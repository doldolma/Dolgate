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

// 프로브는 안착한 프롬프트가 분명하면 현재 전면 셸을 따르고, 모호할 때만 최초 러너로 물러난다.
func TestProbeCommandFollowsTheSettledPromptBeforeTheLaunchedShell(t *testing.T) {
	for _, tc := range []struct {
		name  string
		shell string
		tail  string
		want  string
		ok    bool
	}{
		{name: "bash", shell: "bash", want: autocomplete.ShellProbeCommand(), ok: true},
		{name: "이름 없음", shell: "", want: autocomplete.ShellProbeCommand(), ok: true},
		// 프롬프트 정보가 없으면 최초 러너가 안전한 기본값이다.
		{name: "pwsh", shell: "pwsh", want: autocomplete.PowerShellProbeCommand(), ok: true},
		{name: "powershell.exe", shell: `C:\Windows\System32\powershell.exe`, want: autocomplete.PowerShellProbeCommand(), ok: true},
		// 교차 셸에서는 최초 러너가 아니라 새로 안착한 프롬프트를 따른다.
		{name: "PowerShell에서 Git Bash", shell: "powershell", tail: "Computer@host MINGW64 ~\r\n$ ", want: autocomplete.ShellProbeCommand(), ok: true},
		{name: "bash에서 PowerShell", shell: "bash", tail: `PS C:\Users\Computer> `, want: autocomplete.PowerShellProbeCommand(), ok: true},
		{name: "cmd에서 WSL", shell: "cmd", tail: "user@host:~$ ", want: autocomplete.ShellProbeCommand(), ok: true},
		// cmd 는 물어볼 방법도 넣을 것도 없다.
		{name: "cmd", shell: "cmd", ok: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := probeCommandFor(tc.shell, []byte(tc.tail))
			if ok != tc.ok {
				t.Fatalf("ok=%v, 기대 %v", ok, tc.ok)
			}
			if ok && got != tc.want {
				t.Fatalf("프로브가 다르다:\nwant %q\ngot  %q", tc.want, got)
			}
		})
	}
}
