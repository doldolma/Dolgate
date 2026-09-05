package tmuxsession

import (
	"fmt"
	"strings"
	"time"

	"dolssh/services/ssh-core/internal/sshcmd"
)

// 이 파일은 셸 통합 init 을 pane 에 **최소한만 타이핑해서** 심는다.
//
// 왜 필요한가. pane 에 무엇을 타이핑하면 셸의 tty 가 그것을 에코하고, 그 에코는 **tmux 의 pane
// 버퍼에 남는다.** 핸드셰이크는 우리가 렌더러로 보내는 스트림만 가리므로 그때 화면은 깨끗해
// 보이지만, tmux 의 버퍼에는 그대로 있다. 창을 전환하거나 재연결해서 그 버퍼를 다시 그리면
// 1200자 init 스크립트 전문이 프롬프트 아래에 통째로 나타난다 — 사용자가 실제로 본 화면이다.
//
// 그래서 스크립트 본문은 **tmux 서버의 paste 버퍼**에 넣고(`load-buffer -` 로 stdin 에서),
// pane 에는 그것을 읽어 eval 하는 짧은 한 줄만 타이핑한다. 남는 흔적이 15줄에서 한 줄로 준다.
//
// **원격 파일시스템에는 아무것도 쓰지 않는다.** 이 앱의 원칙이다. 한 번 `/tmp` 에 파일로
// 심었다가 바로잡았다 — tmux 버퍼는 서버 프로세스 메모리라 파일이 아니고, 읽는 즉시 지운다.
//
// 재주입(서브셸)에는 쓰지 않는다. 그 셸은 다른 호스트일 수 있고(pane 안에서 중첩 ssh) 그러면
// `tmux` 명령이 그 셸에서 우리 서버를 가리키지 않는다.

const paneInjectBufferTimeout = 5 * time.Second

// paneInjectBufferName 은 pane 별 tmux 버퍼 이름이다. pane 여러 개가 동시에 심어도 겹치지 않는다.
func paneInjectBufferName(paneID string) string {
	return "dolgate-init-" + strings.TrimPrefix(paneID, "%")
}

// paneEchoSpot 은 타이핑할 순간의 커서 자리와 pane 크기다(tmux 가 알려준다). 0 이면 모른다.
type paneEchoSpot struct {
	cursorX, cursorY int
	width, height    int
}

// echoEraseSequence 는 타이핑한 한 줄의 **에코를 셸 안에서 스스로 지우는** 시퀀스를 만든다.
//
// 흔적이 한 줄로 줄어도 사용자는 그 한 줄을 "이상한 게 입력됐다" 로 본다. tty 에코는 tmux 의
// pane 버퍼에 남고, 우리가 렌더러로 보내는 스트림만 가리는 핸드셰이크로는 지울 수 없다. 하지만
// 그 에코가 **어디에** 찍혔는지는 안다 — 타이핑 직전 커서(프롬프트 끝)에서 시작해 typedLen
// 글자만큼 폭에 맞춰 감긴다. 그래서 스크립트의 마지막 줄로 "에코 시작점으로 가서 화면 끝까지
// 지우고 한 줄 내려간다" 를 실행하면, 그 뒤에 bash 가 그리는 새 프롬프트가 옛 프롬프트 바로
// 아래 깨끗한 줄에 놓인다 — Enter 를 한 번 친 모양이다. 옛 프롬프트 자체는 지우지 않는다:
// 여러 줄 PS1 이면 첫 줄들이 어디서 시작했는지 모르기 때문이다.
//
// 에코가 pane 아래를 넘어 화면을 밀었으면(프롬프트가 맨 아래 근처) 그만큼 시작점도 올라간다.
// 모르는 값이 하나라도 있으면 빈 문자열 — 지우지 않는 편이 잘못 지우는 것보다 낫다.
func echoEraseSequence(spot paneEchoSpot, typedLen int) string {
	if spot.width <= 0 || spot.height <= 0 || spot.cursorX <= 0 || typedLen <= 0 {
		return ""
	}
	rowsUsed := (spot.cursorX + typedLen + spot.width - 1) / spot.width
	overflow := spot.cursorY + rowsUsed - spot.height
	if overflow < 0 {
		overflow = 0
	}
	row := spot.cursorY - overflow
	if row < 0 {
		row = 0
	}
	// printf 의 \033 은 셸이 해석한다(bash·zsh·dash 공통).
	return fmt.Sprintf(`printf '\033[%d;%dH\033[J\r\n'`, row+1, spot.cursorX+1)
}

// paneInjectViaTmuxBuffer 는 스크립트를 tmux 버퍼에 넣고, pane 에 타이핑할 짧은 명령을 돌려준다.
//
// 실패하면 ok=false 다 — 부르는 쪽은 예전처럼 본문을 직접 타이핑한다(버퍼를 못 만드는
// 상황에서 통합을 잃는 것보다는 흔적이 남는 편이 낫다).
//
// spot 을 알면 스크립트 끝에 자기 에코를 지우는 줄을 붙인다(echoEraseSequence).
func paneInjectViaTmuxBuffer(handle *controlHandle, paneID, script string, spot paneEchoSpot) (string, bool) {
	if handle == nil || handle.client == nil || script == "" || !isPaneID(paneID) {
		return "", false
	}
	name := sshcmd.QuotePosix(paneInjectBufferName(paneID))
	typed := " eval \"$(tmux show-buffer -b " + name + ")\"; tmux delete-buffer -b " + name
	if erase := echoEraseSequence(spot, len(typed)); erase != "" {
		script = strings.TrimRight(script, "\n") + "\n" + erase + "\n"
	}
	// 내용은 stdin 으로 보낸다 — 명령줄에 1200자를 넣으면 그것이 다시 ps·로그에 남는다.
	load := "command -v tmux >/dev/null 2>&1 && tmux load-buffer -b " + name + " -"
	if _, _, err := sshcmd.RunWithInputWithTimeout(
		handle.client, load, []byte(script), paneInjectBufferTimeout,
	); err != nil {
		return "", false
	}
	// 앞 공백: HISTCONTROL=ignorespace 인 셸의 히스토리에 남지 않게. 읽은 뒤 버퍼를 지운다.
	// pane 안의 셸은 TMUX 환경변수로 같은 서버를 가리키므로 여기의 tmux 는 우리 서버다.
	return typed + "\r", true
}

// scriptFromCommands 는 타이핑용 명령들을 eval 할 스크립트로 바꾼다.
//
// init 명령은 **셸에 타이핑하려고** 만들어져서 줄 끝이 CR(=Enter)이다. 그대로 eval 하면
// 마지막 줄이 예를 들어 `... || true\r` 이 되고, 셸은 `true\r` 라는 명령을 찾다가
// "not found" 를 화면에 남긴다 — 통합도 반만 깔린다. 줄 끝은 LF 여야 한다.
func scriptFromCommands(commands []string) string {
	script := strings.Join(commands, "\n")
	script = strings.ReplaceAll(script, "\r\n", "\n")
	script = strings.ReplaceAll(script, "\r", "\n")
	return strings.TrimRight(script, "\n") + "\n"
}

// paneInjectCommands 는 pane 에 실제로 타이핑할 줄들을 정한다.
//
// 두 번째로 중요한 것: 핸드셰이크에 무장할 에코 텍스트는 **타이핑한 것과 같아야** 한다. 예전에
// 이것이 어긋나서(로컬 PowerShell 에 pwsh 를 주입하는데 bash 문자열을 찾았다) 프롬프트가 두 번
// 찍혔다. 그래서 여기서 정한 줄을 그대로 무장에도 쓴다.
func paneInjectCommands(handle *controlHandle, paneID string, commands []string, viaTmuxBuffer bool, spot paneEchoSpot) []string {
	if !viaTmuxBuffer || len(commands) == 0 {
		return commands
	}
	typed, ok := paneInjectViaTmuxBuffer(handle, paneID, scriptFromCommands(commands), spot)
	if !ok {
		return commands
	}
	return []string{typed}
}
