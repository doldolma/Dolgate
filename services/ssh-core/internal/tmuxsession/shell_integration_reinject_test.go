package tmuxsession

import (
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/pkg/coretypes"
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

func newReinjectHarness(t *testing.T) (*Manager, *controlHandle, *paneStdinRecorder) {
	t.Helper()
	recorder := &paneStdinRecorder{}
	m := NewManager(
		func(coretypes.Event) {},
		func(coretypes.StreamFrame, []byte) {},
	)
	handle := &controlHandle{
		id:     "ctl",
		stdin:  recorder,
		closed: make(chan struct{}),
	}
	m.mu.Lock()
	m.controls["ctl"] = handle
	m.mu.Unlock()
	return m, handle, recorder
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
