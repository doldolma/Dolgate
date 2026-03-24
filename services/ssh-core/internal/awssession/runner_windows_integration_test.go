//go:build windows

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
	fixture := buildConPTYFixtureBinary(t)

	runner, err := startPlatformAWSRunner(protocol.AWSConnectPayload{
		Cols: 120,
		Rows: 32,
	}, awsCommandRuntime{
		executablePath: fixture.fixturePath,
		wrapperPath:    fixture.wrapperPath,
		env:            os.Environ(),
	})
	if err != nil {
		t.Fatalf("startPlatformAWSRunner failed: %v", err)
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

	waitForOutputContains(t, output, "FAKE AWS SSM READY", waitResult, waitErr)
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

type builtConPTYFixture struct {
	fixturePath string
	wrapperPath string
}

func buildConPTYFixtureBinary(t *testing.T) builtConPTYFixture {
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

	wrapperPath := filepath.Join(tempDir, "aws-conpty-wrapper.exe")
	wrapperCommand := exec.Command("go", "build", "-o", wrapperPath, "../../cmd/aws-conpty-wrapper")
	wrapperCommand.Dir = "."
	wrapperCommand.Env = append(os.Environ(), "CGO_ENABLED=0")
	result, err = wrapperCommand.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to build aws conpty wrapper: %v\n%s", err, result)
	}

	return builtConPTYFixture{
		fixturePath: fixturePath,
		wrapperPath: wrapperPath,
	}
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
