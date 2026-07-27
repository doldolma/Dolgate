package http

import (
	"bytes"
	"strings"
	"testing"
)

// OIDC 버튼만 printf 자리표시자를 쓴다. 한쪽 카탈로그에서 %s 를 빠뜨리면 화면에
// "%!s(MISSING)" 이 뜨는데, OIDC 프로바이더를 띄우지 않는 라우터 테스트로는 안 잡힌다.
func TestLoginPageOIDCButtonInterpolatesProvider(t *testing.T) {
	cases := map[pageLocale]string{
		pageLocaleKo: "Google 계정으로 계속하기",
		pageLocaleEn: "Continue with Google",
	}
	for locale, want := range cases {
		var buf bytes.Buffer
		data := loginPageData{
			T:               textFor(locale),
			OIDCEnabled:     true,
			OIDCDisplayName: "Google",
		}
		if err := authPageTemplates.ExecuteTemplate(&buf, loginPageTemplateName, data); err != nil {
			t.Fatalf("%s: template execute: %v", locale, err)
		}
		out := buf.String()
		if !strings.Contains(out, want) {
			t.Errorf("%s: %q 가 없다", locale, want)
		}
		if strings.Contains(out, "MISSING") || strings.Contains(out, "%!s") {
			t.Errorf("%s: printf 자리표시자가 맞지 않는다", locale)
		}
		// OIDC 시작 링크가 언어를 잃으면 프로바이더를 다녀온 뒤 브리지 페이지의 언어가 바뀐다.
		if !strings.Contains(out, "lang="+string(locale)) {
			t.Errorf("%s: OIDC 시작 링크에 lang 이 없다", locale)
		}
	}
}
