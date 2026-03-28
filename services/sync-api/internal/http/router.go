package http

import (
	"context"
	"errors"
	"html/template"
	"net/http"
	"net/url"
	"strings"
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
	RateLimit          AuthRateLimitConfig
	OIDC               OIDCConfig
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

func NewRouter(store store.Store, authService *auth.Service, config RouterConfig) (*gin.Engine, error) {
	router := gin.New()
	if err := router.SetTrustedProxies(config.TrustedProxies); err != nil {
		return nil, err
	}
	router.Use(gin.Logger(), gin.Recovery(), securityHeadersMiddleware())
	shareHub := NewSessionShareHub()
	shareAssetHandler := http.StripPrefix("/share/assets/", http.FileServer(http.FS(mustShareAssetFS())))
	authLimiters := newAuthRouteLimiters(config.RateLimit)

	oidcRuntime, err := newOIDCRuntime(config.OIDC)
	if err != nil {
		return nil, err
	}

	router.GET("/healthz", func(ctx *gin.Context) {
		ctx.JSON(http.StatusOK, gin.H{"status": "ok", "time": time.Now().UTC().Format(time.RFC3339)})
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
			ctx.String(http.StatusBadRequest, err.Error())
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
			ctx.String(http.StatusInternalServerError, err.Error())
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
			ctx.String(http.StatusBadRequest, err.Error())
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
			ctx.String(http.StatusInternalServerError, err.Error())
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
			ctx.String(http.StatusBadRequest, err.Error())
			return
		}
		signedState, err := authService.NewBrowserLoginState(client, redirectURI, desktopState)
		if err != nil {
			ctx.String(http.StatusInternalServerError, err.Error())
			return
		}
		ctx.Redirect(http.StatusFound, oidcRuntime.oauth.AuthCodeURL(signedState))
	})

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

		loginState, err := authService.ParseBrowserLoginState(rawState)
		if err != nil {
			ctx.String(http.StatusUnauthorized, err.Error())
			return
		}

		token, err := oidcRuntime.oauth.Exchange(ctx.Request.Context(), code)
		if err != nil {
			ctx.String(http.StatusBadGateway, err.Error())
			return
		}

		rawIDToken, ok := token.Extra("id_token").(string)
		if !ok || rawIDToken == "" {
			ctx.String(http.StatusBadGateway, "oidc response missing id_token")
			return
		}

		idToken, err := oidcRuntime.verifier.Verify(ctx.Request.Context(), rawIDToken)
		if err != nil {
			ctx.String(http.StatusBadGateway, err.Error())
			return
		}

		var claims struct {
			Subject       string `json:"sub"`
			Email         string `json:"email"`
			EmailVerified bool   `json:"email_verified"`
		}
		if err := idToken.Claims(&claims); err != nil {
			ctx.String(http.StatusBadGateway, err.Error())
			return
		}

		user, err := authService.ResolveOIDCUser(ctx.Request.Context(), "oidc", claims.Subject, claims.Email, claims.EmailVerified)
		if err != nil {
			ctx.String(http.StatusInternalServerError, err.Error())
			return
		}

		exchangeCode, err := authService.IssueExchangeCode(ctx.Request.Context(), user)
		if err != nil {
			ctx.String(http.StatusInternalServerError, err.Error())
			return
		}
		completeDesktopLogin(ctx, loginState.RedirectURI, exchangeCode, loginState.State)
	})

	router.POST("/auth/signup", func(ctx *gin.Context) {
		var request authRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if !authLimiters.signup.Allow(authAttemptKeys(ctx.ClientIP(), request.Email)...) {
			ctx.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyAuthAttemptsMessage})
			return
		}

		_, session, err := authService.Signup(ctx.Request.Context(), request.Email, request.Password, resolveRequestOrigin(ctx))
		if err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		ctx.JSON(http.StatusCreated, session)
	})

	router.POST("/auth/login", func(ctx *gin.Context) {
		var request authRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
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
			ctx.JSON(status, gin.H{"error": err.Error()})
			return
		}
		ctx.JSON(http.StatusOK, session)
	})

	router.POST("/auth/exchange", func(ctx *gin.Context) {
		var request exchangeRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if !authLimiters.exchange.Allow(authAttemptKeys(ctx.ClientIP(), "")...) {
			ctx.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyAuthAttemptsMessage})
			return
		}
		session, err := authService.ExchangeCode(ctx.Request.Context(), request.Code, resolveRequestOrigin(ctx))
		if err != nil {
			ctx.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}
		ctx.JSON(http.StatusOK, session)
	})

	router.POST("/auth/refresh", func(ctx *gin.Context) {
		var request refreshRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if !authLimiters.refresh.Allow(authAttemptKeys(ctx.ClientIP(), "")...) {
			ctx.JSON(http.StatusTooManyRequests, gin.H{"error": tooManyAuthAttemptsMessage})
			return
		}
		session, err := authService.Refresh(ctx.Request.Context(), request.RefreshToken, resolveRequestOrigin(ctx))
		if err != nil {
			ctx.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}
		ctx.JSON(http.StatusOK, session)
	})

	router.POST("/auth/logout", func(ctx *gin.Context) {
		var request logoutRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if err := authService.Logout(ctx.Request.Context(), request.RefreshToken); err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		ctx.Status(http.StatusNoContent)
	})

	sessionShareGroup := router.Group("/api/session-shares")
	sessionShareGroup.Use(authMiddleware(authService))
	sessionShareGroup.POST("", func(ctx *gin.Context) {
		var request createSessionShareRequest
		if err := ctx.ShouldBindJSON(&request); err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if request.SessionID == "" || request.Title == "" || request.Cols <= 0 || request.Rows <= 0 || !isValidSessionShareTransport(request.Transport) {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid session share payload"})
			return
		}

		userID := ctx.GetString("userId")
		response := shareHub.Create(userID, request, requestBaseURL(ctx.Request))
		ctx.JSON(http.StatusCreated, response)
	})
	sessionShareGroup.POST("/:shareId/input", func(ctx *gin.Context) {
		var request struct {
			InputEnabled bool `json:"inputEnabled"`
		}
		if err := ctx.ShouldBindJSON(&request); err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		updated, err := shareHub.SetInputEnabled(ctx.GetString("userId"), ctx.Param("shareId"), request.InputEnabled)
		if err != nil {
			ctx.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		ctx.JSON(http.StatusOK, gin.H{"updated": updated})
	})
	sessionShareGroup.DELETE("/:shareId", func(ctx *gin.Context) {
		if err := shareHub.Delete(ctx.GetString("userId"), ctx.Param("shareId"), "세션 공유가 종료되었습니다."); err != nil {
			ctx.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
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
				ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
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
				ctx.String(http.StatusInternalServerError, err.Error())
			}
		}
	})

	syncGroup := router.Group("/sync")
	syncGroup.Use(authMiddleware(authService))
	syncGroup.GET("", func(ctx *gin.Context) {
		userID := ctx.GetString("userId")

		groups, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindGroups)
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		hosts, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindHosts)
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		secrets, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindSecrets)
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		knownHosts, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindKnownHosts)
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		portForwards, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindPortForwards)
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		preferences, err := store.ListSyncRecords(ctx.Request.Context(), userID, syncmodel.KindPreferences)
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		ctx.JSON(http.StatusOK, syncmodel.Payload{
			Groups:       groups,
			Hosts:        hosts,
			Secrets:      secrets,
			KnownHosts:   knownHosts,
			PortForwards: portForwards,
			Preferences:  preferences,
		})
	})
	syncGroup.POST("", func(ctx *gin.Context) {
		userID := ctx.GetString("userId")
		var payload syncmodel.Payload
		if err := ctx.ShouldBindJSON(&payload); err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindGroups, payload.Groups); err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindHosts, payload.Hosts); err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindSecrets, payload.Secrets); err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindKnownHosts, payload.KnownHosts); err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindPortForwards, payload.PortForwards); err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if err := store.UpsertSyncRecords(ctx.Request.Context(), userID, syncmodel.KindPreferences, payload.Preferences); err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		ctx.Status(http.StatusAccepted)
	})

	return router, nil
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
		CallbackURL string
	}{
		CallbackURL: callbackURL,
	})
}

func completeDesktopLogin(ctx *gin.Context, redirectURI string, code string, state string) {
	callbackURL := buildDesktopCallbackURL(redirectURI, code, state)
	parsed, err := url.Parse(redirectURI)
	if err != nil {
		ctx.String(http.StatusBadRequest, err.Error())
		return
	}
	if parsed.Scheme == "http" {
		ctx.Redirect(http.StatusFound, callbackURL)
		return
	}
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

func authMiddleware(authService *auth.Service) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		authorization := ctx.GetHeader("Authorization")
		if !strings.HasPrefix(authorization, "Bearer ") {
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing bearer token"})
			return
		}

		token := strings.TrimPrefix(authorization, "Bearer ")
		claims, err := authService.ParseAccessToken(token)
		if err != nil {
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}

		ctx.Set("userId", claims.UserID)
		ctx.Next()
	}
}

const tooManyAuthAttemptsMessage = "너무 많은 인증 시도가 감지되었습니다. 잠시 후 다시 시도해 주세요."

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
		"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:",
	)
}

func applyShareViewerResponseHeaders(ctx *gin.Context) {
	ctx.Header(
		"Content-Security-Policy",
		"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self' data:",
	)
}

func applyShareResponseHeaders(ctx *gin.Context) {
	ctx.Header("Cache-Control", "no-store")
	ctx.Header("Pragma", "no-cache")
	ctx.Header("X-Robots-Tag", "noindex, nofollow")
}

func requestBaseURL(request *http.Request) string {
	scheme := strings.TrimSpace(strings.Split(request.Header.Get("X-Forwarded-Proto"), ",")[0])
	if scheme == "" {
		if request.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}

	host := strings.TrimSpace(strings.Split(request.Header.Get("X-Forwarded-Host"), ",")[0])
	if host == "" {
		host = request.Host
	}
	return scheme + "://" + host
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
        <a id="open-app" class="button primary" href="{{ .CallbackURL }}">Dolgate 열기 ↗</a>
        <div class="hint">앱이 이미 열려 있다면 이 탭은 닫아도 됩니다.</div>
      </div>
    </div>
    <script>
      const target = document.getElementById('open-app').getAttribute('href');
      const openApp = () => {
        if (!target) {
          return;
        }
        window.location.href = target;
      };
      window.addEventListener('load', () => {
        setTimeout(openApp, 80);
      });
    </script>
  </body>
</html>
`))
