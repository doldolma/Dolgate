//go:build !windows

package localsession

// zsh 서브셸 재주입. 지금까지 서브셸 테스트는 bash 뿐이었는데, 셸마다 스크립트도 프롬프트를
// 다시 그리는 방식도 다르다(zsh 는 zle 가 줄을 지우고 다시 그린다). 두 셸을 다 덮어 둔다.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

func TestReinjectShellIntegrationIntoAZshSubshell(t *testing.T) {
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash 가 없다")
	}
	zshPath, err := exec.LookPath("zsh")
	if err != nil {
		t.Skip("zsh 가 없다")
	}
	// t.TempDir 을 쓰지 않는다. 이 디렉터리를 서브셸의 ZDOTDIR 로 넘기는데, macOS 의 /etc/zshrc 가
	// 셸을 나갈 때 `.zsh_sessions/` 를 그 안에 만든다 — 테스트가 끝나고 정리가 도는 사이에 파일이
	// 생겨 t.TempDir 의 RemoveAll 이 "directory not empty" 로 **테스트를 실패시켰다**(CI 의
	// macOS 러너에서만 났다). 우리가 지우고 실패는 무시한다.
	dir, err := os.MkdirTemp("", "dolgate-zsh-subshell")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	outerRc := filepath.Join(dir, "outer")
	if err := os.WriteFile(outerRc, []byte("PS1='outer$ '\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// 서브셸 zsh 는 이 디렉터리를 ZDOTDIR 로 받아 우리 rc 만 읽는다(사용자 rc 영향 배제).
	// 히스토리 파일도 남기지 않게 한다 — 위 정리 문제와 같은 부류다.
	if err := os.WriteFile(
		filepath.Join(dir, ".zshrc"),
		[]byte("unset HISTFILE\nPS1='inner%% '\n"),
		0o600,
	); err != nil {
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
		Args:       []string{"--noprofile", "--rcfile", outerRc, "-i"},
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
		t.Fatalf("바깥 셸에 통합이 붙지 않았다:\n%q", captured.snapshot())
	}
	markersBefore := strings.Count(captured.snapshot(), "\x1b]133;A")

	if err := manager.WriteBytes("s1", []byte("ZDOTDIR="+dir+" SHELL_SESSIONS_DISABLE=1 "+zshPath+" -i\r")); err != nil {
		t.Fatal(err)
	}
	if err := manager.ReinjectShellIntegration("s1", "zsh"); err != nil {
		t.Fatal(err)
	}
	if !waitFor(t, 10*time.Second, func() bool {
		return strings.Count(captured.snapshot(), "\x1b]133;A") > markersBefore
	}) {
		t.Fatalf("zsh 서브셸에 통합이 붙지 않았다:\n%q", captured.snapshot())
	}

	// zsh 는 명령 원문을 훅으로 알려 준다(133;E) — bash 에는 없는 경로라 여기서 확인한다.
	if err := manager.WriteBytes("s1", []byte("echo zsh-sub\r")); err != nil {
		t.Fatal(err)
	}
	if !waitFor(t, 8*time.Second, func() bool {
		out := captured.snapshot()
		return strings.Contains(out, "\x1b]133;E;echo zsh-sub") &&
			strings.Contains(out, "\x1b]133;C")
	}) {
		t.Fatalf("zsh 서브셸에서 명령 마커(E/C)가 오지 않았다:\n%q", captured.snapshot())
	}
	if strings.Contains(captured.snapshot(), "__ds_precmd") {
		t.Fatalf("주입 스크립트가 화면에 남았다:\n%q", captured.snapshot())
	}
}
