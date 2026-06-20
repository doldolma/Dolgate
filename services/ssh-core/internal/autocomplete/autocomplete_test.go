package autocomplete

import (
	"bytes"
	"os/exec"
	"strings"
	"testing"
)

func TestParseSnapshot(t *testing.T) {
	var payload bytes.Buffer
	writeFields(&payload, "S", "zsh")
	writeFields(&payload, "H", ": 1710000000:0;sudo systemctl status nginx")
	writeFields(&payload, "H", "sudo systemctl status nginx")
	writeFields(&payload, "H", "bad\ncommand")
	writeFields(&payload, "E", "git", "/usr/bin/git")
	writeFields(&payload, "E", "git", "/opt/bin/git")

	result := ParseSnapshot(payload.Bytes(), 3)
	if result.Capability.Status != "ready" || result.Capability.Shell != "zsh" {
		t.Fatalf("unexpected capability: %#v", result.Capability)
	}
	if result.Snapshot == nil || len(result.Snapshot.History) != 2 {
		t.Fatalf("unexpected history: %#v", result.Snapshot)
	}
	if len(result.Snapshot.Executables) != 1 || result.Snapshot.Executables[0].Path != "/usr/bin/git" {
		t.Fatalf("unexpected executables: %#v", result.Snapshot.Executables)
	}
}

func TestCollectorCommandsAreValidShellSyntax(t *testing.T) {
	// Validate POSIX syntax via whatever `sh` is on PATH (git-bash on Windows
	// runners); skip if none is available.
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh not available")
	}
	for _, command := range []string{RemoteSnapshotCommand(), InBandProbeCommand("nonce-1")} {
		if output, err := exec.Command(sh, "-n", "-c", command).CombinedOutput(); err != nil {
			t.Fatalf("invalid command: %v\n%s", err, output)
		}
	}
}

func TestUnsupportedShell(t *testing.T) {
	var payload bytes.Buffer
	writeFields(&payload, "S", "fish")
	result := ParseSnapshot(payload.Bytes(), 1)
	if result.Capability.Status != "unsupported" || result.Snapshot != nil {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestShellIntegrationInitCommandParses(t *testing.T) {
	command := strings.TrimRight(ShellIntegrationInitCommand(), "\r")
	for _, shell := range []string{"bash", "zsh"} {
		t.Run(shell, func(t *testing.T) {
			path, err := exec.LookPath(shell)
			if err != nil {
				t.Skipf("%s not available", shell)
			}
			if output, err := exec.Command(path, "-n", "-c", command).CombinedOutput(); err != nil {
				t.Fatalf("%s failed to parse init command: %v\n%s", shell, err, output)
			}
		})
	}
}

func TestShellIntegrationInitCommandStructure(t *testing.T) {
	command := ShellIntegrationInitCommand()
	for _, want := range []string{
		"BASH_VERSION", "ZSH_VERSION", `133;%s`, "133;B", "133;C",
		"PROMPT_COMMAND", "precmd_functions", "preexec_functions",
	} {
		if !strings.Contains(command, want) {
			t.Errorf("init command missing %q", want)
		}
	}
	if !strings.HasPrefix(command, " ") {
		t.Error("init command must start with a space for history hygiene")
	}
}

func TestHandshakeFilterSuppressesEchoUntilPromptMarker(t *testing.T) {
	var filter HandshakeFilter

	// The injected command echo and the stale prompt are buffered (suppressed).
	if forward, done := filter.Filter([]byte(" __ds_o(){ ...; }; history -d")); len(forward) != 0 || done {
		t.Fatalf("expected echo to be suppressed, got %q done=%v", forward, done)
	}
	// The prompt marker arrives mid-chunk: drop everything before it, forward
	// from the marker onward, and report the handshake as done.
	chunk := []byte("leftover echo\r\n" + PromptStartMarker + "user@host:~$ ")
	forward, done := filter.Filter(chunk)
	if !done {
		t.Fatal("expected handshake to complete on the marker chunk")
	}
	if !strings.HasPrefix(string(forward), PromptStartMarker) {
		t.Fatalf("forwarded bytes should start at the marker, got %q", forward)
	}
	if strings.Contains(string(forward), "leftover echo") || strings.Contains(string(forward), "__ds_o") {
		t.Fatalf("pre-marker echo leaked into output: %q", forward)
	}
	// After the handshake everything passes through untouched.
	if forward, done := filter.Filter([]byte("ls -la\r\n")); string(forward) != "ls -la\r\n" || done {
		t.Fatalf("expected passthrough after handshake, got %q done=%v", forward, done)
	}
}

func TestHandshakeFilterFlushPreservesOutputOnTimeout(t *testing.T) {
	var filter HandshakeFilter
	filter.Filter([]byte("partial output without a marker"))
	flushed := filter.Flush()
	if string(flushed) != "partial output without a marker" {
		t.Fatalf("flush should return buffered output, got %q", flushed)
	}
	if !filter.Done() {
		t.Fatal("filter should be done after flush")
	}
	if forward, _ := filter.Filter([]byte("more")); string(forward) != "more" {
		t.Fatalf("expected passthrough after flush, got %q", forward)
	}
}

func TestHandshakeFilterStripsInjectedEchoAfterMarker(t *testing.T) {
	var filter HandshakeFilter
	// Prompt marker + prompt text + the injected command echoed again as a prompt
	// redraw right after the marker (the slow-host failure mode).
	chunk := append([]byte(PromptStartMarker+"user@host:~$ "), injectedCommandEcho...)
	forward, done := filter.Filter(chunk)
	if !done {
		t.Fatal("expected handshake to complete on the marker chunk")
	}
	if bytes.Contains(forward, injectedCommandEcho) {
		t.Fatalf("injected echo leaked after the marker: %q", forward)
	}
	if !bytes.Contains(forward, []byte("user@host:~$ ")) {
		t.Fatalf("prompt text should be preserved: %q", forward)
	}
}

func TestHandshakeFilterStripsInjectedEchoAfterDone(t *testing.T) {
	var filter HandshakeFilter
	if _, done := filter.Filter([]byte(PromptStartMarker)); !done {
		t.Fatal("expected handshake to complete on the marker")
	}
	chunk := append([]byte("user@host:~$ "), injectedCommandEcho...)
	if forward, _ := filter.Filter(chunk); bytes.Contains(forward, injectedCommandEcho) {
		t.Fatalf("injected echo leaked after the handshake: %q", forward)
	}
}

func TestHandshakeFilterFlushStripsInjectedEcho(t *testing.T) {
	var filter HandshakeFilter
	// Marker never arrives: a login banner and the injected echo accumulate, then
	// the timeout flushes. The banner must survive; the injection must not.
	filter.Filter(append([]byte("login banner\r\n"), injectedCommandEcho...))
	flushed := filter.Flush()
	if bytes.Contains(flushed, injectedCommandEcho) {
		t.Fatalf("injected echo leaked on flush: %q", flushed)
	}
	if !bytes.Contains(flushed, []byte("login banner")) {
		t.Fatalf("real output should survive the flush: %q", flushed)
	}
}
