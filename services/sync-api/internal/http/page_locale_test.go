package http

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func newLocaleContext(target string, header string) *gin.Context {
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	request := httptest.NewRequest(http.MethodGet, target, nil)
	if header != "" {
		request.Header.Set("Accept-Language", header)
	}
	ctx.Request = request
	return ctx
}

func TestResolvePageLocalePrefersLangParam(t *testing.T) {
	// 앱에서 영어를 골랐는데 브라우저가 한국어인 경우 — 앱 설정이 이겨야 한다.
	if locale := resolvePageLocale(newLocaleContext("/login?lang=en", "ko-KR,ko;q=0.9")); locale != pageLocaleEn {
		t.Fatalf("locale = %q, want en", locale)
	}
	if locale := resolvePageLocale(newLocaleContext("/login?lang=ko", "en-US")); locale != pageLocaleKo {
		t.Fatalf("locale = %q, want ko", locale)
	}
	// 모르는 값은 무시하고 다음 신호(Accept-Language)로 넘어간다.
	if locale := resolvePageLocale(newLocaleContext("/login?lang=fr", "ko")); locale != pageLocaleKo {
		t.Fatalf("locale = %q, want ko", locale)
	}
}

func TestResolvePageLocaleFallsBackToAcceptLanguage(t *testing.T) {
	cases := map[string]pageLocale{
		"ko":                         pageLocaleKo,
		"ko-KR":                      pageLocaleKo,
		"ko_KR":                      pageLocaleKo,
		"en-US,en;q=0.9":             pageLocaleEn,
		"ko-KR,ko;q=0.9,en-US;q=0.8": pageLocaleKo,
		"en-US;q=0.8,ko;q=0.9":       pageLocaleKo,
		"fr-FR,de;q=0.9,ko;q=0.5":    pageLocaleKo,
		"ko;q=0,en":                  pageLocaleEn, // q=0 은 "원하지 않음"
		"*":                          defaultPageLocale,
		"":                           defaultPageLocale,
		"fr-FR":                      defaultPageLocale,
		"en;q=0.4,ko;q=0.4":          pageLocaleEn, // q 가 같으면 먼저 나온 언어
	}
	for header, want := range cases {
		if locale := resolvePageLocale(newLocaleContext("/login", header)); locale != want {
			t.Fatalf("Accept-Language %q → %q, want %q", header, locale, want)
		}
	}
}

func TestResolvePageLocaleReadsFormField(t *testing.T) {
	// 폼 POST 에는 쿼리가 없다 — hidden 필드로 온 언어를 읽어야 오류 페이지가 언어를 잃지 않는다.
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	request := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader("lang=ko&email=a@b.c"))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept-Language", "en-US")
	ctx.Request = request
	if locale := resolvePageLocale(ctx); locale != pageLocaleKo {
		t.Fatalf("locale = %q, want ko", locale)
	}
}

func TestApplyPageLocaleOverride(t *testing.T) {
	ctx := newLocaleContext("/auth/oidc/callback", "en-US")
	applyPageLocaleOverride(ctx, "ko")
	if text := pageTextOf(ctx); text.Lang != "ko" {
		t.Fatalf("Lang = %q, want ko", text.Lang)
	}
	// 서명된 state 에 언어가 없던 예전 토큰이면 평소 판정을 그대로 쓴다.
	other := newLocaleContext("/auth/oidc/callback", "en-US")
	applyPageLocaleOverride(other, "")
	if text := pageTextOf(other); text.Lang != "en" {
		t.Fatalf("Lang = %q, want en", text.Lang)
	}
}

// 앱 카탈로그(ko.json/en.json)에 걸어 둔 것과 같은 규칙이다 — 한쪽 언어만 채우거나 영어에
// 한국어를 그대로 복사해 두는 실수는 화면을 봐야만 드러나므로 테스트로 막는다.
func TestPageTextCatalogsAreComplete(t *testing.T) {
	koValue := reflect.ValueOf(pageTextKo)
	enValue := reflect.ValueOf(pageTextEn)
	hangul := regexp.MustCompile(`[가-힣]`)

	for i := 0; i < koValue.NumField(); i++ {
		name := koValue.Type().Field(i).Name
		ko := koValue.Field(i).String()
		en := enValue.Field(i).String()

		if strings.TrimSpace(ko) == "" {
			t.Errorf("pageTextKo.%s 가 비어 있다", name)
		}
		if strings.TrimSpace(en) == "" {
			t.Errorf("pageTextEn.%s 가 비어 있다", name)
		}
		if hangul.MatchString(en) {
			t.Errorf("pageTextEn.%s 에 한글이 남아 있다: %q", name, en)
		}
		// printf 자리표시자가 한쪽에만 있으면 그 자리가 비거나 %!s(MISSING) 로 나온다.
		if strings.Count(ko, "%s") != strings.Count(en, "%s") {
			t.Errorf("pageText.%s 의 %%s 개수가 다르다: ko=%q en=%q", name, ko, en)
		}
	}
}

func TestPageTextLangMatchesLocale(t *testing.T) {
	if pageTextKo.Lang != string(pageLocaleKo) || pageTextEn.Lang != string(pageLocaleEn) {
		t.Fatalf("Lang 이 로케일과 다르다: ko=%q en=%q", pageTextKo.Lang, pageTextEn.Lang)
	}
	if textFor(pageLocaleKo).Lang != "ko" || textFor(pageLocaleEn).Lang != "en" {
		t.Fatalf("textFor 가 잘못된 카탈로그를 돌려준다")
	}
	// 모르는 로케일은 기본 언어로 떨어진다.
	if textFor(pageLocale("fr")).Lang != string(defaultPageLocale) {
		t.Fatalf("모르는 로케일이 기본 언어로 떨어지지 않는다")
	}
}
