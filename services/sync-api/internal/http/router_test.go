package http_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"dolssh/services/sync-api/internal/auth"
	httpserver "dolssh/services/sync-api/internal/http"
	"dolssh/services/sync-api/internal/store"
	syncmodel "dolssh/services/sync-api/internal/sync"
)

func createTestRouter(t *testing.T) *gin.Engine {
	return createTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
	})
}

func createTestRouterWithConfig(t *testing.T, config httpserver.RouterConfig) *gin.Engine {
	t.Helper()

	sqliteStore, err := store.OpenSQLite("file:dolssh_sync_test?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() {
		if err := sqliteStore.Close(); err != nil {
			t.Fatalf("close sqlite: %v", err)
		}
	})
	authService, err := auth.NewService(
		sqliteStore,
		"",
		filepath.Join(t.TempDir(), "auth-signing-private.pem"),
		15*time.Minute,
		time.Hour,
		72*time.Hour,
		2*time.Minute,
	)
	if err != nil {
		t.Fatalf("new auth service: %v", err)
	}
	router, err := httpserver.NewRouter(sqliteStore, authService, config)
	if err != nil {
		t.Fatalf("new router: %v", err)
	}
	return router
}

func assertCommonSecurityHeaders(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("expected nosniff header, got %q", response.Header().Get("X-Content-Type-Options"))
	}
	if response.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("expected no-referrer header, got %q", response.Header().Get("Referrer-Policy"))
	}
	if response.Header().Get("X-Frame-Options") != "DENY" {
		t.Fatalf("expected DENY X-Frame-Options, got %q", response.Header().Get("X-Frame-Options"))
	}
}

func createOIDCTestServer(t *testing.T) *httptest.Server {
	t.Helper()

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/.well-known/openid-configuration":
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{
				"issuer":"` + server.URL + `",
				"authorization_endpoint":"` + server.URL + `/authorize",
				"token_endpoint":"` + server.URL + `/token",
				"jwks_uri":"` + server.URL + `/keys"
			}`))
		case "/keys":
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"keys":[]}`))
		default:
			http.NotFound(writer, request)
		}
	}))

	return server
}

func TestAuthRefreshAndSyncFlow(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	signupBody := bytes.NewBufferString(`{"email":"user@example.com","password":"supersecure"}`)
	signupRequest := httptest.NewRequest(http.MethodPost, "/auth/signup", signupBody)
	signupRequest.Header.Set("Content-Type", "application/json")
	signupRecorder := httptest.NewRecorder()
	router.ServeHTTP(signupRecorder, signupRequest)
	if signupRecorder.Code != http.StatusCreated {
		t.Fatalf("expected signup to succeed, got %d: %s", signupRecorder.Code, signupRecorder.Body.String())
	}

	var signupResponse struct {
		User struct {
			ID    string `json:"id"`
			Email string `json:"email"`
		} `json:"user"`
		Tokens struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
		} `json:"tokens"`
		VaultBootstrap struct {
			KeyBase64 string `json:"keyBase64"`
		} `json:"vaultBootstrap"`
		OfflineLease struct {
			Token string `json:"token"`
		} `json:"offlineLease"`
	}
	if err := json.Unmarshal(signupRecorder.Body.Bytes(), &signupResponse); err != nil {
		t.Fatalf("decode signup response: %v", err)
	}
	if signupResponse.VaultBootstrap.KeyBase64 == "" {
		t.Fatalf("expected vault bootstrap key")
	}
	if signupResponse.OfflineLease.Token == "" {
		t.Fatalf("expected offline lease in signup response")
	}

	payload := syncmodel.Payload{
		Groups: []syncmodel.Record{
			{
				ID:               "group-1",
				EncryptedPayload: "ciphertext-group",
				UpdatedAt:        "2026-03-21T15:00:00Z",
			},
		},
		Hosts: []syncmodel.Record{
			{
				ID:               "host-1",
				EncryptedPayload: "ciphertext-host",
				UpdatedAt:        "2026-03-21T15:00:00Z",
			},
		},
		Secrets: []syncmodel.Record{
			{
				ID:               "secret-1",
				EncryptedPayload: "ciphertext-secret",
				UpdatedAt:        "2026-03-21T15:00:00Z",
			},
		},
		Preferences: []syncmodel.Record{
			{
				ID:               "global-terminal",
				EncryptedPayload: "ciphertext-preferences",
				UpdatedAt:        "2026-03-21T15:00:00Z",
			},
		},
	}
	payloadBytes, _ := json.Marshal(payload)

	postSync := httptest.NewRequest(http.MethodPost, "/sync", bytes.NewReader(payloadBytes))
	postSync.Header.Set("Authorization", "Bearer "+signupResponse.Tokens.AccessToken)
	postSync.Header.Set("Content-Type", "application/json")
	postSyncRecorder := httptest.NewRecorder()
	router.ServeHTTP(postSyncRecorder, postSync)
	if postSyncRecorder.Code != http.StatusAccepted {
		t.Fatalf("expected sync upsert to succeed, got %d: %s", postSyncRecorder.Code, postSyncRecorder.Body.String())
	}

	getSync := httptest.NewRequest(http.MethodGet, "/sync", nil)
	getSync.Header.Set("Authorization", "Bearer "+signupResponse.Tokens.AccessToken)
	getSyncRecorder := httptest.NewRecorder()
	router.ServeHTTP(getSyncRecorder, getSync)
	if getSyncRecorder.Code != http.StatusOK {
		t.Fatalf("expected sync fetch to succeed, got %d: %s", getSyncRecorder.Code, getSyncRecorder.Body.String())
	}

	var syncResponse syncmodel.Payload
	if err := json.Unmarshal(getSyncRecorder.Body.Bytes(), &syncResponse); err != nil {
		t.Fatalf("decode sync response: %v", err)
	}
	if len(syncResponse.Groups) != 1 || len(syncResponse.Hosts) != 1 || len(syncResponse.Secrets) != 1 || len(syncResponse.Preferences) != 1 {
		t.Fatalf("unexpected sync response: %#v", syncResponse)
	}

	refreshBody := bytes.NewBufferString(`{"refreshToken":"` + signupResponse.Tokens.RefreshToken + `"}`)
	refreshRequest := httptest.NewRequest(http.MethodPost, "/auth/refresh", refreshBody)
	refreshRequest.Header.Set("Content-Type", "application/json")
	refreshRecorder := httptest.NewRecorder()
	router.ServeHTTP(refreshRecorder, refreshRequest)
	if refreshRecorder.Code != http.StatusOK {
		t.Fatalf("expected refresh to succeed, got %d: %s", refreshRecorder.Code, refreshRecorder.Body.String())
	}

	var refreshResponse struct {
		Tokens struct {
			RefreshToken string `json:"refreshToken"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(refreshRecorder.Body.Bytes(), &refreshResponse); err != nil {
		t.Fatalf("decode refresh response: %v", err)
	}
	if refreshResponse.Tokens.RefreshToken == "" || refreshResponse.Tokens.RefreshToken == signupResponse.Tokens.RefreshToken {
		t.Fatalf("expected rotated refresh token")
	}

	oldRefreshBody := bytes.NewBufferString(`{"refreshToken":"` + signupResponse.Tokens.RefreshToken + `"}`)
	oldRefreshRequest := httptest.NewRequest(http.MethodPost, "/auth/refresh", oldRefreshBody)
	oldRefreshRequest.Header.Set("Content-Type", "application/json")
	oldRefreshRecorder := httptest.NewRecorder()
	router.ServeHTTP(oldRefreshRecorder, oldRefreshRequest)
	if oldRefreshRecorder.Code != http.StatusOK {
		t.Fatalf("expected old refresh token to succeed during handoff, got %d", oldRefreshRecorder.Code)
	}
}

func TestSyncRequiresAuth(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	request := httptest.NewRequest(http.MethodGet, "/sync", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized, got %d", recorder.Code)
	}
}

func TestBrowserSignupAcceptsLoopbackRedirectURI(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	form := url.Values{
		"email":        {"loopback@example.com"},
		"password":     {"supersecure"},
		"client":       {"dolgate-desktop"},
		"redirect_uri": {"http://127.0.0.1:43123/auth/callback"},
		"state":        {"state-123"},
	}

	request := httptest.NewRequest(http.MethodPost, "/signup", strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusFound {
		t.Fatalf("expected redirect, got %d: %s", recorder.Code, recorder.Body.String())
	}

	location := recorder.Header().Get("Location")
	if !strings.HasPrefix(location, "http://127.0.0.1:43123/auth/callback?") {
		t.Fatalf("unexpected redirect location: %s", location)
	}
	if !strings.Contains(location, "code=") {
		t.Fatalf("expected exchange code in redirect location: %s", location)
	}
	if !strings.Contains(location, "state=state-123") {
		t.Fatalf("expected state in redirect location: %s", location)
	}
}

func TestLoginPageAppliesSecurityHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	request := httptest.NewRequest(http.MethodGet, "/login", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected login page, got %d", recorder.Code)
	}
	assertCommonSecurityHeaders(t, recorder)
	if !strings.Contains(recorder.Header().Get("Content-Security-Policy"), "default-src 'none'") {
		t.Fatalf("expected login page CSP header, got %q", recorder.Header().Get("Content-Security-Policy"))
	}
}

func TestDesktopCallbackBridgeAppliesSecurityHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	form := url.Values{
		"email":        {"bridge@example.com"},
		"password":     {"supersecure"},
		"client":       {"dolgate-desktop"},
		"redirect_uri": {"dolgate://auth/callback"},
		"state":        {"state-bridge"},
	}

	request := httptest.NewRequest(http.MethodPost, "/signup", strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected bridge page, got %d: %s", recorder.Code, recorder.Body.String())
	}
	assertCommonSecurityHeaders(t, recorder)
	if !strings.Contains(recorder.Header().Get("Content-Security-Policy"), "script-src 'self' 'unsafe-inline'") {
		t.Fatalf("expected bridge CSP header, got %q", recorder.Header().Get("Content-Security-Policy"))
	}
}

func TestOIDCOnlyLoginRedirectsImmediately(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oidcServer := createOIDCTestServer(t)
	defer oidcServer.Close()

	router := createTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled:   false,
		LocalSignupEnabled: false,
		OIDC: httpserver.OIDCConfig{
			Enabled:      true,
			DisplayName:  "SSO",
			IssuerURL:    oidcServer.URL,
			ClientID:     "dolgate-desktop",
			ClientSecret: "secret",
			RedirectURL:  "http://127.0.0.1/callback",
		},
	})

	request := httptest.NewRequest(http.MethodGet, "/login?client=dolgate-desktop&redirect_uri=dolgate://auth/callback&state=test-state", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusFound {
		t.Fatalf("expected redirect, got %d", recorder.Code)
	}
	if recorder.Header().Get("Location") != "/auth/oidc/start?client=dolgate-desktop&redirect_uri=dolgate://auth/callback&state=test-state" {
		t.Fatalf("unexpected login redirect location: %s", recorder.Header().Get("Location"))
	}

	signupRequest := httptest.NewRequest(http.MethodGet, "/signup?client=dolgate-desktop&redirect_uri=dolgate://auth/callback&state=test-state", nil)
	signupRecorder := httptest.NewRecorder()
	router.ServeHTTP(signupRecorder, signupRequest)

	if signupRecorder.Code != http.StatusFound {
		t.Fatalf("expected signup redirect, got %d", signupRecorder.Code)
	}
	if signupRecorder.Header().Get("Location") != "/auth/oidc/start?client=dolgate-desktop&redirect_uri=dolgate://auth/callback&state=test-state" {
		t.Fatalf("unexpected signup redirect location: %s", signupRecorder.Header().Get("Location"))
	}
}

func TestSessionShareCreateAndViewerPage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	signupBody := bytes.NewBufferString(`{"email":"share@example.com","password":"supersecure"}`)
	signupRequest := httptest.NewRequest(http.MethodPost, "/auth/signup", signupBody)
	signupRequest.Header.Set("Content-Type", "application/json")
	signupRecorder := httptest.NewRecorder()
	router.ServeHTTP(signupRecorder, signupRequest)
	if signupRecorder.Code != http.StatusCreated {
		t.Fatalf("expected signup to succeed, got %d: %s", signupRecorder.Code, signupRecorder.Body.String())
	}

	var signupResponse struct {
		Tokens struct {
			AccessToken string `json:"accessToken"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(signupRecorder.Body.Bytes(), &signupResponse); err != nil {
		t.Fatalf("decode signup response: %v", err)
	}

	createBody := bytes.NewBufferString(`{
		"sessionId":"session-1",
		"title":"Prod Shell",
		"hostLabel":"prod.example.com",
		"cols":120,
		"rows":32,
		"snapshot":"\u001b[2J"
	}`)
	createRequest := httptest.NewRequest(http.MethodPost, "/api/session-shares", createBody)
	createRequest.Header.Set("Authorization", "Bearer "+signupResponse.Tokens.AccessToken)
	createRequest.Header.Set("Content-Type", "application/json")
	createRecorder := httptest.NewRecorder()
	router.ServeHTTP(createRecorder, createRequest)
	if createRecorder.Code != http.StatusCreated {
		t.Fatalf("expected share create to succeed, got %d: %s", createRecorder.Code, createRecorder.Body.String())
	}

	var createResponse struct {
		ShareID   string `json:"shareId"`
		ViewerURL string `json:"viewerUrl"`
	}
	if err := json.Unmarshal(createRecorder.Body.Bytes(), &createResponse); err != nil {
		t.Fatalf("decode share create response: %v", err)
	}
	if createResponse.ShareID == "" || createResponse.ViewerURL == "" {
		t.Fatalf("expected share identifiers in response: %s", createRecorder.Body.String())
	}

	viewerURL, err := url.Parse(createResponse.ViewerURL)
	if err != nil {
		t.Fatalf("parse viewer url: %v", err)
	}

	viewerRequest := httptest.NewRequest(http.MethodGet, viewerURL.RequestURI(), nil)
	viewerRecorder := httptest.NewRecorder()
	router.ServeHTTP(viewerRecorder, viewerRequest)
	if viewerRecorder.Code != http.StatusOK {
		t.Fatalf("expected viewer page to load, got %d: %s", viewerRecorder.Code, viewerRecorder.Body.String())
	}
	assertCommonSecurityHeaders(t, viewerRecorder)
	if viewerRecorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("expected no-store cache control, got %q", viewerRecorder.Header().Get("Cache-Control"))
	}
	if !strings.Contains(viewerRecorder.Header().Get("Content-Security-Policy"), "connect-src 'self'") {
		t.Fatalf("expected viewer CSP header, got %q", viewerRecorder.Header().Get("Content-Security-Policy"))
	}
	if !strings.Contains(viewerRecorder.Body.String(), `data-share-id="`) {
		t.Fatalf("expected viewer page html to contain share metadata: %s", viewerRecorder.Body.String())
	}
	if !strings.Contains(viewerRecorder.Body.String(), `/share/assets/viewer.js?v=`) {
		t.Fatalf("expected viewer page html to contain versioned viewer asset url: %s", viewerRecorder.Body.String())
	}
	if !strings.Contains(viewerRecorder.Body.String(), `/share/assets/vendor/xterm-addon-search.js?v=`) {
		t.Fatalf("expected viewer page html to contain versioned search addon asset url: %s", viewerRecorder.Body.String())
	}
	if !strings.Contains(viewerRecorder.Body.String(), `id="viewer-search-input"`) {
		t.Fatalf("expected viewer page html to contain search overlay markup: %s", viewerRecorder.Body.String())
	}

	invalidViewerRequest := httptest.NewRequest(http.MethodGet, "/share/"+createResponse.ShareID+"/invalid-token", nil)
	invalidViewerRecorder := httptest.NewRecorder()
	router.ServeHTTP(invalidViewerRecorder, invalidViewerRequest)
	if invalidViewerRecorder.Code != http.StatusNotFound {
		t.Fatalf("expected invalid viewer token to fail, got %d", invalidViewerRecorder.Code)
	}
}

func TestAuthLoginRateLimit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
		RateLimit: httpserver.AuthRateLimitConfig{
			Login: httpserver.RateLimitRuleConfig{
				Limit:         1,
				WindowSeconds: 300,
			},
		},
	})

	for attempt := 0; attempt < 2; attempt += 1 {
		request := httptest.NewRequest(http.MethodPost, "/auth/login", bytes.NewBufferString(`{"email":"limit@example.com","password":"supersecure"}`))
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)

		if attempt == 0 && recorder.Code != http.StatusUnauthorized {
			t.Fatalf("expected first attempt to be unauthorized, got %d", recorder.Code)
		}
		if attempt == 1 && recorder.Code != http.StatusTooManyRequests {
			t.Fatalf("expected second attempt to be rate limited, got %d: %s", recorder.Code, recorder.Body.String())
		}
	}
}

func TestTrustedProxiesAffectAuthRateLimitIdentity(t *testing.T) {
	gin.SetMode(gin.TestMode)
	withTrustedProxy := createTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
		TrustedProxies:     []string{"127.0.0.1"},
		RateLimit: httpserver.AuthRateLimitConfig{
			Exchange: httpserver.RateLimitRuleConfig{
				Limit:         1,
				WindowSeconds: 300,
			},
		},
	})

	forwardedIPs := []string{"203.0.113.10", "203.0.113.11"}
	for _, forwardedIP := range forwardedIPs {
		request := httptest.NewRequest(http.MethodPost, "/auth/exchange", bytes.NewBufferString(`{"code":"bad-code"}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Forwarded-For", forwardedIP)
		request.RemoteAddr = "127.0.0.1:43123"
		recorder := httptest.NewRecorder()
		withTrustedProxy.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("expected forwarded IP %s to be treated independently, got %d: %s", forwardedIP, recorder.Code, recorder.Body.String())
		}
	}

	withoutTrustedProxy := createTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
		RateLimit: httpserver.AuthRateLimitConfig{
			Exchange: httpserver.RateLimitRuleConfig{
				Limit:         1,
				WindowSeconds: 300,
			},
		},
	})

	first := httptest.NewRequest(http.MethodPost, "/auth/exchange", bytes.NewBufferString(`{"code":"bad-code"}`))
	first.Header.Set("Content-Type", "application/json")
	first.Header.Set("X-Forwarded-For", "203.0.113.10")
	first.RemoteAddr = "127.0.0.1:43123"
	firstRecorder := httptest.NewRecorder()
	withoutTrustedProxy.ServeHTTP(firstRecorder, first)
	if firstRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected first untrusted proxy request to be unauthorized, got %d", firstRecorder.Code)
	}

	second := httptest.NewRequest(http.MethodPost, "/auth/exchange", bytes.NewBufferString(`{"code":"bad-code"}`))
	second.Header.Set("Content-Type", "application/json")
	second.Header.Set("X-Forwarded-For", "203.0.113.11")
	second.RemoteAddr = "127.0.0.1:43123"
	secondRecorder := httptest.NewRecorder()
	withoutTrustedProxy.ServeHTTP(secondRecorder, second)
	if secondRecorder.Code != http.StatusTooManyRequests {
		t.Fatalf("expected second untrusted proxy request to be rate limited, got %d: %s", secondRecorder.Code, secondRecorder.Body.String())
	}
}
