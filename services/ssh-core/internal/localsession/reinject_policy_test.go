package localsession

import (
	"testing"

	"dolssh/services/ssh-core/internal/autocomplete"
)

func TestShouldArmSubshellReinject(t *testing.T) {
	for _, tc := range []struct {
		name  string
		shell string
		want  bool
	}{
		// 힌트를 알면 그 셸 것 한 줄로 나간다.
		{"bash", "bash", true},
		{"zsh", "zsh", true},
		{"fish", "fish", true},
		{"pwsh", "pwsh", true},
		{"powershell", "powershell", true},

		// 모르면 bash·zsh 겸용이 나간다. `wsl`·`ssh` 처럼 대상 셸이 명령에 없는 경우가 이쪽이고,
		// 그 끝은 대개 POSIX 셸이다 — 윈도우에서도 막지 않는다(막으면 WSL 에 통합이 없다).
		{"모름", "", true},

		// 훅을 걸 수 없는 셸.
		{"dash", "dash", false},
		{"ksh", "ksh", false},
		{"cmd", "cmd", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldArmSubshellReinject(tc.shell); got != tc.want {
				t.Fatalf("shouldArmSubshellReinject(%q) = %v, want %v", tc.shell, got, tc.want)
			}
		})
	}
}

// 프로브는 **우리가 띄운 셸**로 고른다. 사용자가 친 명령이 아니라 프로세스 이름이라 틀릴 수 없다.
func TestProbeCommandFollowsTheLaunchedShell(t *testing.T) {
	for _, tc := range []struct {
		name  string
		shell string
		want  string
		ok    bool
	}{
		{name: "bash", shell: "bash", want: autocomplete.ShellProbeCommand(), ok: true},
		{name: "이름 없음", shell: "", want: autocomplete.ShellProbeCommand(), ok: true},
		// PowerShell 에 printf 를 보내면 "인식할 수 없는 명령" 이 화면에 남는다.
		{name: "pwsh", shell: "pwsh", want: autocomplete.PowerShellProbeCommand(), ok: true},
		{name: "powershell.exe", shell: `C:\Windows\System32\powershell.exe`, want: autocomplete.PowerShellProbeCommand(), ok: true},
		// cmd 는 물어볼 방법도 넣을 것도 없다.
		{name: "cmd", shell: "cmd", ok: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := probeCommandFor(tc.shell)
			if ok != tc.ok {
				t.Fatalf("ok=%v, 기대 %v", ok, tc.ok)
			}
			if ok && got != tc.want {
				t.Fatalf("프로브가 다르다:\nwant %q\ngot  %q", tc.want, got)
			}
		})
	}
}
