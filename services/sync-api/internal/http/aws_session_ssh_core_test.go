package http

import (
	"testing"
	"time"
)

func TestAwsSessionBridgeUsesEmbeddedRuntime(t *testing.T) {
	t.Setenv("DOLSSH_E2E_FAKE_AWS_SESSION", "1")

	bridge := NewAwsSessionBridge()
	defer bridge.Close()

	runner, err := bridge.NewRunner(awsSessionStartRequest{
		HostID:     "host-aws-1",
		Label:      "Production EC2",
		Region:     "ap-northeast-2",
		InstanceID: "i-0123456789",
		Cols:       120,
		Rows:       32,
	})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}
	defer runner.Close()

	ready := waitForAwsRuntimeEvent(t, runner.Events(), "ready")
	if ready.Type != "ready" {
		t.Fatalf("expected ready event, got %#v", ready)
	}

	output := waitForAwsRuntimeEvent(t, runner.Events(), "output")
	if string(output.Data) != "Connected to fake AWS SSM smoke session.\r\n" {
		t.Fatalf("unexpected initial output %q", string(output.Data))
	}

	if err := runner.Write([]byte("pwd\r")); err != nil {
		t.Fatalf("runner.Write() error = %v", err)
	}
	echo := waitForAwsRuntimeEvent(t, runner.Events(), "output")
	if string(echo.Data) != "pwd\r" {
		t.Fatalf("unexpected echoed output %q", string(echo.Data))
	}
}

func waitForAwsRuntimeEvent(t *testing.T, events <-chan awsSessionRuntimeEvent, expectedType string) awsSessionRuntimeEvent {
	t.Helper()

	deadline := time.After(2 * time.Second)
	for {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatalf("AWS runtime events closed before %s", expectedType)
			}
			if event.Type == expectedType {
				return event
			}
		case <-deadline:
			t.Fatalf("timed out waiting for AWS runtime event %s", expectedType)
		}
	}
}
