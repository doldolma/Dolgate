//go:build !windows

package localsession

// PS0 이 없는 bash(4.4 미만, macOS 기본이 3.2)에서도 **명령 시작 마커(133;C)** 가 오는지.
//
// 이게 없으면 앱은 명령 블록을 만들지 못한다(블록은 C 에서 시작한다) — A·B·D 만 와서 통합이
// 붙은 것처럼 보이면서 화면에는 아무 것도 안 생긴다. 실제로 macOS 로컬에서 `bash` 서브셸에
// 들어가면 그랬고, 그때 재주입 테스트는 A 만 세고 있어서 통과했다.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

func TestBashWithoutPS0StillReportsCommandStart(t *testing.T) {
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash 가 없다")
	}
	version, err := exec.Command(bashPath, "-c", "echo $BASH_VERSION").Output()
	if err != nil {
		t.Skip("bash 버전을 못 읽었다")
	}
	major := strings.SplitN(strings.TrimSpace(string(version)), ".", 2)[0]
	if major >= "5" {
		// PS0 이 있는 bash 는 이 테스트의 대상이 아니다(그쪽은 PS0 로 C 가 온다).
		t.Skipf("PS0 을 쓰는 bash 다(%s) — 3.x/4.0~4.3 에서만 의미가 있다", strings.TrimSpace(string(version)))
	}

	dir := t.TempDir()
	rc := filepath.Join(dir, "rc")
	if err := os.WriteFile(rc, []byte("PS1='ready$ '\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	captured := &unixCapturedOutput{}
	manager := NewManager(
		func(protocol.Event) {},
		func(_ protocol.StreamFrame, data []byte) { captured.append(data) },
	)
	if err := manager.Connect("s1", "r1", protocol.LocalConnectPayload{
		Cols: 120, Rows: 32,
		Executable: bashPath,
		Args:       []string{"--noprofile", "--rcfile", rc, "-i"},
		ShellKind:  "bash",
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Disconnect("s1") })
	if err := manager.InstallShellIntegration("s1"); err != nil {
		t.Fatal(err)
	}
	if !waitFor(t, 8*time.Second, func() bool {
		return strings.Contains(captured.snapshot(), "\x1b]133;A")
	}) {
		t.Fatalf("프롬프트 마커(A)가 오지 않았다:\n%q", captured.snapshot())
	}

	if err := manager.WriteBytes("s1", []byte("echo hi\r")); err != nil {
		t.Fatal(err)
	}
	// C(명령 시작)와 D(종료)까지 와야 앱이 블록을 만든다.
	if !waitFor(t, 8*time.Second, func() bool {
		out := captured.snapshot()
		return strings.Contains(out, "\x1b]133;C") && strings.Contains(out, "\x1b]133;D")
	}) {
		t.Fatalf("명령 시작(C)/종료(D) 마커가 오지 않았다:\n%q", captured.snapshot())
	}

	// 한 명령에 C 는 한 번만. DEBUG 트랩은 명령마다 발화하므로 중복을 막지 못하면 블록이
	// 여러 개 생긴다.
	if got := strings.Count(captured.snapshot(), "\x1b]133;C"); got != 1 {
		t.Fatalf("C 마커가 %d개다(1개여야 한다):\n%q", got, captured.snapshot())
	}
}
