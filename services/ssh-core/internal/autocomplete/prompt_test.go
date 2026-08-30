package autocomplete

import "testing"

func TestLooksLikeShellPrompt(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  bool
	}{
		{"bash prompt", "user@host:~$ ", true},
		{"root prompt", "root@host:/etc# ", true},
		{"zsh percent", "host% ", true},
		{"starship arrow", "~/proj ❯ ", true},
		{"omz arrow", "➜  proj ", false}, // trailing text after glyph, not a settled prompt tail
		{"prompt with ansi color", "\x1b[32muser@host\x1b[0m:~$ ", true},
		{"prompt with osc cwd then marker", "\x1b]7;file://host/home\x07user@host:~$ ", true},
		{"password prompt", "user@host's password: ", false},
		{"sudo password", "[sudo] password for user: ", false},
		{"pager status", "Manual page ls(1) line 1 (press h for help or q to quit)", false},
		{"empty", "", false},
		{"whitespace only", "   \r\n", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := LooksLikeShellPrompt(tc.value); got != tc.want {
				t.Fatalf("LooksLikeShellPrompt(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}

func TestStripTerminalControls(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  string
	}{
		{"plain", "hello", "hello"},
		{"csi color", "\x1b[31mred\x1b[0m", "red"},
		{"osc bel", "\x1b]0;title\x07text", "text"},
		{"osc st", "\x1b]7;file://h/p\x1b\\text", "text"},
		{"keeps newlines and tabs", "a\tb\r\nc", "a\tb\r\nc"},
		{"drops bare control", "a\x01b", "ab"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := StripTerminalControls(tc.value); got != tc.want {
				t.Fatalf("StripTerminalControls(%q) = %q, want %q", tc.value, got, tc.want)
			}
		})
	}
}

func TestLooksLikeWindowsCommandLinePrompt(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  bool
	}{
		{"cmd prompt", "C:\\Users\\me>", true},
		{"cmd short prompt", "C:\\>", true},
		{"cmd lowercase drive", "d:\\work>", true},
		// "PS X:\" is caught earlier by LooksLikePowerShellPrompt; this function
		// only needs the drive-prompt shapes that one misses.
		{"powershell default", "PS C:\\Users\\me>", false},
		{"posix home prompt", "user@host:~$", false},
		{"posix path prompt", "user@host:/tmp/$", false},
		{"bash version prompt", "bash-5.2$", false},
		{"c drive mentioned mid-line", "echo C:\\temp", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := LooksLikeWindowsCommandLinePrompt(tc.value); got != tc.want {
				t.Fatalf("LooksLikeWindowsCommandLinePrompt(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}
