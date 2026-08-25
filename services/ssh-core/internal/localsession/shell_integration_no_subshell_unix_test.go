//go:build !windows

package localsession

// 서브셸 진입 명령이 **실패한** 경우(없는 셸을 쳤다) 재주입하지 않는지.
//
// 렌더러는 입력만 보고 부르므로 `zsh` 가 깔려 있지 않은 호스트에서도 재주입이 걸린다. 그때
// 원래 셸이 그대로 새 프롬프트를 그리는데, 거기에는 이미 우리 마커가 붙어 있다 — 그걸 보고
// 접어야 한다. 접지 않으면 프롬프트가 한 번 더 남고, 힌트가 fish 면 zsh 에 fish 문법이 들어간다.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

func TestReinjectIsSkippedWhenTheSubshellNeverStarted(t *testing.T) {
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash 가 없다")
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
		t.Fatalf("접속 통합이 붙지 않았다:\n%q", captured.snapshot())
	}
	markersBefore := strings.Count(captured.snapshot(), "\x1b]133;A")

	// 없는 셸을 친다 — 명령은 실패하고 **같은 셸**이 새 프롬프트를 그린다.
	if err := manager.WriteBytes("s1", []byte("dolgate-no-such-shell\r")); err != nil {
		t.Fatal(err)
	}
	// 렌더러는 입력만 보고 부르므로 여기서도 호출된다(패턴이 맞았다고 가정).
	if err := manager.ReinjectShellIntegration("s1", "zsh"); err != nil {
		t.Fatal(err)
	}
	// 실패 프롬프트가 돌아올 때까지.
	if !waitFor(t, 8*time.Second, func() bool {
		return strings.Count(captured.snapshot(), "\x1b]133;A") > markersBefore
	}) {
		t.Fatalf("실패 뒤 프롬프트가 오지 않았다:\n%q", captured.snapshot())
	}

	// 주입했다면 그 명령이 실행되면서 프롬프트가 **한 번 더** 그려진다(마커도 하나 더). 접었다면
	// 실패 프롬프트 하나로 끝난다. 화면 글자가 아니라 이 개수가 판정이다 — 주입 스크립트는
	// 셸 가드에 걸려 조용히 아무 것도 안 하고 에코도 지워지므로, 글자로는 갈리지 않는다.
	time.Sleep(2 * time.Second)
	if got := strings.Count(captured.snapshot(), "\x1b]133;A") - markersBefore; got != 1 {
		t.Fatalf("실패 뒤 프롬프트가 %d번 그려졌다(1번이어야 한다 — 주입했다는 뜻):\n%q",
			got, captured.snapshot())
	}
}
