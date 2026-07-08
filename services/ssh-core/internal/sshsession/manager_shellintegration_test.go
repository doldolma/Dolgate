package sshsession

import (
	"bytes"
	"errors"
	"testing"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
)

type fakeWriteCloser struct {
	writes int
	buf    bytes.Buffer
	err    error
}

func (f *fakeWriteCloser) Write(p []byte) (int, error) {
	f.writes++
	if f.err != nil {
		return 0, f.err
	}
	return f.buf.Write(p)
}

func (f *fakeWriteCloser) Close() error { return nil }

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

	if w.writes != 1 {
		t.Fatalf("expected exactly one injection across repeated calls, got %d", w.writes)
	}
	if got := w.buf.String(); got != autocomplete.ShellIntegrationInitCommand() {
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
	if w.writes != 0 {
		t.Fatalf("unsupported shell should not receive init command, got %d writes", w.writes)
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

	w.err = nil
	installed, err = m.installShellIntegration("session-1", h, "bash")
	if err != nil || !installed {
		t.Fatalf("expected retry to install, installed=%v err=%v", installed, err)
	}
	if w.writes != 2 {
		t.Fatalf("expected failed write plus retry, got %d writes", w.writes)
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
