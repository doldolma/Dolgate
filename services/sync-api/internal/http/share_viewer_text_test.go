package http

import (
	"bytes"
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// pageText 와 같은 규칙 — 한쪽 언어만 채우거나 영어에 한국어를 복사해 두는 실수를 막는다.
func TestViewerTextCatalogsAreComplete(t *testing.T) {
	koValue := reflect.ValueOf(viewerTextKo)
	enValue := reflect.ValueOf(viewerTextEn)
	hangul := regexp.MustCompile(`[가-힣]`)

	for i := 0; i < koValue.NumField(); i++ {
		name := koValue.Type().Field(i).Name
		ko := koValue.Field(i).String()
		en := enValue.Field(i).String()

		if strings.TrimSpace(ko) == "" {
			t.Errorf("viewerTextKo.%s 가 비어 있다", name)
		}
		if strings.TrimSpace(en) == "" {
			t.Errorf("viewerTextEn.%s 가 비어 있다", name)
		}
		if hangul.MatchString(en) {
			t.Errorf("viewerTextEn.%s 에 한글이 남아 있다: %q", name, en)
		}
		// 시청자 수 문구의 %s·%d 가 한쪽에만 있으면 화면에 %!d(MISSING) 이 뜬다.
		for _, verb := range []string{"%s", "%d"} {
			if strings.Count(ko, verb) != strings.Count(en, verb) {
				t.Errorf("viewerText.%s 의 %s 개수가 다르다: ko=%q en=%q", name, verb, ko, en)
			}
		}
	}
}

// viewer.js 는 이 JSON 의 키를 그대로 읽는다. 태그가 빠지면 Go 필드명(PascalCase)이 키가 되어
// 조용히 값을 못 찾고 영어 기본값으로 떨어진다.
func TestViewerTextJSONUsesCamelCaseKeys(t *testing.T) {
	var decoded map[string]any
	if err := json.Unmarshal([]byte(viewerTextJSON(viewerTextKo)), &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{
		"lang", "timeLocale", "chatEmpty", "chatOpen", "chatOwnerBadge",
		"statusReadOnly", "viewerCountOneFormat", "shareEnded",
	} {
		if _, ok := decoded[key]; !ok {
			t.Errorf("JSON 에 %q 키가 없다", key)
		}
	}
	if len(decoded) != reflect.TypeOf(viewerTextKo).NumField() {
		t.Errorf("JSON 키 수(%d)가 필드 수(%d)와 다르다", len(decoded), reflect.TypeOf(viewerTextKo).NumField())
	}
}

func TestShareViewerPageRendersInBothLanguages(t *testing.T) {
	cases := map[pageLocale]struct {
		lang string
		want []string
	}{
		pageLocaleKo: {lang: "ko", want: []string{"공유된 세션", "채팅", "닉네임", "전송", "터미널 출력 검색"}},
		pageLocaleEn: {lang: "en", want: []string{"Shared Session", "Chat", "Nickname", "Send", "Search terminal output"}},
	}
	for locale, expected := range cases {
		text := viewerTextFor(locale)
		var buf bytes.Buffer
		err := shareViewerTemplate.Execute(&buf, viewerPageData{
			ShareID:      "share-1",
			ViewerToken:  "viewer-token-1",
			AssetVersion: shareAssetVersion,
			T:            text,
			TextJSON:     viewerTextJSON(text),
		})
		if err != nil {
			t.Fatalf("%s: template execute: %v", locale, err)
		}
		out := buf.String()

		if !strings.Contains(out, `<html lang="`+expected.lang+`">`) {
			t.Errorf("%s: <html lang> 이 %s 가 아니다", locale, expected.lang)
		}
		for _, want := range expected.want {
			if !strings.Contains(out, want) {
				t.Errorf("%s: %q 가 없다", locale, want)
			}
		}
		// viewer.js 가 읽는 data 속성이 실려야 한다. html/template 이 속성 문맥에서 따옴표를
		// 이스케이프하므로, 브라우저가 되돌린 값이 JSON 으로 파싱되는지까지 확인한다.
		if !strings.Contains(out, "data-viewer-text=") {
			t.Fatalf("%s: data-viewer-text 속성이 없다", locale)
		}
		attr := regexp.MustCompile(`data-viewer-text="([^"]*)"`).FindStringSubmatch(out)
		if attr == nil {
			t.Fatalf("%s: data-viewer-text 값을 읽지 못했다", locale)
		}
		var decoded viewerText
		unescaped := strings.ReplaceAll(attr[1], "&#34;", `"`)
		if err := json.Unmarshal([]byte(unescaped), &decoded); err != nil {
			t.Fatalf("%s: data 속성 JSON 파싱 실패: %v", locale, err)
		}
		if decoded.Lang != expected.lang || decoded.ChatEmpty != text.ChatEmpty {
			t.Errorf("%s: data 속성 문구가 카탈로그와 다르다: %+v", locale, decoded)
		}
	}

	if strings.Contains(shareAssetVersion, "owner-chat-display-v2") {
		t.Errorf("viewer.html/js 를 바꿨으면 shareAssetVersion 도 올려야 캐시가 갱신된다")
	}
}

// 종료 안내는 여러 언어의 시청자에게 한 번에 나가므로 코드를 함께 보내야 한다.
func TestShareEndedMessageFallsBackToKorean(t *testing.T) {
	if got := shareEndedMessageFor(shareEndedReason); got != viewerTextKo.ShareEnded {
		t.Fatalf("message = %q", got)
	}
}
