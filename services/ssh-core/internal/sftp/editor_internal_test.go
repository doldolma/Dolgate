package sftp

import (
	"strings"
	"testing"

	"dolssh/services/ssh-core/internal/protocol"
)

func TestLooksBinary(t *testing.T) {
	if looksBinary([]byte("plain text\nwith lines\n")) {
		t.Fatal("text content should not be flagged as binary")
	}
	if !looksBinary([]byte{'a', 'b', 0x00, 'c'}) {
		t.Fatal("content with a NUL byte should be flagged as binary")
	}
	if looksBinary(nil) {
		t.Fatal("empty content should not be flagged as binary")
	}
}

func TestBuildSudoInstallCommand(t *testing.T) {
	got := buildSudoInstallCommand("sudo -S -p ''", "0644", "/tmp/.dolgate-edit-1.tmp", "/etc/nginx/nginx.conf")
	want := "sudo -S -p '' install -m 0644 -- '/tmp/.dolgate-edit-1.tmp' '/etc/nginx/nginx.conf'"
	if got != want {
		t.Fatalf("unexpected command:\n got: %s\nwant: %s", got, want)
	}

	gotRoot := buildSudoInstallCommand("", "0600", "/tmp/x", "/root/secret")
	if strings.HasPrefix(gotRoot, "sudo") {
		t.Fatalf("root command must not be prefixed with sudo: %s", gotRoot)
	}
	if !strings.Contains(gotRoot, "install -m 0600 -- '/tmp/x' '/root/secret'") {
		t.Fatalf("unexpected root command: %s", gotRoot)
	}

	// A single quote embedded in a path must be escaped so it cannot break out.
	gotInjection := buildSudoInstallCommand("", "0644", "/tmp/x", "/tmp/a'; touch pwned; '")
	if !strings.Contains(gotInjection, `'"'"'`) {
		t.Fatalf("embedded quote was not escaped, command is injectable: %s", gotInjection)
	}
}

func TestSudoInvocationKeepsPasswordOnStdin(t *testing.T) {
	s := New(func(protocol.Event) {})
	handle := &endpointHandle{}

	prefix, stdin := s.sudoInvocation("missing-endpoint", handle, "hunter2")
	if prefix != "sudo -S -p ''" {
		t.Fatalf("expected password sudo prefix, got %q", prefix)
	}
	if string(stdin) != "hunter2\n" {
		t.Fatalf("expected password on stdin, got %q", string(stdin))
	}
	if strings.Contains(prefix, "hunter2") {
		t.Fatal("password must never appear in the command string")
	}

	prefixNoPw, stdinNoPw := s.sudoInvocation("missing-endpoint", handle, "")
	if prefixNoPw != "sudo -n" || stdinNoPw != nil {
		t.Fatalf("expected non-interactive sudo with no stdin, got %q / %q", prefixNoPw, string(stdinNoPw))
	}

	handle.sudoPassword = "cached"
	prefixCached, stdinCached := s.sudoInvocation("missing-endpoint", handle, "")
	if prefixCached != "sudo -S -p ''" || string(stdinCached) != "cached\n" {
		t.Fatalf("expected cached password on stdin, got %q / %q", prefixCached, string(stdinCached))
	}
}
