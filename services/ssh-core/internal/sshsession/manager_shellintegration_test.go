package sshsession

import (
	"bytes"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
)

// fakeWriteCloser stands in for the session's stdin. Injection happens on a
// timer goroutine (see the reinject gate) while the test inspects the writer, so
// the fake is mutex-guarded and must only be read through its accessors.
type fakeWriteCloser struct {
	mu     sync.Mutex
	writes int
	buf    bytes.Buffer
	err    error
}

func (f *fakeWriteCloser) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes++
	if f.err != nil {
		return 0, f.err
	}
	return f.buf.Write(p)
}

func (f *fakeWriteCloser) Close() error { return nil }

func (f *fakeWriteCloser) writeCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.writes
}

func (f *fakeWriteCloser) written() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.buf.String()
}

func (f *fakeWriteCloser) setErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

// installShellIntegration는 여러 번 호출해도 정확히 1회만 주입하고 핸드셰이크를 arm 한다.
// 서버측 Connect 주입과 renderer 경유 InstallShellIntegration이 같은 상태를 공유하므로 어느
// 쪽이 먼저 와도 중복 주입/재-arm(=motd 유실)이 없어야 한다.
func TestInstallShellIntegrationInjectsOnce(t *testing.T) {
	w := &fakeWriteCloser{}
	h := &sessionHandle{stdin: w, closed: make(chan struct{})}
	m := NewManager(func(_ protocol.Event) {}, func(_ protocol.StreamFrame, _ []byte) {})

	installed, err := m.installShellIntegration("session-1", h, "bash")
	if err != nil || !installed {
		t.Fatalf("expected first install to succeed, installed=%v err=%v", installed, err)
	}
	installed, err = m.installShellIntegration("session-1", h, "bash")
	if err != nil || installed {
		t.Fatalf("expected second install to be no-op, installed=%v err=%v", installed, err)
	}
	installed, err = m.installShellIntegration("session-1", h, "bash")
	if err != nil || installed {
		t.Fatalf("expected third install to be no-op, installed=%v err=%v", installed, err)
	}

	// 셸을 알고 부르므로(bash) 그 셸 것 하나만 나간다.
	if got := w.writeCount(); got != 1 {
		t.Fatalf("expected exactly one injection across repeated calls, got %d", got)
	}
	if got := w.written(); got != autocomplete.BashShellIntegrationInitCommand() {
		t.Fatalf("unexpected injected command: %q", got)
	}
	// arm 되었으면 echo/마커가 없는 첫 청크는 흡수(버퍼링)되어 빈 forward를 반환한다.
	if forwarded := h.handshake.Filter([]byte("noise before marker")); len(forwarded) != 0 {
		t.Fatalf("handshake should be armed and suppressing, got %q", forwarded)
	}
}

func TestInstallShellIntegrationUnsupportedIsNoop(t *testing.T) {
	w := &fakeWriteCloser{}
	h := &sessionHandle{
		stdin:                 w,
		closed:                make(chan struct{}),
		shellIntegrationState: shellIntegrationUnsupported,
	}
	m := NewManager(func(_ protocol.Event) {}, func(_ protocol.StreamFrame, _ []byte) {})

	installed, err := m.installShellIntegration("session-1", h, "bash")
	if err != nil || installed {
		t.Fatalf("expected unsupported install to be no-op, installed=%v err=%v", installed, err)
	}
	if got := w.writeCount(); got != 0 {
		t.Fatalf("unsupported shell should not receive init command, got %d writes", got)
	}
	if forwarded := h.handshake.Filter([]byte("plain output")); string(forwarded) != "plain output" {
		t.Fatalf("unsupported shell output should pass through, got %q", forwarded)
	}
}

func TestInstallShellIntegrationWriteFailureCanRetry(t *testing.T) {
	writeErr := errors.New("stdin closed")
	w := &fakeWriteCloser{err: writeErr}
	h := &sessionHandle{stdin: w, closed: make(chan struct{})}
	m := NewManager(func(_ protocol.Event) {}, func(_ protocol.StreamFrame, _ []byte) {})

	installed, err := m.installShellIntegration("session-1", h, "bash")
	if !errors.Is(err, writeErr) || installed {
		t.Fatalf("expected write failure, installed=%v err=%v", installed, err)
	}
	if h.shellIntegrationStatus() != shellIntegrationUnknown {
		t.Fatalf("failed write must leave integration retryable, got state %v", h.shellIntegrationStatus())
	}
	if forwarded := h.handshake.Filter([]byte("after failure")); string(forwarded) != "after failure" {
		t.Fatalf("handshake should pass through after failed write, got %q", forwarded)
	}

	w.setErr(nil)
	installed, err = m.installShellIntegration("session-1", h, "bash")
	if err != nil || !installed {
		t.Fatalf("expected retry to install, installed=%v err=%v", installed, err)
	}
	if got := w.writeCount(); got != 2 {
		t.Fatalf("expected failed write plus retry, got %d writes", got)
	}
}

// ReinjectShellIntegration must wait for the subshell prompt to settle before
// writing (so it never corrupts a still-authenticating shell), then inject
// exactly once and arm the echo-suppression handshake. This is the core of the
// subshell (nested ssh / sudo su / docker exec) recovery path.
func TestReinjectShellIntegrationInjectsAfterPromptSettles(t *testing.T) {
	w := &fakeWriteCloser{}
	h := &sessionHandle{
		stdin:        w,
		closed:       make(chan struct{}),
		reinjectGate: autocomplete.NewPromptSettleGate(20*time.Millisecond, time.Second),
	}
	m := NewManager(func(_ protocol.Event) {}, func(_ protocol.StreamFrame, _ []byte) {})
	m.mu.Lock()
	m.sessions["s1"] = h
	m.mu.Unlock()
	defer close(h.closed)

	if err := m.ReinjectShellIntegration("s1", ""); err != nil {
		t.Fatalf("arm reinject failed: %v", err)
	}

	// Connection/auth output that is not a prompt must not trigger injection.
	h.reinjectGate.Observe([]byte("Connecting to remote2...\r\n"))
	time.Sleep(45 * time.Millisecond)
	if got := w.writeCount(); got != 0 {
		t.Fatalf("must not inject before a prompt settles, got %d writes", got)
	}

	// A settled subshell prompt then quiet triggers the injection.
	//
	// 서브셸은 무엇으로 들어갔는지 모르므로 bash 용·zsh 용이 **한 명령의 여러 줄** 로 나간다 —
	// 한 줄로 합치면 MAX_CANON(1024)을 넘어 줄 편집기가 없는 셸에서 잘린다.
	h.reinjectGate.Observe([]byte("user@remote2:~$ "))
	want := strings.Join(autocomplete.ShellIntegrationInitLines(""), "")
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && w.written() != want {
		time.Sleep(10 * time.Millisecond)
	}
	if got := w.writeCount(); got != len(autocomplete.ShellIntegrationInitLines("")) {
		t.Fatalf("expected one write per injected line after prompt settle, got %d", got)
	}
	if got := w.written(); got != want {
		t.Fatalf("unexpected injected command: %q", got)
	}
	// The handshake must be armed so the injected command echo is suppressed.
	if forwarded := h.handshake.Filter([]byte("noise before marker")); len(forwarded) != 0 {
		t.Fatalf("handshake should be armed after reinject, got %q", forwarded)
	}
}

func TestNormalizeRemoteShellProbeOutput(t *testing.T) {
	for _, tc := range []struct {
		name string
		out  []byte
		want string
	}{
		{name: "bash capability", out: []byte("bash\n"), want: "bash"},
		{name: "zsh capability", out: []byte("zsh\n"), want: "zsh"},
		{name: "fish capability", out: []byte("fish\n"), want: "fish"},
		{name: "fish path capability", out: []byte("/usr/bin/fish\n"), want: "fish"},
		{name: "sh path remains unsupported without capability", out: []byte("/bin/sh\n"), want: ""},
		{name: "unsupported", out: []byte("ksh\n"), want: ""},
		{name: "empty", out: nil, want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeRemoteShellProbeOutput(tc.out); got != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
		})
	}
}

// 서브셸 진입 명령이 실패한 경우(없는 셸을 쳤다) 원래 셸이 **마커 붙은** 프롬프트를 그린다.
// 그때는 주입하지 않는다 — 통합은 살아 있고, 보내면 프롬프트만 한 번 더 남는다.
func TestReinjectIsSkippedWhenThePromptAlreadyCarriesTheMarker(t *testing.T) {
	w := &fakeWriteCloser{}
	h := &sessionHandle{
		stdin:        w,
		closed:       make(chan struct{}),
		reinjectGate: autocomplete.NewPromptSettleGate(20*time.Millisecond, time.Second),
	}
	m := NewManager(func(_ protocol.Event) {}, func(_ protocol.StreamFrame, _ []byte) {})
	m.mu.Lock()
	m.sessions["s1"] = h
	m.mu.Unlock()
	defer close(h.closed)

	if err := m.ReinjectShellIntegration("s1", "zsh"); err != nil {
		t.Fatalf("arm reinject failed: %v", err)
	}
	h.reinjectGate.Observe([]byte("bash: zsh: command not found\r\n"))
	h.reinjectGate.Observe([]byte(autocomplete.PromptStartMarker + "user@remote:~$ "))

	time.Sleep(200 * time.Millisecond)
	if got := w.writeCount(); got != 0 {
		t.Fatalf("서브셸이 뜨지 않았는데 %d번 썼다: %q", got, w.written())
	}
}

// 마커가 없는 맨 프롬프트(진짜 새 셸)에는 그대로 주입한다 — 위 규칙이 정상 경로를 막지 않는지.
func TestReinjectStillRunsForAFreshSubshellPrompt(t *testing.T) {
	w := &fakeWriteCloser{}
	h := &sessionHandle{
		stdin:        w,
		closed:       make(chan struct{}),
		reinjectGate: autocomplete.NewPromptSettleGate(20*time.Millisecond, time.Second),
	}
	m := NewManager(func(_ protocol.Event) {}, func(_ protocol.StreamFrame, _ []byte) {})
	m.mu.Lock()
	m.sessions["s1"] = h
	m.mu.Unlock()
	defer close(h.closed)

	if err := m.ReinjectShellIntegration("s1", "bash"); err != nil {
		t.Fatalf("arm reinject failed: %v", err)
	}
	h.reinjectGate.Observe([]byte("bash-5.2$ "))

	want := strings.Join(autocomplete.ShellIntegrationInitLines("bash"), "")
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && w.written() != want {
		time.Sleep(10 * time.Millisecond)
	}
	if got := w.written(); got != want {
		t.Fatalf("맨 프롬프트에는 주입해야 한다. 쓴 것: %q", got)
	}
}

// 훅을 걸 수 없는 셸(dash·ksh)로 들어간 경우에는 아무것도 보내지 않는다 — 타이핑해 봐야
// 화면만 더럽힌다.
func TestReinjectSendsNothingForAnUnsupportedShellHint(t *testing.T) {
	w := &fakeWriteCloser{}
	h := &sessionHandle{
		stdin:        w,
		closed:       make(chan struct{}),
		reinjectGate: autocomplete.NewPromptSettleGate(20*time.Millisecond, time.Second),
	}
	m := NewManager(func(_ protocol.Event) {}, func(_ protocol.StreamFrame, _ []byte) {})
	m.mu.Lock()
	m.sessions["s1"] = h
	m.mu.Unlock()
	defer close(h.closed)

	if err := m.ReinjectShellIntegration("s1", "dash"); err != nil {
		t.Fatalf("arm reinject failed: %v", err)
	}
	h.reinjectGate.Observe([]byte("$ "))

	time.Sleep(200 * time.Millisecond)
	if got := w.writeCount(); got != 0 {
		t.Fatalf("지원하지 않는 셸에 %d번 썼다: %q", got, w.written())
	}
}
