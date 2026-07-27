package http

import "encoding/json"

// 세션 공유 뷰어(브라우저에서 링크로 여는 페이지)의 문구. 인증 페이지(pageText)와 분리한
// 이유는 독자가 다르기 때문이다 — 공유 링크를 받는 사람은 앱 사용자가 아닐 수 있어서,
// 이 페이지의 언어는 받는 사람의 브라우저 설정(Accept-Language)이 기준이다.
//
// json 태그가 붙은 필드는 <body data-viewer-text> 로 실려 viewer.js 가 읽는다. 뷰어의 CSP 는
// script-src 'self' 라 인라인 <script> 로 넘길 수 없다(data 속성은 막히지 않는다).
type viewerText struct {
	Lang string `json:"lang"`
	// TimeLocale 은 채팅 시각을 그릴 때 toLocaleTimeString 에 넘긴다. 예전에는 "ko-KR" 이
	// 하드코딩돼 있어 영어 페이지에서도 "오전/오후" 가 나왔다.
	TimeLocale string `json:"timeLocale"`

	Title         string `json:"title"`
	SharedSession string `json:"sharedSession"`

	StatusConnecting   string `json:"statusConnecting"`
	StatusReadOnly     string `json:"statusReadOnly"`
	StatusInputEnabled string `json:"statusInputEnabled"`
	StatusEnded        string `json:"statusEnded"`
	// ViewerCount*Format 의 %s 는 위 상태 문구, %d 는 시청자 수다. 영어는 단수·복수가
	// 달라서 두 형식을 따로 둔다(한국어는 같은 문장을 쓴다).
	ViewerCountOneFormat  string `json:"viewerCountOneFormat"`
	ViewerCountManyFormat string `json:"viewerCountManyFormat"`
	ShareEnded            string `json:"shareEnded"`

	SearchPlaceholder string `json:"searchPlaceholder"`
	SearchAriaLabel   string `json:"searchAriaLabel"`
	SearchPrev        string `json:"searchPrev"`
	SearchNext        string `json:"searchNext"`
	SearchClose       string `json:"searchClose"`

	ChatPanelAriaLabel      string `json:"chatPanelAriaLabel"`
	ChatHeading             string `json:"chatHeading"`
	ChatOpen                string `json:"chatOpen"`
	ChatCollapse            string `json:"chatCollapse"`
	ChatStatusConnecting    string `json:"chatStatusConnecting"`
	ChatStatusReady         string `json:"chatStatusReady"`
	ChatStatusEnded         string `json:"chatStatusEnded"`
	ChatEmpty               string `json:"chatEmpty"`
	ChatNicknameLabel       string `json:"chatNicknameLabel"`
	ChatNicknamePlaceholder string `json:"chatNicknamePlaceholder"`
	ChatMessageLabel        string `json:"chatMessageLabel"`
	ChatMessagePlaceholder  string `json:"chatMessagePlaceholder"`
	ChatSend                string `json:"chatSend"`
	// ChatOwnerBadge 는 화면에 보이는 배지 문구다. 닉네임 뒤에 붙는 " Owner" 접미사는
	// 소유자 앱이 보내는 와이어 값이라 번역하지 않는다 — viewer.js 가 그 접미사를 정규식으로
	// 벗겨내므로, 번역하면 소유자 닉네임이 "Synology Owner" 처럼 그대로 남는다.
	ChatOwnerBadge    string `json:"chatOwnerBadge"`
	ChatUnknownSender string `json:"chatUnknownSender"`
}

var viewerTextKo = viewerText{
	Lang:       "ko",
	TimeLocale: "ko-KR",

	Title:         "Dolgate 세션 공유",
	SharedSession: "공유된 세션",

	StatusConnecting:      "연결 중",
	StatusReadOnly:        "읽기 전용",
	StatusInputEnabled:    "입력 허용",
	StatusEnded:           "종료됨",
	ViewerCountOneFormat:  "%s · 시청자 %d명",
	ViewerCountManyFormat: "%s · 시청자 %d명",
	ShareEnded:            "세션 공유가 종료되었습니다.",

	SearchPlaceholder: "터미널 출력 검색",
	SearchAriaLabel:   "터미널 출력 검색",
	SearchPrev:        "이전",
	SearchNext:        "다음",
	SearchClose:       "닫기",

	ChatPanelAriaLabel:      "세션 채팅",
	ChatHeading:             "채팅",
	ChatOpen:                "채팅 열기",
	ChatCollapse:            "채팅 접기",
	ChatStatusConnecting:    "연결 중",
	ChatStatusReady:         "대화 가능",
	ChatStatusEnded:         "종료됨",
	ChatEmpty:               "아직 채팅이 없습니다. 첫 메시지를 보내보세요.",
	ChatNicknameLabel:       "닉네임",
	ChatNicknamePlaceholder: "닉네임",
	ChatMessageLabel:        "메시지",
	ChatMessagePlaceholder:  "메시지를 입력하세요",
	ChatSend:                "전송",
	ChatOwnerBadge:          "소유자",
	ChatUnknownSender:       "알 수 없음",
}

var viewerTextEn = viewerText{
	Lang:       "en",
	TimeLocale: "en-US",

	Title:         "Dolgate Session Share",
	SharedSession: "Shared Session",

	StatusConnecting:      "Connecting",
	StatusReadOnly:        "Read only",
	StatusInputEnabled:    "Input enabled",
	StatusEnded:           "Ended",
	ViewerCountOneFormat:  "%s · %d viewer",
	ViewerCountManyFormat: "%s · %d viewers",
	ShareEnded:            "The session share has ended.",

	SearchPlaceholder: "Search terminal output",
	SearchAriaLabel:   "Search terminal output",
	SearchPrev:        "Prev",
	SearchNext:        "Next",
	SearchClose:       "Close",

	ChatPanelAriaLabel:      "Session chat",
	ChatHeading:             "Chat",
	ChatOpen:                "Open chat",
	ChatCollapse:            "Collapse chat",
	ChatStatusConnecting:    "Connecting",
	ChatStatusReady:         "Ready",
	ChatStatusEnded:         "Ended",
	ChatEmpty:               "No messages yet. Send the first one.",
	ChatNicknameLabel:       "Nickname",
	ChatNicknamePlaceholder: "Nickname",
	ChatMessageLabel:        "Message",
	ChatMessagePlaceholder:  "Type a message",
	ChatSend:                "Send",
	ChatOwnerBadge:          "Owner",
	ChatUnknownSender:       "Unknown",
}

func viewerTextFor(locale pageLocale) viewerText {
	if locale == pageLocaleKo {
		return viewerTextKo
	}
	return viewerTextEn
}

// viewerTextJSON 은 data 속성에 실을 JSON 이다. 마샬은 실패할 수 없는 구조체(문자열 필드만)
// 지만, 만약 실패하면 문구 없이라도 페이지는 뜨도록 빈 객체를 돌려준다.
func viewerTextJSON(text viewerText) string {
	encoded, err := json.Marshal(text)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

// 종료 이유 코드. 지금은 한 가지지만, 문장 대신 코드를 실어 보내야 여러 언어의 시청자가
// 각자 자기 언어로 안내를 볼 수 있다.
const shareEndedReason = "ended"

// shareEndedMessageFor 는 코드를 모르는 예전 클라이언트를 위한 완성된 문장이다. 브로드캐스트
// 시점에는 각 시청자의 언어를 알 수 없으므로 한국어(원문)를 쓴다 — 코드를 아는 뷰어는 이
// 값을 무시하고 자기 페이지 언어로 문장을 만든다.
func shareEndedMessageFor(reason string) string {
	if reason == shareEndedReason {
		return viewerTextKo.ShareEnded
	}
	return reason
}
