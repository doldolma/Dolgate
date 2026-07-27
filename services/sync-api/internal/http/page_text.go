package http

import "github.com/gin-gonic/gin"

// 인증 페이지에 나가는 모든 문구를 언어별로 담는다. map 이 아니라 구조체인 이유:
//   - Go 쪽에서 키를 잘못 쓰면 컴파일이 깨진다(map 은 런타임에 빈 문자열로 조용히 통과).
//   - 두 언어가 모두 채워졌는지 테스트가 리플렉션으로 확인할 수 있다.
//
// 템플릿에서는 {{ .T.필드 }} 로 쓴다. JS 안에서도 따옴표 없이 {{ .T.필드 }} 로 써야 한다 —
// html/template 이 JS 문맥을 알아서 인용·이스케이프한다.
type pageText struct {
	// Lang 은 <html lang="..."> 에 그대로 들어간다.
	Lang string

	// --- 로그인 / 회원가입 페이지 ---
	SignInTitle        string
	SignupTitle        string
	LoginLede          string
	EmailLabel         string
	PasswordLabel      string
	SignInSubmit       string
	SignupSubmit       string
	NoAccountPrompt    string
	SignupLink         string
	PasskeyLoginButton string
	// ContinueWithFormat 은 %s 에 IdP 표시 이름(Google, Okta …)이 들어간다.
	ContinueWithFormat string

	// --- 로그인 페이지 스크립트 ---
	LoginIncomplete     string
	LoginFailed         string
	NoResponse          string
	VerifyFailed        string // 뒤에 " (상태코드)" 가 붙는다
	PasskeyNotAllowed   string
	PasskeyFailedPrefix string
	UnknownError        string
	LoginVerifying      string
	LoginSucceeded      string
	PasskeyChecking     string

	// --- 로그인 폼 오류(서버가 판단해 페이지에 심는다) ---
	InvalidInput          string
	TooManyAttempts       string
	PasswordLoginDisabled string
	BadCredentials        string
	SignupFailed          string
	EmailTaken            string

	// --- 패스키 등록 페이지 ---
	RegisterPageTitle       string
	RegisterHeading         string
	RegisterLede            string
	RegisterNameLabel       string
	RegisterNamePlaceholder string
	RegisterButton          string
	RegisterUnsupported     string
	RegisterBadTicket       string
	RegisterInProgress      string
	RegisterBeginFailed     string
	RegisterDone            string
	RegisterNotAllowed      string
	RegisterDuplicate       string
	GenericError            string

	// --- OIDC 교환 브리지 ---
	OIDCBridgeTitle   string
	OIDCBridgeHeading string
	OIDCBridgeBody    string
	ContinueButton    string

	// --- 앱으로 돌아가는 브리지 ---
	CallbackTitle   string
	CallbackHeading string
	CallbackBody    string
	CallbackOpenApp string
	CallbackHint    string

	// --- 서버 오류(브라우저 인증 경로에서 평문·JSON 으로 나간다) ---
	BadRequest            string
	ServerError           string
	AuthFailed            string
	RequestFailed         string
	UnknownPasskey        string
	UnusablePasskey       string
	PasskeyRegisterFailed string
	RegisterLinkExpired   string
	TooManyPasskeys       string
}

var pageTextKo = pageText{
	Lang: "ko",

	SignInTitle:        "Dolgate 로그인",
	SignupTitle:        "Dolgate 계정 만들기",
	LoginLede:          "브라우저에서 로그인한 뒤 앱으로 돌아갑니다.",
	EmailLabel:         "이메일",
	PasswordLabel:      "비밀번호",
	SignInSubmit:       "로그인",
	SignupSubmit:       "계정 만들기",
	NoAccountPrompt:    "계정이 없나요?",
	SignupLink:         "회원가입",
	PasskeyLoginButton: "패스키로 로그인",
	ContinueWithFormat: "%s 계정으로 계속하기",

	LoginIncomplete:     "서버가 로그인을 마치지 못했습니다. 잠시 후 다시 시도해 주세요.",
	LoginFailed:         "로그인에 실패했습니다.",
	NoResponse:          "서버 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.",
	VerifyFailed:        "로그인 검증 실패",
	PasskeyNotAllowed:   "등록된 패스키가 없거나 인증이 취소되었습니다. 먼저 패스키를 등록해 주세요.",
	PasskeyFailedPrefix: "패스키 로그인 실패: ",
	UnknownError:        "알 수 없는 오류",
	LoginVerifying:      "로그인 확인 중…",
	LoginSucceeded:      "로그인 성공 — 앱으로 돌아갑니다.",
	PasskeyChecking:     "패스키 확인 중…",

	InvalidInput:          "입력값을 확인해 주세요.",
	TooManyAttempts:       "너무 많은 인증 시도가 감지되었습니다. 잠시 후 다시 시도해 주세요.",
	PasswordLoginDisabled: "이 서버에서는 비밀번호 로그인이 비활성화되어 있습니다.",
	BadCredentials:        "이메일 또는 비밀번호가 올바르지 않습니다.",
	SignupFailed:          "회원가입에 실패했습니다.",
	EmailTaken:            "이미 사용 중인 이메일입니다.",

	RegisterPageTitle:       "Dolgate 패스키 등록",
	RegisterHeading:         "패스키 등록",
	RegisterLede:            "이 기기의 생체 인증 또는 보안 키로 패스키를 등록합니다. 다음 로그인부터 비밀번호 없이 사용할 수 있습니다.",
	RegisterNameLabel:       "패스키 이름(선택)",
	RegisterNamePlaceholder: "예: 내 맥북",
	RegisterButton:          "패스키 등록",
	RegisterUnsupported:     "이 브라우저에서는 패스키를 사용할 수 없습니다.",
	RegisterBadTicket:       "등록 링크가 올바르지 않거나 만료되었습니다. 앱에서 다시 시도해 주세요.",
	RegisterInProgress:      "진행 중…",
	RegisterBeginFailed:     "등록을 시작할 수 없습니다.",
	RegisterDone:            "패스키가 등록되었습니다. 이 창을 닫고 앱으로 돌아가 주세요.",
	RegisterNotAllowed:      "등록이 취소되었거나 시간이 초과되었습니다. 이미 이 기기에 등록된 패스키가 있으면 중복 등록은 차단됩니다 — 다른 기기·보안 키로 추가하려면 인증 창에서 다른 옵션을 선택하세요.",
	RegisterDuplicate:       "이 기기에는 이미 이 계정의 패스키가 등록되어 있습니다.",
	GenericError:            "오류가 발생했습니다.",

	OIDCBridgeTitle:   "Dolgate 로그인 처리 중",
	OIDCBridgeHeading: "로그인 처리 중…",
	OIDCBridgeBody:    "잠시만 기다려 주세요. 자동으로 진행되지 않으면 아래 버튼을 눌러 주세요.",
	ContinueButton:    "계속",

	CallbackTitle:   "Dolgate 열기",
	CallbackHeading: "앱으로 돌아가는 중",
	CallbackBody:    "로그인은 완료되었습니다. Dolgate 앱이 자동으로 열리지 않으면 아래 버튼을 눌러 돌아가세요.",
	CallbackOpenApp: "Dolgate 열기 ↗",
	CallbackHint:    "앱이 이미 열려 있다면 이 탭은 닫아도 됩니다.",

	BadRequest:            "잘못된 요청입니다.",
	ServerError:           "서버 오류가 발생했습니다.",
	AuthFailed:            "인증에 실패했습니다.",
	RequestFailed:         "요청 처리 중 오류가 발생했습니다.",
	UnknownPasskey:        "등록되지 않은 패스키입니다.",
	UnusablePasskey:       "이 패스키는 사용할 수 없습니다. 다른 방법으로 로그인한 뒤 설정에서 삭제하고 다시 등록해 주세요.",
	PasskeyRegisterFailed: "패스키 등록에 실패했습니다.",
	RegisterLinkExpired:   "등록 링크가 만료되었거나 이미 사용되었습니다.",
	TooManyPasskeys:       "등록할 수 있는 패스키 개수를 초과했습니다. 사용하지 않는 패스키를 먼저 삭제해 주세요.",
}

var pageTextEn = pageText{
	Lang: "en",

	SignInTitle:        "Sign in to Dolgate",
	SignupTitle:        "Create your Dolgate account",
	LoginLede:          "Sign in here, then return to the app.",
	EmailLabel:         "Email",
	PasswordLabel:      "Password",
	SignInSubmit:       "Sign in",
	SignupSubmit:       "Create account",
	NoAccountPrompt:    "No account yet?",
	SignupLink:         "Sign up",
	PasskeyLoginButton: "Sign in with a passkey",
	ContinueWithFormat: "Continue with %s",

	LoginIncomplete:     "The server could not finish the sign-in. Try again in a moment.",
	LoginFailed:         "The sign-in failed.",
	NoResponse:          "No response from the server. Try again in a moment.",
	VerifyFailed:        "Sign-in verification failed",
	PasskeyNotAllowed:   "No passkey is registered, or the prompt was cancelled. Register a passkey first.",
	PasskeyFailedPrefix: "Passkey sign-in failed: ",
	UnknownError:        "unknown error",
	LoginVerifying:      "Verifying the sign-in…",
	LoginSucceeded:      "Signed in — returning to the app.",
	PasskeyChecking:     "Checking the passkey…",

	InvalidInput:          "Check the values you entered.",
	TooManyAttempts:       "Too many sign-in attempts were detected. Try again in a moment.",
	PasswordLoginDisabled: "Password sign-in is disabled on this server.",
	BadCredentials:        "The email or password is incorrect.",
	SignupFailed:          "The sign-up failed.",
	EmailTaken:            "That email is already in use.",

	RegisterPageTitle:       "Register a Dolgate passkey",
	RegisterHeading:         "Register a passkey",
	RegisterLede:            "Register a passkey using this device's biometrics or a security key. From your next sign-in you can skip the password.",
	RegisterNameLabel:       "Passkey name (optional)",
	RegisterNamePlaceholder: "e.g. My MacBook",
	RegisterButton:          "Register passkey",
	RegisterUnsupported:     "This browser cannot use passkeys.",
	RegisterBadTicket:       "The registration link is invalid or has expired. Try again from the app.",
	RegisterInProgress:      "Working…",
	RegisterBeginFailed:     "Could not start the registration.",
	RegisterDone:            "The passkey is registered. Close this window and return to the app.",
	RegisterNotAllowed:      "The registration was cancelled or timed out. If this device already has a passkey for this account, a duplicate is blocked — to add another device or security key, pick a different option in the prompt.",
	RegisterDuplicate:       "This device already has a passkey for this account.",
	GenericError:            "Something went wrong.",

	OIDCBridgeTitle:   "Signing in to Dolgate",
	OIDCBridgeHeading: "Signing in…",
	OIDCBridgeBody:    "One moment. If this does not continue on its own, press the button below.",
	ContinueButton:    "Continue",

	CallbackTitle:   "Open Dolgate",
	CallbackHeading: "Returning to the app",
	CallbackBody:    "You are signed in. If the Dolgate app does not open on its own, press the button below to go back.",
	CallbackOpenApp: "Open Dolgate ↗",
	CallbackHint:    "If the app is already open, you can close this tab.",

	BadRequest:            "Bad request.",
	ServerError:           "A server error occurred.",
	AuthFailed:            "Authentication failed.",
	RequestFailed:         "An error occurred while handling the request.",
	UnknownPasskey:        "That passkey is not registered.",
	UnusablePasskey:       "This passkey cannot be used. Sign in another way, then delete it in settings and register it again.",
	PasskeyRegisterFailed: "The passkey registration failed.",
	RegisterLinkExpired:   "The registration link has expired or was already used.",
	TooManyPasskeys:       "You have reached the passkey limit. Delete a passkey you no longer use first.",
}

func textFor(locale pageLocale) pageText {
	if locale == pageLocaleKo {
		return pageTextKo
	}
	return pageTextEn
}

// pageTextContextKey 는 한 요청 안에서 언어 판정을 한 번만 하도록 결과를 캐시하는 키다.
const pageTextContextKey = "dolgate.pageText"

// pageTextOf 는 이 요청에 쓸 문구 집합을 돌려준다. 핸들러가 오류 문구를 만들 때와 렌더할
// 때 각각 부르므로 gin 컨텍스트에 캐시한다.
func pageTextOf(ctx *gin.Context) pageText {
	if cached, ok := ctx.Get(pageTextContextKey); ok {
		if text, ok := cached.(pageText); ok {
			return text
		}
	}
	text := textFor(resolvePageLocale(ctx))
	ctx.Set(pageTextContextKey, text)
	return text
}

// applyPageLocaleOverride 는 요청 자체에 언어 정보가 없는 경로(OIDC 프로바이더가 되돌려
// 보낸 콜백)에서, 서명된 state 에 실려 온 언어를 이 요청의 언어로 고정한다. 모르는 값이면
// 아무것도 하지 않아 평소 판정(Accept-Language)이 그대로 쓰인다.
func applyPageLocaleOverride(ctx *gin.Context, value string) {
	if locale, ok := normalizePageLocale(value); ok {
		ctx.Set(pageTextContextKey, textFor(locale))
	}
}
