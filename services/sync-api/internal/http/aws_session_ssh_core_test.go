package http

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/pkg/coretypes"
)

// fakeAwsSsmTokenIssuer stands in for ssm:StartSession so bridge tests with a
// fake core runtime never talk to AWS.
type fakeAwsSsmTokenIssuer struct{}

func (fakeAwsSsmTokenIssuer) IssueShellSession(context.Context, string, map[string]string, string) (awsSsmSessionToken, error) {
	return awsSsmSessionToken{
		SessionID:  "fake-ssm-session",
		StreamURL:  "wss://fake.example/stream",
		TokenValue: "fake-token",
	}, nil
}

func (fakeAwsSsmTokenIssuer) IssuePortForwardSession(context.Context, string, map[string]string, string, int, int) (awsSsmSessionToken, error) {
	return awsSsmSessionToken{
		SessionID:  "fake-ssm-forward",
		StreamURL:  "wss://fake.example/forward",
		TokenValue: "fake-forward-token",
	}, nil
}

type fakeAwsSessionCoreRuntime struct {
	mu sync.Mutex

	connectCalls    []coretypes.AWSConnectPayload
	signalCalls     []coretypes.ControlSignalPayload
	disconnectCalls []string
	shutdownCalls   int
	onDisconnect    func(string)
}

func (core *fakeAwsSessionCoreRuntime) PrepareAutocomplete(string, string) error { return nil }
func (core *fakeAwsSessionCoreRuntime) RefreshAutocomplete(string, string) error { return nil }
func (core *fakeAwsSessionCoreRuntime) StopAutocomplete(string)                  {}

func (core *fakeAwsSessionCoreRuntime) ConnectAWS(sessionID, requestID string, payload coretypes.AWSConnectPayload) error {
	core.mu.Lock()
	core.connectCalls = append(core.connectCalls, payload)
	core.mu.Unlock()
	return nil
}

func (core *fakeAwsSessionCoreRuntime) SendSessionInput(sessionID string, data []byte) error {
	return nil
}

func (core *fakeAwsSessionCoreRuntime) SendControlSignal(sessionID string, payload coretypes.ControlSignalPayload) error {
	core.mu.Lock()
	defer core.mu.Unlock()
	core.signalCalls = append(core.signalCalls, payload)
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
	if !strings.Contains(string(output.Data), "Connected to fake AWS SSM smoke session.\r\n") {
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

// ssh-core 가 셸 통합 스크립트를 타이핑해도 되는지는 원격 셸 종류로 갈린다. Windows 인스턴스는
// PowerShell 로 떨어져서 POSIX 스크립트가 파싱 오류만 쏟는데, 서버 프록시 경로에서 이 값을
// 흘리지 않으면 데스크톱이 알아낸 종류가 서버의 코어까지 도달하지 못한다.
func TestDirectAwsSessionForwardsShellKind(t *testing.T) {
	core := &fakeAwsSessionCoreRuntime{}
	bridge := newAwsSessionBridgeWithCore(core)
	bridge.ssmTokens = fakeAwsSsmTokenIssuer{}
	defer bridge.Close()

	if _, err := bridge.NewRunner(awsSessionStartRequest{
		HostID:     "host-aws-win",
		Label:      "Windows EC2",
		Region:     "ap-northeast-2",
		InstanceID: "i-00c8d7296782e6ad5",
		ShellKind:  "powershell",
	}); err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	core.mu.Lock()
	defer core.mu.Unlock()
	if len(core.connectCalls) != 1 {
		t.Fatalf("ConnectAWS() calls = %d, want 1", len(core.connectCalls))
	}
	if got := core.connectCalls[0].ShellKind; got != "powershell" {
		t.Fatalf("ConnectAWS payload ShellKind = %q, want %q", got, "powershell")
	}
}

// 리눅스(종류 미지정)는 기존 동작을 그대로 유지해야 한다 — 빈 값이 POSIX 셸을 뜻한다.
func TestDirectAwsSessionLeavesShellKindEmptyByDefault(t *testing.T) {
	core := &fakeAwsSessionCoreRuntime{}
	bridge := newAwsSessionBridgeWithCore(core)
	bridge.ssmTokens = fakeAwsSsmTokenIssuer{}
	defer bridge.Close()

	if _, err := bridge.NewRunner(awsSessionStartRequest{
		HostID:     "host-aws-1",
		Label:      "Production EC2",
		Region:     "ap-northeast-2",
		InstanceID: "i-0123456789",
	}); err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	core.mu.Lock()
	defer core.mu.Unlock()
	if got := core.connectCalls[0].ShellKind; got != "" {
		t.Fatalf("ConnectAWS payload ShellKind = %q, want empty", got)
	}
}

func TestDirectAwsSessionForwardsControlSignal(t *testing.T) {
	core := &fakeAwsSessionCoreRuntime{}
	bridge := newAwsSessionBridgeWithCore(core)
	bridge.ssmTokens = fakeAwsSsmTokenIssuer{}
	defer bridge.Close()

	runner, err := bridge.NewRunner(awsSessionStartRequest{
		HostID:     "host-aws-1",
		Label:      "Production EC2",
		Region:     "ap-northeast-2",
		InstanceID: "i-0123456789",
	})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}

	core.mu.Lock()
	if len(core.connectCalls) != 1 {
		core.mu.Unlock()
		t.Fatalf("ConnectAWS() calls = %d, want 1", len(core.connectCalls))
	}
	payload := core.connectCalls[0]
	core.mu.Unlock()
	if payload.StreamURL != "wss://fake.example/stream" ||
		payload.TokenValue != "fake-token" ||
		payload.SsmSessionID != "fake-ssm-session" {
		t.Fatalf("ConnectAWS payload missing issued token: %#v", payload)
	}

	if err := runner.ControlSignal("interrupt"); err != nil {
		t.Fatalf("ControlSignal() error = %v", err)
	}

	core.mu.Lock()
	defer core.mu.Unlock()
	if len(core.signalCalls) != 1 || core.signalCalls[0].Signal != "interrupt" {
		t.Fatalf("signal calls = %#v", core.signalCalls)
	}
}

func TestDirectAwsSessionBackpressureRequestsDisconnect(t *testing.T) {
	core := &fakeAwsSessionCoreRuntime{}
	bridge := newAwsSessionBridgeWithCore(core)
	bridge.ssmTokens = fakeAwsSsmTokenIssuer{}
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
