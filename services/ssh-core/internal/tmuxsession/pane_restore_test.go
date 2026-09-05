package tmuxsession

import (
	"strings"
	"testing"

	"dolssh/services/ssh-core/internal/autocomplete"
)

// 빈 값을 "꺼짐" 으로 읽으면 켜져 있던 모드를 우리가 끈다. 구버전 tmux 는 모르는 포맷을
// 빈 문자열로 확장한다(실측: tmux 3.0 의 bracket_paste_flag).
func TestParsePaneFlag(t *testing.T) {
	cases := map[string]paneFlag{
		"1": flagOn, "2": flagOn, "10": flagOn,
		"0": flagOff,
		"":  flagUnknown, " ": flagUnknown, "\t": flagUnknown,
	}
	for value, want := range cases {
		if got := parsePaneFlag(value); got != want {
			t.Errorf("parsePaneFlag(%q) = %v, want %v", value, got, want)
		}
	}
}

func TestDecPrivateModeLeavesUnknownAlone(t *testing.T) {
	if got := decPrivateMode(2004, flagOn); got != "\x1b[?2004h" {
		t.Errorf("on = %q", got)
	}
	if got := decPrivateMode(2004, flagOff); got != "\x1b[?2004l" {
		t.Errorf("off = %q", got)
	}
	// 여기가 핵심이다 — 모르면 아무것도 보내지 않는다.
	if got := decPrivateMode(2004, flagUnknown); got != "" {
		t.Errorf("unknown = %q, 모르는 모드를 건드렸다", got)
	}
}

func stateLine(fields ...string) string { return strings.Join(fields, "\t") }

// tmux 3.0 이 실제로 주는 모양(bracket_paste_flag 는 빈 값).
func fullStateFields() []string {
	return []string{
		"%7", // pane_id
		"1",  // alternate_on
		"10", // cursor_x
		"7",  // cursor_y
		"3",  // alternate_saved_x
		"12", // alternate_saved_y
		"1",  // cursor_flag
		"0",  // keypad_cursor_flag
		"1",  // wrap_flag
		"0",  // insert_flag
		"",   // bracket_paste_flag — tmux 3.0 은 모른다
		"1",  // mouse_standard_flag
		"0",  // mouse_button_flag
		"0",  // mouse_all_flag
		"0",  // mouse_utf8_flag
		"1",  // mouse_sgr_flag
		"0",  // scroll_region_upper
		"23", // scroll_region_lower
		"80", // pane_width
		"24", // pane_height
	}
}

func TestParsePaneRestoreState(t *testing.T) {
	t.Run("tmux 3.0 응답", func(t *testing.T) {
		state, ok := parsePaneRestoreState(stateLine(fullStateFields()...))
		if !ok {
			t.Fatal("읽지 못했다")
		}
		if state.paneID != "%7" || state.alternate != flagOn {
			t.Errorf("pane/대체화면이 어긋났다: %+v", state)
		}
		if state.cursorX != 10 || state.cursorY != 7 || state.savedX != 3 || state.savedY != 12 {
			t.Errorf("커서가 어긋났다: %+v", state)
		}
		if state.bracket != flagUnknown {
			t.Errorf("빈 bracket 을 %v 로 읽었다 — 모르는 것은 unknown 이어야 한다", state.bracket)
		}
		if state.mouseStandard != flagOn || state.mouseSGR != flagOn ||
			state.mouseButton != flagOff || state.mouseAll != flagOff {
			t.Errorf("마우스가 어긋났다: %+v", state)
		}
		if state.width != 80 || state.height != 24 || state.regionBottom != 23 {
			t.Errorf("크기/영역이 어긋났다: %+v", state)
		}
	})

	t.Run("필드가 모자란 줄은 버린다", func(t *testing.T) {
		if _, ok := parsePaneRestoreState("%7\t1\t0"); ok {
			t.Error("모자란 줄을 읽었다")
		}
	})

	t.Run("pane id 모양이 아니면 버린다", func(t *testing.T) {
		fields := fullStateFields()
		fields[0] = "no such session"
		if _, ok := parsePaneRestoreState(stateLine(fields...)); ok {
			t.Error("pane id 가 아닌 줄을 읽었다")
		}
	})

	t.Run("여러 pane", func(t *testing.T) {
		second := fullStateFields()
		second[0] = "%9"
		out := stateLine(fullStateFields()...) + "\n" + stateLine(second...) + "\r\n\n"
		all := parsePaneRestoreStates([]byte(out))
		if len(all) != 2 || all[0].paneID != "%7" || all[1].paneID != "%9" {
			t.Errorf("= %+v", all)
		}
	})
}

func mustState(t *testing.T, mutate func([]string)) paneRestoreState {
	t.Helper()
	fields := fullStateFields()
	if mutate != nil {
		mutate(fields)
	}
	state, ok := parsePaneRestoreState(stateLine(fields...))
	if !ok {
		t.Fatal("픽스처를 읽지 못했다")
	}
	return state
}

// 화면은 **절대 좌표가 아니라 텍스트 스트림**으로 재생해야 한다. 좌표로 그리면 우리 xterm 과
// pane 의 크기가 조금이라도 다를 때 전부 어긋난다(실기기에서 그렇게 실패했다).
func TestBuildPaneRestoreReplaysAsAStream(t *testing.T) {
	state := mustState(t, nil)
	screens := paneRestoreScreens{
		current: []string{"ALT-1", "ALT-2", "ALT-3"},
		saved:   []string{"NORMAL-1", "NORMAL-2"},
	}
	out := string(buildPaneRestore(state, screens))

	// 행마다 커서를 옮기지 않는다. 커서 이동은 맨 끝의 두 번(주 화면 커서, 최종 커서)뿐이다.
	if cups := strings.Count(out, "H"); cups > 6 {
		t.Errorf("커서 이동이 너무 많다(%d) — 좌표로 그리고 있다: %q", cups, out)
	}
	// 줄 사이는 \r\n 이다. \n 만 쓰면 폭을 꽉 채운 줄 뒤에서 한 줄이 더 내려간다.
	if !strings.Contains(out, "ALT-1\x1b[m") && !strings.Contains(out, "ALT-1\r\n") {
		t.Errorf("줄을 \\r\\n 으로 잇지 않았다: %q", out)
	}
	if strings.Contains(out, "ALT-1\n") && !strings.Contains(out, "ALT-1\r\n") {
		t.Errorf("CR 없이 줄바꿈했다: %q", out)
	}
	// 마지막 줄 뒤에 줄바꿈이 없어야 한다(넣으면 화면이 한 줄 밀려 맨 위가 잘린다).
	if strings.Contains(out, "ALT-3\r\n") {
		t.Errorf("마지막 줄 뒤에 줄바꿈을 넣었다: %q", out)
	}
}

func TestBuildPaneRestoreOrder(t *testing.T) {
	state := mustState(t, nil)
	screens := paneRestoreScreens{
		current: []string{"ALT-1"},
		saved:   []string{"NORMAL-1"},
	}
	out := string(buildPaneRestore(state, screens))
	at := func(needle string) int {
		i := strings.Index(out, needle)
		if i < 0 {
			t.Fatalf("%q 가 없다: %q", needle, out)
		}
		return i
	}
	// 주 화면이 먼저다 — 앱을 빠져나오면(?1049l) 나오는 화면이 그것이다. 빼면 htop 을 끄는
	// 순간 빈 화면이 된다.
	if at("NORMAL-1") > at("\x1b[?1049h") {
		t.Error("주 화면을 대체화면 전환 뒤에 그렸다")
	}
	if at("\x1b[?1049h") > at("ALT-1") {
		t.Error("대체화면 내용을 전환보다 먼저 그렸다")
	}
	// DECSTBM 은 커서를 home 으로 옮기므로 커서 복원보다 앞이어야 한다. 여기서는 화면 전체가
	// 영역(0..23, 높이 24)이라 세우지 않는다.
	if strings.Contains(out, ";24r") {
		t.Error("화면 전체인데 스크롤 영역을 세웠다")
	}
	// 커서가 맨 끝이다.
	if !strings.HasSuffix(out, "\x1b[8;11H") {
		t.Errorf("커서 복원이 맨 끝이 아니다: %q", out[len(out)-20:])
	}
}

func TestBuildPaneRestoreNonAlternate(t *testing.T) {
	state := mustState(t, func(f []string) {
		f[1] = "0"  // alternate_on
		f[11] = "0" // mouse_standard_flag
		f[15] = "0" // mouse_sgr_flag
	})
	out := string(buildPaneRestore(state, paneRestoreScreens{current: []string{"PROMPT$"}}))
	if strings.Contains(out, "\x1b[?1049h") {
		t.Errorf("대체화면이 아닌데 전환했다: %q", out)
	}
	// 주 화면으로 되돌린다 — 자동 재연결은 xterm 을 그대로 쓰므로(같은 stableId) 이전
	// 세션이 대체화면에 두고 갔을 수 있다.
	if !strings.HasPrefix(out, "\x1b[?1049l") {
		t.Errorf("주 화면 복귀가 맨 앞이 아니다: %q", out)
	}
	if !strings.Contains(out, "PROMPT$") {
		t.Errorf("화면을 그리지 않았다: %q", out)
	}
	if !strings.Contains(out, "\x1b[?1000l") {
		t.Errorf("꺼진 마우스 모드를 명시하지 않았다: %q", out)
	}
}

// 터미널에서 마우스 추적(1000/1002/1003)은 한 자리다 — 어느 것이든 끄면 자리가 통째로 꺼진다.
// tmux 의 비트를 그대로 옮겨 `?1000h ?1002l` 로 보내면 결과는 꺼짐이다(실기기에서 htop 클릭이
// 죽어 있던 원인). 활성인 것 하나만 켜고, 다른 것의 `l` 은 보내지 않는다.
func TestMouseModeSequenceIsASingleSlot(t *testing.T) {
	cases := []struct {
		name  string
		state paneRestoreState
		want  string
	}{
		{"htop: standard+sgr", paneRestoreState{mouseStandard: flagOn, mouseButton: flagOff, mouseAll: flagOff, mouseSGR: flagOn, mouseUTF8: flagOff}, "\x1b[?1000h\x1b[?1006h"},
		{"vim: button+sgr", paneRestoreState{mouseStandard: flagOff, mouseButton: flagOn, mouseAll: flagOff, mouseSGR: flagOn, mouseUTF8: flagOff}, "\x1b[?1002h\x1b[?1006h"},
		{"any 이 가장 세다", paneRestoreState{mouseStandard: flagOn, mouseButton: flagOn, mouseAll: flagOn, mouseSGR: flagOff, mouseUTF8: flagOff}, "\x1b[?1003h\x1b[?1006l"},
		{"utf8 인코딩", paneRestoreState{mouseStandard: flagOn, mouseButton: flagOff, mouseAll: flagOff, mouseSGR: flagOff, mouseUTF8: flagOn}, "\x1b[?1000h\x1b[?1005h"},
		{"셸: 전부 꺼짐 → 한 번만 끈다", paneRestoreState{mouseStandard: flagOff, mouseButton: flagOff, mouseAll: flagOff, mouseSGR: flagOff, mouseUTF8: flagOff}, "\x1b[?1000l\x1b[?1006l"},
		{"모르면 건드리지 않는다", paneRestoreState{}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := mouseModeSequence(tc.state); got != tc.want {
				t.Errorf("= %q, want %q", got, tc.want)
			}
		})
	}
}

func TestBuildPaneRestoreScrollRegion(t *testing.T) {
	cases := []struct {
		name             string
		upper, lower     string
		wantTop, wantBot int
		wantSet          bool
	}{
		{"화면 전체", "0", "23", 0, 0, false},
		{"위를 남긴 영역", "1", "23", 2, 24, true},
		{"아래를 남긴 영역", "0", "20", 1, 21, true},
		{"영역이 뒤집힘", "10", "3", 0, 0, false},
		{"한 줄 영역", "5", "5", 0, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			state := mustState(t, func(f []string) { f[16], f[17] = tc.upper, tc.lower })
			top, bottom, ok := paneScrollRegion(state)
			if ok != tc.wantSet || top != tc.wantTop || bottom != tc.wantBot {
				t.Errorf("= (%d,%d,%v), want (%d,%d,%v)",
					top, bottom, ok, tc.wantTop, tc.wantBot, tc.wantSet)
			}
		})
	}
}

// init 명령은 셸에 **타이핑하려고** 만들어져서 줄 끝이 CR 이다. 그대로 파일에 쓰면 마지막
// 문장이 `true\r` 이 되어 셸이 그런 명령을 찾다가 "not found" 를 화면에 남긴다(실측).
func TestScriptFromCommandsUsesLineFeeds(t *testing.T) {
	script := scriptFromCommands([]string{"first || true\r", "second\r"})
	if strings.Contains(script, "\r") {
		t.Errorf("CR 이 남았다: %q", script)
	}
	if !strings.HasSuffix(script, "true\nsecond\n") {
		t.Errorf("= %q", script)
	}
	if strings.Contains(script, "\n\n") {
		t.Errorf("빈 줄이 생겼다: %q", script)
	}
}

// tmux 버퍼를 못 만드는 상황에서는 예전처럼 본문을 직접 타이핑한다 — 흔적이 남는 것이
// 통합을 잃는 것보다 낫다.
func TestPaneInjectFallsBackToTyping(t *testing.T) {
	commands := []string{"init line\r"}
	// client 가 nil 이면 버퍼를 만들 수 없다.
	got := paneInjectCommands(&controlHandle{}, "%0", commands, true, paneEchoSpot{})
	if len(got) != 1 || got[0] != commands[0] {
		t.Errorf("= %q, want 원래 명령 그대로", got)
	}
	// viaTmuxBuffer=false 는 재주입 경로다(서브셸이 다른 호스트일 수 있다).
	got = paneInjectCommands(&controlHandle{}, "%0", commands, false, paneEchoSpot{})
	if len(got) != 1 || got[0] != commands[0] {
		t.Errorf("= %q", got)
	}
}

// 재생 중에는 줄바꿈이 꺼져 있어야 한다. 우리 xterm 이 tmux 의 pane 보다 한 칸만 좁아도,
// 켜져 있으면 폭을 넘는 줄이 두 줄을 먹어 화면 위가 잘린다(실기기에서 그렇게 깨졌다).
func TestBuildPaneRestoreDisablesWrapWhileReplaying(t *testing.T) {
	state := mustState(t, nil) // wrap_flag=1
	out := string(buildPaneRestore(state, paneRestoreScreens{current: []string{"X"}, saved: []string{"Y"}}))
	off := strings.Index(out, "\x1b[?7l")
	first := strings.Index(out, "Y")
	on := strings.LastIndex(out, "\x1b[?7h")
	if off < 0 || first < 0 || off > first {
		t.Fatalf("그리기 전에 줄바꿈을 끄지 않았다: %q", out)
	}
	if on < 0 || on < strings.LastIndex(out, "X") {
		t.Errorf("그린 뒤에 pane 의 줄바꿈 값으로 되돌리지 않았다: %q", out)
	}
}

// pane 높이를 넘는 줄은 버린다 — 넘겨 쓰면 화면이 밀려 맨 위가 잘린다.
func TestBuildPaneRestoreClampsToPaneHeight(t *testing.T) {
	// height=3 인 pane.
	state := mustState(t, func(f []string) { f[1] = "0"; f[19] = "3" })
	lines := []string{"r1", "r2", "r3", "r4", "r5"}
	out := string(buildPaneRestore(state, paneRestoreScreens{current: lines}))
	if !strings.Contains(out, "r3") || strings.Contains(out, "r4") {
		t.Errorf("3행에 맞춰 자르지 않았다: %q", out)
	}
	// 높이를 모르면(0) 그대로 둔다.
	if got := clampScreenLines(lines, 0); len(got) != 5 {
		t.Errorf("모르는 높이에서 잘랐다: %v", got)
	}
}

// 타이핑한 줄의 에코를 스크립트가 스스로 지우는 좌표. 에코는 프롬프트 끝(cursorX)에서 시작해
// 폭에 맞춰 감기고, 화면 아래를 넘으면 그만큼 전체가 밀려 올라간다.
func TestEchoEraseSequence(t *testing.T) {
	cases := []struct {
		name  string
		spot  paneEchoSpot
		typed int
		want  string
	}{
		// 프롬프트 17칸 + 100자 = 117 → 101칸에서 2행. 5행에서 시작, 넘치지 않음.
		{"보통", paneEchoSpot{cursorX: 17, cursorY: 5, width: 101, height: 52}, 100, `printf '\033[6;18H\033[J\r\n'`},
		// 맨 아래(51행, 0-based)에서 2행짜리 에코 → 1행 밀림 → 시작점이 50행으로 올라간다.
		{"아래서 밀림", paneEchoSpot{cursorX: 17, cursorY: 51, width: 101, height: 52}, 100, `printf '\033[51;18H\033[J\r\n'`},
		// 딱 맞게 끝나는 경우: 17+84=101 → 1행.
		{"한 행에 딱", paneEchoSpot{cursorX: 17, cursorY: 0, width: 101, height: 52}, 84, `printf '\033[1;18H\033[J\r\n'`},
		// 모르는 값이 하나라도 있으면 지우지 않는다 — 잘못 지우는 것이 남는 것보다 나쁘다.
		{"폭 모름", paneEchoSpot{cursorX: 17, cursorY: 5, height: 52}, 100, ""},
		{"프롬프트 안 그려짐", paneEchoSpot{cursorX: 0, cursorY: 5, width: 101, height: 52}, 100, ""},
		{"길이 0", paneEchoSpot{cursorX: 17, cursorY: 5, width: 101, height: 52}, 0, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := echoEraseSequence(tc.spot, tc.typed); got != tc.want {
				t.Errorf("= %q, want %q", got, tc.want)
			}
		})
	}
}

// 표식은 "타이핑했다" 가 아니라 "그 pane 에서 133;A 가 왔다" 로 남긴다. 에코 숨김의 1.5초 flush 와
// 무관해야 한다 — 느린 호스트에서 마커가 flush 뒤에 와도 설치는 설치다(아니면 재연결마다 다시 심는
// 진짜 무한 반복이 된다).
func TestInstallPendingConfirmsOnPromptMarker(t *testing.T) {
	h := &controlHandle{}
	marker := []byte("junk" + autocomplete.PromptStartMarker + "ubuntu@box:~$ ")
	if h.takeInstallPending("%0", marker) {
		t.Fatal("타이핑한 적 없는 pane 의 마커를 설치 확인으로 봤다")
	}
	h.setInstallPending("%0")
	if h.takeInstallPending("%0", []byte("echo hi\r\n")) {
		t.Fatal("마커 없는 출력을 설치 확인으로 봤다")
	}
	if h.takeInstallPending("%1", marker) {
		t.Fatal("다른 pane 의 마커로 확인했다")
	}
	if !h.takeInstallPending("%0", marker) {
		t.Fatal("대기 중 pane 에 마커가 왔는데 확인하지 않았다")
	}
	if h.takeInstallPending("%0", marker) {
		t.Fatal("한 번 확인한 뒤 또 확인했다(표식을 두 번 남기게 된다)")
	}
}
