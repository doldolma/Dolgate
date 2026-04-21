package main

import (
	"encoding/json"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

type stubCoreRuntime struct {
	awsConnectSession string
	awsConnectPayload protocol.AWSConnectPayload
	inputSession      string
	inputPayload      []byte
	awsConnectDone    chan struct{}
}

func (stub *stubCoreRuntime) EmitReady()              {}
func (stub *stubCoreRuntime) Health(requestID string) {}
func (stub *stubCoreRuntime) ConnectSSH(sessionID, requestID string, payload protocol.ConnectPayload) error {
	return nil
}
func (stub *stubCoreRuntime) ConnectAWS(sessionID, requestID string, payload protocol.AWSConnectPayload) error {
	stub.awsConnectSession = sessionID
	stub.awsConnectPayload = payload
	if stub.awsConnectDone != nil {
		close(stub.awsConnectDone)
	}
	return nil
}
func (stub *stubCoreRuntime) ConnectLocal(sessionID, requestID string, payload protocol.LocalConnectPayload) error {
	return nil
}
func (stub *stubCoreRuntime) ConnectSerial(sessionID, requestID string, payload protocol.SerialConnectPayload) error {
	return nil
}
func (stub *stubCoreRuntime) ListSerialPorts(requestID string, payload protocol.SerialListPortsPayload) error {
	return nil
}
func (stub *stubCoreRuntime) ControlSerial(sessionID string, payload protocol.SerialControlPayload) error {
	return nil
}
func (stub *stubCoreRuntime) SendSessionInput(sessionID string, data []byte) error {
	stub.inputSession = sessionID
	stub.inputPayload = append([]byte(nil), data...)
	return nil
}
func (stub *stubCoreRuntime) SendControlSignal(sessionID string, payload protocol.ControlSignalPayload) error {
	return nil
}
func (stub *stubCoreRuntime) ResizeSession(sessionID string, payload protocol.ResizePayload) error {
	return nil
}
func (stub *stubCoreRuntime) DisconnectSession(sessionID string) error { return nil }
func (stub *stubCoreRuntime) ProbeHostKey(requestID string, payload protocol.HostKeyProbePayload) error {
	return nil
}
func (stub *stubCoreRuntime) InspectCertificate(requestID string, payload protocol.CertificateInspectPayload) error {
	return nil
}
func (stub *stubCoreRuntime) RespondKeyboardInteractive(sessionID, endpointID string, payload protocol.KeyboardInteractiveRespondPayload) error {
	return nil
}
func (stub *stubCoreRuntime) ConnectContainers(endpointID, requestID string, payload protocol.ContainersConnectPayload) error {
	return nil
}
func (stub *stubCoreRuntime) DisconnectContainers(endpointID, requestID string) error { return nil }
func (stub *stubCoreRuntime) ListContainers(endpointID, requestID string) error       { return nil }
func (stub *stubCoreRuntime) InspectContainer(endpointID, requestID string, payload protocol.ContainersInspectPayload) error {
	return nil
}
func (stub *stubCoreRuntime) LogsContainers(endpointID, requestID string, payload protocol.ContainersLogsPayload) error {
	return nil
}
func (stub *stubCoreRuntime) StartContainer(endpointID, requestID string, payload protocol.ContainersActionPayload) error {
	return nil
}
func (stub *stubCoreRuntime) StopContainer(endpointID, requestID string, payload protocol.ContainersActionPayload) error {
	return nil
}
func (stub *stubCoreRuntime) RestartContainer(endpointID, requestID string, payload protocol.ContainersActionPayload) error {
	return nil
}
func (stub *stubCoreRuntime) RemoveContainer(endpointID, requestID string, payload protocol.ContainersActionPayload) error {
	return nil
}
func (stub *stubCoreRuntime) StatsContainers(endpointID, requestID string, payload protocol.ContainersStatsPayload) error {
	return nil
}
func (stub *stubCoreRuntime) SearchContainerLogs(endpointID, requestID string, payload protocol.ContainersSearchLogsPayload) error {
	return nil
}
func (stub *stubCoreRuntime) StartPortForward(endpointID, requestID string, payload protocol.PortForwardStartPayload) error {
	return nil
}
func (stub *stubCoreRuntime) StopPortForward(endpointID, requestID string) error { return nil }
func (stub *stubCoreRuntime) StartSSMPortForward(endpointID, requestID string, payload protocol.SSMPortForwardStartPayload) error {
	return nil
}
func (stub *stubCoreRuntime) StopSSMPortForward(endpointID, requestID string) error { return nil }
func (stub *stubCoreRuntime) ConnectSFTP(endpointID, requestID string, payload protocol.SFTPConnectPayload) error {
	return nil
}
func (stub *stubCoreRuntime) DisconnectSFTP(endpointID, requestID string) error { return nil }
func (stub *stubCoreRuntime) ListSFTP(endpointID, requestID string, payload protocol.SFTPListPayload) error {
	return nil
}
func (stub *stubCoreRuntime) MkdirSFTP(endpointID, requestID string, payload protocol.SFTPMkdirPayload) error {
	return nil
}
func (stub *stubCoreRuntime) RenameSFTP(endpointID, requestID string, payload protocol.SFTPRenamePayload) error {
	return nil
}
func (stub *stubCoreRuntime) ChmodSFTP(endpointID, requestID string, payload protocol.SFTPChmodPayload) error {
	return nil
}
func (stub *stubCoreRuntime) DeleteSFTP(endpointID, requestID string, payload protocol.SFTPDeletePayload) error {
	return nil
}
func (stub *stubCoreRuntime) StartSFTPTransfer(jobID string, payload protocol.SFTPTransferStartPayload) error {
	return nil
}
func (stub *stubCoreRuntime) CancelSFTPTransfer(jobID string) error { return nil }
func (stub *stubCoreRuntime) Shutdown()                             {}

func TestDispatchFrameRoutesStreamInputThroughRuntime(t *testing.T) {
	core := &stubCoreRuntime{}
	frame := protocol.Frame{
		Kind: protocol.FrameKindStream,
	}
	metadata, err := json.Marshal(protocol.StreamFrame{
		Type:      protocol.StreamTypeWrite,
		SessionID: "session-1",
	})
	if err != nil {
		t.Fatalf("marshal stream metadata: %v", err)
	}
	frame.Metadata = metadata
	frame.Payload = []byte("echo hello\r")

	if err := dispatchFrame(core, newEventWriter(), frame); err != nil {
		t.Fatalf("dispatchFrame() error = %v", err)
	}

	if core.inputSession != "session-1" || string(core.inputPayload) != "echo hello\r" {
		t.Fatalf("unexpected stream routing result: %#v", core)
	}
}

func TestDispatchAWSConnectUsesRuntimeFacade(t *testing.T) {
	core := &stubCoreRuntime{awsConnectDone: make(chan struct{})}
	payload, err := json.Marshal(protocol.AWSConnectPayload{
		Region:     "ap-northeast-2",
		InstanceID: "i-0123456789",
		Cols:       132,
		Rows:       48,
	})
	if err != nil {
		t.Fatalf("marshal AWS payload: %v", err)
	}

	if err := dispatch(core, newEventWriter(), protocol.Request{
		ID:        "req-1",
		Type:      protocol.CommandAWSConnect,
		SessionID: "session-aws-1",
		Payload:   payload,
	}); err != nil {
		t.Fatalf("dispatch() error = %v", err)
	}

	select {
	case <-core.awsConnectDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for async AWS connect dispatch")
	}

	if core.awsConnectSession != "session-aws-1" {
		t.Fatalf("expected runtime AWS connect for session-aws-1, got %#v", core)
	}
	if core.awsConnectPayload.Region != "ap-northeast-2" || core.awsConnectPayload.InstanceID != "i-0123456789" {
		t.Fatalf("unexpected AWS payload: %#v", core.awsConnectPayload)
	}
}
