package autocomplete

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// TestShellIntegrationScriptIsDashSafe guards the subshell re-injection path:
// the guarded bash/zsh init commands are written into whatever shell is in the
// foreground of a subshell (nested ssh, sudo su, docker exec). A POSIX sh
// (dash) subshell parses the whole line before running it, so any bash/zsh-only
// syntax outside the executed branch (notably the `name+=(...)` array append)
// makes dash abort with a visible "Syntax error" that the user would see once
// the handshake flushes. Every command must parse under dash and run as a silent
// no-op there.
//
// 셸을 모를 때 보내는 것이 곧 이 목록이다(bash 용·zsh 용).
func TestShellIntegrationScriptIsDashSafe(t *testing.T) {
	// Structural guard (always runs, no dash needed): every zsh array append must
	// stay wrapped in eval so dash's parser only sees an opaque string.
	// 줄들은 한 명령의 조각이다 — 이어 붙인 것이 dash 가 읽는 전체다.
	script := strings.Join(ShellIntegrationInitLines(""), "\n")
	for _, name := range []string{"precmd_functions+=(", "preexec_functions+=("} {
		total := strings.Count(script, name)
		wrapped := strings.Count(script, "eval '"+name)
		if total != wrapped {
			t.Fatalf("%s appears %d times but only %d are eval-wrapped; a bare += breaks dash parsing", name, total, wrapped)
		}
	}

	dash, err := exec.LookPath("dash")
	if err != nil {
		t.Skip("dash not available; structural guard covered the regression")
	}

	f, err := os.CreateTemp("", "dolgate-si-*.sh")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	// 파일로 돌릴 때는 줄 끝의 CR 이 필요 없다(그건 tty 주입용이다).
	if _, err := f.WriteString(strings.ReplaceAll(script, "\r", "") + "\n"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	if out, err := exec.Command(dash, "-n", f.Name()).CombinedOutput(); err != nil {
		t.Fatalf("dash -n rejected the script (would break a sh subshell): %v\n%s", err, out)
	}
	out, err := exec.Command(dash, f.Name()).CombinedOutput()
	if err != nil {
		t.Fatalf("dash exec failed: %v\n%s", err, out)
	}
	if len(out) != 0 {
		t.Fatalf("dash exec produced output (would show as garbage in a sh subshell): %q", out)
	}
}
