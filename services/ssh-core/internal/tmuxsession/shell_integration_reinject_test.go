package tmuxsession

import (
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/pkg/coretypes"
	"golang.org/x/crypto/ssh"
)

// pane 의 stdin 을 받아 두는 대역. writeStdin 이 여기로 흐른다.
type paneStdinRecorder struct {
	mu      sync.Mutex
	written strings.Builder
}

func (r *paneStdinRecorder) Write(data []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.written.Write(data)
	return len(data), nil
}

func (r *paneStdinRecorder) Close() error { return nil }

func (r *paneStdinRecorder) snapshot() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.written.String()
}

// 렌더러로 나가는 pane 스트림을 받아 두는 대역.
type paneStreamRecorder struct {
	mu   sync.Mutex
	data map[string]*strings.Builder
}

func (r *paneStreamRecorder) emit(frame coretypes.StreamFrame, data []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.data == nil {
		r.data = map[string]*strings.Builder{}
	}
	if r.data[frame.SessionID] == nil {
		r.data[frame.SessionID] = &strings.Builder{}
	}
	r.data[frame.SessionID].Write(data)
}

func (r *paneStreamRecorder) read(sessionID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.data == nil || r.data[sessionID] == nil {
		return ""
	}
	return r.data[sessionID].String()
}

func newReinjectHarness(t *testing.T) (*Manager, *controlHandle, *paneStdinRecorder) {
	t.Helper()
	m, handle, recorder, _ := newReinjectHarnessWithStream(t)
	return m, handle, recorder
}

func newReinjectHarnessWithStream(t *testing.T) (*Manager, *controlHandle, *paneStdinRecorder, *paneStreamRecorder) {
	t.Helper()
	recorder := &paneStdinRecorder{}
	stream := &paneStreamRecorder{}
	m := NewManager(func(coretypes.Event) {}, stream.emit)
	// 재주입은 서브셸에 들어간 뒤라 pane 앞에는 껍데기(ssh 등)가 있다. 그 껍데기 너머 프롬프트가
	// 그려진 평범한 화면을 기본으로 둔다 — 가드가 통과시켜야 하는 상태다. 여기서 스텁하지 않으면
	// 조회가 실패로 끝나(known=false) 가드가 전부 포기해 버린다.
	m.panePrompt = stubPanePrompt(paneState{command: "ssh", cursorX: 17, known: true})
	handle := &controlHandle{
		id:     "ctl",
		stdin:  recorder,
		closed: make(chan struct{}),
	}
	m.mu.Lock()
	m.controls["ctl"] = handle
	m.mu.Unlock()
	return m, handle, recorder, stream
}

// tmux 로 나가는 것은 `send-keys -t %0 -H <바이트들>` 이다. 실제로 무엇을 보냈는지 보려면
// 그 16진수를 되돌려야 한다.
func decodePaneStdin(raw string) string {
	var out strings.Builder
	for _, line := range strings.Split(raw, "\n") {
		marker := " -H "
		at := strings.Index(line, marker)
		if at < 0 {
			continue
		}
		for _, token := range strings.Fields(line[at+len(marker):]) {
			value, err := strconv.ParseUint(token, 16, 8)
			if err != nil {
				continue
			}
			out.WriteByte(byte(value))
		}
	}
	return out.String()
}

func waitForStdin(t *testing.T, recorder *paneStdinRecorder, want string, limit time.Duration) bool {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if strings.Contains(decodePaneStdin(recorder.snapshot()), want) {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return strings.Contains(decodePaneStdin(recorder.snapshot()), want)
}

// pane 안에서 서브셸에 들어가면 그 셸에는 훅이 없다 — 예전에는 이 경로가 아예 없어서(runtime 의
// 분기에도, 매니저에도) tmux 로 작업하면 서브셸 통합이 조용히 사라졌다.
//
// 바로 쓰지 않고 **새 프롬프트가 안착한 뒤**에 쓴다. 아직 인증·기동 중인 셸에 쓰면 입력이 망가진다.
func TestReinjectShellIntegrationWaitsForThePanePrompt(t *testing.T) {
	m, handle, recorder := newReinjectHarness(t)
	paneSession := paneSessionID("ctl", "%0")

	if err := m.ReinjectShellIntegration(paneSession, ""); err != nil {
		t.Fatalf("reinject: %v", err)
	}

	// 프롬프트가 아닌 출력에는 반응하지 않는다.
	handle.observePaneOutput("%0", []byte("Password:"))
	time.Sleep(200 * time.Millisecond)
	if got := recorder.snapshot(); got != "" {
		t.Fatalf("프롬프트 전에 주입했다: %q", got)
	}

	handle.observePaneOutput("%0", []byte("root@box:/# "))
	// 셸을 모르므로 먼저 "누구냐" 한 줄이 나간다. 스크립트는 그 답을 받은 뒤에 나간다 —
	// 모른 채 겸용을 던지면 dash·busybox pane 화면에 그대로 남는다.
	if !waitForStdin(t, recorder, "dg-shell", 3*time.Second) {
		t.Fatalf("프롬프트가 안착했는데 묻지 않았다: %q", recorder.snapshot())
	}
	if decoded := decodePaneStdin(recorder.snapshot()); strings.Contains(decoded, "__ds_o") {
		t.Fatalf("묻기도 전에 스크립트를 보냈다: %q", decoded)
	}
	// 다른 pane 은 건드리지 않는다.
	if strings.Contains(recorder.snapshot(), "-t %1") {
		t.Fatalf("다른 pane 에 보냈다: %q", recorder.snapshot())
	}
}

// 셸을 알면 그 셸 것만 보낸다. 훅을 걸 수 없는 셸이면 아무것도 보내지 않는다 — 타이핑해 봐야
// 화면만 더럽힌다.
func TestReinjectShellIntegrationHonoursTheShellHintInPanes(t *testing.T) {
	t.Run("fish", func(t *testing.T) {
		m, handle, recorder := newReinjectHarness(t)
		if err := m.ReinjectShellIntegration(paneSessionID("ctl", "%0"), "fish"); err != nil {
			t.Fatal(err)
		}
		handle.observePaneOutput("%0", []byte("user@box ~> "))
		if !waitForStdin(t, recorder, "__ds_shell_integration_installed", 3*time.Second) {
			t.Fatalf("fish 스크립트를 보내지 않았다: %q", recorder.snapshot())
		}
		if decoded := decodePaneStdin(recorder.snapshot()); strings.Contains(decoded, "BASH_VERSION") {
			t.Fatalf("fish 에 POSIX 스크립트를 보냈다: %q", decoded)
		}
	})

	t.Run("지원 안 함", func(t *testing.T) {
		m, handle, recorder := newReinjectHarness(t)
		if err := m.ReinjectShellIntegration(paneSessionID("ctl", "%0"), "dash"); err != nil {
			t.Fatal(err)
		}
		handle.observePaneOutput("%0", []byte("$ "))
		time.Sleep(700 * time.Millisecond)
		if got := recorder.snapshot(); got != "" {
			t.Fatalf("훅을 걸 수 없는 셸에 보냈다: %q", got)
		}
	})

	t.Run("PowerShell 재주입 안 함", func(t *testing.T) {
		m, handle, recorder := newReinjectHarness(t)
		if err := m.ReinjectShellIntegration(paneSessionID("ctl", "%0"), "pwsh"); err != nil {
			t.Fatal(err)
		}
		handle.observePaneOutput("%0", []byte("PS C:\\> "))
		time.Sleep(200 * time.Millisecond)
		if got := recorder.snapshot(); got != "" {
			t.Fatalf("PowerShell pane 에 재주입했다: %q", got)
		}
	})
}

// pane 세션이 아닌 id(=control 세션 자체)에는 할 일이 없다.
func TestReinjectShellIntegrationIgnoresNonPaneSessions(t *testing.T) {
	m, _, recorder := newReinjectHarness(t)
	if err := m.ReinjectShellIntegration("ctl", ""); err != nil {
		t.Fatalf("reinject: %v", err)
	}
	time.Sleep(200 * time.Millisecond)
	if got := recorder.snapshot(); got != "" {
		t.Fatalf("control 세션에 보냈다: %q", got)
	}
}

// 정착은 "프롬프트가 떴다" 가 아니다. `ssh host` 뒤에 원격 rc 가 vim·tmux 를 띄우면 화면은
// 조용해지고 게이트는 터진다 — 예전에는 그 자리에 프로브를 타이핑했다(vi 에 `printf …` 가 입력됨).
// 설치 경로처럼 타이핑 직전에 pane 화면을 보고, 프롬프트에서 기다리는 상태가 아니면 아무것도
// 보내지 않고 실행 중 블록만 닫는다.
func TestReinjectShellIntegrationGivesUpWhenTheScreenIsNotAtAPrompt(t *testing.T) {
	cases := []struct {
		name  string
		hint  string
		state paneState
	}{
		{"대체화면(vim) — 셸 모름", "", paneState{command: "ssh", alternateOn: true, cursorX: 5, known: true}},
		{"대체화면(vim) — 셸 힌트 있음", "bash", paneState{command: "ssh", alternateOn: true, cursorX: 5, known: true}},
		{"copy-mode", "", paneState{command: "ssh", inMode: true, cursorX: 17, known: true}},
		{"프롬프트가 안 그려짐(커서가 0열)", "", paneState{command: "ssh", cursorX: 0, known: true}},
		{"pane 상태를 못 물음(조회 실패)", "bash", paneState{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m, handle, recorder, stream := newReinjectHarnessWithStream(t)
			m.panePrompt = stubPanePrompt(tc.state)
			paneSession := paneSessionID("ctl", "%0")
			if err := m.ReinjectShellIntegration(paneSession, tc.hint); err != nil {
				t.Fatal(err)
			}
			handle.observePaneOutput("%0", []byte("root@box:/# "))
			time.Sleep(700 * time.Millisecond)
			if got := recorder.snapshot(); got != "" {
				t.Fatalf("프롬프트에 있지 않은 pane 에 타이핑했다: %q", decodePaneStdin(got))
			}
			if n := strings.Count(stream.read(paneSession), autocomplete.CommandFinishedMarker); n != 1 {
				t.Fatalf("포기하면 실행 중 블록을 한 번 닫아야 하는데 마커가 %d번 왔다: %q", n, stream.read(paneSession))
			}
		})
	}
}

// 재주입은 서브셸에 들어간 뒤라 pane 앞의 프로세스는 셸이 아니라 껍데기다. 설치 경로처럼 이름으로
// 걸러 버리면 중첩 ssh·docker·sudo 에는 영영 못 심는다 — 화면 상태만 본다.
func TestReinjectShellIntegrationStillProbesBehindAWrapperProcess(t *testing.T) {
	for _, wrapper := range []string{"ssh", "docker", "sudo", "su"} {
		t.Run(wrapper, func(t *testing.T) {
			m, handle, recorder, stream := newReinjectHarnessWithStream(t)
			m.panePrompt = stubPanePrompt(paneState{command: wrapper, cursorX: 17, known: true})
			paneSession := paneSessionID("ctl", "%0")
			if err := m.ReinjectShellIntegration(paneSession, ""); err != nil {
				t.Fatal(err)
			}
			handle.observePaneOutput("%0", []byte("root@box:/# "))
			if !waitForStdin(t, recorder, "dg-shell", 3*time.Second) {
				t.Fatalf("껍데기(%s) 너머 프롬프트에 묻지 않았다: %q", wrapper, recorder.snapshot())
			}
			if strings.Contains(stream.read(paneSession), autocomplete.CommandFinishedMarker) {
				t.Fatalf("타이핑했는데 포기 마커도 보냈다")
			}
		})
	}
}

// 화면은 **정착 시점**에 봐야 한다. 무장할 때 보면, 그 사이 vi 가 떠오르는 — 이 가드가 잡으려는 —
// 바로 그 변화를 놓친다. 반대 방향도 같다: 무장 때는 아직 이전 프로그램이 앞에 있다가 정착 때
// 프롬프트가 된 경우, 무장 시점 판정은 심을 수 있는 셸을 포기해 버린다.
func TestReinjectShellIntegrationChecksTheScreenWhenThePromptSettles(t *testing.T) {
	m, handle, recorder, _ := newReinjectHarnessWithStream(t)
	var mu sync.Mutex
	state := paneState{command: "ssh", alternateOn: true, cursorX: 5, known: true} // 무장 때: 아직 vi
	m.panePrompt = func(*ssh.Client, string) paneState {
		mu.Lock()
		defer mu.Unlock()
		return state
	}
	paneSession := paneSessionID("ctl", "%0")
	if err := m.ReinjectShellIntegration(paneSession, ""); err != nil {
		t.Fatal(err)
	}
	// vi 가 끝나고 프롬프트가 그려진다.
	mu.Lock()
	state = paneState{command: "ssh", cursorX: 17, known: true}
	mu.Unlock()
	handle.observePaneOutput("%0", []byte("root@box:/# "))
	if !waitForStdin(t, recorder, "dg-shell", 3*time.Second) {
		t.Fatalf("정착 시점에는 프롬프트인데 묻지 않았다 — 무장 시점 화면으로 판정했다: %q", recorder.snapshot())
	}
}
