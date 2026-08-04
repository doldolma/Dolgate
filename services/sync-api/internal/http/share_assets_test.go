package http

import (
	"io/fs"
	"path"
	"strings"
	"testing"
)

// viewer.js 는 애드온을 window.<전역>?.<클래스> 로 꺼낸다. 옵셔널 체이닝이라 전역 이름이
// 어긋나도 예외가 나지 않고 애드온만 조용히 빠진다 — 검색이 안 되는 증상으로만 드러나서
// 벤더 에셋 교체 사고를 놓치기 쉽다. 런타임 없이라도 짝은 정적으로 검증한다.
func TestShareViewerVendorBundlesExposeGlobalsViewerReads(t *testing.T) {
	viewerJS := readShareAsset(t, "share_assets/viewer.js")

	cases := []struct {
		bundle string
		global string
	}{
		{"share_assets/vendor/xterm.js", "Terminal"},
		{"share_assets/vendor/xterm-addon-search.js", "SearchAddon"},
		{"share_assets/vendor/xterm-addon-unicode11.js", "Unicode11Addon"},
		{"share_assets/vendor/xterm-addon-web-links.js", "WebLinksAddon"},
		{"share_assets/vendor/xterm-addon-image.js", "ImageAddon"},
	}

	for _, testCase := range cases {
		bundle := readShareAsset(t, testCase.bundle)

		// UMD 빌드는 전역에 붙일 때 `<객체>.<이름>=` 형태를 거친다. minify 로 변수명은 바뀌지만
		// 노출하는 심볼 이름은 남으므로, 번들이 그 심볼을 내보내는지 확인하는 대리 검사가 된다.
		if !strings.Contains(bundle, "."+testCase.global+"=") {
			t.Fatalf("%s: 번들이 viewer.js 가 읽는 %q 전역을 노출하지 않는다 — 벤더 에셋 버전이 어긋났을 수 있다", testCase.bundle, testCase.global)
		}
		if !strings.Contains(viewerJS, "window."+testCase.global) {
			t.Fatalf("viewer.js 가 window.%s 를 더 이상 읽지 않는다 — %s 가 불필요해졌는지 확인이 필요하다", testCase.global, testCase.bundle)
		}
	}
}

// 벤더 파일은 viewer.html 이 로드해 주지 않으면 전역이 생기지 않는다. 반대로 로드되지 않는
// 파일이 남아 있으면 바이너리에 죽은 에셋이 실린다. 양방향으로 맞물리는지 확인한다.
func TestShareViewerHTMLLoadsEveryVendorAsset(t *testing.T) {
	viewerHTML := readShareAsset(t, "share_assets/viewer.html")

	entries, err := fs.ReadDir(shareAssets, "share_assets/vendor")
	if err != nil {
		t.Fatalf("벤더 디렉터리를 읽지 못했다: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("벤더 디렉터리가 비어 있다 — embed 가 깨졌다")
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		switch path.Ext(entry.Name()) {
		case ".js", ".css":
			// 캐시 버스팅 쿼리까지 확인한다 — shareAssetVersion 을 갱신하지 않으면 교체한
			// 에셋이 브라우저 캐시에 가려 반영되지 않는다.
			reference := "/share/assets/vendor/" + entry.Name() + "?v={{ .AssetVersion }}"
			if !strings.Contains(viewerHTML, reference) {
				t.Fatalf("viewer.html 이 %s 를 캐시 버스팅 붙여 로드하지 않는다", entry.Name())
			}
		case ".txt":
			// 번들이 참조하는 서드파티 라이선스 고지. 페이지가 로드하지는 않지만 코드와 함께
			// 배포돼야 하므로 벤더 디렉터리에 남긴다.
		default:
			t.Fatalf("벤더 디렉터리에 분류되지 않은 파일이 있다: %s — 로드 대상인지 확인이 필요하다", entry.Name())
		}
	}
}

// 인라인 이미지 애드온을 로드하면 .xterm-screen 에 절대 배치된 캔버스가 붙고, 그 캔버스는
// desynchronized 컨텍스트라 별도 합성 레이어로 승격돼 투명해도 아래 텍스트를 가린다. viewer.css
// 가 .xterm-rows 를 그 위로 올려주지 않으면 이미지가 뜨는 순간 터미널 전체가 검게 보인다.
//
// 이 조합은 브라우저 합성 단계에서만 드러나서 Go 테스트로도, 헤드리스 렌더링으로도 재현되지
// 않는다(실제로 인앱 브라우저에서는 정상 동작했다). 그래서 최소한 두 파일이 짝을 유지하는지는
// 정적으로 묶어둔다 — 애드온을 계속 로드하면서 CSS 만 지우는 변경을 막는 게 목적이다.
func TestShareViewerRaisesTextAboveImageLayer(t *testing.T) {
	viewerHTML := readShareAsset(t, "share_assets/viewer.html")
	if !strings.Contains(viewerHTML, "vendor/xterm-addon-image.js") {
		t.Skip("이미지 애드온을 로드하지 않으므로 겹침 문제가 없다")
	}

	viewerCSS := readShareAsset(t, "share_assets/viewer.css")
	rule := extractCSSRule(viewerCSS, ".viewer-terminal .xterm-rows")
	if rule == "" {
		t.Fatal("viewer.css 에 .viewer-terminal .xterm-rows 규칙이 없다 — 이미지 애드온 캔버스가 텍스트를 가린다")
	}
	if !strings.Contains(rule, "z-index") || !strings.Contains(rule, "position") {
		t.Fatalf(".xterm-rows 규칙에 position 과 z-index 가 모두 있어야 캔버스 위로 올라간다: %q", rule)
	}
}

// extractCSSRule 은 선택자 뒤의 선언 블록만 잘라 돌려준다. 없으면 빈 문자열.
func extractCSSRule(css string, selector string) string {
	start := strings.Index(css, selector)
	if start < 0 {
		return ""
	}
	open := strings.Index(css[start:], "{")
	closeAt := strings.Index(css[start:], "}")
	if open < 0 || closeAt < open {
		return ""
	}
	return css[start+open+1 : start+closeAt]
}

func readShareAsset(t *testing.T, name string) string {
	t.Helper()

	contents, err := shareAssets.ReadFile(name)
	if err != nil {
		t.Fatalf("%s 를 읽지 못했다: %v", name, err)
	}
	return string(contents)
}
