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

// 로그인 폼의 fetch 핸들러는 "서버가 응답을 준" 경우 절대 폼을 다시 보내면 안 된다.
// 재전송하면 서버가 이미 처리한 요청이 한 번 더 실행된다 — 회원가입이라면 첫 요청에서
// 계정이 만들어진 뒤 두 번째가 중복으로 실패해, 계정은 있는데 "가입 실패"로 보인다.
// 유일하게 허용되는 폴백은 fetch 자체가 실패한 경우(.catch)뿐이다.
func TestLoginFormDoesNotResubmitWhenServerResponded(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouterWithConfig(t, enabledWebAuthnConfig())
	body := loginPageBody(t, router)

	if calls := strings.Count(body, "nativeSubmit();"); calls != 1 {
		t.Fatalf("nativeSubmit() 호출은 폴백 한 곳이어야 한다, got %d", calls)
	}
	// 응답 헤더가 온 뒤의 실패(본문 잘림·연결 끊김·파싱 오류)는 .catch 로 떨어지지만
	// 서버는 이미 요청을 처리했다. responded 게이트가 없으면 그 경우에도 재전송된다.
	if !strings.Contains(body, "responded = true; return response.text();") {
		t.Fatalf("응답 도착 표식이 없다 — .catch 가 본문 실패까지 재전송한다")
	}
	if !strings.Contains(body, "if (responded) {") {
		t.Fatalf("폴백이 responded 로 걸러지지 않는다")
	}
	if !strings.Contains(body, "서버 응답을 받지 못했습니다") {
		t.Fatalf("응답 후 실패 안내 문구가 없다")
	}
	// 예상 밖 응답(평문 4xx/5xx, 프록시 오류 페이지)에서는 알리고 버튼을 되살린다.
	if !strings.Contains(body, "서버가 로그인을 마치지 못했습니다") {
		t.Fatalf("예상 밖 응답 안내 문구가 없다")
	}
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
