//go:build !windows

package localsession

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
)

// 서브셸(중첩 bash)에 들어간 뒤 통합이 다시 살아나는지. 렌더러가 입력에서 진입을 감지해
// ReinjectShellIntegration 을 부르는 그 지점부터 재현한다.
//
// 부르는 **시점**이 중요하다 — 게이트는 Arm 이후에 오는 출력만 본다. 서브셸 프롬프트가 이미
// 찍힌 뒤에 부르면 볼 것이 없어 기다림이 끝날 때까지 아무 일도 일어나지 않는다(그 경로는
// onTimeout 이 no-op 이다). 렌더러는 입력을 보고 바로 부르므로 제때 무장한다.
func TestReinjectShellIntegrationIntoASubshell(t *testing.T) {
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash 가 없다")
	}
	dir := t.TempDir()
	outerRc := filepath.Join(dir, "outer")
	innerRc := filepath.Join(dir, "inner")
	if err := os.WriteFile(outerRc, []byte("PS1='outer$ '\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(innerRc, []byte("PS1='inner$ '\n"), 0o600); err != nil {
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
	// 접속 통합이 붙을 때까지 기다린다(마커가 오면 붙은 것이다).
	if !waitFor(t, 6*time.Second, func() bool {
		return strings.Contains(captured.snapshot(), "\x1b]133;A")
	}) {
		t.Fatalf("접속 통합이 붙지 않았다:\n%q", captured.snapshot())
	}
	markersBefore := strings.Count(captured.snapshot(), "\x1b]133;A")

	// 사용자가 서브셸로 들어간다.
	if err := manager.WriteBytes("s1", []byte("bash --noprofile --rcfile "+innerRc+" -i\r")); err != nil {
		t.Fatal(err)
	}
	// 렌더러는 **입력을 보고** 바로 부른다(서브셸 프롬프트가 뜨기 전이다).
	if err := manager.ReinjectShellIntegration("s1", ""); err != nil {
		t.Fatal(err)
	}
	if !waitFor(t, 6*time.Second, func() bool {
		return strings.Contains(captured.snapshot(), "inner$")
	}) {
		t.Fatalf("서브셸 프롬프트가 오지 않았다:\n%q", captured.snapshot())
	}

	if !waitFor(t, 10*time.Second, func() bool {
		return strings.Count(captured.snapshot(), "\x1b]133;A") > markersBefore
	}) {
		t.Fatalf("서브셸에 통합이 다시 붙지 않았다:\n%q", captured.snapshot())
	}
	output := captured.snapshot()
	if strings.Contains(output, "__ds_o") {
		t.Fatalf("주입 스크립트가 화면에 남았다:\n%q", output)
	}
}

// 줄 편집기가 없는 서브셸(bash --noediting = readline 없음. sh·dash·busybox·컨테이너 셸이 이
// 상태다)은 프롬프트에서도 canonical 모드로 읽는다 — 한 줄이 MAX_CANON(1024)을 넘으면 잘린다.
// 그래서 셸을 모를 때도 조각을 나눠 보낸다. 합본(1213B)이던 동안 이 경로가 죽어 있었다.
func TestReinjectShellIntegrationIntoASubshellWithoutLineEditor(t *testing.T) {
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash 가 없다")
	}
	dir := t.TempDir()
	outerRc := filepath.Join(dir, "outer")
	innerRc := filepath.Join(dir, "inner")
	if err := os.WriteFile(outerRc, []byte("PS1='outer$ '\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(innerRc, []byte("PS1='inner$ '\n"), 0o600); err != nil {
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
	if !waitFor(t, 6*time.Second, func() bool {
		return strings.Contains(captured.snapshot(), "\x1b]133;A")
	}) {
		t.Fatalf("접속 통합이 붙지 않았다:\n%q", captured.snapshot())
	}
	markersBefore := strings.Count(captured.snapshot(), "\x1b]133;A")

	if err := manager.WriteBytes("s1", []byte(
		"bash --noediting --noprofile --rcfile "+innerRc+" -i\r",
	)); err != nil {
		t.Fatal(err)
	}
	if err := manager.ReinjectShellIntegration("s1", ""); err != nil {
		t.Fatal(err)
	}
	if !waitFor(t, 10*time.Second, func() bool {
		return strings.Count(captured.snapshot(), "\x1b]133;A") > markersBefore
	}) {
		t.Fatalf("줄 편집기 없는 서브셸에 통합이 붙지 않았다:\n%q", captured.snapshot())
	}
	if output := captured.snapshot(); strings.Contains(output, "__ds_o") {
		t.Fatalf("주입 스크립트가 화면에 남았다:\n%q", output)
	}
}

// 셸을 알려 주면 그 셸 것만 보낸다.
//
// fish 서브셸이 이 힌트로 살아난다 — 모른 채 POSIX 겸용을 보내면 fish 가 `__ds_o(){ … }` 를
// 파싱하지 못해 오류가 화면에 남는다. 이름은 알지만 훅을 걸 방법이 없는 셸(dash 등)에는 아예
// 보내지 않는다.
func TestReinjectShellIntegrationUsesTheShellHint(t *testing.T) {
	for _, tc := range []struct {
		name  string
		shell string
		want  []string
	}{
		{name: "fish", shell: "fish", want: []string{autocomplete.FishShellIntegrationInitCommand()}},
		{name: "bash", shell: "bash", want: []string{autocomplete.BashShellIntegrationInitCommand()}},
		{name: "모름", shell: "", want: autocomplete.ShellIntegrationInitLines("")},
		{name: "지원 안 함", shell: "dash", want: nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reader, writer := io.Pipe()
			runner := &fakeRunner{done: make(chan struct{}), output: reader}
			defer close(runner.done)
			t.Cleanup(func() { _ = writer.Close() })
			manager := newTestManager(runner)
			if err := manager.Connect("s1", "r1", protocol.LocalConnectPayload{}); err != nil {
				t.Fatal(err)
			}
			// 접속 통합이 끼어들지 않게 그쪽 게이트는 건드리지 않는다(설치를 부르지 않는다).
			if err := manager.ReinjectShellIntegration("s1", tc.shell); err != nil {
				t.Fatal(err)
			}
			if _, err := writer.Write([]byte("user@host ~ % ")); err != nil {
				t.Fatal(err)
			}

			if len(tc.want) == 0 {
				time.Sleep(700 * time.Millisecond)
				if got := runner.writeCount(); got != 0 {
					t.Fatalf("훅을 걸 수 없는 셸에 %d줄을 보냈다", got)
				}
				return
			}
			if !waitFor(t, 3*time.Second, func() bool { return runner.writeCount() == len(tc.want) }) {
				t.Fatalf("보낸 줄이 %d개, 기대 %d개", runner.writeCount(), len(tc.want))
			}
			for index, want := range tc.want {
				if got := string(runner.writeAt(index)); got != want {
					t.Fatalf("%d번째 줄이 다르다:\nwant %q\ngot  %q", index, want, got)
				}
			}
		})
	}
}
