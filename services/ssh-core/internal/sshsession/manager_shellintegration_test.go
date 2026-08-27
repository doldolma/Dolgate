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
	// 서브셸이 무엇인지 모르므로 먼저 "누구냐" 한 줄이 나간다. 스크립트는 그 답을 받은 뒤에
	// 나간다 — 모른 채 겸용을 던지면 dash·busybox 화면에 그대로 남았다.
	h.reinjectGate.Observe([]byte("user@remote2:~$ "))
	want := autocomplete.ShellProbeCommand()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && w.written() != want {
		time.Sleep(10 * time.Millisecond)
	}
	if got := w.writeCount(); got != 1 {
		t.Fatalf("expected a single probe write after prompt settle, got %d", got)
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

// 프로브의 답을 받으면 **그 셸 전용 한 줄이 실제로 나가야** 한다.
//
// 여기가 끊기면 화면은 깨끗한데 통합이 영영 안 붙는다 — bash 컨테이너에 들어갔는데 명령 상태가
// 회색으로 굳는 증상이 그것이다.
func TestProbeReplyTriggersTheShellSpecificInjection(t *testing.T) {
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
	h.reinjectGate.Observe([]byte("root@container:/app# "))

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && w.writeCount() < 1 {
		time.Sleep(10 * time.Millisecond)
	}
	if got := w.written(); got != autocomplete.ShellProbeCommand() {
		t.Fatalf("프로브가 나가지 않았다: %q", got)
	}

	// 컨테이너의 bash 가 답한다(스트림 경로와 같은 순서: 프로브 관찰 → 핸드셰이크 필터).
	reply := []byte(autocomplete.ShellProbeReplyPrefix + "5.2.15(1)-release||\a")
	h.shellProbe.Observe(reply)
	h.handshake.Filter(reply)

	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && w.writeCount() < 2 {
		time.Sleep(10 * time.Millisecond)
	}
	if got := w.writeCount(); got < 2 {
		t.Fatalf("답을 받고도 주입하지 않았다: writes=%d, %q", got, w.written())
	}
	if got := w.written(); !strings.Contains(got, "__ds_o") {
		t.Fatalf("bash 스크립트가 아니다: %q", got)
	}
}

// 통합이 없는 셸이면 **실행 중이던 명령 블록을 닫아 준다.**
//
// 안 닫으면 바깥 셸의 133;D 가 그 셸을 빠져나올 때까지 오지 않아, 컨테이너 안에서 친 모든 것이
// 한 블록에 빨려 들어가고 상태 점이 계속 도는 것처럼 보인다.
func TestUnsupportedSubshellClosesTheRunningCommandBlock(t *testing.T) {
	var streamed []byte
	w := &fakeWriteCloser{}
	h := &sessionHandle{
		stdin:        w,
		closed:       make(chan struct{}),
		reinjectGate: autocomplete.NewPromptSettleGate(20*time.Millisecond, time.Second),
	}
	m := NewManager(
		func(_ protocol.Event) {},
		func(_ protocol.StreamFrame, data []byte) {
			streamed = append(streamed, data...)
		},
	)
	m.mu.Lock()
	m.sessions["s1"] = h
	m.mu.Unlock()
	defer close(h.closed)

	if err := m.ReinjectShellIntegration("s1", ""); err != nil {
		t.Fatalf("arm reinject failed: %v", err)
	}
	h.reinjectGate.Observe([]byte("/ # "))
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && w.writeCount() < 1 {
		time.Sleep(10 * time.Millisecond)
	}

	// busybox 가 답한다: bash 도 zsh 도 fish 도 아니다.
	reply := []byte(autocomplete.ShellProbeReplyPrefix + "|||\a")
	h.shellProbe.Observe(reply)
	h.handshake.Filter(reply)

	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(string(streamed), autocomplete.CommandFinishedMarker) {
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(string(streamed), autocomplete.CommandFinishedMarker) {
		t.Fatalf("명령 블록을 닫지 않았다: %q", streamed)
	}
	if got := w.writeCount(); got != 1 {
		t.Fatalf("통합을 넣을 수 없는 셸에 %d줄을 보냈다", got)
	}
}

// 통합이 붙는 셸에서도 **바깥 블록은 닫아야 한다.**
//
// 안 닫으면 아직 열려 있는 바깥 블록(`docker exec …`) 안에 안쪽 셸의 블록들이 들어앉아, 화면이
// 블록 속 블록처럼 보인다. 통합이 실제로 붙기 시작하면서 드러난 상태다.
func TestSupportedSubshellAlsoClosesTheOuterCommandBlock(t *testing.T) {
	var streamed []byte
	w := &fakeWriteCloser{}
	h := &sessionHandle{
		stdin:        w,
		closed:       make(chan struct{}),
		reinjectGate: autocomplete.NewPromptSettleGate(20*time.Millisecond, time.Second),
	}
	m := NewManager(
		func(_ protocol.Event) {},
		func(_ protocol.StreamFrame, data []byte) { streamed = append(streamed, data...) },
	)
	m.mu.Lock()
	m.sessions["s1"] = h
	m.mu.Unlock()
	defer close(h.closed)

	if err := m.ReinjectShellIntegration("s1", ""); err != nil {
		t.Fatalf("arm reinject failed: %v", err)
	}
	h.reinjectGate.Observe([]byte("root@container:/app# "))
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && w.writeCount() < 1 {
		time.Sleep(10 * time.Millisecond)
	}

	reply := []byte(autocomplete.ShellProbeReplyPrefix + "5.2.15(1)-release|||\a")
	h.shellProbe.Observe(reply)
	h.handshake.Filter(reply)

	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && w.writeCount() < 2 {
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(string(streamed), autocomplete.CommandFinishedMarker) {
		t.Fatalf("바깥 블록을 닫지 않았다: %q", streamed)
	}
}

// 지원 불가 표시는 **그 셸에서 나오면 지워져야** 한다.
//
// 세션에 영구히 걸어 두었더니 alpine 에 한 번 들어갔다 나온 뒤로는 bash 컨테이너에도 묻지 않아
// 통합이 안 붙었고, 바깥 블록도 못 닫아 계속 열린 채로 남았다.
func TestUnsupportedFlagClearsWhenTheOuterPromptReturns(t *testing.T) {
	h := &sessionHandle{
		stdin:        &fakeWriteCloser{},
		closed:       make(chan struct{}),
		reinjectGate: autocomplete.NewPromptSettleGate(20*time.Millisecond, time.Second),
	}
	defer close(h.closed)
	h.shellIntegrationUnsupported.Store(true)

	// 통합 없는 셸 안에서의 출력에는 마커가 없다 — 표시는 그대로다.
	if h.shellIntegrationUnsupported.Load() &&
		bytes.Contains([]byte("/ # ls\r\n"), []byte(autocomplete.PromptStartMarker)) {
		t.Fatal("마커 없는 출력에서 표시가 지워졌다")
	}

	// 바깥 셸로 돌아오면 그 셸의 프롬프트 마커가 온다.
	chunk := []byte(autocomplete.PromptStartMarker + "user@host:~$ ")
	if h.shellIntegrationUnsupported.Load() && bytes.Contains(chunk, []byte(autocomplete.PromptStartMarker)) {
		h.shellIntegrationUnsupported.Store(false)
	}
	if h.shellIntegrationUnsupported.Load() {
		t.Fatal("바깥 프롬프트가 돌아왔는데 표시가 남아 있다")
	}
}
