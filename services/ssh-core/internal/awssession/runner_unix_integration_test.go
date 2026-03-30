//go:build !windows

package awssession

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

type unixCapturedOutput struct {
	mu   sync.Mutex
	data []byte
}

func (c *unixCapturedOutput) append(chunk []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data = append(c.data, chunk...)
}

func (c *unixCapturedOutput) snapshot() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return string(c.data)
}

func TestUnixPTYRunnerRoutesTTYOutputInputAndResize(t *testing.T) {
	fixturePath := buildUnixPTYFixtureBinary(t)

	runner, err := startPlatformAWSRunner(protocol.AWSConnectPayload{
		Cols: 120,
		Rows: 32,
	}, awsCommandRuntime{
		executablePath: fixturePath,
		env:            os.Environ(),
	})
	if err != nil {
		t.Fatalf("startPlatformAWSRunner failed: %v", err)
	}
	defer func() {
		_ = runner.Kill()
		_ = runner.Close()
	}()

	output := &unixCapturedOutput{}
	copyDone := make(chan struct{})
	waitResult := make(chan sessionExit, 1)
	waitErr := make(chan error, 1)
	go func() {
		defer close(copyDone)
		for _, reader := range runner.Streams() {
			copyUnixReaderOutput(output, reader)
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

	waitForUnixOutputContains(t, output, "READY:FAKE_AWS_SSM", waitResult, waitErr)
	waitForUnixOutputContains(t, output, "TTY:true", waitResult, waitErr)
	waitForUnixOutputContains(t, output, "SIZE:120x32", waitResult, waitErr)

	if err := runner.Write([]byte("hello-from-pty\r\n")); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	waitForUnixOutputContains(t, output, "ECHO:hello-from-pty", waitResult, waitErr)

	if err := runner.Resize(140, 50); err != nil {
		t.Fatalf("resize failed: %v", err)
	}
	if err := runner.Write([]byte("__REPORT_SIZE__\r\n")); err != nil {
		t.Fatalf("size probe write failed: %v", err)
	}
	waitForUnixOutputContains(t, output, "SIZE:140x50", waitResult, waitErr)

	if err := runner.SendControlSignal("interrupt"); err != nil {
		t.Fatalf("interrupt failed: %v", err)
	}
	waitForUnixOutputContains(t, output, "SIGNAL:INT", waitResult, waitErr)

	if err := runner.SendControlSignal("suspend"); err != nil {
		t.Fatalf("suspend failed: %v", err)
	}
	waitForUnixOutputContains(t, output, "SIGNAL:TSTP", waitResult, waitErr)

	if err := runner.SendControlSignal("quit"); err != nil {
		t.Fatalf("quit failed: %v", err)
	}
	waitForUnixOutputContains(t, output, "SIGNAL:QUIT", waitResult, waitErr)

	if err := runner.Kill(); err != nil {
		t.Fatalf("kill failed: %v", err)
	}
	exit := <-waitResult
	if exit.Signal == "" && exit.ExitCode == 0 {
		t.Fatalf("expected non-zero exit after kill, got %#v", exit)
	}

	_ = runner.Close()
	<-copyDone
}

func buildUnixPTYFixtureBinary(t *testing.T) string {
	t.Helper()

	tempDir := t.TempDir()
	outputPath := filepath.Join(tempDir, "pty-fixture")
	command := exec.Command("go", "build", "-o", outputPath, ".")
	command.Dir = filepath.Join(".", "testfixture")
	command.Env = append(os.Environ(), "CGO_ENABLED=0")
	result, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to build unix pty fixture: %v\n%s", err, result)
	}
	return outputPath
}

func copyUnixReaderOutput(output *unixCapturedOutput, reader io.Reader) {
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

func waitForUnixOutputContains(t *testing.T, output *unixCapturedOutput, expected string, waitResult <-chan sessionExit, waitErr <-chan error) {
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
