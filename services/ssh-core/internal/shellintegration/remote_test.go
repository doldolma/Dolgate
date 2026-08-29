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
