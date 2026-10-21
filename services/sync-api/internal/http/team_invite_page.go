package http

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

const teamInvitePageTemplateName = "team-invite.html"

// teamInviteAppScheme 은 링크 페이지의 `앱 열기` 가 여는 앱 스킴이다(데스크톱 src/main/protocol-links.ts 와 같다).
// 로그인 콜백의 dolgate:// 와 따로 둔다 — 옛 데스크톱 앱은 dolgate:// 로 온 것을 모두 로그인 콜백으로 읽고,
// 콜백이 아니면 세션을 지운다. 새 스킴은 옛 앱이 모르니 아무 일도 일어나지 않는다.
const teamInviteAppScheme = "dolgate-invite"

// teamInviteDownloadURL 은 앱이 없는 사람에게 주는 내려받기 페이지다.
const teamInviteDownloadURL = "https://doldolma.github.io/Dolgate/#download"

// renderTeamInvitePage 는 초대 링크를 브라우저에서 연 사람에게 보이는 페이지다. teamName 이 비면 쓸 수 없는
// 링크(기한 지남·취소·없음)의 안내만 보인다. 링크의 # 뒤(비밀값)는 서버로 오지 않으므로 `앱 열기` 주소와
// 복사 칸은 페이지 스크립트가 브라우저 안에서 채운다.
func renderTeamInvitePage(ctx *gin.Context, status int, teamName string) {
	applyAuthHTMLResponseHeaders(ctx)
	ctx.Header("Content-Type", "text/html; charset=utf-8")
	ctx.Header("X-Robots-Tag", "noindex")
	ctx.Status(status)
	_ = authPageTemplates.ExecuteTemplate(ctx.Writer, teamInvitePageTemplateName, struct {
		T           pageText
		Live        bool
		TeamName    string
		TeamMark    string
		AppScheme   string
		DownloadURL string
	}{
		T:           pageTextOf(ctx),
		Live:        teamName != "",
		TeamName:    teamName,
		TeamMark:    teamMarkOf(teamName),
		AppScheme:   teamInviteAppScheme,
		DownloadURL: teamInviteDownloadURL,
	})
}

// teamMarkOf 는 팀 표시(머리글자 네모)에 넣을 글자다 — 앞 두 단어의 첫 글자(단어가 하나면 그 첫 글자).
func teamMarkOf(name string) string {
	mark := make([]rune, 0, 2)
	for _, word := range strings.Fields(name) {
		r, _ := utf8.DecodeRuneInString(word)
		mark = append(mark, unicode.ToUpper(r))
		if len(mark) == 2 {
			break
		}
	}
	return string(mark)
}
