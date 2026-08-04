package http

import (
	"embed"
	"html/template"
	"io/fs"
)

//go:embed share_assets
var shareAssets embed.FS

type viewerPageData struct {
	ShareID      string
	ViewerToken  string
	AssetVersion string
	// T 는 서버가 그리는 마크업용, TextJSON 은 viewer.js 가 런타임에 읽는 같은 문구 집합이다.
	T        viewerText
	TextJSON string
}

// share_assets/vendor 의 xterm 에셋은 npm 패키지에서 손으로 복사한 것이다. 복사 스크립트가
// 없어 파일만 보고는 어느 버전인지 알 수 없으므로, 아래에 출처를 명시한다. 에셋을 교체하면
// 이 표와 shareAssetVersion 을 함께 갱신해야 한다 — 갱신하지 않으면 브라우저가 옛 파일을
// 캐시에서 계속 쓴다.
//
//	vendor/xterm.js                 @xterm/xterm@5.5.0            lib/xterm.js
//	vendor/xterm.css                @xterm/xterm@5.5.0            css/xterm.css
//	vendor/xterm-addon-search.js    @xterm/addon-search@0.15.0    lib/addon-search.js
//	vendor/xterm-addon-unicode11.js @xterm/addon-unicode11@0.8.0  lib/addon-unicode11.js
//	vendor/xterm-addon-web-links.js @xterm/addon-web-links@0.11.0 lib/addon-web-links.js
//	vendor/xterm-addon-image.js     @xterm/addon-image@0.8.0      lib/addon-image.js
//
// addon-image 는 서드파티 코드를 번들하므로 고지 파일(lib/addon-image.js.LICENSE.txt)도 함께
// 벤더링한다 — 번들 첫 줄이 이 파일을 가리킨다. 이 애드온은 CSP 에 'wasm-unsafe-eval' 을
// 요구한다(applyShareViewerResponseHeaders 참고).
//
// 애드온 버전은 코어와 같은 날 릴리스된 세트를 골라야 한다(5.5.0 은 2024-04-05). 애드온이
// peerDependencies 를 선언하지 않아 npm 이 짝을 검증해 주지 않는다.
//
// 벤더 파일명은 업스트림 산출물명(addon-search.js)과 다르게 옛 이름을 유지한다 — viewer.html
// 의 script 태그와 라우터 테스트가 이 경로를 참조하기 때문이다.
const shareAssetVersion = "20260804-xterm-5.5-image-v6"

func mustShareAssetFS() fs.FS {
	assetFS, err := fs.Sub(shareAssets, "share_assets")
	if err != nil {
		panic(err)
	}
	return assetFS
}

var shareViewerTemplate = template.Must(template.ParseFS(shareAssets, "share_assets/viewer.html"))
