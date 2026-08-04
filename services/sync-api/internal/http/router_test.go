package http_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"dolssh/services/sync-api/internal/auth"
	httpserver "dolssh/services/sync-api/internal/http"
	"dolssh/services/sync-api/internal/store"
	syncmodel "dolssh/services/sync-api/internal/sync"
)

type observingStore struct {
	*store.GormStore
	observations          []store.UserClientObservation
	vaultStateBarrierMu   sync.Mutex
	vaultStateObserved    chan struct{}
	vaultStateReadRelease chan struct{}
}

func (s *observingStore) UpsertUserClientObservation(ctx context.Context, observation store.UserClientObservation) error {
	s.observations = append(s.observations, observation)
	return s.GormStore.UpsertUserClientObservation(ctx, observation)
}

func (s *observingStore) GetUserVaultState(ctx context.Context, userID string) (store.UserVaultState, error) {
	state, err := s.GormStore.GetUserVaultState(ctx, userID)
	s.vaultStateBarrierMu.Lock()
	observed := s.vaultStateObserved
	release := s.vaultStateReadRelease
	s.vaultStateObserved = nil
	s.vaultStateReadRelease = nil
	s.vaultStateBarrierMu.Unlock()
	if observed != nil {
		close(observed)
		<-release
	}
	return state, err
}

func (s *observingStore) blockNextVaultStateRead() (<-chan struct{}, chan<- struct{}) {
	s.vaultStateBarrierMu.Lock()
	defer s.vaultStateBarrierMu.Unlock()
	s.vaultStateObserved = make(chan struct{})
	s.vaultStateReadRelease = make(chan struct{})
	return s.vaultStateObserved, s.vaultStateReadRelease
}

func createTestRouter(t *testing.T) *gin.Engine {
	return createTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
	})
}

func createTestRouterWithConfig(t *testing.T, config httpserver.RouterConfig) *gin.Engine {
	router, _, _ := createObservedTestRouterWithConfig(t, config)
	return router
}

func createObservedTestRouterWithConfig(
	t *testing.T,
	config httpserver.RouterConfig,
) (*gin.Engine, *observingStore, *auth.Service) {
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
	observedStore := &observingStore{GormStore: sqliteStore}
	authService, err := auth.NewService(
		observedStore,
		"",
		filepath.Join(t.TempDir(), "auth-signing-private.pem"),
		15*time.Minute,
		time.Hour,
		72*time.Hour,
		2*time.Minute,
		config.LocalAuthEnabled,
	)
	if err != nil {
		t.Fatalf("new auth service: %v", err)
	}
	router, err := httpserver.NewRouter(observedStore, authService, config)
	if err != nil {
		t.Fatalf("new router: %v", err)
	}
	return router, observedStore, authService
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

// 중복 이메일 가입은 드라이버 원문 에러를 사용자에게 보여선 안 된다. 예전에는 브라우저
// 폼이 "Duplicate entry '…' for key 'users.email'"(MySQL) / "UNIQUE constraint failed"
// (SQLite)를 그대로 렌더했다.
func TestDuplicateSignupHidesDriverError(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	signup := func(path string, body string, contentType string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
		request.Header.Set("Content-Type", contentType)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder
	}

	if code := signup("/auth/signup", `{"email":"dup@example.com","password":"supersecure"}`, "application/json").Code; code != http.StatusCreated {
		t.Fatalf("first signup = %d, want 201", code)
	}

	// JSON API: 409 + 사람이 읽는 문구.
	jsonRecorder := signup("/auth/signup", `{"email":"dup@example.com","password":"supersecure"}`, "application/json")
	if jsonRecorder.Code != http.StatusConflict {
		t.Fatalf("duplicate signup = %d, want 409: %s", jsonRecorder.Code, jsonRecorder.Body.String())
	}
	assertNoDriverError(t, "JSON", jsonRecorder.Body.String())
	if !strings.Contains(jsonRecorder.Body.String(), "이미 사용 중인 이메일입니다") {
		t.Fatalf("duplicate signup body = %s", jsonRecorder.Body.String())
	}

	// 브라우저 폼: 로그인 페이지가 다시 렌더되고 같은 문구가 뜬다.
	form := url.Values{}
	form.Set("email", "dup@example.com")
	form.Set("password", "supersecure")
	form.Set("redirect_uri", "http://127.0.0.1:53123/auth/callback")
	// 로그인 페이지는 요청 언어를 따르므로 단정할 문구의 언어를 고정한다.
	form.Set("lang", "ko")
	formBody := signup("/signup", form.Encode(), "application/x-www-form-urlencoded").Body.String()
	assertNoDriverError(t, "browser form", formBody)
	if !strings.Contains(formBody, "이미 사용 중인 이메일입니다") {
		t.Fatalf("browser signup page missing the duplicate message")
	}
}

func assertNoDriverError(t *testing.T, label string, body string) {
	t.Helper()
	for _, leak := range []string{"UNIQUE constraint", "Duplicate entry", "users.email", "SQLSTATE", "gorm"} {
		if strings.Contains(body, leak) {
			t.Fatalf("%s response leaks driver error %q: %s", label, leak, body)
		}
	}
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
		syncmodel.KindGroups: []syncmodel.Record{
			{
				ID:               "group-1",
				EncryptedPayload: "ciphertext-group",
				UpdatedAt:        "2026-03-21T15:00:00Z",
			},
		},
		syncmodel.KindHosts: []syncmodel.Record{
			{
				ID:               "host-1",
				EncryptedPayload: "ciphertext-host",
				UpdatedAt:        "2026-03-21T15:00:00Z",
			},
		},
		syncmodel.KindSecrets: []syncmodel.Record{
			{
				ID:               "secret-1",
				EncryptedPayload: "ciphertext-secret",
				UpdatedAt:        "2026-03-21T15:00:00Z",
			},
		},
		syncmodel.KindPreferences: []syncmodel.Record{
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
	if len(syncResponse[syncmodel.KindGroups]) != 1 || len(syncResponse[syncmodel.KindHosts]) != 1 || len(syncResponse[syncmodel.KindSecrets]) != 1 || len(syncResponse[syncmodel.KindPreferences]) != 1 {
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
	if refreshResponse.Tokens.RefreshToken == "" {
		t.Fatalf("expected refresh response to include a refresh token")
	}
	if refreshResponse.Tokens.RefreshToken != signupResponse.Tokens.RefreshToken {
		t.Fatalf("expected the same refresh token to slide forward (no rotation)")
	}

	reuseRefreshBody := bytes.NewBufferString(`{"refreshToken":"` + signupResponse.Tokens.RefreshToken + `"}`)
	reuseRefreshRequest := httptest.NewRequest(http.MethodPost, "/auth/refresh", reuseRefreshBody)
	reuseRefreshRequest.Header.Set("Content-Type", "application/json")
	reuseRefreshRecorder := httptest.NewRecorder()
	router.ServeHTTP(reuseRefreshRecorder, reuseRefreshRequest)
	if reuseRefreshRecorder.Code != http.StatusOK {
		t.Fatalf("expected the same refresh token to keep working, got %d", reuseRefreshRecorder.Code)
	}
}

func TestChangeAccountPasswordEndpoint(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	signupRequest := httptest.NewRequest(http.MethodPost, "/auth/signup", bytes.NewBufferString(`{"email":"password@example.com","password":"old-password"}`))
	signupRequest.Header.Set("Content-Type", "application/json")
	signupRecorder := httptest.NewRecorder()
	router.ServeHTTP(signupRecorder, signupRequest)
	if signupRecorder.Code != http.StatusCreated {
		t.Fatalf("signup status = %d: %s", signupRecorder.Code, signupRecorder.Body.String())
	}

	var session struct {
		User struct {
			PasswordState string `json:"passwordState"`
		} `json:"user"`
		Tokens struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(signupRecorder.Body.Bytes(), &session); err != nil {
		t.Fatalf("decode signup response: %v", err)
	}
	if session.User.PasswordState != "set" {
		t.Fatalf("passwordState = %q, want set", session.User.PasswordState)
	}

	changePassword := func(currentPassword string, newPassword string) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(map[string]string{
			"currentPassword": currentPassword,
			"newPassword":     newPassword,
			"refreshToken":    session.Tokens.RefreshToken,
		})
		if err != nil {
			t.Fatalf("encode password request: %v", err)
		}
		request := httptest.NewRequest(http.MethodPut, "/auth/account/password", bytes.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+session.Tokens.AccessToken)
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder
	}

	wrongCurrent := changePassword("wrong-password", "new-password")
	if wrongCurrent.Code != http.StatusBadRequest || !strings.Contains(wrongCurrent.Body.String(), `"code":"current_password_invalid"`) {
		t.Fatalf("wrong current response = %d: %s", wrongCurrent.Code, wrongCurrent.Body.String())
	}

	changed := changePassword("old-password", "new-password")
	if changed.Code != http.StatusOK || !strings.Contains(changed.Body.String(), `"passwordState":"set"`) {
		t.Fatalf("change response = %d: %s", changed.Code, changed.Body.String())
	}

	loginRequest := httptest.NewRequest(http.MethodPost, "/auth/login", bytes.NewBufferString(`{"email":"password@example.com","password":"new-password"}`))
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRecorder := httptest.NewRecorder()
	router.ServeHTTP(loginRecorder, loginRequest)
	if loginRecorder.Code != http.StatusOK {
		t.Fatalf("login with new password status = %d: %s", loginRecorder.Code, loginRecorder.Body.String())
	}
}

func TestAuthJSONEndpointsRecordClientObservationsOnSuccess(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router, observedStore, authService := createObservedTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
	})

	setClientHeaders := func(request *http.Request) {
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("User-Agent", "DolgateTest/1.6.1")
		request.Header.Set("X-Dolgate-Client", "desktop")
		request.Header.Set("X-Dolgate-Client-Version", "1.6.1")
		request.Header.Set("X-Dolgate-Platform", "macos")
		request.Header.Set("X-Dolgate-Client-Installation-Id", "install-test-1")
	}

	signupRequest := httptest.NewRequest(http.MethodPost, "/auth/signup", bytes.NewBufferString(`{"email":"observe@example.com","password":"supersecure"}`))
	setClientHeaders(signupRequest)
	signupRecorder := httptest.NewRecorder()
	router.ServeHTTP(signupRecorder, signupRequest)
	if signupRecorder.Code != http.StatusCreated {
		t.Fatalf("expected signup to succeed, got %d: %s", signupRecorder.Code, signupRecorder.Body.String())
	}

	var signupResponse struct {
		Tokens struct {
			RefreshToken string `json:"refreshToken"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(signupRecorder.Body.Bytes(), &signupResponse); err != nil {
		t.Fatalf("decode signup response: %v", err)
	}

	loginRequest := httptest.NewRequest(http.MethodPost, "/auth/login", bytes.NewBufferString(`{"email":"observe@example.com","password":"supersecure"}`))
	setClientHeaders(loginRequest)
	loginRecorder := httptest.NewRecorder()
	router.ServeHTTP(loginRecorder, loginRequest)
	if loginRecorder.Code != http.StatusOK {
		t.Fatalf("expected login to succeed, got %d: %s", loginRecorder.Code, loginRecorder.Body.String())
	}

	user, err := observedStore.GetUserByEmail(context.Background(), "observe@example.com")
	if err != nil {
		t.Fatalf("GetUserByEmail() error = %v", err)
	}
	exchangeCode, err := authService.IssueExchangeCode(context.Background(), user)
	if err != nil {
		t.Fatalf("IssueExchangeCode() error = %v", err)
	}

	exchangeRequest := httptest.NewRequest(http.MethodPost, "/auth/exchange", bytes.NewBufferString(`{"code":"`+exchangeCode+`"}`))
	setClientHeaders(exchangeRequest)
	exchangeRecorder := httptest.NewRecorder()
	router.ServeHTTP(exchangeRecorder, exchangeRequest)
	if exchangeRecorder.Code != http.StatusOK {
		t.Fatalf("expected exchange to succeed, got %d: %s", exchangeRecorder.Code, exchangeRecorder.Body.String())
	}

	refreshRequest := httptest.NewRequest(http.MethodPost, "/auth/refresh", bytes.NewBufferString(`{"refreshToken":"`+signupResponse.Tokens.RefreshToken+`"}`))
	setClientHeaders(refreshRequest)
	refreshRecorder := httptest.NewRecorder()
	router.ServeHTTP(refreshRecorder, refreshRequest)
	if refreshRecorder.Code != http.StatusOK {
		t.Fatalf("expected refresh to succeed, got %d: %s", refreshRecorder.Code, refreshRecorder.Body.String())
	}

	if len(observedStore.observations) != 4 {
		t.Fatalf("len(observations) = %d, want 4", len(observedStore.observations))
	}

	wantEvents := []string{"signup", "login", "exchange", "refresh"}
	for index, event := range wantEvents {
		observation := observedStore.observations[index]
		if observation.LastAuthEvent != event {
			t.Fatalf("observations[%d].LastAuthEvent = %q, want %q", index, observation.LastAuthEvent, event)
		}
		if observation.ClientName != "desktop" || observation.ClientVersion != "1.6.1" || observation.Platform != "macos" {
			t.Fatalf("unexpected client metadata: %+v", observation)
		}
		if observation.ClientInstallationID != "install-test-1" {
			t.Fatalf("ClientInstallationID = %q, want install-test-1", observation.ClientInstallationID)
		}
		if observation.LastIP == "" {
			t.Fatalf("expected LastIP to be populated")
		}
		if observation.LastUserAgent != "DolgateTest/1.6.1" {
			t.Fatalf("LastUserAgent = %q, want DolgateTest/1.6.1", observation.LastUserAgent)
		}
	}
}

func TestAuthJSONEndpointsSkipObservationOnFailureAndUseUnknownFallbacks(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router, observedStore, _ := createObservedTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
	})

	loginRequest := httptest.NewRequest(http.MethodPost, "/auth/login", bytes.NewBufferString(`{"email":"missing@example.com","password":"supersecure"}`))
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRecorder := httptest.NewRecorder()
	router.ServeHTTP(loginRecorder, loginRequest)
	if loginRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected login to fail, got %d: %s", loginRecorder.Code, loginRecorder.Body.String())
	}
	if len(observedStore.observations) != 0 {
		t.Fatalf("expected no observations after failed login, got %d", len(observedStore.observations))
	}

	signupRequest := httptest.NewRequest(http.MethodPost, "/auth/signup", bytes.NewBufferString(`{"email":"unknown@example.com","password":"supersecure"}`))
	signupRequest.Header.Set("Content-Type", "application/json")
	signupRecorder := httptest.NewRecorder()
	router.ServeHTTP(signupRecorder, signupRequest)
	if signupRecorder.Code != http.StatusCreated {
		t.Fatalf("expected signup to succeed, got %d: %s", signupRecorder.Code, signupRecorder.Body.String())
	}

	var signupResponse struct {
		Tokens struct {
			RefreshToken string `json:"refreshToken"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(signupRecorder.Body.Bytes(), &signupResponse); err != nil {
		t.Fatalf("decode signup response: %v", err)
	}

	observedStore.observations = nil

	refreshRequest := httptest.NewRequest(http.MethodPost, "/auth/refresh", bytes.NewBufferString(`{"refreshToken":"`+signupResponse.Tokens.RefreshToken+`"}`))
	refreshRequest.Header.Set("Content-Type", "application/json")
	refreshRecorder := httptest.NewRecorder()
	router.ServeHTTP(refreshRecorder, refreshRequest)
	if refreshRecorder.Code != http.StatusOK {
		t.Fatalf("expected refresh to succeed, got %d: %s", refreshRecorder.Code, refreshRecorder.Body.String())
	}

	if len(observedStore.observations) != 1 {
		t.Fatalf("len(observations) = %d, want 1", len(observedStore.observations))
	}

	observation := observedStore.observations[0]
	if observation.ClientName != "unknown" || observation.ClientVersion != "unknown" || observation.Platform != "unknown" || observation.ClientInstallationID != "unknown" {
		t.Fatalf("unexpected fallback observation: %+v", observation)
	}
	if observation.LastAuthEvent != "refresh" {
		t.Fatalf("LastAuthEvent = %q, want refresh", observation.LastAuthEvent)
	}
}

func TestServerInfoEndpoint(t *testing.T) {
	gin.SetMode(gin.TestMode)
	awsRuntime := httpserver.AwsSsmRuntime{
		Enabled:                    true,
		AwsSsoBrowserFlowSupported: true,
	}
	awsSftpBridge := httpserver.NewAwsSftpBridge(awsRuntime)
	t.Cleanup(awsSftpBridge.Close)
	router := createTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
		ServerVersion:      "2026.04.07-test",
		AwsSsmRuntime:      awsRuntime,
		AwsSsoBrowserFlow:  true,
		AwsSftpBridge:      awsSftpBridge,
	})

	request := httptest.NewRequest(http.MethodGet, "/api/info", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected info endpoint to succeed, got %d: %s", recorder.Code, recorder.Body.String())
	}

	var response struct {
		ServerVersion string `json:"serverVersion"`
		Capabilities  struct {
			Sync struct {
				AWSProfiles bool `json:"awsProfiles"`
			} `json:"sync"`
			Sessions struct {
				AWSSsm            bool `json:"awsSsm"`
				AWSSftp           bool `json:"awsSftp"`
				AWSSsoBrowserFlow bool `json:"awsSsoBrowserFlow"`
			} `json:"sessions"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode info response: %v", err)
	}
	if response.ServerVersion != "2026.04.07-test" {
		t.Fatalf("expected version to round-trip, got %q", response.ServerVersion)
	}
	if !response.Capabilities.Sync.AWSProfiles {
		t.Fatalf("expected awsProfiles capability to be enabled")
	}
	if !response.Capabilities.Sessions.AWSSsm {
		t.Fatalf("expected awsSsm capability to be enabled")
	}
	if !response.Capabilities.Sessions.AWSSftp {
		t.Fatalf("expected awsSftp capability to be enabled")
	}
	if !response.Capabilities.Sessions.AWSSsoBrowserFlow {
		t.Fatalf("expected awsSsoBrowserFlow capability to be enabled")
	}
}

// The SSO browser flow runs on the AWS SDK and is always available in
// production; a router explicitly configured without a manager (tests only)
// still answers 503 with the configured reason instead of crashing.
func TestAwsSsoMobileStartReturns503WithoutManager(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
		AwsSsmRuntime: httpserver.AwsSsmRuntime{
			Enabled:                    true,
			AwsSsoBrowserFlowReason:    "browser flow disabled for this test",
			AwsSsoBrowserFlowSupported: false,
		},
	})
	accessToken := signupAccessToken(t, router, "aws-sso-disabled@example.com")

	recorder := postAwsSsoMobileStart(t, router, accessToken)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected AWS SSO start without manager to be 503, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "browser flow disabled for this test") {
		t.Fatalf("expected configured reason in response, got %s", recorder.Body.String())
	}
}

type testServerInfoResponse struct {
	ServerVersion string `json:"serverVersion"`
	Capabilities  struct {
		Sessions struct {
			AWSSsoBrowserFlow bool `json:"awsSsoBrowserFlow"`
		} `json:"sessions"`
	} `json:"capabilities"`
}

func requestServerInfo(t *testing.T, router *gin.Engine) testServerInfoResponse {
	t.Helper()

	request := httptest.NewRequest(http.MethodGet, "/api/info", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected server info to succeed, got %d: %s", recorder.Code, recorder.Body.String())
	}

	var response testServerInfoResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode server info response: %v", err)
	}
	return response
}

func signupAccessToken(t *testing.T, router *gin.Engine, email string) string {
	t.Helper()

	signupBody := bytes.NewBufferString(`{"email":"` + email + `","password":"supersecure"}`)
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
	if signupResponse.Tokens.AccessToken == "" {
		t.Fatalf("signup access token should not be empty")
	}
	return signupResponse.Tokens.AccessToken
}

func postAwsSsoMobileStart(t *testing.T, router *gin.Engine, accessToken string) *httptest.ResponseRecorder {
	t.Helper()

	body := strings.NewReader(`{
		"targetProfileName":"prod",
		"sourceProfileName":"prod",
		"sourceProfileFingerprint":"fingerprint-1",
		"ssoStartUrl":"https://example.awsapps.com/start",
		"ssoRegion":"us-east-1",
		"ssoAccountId":"123456789012",
		"ssoRoleName":"AdministratorAccess",
		"redirectUri":"http://127.0.0.1:43111/oauth/callback"
	}`)
	request := httptest.NewRequest(http.MethodPost, "/api/aws-sso/mobile/start", body)
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func TestAwsSessionWebSocketAcceptsQueryAccessToken(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
		AwsSsmRuntime: httpserver.AwsSsmRuntime{
			Enabled: true,
		},
	})

	signupBody := bytes.NewBufferString(`{"email":"ws-query@example.com","password":"supersecure"}`)
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

	server := httptest.NewServer(router)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") +
		"/api/aws-sessions/ws?access_token=" + url.QueryEscape(signupResponse.Tokens.AccessToken)
	conn, response, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		if response != nil {
			t.Fatalf("dial websocket with query access token: %v (status=%d)", err, response.StatusCode)
		}
		t.Fatalf("dial websocket with query access token: %v", err)
	}
	_ = conn.Close()
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

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected bridge page, got %d: %s", recorder.Code, recorder.Body.String())
	}

	body := recorder.Body.String()
	if !strings.Contains(body, "http://127.0.0.1:43123/auth/callback?") {
		t.Fatalf("expected loopback callback url in bridge page: %s", body)
	}
	if !strings.Contains(body, "code=") {
		t.Fatalf("expected exchange code in bridge page: %s", body)
	}
	if !strings.Contains(body, "state=state-123") {
		t.Fatalf("expected state in bridge page: %s", body)
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
	if !strings.Contains(
		recorder.Header().Get("Content-Security-Policy"),
		"form-action 'self' http://localhost:* http://127.0.0.1:* http://[::1]:*",
	) {
		t.Fatalf(
			"expected login page CSP to allow loopback form posts, got %q",
			recorder.Header().Get("Content-Security-Policy"),
		)
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

func TestMobileBrowserSignupBridgePreservesCustomSchemeCallbackURL(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	form := url.Values{
		"email":        {"mobile-bridge@example.com"},
		"password":     {"supersecure"},
		"client":       {"dolgate-mobile"},
		"redirect_uri": {"dolgate://auth/callback"},
		"state":        {"mobile-state"},
	}

	request := httptest.NewRequest(http.MethodPost, "/signup", strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected mobile bridge page, got %d: %s", recorder.Code, recorder.Body.String())
	}

	body := recorder.Body.String()
	if !strings.Contains(body, `const target = "dolgate://auth/callback?`) {
		t.Fatalf("expected custom scheme callback in bridge page script, got %s", body)
	}
	if !strings.Contains(body, `id="open-app" class="button primary" href="dolgate://auth/callback?`) {
		t.Fatalf("expected open-app href to contain custom scheme callback, got %s", body)
	}
	if strings.Contains(body, `id="open-app" class="button primary" href="#"`) {
		t.Fatalf("expected open-app href not to remain placeholder, got %s", body)
	}
	if strings.Contains(body, "#ZgotmplZ") {
		t.Fatalf("expected bridge page to preserve custom scheme callback, got %s", body)
	}
	if !strings.Contains(body, "state=mobile-state") {
		t.Fatalf("expected state parameter in bridge callback url, got %s", body)
	}
}

func TestAwsSsoCallbackBridgeRedirectsBackIntoMobileApp(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	request := httptest.NewRequest(
		http.MethodGet,
		"/auth/aws-sso/callback?code=auth-code&state=aws-state",
		nil,
	)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected aws sso bridge page, got %d: %s", recorder.Code, recorder.Body.String())
	}

	body := recorder.Body.String()
	if !strings.Contains(body, `const target = "dolgate://aws-sso/callback?code=auth-code&state=aws-state"`) {
		t.Fatalf("expected aws sso bridge target in page script, got %s", body)
	}
	if !strings.Contains(body, `href="dolgate://aws-sso/callback?code=auth-code&amp;state=aws-state"`) {
		t.Fatalf("expected aws sso bridge href in page markup, got %s", body)
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

func oidcHideOnIOSTestConfig(oidcServerURL string, hideOnIOS bool) httpserver.RouterConfig {
	return httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
		OIDC: httpserver.OIDCConfig{
			Enabled:      true,
			DisplayName:  "Google",
			IssuerURL:    oidcServerURL,
			ClientID:     "dolgate-desktop",
			ClientSecret: "secret",
			RedirectURL:  "http://127.0.0.1/callback",
			HideOnIOS:    hideOnIOS,
		},
	}
}

func requestLoginPage(t *testing.T, router http.Handler, target string) string {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, target, nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected page for %s, got %d: %s", target, recorder.Code, recorder.Body.String())
	}
	return recorder.Body.String()
}

func TestOIDCHiddenOnIOSBrowserLoginWhenFlagEnabled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oidcServer := createOIDCTestServer(t)
	defer oidcServer.Close()

	router := createTestRouterWithConfig(t, oidcHideOnIOSTestConfig(oidcServer.URL, true))

	// iOS 앱에서 연 로그인/회원가입 — OIDC 버튼 숨김, 이메일/비번 폼은 유지.
	for _, path := range []string{"/login", "/signup"} {
		body := requestLoginPage(t, router, path+"?client=dolgate-mobile&redirect_uri=dolgate://auth/callback&state=test-state&platform=ios")
		if strings.Contains(body, "/auth/oidc/start") {
			t.Fatalf("expected OIDC button hidden on iOS %s page, got %s", path, body)
		}
		if !strings.Contains(body, `name="email"`) {
			t.Fatalf("expected local auth form on iOS %s page, got %s", path, body)
		}
	}

	// 안드로이드와 데스크톱(platform 없음)은 그대로 노출.
	for _, target := range []string{
		"/login?client=dolgate-mobile&redirect_uri=dolgate://auth/callback&state=test-state&platform=android",
		"/login?client=dolgate-desktop&redirect_uri=dolgate://auth/callback&state=test-state",
	} {
		body := requestLoginPage(t, router, target)
		if !strings.Contains(body, "/auth/oidc/start") {
			t.Fatalf("expected OIDC button visible for %s, got %s", target, body)
		}
	}
}

func TestOIDCVisibleOnIOSWhenHideFlagDisabled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oidcServer := createOIDCTestServer(t)
	defer oidcServer.Close()

	router := createTestRouterWithConfig(t, oidcHideOnIOSTestConfig(oidcServer.URL, false))

	body := requestLoginPage(t, router, "/login?client=dolgate-mobile&redirect_uri=dolgate://auth/callback&state=test-state&platform=ios")
	if !strings.Contains(body, "/auth/oidc/start") {
		t.Fatalf("expected OIDC button visible when flag disabled, got %s", body)
	}
}

func TestOIDCHideOnIOSSurvivesLoginFormRerender(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oidcServer := createOIDCTestServer(t)
	defer oidcServer.Close()

	router := createTestRouterWithConfig(t, oidcHideOnIOSTestConfig(oidcServer.URL, true))

	// GET 페이지가 platform 을 hidden 필드로 실어 두는지부터 확인한다.
	getBody := requestLoginPage(t, router, "/login?client=dolgate-mobile&redirect_uri=dolgate://auth/callback&state=test-state&platform=ios")
	if !strings.Contains(getBody, `name="platform" value="ios"`) {
		t.Fatalf("expected hidden platform field on iOS login page, got %s", getBody)
	}

	// 잘못된 자격증명으로 폼 제출 → 에러 재렌더에서도 OIDC 버튼이 숨겨진 채 유지돼야 한다.
	form := url.Values{
		"email":        {"nobody@example.com"},
		"password":     {"wrong-password"},
		"client":       {"dolgate-mobile"},
		"redirect_uri": {"dolgate://auth/callback"},
		"state":        {"test-state"},
		"platform":     {"ios"},
	}
	request := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected rerendered login page, got %d: %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if strings.Contains(body, "/auth/oidc/start") {
		t.Fatalf("expected OIDC button hidden on rerendered iOS login page, got %s", body)
	}
	if !strings.Contains(body, `name="platform" value="ios"`) {
		t.Fatalf("expected hidden platform field preserved on rerender, got %s", body)
	}
}

func TestOIDCHideOnIOSIgnoredWhenLocalAuthDisabled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oidcServer := createOIDCTestServer(t)
	defer oidcServer.Close()

	config := oidcHideOnIOSTestConfig(oidcServer.URL, true)
	config.LocalAuthEnabled = false
	config.LocalSignupEnabled = false
	router := createTestRouterWithConfig(t, config)

	// 로컬 인증이 꺼진 서버에서 숨기면 iOS 의 로그인 수단이 없어지므로 플래그를 무시하고
	// 기존 OIDC 즉시 리다이렉트를 유지한다.
	request := httptest.NewRequest(http.MethodGet, "/login?client=dolgate-mobile&redirect_uri=dolgate://auth/callback&state=test-state&platform=ios", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusFound {
		t.Fatalf("expected redirect, got %d", recorder.Code)
	}
	if !strings.HasPrefix(recorder.Header().Get("Location"), "/auth/oidc/start?") {
		t.Fatalf("unexpected redirect location: %s", recorder.Header().Get("Location"))
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
	if !strings.Contains(viewerRecorder.Header().Get("Content-Security-Policy"), "style-src 'self' 'unsafe-inline'") {
		t.Fatalf("expected viewer CSP to allow inline styles for xterm rendering, got %q", viewerRecorder.Header().Get("Content-Security-Policy"))
	}
	// 이 지시어가 빠지면 inline image 애드온의 Sixel 디코더(WASM 컴파일)가 브라우저에서 막히고,
	// viewer.js 의 try/catch 가 그 실패를 흡수해 이미지만 조용히 사라진다.
	if !strings.Contains(viewerRecorder.Header().Get("Content-Security-Policy"), "script-src 'self' 'wasm-unsafe-eval'") {
		t.Fatalf("expected viewer CSP to allow wasm compilation for the inline image addon, got %q", viewerRecorder.Header().Get("Content-Security-Policy"))
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
	if !strings.Contains(viewerRecorder.Body.String(), `/share/assets/vendor/xterm-addon-image.js?v=`) {
		t.Fatalf("expected viewer page html to contain versioned image addon asset url: %s", viewerRecorder.Body.String())
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

func TestAccountDeleteRemovesAllDataAndInvalidatesTokens(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	signupBody := bytes.NewBufferString(`{"email":"delete-me@example.com","password":"supersecure"}`)
	signupRequest := httptest.NewRequest(http.MethodPost, "/auth/signup", signupBody)
	signupRequest.Header.Set("Content-Type", "application/json")
	signupRecorder := httptest.NewRecorder()
	router.ServeHTTP(signupRecorder, signupRequest)
	if signupRecorder.Code != http.StatusCreated {
		t.Fatalf("expected signup to succeed, got %d: %s", signupRecorder.Code, signupRecorder.Body.String())
	}
	var signupResponse struct {
		Tokens struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(signupRecorder.Body.Bytes(), &signupResponse); err != nil {
		t.Fatalf("decode signup response: %v", err)
	}

	payload := syncmodel.Payload{
		syncmodel.KindHosts: []syncmodel.Record{
			{ID: "host-1", EncryptedPayload: "ciphertext-host", UpdatedAt: "2026-03-21T15:00:00Z"},
		},
	}
	payloadBytes, _ := json.Marshal(payload)
	postSync := httptest.NewRequest(http.MethodPost, "/sync", bytes.NewReader(payloadBytes))
	postSync.Header.Set("Authorization", "Bearer "+signupResponse.Tokens.AccessToken)
	postSync.Header.Set("Content-Type", "application/json")
	postSyncRecorder := httptest.NewRecorder()
	router.ServeHTTP(postSyncRecorder, postSync)
	if postSyncRecorder.Code != http.StatusAccepted {
		t.Fatalf("expected sync upsert to succeed, got %d", postSyncRecorder.Code)
	}

	// 미인증 삭제는 거부된다.
	anonymousDelete := httptest.NewRequest(http.MethodDelete, "/auth/account", nil)
	anonymousDeleteRecorder := httptest.NewRecorder()
	router.ServeHTTP(anonymousDeleteRecorder, anonymousDelete)
	if anonymousDeleteRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthenticated delete to be rejected, got %d", anonymousDeleteRecorder.Code)
	}

	deleteRequest := httptest.NewRequest(http.MethodDelete, "/auth/account", nil)
	deleteRequest.Header.Set("Authorization", "Bearer "+signupResponse.Tokens.AccessToken)
	deleteRecorder := httptest.NewRecorder()
	router.ServeHTTP(deleteRecorder, deleteRequest)
	if deleteRecorder.Code != http.StatusNoContent {
		t.Fatalf("expected account delete to succeed, got %d: %s", deleteRecorder.Code, deleteRecorder.Body.String())
	}

	// refresh 토큰이 삭제됐으므로 다른 기기의 갱신은 401 → 로그아웃 흐름을 탄다.
	refreshBody := bytes.NewBufferString(`{"refreshToken":"` + signupResponse.Tokens.RefreshToken + `"}`)
	refreshRequest := httptest.NewRequest(http.MethodPost, "/auth/refresh", refreshBody)
	refreshRequest.Header.Set("Content-Type", "application/json")
	refreshRecorder := httptest.NewRecorder()
	router.ServeHTTP(refreshRecorder, refreshRequest)
	if refreshRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected refresh after delete to fail with 401, got %d", refreshRecorder.Code)
	}

	// 아직 만료 전인 access 토큰으로도 sync 는 거부돼(유저 존재 확인) 지운 데이터가 부활하지 않는다.
	resurrectSync := httptest.NewRequest(http.MethodPost, "/sync", bytes.NewReader(payloadBytes))
	resurrectSync.Header.Set("Authorization", "Bearer "+signupResponse.Tokens.AccessToken)
	resurrectSync.Header.Set("Content-Type", "application/json")
	resurrectRecorder := httptest.NewRecorder()
	router.ServeHTTP(resurrectRecorder, resurrectSync)
	if resurrectRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected sync after delete to fail with 401, got %d", resurrectRecorder.Code)
	}

	// 같은 이메일로 재가입하면 완전히 새 계정 — 이전 데이터가 없어야 한다.
	resignupBody := bytes.NewBufferString(`{"email":"delete-me@example.com","password":"supersecure"}`)
	resignupRequest := httptest.NewRequest(http.MethodPost, "/auth/signup", resignupBody)
	resignupRequest.Header.Set("Content-Type", "application/json")
	resignupRecorder := httptest.NewRecorder()
	router.ServeHTTP(resignupRecorder, resignupRequest)
	if resignupRecorder.Code != http.StatusCreated {
		t.Fatalf("expected re-signup to succeed, got %d: %s", resignupRecorder.Code, resignupRecorder.Body.String())
	}
	var resignupResponse struct {
		Tokens struct {
			AccessToken string `json:"accessToken"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(resignupRecorder.Body.Bytes(), &resignupResponse); err != nil {
		t.Fatalf("decode re-signup response: %v", err)
	}
	getSync := httptest.NewRequest(http.MethodGet, "/sync", nil)
	getSync.Header.Set("Authorization", "Bearer "+resignupResponse.Tokens.AccessToken)
	getSyncRecorder := httptest.NewRecorder()
	router.ServeHTTP(getSyncRecorder, getSync)
	if getSyncRecorder.Code != http.StatusOK {
		t.Fatalf("expected sync fetch to succeed, got %d", getSyncRecorder.Code)
	}
	var syncResponse syncmodel.Payload
	if err := json.Unmarshal(getSyncRecorder.Body.Bytes(), &syncResponse); err != nil {
		t.Fatalf("decode sync response: %v", err)
	}
	if len(syncResponse[syncmodel.KindHosts]) != 0 {
		t.Fatalf("expected no hosts after account deletion, got %#v", syncResponse[syncmodel.KindHosts])
	}
}

type vaultTestSessionResponse struct {
	Tokens struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
	} `json:"tokens"`
	VaultBootstrap struct {
		Version           int    `json:"version"`
		KeyBase64         string `json:"keyBase64"`
		WrappedDekBase64  string `json:"wrappedDekBase64"`
		Epoch             int64  `json:"epoch"`
		DekVerifierBase64 string `json:"dekVerifierBase64"`
		Kdf               *struct {
			Algorithm   string `json:"algorithm"`
			SaltBase64  string `json:"saltBase64"`
			MemoryKiB   int    `json:"memoryKib"`
			TimeCost    int    `json:"timeCost"`
			Parallelism int    `json:"parallelism"`
		} `json:"kdf"`
	} `json:"vaultBootstrap"`
}

// vaultEpochFromResponse 는 POST/PUT /auth/vault 응답 바디에서 epoch 을 뽑는다.
func vaultEpochFromResponse(t *testing.T, recorder *httptest.ResponseRecorder) int64 {
	t.Helper()
	var body struct {
		Epoch int64 `json:"epoch"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode vault mutation response: %v", err)
	}
	return body.Epoch
}

// setVaultEpochHeader 는 push 요청에 epoch fence 헤더를 싣는다.
func setVaultEpochHeader(request *http.Request, epoch int64) {
	request.Header.Set("X-Dolgate-Vault-Epoch", strconv.FormatInt(epoch, 10))
}

func vaultTestRequest(method string, path string, body string, accessToken string, clientVersion string) *http.Request {
	request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	if accessToken != "" {
		request.Header.Set("Authorization", "Bearer "+accessToken)
	}
	if clientVersion != "" {
		request.Header.Set("X-Dolgate-Client", "mobile")
		request.Header.Set("X-Dolgate-Client-Version", clientVersion)
	}
	return request
}

func vaultTestSession(t *testing.T, router *gin.Engine, method string, path string, body string, clientVersion string) (vaultTestSessionResponse, *httptest.ResponseRecorder) {
	t.Helper()
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, vaultTestRequest(method, path, body, "", clientVersion))
	var session vaultTestSessionResponse
	if recorder.Code == http.StatusOK || recorder.Code == http.StatusCreated {
		if err := json.Unmarshal(recorder.Body.Bytes(), &session); err != nil {
			t.Fatalf("decode session response: %v", err)
		}
	}
	return session, recorder
}

// testVaultVerifier 는 테스트용 결정적 verifier(32바이트) — 실제 클라이언트는 HMAC(DEK)
// 를 보내지만 서버는 형식만 검증하고 저장·배포하므로 값 자체는 불투명하다.
func testVaultVerifier(wrappedDek []byte) []byte {
	seed := byte(0x5A)
	if len(wrappedDek) > 0 {
		seed ^= wrappedDek[0]
	}
	return bytes.Repeat([]byte{seed}, 32)
}

func legacyVaultVerifierForTest(t *testing.T, keyBase64 string) []byte {
	t.Helper()
	key, err := base64.StdEncoding.DecodeString(keyBase64)
	if err != nil {
		t.Fatalf("decode legacy vault key: %v", err)
	}
	verifier := hmac.New(sha256.New, key)
	_, _ = verifier.Write([]byte("dolgate-dek-verifier-v1"))
	return verifier.Sum(nil)
}

func buildVaultSetupBody(wrappedDek []byte, salt []byte) string {
	return buildVaultMutationBody(wrappedDek, salt, 0, testVaultVerifier(wrappedDek), nil)
}

func buildVaultMutationBody(
	wrappedDek []byte,
	salt []byte,
	expectedEpoch int64,
	dekVerifier []byte,
	expectedDekVerifier *string,
) string {
	payload := map[string]any{
		"wrappedDekBase64":  base64.StdEncoding.EncodeToString(wrappedDek),
		"dekVerifierBase64": base64.StdEncoding.EncodeToString(dekVerifier),
		"expectedEpoch":     expectedEpoch,
		"kdf": map[string]any{
			"algorithm":   "argon2id",
			"saltBase64":  base64.StdEncoding.EncodeToString(salt),
			"memoryKib":   64 * 1024,
			"timeCost":    3,
			"parallelism": 1,
		},
	}
	if expectedDekVerifier != nil {
		payload["expectedDekVerifierBase64"] = *expectedDekVerifier
		payload["expectedWrapRevision"] = 1
	}
	encoded, _ := json.Marshal(payload)
	return string(encoded)
}

const vaultE2EECapableVersion = "1.8.0"
const vaultLegacyClientVersion = "1.7.10"

func TestSyncRevisionETag(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	signup, signupRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/signup",
		`{"email":"revision@example.com","password":"supersecure"}`, vaultE2EECapableVersion)
	if signupRecorder.Code != http.StatusCreated {
		t.Fatalf("signup failed: %d %s", signupRecorder.Code, signupRecorder.Body.String())
	}
	token := signup.Tokens.AccessToken
	// push 는 볼트가 있어야 하므로 먼저 v2 볼트를 설정한다.
	setupRecorder := httptest.NewRecorder()
	router.ServeHTTP(setupRecorder, vaultTestRequest(http.MethodPost, "/auth/vault",
		buildVaultSetupBody(bytes.Repeat([]byte{0xA1}, 60), bytes.Repeat([]byte{0xB2}, 16)), token, vaultE2EECapableVersion))
	if setupRecorder.Code != http.StatusOK {
		t.Fatalf("vault setup failed: %d %s", setupRecorder.Code, setupRecorder.Body.String())
	}
	epoch := vaultEpochFromResponse(t, setupRecorder)
	pushSequence := int64(0)
	pushRevision := func() int64 {
		t.Helper()
		// 매 push 마다 다른 timestamp/내용 — 동일 재-push 는 no-op 으로 스킵되므로
		// revision 단조 증가를 검증하려면 실제 변경이어야 한다.
		pushSequence++
		payload := fmt.Sprintf(`{"hosts":[{"id":"host-1","encrypted_payload":"c%d","updated_at":"2026-07-11T00:00:%02dZ"}]}`, pushSequence, pushSequence)
		recorder := httptest.NewRecorder()
		req := vaultTestRequest(http.MethodPost, "/sync", payload, token, vaultE2EECapableVersion)
		setVaultEpochHeader(req, epoch)
		router.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusAccepted {
			t.Fatalf("push failed: %d %s", recorder.Code, recorder.Body.String())
		}
		var body struct {
			Revision int64 `json:"revision"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode push revision: %v", err)
		}
		return body.Revision
	}

	rev1 := pushRevision()
	if rev1 == 0 {
		t.Fatalf("expected non-zero revision after push")
	}

	// GET 은 현재 리비전을 ETag 로 준다.
	getRecorder := httptest.NewRecorder()
	router.ServeHTTP(getRecorder, vaultTestRequest(http.MethodGet, "/sync", "", token, vaultE2EECapableVersion))
	if getRecorder.Code != http.StatusOK {
		t.Fatalf("get failed: %d", getRecorder.Code)
	}
	etag := getRecorder.Header().Get("ETag")
	if etag != fmt.Sprintf("\"%d\"", rev1) {
		t.Fatalf("expected ETag for revision %d, got %q", rev1, etag)
	}

	// 같은 ETag 로 조건부 GET → 변경 없음 → 304, 본문 없음.
	notModified := httptest.NewRecorder()
	req := vaultTestRequest(http.MethodGet, "/sync", "", token, vaultE2EECapableVersion)
	req.Header.Set("If-None-Match", etag)
	router.ServeHTTP(notModified, req)
	if notModified.Code != http.StatusNotModified {
		t.Fatalf("expected 304 for unchanged If-None-Match, got %d", notModified.Code)
	}
	if notModified.Body.Len() != 0 {
		t.Fatalf("expected empty body on 304, got %q", notModified.Body.String())
	}

	// 다시 push → 리비전 단조 증가.
	rev2 := pushRevision()
	if rev2 <= rev1 {
		t.Fatalf("expected revision to increase, %d -> %d", rev1, rev2)
	}

	// 옛 ETag 로 조건부 GET → 변경됨 → 200 + 새 ETag.
	changed := httptest.NewRecorder()
	changedReq := vaultTestRequest(http.MethodGet, "/sync", "", token, vaultE2EECapableVersion)
	changedReq.Header.Set("If-None-Match", fmt.Sprintf("\"%d\"", rev1))
	router.ServeHTTP(changed, changedReq)
	if changed.Code != http.StatusOK {
		t.Fatalf("expected 200 for stale If-None-Match, got %d", changed.Code)
	}
	if changed.Header().Get("ETag") != fmt.Sprintf("\"%d\"", rev2) {
		t.Fatalf("expected new ETag %d, got %q", rev2, changed.Header().Get("ETag"))
	}
}

func TestVaultV2EndToEndFlow(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	// 신규 유저 + E2EE 지원 클라이언트: 볼트를 만들지 않고 version 0 을 내려 설정을 유도한다.
	signup, signupRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/signup",
		`{"email":"e2ee@example.com","password":"supersecure"}`, vaultE2EECapableVersion)
	if signupRecorder.Code != http.StatusCreated {
		t.Fatalf("signup failed: %d %s", signupRecorder.Code, signupRecorder.Body.String())
	}
	if signup.VaultBootstrap.Version != 0 || signup.VaultBootstrap.KeyBase64 != "" {
		t.Fatalf("expected version 0 vault for new e2ee user, got %#v", signup.VaultBootstrap)
	}

	wrappedDek := bytes.Repeat([]byte{0xA1}, 60)
	salt := bytes.Repeat([]byte{0xB2}, 16)

	setupRecorder := httptest.NewRecorder()
	router.ServeHTTP(setupRecorder, vaultTestRequest(http.MethodPost, "/auth/vault",
		buildVaultSetupBody(wrappedDek, salt), signup.Tokens.AccessToken, vaultE2EECapableVersion))
	if setupRecorder.Code != http.StatusOK {
		t.Fatalf("vault setup failed: %d %s", setupRecorder.Code, setupRecorder.Body.String())
	}
	firstEpoch := vaultEpochFromResponse(t, setupRecorder)
	if firstEpoch < 1 {
		t.Fatalf("expected setup to start a positive epoch, got %d", firstEpoch)
	}

	// E2EE 클라이언트 refresh → v2 descriptor.
	refreshBody := `{"refreshToken":"` + signup.Tokens.RefreshToken + `"}`
	refreshed, refreshRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/refresh", refreshBody, vaultE2EECapableVersion)
	if refreshRecorder.Code != http.StatusOK {
		t.Fatalf("refresh failed: %d %s", refreshRecorder.Code, refreshRecorder.Body.String())
	}
	if refreshed.VaultBootstrap.Version != 2 || refreshed.VaultBootstrap.KeyBase64 != "" {
		t.Fatalf("expected v2 descriptor without raw key, got %#v", refreshed.VaultBootstrap)
	}
	if refreshed.VaultBootstrap.WrappedDekBase64 != base64.StdEncoding.EncodeToString(wrappedDek) {
		t.Fatalf("wrapped DEK mismatch: %s", refreshed.VaultBootstrap.WrappedDekBase64)
	}
	if refreshed.VaultBootstrap.Kdf == nil || refreshed.VaultBootstrap.Kdf.Algorithm != "argon2id" ||
		refreshed.VaultBootstrap.Kdf.MemoryKiB != 64*1024 || refreshed.VaultBootstrap.Kdf.TimeCost != 3 ||
		refreshed.VaultBootstrap.Kdf.Parallelism != 1 ||
		refreshed.VaultBootstrap.Kdf.SaltBase64 != base64.StdEncoding.EncodeToString(salt) {
		t.Fatalf("kdf params mismatch: %#v", refreshed.VaultBootstrap.Kdf)
	}
	if refreshed.VaultBootstrap.Epoch != firstEpoch {
		t.Fatalf("expected descriptor epoch %d to match setup, got %d", firstEpoch, refreshed.VaultBootstrap.Epoch)
	}
	// 클라이언트가 제출한 verifier 가 descriptor 로 그대로 배포된다 — 다른 기기가 캐시 DEK
	// 를 로컬에서 검증하는 근거.
	if refreshed.VaultBootstrap.DekVerifierBase64 != base64.StdEncoding.EncodeToString(testVaultVerifier(wrappedDek)) {
		t.Fatalf("expected descriptor verifier to match setup, got %q", refreshed.VaultBootstrap.DekVerifierBase64)
	}

	// 구버전 클라이언트(헤더 미달 또는 없음)는 426 + 안내 문구.
	for _, clientVersion := range []string{vaultLegacyClientVersion, ""} {
		_, gateRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/refresh", refreshBody, clientVersion)
		if gateRecorder.Code != http.StatusUpgradeRequired {
			t.Fatalf("expected 426 for legacy client %q, got %d: %s", clientVersion, gateRecorder.Code, gateRecorder.Body.String())
		}
		var gateBody struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(gateRecorder.Body.Bytes(), &gateBody); err != nil {
			t.Fatalf("decode 426 body: %v", err)
		}
		if !strings.Contains(gateBody.Error, "업데이트") || strings.Contains(gateBody.Error, "로그인이 필요") {
			t.Fatalf("unexpected 426 message (데스크톱 치환 패턴 회피 필요): %q", gateBody.Error)
		}
	}

	// 두 번째 설정 시도(다른 기기 레이스)는 409.
	conflictRecorder := httptest.NewRecorder()
	router.ServeHTTP(conflictRecorder, vaultTestRequest(http.MethodPost, "/auth/vault",
		buildVaultSetupBody(wrappedDek, salt), signup.Tokens.AccessToken, vaultE2EECapableVersion))
	if conflictRecorder.Code != http.StatusConflict {
		t.Fatalf("expected 409 on duplicate vault setup, got %d: %s", conflictRecorder.Code, conflictRecorder.Body.String())
	}

	// 암호 변경(rewrap) 후 새 wrapped DEK 가 내려온다.
	newWrappedDek := bytes.Repeat([]byte{0xC3}, 60)
	newSalt := bytes.Repeat([]byte{0xD4}, 16)
	currentVerifier := base64.StdEncoding.EncodeToString(testVaultVerifier(wrappedDek))
	for _, stale := range []struct {
		name             string
		expectedEpoch    int64
		expectedVerifier string
	}{
		{name: "epoch", expectedEpoch: firstEpoch - 1, expectedVerifier: currentVerifier},
		{name: "verifier", expectedEpoch: firstEpoch, expectedVerifier: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xee}, 32))},
	} {
		staleRecorder := httptest.NewRecorder()
		router.ServeHTTP(staleRecorder, vaultTestRequest(http.MethodPut, "/auth/vault",
			buildVaultMutationBody(
				newWrappedDek,
				newSalt,
				stale.expectedEpoch,
				testVaultVerifier(wrappedDek),
				&stale.expectedVerifier,
			), signup.Tokens.AccessToken, vaultE2EECapableVersion))
		if staleRecorder.Code != http.StatusConflict {
			t.Fatalf("expected stale %s rewrap to get 409, got %d: %s", stale.name, staleRecorder.Code, staleRecorder.Body.String())
		}
	}
	unchanged, unchangedRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/refresh", refreshBody, vaultE2EECapableVersion)
	if unchangedRecorder.Code != http.StatusOK || unchanged.VaultBootstrap.WrappedDekBase64 != base64.StdEncoding.EncodeToString(wrappedDek) {
		t.Fatalf("stale rewrap changed the current vault: %d %#v", unchangedRecorder.Code, unchanged.VaultBootstrap)
	}
	rewrapRecorder := httptest.NewRecorder()
	router.ServeHTTP(rewrapRecorder, vaultTestRequest(http.MethodPut, "/auth/vault",
		buildVaultMutationBody(
			newWrappedDek,
			newSalt,
			firstEpoch,
			testVaultVerifier(wrappedDek),
			&currentVerifier,
		), signup.Tokens.AccessToken, vaultE2EECapableVersion))
	if rewrapRecorder.Code != http.StatusOK {
		t.Fatalf("vault rewrap failed: %d %s", rewrapRecorder.Code, rewrapRecorder.Body.String())
	}
	// 암호 변경은 DEK 를 안 바꾸므로 epoch 은 그대로여야 한다(다른 기기 재입력 방지).
	if got := vaultEpochFromResponse(t, rewrapRecorder); got != firstEpoch {
		t.Fatalf("expected rewrap to preserve epoch %d, got %d", firstEpoch, got)
	}
	rewrapped, _ := vaultTestSession(t, router, http.MethodPost, "/auth/refresh", refreshBody, vaultE2EECapableVersion)
	if rewrapped.VaultBootstrap.WrappedDekBase64 != base64.StdEncoding.EncodeToString(newWrappedDek) {
		t.Fatalf("expected rewrapped DEK in descriptor, got %s", rewrapped.VaultBootstrap.WrappedDekBase64)
	}
	if rewrapped.VaultBootstrap.Epoch != firstEpoch {
		t.Fatalf("expected epoch unchanged after rewrap, got %d", rewrapped.VaultBootstrap.Epoch)
	}
	// rewrap 은 기존 verifier 를 보존한다(DEK 불변 — 다른 값 제출은 무시).
	if rewrapped.VaultBootstrap.DekVerifierBase64 != base64.StdEncoding.EncodeToString(testVaultVerifier(wrappedDek)) {
		t.Fatalf("expected verifier unchanged after rewrap, got %q", rewrapped.VaultBootstrap.DekVerifierBase64)
	}

	// 볼트 초기화: sync 데이터가 지워지고 version 0 으로 되돌아가 재설정이 가능하다.
	syncPayload := `{"hosts":[{"id":"host-1","encrypted_payload":"ciphertext","updated_at":"2026-07-11T00:00:00Z"}]}`
	pushRecorder := httptest.NewRecorder()
	// v2 push 는 epoch 헤더 필수 — 현재 볼트의 epoch 을 실어 보낸다.
	pushReq := vaultTestRequest(http.MethodPost, "/sync", syncPayload, signup.Tokens.AccessToken, vaultE2EECapableVersion)
	setVaultEpochHeader(pushReq, firstEpoch)
	router.ServeHTTP(pushRecorder, pushReq)
	if pushRecorder.Code != http.StatusAccepted {
		t.Fatalf("sync push failed: %d %s", pushRecorder.Code, pushRecorder.Body.String())
	}

	// epoch 헤더가 없는 v2 push 는 (E2EE 클라라도) 거부된다 — 헤더는 필수다.
	noHeaderPush := httptest.NewRecorder()
	router.ServeHTTP(noHeaderPush, vaultTestRequest(http.MethodPost, "/sync", syncPayload, signup.Tokens.AccessToken, vaultE2EECapableVersion))
	if noHeaderPush.Code != http.StatusConflict {
		t.Fatalf("expected header-less v2 push to be rejected with 409, got %d %s", noHeaderPush.Code, noHeaderPush.Body.String())
	}

	// 실제 클라이언트 프로파일: /sync 에 클라 식별 헤더가 없어도 epoch 헤더 존재 자체가
	// E2EE 능력의 증거이므로 426 게이트를 통과해야 한다(구버전은 이 헤더를 모른다).
	realClientPush := httptest.NewRecorder()
	realClientReq := vaultTestRequest(http.MethodPost, "/sync", syncPayload, signup.Tokens.AccessToken, "")
	setVaultEpochHeader(realClientReq, firstEpoch)
	router.ServeHTTP(realClientPush, realClientReq)
	if realClientPush.Code != http.StatusAccepted {
		t.Fatalf("expected epoch-only push (no client headers) to be accepted, got %d %s", realClientPush.Code, realClientPush.Body.String())
	}

	// 무변경 push 는 revision 을 올리지 않는다 — 재-push 루프가 전 기기의 304 최적화를
	// 무력화하지 않게. (1) LWW 로 스킵되는 낡은 timestamp, (2) 동일 timestamp + 동일 내용의
	// 재-push(실클라이언트의 전체 스냅샷 재전송 모양) 둘 다.
	beforeNoop := httptest.NewRecorder()
	beforeNoopReq := vaultTestRequest(http.MethodGet, "/sync", "", signup.Tokens.AccessToken, vaultE2EECapableVersion)
	router.ServeHTTP(beforeNoop, beforeNoopReq)
	etagBeforeNoop := beforeNoop.Header().Get("ETag")
	for _, noopPayload := range []string{
		`{"hosts":[{"id":"host-1","encrypted_payload":"old","updated_at":"2020-01-01T00:00:00Z"}]}`,
		syncPayload,
	} {
		noopPush := httptest.NewRecorder()
		noopReq := vaultTestRequest(http.MethodPost, "/sync", noopPayload, signup.Tokens.AccessToken, vaultE2EECapableVersion)
		setVaultEpochHeader(noopReq, firstEpoch)
		router.ServeHTTP(noopPush, noopReq)
		if noopPush.Code != http.StatusAccepted {
			t.Fatalf("no-op push should still be accepted, got %d %s", noopPush.Code, noopPush.Body.String())
		}
	}
	afterNoop := httptest.NewRecorder()
	router.ServeHTTP(afterNoop, vaultTestRequest(http.MethodGet, "/sync", "", signup.Tokens.AccessToken, vaultE2EECapableVersion))
	if afterNoop.Header().Get("ETag") != etagBeforeNoop {
		t.Fatalf("expected no-op push to keep revision %s, got %s", etagBeforeNoop, afterNoop.Header().Get("ETag"))
	}

	// 레코드 자체가 잘못된 push(파싱 불가 타임스탬프)는 400 — 5xx 재시도 루프를 만들지 않는다.
	badRecordPush := httptest.NewRecorder()
	badRecordReq := vaultTestRequest(http.MethodPost, "/sync",
		`{"hosts":[{"id":"host-bad","encrypted_payload":"x","updated_at":"not-a-time"}]}`,
		signup.Tokens.AccessToken, vaultE2EECapableVersion)
	setVaultEpochHeader(badRecordReq, firstEpoch)
	router.ServeHTTP(badRecordPush, badRecordReq)
	if badRecordPush.Code != http.StatusBadRequest {
		t.Fatalf("expected malformed record push to get 400, got %d %s", badRecordPush.Code, badRecordPush.Body.String())
	}

	// 구버전 클라(E2EE descriptor 미이해, epoch 헤더도 없음)는 v2 볼트에 push 할 수 없다 —
	// v1 시절 access 토큰으로 세션 게이트를 우회해도 여기서 426 으로 막고 업데이트를 안내한다.
	for _, legacyVersion := range []string{vaultLegacyClientVersion, ""} {
		legacyPush := httptest.NewRecorder()
		router.ServeHTTP(legacyPush, vaultTestRequest(http.MethodPost, "/sync", syncPayload, signup.Tokens.AccessToken, legacyVersion))
		if legacyPush.Code != http.StatusUpgradeRequired {
			t.Fatalf("expected legacy client (%q) push to v2 vault to get 426, got %d %s", legacyVersion, legacyPush.Code, legacyPush.Body.String())
		}
	}
	resetRecorder := httptest.NewRecorder()
	router.ServeHTTP(resetRecorder, vaultTestRequest(http.MethodPost, "/auth/vault/reset", fmt.Sprintf(`{"expectedEpoch":%d}`, firstEpoch), signup.Tokens.AccessToken, vaultE2EECapableVersion))
	if resetRecorder.Code != http.StatusOK {
		t.Fatalf("vault reset failed: %d %s", resetRecorder.Code, resetRecorder.Body.String())
	}
	if resetEpoch := vaultEpochFromResponse(t, resetRecorder); resetEpoch != firstEpoch+1 {
		t.Fatalf("expected reset response epoch %d, got %d", firstEpoch+1, resetEpoch)
	}

	// reset 은 refresh 토큰을 지우지 않지만, v2 이력이 있는 계정의 구클라는 426으로
	// 차단한다. 신클라는 같은 토큰으로 version 0 descriptor를 받아 재설정한다.
	legacyRefresh := httptest.NewRecorder()
	router.ServeHTTP(legacyRefresh, vaultTestRequest(http.MethodPost, "/auth/refresh", refreshBody, "", vaultLegacyClientVersion))
	if legacyRefresh.Code != http.StatusUpgradeRequired {
		t.Fatalf("expected legacy refresh after reset to get 426, got %d %s", legacyRefresh.Code, legacyRefresh.Body.String())
	}
	survivingRefresh := httptest.NewRecorder()
	router.ServeHTTP(survivingRefresh, vaultTestRequest(http.MethodPost, "/auth/refresh", refreshBody, "", vaultE2EECapableVersion))
	if survivingRefresh.Code != http.StatusOK {
		t.Fatalf("expected refresh token to survive reset, got %d %s", survivingRefresh.Code, survivingRefresh.Body.String())
	}
	var resetDescriptor auth.SessionBootstrap
	if err := json.Unmarshal(survivingRefresh.Body.Bytes(), &resetDescriptor); err != nil {
		t.Fatalf("decode reset descriptor: %v", err)
	}
	if resetDescriptor.VaultBootstrap.Version != 0 || resetDescriptor.VaultBootstrap.Epoch != firstEpoch+1 {
		t.Fatalf("expected version 0 to carry reset epoch %d, got %#v", firstEpoch+1, resetDescriptor.VaultBootstrap)
	}

	// 볼트 부재 가드: 볼트가 없으면(초기화 직후 재설정 전) push 는 409 로 거부된다
	// (혼합 키 오염 방지). pull 은 무해하므로 계속 허용된다.
	stalePush := httptest.NewRecorder()
	router.ServeHTTP(stalePush, vaultTestRequest(http.MethodPost, "/sync", syncPayload, signup.Tokens.AccessToken, vaultE2EECapableVersion))
	if stalePush.Code != http.StatusConflict {
		t.Fatalf("expected stale push to be rejected with 409, got %d", stalePush.Code)
	}
	getSyncRecorder := httptest.NewRecorder()
	router.ServeHTTP(getSyncRecorder, vaultTestRequest(http.MethodGet, "/sync", "", signup.Tokens.AccessToken, vaultE2EECapableVersion))
	if getSyncRecorder.Code != http.StatusOK {
		t.Fatalf("sync fetch failed: %d", getSyncRecorder.Code)
	}
	var syncAfterReset syncmodel.Payload
	if err := json.Unmarshal(getSyncRecorder.Body.Bytes(), &syncAfterReset); err != nil {
		t.Fatalf("decode sync response: %v", err)
	}
	if len(syncAfterReset[syncmodel.KindHosts]) != 0 {
		t.Fatalf("expected sync records wiped after vault reset, got %d hosts", len(syncAfterReset[syncmodel.KindHosts]))
	}

	// 재로그인 후 version 0 을 받고, 새 볼트를 다시 설정할 수 있다.
	login, loginRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/login",
		`{"email":"e2ee@example.com","password":"supersecure"}`, vaultE2EECapableVersion)
	if loginRecorder.Code != http.StatusOK {
		t.Fatalf("re-login after reset failed: %d %s", loginRecorder.Code, loginRecorder.Body.String())
	}
	if login.VaultBootstrap.Version != 0 || login.VaultBootstrap.Epoch != firstEpoch+1 {
		t.Fatalf("expected version 0 with reset epoch %d, got %#v", firstEpoch+1, login.VaultBootstrap)
	}
	resetupRecorder := httptest.NewRecorder()
	router.ServeHTTP(resetupRecorder, vaultTestRequest(http.MethodPost, "/auth/vault",
		buildVaultMutationBody(
			wrappedDek,
			salt,
			firstEpoch+1,
			testVaultVerifier(wrappedDek),
			nil,
		), login.Tokens.AccessToken, vaultE2EECapableVersion))
	if resetupRecorder.Code != http.StatusOK {
		t.Fatalf("vault re-setup after reset failed: %d %s", resetupRecorder.Code, resetupRecorder.Body.String())
	}
	// 방어③: 재설정된 볼트는 새 DEK 세대를 시작해야 한다 — reset(+1)+재설정(+1)이므로
	// 옛 epoch 과 확실히 구분된다.
	secondEpoch := vaultEpochFromResponse(t, resetupRecorder)
	if secondEpoch != firstEpoch+2 {
		t.Fatalf("expected re-setup epoch %d (reset+setup), got %d", firstEpoch+2, secondEpoch)
	}
	// reset 전에 보낸 요청이 재설정 뒤 늦게 도착해도 새 볼트를 지우면 안 된다.
	delayedReset := httptest.NewRecorder()
	router.ServeHTTP(delayedReset, vaultTestRequest(
		http.MethodPost,
		"/auth/vault/reset",
		fmt.Sprintf(`{"expectedEpoch":%d}`, firstEpoch+1),
		login.Tokens.AccessToken,
		vaultE2EECapableVersion,
	))
	if delayedReset.Code != http.StatusConflict {
		t.Fatalf("expected delayed reset to get 409, got %d %s", delayedReset.Code, delayedReset.Body.String())
	}
	afterDelayedReset, afterDelayedResetRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/refresh", `{"refreshToken":"`+login.Tokens.RefreshToken+`"}`, vaultE2EECapableVersion)
	if afterDelayedResetRecorder.Code != http.StatusOK || afterDelayedReset.VaultBootstrap.Version != 2 || afterDelayedReset.VaultBootstrap.Epoch != secondEpoch {
		t.Fatalf("delayed reset changed the recreated vault: %d %#v", afterDelayedResetRecorder.Code, afterDelayedReset.VaultBootstrap)
	}

	// 방어③: 옛 epoch 을 실은 push 는 볼트 행이 존재해도(위 부재 검사 통과) 거부된다.
	staleEpochPush := httptest.NewRecorder()
	staleEpochRequest := vaultTestRequest(http.MethodPost, "/sync", syncPayload, login.Tokens.AccessToken, vaultE2EECapableVersion)
	setVaultEpochHeader(staleEpochRequest, firstEpoch)
	router.ServeHTTP(staleEpochPush, staleEpochRequest)
	if staleEpochPush.Code != http.StatusConflict {
		t.Fatalf("expected stale epoch push to be rejected with 409, got %d %s", staleEpochPush.Code, staleEpochPush.Body.String())
	}
	var staleEpochBody struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(staleEpochPush.Body.Bytes(), &staleEpochBody); err != nil {
		t.Fatalf("decode stale epoch push body: %v", err)
	}
	if staleEpochBody.Code != "vault_dek_mismatch" {
		t.Fatalf("expected vault_dek_mismatch code, got %q", staleEpochBody.Code)
	}

	// 방어③(no-op 형태): 쓸 것이 없는 무변경 push 라도 옛 epoch 이면 같은 409 신호를 받아야
	// 한다 — 옛 세대 기기가 fence(쓰기 경로)에 닿지 않고도 재판정 플로우로 전환된다.
	staleNoopPush := httptest.NewRecorder()
	staleNoopRequest := vaultTestRequest(http.MethodPost, "/sync", `{}`, login.Tokens.AccessToken, vaultE2EECapableVersion)
	setVaultEpochHeader(staleNoopRequest, firstEpoch)
	router.ServeHTTP(staleNoopPush, staleNoopRequest)
	if staleNoopPush.Code != http.StatusConflict {
		t.Fatalf("expected stale-epoch no-op push to be rejected with 409, got %d %s", staleNoopPush.Code, staleNoopPush.Body.String())
	}

	// 현재 epoch 을 실은 push 는 정상 수락된다.
	freshEpochPush := httptest.NewRecorder()
	freshEpochRequest := vaultTestRequest(http.MethodPost, "/sync", syncPayload, login.Tokens.AccessToken, vaultE2EECapableVersion)
	setVaultEpochHeader(freshEpochRequest, secondEpoch)
	router.ServeHTTP(freshEpochPush, freshEpochRequest)
	if freshEpochPush.Code != http.StatusAccepted {
		t.Fatalf("expected current epoch push to be accepted, got %d %s", freshEpochPush.Code, freshEpochPush.Body.String())
	}
}

// 초기화 후 구버전 클라 로그인이 v1 볼트를 lazy 재생성한 경우: E2EE 기기(epoch 헤더)가
// 그 v1 볼트에 push 하면 409 로 거부된다 — v1 볼트에 v2 암호문이 섞여 구버전 기기가
// 복호화하지 못하는 오염을 막는다.
func TestVaultV1RejectsEpochHeaderPush(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	signup, signupRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/signup",
		`{"email":"v1-epoch-push@example.com","password":"supersecure"}`, "")
	if signupRecorder.Code != http.StatusCreated {
		t.Fatalf("legacy signup failed: %d %s", signupRecorder.Code, signupRecorder.Body.String())
	}
	if signup.VaultBootstrap.Version != 1 {
		t.Fatalf("expected lazy v1 vault, got %#v", signup.VaultBootstrap)
	}

	payload := `{"hosts":[{"id":"host-1","encrypted_payload":"v2-ciphertext","updated_at":"2026-07-11T00:00:00Z"}]}`
	rejected := httptest.NewRecorder()
	rejectedReq := vaultTestRequest(http.MethodPost, "/sync", payload, signup.Tokens.AccessToken, vaultE2EECapableVersion)
	setVaultEpochHeader(rejectedReq, 3)
	router.ServeHTTP(rejected, rejectedReq)
	if rejected.Code != http.StatusConflict {
		t.Fatalf("expected epoch-header push to v1 vault to get 409, got %d %s", rejected.Code, rejected.Body.String())
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rejected.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Code != "vault_dek_mismatch" {
		t.Fatalf("expected vault_dek_mismatch code, got %q", body.Code)
	}

	// 헤더 없는 구버전 push 는 기존대로 허용된다.
	accepted := httptest.NewRecorder()
	router.ServeHTTP(accepted, vaultTestRequest(http.MethodPost, "/sync", payload, signup.Tokens.AccessToken, ""))
	if accepted.Code != http.StatusAccepted {
		t.Fatalf("expected legacy push to v1 vault to be accepted, got %d %s", accepted.Code, accepted.Body.String())
	}
}

func TestVaultLegacyClientsKeepV1Behavior(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	// 구버전(헤더 없음) 신규 가입: 기존과 동일하게 v1 볼트가 lazy 생성된다.
	legacySignup, legacyRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/signup",
		`{"email":"legacy@example.com","password":"supersecure"}`, "")
	if legacyRecorder.Code != http.StatusCreated {
		t.Fatalf("legacy signup failed: %d %s", legacyRecorder.Code, legacyRecorder.Body.String())
	}
	if legacySignup.VaultBootstrap.Version != 1 || legacySignup.VaultBootstrap.KeyBase64 == "" {
		t.Fatalf("expected v1 vault with raw key for legacy signup, got %#v", legacySignup.VaultBootstrap)
	}

	// 같은 계정을 E2EE 지원 클라이언트로 refresh 해도 v1 그대로다(기존 유저 무변화).
	refreshBody := `{"refreshToken":"` + legacySignup.Tokens.RefreshToken + `"}`
	refreshed, refreshRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/refresh", refreshBody, vaultE2EECapableVersion)
	if refreshRecorder.Code != http.StatusOK {
		t.Fatalf("refresh failed: %d %s", refreshRecorder.Code, refreshRecorder.Body.String())
	}
	if refreshed.VaultBootstrap.Version != 1 || refreshed.VaultBootstrap.KeyBase64 != legacySignup.VaultBootstrap.KeyBase64 {
		t.Fatalf("expected unchanged v1 vault for existing user on e2ee client, got %#v", refreshed.VaultBootstrap)
	}
}

func TestVaultV1MigrationVerifiesTheServerKnownDEK(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	signup, signupRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/signup",
		`{"email":"legacy-migrate@example.com","password":"supersecure"}`, "")
	if signupRecorder.Code != http.StatusCreated || signup.VaultBootstrap.Version != 1 {
		t.Fatalf("legacy signup failed: %d %s", signupRecorder.Code, signupRecorder.Body.String())
	}
	wrapper := bytes.Repeat([]byte{0xa7}, 60)
	salt := bytes.Repeat([]byte{0xb8}, 16)
	wrongVerifier := bytes.Repeat([]byte{0xff}, 32)
	wrong := httptest.NewRecorder()
	router.ServeHTTP(wrong, vaultTestRequest(http.MethodPost, "/auth/vault",
		buildVaultMutationBody(wrapper, salt, 0, wrongVerifier, nil), signup.Tokens.AccessToken, vaultE2EECapableVersion))
	if wrong.Code != http.StatusConflict {
		t.Fatalf("migration with wrong verifier = %d %s, want 409", wrong.Code, wrong.Body.String())
	}

	refreshBody := `{"refreshToken":"` + signup.Tokens.RefreshToken + `"}`
	stillLegacy, refreshRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/refresh", refreshBody, vaultE2EECapableVersion)
	if refreshRecorder.Code != http.StatusOK || stillLegacy.VaultBootstrap.Version != 1 {
		t.Fatalf("failed migration changed the vault: %d %#v", refreshRecorder.Code, stillLegacy.VaultBootstrap)
	}

	correct := httptest.NewRecorder()
	router.ServeHTTP(correct, vaultTestRequest(http.MethodPost, "/auth/vault",
		buildVaultMutationBody(
			wrapper,
			salt,
			0,
			legacyVaultVerifierForTest(t, signup.VaultBootstrap.KeyBase64),
			nil,
		), signup.Tokens.AccessToken, vaultE2EECapableVersion))
	if correct.Code != http.StatusOK {
		t.Fatalf("migration with the correct verifier = %d %s, want 200", correct.Code, correct.Body.String())
	}

	migrated, migratedRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/refresh", refreshBody, vaultE2EECapableVersion)
	if migratedRecorder.Code != http.StatusOK || migrated.VaultBootstrap.Version != 2 || migrated.VaultBootstrap.KeyBase64 != "" {
		t.Fatalf("expected v2 descriptor after migration: %d %#v", migratedRecorder.Code, migrated.VaultBootstrap)
	}
}

func TestLegacyPushIsRejectedWhenResetCommitsAfterRouterPrecheck(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router, observedStore, _ := createObservedTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
	})

	signup, signupRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/signup",
		`{"email":"legacy-reset-race@example.com","password":"supersecure"}`, "")
	if signupRecorder.Code != http.StatusCreated || signup.VaultBootstrap.Version != 1 {
		t.Fatalf("legacy signup failed: %d %s", signupRecorder.Code, signupRecorder.Body.String())
	}

	observed, release := observedStore.blockNextVaultStateRead()
	payload := `{"hosts":[{"id":"stale-host","encrypted_payload":"old-v1-ciphertext","updated_at":"2026-07-15T00:00:00Z"}]}`
	response := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, vaultTestRequest(http.MethodPost, "/sync", payload, signup.Tokens.AccessToken, ""))
		response <- recorder
	}()

	select {
	case <-observed:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for push vault precheck")
	}

	user, err := observedStore.GetUserByEmail(context.Background(), "legacy-reset-race@example.com")
	if err != nil {
		t.Fatalf("GetUserByEmail() error = %v", err)
	}
	if _, err := observedStore.ResetUserVault(context.Background(), user.ID, 0); err != nil {
		t.Fatalf("ResetUserVault() error = %v", err)
	}
	if _, err := observedStore.GetOrCreateUserVaultKey(context.Background(), user.ID); !errors.Is(err, store.ErrVaultE2EERequired) {
		t.Fatalf("GetOrCreateUserVaultKey() after reset error = %v, want ErrVaultE2EERequired", err)
	}
	close(release)

	var recorder *httptest.ResponseRecorder
	select {
	case recorder = <-response:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for stale push response")
	}
	if recorder.Code != http.StatusConflict {
		t.Fatalf("stale legacy push after reset = %d %s, want 409", recorder.Code, recorder.Body.String())
	}
	records, err := observedStore.ListSyncRecords(context.Background(), user.ID, syncmodel.KindHosts)
	if err != nil {
		t.Fatalf("ListSyncRecords() error = %v", err)
	}
	if len(records) != 0 {
		t.Fatalf("stale legacy push persisted records: %#v", records)
	}
}

func TestBrowserFormSignupDoesNotPrecreateVault(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router, observedStore, _ := createObservedTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
	})

	form := url.Values{
		"email":        {"web-first@example.com"},
		"password":     {"supersecure"},
		"client":       {"dolgate-desktop"},
		"redirect_uri": {"http://127.0.0.1:43123/auth/callback"},
		"state":        {"state-vault"},
	}
	request := httptest.NewRequest(http.MethodPost, "/signup", strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("browser signup failed: %d %s", recorder.Code, recorder.Body.String())
	}

	// 웹 폼 세션은 앱으로 가지 않으므로 볼트가 생성되면 안 된다 — 신규 유저가 어느
	// 클라이언트로 exchange 하느냐가 볼트 버전을 결정해야 한다.
	user, err := observedStore.GetUserByEmail(context.Background(), "web-first@example.com")
	if err != nil {
		t.Fatalf("GetUserByEmail() error = %v", err)
	}
	if _, err := observedStore.GetUserVaultKey(context.Background(), user.ID); !errors.Is(err, store.ErrVaultNotFound) {
		t.Fatalf("expected no vault after browser form signup, got err=%v", err)
	}

	// bridge 페이지에서 exchange code 를 뽑아 E2EE 클라이언트로 교환하면 version 0.
	body := recorder.Body.String()
	codeIndex := strings.Index(body, "code=")
	if codeIndex < 0 {
		t.Fatalf("expected exchange code in bridge page: %s", body)
	}
	rest := body[codeIndex+len("code="):]
	end := strings.IndexAny(rest, "&\"' <")
	if end < 0 {
		t.Fatalf("could not delimit exchange code: %s", rest)
	}
	code := rest[:end]

	exchanged, exchangeRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/exchange",
		`{"code":"`+code+`"}`, vaultE2EECapableVersion)
	if exchangeRecorder.Code != http.StatusOK {
		t.Fatalf("exchange failed: %d %s", exchangeRecorder.Code, exchangeRecorder.Body.String())
	}
	if exchanged.VaultBootstrap.Version != 0 || exchanged.VaultBootstrap.KeyBase64 != "" {
		t.Fatalf("expected version 0 vault for web-first new user on e2ee client, got %#v", exchanged.VaultBootstrap)
	}
}

func TestVaultSetupValidationRejectsBadRequests(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouter(t)

	signup, signupRecorder := vaultTestSession(t, router, http.MethodPost, "/auth/signup",
		`{"email":"vault-validate@example.com","password":"supersecure"}`, vaultE2EECapableVersion)
	if signupRecorder.Code != http.StatusCreated {
		t.Fatalf("signup failed: %d", signupRecorder.Code)
	}

	salt := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x01}, 16))
	wrapped := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x02}, 60))
	verifier := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x03}, 32))
	badBodies := []string{
		// wrapped DEK 가 base64 가 아님
		`{"wrappedDekBase64":"?!","dekVerifierBase64":"` + verifier + `","kdf":{"algorithm":"argon2id","saltBase64":"` + salt + `","memoryKib":65536,"timeCost":3,"parallelism":1}}`,
		// 지원하지 않는 KDF
		`{"wrappedDekBase64":"` + wrapped + `","dekVerifierBase64":"` + verifier + `","kdf":{"algorithm":"pbkdf2","saltBase64":"` + salt + `","memoryKib":65536,"timeCost":3,"parallelism":1}}`,
		// salt 가 너무 짧음
		`{"wrappedDekBase64":"` + wrapped + `","dekVerifierBase64":"` + verifier + `","kdf":{"algorithm":"argon2id","saltBase64":"c2hvcnQ=","memoryKib":65536,"timeCost":3,"parallelism":1}}`,
		// 메모리 파라미터가 허용 범위 밖(하한 미달)
		`{"wrappedDekBase64":"` + wrapped + `","dekVerifierBase64":"` + verifier + `","kdf":{"algorithm":"argon2id","saltBase64":"` + salt + `","memoryKib":1024,"timeCost":3,"parallelism":1}}`,
		// 메모리 파라미터가 허용 범위 밖(상한 초과 — 클라이언트 실행 검증과 동일 상한)
		`{"wrappedDekBase64":"` + wrapped + `","dekVerifierBase64":"` + verifier + `","kdf":{"algorithm":"argon2id","saltBase64":"` + salt + `","memoryKib":1048576,"timeCost":3,"parallelism":1}}`,
		// 이전 범위 안이지만 앱이 지원하지 않는 비용 프로필
		`{"wrappedDekBase64":"` + wrapped + `","dekVerifierBase64":"` + verifier + `","kdf":{"algorithm":"argon2id","saltBase64":"` + salt + `","memoryKib":131072,"timeCost":4,"parallelism":1}}`,
		// verifier 누락(설정에는 필수 — 다른 기기의 로컬 검증 근거)
		`{"wrappedDekBase64":"` + wrapped + `","kdf":{"algorithm":"argon2id","saltBase64":"` + salt + `","memoryKib":65536,"timeCost":3,"parallelism":1}}`,
		// verifier 형식 오류(32바이트 아님)
		`{"wrappedDekBase64":"` + wrapped + `","dekVerifierBase64":"c2hvcnQ=","kdf":{"algorithm":"argon2id","saltBase64":"` + salt + `","memoryKib":65536,"timeCost":3,"parallelism":1}}`,
	}
	for _, body := range badBodies {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, vaultTestRequest(http.MethodPost, "/auth/vault", body, signup.Tokens.AccessToken, vaultE2EECapableVersion))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for body %s, got %d: %s", body, recorder.Code, recorder.Body.String())
		}
	}

	// 검증 실패가 볼트를 만들지 않았으니 정상 설정은 여전히 가능해야 한다.
	okRecorder := httptest.NewRecorder()
	router.ServeHTTP(okRecorder, vaultTestRequest(http.MethodPost, "/auth/vault",
		buildVaultSetupBody(bytes.Repeat([]byte{0x02}, 60), bytes.Repeat([]byte{0x01}, 16)), signup.Tokens.AccessToken, vaultE2EECapableVersion))
	if okRecorder.Code != http.StatusOK {
		t.Fatalf("expected vault setup to succeed after failed validations, got %d: %s", okRecorder.Code, okRecorder.Body.String())
	}
}
