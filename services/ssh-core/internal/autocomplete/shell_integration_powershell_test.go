package autocomplete

import (
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

// PowerShell 통합에서 실기기로 두 번 깨진 자리를 잠근다. 자세한 경위는
// powerShellIntegrationScript 주석에 있다.

// 명령 시작(C)을 PSReadLine 의 AddToHistoryHandler 에 걸면 안 된다.
//
// PSReadLine 은 기동 시 히스토리 파일을 읽으며 **줄마다** 그 핸들러를 부른다. 실기기에서
// 히스토리 394줄이 C 372개가 되어(짝이 되는 D 는 없다) 블록 372개가 running 으로 남았고, 끝을
// 모르는 running 블록은 화면 끝까지 칠해지므로 터미널을 열면 화면 전체가 한 블록이 됐다.
func TestPowerShellCommandStartIsNotWiredToHistory(t *testing.T) {
	script := PowerShellIntegrationScript()
	for _, forbidden := range []string{"AddToHistoryHandler", "Set-PSReadLineOption"} {
		if strings.Contains(script, forbidden) {
			t.Errorf(
				"%s 로 명령 시작을 잡으면 안 된다 — 히스토리 로드마다 발화해 유령 블록이 생긴다",
				forbidden,
			)
		}
	}
	// 대신 호스트가 한 줄을 읽을 때만 불리는 자리를 감싼다.
	if !strings.Contains(script, "PSConsoleHostReadLine") {
		t.Error("PSConsoleHostReadLine 훅이 없다 — 명령 시작(C)을 알 방법이 사라진다")
	}
	// 그 훅은 셸이 받아들인 명령 원문을 E 로 올려 보낸다(zsh 와 같은 계약).
	if !strings.Contains(script, "'E;'") {
		t.Error("명령 원문(133;E)을 보내지 않는다 — 앱이 화면에서 명령을 읽어야 한다")
	}
}

// prompt 함수는 마커를 즉시 쓰지 않고 **반환 문자열로** 조립해야 한다.
//
// PowerShell 은 prompt 의 반환값을 화면에 쓴다. 함수 안에서 [Console]::Write 로 즉시 쓰면 그
// 바이트가 프롬프트보다 앞에 놓이는데, B(입력 시작)가 그렇게 앞으로 가면 앱이 기록하는
// promptEndX 가 0 이 되어 화면에서 명령을 읽을 때 프롬프트까지 읽힌다 — 재실행·복사에
// `PS C:\Users\...> pwd` 가 들어간 원인이다.
//
// 즉시 쓰기가 필요한 곳은 ReadLine 훅 하나뿐이다(그쪽은 반환값이 명령 원문이라 마커를 실을 수
// 없다). 그래서 [Console]::Write 는 정확히 한 번만 나와야 한다.
func TestPowerShellPromptMarkersRideTheReturnValue(t *testing.T) {
	script := PowerShellIntegrationScript()
	if got := strings.Count(script, "[Console]::Write"); got != 1 {
		t.Errorf(
			"[Console]::Write 가 %d 번 나온다 — ReadLine 훅의 1번만 허용한다(prompt 는 반환값으로 실어 보낸다)",
			got,
		)
	}
	// 그 하나는 prompt 정의보다 앞(=__ds_hook 안)에 있어야 한다.
	promptAt := strings.Index(script, "function global:prompt {")
	writeAt := strings.Index(script, "[Console]::Write")
	if promptAt < 0 {
		t.Fatal("스크립트에 prompt 함수가 없다")
	}
	if writeAt > promptAt {
		t.Error("prompt 쪽에서 즉시 쓰고 있다 — 마커가 프롬프트보다 앞에 놓인다")
	}
	// 반환 문자열에서 B 는 프롬프트 뒤여야 한다.
	rendered := strings.Index(script, "$rendered +")
	marker := strings.Index(script, `(__ds_o 'B')`)
	if rendered < 0 || marker < 0 || rendered > marker {
		t.Error("반환 문자열이 프롬프트 뒤에 B 를 붙이지 않는다")
	}
}

// 실제로 돌려 마커 순서를 확인한다. 구조 검사와 달리 이쪽은 PowerShell 이 무엇을 화면에 쓰는지
// 본다 — B 가 프롬프트 앞으로 가는 회귀를 여기서 잡는다.
func TestPowerShellIntegrationEmitsMarkersInOrder(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("PowerShell 은 Windows 에서만 확인한다")
	}
	path, err := exec.LookPath("powershell")
	if err != nil {
		t.Skip("powershell not available")
	}
	command := strings.TrimRight(PowerShellIntegrationInitCommand(), "\r") + "; prompt"
	output, err := exec.Command(path, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command).Output()
	if err != nil {
		t.Fatalf("PowerShell failed to run init command: %v", err)
	}
	got := string(output)

	// D → A → cwd → 프롬프트 → B. 프롬프트는 기본 프롬프트의 `PS ` 로 찾는다.
	order := []string{"]133;D;", "]133;A", "]7;file:", "PS ", "]133;B"}
	previous := -1
	for _, want := range order {
		at := strings.Index(got, want)
		if at < 0 {
			t.Fatalf("출력에 %q 가 없다: %q", want, got)
		}
		if at < previous {
			t.Fatalf("%q 가 앞선 마커보다 먼저 왔다: %q", want, got)
		}
		previous = at
	}
	// 프롬프트를 실행만 했으므로 명령은 없었다 — C 가 오면 안 된다.
	if strings.Contains(got, "]133;C") {
		t.Errorf("명령 없이 C 가 왔다: %q", got)
	}
}
