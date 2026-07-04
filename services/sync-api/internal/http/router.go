package http

import (
	"context"
	"errors"
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
}

type serverInfoSyncCapabilities struct {
	AWSProfiles bool `json:"awsProfiles"`
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

const (
	clientHeaderName               = "X-Dolgate-Client"
	clientVersionHeaderName        = "X-Dolgate-Client-Version"
	clientPlatformHeaderName       = "X-Dolgate-Platform"
	clientInstallationIDHeaderName = "X-Dolgate-Client-Installation-Id"
	unknownClientObservationValue  = "unknown"
)

type browserLoginForm struct {
	Email       string `form:"email"`
	Password    string `form:"password"`
	Client      string `form:"client"`
	RedirectURI string `form:"redirect_uri"`
	State       string `form:"state"`
}

type browserSignupForm struct {
	Email       string `form:"email"`
	Password    string `form:"password"`
	Client      string `form:"client"`
	RedirectURI string `form:"redirect_uri"`
	State       string `form:"state"`
}

type loginPageData struct {
	Title              string
	IsSignup           bool
	ErrorMessage       string
	Email              string
	Client             string
	RedirectURI        string
	State              string
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
			LocalAuthEnabled:   config.LocalAuthEnabled,
			LocalSignupEnabled: config.LocalSignupEnabled,
			OIDCEnabled:        oidcRuntime != nil,
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
				LocalAuthEnabled:   config.LocalAuthEnabled,
				LocalSignupEnabled: config.LocalSignupEnabled,
				OIDCEnabled:        oidcRuntime != nil,
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
				LocalAuthEnabled:   config.LocalAuthEnabled,
				LocalSignupEnabled: config.LocalSignupEnabled,
				OIDCEnabled:        oidcRuntime != nil,
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
				LocalAuthEnabled:   config.LocalAuthEnabled,
				LocalSignupEnabled: config.LocalSignupEnabled,
				OIDCEnabled:        oidcRuntime != nil,
				OIDCDisplayName:    oidcButtonLabel(oidcRuntime),
				ShowSignupLink:     config.LocalAuthEnabled && config.LocalSignupEnabled,
			})
			return
		}
		if err := validateDesktopRedirectURI(form.RedirectURI); err != nil {
			logAndStringError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}

		user, _, err := authService.Login(ctx.Request.Context(), form.Email, form.Password, resolveRequestOrigin(ctx))
		if err != nil {
			renderLoginPage(ctx, loginPageData{
				Title:              "Sign in to Dolgate",
				IsSignup:           false,
				ErrorMessage:       "이메일 또는 비밀번호가 올바르지 않습니다.",
				Email:              form.Email,
				Client:             form.Client,
				RedirectURI:        form.RedirectURI,
				State:              form.State,
				LocalAuthEnabled:   config.LocalAuthEnabled,
				LocalSignupEnabled: config.LocalSignupEnabled,
				OIDCEnabled:        oidcRuntime != nil,
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
			LocalAuthEnabled:   true,
			LocalSignupEnabled: true,
			OIDCEnabled:        oidcRuntime != nil,
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
				LocalAuthEnabled:   true,
				LocalSignupEnabled: true,
				OIDCEnabled:        oidcRuntime != nil,
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
				LocalAuthEnabled:   true,
				LocalSignupEnabled: true,
				OIDCEnabled:        oidcRuntime != nil,
				OIDCDisplayName:    oidcButtonLabel(oidcRuntime),
			})
			return
		}
		if err := validateDesktopRedirectURI(form.RedirectURI); err != nil {
			logAndStringError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}

		user, _, err := authService.Signup(ctx.Request.Context(), form.Email, form.Password, resolveRequestOrigin(ctx))
		if err != nil {
			renderLoginPage(ctx, loginPageData{
				Title:              "Create your Dolgate account",
				IsSignup:           true,
				ErrorMessage:       err.Error(),
				Email:              form.Email,
				Client:             form.Client,
				RedirectURI:        form.RedirectURI,
				State:              form.State,
				LocalAuthEnabled:   true,
				LocalSignupEnabled: true,
				OIDCEnabled:        oidcRuntime != nil,
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

		_, session, err := authService.Signup(ctx.Request.Context(), request.Email, request.Password, resolveRequestOrigin(ctx))
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

		_, session, err := authService.Login(ctx.Request.Context(), request.Email, request.Password, resolveRequestOrigin(ctx))
		if err != nil {
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
		session, err := authService.ExchangeCode(ctx.Request.Context(), request.Code, resolveRequestOrigin(ctx))
		if err != nil {
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
		session, err := authService.Refresh(ctx.Request.Context(), request.RefreshToken, resolveRequestOrigin(ctx))
		if err != nil {
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

	syncGroup := router.Group("/sync")
	syncGroup.Use(authMiddleware(authService))
	syncGroup.GET("", func(ctx *gin.Context) {
		userID := ctx.GetString("userId")

		groups, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindGroups)
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		hosts, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindHosts)
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		secrets, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindSecrets)
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		knownHosts, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindKnownHosts)
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		portForwards, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindPortForwards)
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		dnsOverrides, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindDNSOverrides)
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		preferences, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindPreferences)
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		awsProfiles, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindAWSProfiles)
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		snippets, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindSnippets)
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}

		ctx.JSON(http.StatusOK, syncmodel.Payload{
			Groups:       groups,
			Hosts:        hosts,
			Secrets:      secrets,
			KnownHosts:   knownHosts,
			PortForwards: portForwards,
			DNSOverrides: dnsOverrides,
			Preferences:  preferences,
			AWSProfiles:  awsProfiles,
			Snippets:     snippets,
		})
	})
	syncGroup.POST("", func(ctx *gin.Context) {
		userID := ctx.GetString("userId")
		var payload syncmodel.Payload
		if err := ctx.ShouldBindJSON(&payload); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindGroups, payload.Groups); err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindHosts, payload.Hosts); err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindSecrets, payload.Secrets); err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindKnownHosts, payload.KnownHosts); err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindPortForwards, payload.PortForwards); err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindDNSOverrides, payload.DNSOverrides); err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindPreferences, payload.Preferences); err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindAWSProfiles, payload.AWSProfiles); err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindSnippets, payload.Snippets); err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		ctx.Status(http.StatusAccepted)
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
          <div class="foot">계정이 없나요? <a href="/signup?client={{ .Client }}&redirect_uri={{ .RedirectURI }}&state={{ .State }}" style="color:#b9c8ff">회원가입</a></div>
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
