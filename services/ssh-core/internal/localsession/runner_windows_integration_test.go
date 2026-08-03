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
		shellKind:        "fixture",
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

	waitForOutputContainsWithin(t, output, "FAKE LOCAL SHELL READY", promptStartupTimeout, waitResult, waitErr)
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

func TestResolveWindowsShellRuntimeWithLookupPrefersPwshThenPowerShellThenCmd(t *testing.T) {
	resolved, err := resolveWindowsShellRuntimeWithLookup([]windowsShellCandidate{
		{
			kind:           windowsShellKindPwsh,
			executablePath: `C:\Program Files\PowerShell\7\pwsh.exe`,
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		{
			kind:           windowsShellKindPowerShell,
			executablePath: `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		{
			kind:           windowsShellKindCmd,
			executablePath: `C:\Windows\System32\cmd.exe`,
			args:           []string{"/d", "/k", "prompt $P$G"},
		},
	}, func(candidate string) bool {
		return candidate == `C:\Program Files\PowerShell\7\pwsh.exe`
	})
	if err != nil {
		t.Fatalf("expected pwsh shell, got error: %v", err)
	}
	if resolved.kind != windowsShellKindPwsh {
		t.Fatalf("resolved shell kind = %q", resolved.kind)
	}
	if resolved.executablePath != `C:\Program Files\PowerShell\7\pwsh.exe` {
		t.Fatalf("resolved shell path = %q", resolved.executablePath)
	}

	resolved, err = resolveWindowsShellRuntimeWithLookup([]windowsShellCandidate{
		{
			kind:           windowsShellKindPwsh,
			executablePath: `C:\missing\pwsh.exe`,
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		{
			kind:           windowsShellKindPowerShell,
			executablePath: `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		{
			kind:           windowsShellKindCmd,
			executablePath: `C:\Windows\System32\cmd.exe`,
			args:           []string{"/d", "/k", "prompt $P$G"},
		},
	}, func(candidate string) bool {
		return candidate == `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
	})
	if err != nil {
		t.Fatalf("expected PowerShell fallback, got error: %v", err)
	}
	if resolved.kind != windowsShellKindPowerShell {
		t.Fatalf("resolved shell kind = %q", resolved.kind)
	}

	resolved, err = resolveWindowsShellRuntimeWithLookup([]windowsShellCandidate{
		{
			kind:           windowsShellKindPwsh,
			executablePath: `C:\missing\pwsh.exe`,
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		{
			kind:           windowsShellKindPowerShell,
			executablePath: `C:\missing\powershell.exe`,
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		{
			kind:           windowsShellKindCmd,
			executablePath: `C:\Windows\System32\cmd.exe`,
			args:           []string{"/d", "/k", "prompt $P$G"},
		},
	}, func(candidate string) bool {
		return candidate == `C:\Windows\System32\cmd.exe`
	})
	if err != nil {
		t.Fatalf("expected cmd fallback, got error: %v", err)
	}
	if resolved.kind != windowsShellKindCmd {
		t.Fatalf("resolved shell kind = %q", resolved.kind)
	}
	if resolved.executablePath != `C:\Windows\System32\cmd.exe` {
		t.Fatalf("resolved shell path = %q", resolved.executablePath)
	}
}

func TestResolveWindowsShellRuntimeWithLookupReportsAllSupportedShellFamilies(t *testing.T) {
	_, err := resolveWindowsShellRuntimeWithLookup([]windowsShellCandidate{
		{
			kind:           windowsShellKindPwsh,
			executablePath: `C:\missing\pwsh.exe`,
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		{
			kind:           windowsShellKindPowerShell,
			executablePath: `C:\missing\powershell.exe`,
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		{
			kind:           windowsShellKindCmd,
			executablePath: `C:\missing\cmd.exe`,
			args:           []string{"/d", "/k", "prompt $P$G"},
		},
	}, func(string) bool {
		return false
	})
	if err == nil {
		t.Fatal("expected shell resolution error")
	}
	if !strings.Contains(err.Error(), "pwsh.exe") || !strings.Contains(err.Error(), "powershell.exe") || !strings.Contains(err.Error(), "cmd.exe") {
		t.Fatalf("error message = %q", err)
	}
}

func TestBuildWindowsLocalShellEnvSeedsCommandProcessorVariables(t *testing.T) {
	env := buildWindowsLocalShellEnv([]string{
		`PATH=C:\Users\heodoyeong\bin;C:\Tools`,
	}, windowsShellRuntime{
		kind:           windowsShellKindCmd,
		executablePath: `C:\Windows\System32\cmd.exe`,
		args:           []string{"/d", "/k", "prompt $P$G"},
	})

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

func TestBuildWindowsLocalShellEnvKeepsCmdComspecForPowerShell(t *testing.T) {
	env := buildWindowsLocalShellEnv([]string{
		`PATH=C:\Users\heodoyeong\bin;C:\Tools`,
		`SystemRoot=C:\Windows`,
		`ComSpec=C:\Windows\System32\cmd.exe`,
	}, windowsShellRuntime{
		kind:           windowsShellKindPowerShell,
		executablePath: `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
		args:           []string{"-NoLogo", "-NoProfile"},
	})

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
}

func TestWindowsConPTYRunnerSupportsInteractivePowerShell(t *testing.T) {
	wrapperPath := buildLocalConPTYWrapperBinary(t)

	shellRuntime, err := resolveWindowsShellRuntimeWithLookup([]windowsShellCandidate{
		{
			kind:           windowsShellKindPowerShell,
			executablePath: `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
			args:           []string{"-NoLogo", "-NoProfile"},
		},
		{
			kind:           windowsShellKindPowerShell,
			executablePath: "powershell.exe",
			args:           []string{"-NoLogo", "-NoProfile"},
		},
	}, isWindowsShellUsable)
	if err != nil {
		t.Fatalf("resolveWindowsShellRuntimeWithLookup failed: %v", err)
	}

	runner, err := startPlatformLocalRunner(protocol.LocalConnectPayload{
		Cols: 120,
		Rows: 32,
	}, localCommandRuntime{
		shellKind:        shellRuntime.kind,
		executablePath:   shellRuntime.executablePath,
		args:             shellRuntime.args,
		env:              buildWindowsLocalShellEnv(os.Environ(), shellRuntime),
		wrapperPath:      wrapperPath,
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

	// PowerShell 5 on GitHub's Windows Server 2025 image can drop input sent
	// while the initial profile/prompt setup is still taking over the console.
	// Wait for the interactive prompt before sending the probe command.
	//
	// Match the prompt's trailing ">" without the following space: ConPTY can
	// render the gap after the prompt as a cursor-forward escape (ESC [ 1 C)
	// instead of a literal space, so waiting for "> " times out on a local
	// Windows 11 console even though the prompt is already interactive.
	waitForOutputContainsWithin(t, output, "PS ", promptStartupTimeout, waitResult, waitErr)
	waitForOutputContainsWithin(t, output, ">", promptStartupTimeout, waitResult, waitErr)

	if err := runner.Write([]byte("Write-Output READY_FROM_TEST\r\n")); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	waitForOutputContains(t, output, "READY_FROM_TEST", waitResult, waitErr)

	if err := runner.Kill(); err != nil {
		t.Fatalf("kill failed: %v", err)
	}
	_ = runner.Close()
	<-copyDone
}

func buildLocalConPTYWrapperBinary(t *testing.T) string {
	t.Helper()

	tempDir := t.TempDir()
	wrapperPath := filepath.Join(tempDir, "aws-conpty-wrapper.exe")
	wrapperCommand := exec.Command("go", "build", "-o", wrapperPath, "../../cmd/aws-conpty-wrapper")
	wrapperCommand.Dir = "."
	wrapperCommand.Env = append(os.Environ(), "CGO_ENABLED=0")
	result, err := wrapperCommand.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to build local conpty wrapper: %v\n%s", err, result)
	}

	return wrapperPath
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

// 셸이 첫 출력을 내기까지는 프로세스 시작·프로필 로딩·모듈 자동 로드가 끝나야 한다. 공용
// CI 러너에서 PowerShell 콜드 스타트는 5초를 넘기는 일이 흔해서, 첫 프롬프트를 기다리는 데는
// 넉넉한 예산이 필요하다. 반면 이미 살아 있는 셸이 명령을 되돌려 주는 건 빠르므로, 두 경우를
// 같은 값으로 재면 둘 중 하나는 반드시 틀린 값이 된다.
const (
	promptStartupTimeout = 60 * time.Second
	outputEchoTimeout    = 5 * time.Second
)

func waitForOutputContains(t *testing.T, output *capturedOutput, expected string, waitResult <-chan sessionExit, waitErr <-chan error) {
	t.Helper()
	waitForOutputContainsWithin(t, output, expected, outputEchoTimeout, waitResult, waitErr)
}

func waitForOutputContainsWithin(t *testing.T, output *capturedOutput, expected string, timeout time.Duration, waitResult <-chan sessionExit, waitErr <-chan error) {
	t.Helper()
	deadline := time.Now().Add(timeout)
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
	t.Fatalf("timed out waiting for %q after %s in output:\n%s", expected, timeout, output.snapshot())
}
