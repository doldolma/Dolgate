package http

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"dolssh/services/sync-api/internal/auth"
	"dolssh/services/sync-api/internal/store"
)

// WebAuthnRouterConfig 는 config.WebAuthnConfig 를 http 계층으로 전달하는 값이다.
type WebAuthnRouterConfig struct {
	Enabled       bool
	RPID          string
	RPDisplayName string
	Origins       []string
}

// webauthnRuntime 은 패스키가 실제로 활성화된 경우에만 만들어진다(nil = 비활성). nil 이면
// 관련 라우트를 아예 등록하지 않으므로 요청은 404 가 된다.
type webauthnRuntime struct {
	service *auth.WebAuthnService
}

// newWebAuthnRuntime 은 설정과 RP 유도 결과로 런타임을 만든다. Enabled 라도 RP 를 유도하지
// 못하면(https 도메인 origin 이 아니면) 경고 로그 후 nil 을 돌려 자동 비활성한다.
func newWebAuthnRuntime(dataStore store.Store, config RouterConfig) (*webauthnRuntime, error) {
	if !config.WebAuthn.Enabled {
		return nil, nil
	}
	rpID, origins, ok, reason := auth.DeriveWebAuthnRP(config.PublicBaseURL, config.WebAuthn.RPID, config.WebAuthn.Origins)
	if !ok {
		log.Printf("webauthn disabled: %s", reason)
		return nil, nil
	}
	service, err := auth.NewWebAuthnService(dataStore, rpID, config.WebAuthn.RPDisplayName, origins)
	if err != nil {
		return nil, err
	}
	log.Printf("webauthn enabled (rpId=%s, origins=%s)", rpID, strings.Join(origins, ","))
	return &webauthnRuntime{service: service}, nil
}

type webauthnLoginFinishRequest struct {
	CeremonyID  string          `json:"ceremonyId"`
	Client      string          `json:"client"`
	RedirectURI string          `json:"redirectUri"`
	State       string          `json:"state"`
	Credential  json.RawMessage `json:"credential"`
}

type webauthnRegisterBeginRequest struct {
	Ticket string `json:"ticket"`
}

type webauthnRegisterFinishRequest struct {
	Ticket     string          `json:"ticket"`
	CeremonyID string          `json:"ceremonyId"`
	Name       string          `json:"name"`
	Credential json.RawMessage `json:"credential"`
}

// registerWebAuthnRoutes 는 런타임이 있을 때만 패스키 라우트를 등록한다. 비활성 서버에서는
// 아무것도 등록하지 않아 모든 /auth/webauthn·/api/webauthn 요청이 404 가 된다.
func registerWebAuthnRoutes(
	router *gin.Engine,
	runtime *webauthnRuntime,
	authService *auth.Service,
	dataStore store.Store,
	limiters authRouteLimiters,
	config RouterConfig,
) {
	if runtime == nil {
		return
	}

	// --- discoverable 로그인 (공개) ---
	router.POST("/auth/webauthn/login/begin", func(ctx *gin.Context) {
		if !limiters.webauthn.Allow(authAttemptKeys(ctx.ClientIP(), "")...) {
			ctx.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyAuthAttemptsMessage})
			return
		}
		assertion, ceremonyID, err := runtime.service.BeginLogin(ctx.Request.Context())
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		ctx.JSON(http.StatusOK, gin.H{"ceremonyId": ceremonyID, "publicKey": assertion.Response})
	})

	router.POST("/auth/webauthn/login/finish", func(ctx *gin.Context) {
		if !limiters.webauthn.Allow(authAttemptKeys(ctx.ClientIP(), "")...) {
			ctx.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyAuthAttemptsMessage})
			return
		}
		var request webauthnLoginFinishRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if err := validateDesktopRedirectURI(request.RedirectURI); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if len(request.Credential) == 0 {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
			return
		}

		user, err := runtime.service.FinishLogin(ctx.Request.Context(), request.CeremonyID, request.Credential)
		if err != nil {
			// 서버에 기록이 없는(미등록) 자격증명이면 code 를 함께 내려, 클라이언트가
			// signalUnknownCredential 로 비밀번호 관리자의 stale 패스키를 정리하도록 한다.
			if errors.Is(err, auth.ErrUnknownWebAuthnCredential) {
				log.Printf("webauthn login finish: unknown credential (client will be signaled): %v", err)
				ctx.JSON(http.StatusUnauthorized, gin.H{"error": "등록되지 않은 패스키입니다.", "code": "unknown_credential"})
				return
			}
			// 복제 의심은 unknown 과 반대다 — 서버 기록은 멀쩡하므로 code 를 주지 않는다
			// (주면 클라이언트가 정상 패스키를 지운다). 대신 다음 행동을 알려 준다.
			if errors.Is(err, auth.ErrClonedWebAuthnCredential) {
				ctx.JSON(http.StatusUnauthorized, gin.H{
					"error": "이 패스키는 사용할 수 없습니다. 다른 방법으로 로그인한 뒤 설정에서 삭제하고 다시 등록해 주세요.",
				})
				return
			}
			logAndJSONError(ctx, http.StatusUnauthorized, "인증에 실패했습니다.", err)
			return
		}

		code, err := authService.IssueExchangeCode(ctx.Request.Context(), user)
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		if err := recordAuthClientObservation(ctx, dataStore, user.ID, "webauthn"); err != nil {
			_ = ctx.Error(err)
		}
		ctx.JSON(http.StatusOK, gin.H{"redirectUrl": buildDesktopCallbackURL(request.RedirectURI, code, request.State)})
	})

	// --- 등록 (브라우저, 티켓 인가) ---
	router.GET("/auth/webauthn/register", func(ctx *gin.Context) {
		// 티켓은 URL fragment(#ticket=)로 전달되어 서버로 오지 않는다 — 액세스 로그·프록시
		// 로그에 남지 않게 하기 위함(CWE-598 회피). 페이지 JS 가 location.hash 에서 읽어
		// begin/finish 에 실어 보내고, 실제 검증은 그 단계에서 한다.
		renderWebAuthnRegisterPage(ctx)
	})

	router.POST("/auth/webauthn/register/begin", func(ctx *gin.Context) {
		// 티켓 하나로 ceremony 를 무한정 만들 수 있고, 가짜 티켓도 매번 RSA 검증을 태운다.
		if !limiters.webauthn.Allow(authAttemptKeys(ctx.ClientIP(), "")...) {
			ctx.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyAuthAttemptsMessage})
			return
		}
		var request webauthnRegisterBeginRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		userID, _, err := authService.ParseWebAuthnRegisterTicket(request.Ticket)
		if err != nil {
			logAndJSONError(ctx, http.StatusUnauthorized, "인증에 실패했습니다.", err)
			return
		}
		creation, ceremonyID, err := runtime.service.BeginRegistration(ctx.Request.Context(), userID)
		if errors.Is(err, auth.ErrTooManyWebAuthnCredentials) {
			logAndJSONError(ctx, http.StatusConflict, tooManyPasskeysMessage, err)
			return
		}
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		ctx.JSON(http.StatusOK, gin.H{"ceremonyId": ceremonyID, "publicKey": creation.Response})
	})

	router.POST("/auth/webauthn/register/finish", func(ctx *gin.Context) {
		if !limiters.webauthn.Allow(authAttemptKeys(ctx.ClientIP(), "")...) {
			ctx.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyAuthAttemptsMessage})
			return
		}
		var request webauthnRegisterFinishRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		userID, ticketID, err := authService.ParseWebAuthnRegisterTicket(request.Ticket)
		if err != nil {
			logAndJSONError(ctx, http.StatusUnauthorized, "인증에 실패했습니다.", err)
			return
		}
		if len(request.Credential) == 0 {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
			return
		}
		err = runtime.service.FinishRegistration(ctx.Request.Context(), userID, request.CeremonyID, request.Name, request.Credential)
		if errors.Is(err, auth.ErrTooManyWebAuthnCredentials) {
			logAndJSONError(ctx, http.StatusConflict, tooManyPasskeysMessage, err)
			return
		}
		if err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "패스키 등록에 실패했습니다.", err)
			return
		}
		// 티켓은 등록이 실제로 성사된 뒤에 태운다. 앞에서 태우면 이후 어떤 실패(개수 상한,
		// DB 오류)든 티켓과 ceremony 를 함께 날려, 인증기에는 패스키가 이미 만들어졌는데
		// 재시도는 막히는 상태가 된다. 티켓당 성공 등록은 한 번뿐이라는 성질은 그대로다.
		if err := authService.ConsumeWebAuthnRegisterTicket(ctx.Request.Context(), userID, ticketID); err != nil {
			logAndJSONError(ctx, http.StatusUnauthorized, "등록 링크가 만료되었거나 이미 사용되었습니다.", err)
			return
		}
		ctx.JSON(http.StatusOK, gin.H{"ok": true})
	})

	// --- 앱용 관리 (Bearer) ---
	group := router.Group("/api/webauthn")
	group.Use(authMiddleware(authService))
	group.POST("/registration-ticket", func(ctx *gin.Context) {
		userID := ctx.GetString("userId")
		// 발급이 ceremony 행을 하나씩 남기게 됐다 — 인증된 클라이언트라도 무제한으로
		// 부르면 정리가 쫓아가야 할 양이 계속 늘어난다.
		if !limiters.webauthn.Allow(authAttemptKeys(ctx.ClientIP(), userID)...) {
			ctx.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyAuthAttemptsMessage})
			return
		}
		ticket, err := authService.NewWebAuthnRegisterTicket(ctx.Request.Context(), userID)
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		base := strings.TrimSpace(config.PublicBaseURL)
		if base == "" {
			base = resolveRequestOrigin(ctx)
		}
		// 티켓은 fragment 로 실어 서버 로그·히스토리에 남지 않게 한다. 데스크톱 앱은 이 url 을
		// 그대로 쓰지 않고 자기 설정의 serverUrl 로 재조립하지만(임의 URL 실행 차단), 다른
		// 클라이언트를 위해 안전한 형태로 내려준다.
		registerURL := strings.TrimRight(base, "/") + "/auth/webauthn/register#ticket=" + url.QueryEscape(ticket)
		ctx.JSON(http.StatusOK, gin.H{"url": registerURL, "ticket": ticket})
	})
	group.GET("/credentials", func(ctx *gin.Context) {
		credentials, err := dataStore.ListWebAuthnCredentialsByUser(ctx.Request.Context(), ctx.GetString("userId"))
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		items := make([]gin.H, 0, len(credentials))
		for _, credential := range credentials {
			items = append(items, gin.H{
				"id":         credential.CredentialID,
				"name":       credential.Name,
				"createdAt":  credential.CreatedAt.UTC().Format(time.RFC3339),
				"lastUsedAt": credential.LastUsedAt.UTC().Format(time.RFC3339),
			})
		}
		ctx.JSON(http.StatusOK, gin.H{"credentials": items})
	})
	group.DELETE("/credentials/:id", func(ctx *gin.Context) {
		if err := dataStore.DeleteWebAuthnCredential(ctx.Request.Context(), ctx.GetString("userId"), ctx.Param("id")); err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			return
		}
		ctx.Status(http.StatusNoContent)
	})
}
