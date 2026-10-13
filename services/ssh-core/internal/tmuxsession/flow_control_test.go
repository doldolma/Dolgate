package tmuxsession

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"dolssh/services/ssh-core/pkg/coretypes"
)

func flowTestManager(recorder *paneStreamRecorder, version tmuxVersion) (*Manager, *controlHandle, *paneStdinRecorder) {
	m := NewManager(func(coretypes.Event) {}, recorder.emit)
	stdin := &paneStdinRecorder{}
	handle := &controlHandle{id: "ctl", stdin: stdin, closed: make(chan struct{}), version: version}
	m.mu.Lock()
	m.controls["ctl"] = handle
	m.mu.Unlock()
	return m, handle, stdin
}

var tmux34 = tmuxVersion{major: 3, minor: 4, known: true}

// 창별 멈춤(refresh-client -A)은 tmux 3.2 에 들어왔다. 버전을 모르면 쓰지 않는다 — 같은 -A 의 `off` 가
// tmux 3.6b 서버를 죽였듯, 모르는 tmux 에 무엇을 보낼지 장담할 수 없다.
func TestPaneFlowControlsNeedAKnownTmux32(t *testing.T) {
	cases := []struct {
		name    string
		version tmuxVersion
		session string
		want    bool
	}{
		{"3.2", tmuxVersion{major: 3, minor: 2, known: true}, "tmux:ctl:7", true},
		{"3.1", tmuxVersion{major: 3, minor: 1, known: true}, "tmux:ctl:7", false},
		{"unknown", tmuxVersion{}, "tmux:ctl:7", false},
		{"control session itself", tmux34, "ctl", false},
		{"not a pane", tmux34, "tmux:ctl:x", false},
		{"unknown control", tmux34, "tmux:other:7", false},
	}
	for _, tc := range cases {
		m, _, _ := flowTestManager(&paneStreamRecorder{}, tc.version)
		if _, _, ok := m.PaneFlowControls(tc.session); ok != tc.want {
			t.Errorf("%s: ok = %v, want %v", tc.name, ok, tc.want)
		}
	}
}

// 모든 창이 제어 채널 하나로 와서 읽기를 멈출 수 없다. 그 창만 멈추고 다시 보내게 한다.
func TestPaneFlowControlsPauseAndContinueOnlyThatPane(t *testing.T) {
	m, _, stdin := flowTestManager(&paneStreamRecorder{}, tmux34)
	pause, resume, ok := m.PaneFlowControls("tmux:ctl:7")
	if !ok {
		t.Fatal("PaneFlowControls must be available on tmux 3.4")
	}
	pause()
	if got := stdin.snapshot(); got != "refresh-client -A '%7:pause'\n" {
		t.Fatalf("pause wrote %q", got)
	}
	resume()
	if got := stdin.snapshot(); !strings.HasSuffix(got, "refresh-client -A '%7:continue'\n") {
		t.Fatalf("resume wrote %q", got)
	}
}

func waitForPaneStream(t *testing.T, recorder *paneStreamRecorder, sessionID string) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if got := recorder.read(sessionID); got != "" {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s: 다시 그린 화면이 오지 않았다", sessionID)
	return ""
}

// 멈춘 동안에도 프로그램은 돌고 그 출력은 오지 않는다. 재개한 뒤 잠잠해지면 지금 화면을 다시 그려야 한다 —
// 그러지 않으면 Ctrl+C 뒤의 프롬프트처럼 멈춘 동안 나온 마지막 화면이 끝내 안 보인다.
func TestContinueAfterOurPauseRedrawsThePaneOnceQuiet(t *testing.T) {
	recorder := &paneStreamRecorder{}
	m, handle, _ := flowTestManager(recorder, tmux34)
	m.redrawQuiet = 20 * time.Millisecond
	m.paneRestoreStates = func(*controlHandle) []paneRestoreState {
		return []paneRestoreState{
			{paneID: "%7", alternate: flagOff, cursorX: 2, cursorY: 0, width: 80, height: 2},
			{paneID: "%8", alternate: flagOff, width: 80, height: 2},
		}
	}
	m.paneScreens = func(_ *controlHandle, state paneRestoreState) paneRestoreScreens {
		return paneRestoreScreens{current: []string{"$ " + state.paneID, ""}}
	}
	pause, _, _ := m.PaneFlowControls("tmux:ctl:7")
	pause()

	m.handleControlEvent(handle, ControlEvent{Kind: ControlContinue, PaneID: "%7"})
	got := waitForPaneStream(t, recorder, "tmux:ctl:7")
	if !strings.HasPrefix(got, "\x1b[?1049l") || !strings.Contains(got, "$ %7") {
		t.Fatalf("다시 그린 화면 = %q", got)
	}

	// 우리가 멈추지 않은 창의 재개(다른 클라이언트·pause-after)는 건드리지 않는다.
	m.handleControlEvent(handle, ControlEvent{Kind: ControlContinue, PaneID: "%8"})
	time.Sleep(80 * time.Millisecond)
	if got := recorder.read("tmux:ctl:8"); got != "" {
		t.Fatalf("멈추지 않은 창을 다시 그렸다: %q", got)
	}
}

func countPaneDraws(m *Manager) *atomic.Int32 {
	var draws atomic.Int32
	m.paneRestoreStates = func(*controlHandle) []paneRestoreState {
		return []paneRestoreState{{paneID: "%7", alternate: flagOff, width: 80, height: 1}}
	}
	m.paneScreens = func(*controlHandle, paneRestoreState) paneRestoreScreens {
		draws.Add(1)
		return paneRestoreScreens{current: []string{"$"}}
	}
	return &draws
}

func paneOutput(paneID string) ControlEvent {
	return ControlEvent{Kind: ControlOutput, PaneID: paneID, Data: []byte("y\r\n")}
}

func waitForDraws(t *testing.T, draws *atomic.Int32, want int32) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for draws.Load() < want && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	// 더 그리지 않는지도 본다.
	time.Sleep(150 * time.Millisecond)
	if got := draws.Load(); got != want {
		t.Fatalf("%d번 그렸다, %d번이어야 한다", got, want)
	}
}

// 쏟아지는 동안에는 1초에도 수십 번 멈췄다 풀린다. 그때마다 그리면 원격에 exec 를 그만큼 열고, 떠 온 화면이
// 그 사이 온 출력과 엇갈린다. 출력이 멎을 때까지 기다렸다가 한 번 그린다.
func TestRedrawWaitsWhileThePaneKeepsPrinting(t *testing.T) {
	m, handle, _ := flowTestManager(&paneStreamRecorder{}, tmux34)
	draws := countPaneDraws(m)
	pause, _, _ := m.PaneFlowControls("tmux:ctl:7")
	for i := 0; i < 40; i++ {
		if i%5 == 0 {
			pause()
			m.handleControlEvent(handle, ControlEvent{Kind: ControlContinue, PaneID: "%7"})
		}
		m.handleControlEvent(handle, paneOutput("%7"))
		time.Sleep(5 * time.Millisecond)
	}
	if got := draws.Load(); got != 0 {
		t.Fatalf("출력이 이어지는 동안 %d번 그렸다", got)
	}
	waitForDraws(t, draws, 1)
}

// 화면을 떠 오는 동안 출력이 오면, 떠 둔 화면이 그 출력보다 옛것일 수 있다(따로 연 exec 로 떠 온다).
// 다시 잠잠해진 뒤 한 번 더 그린다.
func TestOutputDuringARedrawRedrawsAgainOnceQuiet(t *testing.T) {
	m, handle, _ := flowTestManager(&paneStreamRecorder{}, tmux34)
	m.redrawQuiet = 20 * time.Millisecond
	var draws atomic.Int32
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	m.paneRestoreStates = func(*controlHandle) []paneRestoreState {
		return []paneRestoreState{{paneID: "%7", alternate: flagOff, width: 80, height: 1}}
	}
	m.paneScreens = func(*controlHandle, paneRestoreState) paneRestoreScreens {
		if draws.Add(1) == 1 {
			entered <- struct{}{}
			<-release
		}
		return paneRestoreScreens{current: []string{"$"}}
	}
	pause, _, _ := m.PaneFlowControls("tmux:ctl:7")
	pause()
	m.handleControlEvent(handle, ControlEvent{Kind: ControlContinue, PaneID: "%7"})
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("다시 그리기가 시작되지 않았다")
	}
	m.handleControlEvent(handle, paneOutput("%7"))
	close(release)
	waitForDraws(t, &draws, 2)
}

// 재개했다가 잠잠해지기 전에 다시 멈추면 그리지 않는다 — 멈춘 동안 그린 화면은 재개하면 또 낡는다.
func TestNoRedrawWhileThePaneIsPausedAgain(t *testing.T) {
	m, handle, _ := flowTestManager(&paneStreamRecorder{}, tmux34)
	m.redrawQuiet = 20 * time.Millisecond
	draws := countPaneDraws(m)
	pause, _, _ := m.PaneFlowControls("tmux:ctl:7")
	pause()
	m.handleControlEvent(handle, ControlEvent{Kind: ControlContinue, PaneID: "%7"})
	pause()
	time.Sleep(100 * time.Millisecond)
	if got := draws.Load(); got != 0 {
		t.Fatalf("멈춰 있는 동안 %d번 그렸다", got)
	}
	m.handleControlEvent(handle, ControlEvent{Kind: ControlContinue, PaneID: "%7"})
	waitForDraws(t, draws, 1)
}
