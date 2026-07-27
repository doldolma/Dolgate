package http

import (
	"embed"
	"html/template"
)

// 브라우저에 보이는 인증 페이지(로그인·회원가입·패스키 등록·리다이렉트 브리지)를 파일로
// 두고 바이너리에 embed 한다 — share_assets(세션 공유 뷰어)와 같은 방식이라 배포물은
// 그대로 단일 바이너리이고 런타임 파일 의존이 없다.
//
// 예전에는 router.go 안의 백틱 raw 문자열이었다. 570줄짜리 HTML+CSS+JS 라 문법 강조가
// 안 되고 4개 페이지가 같은 CSS 를 각자 복사해 갖고 있었다.
//
// 디렉터리를 통째로 지정하면(`//go:embed auth_assets`) '_' 로 시작하는 파일이 조용히
// 빠져 공용 partial(_shared.html)이 embed 되지 않는다. 그래서 glob 으로 명시한다.
//
//go:embed auth_assets/*.html
var authAssets embed.FS

// html/template 의 문맥 인식 이스케이프에 의존하는 페이지들이다(속성·JS 문맥). ParseFS 로
// 한 세트로 묶어야 공용 partial(_shared.html)의 define 을 각 페이지가 쓸 수 있다.
var authPageTemplates = template.Must(template.ParseFS(authAssets, "auth_assets/*.html"))

const (
	loginPageTemplateName             = "login.html"
	webauthnRegisterPageTemplateName  = "webauthn-register.html"
	oidcExchangeBridgeTemplateName    = "oidc-bridge.html"
	desktopCallbackBridgeTemplateName = "desktop-callback.html"
)
