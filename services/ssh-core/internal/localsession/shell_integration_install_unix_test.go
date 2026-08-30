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

// 로컬 셸은 **바로 준비되지 않는다.** rc 파일(oh-my-zsh 등)이 도는 동안 tty 는 아직 줄 편집기
// 없이 echo 만 하므로, 그 틈에 통합 스크립트를 타이핑하면 그 원문이 화면에 그대로 찍힌다.
// 실기기에서 로컬 터미널을 열면 스크립트가 두 번 찍힌 채 실행되지도 않았다.
func TestInstallShellIntegrationWaitsForASlowStartingShell(t *testing.T) {
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash 가 없다")
	}
	rcPath := filepath.Join(t.TempDir(), "rc")
	// rc 가 도는 동안이 "셸이 아직 준비되지 않은" 구간이다. 프롬프트는 고정해서 찾기 쉽게 둔다.
	if err := os.WriteFile(rcPath, []byte("sleep 0.6\nPS1='ready$ '\n"), 0o600); err != nil {
		t.Fatalf("rc 파일 작성 실패: %v", err)
	}

	captured := &unixCapturedOutput{}
	manager := NewManager(
		func(protocol.Event) {},
		func(_ protocol.StreamFrame, data []byte) { captured.append(data) },
	)
	if err := manager.Connect("session-1", "request-1", protocol.LocalConnectPayload{
		Cols:       120,
		Rows:       32,
		Executable: bashPath,
		Args:       []string{"--noprofile", "--rcfile", rcPath, "-i"},
		ShellKind:  "bash",
	}); err != nil {
		t.Fatalf("로컬 셸 연결 실패: %v", err)
	}
	t.Cleanup(func() { _ = manager.Disconnect("session-1") })

	// 연결 직후에 설치를 요청한다 — 렌더러가 하는 그대로다.
	if err := manager.InstallShellIntegration("session-1"); err != nil {
		t.Fatalf("셸 통합 설치 실패: %v", err)
	}

	// 프롬프트가 뜨고(0.6s) 스크립트가 실행되고 마커가 오갈 시간을 준다.
	time.Sleep(3 * time.Second)
	// 런타임이 하는 것과 같다 — 마커가 오지 않으면 붙잡고 있던 출력을 그대로 내보낸다.
	manager.FlushShellIntegration("session-1")
	time.Sleep(300 * time.Millisecond)

	output := captured.snapshot()
	if strings.Contains(output, "__ds_o") {
		t.Fatalf("주입 스크립트가 화면에 남았다:\n%q", output)
	}
	// 붙잡은 것을 끝내 내보내지 않는 것도 버그다(빈 화면).
	if !strings.Contains(output, "ready$") {
		t.Fatalf("프롬프트가 화면에 오지 않았다:\n%q", output)
	}
	// 마커가 왔다 = 스크립트가 실제로 실행됐다. 예전에는 canonical 모드에서 잘려 실행되지 않았다.
	if !strings.Contains(output, "\x1b]133;A") {
		t.Fatalf("프롬프트 마커가 오지 않았다(스크립트가 실행되지 않았다):\n%q", output)
	}
	// 프롬프트를 보고 주입하므로 그 줄을 지운다 — 지우지 않으면 한 줄에 프롬프트가 두 번 남는다.
	erase := strings.LastIndex(output, "\r\x1b[2K")
	if erase < 0 {
		t.Fatalf("프롬프트 줄을 지우지 않았다:\n%q", output)
	}
	// bash/readline may paint the prompt, clear to the right, then use a bare CR
	// to repaint the same terminal row. Both copies exist in the byte stream,
	// but the earlier one is overwritten on screen and is not a second prompt.
	visibleTail := tailAfterLastBareCarriageReturn(output[erase:])
	if count := strings.Count(visibleTail, "ready$"); count != 1 {
		t.Fatalf("지운 뒤에도 프롬프트가 %d번 남았다:\n%q", count, output)
	}
}

func tailAfterLastBareCarriageReturn(value string) string {
	start := 0
	for index := 0; index < len(value); index++ {
		if value[index] == '\r' && (index+1 == len(value) || value[index+1] != '\n') {
			start = index + 1
		}
	}
	return value[start:]
}
