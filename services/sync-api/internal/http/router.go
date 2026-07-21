package http

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
	"golang.org/x/oauth2"

	"dolssh/services/sync-api/internal/auth"
	"dolssh/services/sync-api/internal/store"
	// NewRouter 의 파라미터 이름(store)이 패키지를 가리므로 핸들러 안에서 sentinel 에러를
	// 참조할 때는 이 별칭을 쓴다.
	storepkg "dolssh/services/sync-api/internal/store"
	syncmodel "dolssh/services/sync-api/internal/sync"
)

type RouterConfig struct {
	LocalAuthEnabled   bool
	LocalSignupEnabled bool
	TrustedProxies     []string
	PublicBaseURL      string
	ServerVersion      string
	RateLimit          AuthRateLimitConfig
	OIDC               OIDCConfig
	AwsSsmRuntime      AwsSsmRuntime
	AwsSsoBrowserFlow  bool
	AwsSessionBridge   *AwsSessionBridge
	AwsSftpBridge      *AwsSftpBridge
	AwsSshTunnelRelay  *AwsSshTunnelRelay
	AwsSsoMobile       *AwsSsoMobileManager
}

type awsSsoMobileRuntimeState struct {
	mu      sync.Mutex
	runtime AwsSsmRuntime
	manager *AwsSsoMobileManager
}

func newAwsSsoMobileRuntimeState(config RouterConfig) *awsSsoMobileRuntimeState {
	return &awsSsoMobileRuntimeState{
		runtime: config.AwsSsmRuntime,
		manager: config.AwsSsoMobile,
	}
}

func (state *awsSsoMobileRuntimeState) browserFlowSupported() bool {
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.manager != nil || state.runtime.AwsSsoBrowserFlowSupported
}

// currentManager returns the configured SSO manager. The browser flow runs on
// the AWS SDK and no longer depends on a CLI probe, so the old
// recover-on-request path (re-detecting binaries at request time) is gone; a
// nil manager only occurs in tests that explicitly configure the flow off.
func (state *awsSsoMobileRuntimeState) currentManager() (*AwsSsoMobileManager, AwsSsmRuntime) {
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.manager, state.runtime
}

type serverInfoResponse struct {
	ServerVersion string                 `json:"serverVersion"`
	Capabilities  serverInfoCapabilities `json:"capabilities"`
}

type serverInfoCapabilities struct {
	Sync     serverInfoSyncCapabilities    `json:"sync"`
	Sessions serverInfoSessionCapabilities `json:"sessions"`
	Vault    serverInfoVaultCapabilities   `json:"vault"`
}

type serverInfoSyncCapabilities struct {
	AWSProfiles bool `json:"awsProfiles"`
}

type serverInfoVaultCapabilities struct {
	E2EE bool `json:"e2ee"`
}

type serverInfoSessionCapabilities struct {
	AWSSsm            bool `json:"awsSsm"`
	AWSSftp           bool `json:"awsSftp"`
	AWSSsoBrowserFlow bool `json:"awsSsoBrowserFlow"`
}

type OIDCConfig struct {
	Enabled      bool
	DisplayName  string
	IssuerURL    string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	Scopes       []string
	// HideOnIOS 는 iOS 앱에서 연 브라우저 로그인(platform=ios)에서만 OIDC 버튼을 숨긴다.
	// 로컬 인증이 꺼진 서버에서는 숨기면 iOS 에 남는 로그인 수단이 없어지므로 무시된다
	// (oidcVisibleForPlatform 참고).
	HideOnIOS bool
}

type oidcRuntime struct {
	provider *oidc.Provider
	verifier *oidc.IDTokenVerifier
	oauth    *oauth2.Config
	config   OIDCConfig
}

type authRequest struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=8"`
}

type refreshRequest struct {
	RefreshToken string `json:"refreshToken" binding:"required"`
}

type logoutRequest struct {
	RefreshToken string `json:"refreshToken" binding:"required"`
}

type exchangeRequest struct {
	Code string `json:"code" binding:"required"`
}

// vaultSetupRequest 는 볼트 설정(POST)과 암호 변경(PUT)이 공유하는 바디다.
type vaultSetupRequest struct {
	WrappedDekBase64 string `json:"wrappedDekBase64" binding:"required"`
	// DekVerifierBase64 는 클라이언트가 DEK 에서 유도한 공개 검증자(HMAC-SHA256, 32바이트).
	// 설정(POST)에서는 필수, 암호 변경(PUT)에서는 선택 — 비어 있지 않으면 verifier 가 없는
	// 기존 볼트에 지연 백필된다.
	DekVerifierBase64 string              `json:"dekVerifierBase64"`
	Kdf               vaultKdfParamsInput `json:"kdf" binding:"required"`
	// 변이를 시작할 때 클라이언트가 관찰한 세대. pointer로 누락과 epoch 0을 구분한다.
	ExpectedEpoch *int64 `json:"expectedEpoch"`
	// PUT에서 현재 descriptor verifier의 기대값. 빈 문자열도 "verifier 없음"이라는
	// 명시적인 precondition이므로 pointer로 누락과 구분한다.
	ExpectedDekVerifierBase64 *string `json:"expectedDekVerifierBase64"`
	// PUT에서 현재 wrapper 개정의 기대값. 누락은 필드 도입 전 클라이언트의 0으로 취급한다.
	ExpectedWrapRevision *int64 `json:"expectedWrapRevision"`
}

type vaultResetRequest struct {
	ExpectedEpoch *int64 `json:"expectedEpoch"`
}

type vaultKdfParamsInput struct {
	Algorithm   string `json:"algorithm"`
	SaltBase64  string `json:"saltBase64"`
	MemoryKiB   int    `json:"memoryKib"`
	TimeCost    int    `json:"timeCost"`
	Parallelism int    `json:"parallelism"`
}

func (r vaultSetupRequest) toUserVaultKey(userID string) storepkg.UserVaultKey {
	return storepkg.UserVaultKey{
		UserID:           userID,
		Version:          2,
		DekVerifier:      strings.TrimSpace(r.DekVerifierBase64),
		WrappedDekBase64: strings.TrimSpace(r.WrappedDekBase64),
		KdfAlgorithm:     strings.TrimSpace(r.Kdf.Algorithm),
		KdfSaltBase64:    strings.TrimSpace(r.Kdf.SaltBase64),
		KdfMemoryKiB:     r.Kdf.MemoryKiB,
		KdfTimeCost:      r.Kdf.TimeCost,
		KdfParallelism:   r.Kdf.Parallelism,
	}
}

// validateVaultDekVerifier 는 verifier 형식(base64 32바이트 = HMAC-SHA256 출력)을 검사한다.
func validateVaultDekVerifier(value string) bool {
	verifier, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
	return err == nil && len(verifier) == 32
}

// validateVaultSetupRequest 는 클라이언트 버그로 깨진 볼트가 저장되는 것을 막는 형식 검증이다.
// 통과하지 못하면 사용자에게 보여줄 메시지를 돌려준다(빈 문자열 = 통과).
// requireVerifier 는 설정(POST)에서만 true — 새 볼트에는 verifier 가 반드시 있어야 다른
// 기기들이 로컬 검증으로 합류할 수 있다. 암호 변경(PUT)은 기존 볼트 유지라 선택이다.
func validateVaultSetupRequest(request vaultSetupRequest, requireVerifier bool) string {
	if request.ExpectedEpoch == nil || *request.ExpectedEpoch < 0 {
		return "볼트 세대 정보가 누락되었습니다. 앱을 최신 버전으로 업데이트해 주세요."
	}
	wrapped, err := base64.StdEncoding.DecodeString(strings.TrimSpace(request.WrappedDekBase64))
	if err != nil || len(wrapped) < 44 || len(wrapped) > 128 {
		// GCM wrap 최소 크기 = iv(12) + DEK(32) ... 태그 포함 60 이 정상이지만 포맷 여지를 둔다.
		return "잘못된 볼트 키 형식입니다."
	}
	trimmedVerifier := strings.TrimSpace(request.DekVerifierBase64)
	if requireVerifier && trimmedVerifier == "" {
		return "볼트 검증자가 누락되었습니다. 앱을 최신 버전으로 업데이트해 주세요."
	}
	if trimmedVerifier != "" && !validateVaultDekVerifier(trimmedVerifier) {
		return "잘못된 볼트 검증자 형식입니다."
	}
	if strings.TrimSpace(request.Kdf.Algorithm) != "argon2id" {
		return "지원하지 않는 KDF 알고리즘입니다."
	}
	salt, err := base64.StdEncoding.DecodeString(strings.TrimSpace(request.Kdf.SaltBase64))
	if err != nil || len(salt) < 16 || len(salt) > 64 {
		return "잘못된 KDF salt 형식입니다."
	}
	// 현재 앱이 실제로 검증한 Argon2id 프로필만 저장한다. 범위 허용은 손상된 descriptor 가
	// 범위 안의 고비용 조합으로 클라이언트를 장시간 점유하는 여지를 남긴다.
	if request.Kdf.MemoryKiB != 64*1024 || request.Kdf.TimeCost != 3 || request.Kdf.Parallelism != 1 {
		return "지원하지 않는 KDF 파라미터입니다."
	}
	return ""
}

const (
	clientHeaderName               = "X-Dolgate-Client"
	clientVersionHeaderName        = "X-Dolgate-Client-Version"
	clientPlatformHeaderName       = "X-Dolgate-Platform"
	clientInstallationIDHeaderName = "X-Dolgate-Client-Installation-Id"
	unknownClientObservationValue  = "unknown"
	// push 시 클라이언트가 자기 DEK 세대(epoch)를 실어 보내는 헤더. 서버는 이 값을
	// revision bump 의 WHERE 조건(fence)으로 써서 옛 세대의 쓰기를 커밋 시점에 거부한다.
	vaultEpochHeader = "X-Dolgate-Vault-Epoch"
)

// push 거부 응답의 code 필드 — 클라이언트가 상황을 구분해 대응하도록 한다.
const (
	// 볼트 자체가 없음(초기화 직후 재설정 전) — 세션 갱신으로 재합류.
	vaultResetCode = "vault_reset"
	// 볼트는 있으나 DEK 세대가 다름 — 클라이언트는 세션을 갱신해 재판정한다(verifier
	// 불일치면 잠금). 코드 문자열은 dekId 시절 값을 유지해 클라이언트 매핑 churn 을 피한다.
	vaultDekMismatchCode = "vault_dek_mismatch"
)

// E2EE(vault v2) descriptor 를 이해하는 첫 클라이언트 버전. 이 미만(또는 헤더 없음)은
// keyBase64 없는 세션을 파싱하지 못하므로 레거시로 취급한다. 릴리스 버전 확정 시 갱신.
var e2eeMinimumClientVersions = map[string]string{
	"desktop": "1.8.0",
	"mobile":  "1.8.0",
}

// 구버전 클라이언트에 v2 계정 세션을 거부할 때 내려주는 안내. 데스크톱의
// normalizeAuthInvalidErrorMessage 치환 패턴(unauthorized|로그인이 필요|세션이 만료 등)에
// 걸리지 않는 문구여야 원문 그대로 로그인 화면에 표시된다. 상태코드도 같은 이유로
// 401/403(치환)·5xx(오프라인 폴백 유도)를 피해 426 을 쓴다.
const vaultClientOutdatedMessage = "이 계정은 종단간 암호화가 적용되어 있습니다. 앱을 최신 버전으로 업데이트한 뒤 다시 시도해 주세요."

// parseClientVersion 은 "1.7.10"·"1.8.0-beta.1" 류 버전 문자열에서 숫자 세그먼트를 뽑는다.
// 프리릴리스 접미사는 무시한다(게이팅 목적에는 major.minor.patch 로 충분).
func parseClientVersion(value string) ([3]int, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return [3]int{}, false
	}
	var parsed [3]int
	segments := strings.SplitN(trimmed, ".", 3)
	for index, segment := range segments {
		digits := segment
		for cut, char := range segment {
			if char < '0' || char > '9' {
				digits = segment[:cut]
				break
			}
		}
		if digits == "" {
			// 첫 세그먼트부터 숫자가 없으면 버전이 아니다. 뒤쪽 세그먼트가 프리릴리스
			// 라벨뿐이면("1.8.beta") 거기서 멈추고 나머지는 0 으로 둔다.
			if index == 0 {
				return [3]int{}, false
			}
			break
		}
		number, err := strconv.Atoi(digits)
		if err != nil {
			return [3]int{}, false
		}
		parsed[index] = number
	}
	return parsed, true
}

func isClientVersionAtLeast(version string, minimum string) bool {
	parsedVersion, ok := parseClientVersion(version)
	if !ok {
		return false
	}
	parsedMinimum, ok := parseClientVersion(minimum)
	if !ok {
		return false
	}
	for index := 0; index < 3; index++ {
		if parsedVersion[index] != parsedMinimum[index] {
			return parsedVersion[index] > parsedMinimum[index]
		}
	}
	return true
}

// resolveVaultResolution 은 요청 헤더로 클라이언트가 E2EE descriptor 를 이해하는지 판정한다.
func resolveVaultResolution(ctx *gin.Context) auth.VaultResolution {
	clientName := strings.TrimSpace(ctx.GetHeader(clientHeaderName))
	minimum, known := e2eeMinimumClientVersions[clientName]
	if !known {
		return auth.VaultResolutionLegacy
	}
	if !isClientVersionAtLeast(ctx.GetHeader(clientVersionHeaderName), minimum) {
		return auth.VaultResolutionLegacy
	}
	return auth.VaultResolutionE2EE
}

type browserLoginForm struct {
	Email       string `form:"email"`
	Password    string `form:"password"`
	Client      string `form:"client"`
	RedirectURI string `form:"redirect_uri"`
	State       string `form:"state"`
	Platform    string `form:"platform"`
}

type browserSignupForm struct {
	Email       string `form:"email"`
	Password    string `form:"password"`
	Client      string `form:"client"`
	RedirectURI string `form:"redirect_uri"`
	State       string `form:"state"`
	Platform    string `form:"platform"`
}

type loginPageData struct {
	Title              string
	IsSignup           bool
	ErrorMessage       string
	Email              string
	Client             string
	RedirectURI        string
	State              string
	Platform           string
	LocalAuthEnabled   bool
	LocalSignupEnabled bool
	OIDCEnabled        bool
	OIDCDisplayName    string
	ShowSignupLink     bool
}

func normalizeClientObservationValue(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return unknownClientObservationValue
	}
	return trimmed
}

func recordAuthClientObservation(ctx *gin.Context, dbStore store.Store, userID string, authEvent string) error {
	return dbStore.UpsertUserClientObservation(ctx.Request.Context(), store.UserClientObservation{
		UserID:               userID,
		ClientName:           normalizeClientObservationValue(ctx.GetHeader(clientHeaderName)),
		ClientVersion:        normalizeClientObservationValue(ctx.GetHeader(clientVersionHeaderName)),
		Platform:             normalizeClientObservationValue(ctx.GetHeader(clientPlatformHeaderName)),
		ClientInstallationID: normalizeClientObservationValue(ctx.GetHeader(clientInstallationIDHeaderName)),
		LastAuthEvent:        authEvent,
		LastIP:               strings.TrimSpace(ctx.ClientIP()),
		LastUserAgent:        strings.TrimSpace(ctx.Request.UserAgent()),
		ObservedAt:           time.Now().UTC(),
	})
}

func awsSsoBrowserUnavailableMessage(runtime AwsSsmRuntime) string {
	message := "AWS SSO browser flow is unavailable on this server."
	if strings.TrimSpace(runtime.AwsSsoBrowserFlowReason) != "" {
		return message + " " + runtime.AwsSsoBrowserFlowReason
	}
	return message
}

func NewRouter(store store.Store, authService *auth.Service, config RouterConfig) (*gin.Engine, error) {
	router := gin.New()
	if err := router.SetTrustedProxies(config.TrustedProxies); err != nil {
		return nil, err
	}
	router.Use(gin.Logger(), gin.Recovery(), securityHeadersMiddleware())
	awsSsoMobileRuntime := newAwsSsoMobileRuntimeState(config)
	shareHub := NewSessionShareHub(config.PublicBaseURL)
	var awsSessionFactory awsSessionRunnerFactory
	if config.AwsSessionBridge != nil {
		awsSessionFactory = config.AwsSessionBridge.RunnerFactory()
	}
	awsSessionHub := NewAwsSessionHub(config.AwsSsmRuntime, awsSessionFactory)
	shareAssetHandler := http.StripPrefix("/share/assets/", http.FileServer(http.FS(mustShareAssetFS())))
	authLimiters := newAuthRouteLimiters(config.RateLimit)

	oidcRuntime, err := newOIDCRuntime(config.OIDC)
	if err != nil {
		return nil, err
	}

	router.GET("/healthz", func(ctx *gin.Context) {
		ctx.JSON(http.StatusOK, gin.H{"status": "ok", "time": time.Now().UTC().Format(time.RFC3339)})
	})

	router.GET("/api/info", func(ctx *gin.Context) {
		ctx.JSON(http.StatusOK, serverInfoResponse{
			ServerVersion: resolveServerVersion(config.ServerVersion),
			Capabilities: serverInfoCapabilities{
				Sync: serverInfoSyncCapabilities{
					AWSProfiles: true,
				},
				Sessions: serverInfoSessionCapabilities{
					AWSSsm:            config.AwsSsmRuntime.Enabled,
					AWSSftp:           config.AwsSftpBridge != nil && config.AwsSsmRuntime.Enabled,
					AWSSsoBrowserFlow: awsSsoMobileRuntime.browserFlowSupported(),
				},
				Vault: serverInfoVaultCapabilities{
					E2EE: true,
				},
			},
		})
	})

	router.GET("/auth/aws-sso/callback", func(ctx *gin.Context) {
		renderDesktopCallbackBridgePage(
			ctx,
			buildMobileAwsSsoCallbackURL(
				ctx.Query("code"),
				ctx.Query("state"),
				ctx.Query("error"),
				ctx.Query("error_description"),
			),
		)
	})

	router.GET("/login", func(ctx *gin.Context) {
		if shouldRedirectDirectlyToOIDC(config, oidcRuntime) {
			redirectToOIDCStart(ctx)
			return
		}
		renderLoginPage(ctx, loginPageData{
			Title:              "Sign in to Dolgate",
			IsSignup:           false,
			Client:             ctx.Query("client"),
			RedirectURI:        ctx.Query("redirect_uri"),
			State:              ctx.Query("state"),
			Platform:           browserLoginPlatform(ctx),
			LocalAuthEnabled:   config.LocalAuthEnabled,
			LocalSignupEnabled: config.LocalSignupEnabled,
			OIDCEnabled:        oidcVisibleForPlatform(config, oidcRuntime, browserLoginPlatform(ctx)),
			OIDCDisplayName:    oidcButtonLabel(oidcRuntime),
			ShowSignupLink:     config.LocalAuthEnabled && config.LocalSignupEnabled,
		})
	})

	router.POST("/login", func(ctx *gin.Context) {
		var form browserLoginForm
		if err := ctx.ShouldBind(&form); err != nil {
			renderLoginPage(ctx, loginPageData{
				Title:              "Sign in to Dolgate",
				IsSignup:           false,
				ErrorMessage:       err.Error(),
				Email:              form.Email,
				Client:             form.Client,
				RedirectURI:        form.RedirectURI,
				State:              form.State,
				Platform:           form.Platform,
				LocalAuthEnabled:   config.LocalAuthEnabled,
				LocalSignupEnabled: config.LocalSignupEnabled,
				OIDCEnabled:        oidcVisibleForPlatform(config, oidcRuntime, browserLoginPlatform(ctx)),
				OIDCDisplayName:    oidcButtonLabel(oidcRuntime),
				ShowSignupLink:     config.LocalAuthEnabled && config.LocalSignupEnabled,
			})
			return
		}
		if !authLimiters.login.Allow(authAttemptKeys(ctx.ClientIP(), form.Email)...) {
			ctx.Status(http.StatusTooManyRequests)
			renderLoginPage(ctx, loginPageData{
				Title:              "Sign in to Dolgate",
				IsSignup:           false,
				ErrorMessage:       tooManyAuthAttemptsMessage,
				Email:              form.Email,
				Client:             form.Client,
				RedirectURI:        form.RedirectURI,
				State:              form.State,
				Platform:           form.Platform,
				LocalAuthEnabled:   config.LocalAuthEnabled,
				LocalSignupEnabled: config.LocalSignupEnabled,
				OIDCEnabled:        oidcVisibleForPlatform(config, oidcRuntime, browserLoginPlatform(ctx)),
				OIDCDisplayName:    oidcButtonLabel(oidcRuntime),
				ShowSignupLink:     config.LocalAuthEnabled && config.LocalSignupEnabled,
			})
			return
		}
		if !config.LocalAuthEnabled {
			renderLoginPage(ctx, loginPageData{
				Title:              "Sign in to Dolgate",
				IsSignup:           false,
				ErrorMessage:       "이 서버에서는 비밀번호 로그인이 비활성화되어 있습니다.",
				Email:              form.Email,
				Client:             form.Client,
				RedirectURI:        form.RedirectURI,
				State:              form.State,
				Platform:           form.Platform,
				LocalAuthEnabled:   config.LocalAuthEnabled,
				LocalSignupEnabled: config.LocalSignupEnabled,
				OIDCEnabled:        oidcVisibleForPlatform(config, oidcRuntime, browserLoginPlatform(ctx)),
				OIDCDisplayName:    oidcButtonLabel(oidcRuntime),
				ShowSignupLink:     config.LocalAuthEnabled && config.LocalSignupEnabled,
			})
			return
		}
		if err := validateDesktopRedirectURI(form.RedirectURI); err != nil {
			logAndStringError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}

		// 이 세션은 앱으로 전달되지 않고 곧장 exchange code 로 바뀐다 — 볼트를 건드리지
		// 않아야 신규 유저가 웹 폼을 거쳤다는 이유로 v1 볼트가 미리 생성되지 않는다.
		user, _, err := authService.Login(ctx.Request.Context(), form.Email, form.Password, resolveRequestOrigin(ctx), auth.VaultResolutionSkip)
		if err != nil {
			renderLoginPage(ctx, loginPageData{
				Title:              "Sign in to Dolgate",
				IsSignup:           false,
				ErrorMessage:       "이메일 또는 비밀번호가 올바르지 않습니다.",
				Email:              form.Email,
				Client:             form.Client,
				RedirectURI:        form.RedirectURI,
				State:              form.State,
				Platform:           form.Platform,
				LocalAuthEnabled:   config.LocalAuthEnabled,
				LocalSignupEnabled: config.LocalSignupEnabled,
				OIDCEnabled:        oidcVisibleForPlatform(config, oidcRuntime, browserLoginPlatform(ctx)),
				OIDCDisplayName:    oidcButtonLabel(oidcRuntime),
				ShowSignupLink:     config.LocalAuthEnabled && config.LocalSignupEnabled,
			})
			return
		}

		code, err := authService.IssueExchangeCode(ctx.Request.Context(), user)
		if err != nil {
			logAndStringError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		completeDesktopLogin(ctx, form.RedirectURI, code, form.State)
	})

	router.GET("/signup", func(ctx *gin.Context) {
		if shouldRedirectDirectlyToOIDC(config, oidcRuntime) {
			redirectToOIDCStart(ctx)
			return
		}
		if !config.LocalAuthEnabled || !config.LocalSignupEnabled {
			ctx.Redirect(http.StatusFound, "/login")
			return
		}
		renderLoginPage(ctx, loginPageData{
			Title:              "Create your Dolgate account",
			IsSignup:           true,
			Client:             ctx.Query("client"),
			RedirectURI:        ctx.Query("redirect_uri"),
			State:              ctx.Query("state"),
			Platform:           browserLoginPlatform(ctx),
			LocalAuthEnabled:   true,
			LocalSignupEnabled: true,
			OIDCEnabled:        oidcVisibleForPlatform(config, oidcRuntime, browserLoginPlatform(ctx)),
			OIDCDisplayName:    oidcButtonLabel(oidcRuntime),
			ShowSignupLink:     false,
		})
	})

	router.POST("/signup", func(ctx *gin.Context) {
		if !config.LocalAuthEnabled || !config.LocalSignupEnabled {
			ctx.Redirect(http.StatusFound, "/login")
			return
		}

		var form browserSignupForm
		if err := ctx.ShouldBind(&form); err != nil {
			renderLoginPage(ctx, loginPageData{
				Title:              "Create your Dolgate account",
				IsSignup:           true,
				ErrorMessage:       err.Error(),
				Email:              form.Email,
				Client:             form.Client,
				RedirectURI:        form.RedirectURI,
				State:              form.State,
				Platform:           form.Platform,
				LocalAuthEnabled:   true,
				LocalSignupEnabled: true,
				OIDCEnabled:        oidcVisibleForPlatform(config, oidcRuntime, browserLoginPlatform(ctx)),
				OIDCDisplayName:    oidcButtonLabel(oidcRuntime),
			})
			return
		}
		if !authLimiters.signup.Allow(authAttemptKeys(ctx.ClientIP(), form.Email)...) {
			ctx.Status(http.StatusTooManyRequests)
			renderLoginPage(ctx, loginPageData{
				Title:              "Create your Dolgate account",
				IsSignup:           true,
				ErrorMessage:       tooManyAuthAttemptsMessage,
				Email:              form.Email,
				Client:             form.Client,
				RedirectURI:        form.RedirectURI,
				State:              form.State,
				Platform:           form.Platform,
				LocalAuthEnabled:   true,
				LocalSignupEnabled: true,
				OIDCEnabled:        oidcVisibleForPlatform(config, oidcRuntime, browserLoginPlatform(ctx)),
				OIDCDisplayName:    oidcButtonLabel(oidcRuntime),
			})
			return
		}
		if err := validateDesktopRedirectURI(form.RedirectURI); err != nil {
			logAndStringError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}

		// 브라우저 폼 로그인과 동일 — 세션이 앱으로 가지 않으므로 볼트 생성을 건너뛴다.
		user, _, err := authService.Signup(ctx.Request.Context(), form.Email, form.Password, resolveRequestOrigin(ctx), auth.VaultResolutionSkip)
		if err != nil {
			renderLoginPage(ctx, loginPageData{
				Title:              "Create your Dolgate account",
				IsSignup:           true,
				ErrorMessage:       err.Error(),
				Email:              form.Email,
				Client:             form.Client,
				RedirectURI:        form.RedirectURI,
				State:              form.State,
				Platform:           form.Platform,
				LocalAuthEnabled:   true,
				LocalSignupEnabled: true,
				OIDCEnabled:        oidcVisibleForPlatform(config, oidcRuntime, browserLoginPlatform(ctx)),
				OIDCDisplayName:    oidcButtonLabel(oidcRuntime),
			})
			return
		}
		code, err := authService.IssueExchangeCode(ctx.Request.Context(), user)
		if err != nil {
			logAndStringError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		completeDesktopLogin(ctx, form.RedirectURI, code, form.State)
	})

	router.GET("/auth/oidc/start", func(ctx *gin.Context) {
		if oidcRuntime == nil {
			ctx.String(http.StatusNotFound, "oidc is not enabled")
			return
		}

		client := ctx.Query("client")
		redirectURI := ctx.Query("redirect_uri")
		desktopState := ctx.Query("state")
		if err := validateDesktopRedirectURI(redirectURI); err != nil {
			logAndStringError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		signedState, err := authService.NewBrowserLoginState(client, redirectURI, desktopState)
		if err != nil {
			logAndStringError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		ctx.Redirect(http.StatusFound, oidcRuntime.oauth.AuthCodeURL(signedState))
	})

	// GET 콜백은 authorization code를 "여기서" 교환하지 않는다. 일회용 code는 브라우저
	// prefetch/prerender·광고차단/보안확장·링크 스캐너가 콜백 URL을 한 번 긁기만 해도
	// 소진돼, 실제 사용자 네비게이션의 교환이 invalid_grant 로 실패한다. 그래서 GET 에서는
	// state 서명만 검증하고, 실제 사용자 페이지의 JS 가 /auth/oidc/complete 로 POST 할 때만
	// 교환한다(prefetch 는 JS 미실행이라 코드가 안 닳고, prerender 는 활성화 후에만 제출).
	router.GET("/auth/oidc/callback", func(ctx *gin.Context) {
		if oidcRuntime == nil {
			ctx.String(http.StatusNotFound, "oidc is not enabled")
			return
		}
		rawState := ctx.Query("state")
		code := ctx.Query("code")
		if rawState == "" || code == "" {
			ctx.String(http.StatusBadRequest, "missing oidc callback state or code")
			return
		}
		if _, err := authService.ParseBrowserLoginState(rawState); err != nil {
			logAndStringError(ctx, http.StatusUnauthorized, "인증에 실패했습니다.", err)
			return
		}
		renderOIDCExchangeBridgePage(ctx, code, rawState)
	})

	router.POST("/auth/oidc/complete", func(ctx *gin.Context) {
		if oidcRuntime == nil {
			ctx.String(http.StatusNotFound, "oidc is not enabled")
			return
		}
		rawState := ctx.PostForm("state")
		code := ctx.PostForm("code")
		if rawState == "" || code == "" {
			ctx.String(http.StatusBadRequest, "missing oidc callback state or code")
			return
		}

		loginState, err := authService.ParseBrowserLoginState(rawState)
		if err != nil {
			logAndStringError(ctx, http.StatusUnauthorized, "인증에 실패했습니다.", err)
			return
		}

		token, err := oidcRuntime.oauth.Exchange(ctx.Request.Context(), code)
		if err != nil {
			logAndStringError(ctx, http.StatusBadGateway, "요청 처리 중 오류가 발생했습니다.", err)
			return
		}

		rawIDToken, ok := token.Extra("id_token").(string)
		if !ok || rawIDToken == "" {
			ctx.String(http.StatusBadGateway, "oidc response missing id_token")
			return
		}

		idToken, err := oidcRuntime.verifier.Verify(ctx.Request.Context(), rawIDToken)
		if err != nil {
			logAndStringError(ctx, http.StatusBadGateway, "요청 처리 중 오류가 발생했습니다.", err)
			return
		}

		var claims struct {
			Subject       string `json:"sub"`
			Email         string `json:"email"`
			EmailVerified bool   `json:"email_verified"`
		}
		if err := idToken.Claims(&claims); err != nil {
			logAndStringError(ctx, http.StatusBadGateway, "요청 처리 중 오류가 발생했습니다.", err)
			return
		}

		user, err := authService.ResolveOIDCUser(ctx.Request.Context(), "oidc", claims.Subject, claims.Email, claims.EmailVerified)
		if err != nil {
			logAndStringError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}

		exchangeCode, err := authService.IssueExchangeCode(ctx.Request.Context(), user)
		if err != nil {
			logAndStringError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		completeDesktopLogin(ctx, loginState.RedirectURI, exchangeCode, loginState.State)
	})

	router.POST("/auth/signup", func(ctx *gin.Context) {
		var request authRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if !authLimiters.signup.Allow(authAttemptKeys(ctx.ClientIP(), request.Email)...) {
			ctx.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyAuthAttemptsMessage})
			return
		}

		_, session, err := authService.Signup(ctx.Request.Context(), request.Email, request.Password, resolveRequestOrigin(ctx), resolveVaultResolution(ctx))
		if err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if err := recordAuthClientObservation(ctx, store, session.User.ID, "signup"); err != nil {
			_ = ctx.Error(err)
		}
		ctx.JSON(http.StatusCreated, session)
	})

	router.POST("/auth/login", func(ctx *gin.Context) {
		var request authRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if !authLimiters.login.Allow(authAttemptKeys(ctx.ClientIP(), request.Email)...) {
			ctx.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyAuthAttemptsMessage})
			return
		}

		_, session, err := authService.Login(ctx.Request.Context(), request.Email, request.Password, resolveRequestOrigin(ctx), resolveVaultResolution(ctx))
		if err != nil {
			if errors.Is(err, auth.ErrVaultClientOutdated) {
				ctx.JSON(http.StatusUpgradeRequired, gin.H{"error": vaultClientOutdatedMessage})
				return
			}
			status := http.StatusUnauthorized
			if !errors.Is(err, auth.ErrInvalidCredentials) {
				status = http.StatusBadRequest
			}
			logAndJSONError(ctx, status, "인증에 실패했습니다.", err)
			return
		}
		if err := recordAuthClientObservation(ctx, store, session.User.ID, "login"); err != nil {
			_ = ctx.Error(err)
		}
		ctx.JSON(http.StatusOK, session)
	})

	router.POST("/auth/exchange", func(ctx *gin.Context) {
		var request exchangeRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if !authLimiters.exchange.Allow(authAttemptKeys(ctx.ClientIP(), "")...) {
			ctx.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyAuthAttemptsMessage})
			return
		}
		session, err := authService.ExchangeCode(ctx.Request.Context(), request.Code, resolveRequestOrigin(ctx), resolveVaultResolution(ctx))
		if err != nil {
			if errors.Is(err, auth.ErrVaultClientOutdated) {
				ctx.JSON(http.StatusUpgradeRequired, gin.H{"error": vaultClientOutdatedMessage})
				return
			}
			logAndJSONError(ctx, http.StatusUnauthorized, "인증에 실패했습니다.", err)
			return
		}
		if err := recordAuthClientObservation(ctx, store, session.User.ID, "exchange"); err != nil {
			_ = ctx.Error(err)
		}
		ctx.JSON(http.StatusOK, session)
	})

	router.POST("/auth/refresh", func(ctx *gin.Context) {
		var request refreshRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if !authLimiters.refresh.Allow(authAttemptKeys(ctx.ClientIP(), "")...) {
			ctx.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyAuthAttemptsMessage})
			return
		}
		session, err := authService.Refresh(ctx.Request.Context(), request.RefreshToken, resolveRequestOrigin(ctx), resolveVaultResolution(ctx))
		if err != nil {
			if errors.Is(err, auth.ErrVaultClientOutdated) {
				ctx.JSON(http.StatusUpgradeRequired, gin.H{"error": vaultClientOutdatedMessage})
				return
			}
			logAndJSONError(ctx, http.StatusUnauthorized, "인증에 실패했습니다.", err)
			return
		}
		if err := recordAuthClientObservation(ctx, store, session.User.ID, "refresh"); err != nil {
			_ = ctx.Error(err)
		}
		ctx.JSON(http.StatusOK, session)
	})

	router.POST("/auth/logout", func(ctx *gin.Context) {
		var request logoutRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if err := authService.Logout(ctx.Request.Context(), request.RefreshToken); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		ctx.Status(http.StatusNoContent)
	})

	// 회원 탈퇴 — Bearer 인증 사용자의 모든 서버측 데이터(계정·인증·vault 키·기기 관찰·
	// sync 레코드)를 단일 트랜잭션으로 즉시 영구 삭제한다. refresh 토큰이 함께 지워지므로
	// 다른 기기는 다음 토큰 갱신(401)에서 로그아웃된다.
	router.DELETE("/auth/account", authMiddleware(authService), func(ctx *gin.Context) {
		userID := ctx.GetString("userId")
		if err := authService.DeleteAccount(ctx.Request.Context(), userID); err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		ctx.Status(http.StatusNoContent)
	})

	sessionShareGroup := router.Group("/api/session-shares")
	sessionShareGroup.Use(authMiddleware(authService))
	sessionShareGroup.POST("", func(ctx *gin.Context) {
		var request createSessionShareRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if request.SessionID == "" || request.Title == "" || request.Cols <= 0 || request.Rows <= 0 || !isValidSessionShareTransport(request.Transport) {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid session share payload"})
			return
		}

		userID := ctx.GetString("userId")
		response := shareHub.Create(userID, request, shareHub.trustedBaseURL(ctx.Request))
		ctx.JSON(http.StatusCreated, response)
	})

	awsSessionGroup := router.Group("/api/aws-sessions")
	awsSessionGroup.Use(authMiddlewareWithOptions(authService, authMiddlewareOptions{
		AllowQueryAccessToken: true,
	}))
	awsSessionGroup.GET("/ws", func(ctx *gin.Context) {
		if err := awsSessionHub.HandleWebSocket(ctx.Writer, ctx.Request); err != nil {
			if ctx.Writer.Written() {
				return
			}
			logAndJSONError(ctx, http.StatusBadGateway, "요청 처리 중 오류가 발생했습니다.", err)
		}
	})

	// Server-proxy (bastion) transport: relays raw SSH bytes over a WebSocket to the
	// SSM tunnel that sync-api opens on its allowlisted IP. Desktop ssh-core rides
	// plain SSH over it, so shell/tmux/sftp/forwarding work through the server in
	// IP-restricted VPCs. Mirrors the aws-sessions WS group's auth (header or query).
	awsSshTunnelGroup := router.Group("/api/aws-ssh-tunnel")
	awsSshTunnelGroup.Use(authMiddlewareWithOptions(authService, authMiddlewareOptions{
		AllowQueryAccessToken: true,
	}))
	awsSshTunnelGroup.GET("/ws", func(ctx *gin.Context) {
		if config.AwsSshTunnelRelay == nil {
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "AWS SSH tunnel relay is unavailable on this server."})
			return
		}
		if err := config.AwsSshTunnelRelay.HandleWebSocket(ctx.Writer, ctx.Request); err != nil {
			if ctx.Writer.Written() {
				return
			}
			logAndJSONError(ctx, http.StatusBadGateway, "요청 처리 중 오류가 발생했습니다.", err)
		}
	})

	awsSftpGroup := router.Group("/api/aws-sftp")
	awsSftpGroup.Use(authMiddleware(authService))
	awsSftpGroup.POST("/sessions", func(ctx *gin.Context) {
		if config.AwsSftpBridge == nil {
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "AWS SFTP runtime is unavailable on this server."})
			return
		}
		var request awsSftpCreateSessionRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		response, err := config.AwsSftpBridge.CreateSession(ctx.Request.Context(), ctx.GetString("userId"), request)
		if err != nil {
			var challenge *awsSftpHostKeyChallengeError
			if errors.As(err, &challenge) {
				ctx.JSON(http.StatusConflict, challenge.response)
				return
			}
			logAndJSONError(ctx, http.StatusBadGateway, "요청 처리 중 오류가 발생했습니다.", err)
			return
		}
		ctx.JSON(http.StatusCreated, response)
	})
	awsSftpGroup.DELETE("/sessions/:sessionId", func(ctx *gin.Context) {
		if config.AwsSftpBridge == nil {
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "AWS SFTP runtime is unavailable on this server."})
			return
		}
		if err := config.AwsSftpBridge.CloseSession(ctx.GetString("userId"), ctx.Param("sessionId")); err != nil {
			logAndJSONError(ctx, http.StatusNotFound, "대상을 찾을 수 없습니다.", err)
			return
		}
		ctx.Status(http.StatusNoContent)
	})
	awsSftpGroup.GET("/sessions/:sessionId/list", func(ctx *gin.Context) {
		if config.AwsSftpBridge == nil {
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "AWS SFTP runtime is unavailable on this server."})
			return
		}
		response, err := config.AwsSftpBridge.List(ctx.GetString("userId"), ctx.Param("sessionId"), ctx.Query("path"))
		if err != nil {
			logAndJSONError(ctx, http.StatusBadGateway, "요청 처리 중 오류가 발생했습니다.", err)
			return
		}
		ctx.JSON(http.StatusOK, response)
	})
	awsSftpGroup.POST("/sessions/:sessionId/read", func(ctx *gin.Context) {
		if config.AwsSftpBridge == nil {
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "AWS SFTP runtime is unavailable on this server."})
			return
		}
		var request awsSftpReadRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		response, err := config.AwsSftpBridge.Read(ctx.GetString("userId"), ctx.Param("sessionId"), request)
		if err != nil {
			logAndJSONError(ctx, http.StatusBadGateway, "요청 처리 중 오류가 발생했습니다.", err)
			return
		}
		ctx.JSON(http.StatusOK, response)
	})
	awsSftpGroup.POST("/sessions/:sessionId/write", func(ctx *gin.Context) {
		if config.AwsSftpBridge == nil {
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "AWS SFTP runtime is unavailable on this server."})
			return
		}
		var request awsSftpWriteRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if err := config.AwsSftpBridge.Write(ctx.GetString("userId"), ctx.Param("sessionId"), request); err != nil {
			logAndJSONError(ctx, http.StatusBadGateway, "요청 처리 중 오류가 발생했습니다.", err)
			return
		}
		ctx.Status(http.StatusNoContent)
	})
	awsSftpGroup.POST("/sessions/:sessionId/mkdir", func(ctx *gin.Context) {
		if config.AwsSftpBridge == nil {
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "AWS SFTP runtime is unavailable on this server."})
			return
		}
		var request awsSftpPathRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if err := config.AwsSftpBridge.Mkdir(ctx.GetString("userId"), ctx.Param("sessionId"), request.Path); err != nil {
			logAndJSONError(ctx, http.StatusBadGateway, "요청 처리 중 오류가 발생했습니다.", err)
			return
		}
		ctx.Status(http.StatusNoContent)
	})
	awsSftpGroup.POST("/sessions/:sessionId/rename", func(ctx *gin.Context) {
		if config.AwsSftpBridge == nil {
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "AWS SFTP runtime is unavailable on this server."})
			return
		}
		var request awsSftpRenameRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if err := config.AwsSftpBridge.Rename(ctx.GetString("userId"), ctx.Param("sessionId"), request.SourcePath, request.TargetPath); err != nil {
			logAndJSONError(ctx, http.StatusBadGateway, "요청 처리 중 오류가 발생했습니다.", err)
			return
		}
		ctx.Status(http.StatusNoContent)
	})
	awsSftpGroup.POST("/sessions/:sessionId/chmod", func(ctx *gin.Context) {
		if config.AwsSftpBridge == nil {
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "AWS SFTP runtime is unavailable on this server."})
			return
		}
		var request awsSftpChmodRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if err := config.AwsSftpBridge.Chmod(ctx.GetString("userId"), ctx.Param("sessionId"), request.Path, request.Permissions); err != nil {
			logAndJSONError(ctx, http.StatusBadGateway, "요청 처리 중 오류가 발생했습니다.", err)
			return
		}
		ctx.Status(http.StatusNoContent)
	})
	awsSftpGroup.POST("/sessions/:sessionId/delete", func(ctx *gin.Context) {
		if config.AwsSftpBridge == nil {
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": "AWS SFTP runtime is unavailable on this server."})
			return
		}
		var request awsSftpPathRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if err := config.AwsSftpBridge.Delete(ctx.GetString("userId"), ctx.Param("sessionId"), request.Path); err != nil {
			logAndJSONError(ctx, http.StatusBadGateway, "요청 처리 중 오류가 발생했습니다.", err)
			return
		}
		ctx.Status(http.StatusNoContent)
	})

	awsSsoGroup := router.Group("/api/aws-sso/mobile")
	awsSsoGroup.Use(authMiddleware(authService))
	awsSsoGroup.POST("/start", func(ctx *gin.Context) {
		awsSsoMobile, awsSsmRuntime := awsSsoMobileRuntime.currentManager()
		if awsSsoMobile == nil {
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": awsSsoBrowserUnavailableMessage(awsSsmRuntime)})
			return
		}

		var request awsSsoMobileLoginStartRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}

		response, err := awsSsoMobile.Start(ctx.Request.Context(), ctx.GetString("userId"), request)
		if err != nil {
			logAndJSONError(ctx, http.StatusBadGateway, "요청 처리 중 오류가 발생했습니다.", err)
			return
		}
		ctx.JSON(http.StatusOK, response)
	})
	awsSsoGroup.GET("/handoff/:loginId", func(ctx *gin.Context) {
		awsSsoMobile, awsSsmRuntime := awsSsoMobileRuntime.currentManager()
		if awsSsoMobile == nil {
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": awsSsoBrowserUnavailableMessage(awsSsmRuntime)})
			return
		}

		response, err := awsSsoMobile.Status(
			ctx.GetString("userId"),
			ctx.Param("loginId"),
		)
		if err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		ctx.JSON(http.StatusOK, response)
	})
	awsSsoGroup.POST("/handoff/:loginId", func(ctx *gin.Context) {
		awsSsoMobile, awsSsmRuntime := awsSsoMobileRuntime.currentManager()
		if awsSsoMobile == nil {
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"error": awsSsoBrowserUnavailableMessage(awsSsmRuntime)})
			return
		}

		var request awsSsoMobileLoginHandoffRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}

		response, err := awsSsoMobile.Complete(
			ctx.Request.Context(),
			ctx.GetString("userId"),
			ctx.Param("loginId"),
			request,
		)
		if err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		ctx.JSON(http.StatusOK, response)
	})
	awsSsoGroup.POST("/cancel", func(ctx *gin.Context) {
		awsSsoMobile, _ := awsSsoMobileRuntime.currentManager()
		if awsSsoMobile == nil {
			ctx.Status(http.StatusNoContent)
			return
		}

		var request struct {
			LoginID string `json:"loginId" binding:"required"`
		}
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if err := awsSsoMobile.Cancel(ctx.GetString("userId"), request.LoginID); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		ctx.Status(http.StatusNoContent)
	})
	sessionShareGroup.POST("/:shareId/input", func(ctx *gin.Context) {
		var request struct {
			InputEnabled bool `json:"inputEnabled"`
		}
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}

		updated, err := shareHub.SetInputEnabled(ctx.GetString("userId"), ctx.Param("shareId"), request.InputEnabled)
		if err != nil {
			logAndJSONError(ctx, http.StatusNotFound, "대상을 찾을 수 없습니다.", err)
			return
		}
		ctx.JSON(http.StatusOK, gin.H{"updated": updated})
	})
	sessionShareGroup.DELETE("/:shareId", func(ctx *gin.Context) {
		if err := shareHub.Delete(ctx.GetString("userId"), ctx.Param("shareId"), "세션 공유가 종료되었습니다."); err != nil {
			logAndJSONError(ctx, http.StatusNotFound, "대상을 찾을 수 없습니다.", err)
			return
		}
		ctx.Status(http.StatusNoContent)
	})

	router.GET("/api/session-shares/:shareId/owner/ws", func(ctx *gin.Context) {
		ownerToken := ctx.Query("token")
		shareID := ctx.Param("shareId")
		if ownerToken == "" || !shareHub.HasOwnerToken(shareID, ownerToken) {
			ctx.JSON(http.StatusUnauthorized, gin.H{"error": "session share not found"})
			return
		}
		if err := shareHub.HandleOwnerWebSocket(ctx.Writer, ctx.Request, shareID, ownerToken); err != nil {
			if !ctx.Writer.Written() {
				logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			}
		}
	})

	router.GET("/share/assets/*filepath", func(ctx *gin.Context) {
		applyShareResponseHeaders(ctx)
		shareAssetHandler.ServeHTTP(ctx.Writer, ctx.Request)
	})
	router.GET("/share/:shareId/:viewerToken", func(ctx *gin.Context) {
		shareID := ctx.Param("shareId")
		viewerToken := ctx.Param("viewerToken")
		if !shareHub.HasViewerToken(shareID, viewerToken) {
			ctx.String(http.StatusNotFound, "session share not found")
			return
		}
		applyShareResponseHeaders(ctx)
		applyShareViewerResponseHeaders(ctx)
		ctx.Header("Content-Type", "text/html; charset=utf-8")
		_ = shareViewerTemplate.Execute(ctx.Writer, viewerPageData{
			ShareID:      shareID,
			ViewerToken:  viewerToken,
			AssetVersion: shareAssetVersion,
		})
	})
	router.GET("/share/:shareId/:viewerToken/ws", func(ctx *gin.Context) {
		shareID := ctx.Param("shareId")
		viewerToken := ctx.Param("viewerToken")
		if !shareHub.HasViewerToken(shareID, viewerToken) {
			ctx.String(http.StatusNotFound, "session share not found")
			return
		}
		if err := shareHub.HandleViewerWebSocket(ctx.Writer, ctx.Request, shareID, viewerToken); err != nil {
			if !ctx.Writer.Written() {
				logAndStringError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			}
		}
	})

	// 탈퇴 직후 아직 만료 전 access 토큰을 가진 기기의 쓰기(지운 데이터 부활, 볼트 재생성)를
	// 막고, 그 기기의 즉시 로그아웃(401 → refresh 실패)을 유도한다. JWT 는 stateless 라
	// 토큰만으로는 탈퇴를 알 수 없으므로 유저 존재를 확인한다.
	requireExistingUser := func(ctx *gin.Context) {
		exists, err := store.UserExists(ctx.Request.Context(), ctx.GetString("userId"))
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			ctx.Abort()
			return
		}
		if !exists {
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "로그인이 필요합니다."})
			return
		}
		ctx.Next()
	}

	// E2EE 볼트(v2) 관리. 세션 발급 응답의 vaultBootstrap descriptor 와 짝을 이룬다.
	vaultGroup := router.Group("/auth/vault")
	vaultGroup.Use(authMiddleware(authService), requireExistingUser)
	// 볼트 설정 — 신규 유저의 최초 설정과 (Phase B) v1 유저의 E2EE 전환을 겸한다.
	// v1 행이 있으면 같은 트랜잭션에서 서버 보관 DEK 원문을 지우며 v2 로 교체된다.
	vaultGroup.POST("", func(ctx *gin.Context) {
		userID := ctx.GetString("userId")
		var request vaultSetupRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if message := validateVaultSetupRequest(request, true); message != "" {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": message})
			return
		}
		vault, err := store.CreateUserVaultV2(
			ctx.Request.Context(),
			request.toUserVaultKey(userID),
			storepkg.VaultMutationPrecondition{ExpectedEpoch: *request.ExpectedEpoch},
		)
		if err != nil {
			if errors.Is(err, storepkg.ErrVaultEpochMismatch) {
				ctx.JSON(http.StatusConflict, gin.H{"error": "동기화 볼트가 변경되었습니다. 세션을 갱신한 뒤 다시 시도해 주세요.", "code": vaultDekMismatchCode})
				return
			}
			if errors.Is(err, storepkg.ErrVaultConflict) {
				// 다른 기기가 먼저 설정했다 — 클라이언트는 세션을 갱신해 descriptor 를
				// 받아 잠금해제 플로우로 전환한다.
				ctx.JSON(http.StatusConflict, gin.H{"error": "다른 기기에서 이미 동기화 암호를 설정했습니다. 그 암호로 잠금을 해제해 주세요."})
				return
			}
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		// 방금 시작된 DEK 세대를 돌려줘 클라이언트가 세션 재갱신 없이 캐시하게 한다.
		ctx.JSON(http.StatusOK, gin.H{"epoch": vault.Epoch, "wrapRevision": vault.WrapRevision})
	})
	// 동기화 암호 변경(rewrap) — DEK 자체는 바뀌지 않으므로 다른 기기의 캐시는 계속 유효하고
	// epoch 도 그대로다. verifier 가 없는 볼트(도입 이전 생성)에는 요청의 verifier 를 백필한다.
	vaultGroup.PUT("", func(ctx *gin.Context) {
		userID := ctx.GetString("userId")
		var request vaultSetupRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if message := validateVaultSetupRequest(request, false); message != "" {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": message})
			return
		}
		if request.ExpectedDekVerifierBase64 == nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "볼트 검증 조건이 누락되었습니다. 앱을 최신 버전으로 업데이트해 주세요."})
			return
		}
		if request.ExpectedWrapRevision == nil || *request.ExpectedWrapRevision < 0 {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "볼트 wrapper 개정 정보가 누락되었습니다. 앱을 최신 버전으로 업데이트해 주세요."})
			return
		}
		expectedVerifier := strings.TrimSpace(*request.ExpectedDekVerifierBase64)
		expectedWrapRevision := *request.ExpectedWrapRevision
		vault, err := store.UpdateUserVaultV2(
			ctx.Request.Context(),
			request.toUserVaultKey(userID),
			storepkg.VaultMutationPrecondition{
				ExpectedEpoch:        *request.ExpectedEpoch,
				ExpectedDekVerifier:  &expectedVerifier,
				ExpectedWrapRevision: &expectedWrapRevision,
			},
		)
		if err != nil {
			if errors.Is(err, storepkg.ErrVaultEpochMismatch) {
				ctx.JSON(http.StatusConflict, gin.H{"error": "동기화 볼트가 변경되었습니다. 세션을 갱신한 뒤 다시 시도해 주세요.", "code": vaultDekMismatchCode})
				return
			}
			if errors.Is(err, storepkg.ErrVaultNotFound) || errors.Is(err, storepkg.ErrVaultConflict) {
				ctx.JSON(http.StatusConflict, gin.H{"error": "변경할 동기화 암호 볼트가 없습니다. 세션을 갱신한 뒤 다시 시도해 주세요."})
				return
			}
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		ctx.JSON(http.StatusOK, gin.H{"epoch": vault.Epoch, "wrapRevision": vault.WrapRevision})
	})
	// 볼트 초기화 — 동기화 암호 분실 최후 수단. 볼트와 모든 sync 레코드를 지운다(복구 불가).
	// 계정은 남으므로 사용자는 곧바로 새 동기화 암호를 설정해 다시 시작한다.
	vaultGroup.POST("/reset", func(ctx *gin.Context) {
		userID := ctx.GetString("userId")
		var request vaultResetRequest
		if err := ctx.ShouldBindJSON(&request); err != nil || request.ExpectedEpoch == nil || *request.ExpectedEpoch < 0 {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "볼트 세대 정보가 누락되었습니다. 앱을 최신 버전으로 업데이트해 주세요."})
			return
		}
		epoch, err := store.ResetUserVault(ctx.Request.Context(), userID, *request.ExpectedEpoch)
		if err != nil {
			if errors.Is(err, storepkg.ErrVaultEpochMismatch) {
				ctx.JSON(http.StatusConflict, gin.H{"error": "동기화 볼트가 변경되었습니다. 세션을 갱신한 뒤 다시 시도해 주세요.", "code": vaultDekMismatchCode})
				return
			}
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		ctx.JSON(http.StatusOK, gin.H{"epoch": epoch})
	})

	syncGroup := router.Group("/sync")
	syncGroup.Use(authMiddleware(authService))
	syncGroup.Use(requireExistingUser)
	syncGroup.GET("", func(ctx *gin.Context) {
		userID := ctx.GetString("userId")

		// revision + 모든 kind 를 단일 읽기 트랜잭션으로 일관 스냅샷으로 읽는다.
		// revision 과 데이터가 어긋나(새 ETag + 옛 데이터) 변경을 놓치는 일이 없도록 한다.
		revision, payload, err := store.GetSyncSnapshot(ctx.Request.Context(), userID)
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		etag := fmt.Sprintf("\"%d\"", revision)
		ctx.Header("ETag", etag)
		// 변경 없음 → 본문 없이 304. 폴링이 idle 일 때 초경량이 되는 지점이다.
		// (구버전 클라는 If-None-Match 를 안 보내므로 항상 200 전체를 받는다.)
		if match := strings.TrimSpace(ctx.GetHeader("If-None-Match")); match != "" && match == etag {
			ctx.Status(http.StatusNotModified)
			return
		}

		ctx.JSON(http.StatusOK, payload)
	})
	syncGroup.POST("", func(ctx *gin.Context) {
		userID := ctx.GetString("userId")
		// 볼트 행이 없으면 push 를 거부한다. 초기화(reset) 직후 다른 기기가 옛 DEK 로
		// 아직 unlocked 인 채 잔여 access 토큰으로 push 해서 서버를 "옛 키 + 새 키"
		// 혼합 상태로 오염시키는 레이스를 막는다(그 기기는 409 를 받고 볼트 플로우로
		// 전환한다). pull(GET)은 무해하므로 막지 않는다. 신규 유저는 볼트 설정 전
		// push 할 일이 없고, 구버전 클라는 로그인 시 v1 볼트가 lazy 생성돼 있다.
		vaultState, err := store.GetUserVaultState(ctx.Request.Context(), userID)
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		rawEpoch := strings.TrimSpace(ctx.GetHeader(vaultEpochHeader))
		// 계정이 한 번이라도 v2가 됐다면 reset 뒤 볼트 행이 없어도 구클라이언트는
		// 계속 426이다. 여기서 먼저 막아 v1 lazy 재생성과 잔여 무헤더 push를 차단한다.
		if vaultState.VersionFloor >= 2 && rawEpoch == "" && resolveVaultResolution(ctx) != auth.VaultResolutionE2EE {
			ctx.JSON(http.StatusUpgradeRequired, gin.H{"error": vaultClientOutdatedMessage})
			return
		}
		if vaultState.Vault == nil {
			ctx.JSON(http.StatusConflict, gin.H{"error": "동기화 볼트가 없습니다. 세션을 갱신한 뒤 다시 시도해 주세요.", "code": vaultResetCode})
			return
		}
		vault := *vaultState.Vault
		headerEpoch, epochParseErr := strconv.ParseInt(rawEpoch, 10, 64)
		epochHeaderValid := rawEpoch != "" && epochParseErr == nil
		if vaultState.VersionFloor >= 2 && vault.Version < 2 {
			// 과거 버그/롤링 배포로 남은 v1 행은 신클라이언트가 즉시 마이그레이션해야 한다.
			// 그 전에는 어떤 형식의 sync payload도 받지 않는다.
			ctx.JSON(http.StatusConflict, gin.H{"error": "종단간 암호화 전환을 완료한 뒤 다시 시도해 주세요.", "code": vaultDekMismatchCode})
			return
		}
		if vault.Version >= 2 {
			// 구버전 클라(E2EE descriptor 미이해)가 v2 볼트에 push 하는 것을 막는다.
			// v1 시절 받은 access 토큰이 15분간 남아 있어 세션 발급 426 게이트를 우회할 수
			// 있는데, 그 창에서 옛 키로 push 하면 볼트가 오염된다. 여기서 거부하고 업데이트
			// 안내를 준다. epoch 헤더 존재 자체가 E2EE 능력의 증거이므로(구버전은 이 헤더를
			// 모른다) 클라 식별 헤더가 없어도 epoch 헤더가 있으면 통과시킨다.
			// (v1 볼트에는 적용 안 됨 — 구버전이 계속 쓸 수 있어야 한다.)
			if rawEpoch == "" && resolveVaultResolution(ctx) != auth.VaultResolutionE2EE {
				ctx.JSON(http.StatusUpgradeRequired, gin.H{"error": vaultClientOutdatedMessage})
				return
			}
			// v2 push 에는 유효한 epoch 헤더가 필수다. 실제 세대 대조는 아래
			// ApplyPushRecords 의 fence(트랜잭션 내 WHERE vault_epoch = ?)가 한다 —
			// 여기서 미리 비교해도 커밋 전에 초기화/재설정이 끼어들 수 있기 때문이다.
			if !epochHeaderValid {
				ctx.JSON(http.StatusConflict, gin.H{"error": "동기화 암호가 초기화되었습니다. 새 동기화 암호로 잠금을 해제해 주세요.", "code": vaultDekMismatchCode})
				return
			}
		} else if epochHeaderValid {
			// E2EE 기기가 epoch 헤더로 push 하는데 볼트가 v1 이다 — 초기화 후 구버전 클라
			// 로그인이 v1 을 lazy 재생성한 경우다. 받아주면 v1 볼트에 v2 암호문이 섞여
			// 구버전 기기가 복호화하지 못한다. 옛 세대 기기로 취급해 재판정시킨다.
			ctx.JSON(http.StatusConflict, gin.H{"error": "동기화 암호가 초기화되었습니다. 새 동기화 암호로 잠금을 해제해 주세요.", "code": vaultDekMismatchCode})
			return
		}
		var payload syncmodel.Payload
		if err := ctx.ShouldBindJSON(&payload); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		// 모든 kind upsert + revision bump 를 단일 트랜잭션으로(원자성). 데이터가 커밋됐는데
		// revision 은 옛 값인 창이 없어야 다른 기기가 304 로 변경을 놓치지 않는다.
		fence := storepkg.VaultPushFence{Epoch: vault.Epoch, Version: vault.Version}
		if vault.Version >= 2 {
			fence.Epoch = headerEpoch
		}
		revision, err := store.ApplyPushRecords(ctx.Request.Context(), userID, payload, fence)
		if err != nil {
			if errors.Is(err, storepkg.ErrVaultEpochMismatch) {
				ctx.JSON(http.StatusConflict, gin.H{"error": "동기화 암호가 초기화되었습니다. 새 동기화 암호로 잠금을 해제해 주세요.", "code": vaultDekMismatchCode})
				return
			}
			// 클라이언트가 보낸 레코드 자체의 문제(잘못된 타임스탬프 등)는 400 — 재시도해도
			// 영원히 실패하는 것을 5xx 로 위장해 서버 알림을 오염시키지 않는다.
			if errors.Is(err, storepkg.ErrBadSyncRecord) {
				logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
				return
			}
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		// 새 revision 을 돌려줘 push 한 기기가 자기 push 를 다시 pull 하지 않게 한다.
		ctx.JSON(http.StatusAccepted, gin.H{"revision": revision})
	})

	return router, nil
}

func resolveServerVersion(value string) string {
	if strings.TrimSpace(value) == "" {
		return "dev"
	}
	return strings.TrimSpace(value)
}

func shouldRedirectDirectlyToOIDC(config RouterConfig, runtime *oidcRuntime) bool {
	return !config.LocalAuthEnabled && runtime != nil
}

func redirectToOIDCStart(ctx *gin.Context) {
	target := url.URL{
		Path:     "/auth/oidc/start",
		RawQuery: ctx.Request.URL.RawQuery,
	}
	ctx.Redirect(http.StatusFound, target.String())
}

func newOIDCRuntime(config OIDCConfig) (*oidcRuntime, error) {
	if !config.Enabled {
		return nil, nil
	}
	if config.DisplayName == "" {
		config.DisplayName = "SSO"
	}
	if len(config.Scopes) == 0 {
		config.Scopes = []string{oidc.ScopeOpenID, "profile", "email"}
	}
	provider, err := oidc.NewProvider(context.Background(), config.IssuerURL)
	if err != nil {
		return nil, err
	}
	return &oidcRuntime{
		provider: provider,
		verifier: provider.Verifier(&oidc.Config{ClientID: config.ClientID}),
		oauth: &oauth2.Config{
			ClientID:     config.ClientID,
			ClientSecret: config.ClientSecret,
			Endpoint:     provider.Endpoint(),
			RedirectURL:  config.RedirectURL,
			Scopes:       config.Scopes,
		},
		config: config,
	}, nil
}

func oidcButtonLabel(runtime *oidcRuntime) string {
	if runtime == nil {
		return ""
	}
	if runtime.config.DisplayName != "" {
		return runtime.config.DisplayName
	}
	return "SSO"
}

// browserLoginPlatform 은 브라우저 로그인 요청이 실어 보낸 플랫폼 식별자(ios/android)를
// 돌려준다. 앱이 로그인 URL 을 열 때는 쿼리로, 폼 제출 후 재렌더에서는 hidden 필드로 온다.
func browserLoginPlatform(ctx *gin.Context) string {
	if platform := strings.TrimSpace(ctx.Query("platform")); platform != "" {
		return platform
	}
	return strings.TrimSpace(ctx.PostForm("platform"))
}

// oidcVisibleForPlatform — HideOnIOS 가 켜진 서버는 iOS 앱에서 연 브라우저 로그인에 한해
// OIDC 버튼을 숨긴다. 로컬 인증이 꺼진 서버에서 숨기면 iOS 에 남는 로그인 수단이 없어지므로
// 그 경우 플래그를 무시한다 — 덕분에 로컬 인증 없이 OIDC 단독인 서버의 즉시 리다이렉트
// 동작도 그대로 유지된다.
func oidcVisibleForPlatform(config RouterConfig, runtime *oidcRuntime, platform string) bool {
	if runtime == nil {
		return false
	}
	if config.OIDC.HideOnIOS && config.LocalAuthEnabled && platform == "ios" {
		return false
	}
	return true
}

func validateDesktopRedirectURI(raw string) error {
	if raw == "" {
		return errors.New("missing redirect_uri")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return err
	}
	switch parsed.Scheme {
	case "dolgate":
		if parsed.Host != "auth" || parsed.Path != "/callback" {
			return errors.New("invalid redirect_uri")
		}
		return nil
	case "http":
		host := parsed.Hostname()
		if (host != "127.0.0.1" && host != "localhost") || parsed.Path != "/auth/callback" {
			return errors.New("invalid redirect_uri")
		}
		if parsed.Port() == "" {
			return errors.New("invalid redirect_uri")
		}
		return nil
	default:
		return errors.New("invalid redirect_uri")
	}
}

func buildDesktopCallbackURL(redirectURI string, code string, state string) string {
	parsed, _ := url.Parse(redirectURI)
	query := parsed.Query()
	query.Set("code", code)
	if state != "" {
		query.Set("state", state)
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func buildMobileAwsSsoCallbackURL(
	code string,
	state string,
	authError string,
	errorDescription string,
) string {
	parsed, _ := url.Parse("dolgate://aws-sso/callback")
	query := parsed.Query()
	if code != "" {
		query.Set("code", code)
	}
	if state != "" {
		query.Set("state", state)
	}
	if authError != "" {
		query.Set("error", authError)
	}
	if errorDescription != "" {
		query.Set("error_description", errorDescription)
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func renderLoginPage(ctx *gin.Context, data loginPageData) {
	applyAuthHTMLResponseHeaders(ctx)
	ctx.Header("Content-Type", "text/html; charset=utf-8")
	if data.Title == "" {
		data.Title = "Sign in to Dolgate"
	}
	_ = loginPageTemplate.Execute(ctx.Writer, data)
}

func renderDesktopCallbackBridgePage(ctx *gin.Context, callbackURL string) {
	applyAuthHTMLResponseHeaders(ctx)
	ctx.Header("Content-Type", "text/html; charset=utf-8")
	_ = desktopCallbackBridgeTemplate.Execute(ctx.Writer, struct {
		CallbackURLAttr template.URL
		CallbackURLJSON template.JS
	}{
		CallbackURLAttr: template.URL(callbackURL),
		CallbackURLJSON: template.JS(strconv.Quote(callbackURL)),
	})
}

// renderOIDCExchangeBridgePage shows a tiny interstitial that POSTs the OIDC
// authorization code + state to /auth/oidc/complete via JS. A passive GET of the
// callback (prefetch, ad-block/security extension, link scanner) renders this
// page but never runs the submit, so the single-use code is not consumed; only a
// real user navigation completes the exchange. code/state are auto-escaped by
// html/template in the hidden-input attribute context.
func renderOIDCExchangeBridgePage(ctx *gin.Context, code string, state string) {
	applyAuthHTMLResponseHeaders(ctx)
	ctx.Header("Cache-Control", "no-store")
	ctx.Header("Content-Type", "text/html; charset=utf-8")
	_ = oidcExchangeBridgeTemplate.Execute(ctx.Writer, struct {
		Code  string
		State string
	}{Code: code, State: state})
}

func completeDesktopLogin(ctx *gin.Context, redirectURI string, code string, state string) {
	callbackURL := buildDesktopCallbackURL(redirectURI, code, state)
	renderDesktopCallbackBridgePage(ctx, callbackURL)
}

func resolveRequestOrigin(ctx *gin.Context) string {
	scheme := "http"
	if forwarded := strings.TrimSpace(ctx.GetHeader("X-Forwarded-Proto")); forwarded != "" {
		scheme = forwarded
	} else if ctx.Request.TLS != nil {
		scheme = "https"
	}

	host := strings.TrimSpace(ctx.Request.Host)
	if host == "" {
		host = "localhost"
	}
	return scheme + "://" + host
}

type authMiddlewareOptions struct {
	AllowQueryAccessToken bool
}

func authMiddleware(authService *auth.Service) gin.HandlerFunc {
	return authMiddlewareWithOptions(authService, authMiddlewareOptions{})
}

func authMiddlewareWithOptions(authService *auth.Service, options authMiddlewareOptions) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		token := extractBearerToken(ctx, options)
		if strings.TrimSpace(token) == "" {
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing bearer token"})
			return
		}

		claims, err := authService.ParseAccessToken(token)
		if err != nil {
			log.Printf("http error (401): access token validation failed: %v", err)
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "인증에 실패했습니다."})
			return
		}

		ctx.Set("userId", claims.UserID)
		ctx.Next()
	}
}

func extractBearerToken(ctx *gin.Context, options authMiddlewareOptions) string {
	authorization := ctx.GetHeader("Authorization")
	if strings.HasPrefix(authorization, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(authorization, "Bearer "))
	}
	if options.AllowQueryAccessToken {
		return strings.TrimSpace(ctx.Query("access_token"))
	}
	return ""
}

const tooManyAuthAttemptsMessage = "너무 많은 인증 시도가 감지되었습니다. 잠시 후 다시 시도해 주세요."

// logAndJSONError/logAndStringError는 클라이언트에는 generic 메시지만 주고 원본 오류는 서버
// 로그에만 남긴다 — DB/OIDC/JWT 등 내부 오류 문자열이 응답 body로 새어 나가는 것을 막는다.
func logAndJSONError(ctx *gin.Context, status int, publicMsg string, err error) {
	if err != nil {
		log.Printf("http error (%d): %s: %v", status, publicMsg, err)
	}
	ctx.JSON(status, gin.H{"error": publicMsg})
}

func logAndStringError(ctx *gin.Context, status int, publicMsg string, err error) {
	if err != nil {
		log.Printf("http error (%d): %s: %v", status, publicMsg, err)
	}
	ctx.String(status, publicMsg)
}

func securityHeadersMiddleware() gin.HandlerFunc {
	return func(ctx *gin.Context) {
		applyCommonSecurityHeaders(ctx)
		ctx.Next()
	}
}

func applyCommonSecurityHeaders(ctx *gin.Context) {
	ctx.Header("X-Content-Type-Options", "nosniff")
	ctx.Header("Referrer-Policy", "no-referrer")
	ctx.Header("X-Frame-Options", "DENY")
}

func applyAuthHTMLResponseHeaders(ctx *gin.Context) {
	ctx.Header(
		"Content-Security-Policy",
		"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' http://localhost:* http://127.0.0.1:* http://[::1]:*; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:",
	)
}

func applyShareViewerResponseHeaders(ctx *gin.Context) {
	// The browser share viewer embeds xterm.js, which relies on runtime inline
	// styles for accurate terminal sizing and cell layout.
	ctx.Header(
		"Content-Security-Policy",
		"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:",
	)
}

func applyShareResponseHeaders(ctx *gin.Context) {
	ctx.Header("Cache-Control", "no-store")
	ctx.Header("Pragma", "no-cache")
	ctx.Header("X-Robots-Tag", "noindex, nofollow")
}

var loginPageTemplate = template.Must(template.New("login").Parse(`
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{ .Title }}</title>
    <style>
      body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0f1726; color:#f5f7fb; }
      .wrap { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:40px; }
      .card { width:100%; max-width:420px; background:#162133; border:1px solid rgba(255,255,255,.08); border-radius:24px; box-shadow:0 18px 48px rgba(0,0,0,.35); padding:32px; }
      .eyebrow { letter-spacing:.2em; font-size:12px; text-transform:uppercase; color:#9fb0d3; margin-bottom:10px; }
      h1 { margin:0 0 8px; font-size:34px; line-height:1.1; }
      p { color:#9fb0d3; margin:0 0 24px; }
      form { display:flex; flex-direction:column; gap:14px; }
      label { display:flex; flex-direction:column; gap:8px; font-size:14px; color:#ced7eb; }
      input { border:none; border-radius:14px; background:#0d1522; color:#f5f7fb; padding:14px 16px; font-size:15px; }
      button, a.button { display:inline-flex; justify-content:center; align-items:center; border:none; border-radius:14px; padding:14px 16px; font-size:15px; font-weight:700; text-decoration:none; cursor:pointer; }
      .primary { background:#5f7cff; color:white; }
      .secondary { background:#24324a; color:white; }
      .stack { display:flex; flex-direction:column; gap:12px; }
      .error { background:rgba(255,92,92,.12); color:#ffb8b8; border:1px solid rgba(255,92,92,.18); border-radius:14px; padding:12px 14px; margin-bottom:18px; }
      .foot { margin-top:16px; color:#8fa0c5; font-size:13px; }
      .divider { margin:18px 0; border-top:1px solid rgba(255,255,255,.08); }
      .actions { display:flex; flex-direction:column; gap:12px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="eyebrow">Dolgate</div>
        <h1>{{ .Title }}</h1>
        <p>브라우저에서 로그인한 뒤 앱으로 돌아갑니다.</p>
        {{ if .ErrorMessage }}
          <div class="error">{{ .ErrorMessage }}</div>
        {{ end }}
        {{ if .LocalAuthEnabled }}
          <form method="post" action="{{ if .IsSignup }}/signup{{ else }}/login{{ end }}">
            <input type="hidden" name="client" value="{{ .Client }}" />
            <input type="hidden" name="redirect_uri" value="{{ .RedirectURI }}" />
            <input type="hidden" name="state" value="{{ .State }}" />
            <input type="hidden" name="platform" value="{{ .Platform }}" />
            <label>Email
              <input type="email" name="email" value="{{ .Email }}" required />
            </label>
            <label>Password
              <input type="password" name="password" required minlength="8" />
            </label>
            <button class="primary" type="submit">{{ if .IsSignup }}Create account{{ else }}Sign in{{ end }}</button>
          </form>
        {{ end }}
        {{ if and .ShowSignupLink (not .IsSignup) }}
          <div class="foot">계정이 없나요? <a href="/signup?client={{ .Client }}&redirect_uri={{ .RedirectURI }}&state={{ .State }}&platform={{ .Platform }}" style="color:#b9c8ff">회원가입</a></div>
        {{ end }}
        {{ if and .LocalAuthEnabled .OIDCEnabled }}
          <div class="divider"></div>
        {{ end }}
        {{ if .OIDCEnabled }}
          <div class="actions">
            <a class="button secondary" href="/auth/oidc/start?client={{ .Client }}&redirect_uri={{ .RedirectURI }}&state={{ .State }}">Continue with {{ .OIDCDisplayName }}</a>
          </div>
        {{ end }}
      </div>
    </div>
  </body>
</html>
`))

var oidcExchangeBridgeTemplate = template.Must(template.New("oidc-exchange-bridge").Parse(`
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Dolgate 로그인 처리 중</title>
    <style>
      body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0f1726; color:#f5f7fb; }
      .wrap { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:40px; }
      .card { width:100%; max-width:460px; background:#162133; border:1px solid rgba(255,255,255,.08); border-radius:24px; box-shadow:0 18px 48px rgba(0,0,0,.35); padding:32px; }
      .eyebrow { letter-spacing:.2em; font-size:12px; text-transform:uppercase; color:#9fb0d3; margin-bottom:10px; }
      h1 { margin:0 0 10px; font-size:28px; line-height:1.1; }
      p { color:#9fb0d3; margin:0 0 22px; line-height:1.55; }
      button.button { display:inline-flex; justify-content:center; align-items:center; border:none; border-radius:16px; padding:14px 18px; font-size:15px; font-weight:700; cursor:pointer; background:#24324a; color:#fff; border:1px solid rgba(185,200,255,.34); }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="eyebrow">Dolgate</div>
        <h1>로그인 처리 중…</h1>
        <p>잠시만 기다려 주세요. 자동으로 진행되지 않으면 아래 버튼을 눌러 주세요.</p>
        <form id="complete-form" method="POST" action="/auth/oidc/complete">
          <input type="hidden" name="code" value="{{ .Code }}" />
          <input type="hidden" name="state" value="{{ .State }}" />
          <button type="submit" class="button">계속</button>
        </form>
      </div>
    </div>
    <script>
      (function () {
        var form = document.getElementById('complete-form');
        if (!form) { return; }
        var submitted = false;
        function submitOnce() {
          if (submitted) { return; }
          submitted = true;
          form.submit();
        }
        // prefetch는 이 스크립트를 실행하지 않아 코드가 보존된다. prerender는 활성화(실제
        // 사용자 네비게이션) 이후에만 제출해 미리 코드를 소진하지 않게 한다.
        if (document.prerendering) {
          document.addEventListener('prerenderingchange', submitOnce, { once: true });
        } else {
          submitOnce();
        }
      })();
    </script>
  </body>
</html>`))

var desktopCallbackBridgeTemplate = template.Must(template.New("desktop-callback-bridge").Parse(`
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Open Dolgate</title>
    <style>
      body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0f1726; color:#f5f7fb; }
      .wrap { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:40px; }
      .card { width:100%; max-width:460px; background:#162133; border:1px solid rgba(255,255,255,.08); border-radius:24px; box-shadow:0 18px 48px rgba(0,0,0,.35); padding:32px; }
      .eyebrow { letter-spacing:.2em; font-size:12px; text-transform:uppercase; color:#9fb0d3; margin-bottom:10px; }
      h1 { margin:0 0 10px; font-size:34px; line-height:1.08; }
      p { color:#9fb0d3; margin:0 0 22px; line-height:1.55; }
      a.button { display:inline-flex; justify-content:center; align-items:center; gap:10px; border:none; border-radius:16px; padding:14px 18px; font-size:15px; font-weight:700; text-decoration:none; cursor:pointer; }
      .primary { background:#24324a; color:white; border:1px solid rgba(185,200,255,.34); box-shadow:0 12px 28px rgba(0,0,0,.22); }
      .hint { margin-top:16px; color:#8fa0c5; font-size:13px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="eyebrow">Dolgate</div>
        <h1>앱으로 돌아가는 중</h1>
        <p>로그인은 완료되었습니다. Dolgate 앱이 자동으로 열리지 않으면 아래 버튼을 눌러 돌아가세요.</p>
        <a id="open-app" class="button primary" href="{{ .CallbackURLAttr }}">Dolgate 열기 ↗</a>
        <div class="hint">앱이 이미 열려 있다면 이 탭은 닫아도 됩니다.</div>
      </div>
    </div>
    <script>
      const target = {{ .CallbackURLJSON }};
      const openAppButton = document.getElementById('open-app');
      const openApp = () => {
        if (!target) {
          return;
        }
        window.location.assign(target);
      };
      if (openAppButton && target) {
        openAppButton.addEventListener('click', (event) => {
          event.preventDefault();
          openApp();
        });
      }
      window.addEventListener('load', () => {
        setTimeout(openApp, 80);
      });
    </script>
  </body>
</html>
`))
