package http_test

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

var hangulPattern = regexp.MustCompile(`[가-힣]`)

func getPage(t *testing.T, router *gin.Engine, target string) string {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, target, nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET %s status = %d: %s", target, recorder.Code, recorder.Body.String())
	}
	return recorder.Body.String()
}

// 영어 페이지에 한글이 남아 있으면 문구를 하나 빠뜨린 것이다. 주석·개발용 console 로그는
// 사용자에게 보이지 않으므로 검사에서 뺀다.
func assertNoHangulInMarkup(t *testing.T, label string, body string) {
	t.Helper()
	for index, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "console.") {
			continue
		}
		if strings.Contains(trimmed, "console.info(") || strings.Contains(trimmed, "console.warn(") {
			continue
		}
		if hangulPattern.MatchString(trimmed) {
			t.Errorf("%s: 영어 페이지 %d번째 줄에 한글이 남아 있다: %s", label, index+1, trimmed)
		}
	}
}

func TestAuthPagesRenderInBothLanguages(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouterWithConfig(t, enabledWebAuthnConfig())

	// 앱이 실어 보내는 lang 파라미터로 각 페이지를 두 언어로 받아 본다.
	pages := []struct {
		label  string
		target string
		ko     []string
		en     []string
	}{
		{
			label:  "로그인",
			target: "/login?client=desktop&redirect_uri=http%3A%2F%2F127.0.0.1%3A53123%2Fcb&state=s",
			ko:     []string{"Dolgate 로그인", "이메일", "비밀번호", "패스키로 로그인", "회원가입"},
			en:     []string{"Sign in to Dolgate", "Email", "Password", "Sign in with a passkey", "Sign up"},
		},
		{
			label:  "회원가입",
			target: "/signup?client=desktop&redirect_uri=http%3A%2F%2F127.0.0.1%3A53123%2Fcb&state=s",
			ko:     []string{"Dolgate 계정 만들기", "계정 만들기"},
			en:     []string{"Create your Dolgate account", "Create account"},
		},
		{
			label:  "패스키 등록",
			target: "/auth/webauthn/register",
			ko:     []string{"패스키 등록", "패스키 이름(선택)"},
			en:     []string{"Register a passkey", "Passkey name (optional)"},
		},
		{
			label:  "앱으로 돌아가는 브리지",
			target: "/auth/aws-sso/callback?code=abc&state=xyz",
			ko:     []string{"앱으로 돌아가는 중", "Dolgate 열기"},
			en:     []string{"Returning to the app", "Open Dolgate"},
		},
	}

	for _, page := range pages {
		separator := "?"
		if strings.Contains(page.target, "?") {
			separator = "&"
		}

		korean := getPage(t, router, page.target+separator+"lang=ko")
		if !strings.Contains(korean, `<html lang="ko">`) {
			t.Errorf("%s(ko): <html lang> 이 ko 가 아니다", page.label)
		}
		for _, want := range page.ko {
			if !strings.Contains(korean, want) {
				t.Errorf("%s(ko): %q 가 없다", page.label, want)
			}
		}

		english := getPage(t, router, page.target+separator+"lang=en")
		if !strings.Contains(english, `<html lang="en">`) {
			t.Errorf("%s(en): <html lang> 이 en 이 아니다", page.label)
		}
		for _, want := range page.en {
			if !strings.Contains(english, want) {
				t.Errorf("%s(en): %q 가 없다", page.label, want)
			}
		}
		assertNoHangulInMarkup(t, page.label+"(en)", english)
	}
}

func TestLoginPageFollowsAcceptLanguageWithoutLangParam(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouterWithConfig(t, enabledWebAuthnConfig())

	request := httptest.NewRequest(http.MethodGet, "/login", nil)
	request.Header.Set("Accept-Language", "ko-KR,ko;q=0.9,en;q=0.8")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if !strings.Contains(recorder.Body.String(), `<html lang="ko">`) {
		t.Fatalf("브라우저 언어(ko)를 따르지 않는다")
	}
}

// 폼 오류로 페이지를 다시 그릴 때 언어를 잃으면, 영어로 로그인하던 사용자가 한국어 오류를
// 보게 된다. hidden 필드로 실어 보낸 lang 이 그 경로를 지킨다.
func TestLoginFormErrorKeepsRequestedLanguage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouterWithConfig(t, enabledWebAuthnConfig())

	post := func(lang string) string {
		form := url.Values{}
		form.Set("email", "nobody@example.com")
		form.Set("password", "wrong-password")
		form.Set("redirect_uri", "http://127.0.0.1:53123/auth/callback")
		form.Set("lang", lang)
		request := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader(form.Encode()))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		// 브라우저 언어는 일부러 반대로 둔다 — 폼에 실린 언어가 이겨야 한다.
		request.Header.Set("Accept-Language", "ko-KR")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder.Body.String()
	}

	english := post("en")
	if !strings.Contains(english, "The email or password is incorrect.") {
		t.Errorf("영어 오류 문구가 없다")
	}
	if !strings.Contains(english, `<html lang="en">`) {
		t.Errorf("오류 페이지가 영어가 아니다")
	}

	korean := post("ko")
	if !strings.Contains(korean, "이메일 또는 비밀번호가 올바르지 않습니다.") {
		t.Errorf("한국어 오류 문구가 없다")
	}
}

// 로그인 페이지의 JS 가 부르는 패스키 엔드포인트도 페이지와 같은 언어로 답해야 한다 —
// 브라우저 언어와 페이지 언어가 다를 수 있어서 Accept-Language 만으로는 어긋난다.
func TestWebAuthnBrowserEndpointErrorsFollowLangParam(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := createTestRouterWithConfig(t, enabledWebAuthnConfig())

	post := func(target string) string {
		request := httptest.NewRequest(http.MethodPost, target, strings.NewReader("not json"))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept-Language", "ko-KR")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder.Body.String()
	}

	if body := post("/auth/webauthn/login/finish?lang=en"); !strings.Contains(body, "Bad request.") {
		t.Errorf("영어 오류가 아니다: %s", body)
	}
	if body := post("/auth/webauthn/login/finish?lang=ko"); !strings.Contains(body, "잘못된 요청입니다.") {
		t.Errorf("한국어 오류가 아니다: %s", body)
	}
}
