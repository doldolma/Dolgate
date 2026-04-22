package http

import (
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/pkg/coretypes"
)

type fakeAwsSessionCoreRuntime struct {
	mu sync.Mutex

	connectCalls    []coretypes.AWSConnectPayload
	disconnectCalls []string
	shutdownCalls   int
	onDisconnect    func(string)
}

func (core *fakeAwsSessionCoreRuntime) ConnectAWS(sessionID, requestID string, payload coretypes.AWSConnectPayload) error {
	core.mu.Lock()
	core.connectCalls = append(core.connectCalls, payload)
	core.mu.Unlock()
	return nil
}

func (core *fakeAwsSessionCoreRuntime) SendSessionInput(sessionID string, data []byte) error {
	return nil
}

func (core *fakeAwsSessionCoreRuntime) ResizeSession(sessionID string, payload coretypes.ResizePayload) error {
	return nil
}

func (core *fakeAwsSessionCoreRuntime) DisconnectSession(sessionID string) error {
	core.mu.Lock()
	core.disconnectCalls = append(core.disconnectCalls, sessionID)
	onDisconnect := core.onDisconnect
	core.mu.Unlock()
	if onDisconnect != nil {
		onDisconnect(sessionID)
	}
	return nil
}

func (core *fakeAwsSessionCoreRuntime) Shutdown() {
	core.mu.Lock()
	core.shutdownCalls += 1
	core.mu.Unlock()
}

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

func TestAwsSessionBridgeRejectsNewRunnersAfterClose(t *testing.T) {
	core := &fakeAwsSessionCoreRuntime{}
	bridge := newAwsSessionBridgeWithCore(core)

	bridge.Close()

	if _, err := bridge.NewRunner(awsSessionStartRequest{
		HostID:     "host-aws-1",
		Label:      "Production EC2",
		Region:     "ap-northeast-2",
		InstanceID: "i-0123456789",
	}); err == nil {
		t.Fatal("expected NewRunner() to fail after bridge shutdown")
	}

	core.mu.Lock()
	defer core.mu.Unlock()
	if core.shutdownCalls != 1 {
		t.Fatalf("Shutdown() calls = %d, want 1", core.shutdownCalls)
	}
}

func TestDirectAwsSessionBackpressureRequestsDisconnect(t *testing.T) {
	core := &fakeAwsSessionCoreRuntime{}
	bridge := newAwsSessionBridgeWithCore(core)
	core.onDisconnect = func(sessionID string) {
		bridge.handleEvent(coretypes.Event{
			Type:      coretypes.EventClosed,
			SessionID: sessionID,
			Payload: coretypes.ClosedPayload{
				Message: "client requested disconnect",
			},
		})
	}

	runner, err := bridge.NewRunner(awsSessionStartRequest{
		HostID:     "host-aws-1",
		Label:      "Production EC2",
		Region:     "ap-northeast-2",
		InstanceID: "i-0123456789",
	})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	session := runner.(*directAwsSession)
	for index := 0; index < awsSessionEventsBufferSize; index++ {
		if !session.emit(awsSessionRuntimeEvent{Type: "output", Data: []byte("x")}) {
			t.Fatalf("emit() unexpectedly failed at index %d", index)
		}
	}
	if session.emit(awsSessionRuntimeEvent{Type: "output", Data: []byte("overflow")}) {
		t.Fatal("emit() should fail when the event queue is full")
	}

	select {
	case <-session.done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for session finalization")
	}

	core.mu.Lock()
	defer core.mu.Unlock()
	if len(core.disconnectCalls) != 1 {
		t.Fatalf("DisconnectSession() calls = %d, want 1", len(core.disconnectCalls))
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
