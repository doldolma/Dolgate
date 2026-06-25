package sshsession

import (
	"bytes"
	"testing"

	"dolssh/services/ssh-core/internal/autocomplete"
)

type fakeWriteCloser struct {
	writes int
	buf    bytes.Buffer
}

func (f *fakeWriteCloser) Write(p []byte) (int, error) {
	f.writes++
	return f.buf.Write(p)
}

func (f *fakeWriteCloser) Close() error { return nil }

// installShellIntegration는 once로 보호되어 여러 번 호출해도 정확히 1회만 주입하고,
// 핸드셰이크를 arm 한다 — 서버측 Connect 주입과 renderer 경유 InstallShellIntegration이
// 같은 once를 공유하므로 어느 쪽이 먼저 와도 중복 주입/재-arm(=motd 유실)이 없어야 한다.
func TestInstallShellIntegrationInjectsOnce(t *testing.T) {
	w := &fakeWriteCloser{}
	h := &sessionHandle{stdin: w}

	h.installShellIntegration()
	h.installShellIntegration()
	h.installShellIntegration()

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
