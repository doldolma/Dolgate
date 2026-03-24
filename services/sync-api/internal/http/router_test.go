package http_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	authService := auth.NewService(sqliteStore, "test-secret", 15*time.Minute, time.Hour)
	router, err := httpserver.NewRouter(sqliteStore, authService, config)
	if err != nil {
		t.Fatalf("new router: %v", err)
	}
	return router
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
	}
	if err := json.Unmarshal(signupRecorder.Body.Bytes(), &signupResponse); err != nil {
		t.Fatalf("decode signup response: %v", err)
	}
	if signupResponse.VaultBootstrap.KeyBase64 == "" {
		t.Fatalf("expected vault bootstrap key")
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
	if oldRefreshRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected old refresh token to fail, got %d", oldRefreshRecorder.Code)
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
		"client":       {"dolssh-desktop"},
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
			ClientID:     "dolssh-desktop",
			ClientSecret: "secret",
			RedirectURL:  "http://127.0.0.1/callback",
		},
	})

	request := httptest.NewRequest(http.MethodGet, "/login?client=dolssh-desktop&redirect_uri=dolssh://auth/callback&state=test-state", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusFound {
		t.Fatalf("expected redirect, got %d", recorder.Code)
	}
	if recorder.Header().Get("Location") != "/auth/oidc/start?client=dolssh-desktop&redirect_uri=dolssh://auth/callback&state=test-state" {
		t.Fatalf("unexpected login redirect location: %s", recorder.Header().Get("Location"))
	}

	signupRequest := httptest.NewRequest(http.MethodGet, "/signup?client=dolssh-desktop&redirect_uri=dolssh://auth/callback&state=test-state", nil)
	signupRecorder := httptest.NewRecorder()
	router.ServeHTTP(signupRecorder, signupRequest)

	if signupRecorder.Code != http.StatusFound {
		t.Fatalf("expected signup redirect, got %d", signupRecorder.Code)
	}
	if signupRecorder.Header().Get("Location") != "/auth/oidc/start?client=dolssh-desktop&redirect_uri=dolssh://auth/callback&state=test-state" {
		t.Fatalf("unexpected signup redirect location: %s", signupRecorder.Header().Get("Location"))
	}
}
