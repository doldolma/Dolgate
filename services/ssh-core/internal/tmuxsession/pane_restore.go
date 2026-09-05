package tmuxsession

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"dolssh/services/ssh-core/internal/sshcmd"
)

// 이 파일은 "재연결하면 htop·vim pane 을 못 쓴다" 를 고친다.
//
// **근본 원인**(실측): control mode 는 attach 후 새 출력만 준다 — 재연결 직후 pane 스트림이
// 0바이트다. tmux 는 화면 셀만 들고 있고 그것을 재생해 주지 않으며, 앱이 기동할 때 한 번 보낸
// 터미널 모드(`?1049h`·`?1000h`·`?1h`)도 그때 tmux 가 소비했다. 그래서 control mode 클라이언트는
// **예외 없이 자기가 화면을 복원해야 한다** — 이 저장소는 그 조각을 만들지 않았다
// (integration_test.go 에 "초기 화면은 capture-pane 후속 과제" 로 남아 있었다).
//
// **방식은 iTerm2 와 같다**(control mode 는 원래 iTerm2 를 위해 만들어졌고, 그 구현이
// sources/tmux/TmuxWindowOpener.m + TmuxStateParser.m 에 있다):
//
//   - 화면은 `capture-pane -p -e -J` 로 떠서 **텍스트 스트림으로 재생**한다. 절대 좌표
//     (`\x1b[<row>;1H`)로 그리지 않는다 — 그러면 우리 xterm 과 pane 의 크기가 조금이라도
//     다를 때 전부 어긋난다(실제로 그렇게 실패했다). 줄을 `\r\n` 으로 이어 쓰면 터미널이
//     자기 폭으로 자연스럽게 감싸고 스크롤한다.
//   - 격자가 **둘**이다. `-a` 없이 뜨면 **현재** 격자(앱이 그린 대체화면), `-a` 를 주면
//     **저장된** 격자(앱에 들어가기 전 주 화면)다. 둘 다 복원해야 앱을 빠져나올 때 원래
//     화면이 나온다. 하나만 하면 htop 을 끄는 순간 빈 화면이 된다.
//   - 모드는 `list-panes -F` 로 읽어 DECSET 을 합성한다. 앱은 다시 그릴 때 이것을 재전송하지
//     않는다(기동 시 한 번만 보낸다).
//
// 크기는 **맞춰 놓고** 복원한다(restoreOnFirstResize 주석 참고).

const paneRestoreTimeout = 10 * time.Second

// paneRestoreStateFormat 은 iTerm2 의 TmuxStateParser 가 쓰는 것과 같은 집합이다(+크기).
// 필드 순서는 parsePaneRestoreState 의 인덱스와 맞물린다 — 바꾸려면 양쪽을 같이 바꿔야 한다.
const paneRestoreStateFormat = "#{pane_id}\t#{alternate_on}\t#{cursor_x}\t#{cursor_y}\t" +
	"#{alternate_saved_x}\t#{alternate_saved_y}\t" +
	"#{cursor_flag}\t#{keypad_cursor_flag}\t#{wrap_flag}\t#{insert_flag}\t" +
	"#{bracket_paste_flag}\t" +
	"#{mouse_standard_flag}\t#{mouse_button_flag}\t#{mouse_all_flag}\t" +
	"#{mouse_utf8_flag}\t#{mouse_sgr_flag}\t" +
	"#{scroll_region_upper}\t#{scroll_region_lower}\t#{pane_width}\t#{pane_height}"

const paneRestoreStateFieldCount = 20

// paneFlag 는 tmux 가 알려준 모드 값이다. **세 상태**인 것이 중요하다.
//
// 빈 값을 "꺼짐" 으로 보면 안 된다. 구버전 tmux 는 모르는 포맷을 빈 문자열로 확장하는데
// (실측: tmux 3.0 의 `bracket_paste_flag`), 그것을 꺼짐으로 읽으면 우리가 `?2004l` 을 보내
// **켜져 있던 모드를 끈다**. 모르면 건드리지 않는다.
type paneFlag uint8

const (
	flagUnknown paneFlag = iota
	flagOff
	flagOn
)

// String 은 진단 로그에 숫자가 아니라 뜻이 찍히게 한다.
func (f paneFlag) String() string {
	switch f {
	case flagOn:
		return "on"
	case flagOff:
		return "off"
	default:
		return "unknown"
	}
}

func parsePaneFlag(value string) paneFlag {
	switch trimmed := strings.TrimSpace(value); {
	case trimmed == "":
		return flagUnknown
	case trimmed == "0":
		return flagOff
	default:
		// pane_in_mode 처럼 개수를 돌려주는 포맷도 있으므로 "1" 만 보지 않는다.
		return flagOn
	}
}

// paneRestoreState 는 한 pane 의 커서·모드·크기다.
//
// origin 모드(DECOM)는 일부러 담지 않는다. 켜면 커서가 스크롤 영역의 home 으로 옮겨져서
// 복원한 커서 자리를 덮는다 — 쓰는 프로그램이 거의 없는 모드를 위해 커서를 잘못 두는 것은
// 남는 장사가 아니다. iTerm2 도 담지 않는다.
type paneRestoreState struct {
	paneID    string
	alternate paneFlag
	cursorX   int
	cursorY   int
	// 대체화면일 때 주 화면의 커서 자리. 주 화면 복원 뒤 여기에 커서를 둔다.
	savedX int
	savedY int

	cursorShown paneFlag // ?25
	appCursor   paneFlag // ?1  DECCKM — 없으면 방향키가 엉킨다
	wrap        paneFlag // ?7
	insert      paneFlag // CSI 4 h  IRM
	bracket     paneFlag // ?2004 — tmux 3.0 은 모른다(빈 값)

	mouseStandard paneFlag // ?1000
	mouseButton   paneFlag // ?1002
	mouseAll      paneFlag // ?1003
	mouseUTF8     paneFlag // ?1005
	mouseSGR      paneFlag // ?1006

	regionTop    int
	regionBottom int
	width        int
	height       int
}

// paneRestoreScreens 는 한 pane 의 두 격자다.
type paneRestoreScreens struct {
	// current 는 지금 보이는 격자다(대체화면 앱이 있으면 그 화면).
	current []string
	// saved 는 대체화면에 들어가기 전의 주 화면이다. alternate 가 아니면 비어 있다.
	saved []string
}

// queryPaneRestoreStates 는 이 tmux 세션의 모든 pane 상태를 한 번의 왕복으로 읽는다.
//
// control 채널이 아니라 보조 exec 채널로 묻는다. control mode 의 명령 응답(%begin~%end 사이)은
// 이스케이프되지 않은 원문이라, 캡처한 화면에 '%' 로 시작하는 줄이 하나라도 있으면 파서가
// 그것을 notification 으로 먹는다 — 화면 내용은 임의의 바이트라서 실제로 있을 수 있다.
func queryPaneRestoreStates(handle *controlHandle, sessionName string) []paneRestoreState {
	if handle == nil || handle.client == nil {
		return nil
	}
	target := "-a"
	if sessionName != "" {
		target = "-s -t " + sshcmd.QuotePosix(sessionName)
	}
	command := "command -v tmux >/dev/null 2>&1 && tmux list-panes " + target +
		" -F " + sshcmd.QuotePosix(paneRestoreStateFormat)
	stdout, _, err := sshcmd.RunWithTimeout(handle.client, command, paneRestoreTimeout)
	if err != nil {
		return nil
	}
	return parsePaneRestoreStates(stdout)
}

func parsePaneRestoreStates(stdout []byte) []paneRestoreState {
	var all []paneRestoreState
	for _, line := range strings.Split(string(stdout), "\n") {
		if state, ok := parsePaneRestoreState(strings.TrimRight(line, "\r")); ok {
			all = append(all, state)
		}
	}
	return all
}

func parsePaneRestoreState(line string) (paneRestoreState, bool) {
	if line == "" {
		return paneRestoreState{}, false
	}
	f := strings.Split(line, "\t")
	if len(f) < paneRestoreStateFieldCount {
		return paneRestoreState{}, false
	}
	paneID := strings.TrimSpace(f[0])
	if !isPaneID(paneID) {
		return paneRestoreState{}, false
	}
	return paneRestoreState{
		paneID:        paneID,
		alternate:     parsePaneFlag(f[1]),
		cursorX:       paneFlagInt(f[2]),
		cursorY:       paneFlagInt(f[3]),
		savedX:        paneFlagInt(f[4]),
		savedY:        paneFlagInt(f[5]),
		cursorShown:   parsePaneFlag(f[6]),
		appCursor:     parsePaneFlag(f[7]),
		wrap:          parsePaneFlag(f[8]),
		insert:        parsePaneFlag(f[9]),
		bracket:       parsePaneFlag(f[10]),
		mouseStandard: parsePaneFlag(f[11]),
		mouseButton:   parsePaneFlag(f[12]),
		mouseAll:      parsePaneFlag(f[13]),
		mouseUTF8:     parsePaneFlag(f[14]),
		mouseSGR:      parsePaneFlag(f[15]),
		regionTop:     paneFlagInt(f[16]),
		regionBottom:  paneFlagInt(f[17]),
		width:         paneFlagInt(f[18]),
		height:        paneFlagInt(f[19]),
	}, true
}

// paneFlagInt 는 숫자 포맷 값을 읽는다(빈 값·해석 불가·음수는 0).
func paneFlagInt(value string) int {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// queryPaneScreens 는 pane 의 화면을 뜬다.
//
// **`-J` 를 쓰지 않는다.** iTerm2 는 쓰지만 그쪽은 히스토리(논리 줄)를 되살려 자기 폭으로
// 다시 감싸는 목적이고, 우리는 **보이는 화면 한 판**을 되돌린다. `-J` 는 감긴 줄을 잇는 동시에
// 줄 끝 공백을 보존해서 모든 줄을 pane 폭에 꽉 채우는데, 우리 xterm 이 1칸만 좁아도 그 줄이
// 전부 감겨 52줄이 104줄이 되고 위쪽 절반이 스크롤로 사라진다(실기기에서 그렇게 깨졌다).
// 빼면 줄마다 끝 공백이 잘려 나가 그런 일이 없다.
//
// `-N`(끝 공백 보존)은 3.1 에서 추가된 것이라 3.0 에 보내면 **명령 전체가 실패한다**(실측:
// "unknown option -- N"). 모르는 포맷은 빈 문자열이 되지만 모르는 옵션은 에러다.
//
// 히스토리(`-S`)는 뜨지 않는다. 자동 재연결은 xterm 을 그대로 쓰므로(같은 stableId) 다시
// 흘려 넣으면 스크롤백이 겹친다. 보이는 화면만 되돌린다.
func queryPaneScreens(handle *controlHandle, state paneRestoreState) paneRestoreScreens {
	if handle == nil || handle.client == nil || !isPaneID(state.paneID) {
		return paneRestoreScreens{}
	}
	target := sshcmd.QuotePosix(state.paneID)
	base := "tmux capture-pane -p -e -t " + target
	var screens paneRestoreScreens
	if lines, ok := runCapture(handle, base); ok {
		screens.current = lines
	}
	if state.alternate == flagOn {
		if lines, ok := runCapture(handle, base+" -a"); ok {
			screens.saved = lines
		}
	}
	return screens
}

func runCapture(handle *controlHandle, command string) ([]string, bool) {
	stdout, _, err := sshcmd.RunWithTimeout(handle.client, command, paneRestoreTimeout)
	if err != nil {
		return nil, false
	}
	text := strings.TrimSuffix(string(stdout), "\n")
	if text == "" {
		return nil, true
	}
	return strings.Split(text, "\n"), true
}

// buildPaneRestore 는 pane 의 상태를 터미널이 알아듣는 바이트로 만든다.
//
// 순서에 이유가 있다.
//
//  1. **주 화면 먼저.** 대체화면 앱이 떠 있어도 그 아래 주 화면을 먼저 채운다 — 앱을 빠져나올
//     때(`?1049l`) 나오는 화면이 그것이다. 이걸 빼면 htop 을 끄는 순간 빈 화면이 된다.
//  2. **`?1049h` 뒤에 대체화면.** 순서가 뒤집히면 앱의 화면이 주 화면을 덮어 스크롤백을 잃는다.
//  3. **스크롤 영역은 그린 뒤, 커서 앞.** DECSTBM 은 커서를 home 으로 옮긴다.
//  4. **커서가 맨 끝.** 뒤에 무엇을 더 쓰면 커서가 움직인다.
func buildPaneRestore(state paneRestoreState, screens paneRestoreScreens) []byte {
	var out strings.Builder
	alternate := state.alternate == flagOn

	// 주 화면. 대체화면일 때는 saved 격자가 그것이고, 아니면 current 가 그것이다.
	primary := screens.current
	if alternate {
		primary = screens.saved
	}
	// **재생하는 동안 줄바꿈을 끈다(`?7l`).** 우리 xterm 과 tmux 의 pane 폭은 서로 다른 계산에서
	// 나오므로 한두 칸 어긋날 수 있다. 줄바꿈이 켜져 있으면 폭을 넘는 줄이 두 줄을 먹고, 그만큼
	// 화면이 밀려 **맨 위가 잘린다**. 꺼 두면 넘치는 부분이 잘릴 뿐 줄 수가 늘지 않는다.
	// 진짜 줄바꿈 모드는 맨 끝에서 pane 의 값으로 되돌린다.
	out.WriteString("\x1b[?1049l\x1b[m\x1b[?7l\x1b[H\x1b[2J")
	writeScreenLines(&out, clampScreenLines(primary, state.height))
	if alternate {
		// 주 화면의 커서 자리를 세워 둔다 — 앱을 빠져나오면 여기로 돌아간다.
		fmt.Fprintf(&out, "\x1b[%d;%dH", state.savedY+1, state.savedX+1)
		out.WriteString("\x1b[?1049h\x1b[m\x1b[H\x1b[2J")
		writeScreenLines(&out, clampScreenLines(screens.current, state.height))
	}
	out.WriteString("\x1b[m")

	if top, bottom, ok := paneScrollRegion(state); ok {
		fmt.Fprintf(&out, "\x1b[%d;%dr", top, bottom)
	}
	out.WriteString(decPrivateMode(7, state.wrap))
	out.WriteString(decPrivateMode(1, state.appCursor))
	out.WriteString(decPrivateMode(25, state.cursorShown))
	out.WriteString(decPrivateMode(2004, state.bracket))
	out.WriteString(mouseModeSequence(state))
	switch state.insert {
	case flagOn:
		out.WriteString("\x1b[4h")
	case flagOff:
		out.WriteString("\x1b[4l")
	}
	fmt.Fprintf(&out, "\x1b[%d;%dH", state.cursorY+1, state.cursorX+1)
	return []byte(out.String())
}

// clampScreenLines 는 pane 높이를 넘는 줄을 버린다.
//
// capture-pane 은 대개 딱 pane 높이만큼 주지만, 안전장치다 — 높이를 넘겨 쓰면 그만큼 화면이
// 스크롤되어 맨 위가 잘린다. 렌더러는 이 pane 의 xterm 을 tmux 레이아웃 칸 수(=pane 높이)로
// 고정하므로 그 값에 맞춘다.
func clampScreenLines(lines []string, rows int) []string {
	if rows <= 0 || len(lines) <= rows {
		return lines
	}
	return lines[:rows]
}

// writeScreenLines 는 화면 줄들을 스트림으로 쓴다.
//
// 줄 사이는 `\r\n` 이다. `\n` 만 쓰면 폭을 꽉 채운 줄 뒤에서 감싸기 대기 상태가 남아 한 줄이
// 더 내려간다 — `\r` 이 그 상태를 지운다. **마지막 줄 뒤에는 줄바꿈을 넣지 않는다**(넣으면
// 화면이 한 줄 밀려 맨 위가 잘린다).
//
// 줄 앞마다 속성을 초기화한다. capture-pane -e 는 줄 안의 속성 변화만 담으므로, 색이 켜진 채
// 끝난 줄의 다음 줄로 그 색이 번진다.
func writeScreenLines(out *strings.Builder, lines []string) {
	for index, line := range lines {
		if index > 0 {
			out.WriteString("\r\n")
		}
		out.WriteString("\x1b[m")
		out.WriteString(line)
	}
}

// paneScrollRegion 은 DECSTBM 으로 세울 1-based 영역을 돌려준다. 화면 전체(=기본값)면
// 세우지 않는다 — 높이를 모를 때 잘못된 영역을 박는 것을 피한다.
func paneScrollRegion(state paneRestoreState) (int, int, bool) {
	if state.regionBottom <= state.regionTop {
		return 0, 0, false
	}
	full := state.regionTop == 0 && (state.height <= 0 || state.regionBottom >= state.height-1)
	if full {
		return 0, 0, false
	}
	return state.regionTop + 1, state.regionBottom + 1, true
}

// mouseModeSequence 는 마우스 보고 모드를 되돌린다.
//
// tmux 는 1000/1002/1003 을 **각각의 비트**로 들고 있지만, 터미널(xterm.js 도, 진짜 xterm 도)
// 에서는 **한 자리**다 — 셋 중 하나만 활성이고, 그중 어느 것이든 끄면(`?1002l`) 그 자리가
// 통째로 꺼진다. 그래서 tmux 의 비트를 그대로 옮겨 `?1000h ?1002l ?1003l` 로 보내면 결과는
// **마우스 꺼짐**이다 — 바이트는 나갔는데 htop 클릭이 죽어 있던 이유가 이것이다(헤드리스
// xterm 이 mouseTrackingMode=none 으로 잡아냈다). 인코딩(1005 UTF-8 / 1006 SGR)도 같은 한
// 자리다. 그러니 활성인 것 하나만 켜고, 없을 때만 한 번 끈다.
func mouseModeSequence(state paneRestoreState) string {
	var out strings.Builder
	switch {
	case state.mouseAll == flagOn:
		out.WriteString("\x1b[?1003h")
	case state.mouseButton == flagOn:
		out.WriteString("\x1b[?1002h")
	case state.mouseStandard == flagOn:
		out.WriteString("\x1b[?1000h")
	case state.mouseStandard == flagOff || state.mouseButton == flagOff || state.mouseAll == flagOff:
		// 무엇인가는 답했고 전부 꺼짐이다. 자동 재연결은 xterm 을 그대로 쓰므로(같은 stableId)
		// 이전 세션이 켜 둔 것을 확실히 끈다. 하나만 보내도 자리가 통째로 꺼진다.
		out.WriteString("\x1b[?1000l")
	}
	switch {
	case state.mouseSGR == flagOn:
		out.WriteString("\x1b[?1006h")
	case state.mouseUTF8 == flagOn:
		out.WriteString("\x1b[?1005h")
	case state.mouseSGR == flagOff || state.mouseUTF8 == flagOff:
		out.WriteString("\x1b[?1006l")
	}
	return out.String()
}

// decPrivateMode 는 DECSET/DECRST 한 개를 만든다. 모르는 모드는 건드리지 않는다.
func decPrivateMode(mode int, flag paneFlag) string {
	switch flag {
	case flagOn:
		return fmt.Sprintf("\x1b[?%dh", mode)
	case flagOff:
		return fmt.Sprintf("\x1b[?%dl", mode)
	default:
		return ""
	}
}
