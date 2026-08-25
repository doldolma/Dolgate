package localsession

import "testing"

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
