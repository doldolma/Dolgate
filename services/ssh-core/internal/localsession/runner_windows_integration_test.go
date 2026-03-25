//go:build windows

package localsession

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

type capturedOutput struct {
	mu   sync.Mutex
	data []byte
}

func (c *capturedOutput) append(chunk []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data = append(c.data, chunk...)
}

func (c *capturedOutput) snapshot() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return string(c.data)
}

func TestWindowsConPTYRunnerRoutesOutputInputAndResize(t *testing.T) {
	fixturePath := buildConPTYFixtureBinary(t)

	runner, err := startPlatformLocalRunner(protocol.LocalConnectPayload{
		Cols: 120,
		Rows: 32,
	}, localCommandRuntime{
		executablePath:   fixturePath,
		env:              os.Environ(),
		workingDirectory: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("startPlatformLocalRunner failed: %v", err)
	}
	defer func() {
		_ = runner.Kill()
		_ = runner.Close()
	}()

	output := &capturedOutput{}
	copyDone := make(chan struct{})
	waitResult := make(chan sessionExit, 1)
	waitErr := make(chan error, 1)
	go func() {
		defer close(copyDone)
		for _, reader := range runner.Streams() {
			copyReaderOutput(output, reader)
		}
	}()
	go func() {
		exit, err := runner.Wait()
		if err != nil {
			waitErr <- err
			return
		}
		waitResult <- exit
	}()

	waitForOutputContains(t, output, "FAKE LOCAL SHELL READY", waitResult, waitErr)
	waitForOutputContains(t, output, "SIZE:120x32", waitResult, waitErr)

	if err := runner.Write([]byte("hello-from-conpty\r\n")); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	waitForOutputContains(t, output, "ECHO:hello-from-conpty", waitResult, waitErr)

	if err := runner.Resize(140, 50); err != nil {
		t.Fatalf("resize failed: %v", err)
	}
	if err := runner.Write([]byte("__REPORT_SIZE__\r\n")); err != nil {
		t.Fatalf("size probe write failed: %v", err)
	}
	waitForOutputContains(t, output, "SIZE:140x50", waitResult, waitErr)

	if err := runner.Kill(); err != nil {
		t.Fatalf("kill failed: %v", err)
	}
	exit := <-waitResult
	if exit.ExitCode != 1 {
		t.Fatalf("exit code = %d", exit.ExitCode)
	}

	_ = runner.Close()
	<-copyDone
}

func TestResolveWindowsShellExecutableWithLookupPrefersComspecThenFallbacks(t *testing.T) {
	resolved, err := resolveWindowsShellExecutableWithLookup([]string{`C:\custom\cmd.exe`, "cmd.exe"}, func(candidate string) bool {
		return candidate == `C:\custom\cmd.exe`
	})
	if err != nil {
		t.Fatalf("expected shell from COMSPEC, got error: %v", err)
	}
	if resolved != `C:\custom\cmd.exe` {
		t.Fatalf("resolved shell = %q", resolved)
	}

	resolved, err = resolveWindowsShellExecutableWithLookup([]string{`C:\missing\cmd.exe`, "cmd.exe"}, func(candidate string) bool {
		return candidate == "cmd.exe"
	})
	if err != nil {
		t.Fatalf("expected fallback shell, got error: %v", err)
	}
	if resolved != "cmd.exe" {
		t.Fatalf("resolved shell = %q", resolved)
	}
}

func TestResolveWindowsShellExecutableWithLookupIgnoresNonCmdComSpec(t *testing.T) {
	resolved, err := resolveWindowsShellExecutableWithLookup([]string{`C:\Program Files\PowerShell\7\pwsh.exe`, `C:\Windows\System32\cmd.exe`}, func(candidate string) bool {
		return candidate == `C:\Windows\System32\cmd.exe`
	})
	if err != nil {
		t.Fatalf("expected cmd fallback, got error: %v", err)
	}
	if resolved != `C:\Windows\System32\cmd.exe` {
		t.Fatalf("resolved shell = %q", resolved)
	}
}

func TestBuildWindowsLocalShellEnvSeedsCommandProcessorVariables(t *testing.T) {
	env := buildWindowsLocalShellEnv([]string{
		`PATH=C:\Users\heodoyeong\bin;C:\Tools`,
	}, `C:\Windows\System32\cmd.exe`)

	got := map[string]string{}
	for _, entry := range env {
		parts := strings.SplitN(entry, "=", 2)
		if len(parts) == 2 {
			got[parts[0]] = parts[1]
		}
	}

	if got["COMSPEC"] != `C:\Windows\System32\cmd.exe` {
		t.Fatalf("COMSPEC = %q", got["COMSPEC"])
	}
	if got["SystemRoot"] != `C:\Windows` {
		t.Fatalf("SystemRoot = %q", got["SystemRoot"])
	}
	if got["windir"] != `C:\Windows` {
		t.Fatalf("windir = %q", got["windir"])
	}
}

func buildConPTYFixtureBinary(t *testing.T) string {
	t.Helper()

	tempDir := t.TempDir()
	fixturePath := filepath.Join(tempDir, "conpty-fixture.exe")
	fixtureCommand := exec.Command("go", "build", "-o", fixturePath, ".")
	fixtureCommand.Dir = filepath.Join(".", "testfixture")
	fixtureCommand.Env = append(os.Environ(), "CGO_ENABLED=0")
	result, err := fixtureCommand.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to build conpty fixture: %v\n%s", err, result)
	}

	return fixturePath
}

func copyReaderOutput(output *capturedOutput, reader io.Reader) {
	buffer := make([]byte, 4096)
	for {
		count, err := reader.Read(buffer)
		if count > 0 {
			chunk := make([]byte, count)
			copy(chunk, buffer[:count])
			output.append(chunk)
		}
		if err != nil {
			return
		}
	}
}

func waitForOutputContains(t *testing.T, output *capturedOutput, expected string, waitResult <-chan sessionExit, waitErr <-chan error) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(output.snapshot(), expected) {
			return
		}
		select {
		case err := <-waitErr:
			t.Fatalf("runner exited early with error while waiting for %q: %v\n%s", expected, err, output.snapshot())
		case exit := <-waitResult:
			t.Fatalf("runner exited early while waiting for %q: %#v\n%s", expected, exit, output.snapshot())
		default:
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %q in output:\n%s", expected, output.snapshot())
}
