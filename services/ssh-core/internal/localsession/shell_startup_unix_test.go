//go:build !windows

package localsession

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

// 로컬 셸은 우리가 직접 띄우므로 통합을 **기동 파일**로 넣는다. 타이핑이 없어지면 그에 딸린
// 문제가 통째로 사라진다 — tty 한 줄 상한, 화면에서 echo 걷어내기, 프롬프트 기다리기.
//
// 확인할 것은 셋이다: (1) 사용자 rc 가 그대로 살아 있는가, (2) 화면에 아무것도 타이핑되지
// 않는가, (3) **첫 프롬프트부터** 마커가 붙는가(타이핑 방식은 첫 프롬프트에 마커가 없었다).
func TestLocalShellIntegrationComesFromStartupFiles(t *testing.T) {
	for _, tc := range []struct {
		shell  string
		rcName string
		rcBody string
	}{
		{shell: "bash", rcName: ".bashrc", rcBody: "export DOLGATE_RC_RAN=yes\nPS1='ready$ '\n"},
		{shell: "zsh", rcName: ".zshrc", rcBody: "export DOLGATE_RC_RAN=yes\nPS1='ready$ '\n"},
	} {
		t.Run(tc.shell, func(t *testing.T) {
			shellPath, err := exec.LookPath(tc.shell)
			if err != nil {
				t.Skipf("%s 가 없다", tc.shell)
			}
			// 사용자 홈을 흉내낸다 — 실제 홈의 설정을 건드리지 않는다.
			home := t.TempDir()
			if err := os.WriteFile(filepath.Join(home, tc.rcName), []byte(tc.rcBody), 0o600); err != nil {
				t.Fatal(err)
			}

			captured := &unixCapturedOutput{}
			manager := NewManager(
				func(protocol.Event) {},
				func(_ protocol.StreamFrame, data []byte) { captured.append(data) },
			)
			if err := manager.Connect("s1", "r1", protocol.LocalConnectPayload{
				Cols: 120, Rows: 32,
				Executable: shellPath,
				ShellKind:  tc.shell,
				Env:        map[string]string{"HOME": home, "ZDOTDIR": ""},
			}); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = manager.Disconnect("s1") })
			// 렌더러가 하는 그대로 부른다 — 기동 파일로 이미 넣었으면 아무것도 쓰지 않아야 한다.
			if err := manager.InstallShellIntegration("s1"); err != nil {
				t.Fatal(err)
			}

			// 마커와 프롬프트가 **둘 다** 올 때까지 기다린다 — 하나만 보고 자리를 비교하면
			// 아직 안 온 쪽이 -1 이라 엉뚱하게 판정한다.
			if !waitFor(t, 8*time.Second, func() bool {
				output := captured.snapshot()
				return strings.Contains(output, "\x1b]133;A") && strings.Contains(output, "ready$")
			}) {
				t.Fatalf("첫 프롬프트에 마커가 없다:\n%q", captured.snapshot())
			}
			// 마커가 프롬프트보다 먼저 온다 = 훅이 프롬프트를 그리기 전에 이미 걸려 있었다.
			output := captured.snapshot()
			if strings.Index(output, "\x1b]133;A") > strings.Index(output, "ready$") {
				t.Fatalf("첫 프롬프트에는 마커가 없었다(뒤늦게 붙었다):\n%q", output)
			}
			if strings.Contains(output, "__ds_o") {
				t.Fatalf("타이핑한 흔적이 화면에 있다:\n%q", output)
			}

			// 사용자 rc 가 살아 있는지 — 그 값이 셸 안에 있어야 한다.
			if err := manager.WriteBytes("s1", []byte("echo rc=$DOLGATE_RC_RAN\r")); err != nil {
				t.Fatal(err)
			}
			if !waitFor(t, 5*time.Second, func() bool {
				return strings.Contains(captured.snapshot(), "rc=yes")
			}) {
				t.Fatalf("사용자 rc 가 실행되지 않았다:\n%q", captured.snapshot())
			}
		})
	}
}

// zsh 는 시작 파일마다 ZDOTDIR 를 다시 본다. 사용자의 .zshenv 가 ZDOTDIR 를 옮기는 구성
// (`~/.config/zsh` 등)에서 우리 심이 그것을 되돌리지 않으면, 다음 파일부터 그 디렉터리에서
// 읽혀 우리 .zshrc 가 실행되지 않는다 — 통합이 조용히 꺼진다.
func TestZshStartupIntegrationSurvivesUserZdotdir(t *testing.T) {
	shellPath, err := exec.LookPath("zsh")
	if err != nil {
		t.Skip("zsh 가 없다")
	}
	home := t.TempDir()
	userZdotdir := filepath.Join(home, "config", "zsh")
	if err := os.MkdirAll(userZdotdir, 0o700); err != nil {
		t.Fatal(err)
	}
	// 사용자 .zshenv 가 ZDOTDIR 를 옮긴다.
	if err := os.WriteFile(
		filepath.Join(home, ".zshenv"),
		[]byte("export ZDOTDIR=\""+userZdotdir+"\"\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	// 사용자 rc 는 옮긴 디렉터리에 있다 — 그것도 살아 있어야 한다.
	if err := os.WriteFile(
		filepath.Join(userZdotdir, ".zshrc"),
		[]byte("export DOLGATE_RC_RAN=yes\nPS1='ready$ '\n"),
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
		Executable: shellPath,
		ShellKind:  "zsh",
		Env:        map[string]string{"HOME": home, "ZDOTDIR": ""},
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Disconnect("s1") })
	if err := manager.InstallShellIntegration("s1"); err != nil {
		t.Fatal(err)
	}

	if !waitFor(t, 8*time.Second, func() bool {
		output := captured.snapshot()
		return strings.Contains(output, "\x1b]133;A") && strings.Contains(output, "ready$")
	}) {
		t.Fatalf("옮긴 ZDOTDIR 에서 통합이 실행되지 않았다:\n%q", captured.snapshot())
	}
	if err := manager.WriteBytes("s1", []byte("echo rc=$DOLGATE_RC_RAN\r")); err != nil {
		t.Fatal(err)
	}
	if !waitFor(t, 5*time.Second, func() bool {
		return strings.Contains(captured.snapshot(), "rc=yes")
	}) {
		t.Fatalf("옮긴 디렉터리의 사용자 rc 가 실행되지 않았다:\n%q", captured.snapshot())
	}
}
