//go:build windows

package localsession

import (
	"encoding/base64"
	"strings"
	"testing"
	"unicode/utf16"

	"dolssh/services/ssh-core/internal/autocomplete"
)

// 셸 통합을 stdin 으로 타이핑하면 셸이 그 줄을 echo 하고, 그것을 화면에서 걷어내는 과정에서
// 줄바꿈까지 사라져 conhost 와 화면의 커서가 어긋난다(스크립트가 1385 바이트라 200 칸 화면에서
// 7 행). 실기기에서 첫 프롬프트가 두 번 찍히고 첫 입력이 7 행 아래에 찍혔다. 그래서 PowerShell
// 에는 기동 인자로 넣는다.
func TestPowerShellSpawnCarriesTheIntegration(t *testing.T) {
	for _, kind := range []string{windowsShellKindPwsh, windowsShellKindPowerShell} {
		args, preinstalled := withShellIntegrationArgs(kind, []string{"-NoLogo", "-NoProfile"})
		if !preinstalled {
			t.Fatalf("%s: 기동 인자로 통합을 넣지 않았다", kind)
		}
		// 기존 인자는 유지되어야 한다.
		if args[0] != "-NoLogo" || args[1] != "-NoProfile" {
			t.Fatalf("%s: 기존 인자가 사라졌다: %v", kind, args)
		}
		// -EncodedCommand 는 마지막이어야 한다(뒤의 인자는 전부 명령으로 취급된다).
		if len(args) < 4 || args[len(args)-2] != "-EncodedCommand" {
			t.Fatalf("%s: -EncodedCommand 가 마지막 인자가 아니다: %v", kind, args)
		}
		if !contains(args, "-NoExit") {
			t.Fatalf("%s: -NoExit 이 없다 — 스크립트 실행 후 셸이 종료된다", kind)
		}

		decoded := decodeUTF16Base64(t, args[len(args)-1])
		if decoded != autocomplete.PowerShellIntegrationScript() {
			t.Fatalf("%s: 인코딩된 스크립트가 원본과 다르다", kind)
		}
		// 화면에 echo 될 형태(앞 공백·끝 CR)가 섞여 들어가면 안 된다.
		if strings.HasPrefix(decoded, " ") || strings.HasSuffix(decoded, "\r") {
			t.Fatalf("%s: stdin 주입용 형태가 그대로 들어갔다", kind)
		}
	}
}

// cmd.exe 처럼 통합이 없는 셸은 건드리지 않는다.
func TestNonPowerShellSpawnIsUntouched(t *testing.T) {
	base := []string{"/K", "echo hi"}
	args, preinstalled := withShellIntegrationArgs(windowsShellKindCmd, base)
	if preinstalled {
		t.Fatal("cmd 에 통합을 넣었다")
	}
	if len(args) != len(base) {
		t.Fatalf("cmd 인자가 바뀌었다: %v", args)
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func decodeUTF16Base64(t *testing.T, encoded string) string {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("base64 디코딩 실패: %v", err)
	}
	if len(raw)%2 != 0 {
		t.Fatalf("UTF-16LE 가 아니다(홀수 바이트 %d)", len(raw))
	}
	units := make([]uint16, 0, len(raw)/2)
	for index := 0; index < len(raw); index += 2 {
		units = append(units, uint16(raw[index])|uint16(raw[index+1])<<8)
	}
	return string(utf16.Decode(units))
}
