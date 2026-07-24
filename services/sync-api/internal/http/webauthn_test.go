package http_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	httpserver "dolssh/services/sync-api/internal/http"
)

func enabledWebAuthnConfig() httpserver.RouterConfig {
	return httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
		PublicBaseURL:      "https://ssh.example.com",
		WebAuthn:           httpserver.WebAuthnRouterConfig{Enabled: true},
	}
}

func infoWebAuthnCapability(t *testing.T, router *gin.Engine) bool {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/info", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("/api/info status = %d", recorder.Code)
	}
	var info struct {
		Capabilities struct {
			Auth struct {
				WebAuthn bool `json:"webauthn"`
			} `json:"auth"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &info); err != nil {
		t.Fatalf("decode /api/info: %v", err)
	}
	return info.Capabilities.Auth.WebAuthn
}

func loginPageBody(t *testing.T, router *gin.Engine) string {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/login", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("/login status = %d", recorder.Code)
	}
	return recorder.Body.String()
}

func TestWebAuthnEnabledExposesCapabilityAndLogin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouterWithConfig(t, enabledWebAuthnConfig())

	if !infoWebAuthnCapability(t, router) {
		t.Fatalf("expected capabilities.auth.webauthn = true")
	}
	if body := loginPageBody(t, router); !strings.Contains(body, "패스키로 로그인") {
		t.Fatalf("login page should show the passkey button when enabled")
	}

	// discoverable 로그인 시작은 authenticator 없이도 챌린지를 발급한다.
	request := httptest.NewRequest(http.MethodPost, "/auth/webauthn/login/begin", strings.NewReader("{}"))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("login/begin status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var begin struct {
		CeremonyID string          `json:"ceremonyId"`
		PublicKey  json.RawMessage `json:"publicKey"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &begin); err != nil {
		t.Fatalf("decode begin: %v", err)
	}
	if begin.CeremonyID == "" || len(begin.PublicKey) == 0 {
		t.Fatalf("expected ceremonyId and publicKey, got %s", recorder.Body.String())
	}
}

func TestWebAuthnDisabledHidesEverything(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled:   true,
		LocalSignupEnabled: true,
		PublicBaseURL:      "https://ssh.example.com",
		WebAuthn:           httpserver.WebAuthnRouterConfig{Enabled: false},
	})

	if infoWebAuthnCapability(t, router) {
		t.Fatalf("expected capabilities.auth.webauthn = false")
	}
	if body := loginPageBody(t, router); strings.Contains(body, "패스키로 로그인") {
		t.Fatalf("login page must not show passkey button when disabled")
	}

	request := httptest.NewRequest(http.MethodPost, "/auth/webauthn/login/begin", strings.NewReader("{}"))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("disabled login/begin status = %d, want 404", recorder.Code)
	}
}

// Enabled 라도 origin 이 https 도메인이 아니면(여기선 IP) 자동 비활성돼야 한다.
func TestWebAuthnAutoOffOnInsecureOrigin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouterWithConfig(t, httpserver.RouterConfig{
		LocalAuthEnabled: true,
		PublicBaseURL:    "http://192.168.0.10:8080",
		WebAuthn:         httpserver.WebAuthnRouterConfig{Enabled: true},
	})

	if infoWebAuthnCapability(t, router) {
		t.Fatalf("webauthn must auto-disable on an IP origin")
	}
	request := httptest.NewRequest(http.MethodPost, "/auth/webauthn/login/begin", strings.NewReader("{}"))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("auto-off login/begin status = %d, want 404", recorder.Code)
	}
}

func TestWebAuthnRegistrationTicketRequiresAuth(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouterWithConfig(t, enabledWebAuthnConfig())

	request := httptest.NewRequest(http.MethodPost, "/api/webauthn/registration-ticket", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("registration-ticket without bearer = %d, want 401", recorder.Code)
	}
}
