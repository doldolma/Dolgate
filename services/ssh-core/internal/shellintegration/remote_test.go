package shellintegration

import "testing"

func TestNormalizeRemoteShellProbeOutput(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want string
	}{
		{name: "bash version", out: "bash\n/bin/zsh\n", want: "bash"},
		{name: "login path", out: "/usr/local/bin/fish\n", want: "fish"},
		{name: "powershell is not typable", out: "/usr/local/bin/pwsh\n", want: ""},
		{name: "unsupported", out: "/bin/dash\n", want: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := NormalizeRemoteShellProbeOutput([]byte(test.out)); got != test.want {
				t.Fatalf("NormalizeRemoteShellProbeOutput() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestNormalizeRemoteShellAllowsOnlyTypableRemoteShells(t *testing.T) {
	tests := []struct {
		value string
		want  string
	}{
		{value: "/bin/bash", want: "bash"},
		{value: "zsh", want: "zsh"},
		{value: "/opt/homebrew/bin/fish", want: "fish"},
		{value: "pwsh", want: ""},
		{value: "powershell.exe", want: ""},
		{value: "dash", want: ""},
	}
	for _, test := range tests {
		if got := NormalizeRemoteShell(test.value); got != test.want {
			t.Errorf("NormalizeRemoteShell(%q) = %q, want %q", test.value, got, test.want)
		}
	}
}
