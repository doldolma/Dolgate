package awssession

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

// Builds the real e2e fixture and drives it through the process-backed fake
// runner — the same path the desktop smoke tests use.
func TestProcessBackedFakeAgentRunnerEcho(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping fixture build in -short mode")
	}

	fixturePath := filepath.Join(t.TempDir(), "fake-aws-session")
	if runtime.GOOS == "windows" {
		fixturePath += ".exe"
	}
	build := exec.Command("go", "build", "-o", fixturePath, "./testfixture")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		t.Fatalf("building fixture: %v", err)
	}

	t.Setenv("DOLSSH_E2E_FAKE_AWS_SESSION", "process")
	t.Setenv("DOLSSH_E2E_FAKE_AWS_FIXTURE_PATH", fixturePath)

	runner, err := defaultRunnerFactory(protocol.AWSConnectPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		InstanceID:  "i-fake",
		Cols:        120,
		Rows:        32,
	})
	if err != nil {
		t.Fatalf("defaultRunnerFactory: %v", err)
	}
	defer runner.Close()

	output := make(chan string, 64)
	go func() {
		buffer := make([]byte, 8192)
		stream := runner.Streams()[0]
		for {
			n, err := stream.Read(buffer)
			if n > 0 {
				output <- string(buffer[:n])
			}
			if err != nil {
				close(output)
				return
			}
		}
	}()

	waitForOutput := func(needle string) {
		t.Helper()
		var seen strings.Builder
		deadline := time.After(10 * time.Second)
		for {
			select {
			case chunk, ok := <-output:
				if !ok {
					t.Fatalf("stream closed before %q arrived; saw: %q", needle, seen.String())
				}
				seen.WriteString(chunk)
				if strings.Contains(seen.String(), needle) {
					return
				}
			case <-deadline:
				t.Fatalf("timed out waiting for %q; saw: %q", needle, seen.String())
			}
		}
	}

	waitForOutput("READY:FAKE_AWS_SSM")
	waitForOutput("PROMPT> ready")

	if err := runner.Write([]byte("hello-from-go-test\r")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	waitForOutput("ECHO:hello-from-go-test")

	if err := runner.Resize(100, 30); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	if err := runner.Write([]byte("__REPORT_SIZE__\r")); err != nil {
		t.Fatalf("Write report size: %v", err)
	}
	waitForOutput("SIZE:100x30")

	if err := runner.SendControlSignal("interrupt"); err != nil {
		t.Fatalf("SendControlSignal: %v", err)
	}
	waitForOutput("SIGNAL:INT")

	if err := runner.Kill(); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	exit, waitErr := runner.Wait()
	if waitErr != nil {
		t.Fatalf("Wait: %v", waitErr)
	}
	if exit.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", exit.ExitCode)
	}
}
