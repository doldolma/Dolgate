package runtime

import (
	"errors"
	"testing"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/pkg/coretypes"
)

type stubSSHManager struct {
	hasSession    bool
	writeSession  string
	writeData     []byte
	resizeSession string
	resizeCols    int
	resizeRows    int
	disconnectID  string
	challengeID   string
	responses     []string
}

func (stub *stubSSHManager) Connect(sessionID, requestID string, payload coretypes.ConnectPayload) error {
	return nil
}

func (stub *stubSSHManager) HasSession(sessionID string) bool { return stub.hasSession }
func (stub *stubSSHManager) WriteBytes(sessionID string, data []byte) error {
	stub.writeSession = sessionID
	stub.writeData = append([]byte(nil), data...)
	return nil
}
func (stub *stubSSHManager) Resize(sessionID string, cols, rows int) error {
	stub.resizeSession = sessionID
	stub.resizeCols = cols
	stub.resizeRows = rows
	return nil
}
func (stub *stubSSHManager) Disconnect(sessionID string) error {
	stub.disconnectID = sessionID
	return nil
}
func (stub *stubSSHManager) RespondKeyboardInteractive(sessionID, challengeID string, responses []string) error {
	stub.challengeID = challengeID
	stub.responses = append([]string(nil), responses...)
	return nil
}

type stubAWSManager struct {
	hasSession   bool
	writeSession string
	writeData    []byte
	resizeID     string
	resizeCols   int
	resizeRows   int
	disconnectID string
	signal       string
	shutdownCall int
}

func (stub *stubAWSManager) Connect(sessionID, requestID string, payload coretypes.AWSConnectPayload) error {
	return nil
}
func (stub *stubAWSManager) HasSession(sessionID string) bool { return stub.hasSession }
func (stub *stubAWSManager) WriteBytes(sessionID string, data []byte) error {
	stub.writeSession = sessionID
	stub.writeData = append([]byte(nil), data...)
	return nil
}
func (stub *stubAWSManager) SendControlSignal(sessionID, signal string) error {
	stub.signal = signal
	return nil
}
func (stub *stubAWSManager) Resize(sessionID string, cols, rows int) error {
	stub.resizeID = sessionID
	stub.resizeCols = cols
	stub.resizeRows = rows
	return nil
}
func (stub *stubAWSManager) Disconnect(sessionID string) error {
	stub.disconnectID = sessionID
	return nil
}
func (stub *stubAWSManager) Shutdown() { stub.shutdownCall++ }

type stubLocalManager struct {
	hasSession   bool
	writeSession string
	resizeID     string
	disconnectID string
}

func (stub *stubLocalManager) Connect(sessionID, requestID string, payload coretypes.LocalConnectPayload) error {
	return nil
}
func (stub *stubLocalManager) HasSession(sessionID string) bool { return stub.hasSession }
func (stub *stubLocalManager) WriteBytes(sessionID string, data []byte) error {
	stub.writeSession = sessionID
	return nil
}
func (stub *stubLocalManager) Resize(sessionID string, cols, rows int) error {
	stub.resizeID = sessionID
	return nil
}
func (stub *stubLocalManager) Disconnect(sessionID string) error {
	stub.disconnectID = sessionID
	return nil
}

type stubSerialManager struct {
	hasSession   bool
	writeSession string
	control      string
	disconnectID string
}

func (stub *stubSerialManager) Connect(sessionID, requestID string, payload coretypes.SerialConnectPayload) error {
	return nil
}
func (stub *stubSerialManager) ListPorts(requestID string, payload coretypes.SerialListPortsPayload) error {
	return nil
}
func (stub *stubSerialManager) HasSession(sessionID string) bool { return stub.hasSession }
func (stub *stubSerialManager) WriteBytes(sessionID string, data []byte) error {
	stub.writeSession = sessionID
	return nil
}
func (stub *stubSerialManager) Control(sessionID, action string, enabled *bool) error {
	stub.control = action
	return nil
}
func (stub *stubSerialManager) Resize(sessionID string, cols, rows int) error { return nil }
func (stub *stubSerialManager) Disconnect(sessionID string) error {
	stub.disconnectID = sessionID
	return nil
}

type stubSFTPService struct {
	responded    bool
	connectID    string
	shutdownCall int
}

func (stub *stubSFTPService) Connect(endpointID, requestID string, payload coretypes.SFTPConnectPayload) error {
	stub.connectID = endpointID
	return nil
}
func (stub *stubSFTPService) Disconnect(endpointID, requestID string) error { return nil }
func (stub *stubSFTPService) RespondKeyboardInteractive(endpointID, challengeID string, responses []string) error {
	stub.responded = true
	return nil
}
func (stub *stubSFTPService) List(endpointID, requestID string, payload coretypes.SFTPListPayload) error {
	return nil
}
func (stub *stubSFTPService) Mkdir(endpointID, requestID string, payload coretypes.SFTPMkdirPayload) error {
	return nil
}
func (stub *stubSFTPService) Rename(endpointID, requestID string, payload coretypes.SFTPRenamePayload) error {
	return nil
}
func (stub *stubSFTPService) Chmod(endpointID, requestID string, payload coretypes.SFTPChmodPayload) error {
	return nil
}
func (stub *stubSFTPService) Chown(endpointID, requestID string, payload coretypes.SFTPChownPayload) error {
	return nil
}
func (stub *stubSFTPService) ListPrincipals(endpointID, requestID string, payload coretypes.SFTPListPrincipalsPayload) error {
	return nil
}
func (stub *stubSFTPService) Delete(endpointID, requestID string, payload coretypes.SFTPDeletePayload) error {
	return nil
}
func (stub *stubSFTPService) StartTransfer(jobID string, payload coretypes.SFTPTransferStartPayload) error {
	return nil
}
func (stub *stubSFTPService) CancelTransfer(jobID string) error { return nil }
func (stub *stubSFTPService) Shutdown()                         { stub.shutdownCall++ }

type stubContainersService struct {
	responded        bool
	startWithClient  bool
	takeClientCalled string
	shutdownCall     int
	client           *ssh.Client
}

func (stub *stubContainersService) Connect(endpointID, requestID string, payload coretypes.ContainersConnectPayload) error {
	return nil
}
func (stub *stubContainersService) Disconnect(endpointID, requestID string) error { return nil }
func (stub *stubContainersService) TakeClient(endpointID string) (*ssh.Client, error) {
	stub.takeClientCalled = endpointID
	return stub.client, nil
}
func (stub *stubContainersService) RespondKeyboardInteractive(endpointID, challengeID string, responses []string) error {
	stub.responded = true
	return nil
}
func (stub *stubContainersService) List(endpointID, requestID string) error { return nil }
func (stub *stubContainersService) Inspect(endpointID, requestID string, payload coretypes.ContainersInspectPayload) error {
	return nil
}
func (stub *stubContainersService) Logs(endpointID, requestID string, payload coretypes.ContainersLogsPayload) error {
	return nil
}
func (stub *stubContainersService) Start(endpointID, requestID string, payload coretypes.ContainersActionPayload) error {
	return nil
}
func (stub *stubContainersService) Stop(endpointID, requestID string, payload coretypes.ContainersActionPayload) error {
	return nil
}
func (stub *stubContainersService) Restart(endpointID, requestID string, payload coretypes.ContainersActionPayload) error {
	return nil
}
func (stub *stubContainersService) Remove(endpointID, requestID string, payload coretypes.ContainersActionPayload) error {
	return nil
}
func (stub *stubContainersService) Stats(endpointID, requestID string, payload coretypes.ContainersStatsPayload) error {
	return nil
}
func (stub *stubContainersService) SearchLogs(endpointID, requestID string, payload coretypes.ContainersSearchLogsPayload) error {
	return nil
}
func (stub *stubContainersService) Shutdown() { stub.shutdownCall++ }

type stubForwardingService struct {
	respondErr    error
	responded     bool
	startedRuleID string
	startedWith   bool
	stoppedRuleID string
	shutdownCall  int
}

func (stub *stubForwardingService) RespondKeyboardInteractive(endpointID, challengeID string, responses []string) error {
	stub.responded = true
	return stub.respondErr
}
func (stub *stubForwardingService) Start(ruleID, requestID string, payload coretypes.PortForwardStartPayload) error {
	stub.startedRuleID = ruleID
	return nil
}
func (stub *stubForwardingService) StartWithClient(ruleID, requestID string, payload coretypes.PortForwardStartPayload, client *ssh.Client) error {
	stub.startedRuleID = ruleID
	stub.startedWith = true
	return nil
}
func (stub *stubForwardingService) Stop(ruleID, requestID string) error {
	stub.stoppedRuleID = ruleID
	return nil
}
func (stub *stubForwardingService) Shutdown() { stub.shutdownCall++ }

type stubSSMForwardingService struct {
	shutdownCall int
}

func (stub *stubSSMForwardingService) Start(ruleID, requestID string, payload coretypes.SSMPortForwardStartPayload) error {
	return nil
}
func (stub *stubSSMForwardingService) Stop(ruleID, requestID string) error { return nil }
func (stub *stubSSMForwardingService) Shutdown()                           { stub.shutdownCall++ }

func TestRuntimeRoutesSessionIOResizeDisconnectAndSignals(t *testing.T) {
	sshManager := &stubSSHManager{}
	awsManager := &stubAWSManager{hasSession: true}
	localManager := &stubLocalManager{}
	serialManager := &stubSerialManager{}
	runtime := newRuntimeWithDeps(
		func(coretypes.Event) {},
		func(coretypes.StreamFrame, []byte) {},
		sshManager,
		awsManager,
		localManager,
		serialManager,
		&stubSFTPService{},
		&stubContainersService{},
		&stubForwardingService{},
		&stubSSMForwardingService{},
		nil,
		nil,
	)

	if err := runtime.SendSessionInput("session-aws", []byte("ls\r")); err != nil {
		t.Fatalf("SendSessionInput() error = %v", err)
	}
	if awsManager.writeSession != "session-aws" || string(awsManager.writeData) != "ls\r" {
		t.Fatalf("AWS manager did not receive input: %#v", awsManager)
	}

	if err := runtime.ResizeSession("session-aws", coretypes.ResizePayload{Cols: 140, Rows: 42}); err != nil {
		t.Fatalf("ResizeSession() error = %v", err)
	}
	if awsManager.resizeID != "session-aws" || awsManager.resizeCols != 140 || awsManager.resizeRows != 42 {
		t.Fatalf("AWS manager did not receive resize: %#v", awsManager)
	}

	if err := runtime.SendControlSignal("session-aws", coretypes.ControlSignalPayload{Signal: "SIGINT"}); err != nil {
		t.Fatalf("SendControlSignal() error = %v", err)
	}
	if awsManager.signal != "SIGINT" {
		t.Fatalf("expected SIGINT to be forwarded, got %q", awsManager.signal)
	}

	if err := runtime.DisconnectSession("session-aws"); err != nil {
		t.Fatalf("DisconnectSession() error = %v", err)
	}
	if awsManager.disconnectID != "session-aws" {
		t.Fatalf("expected AWS disconnect, got %#v", awsManager)
	}

	awsManager.hasSession = false
	localManager.hasSession = true
	if err := runtime.SendSessionInput("session-local", []byte("pwd\r")); err != nil {
		t.Fatalf("SendSessionInput() local error = %v", err)
	}
	if localManager.writeSession != "session-local" {
		t.Fatalf("expected local manager write, got %#v", localManager)
	}

	localManager.hasSession = false
	serialManager.hasSession = true
	if err := runtime.SendSessionInput("session-serial", []byte("help\r")); err != nil {
		t.Fatalf("SendSessionInput() serial error = %v", err)
	}
	if serialManager.writeSession != "session-serial" {
		t.Fatalf("expected serial manager write, got %#v", serialManager)
	}

	serialManager.hasSession = false
	sshManager.hasSession = true
	if err := runtime.SendSessionInput("session-ssh", []byte("uname -a\r")); err != nil {
		t.Fatalf("SendSessionInput() ssh error = %v", err)
	}
	if sshManager.writeSession != "session-ssh" || string(sshManager.writeData) != "uname -a\r" {
		t.Fatalf("expected SSH manager write, got %#v", sshManager)
	}
}

func TestRuntimeRoutesKeyboardInteractivePortForwardAndShutdown(t *testing.T) {
	sftp := &stubSFTPService{}
	containers := &stubContainersService{}
	forwarding := &stubForwardingService{respondErr: errors.New("not a forwarding endpoint")}
	ssmForwarding := &stubSSMForwardingService{}
	aws := &stubAWSManager{}
	runtime := newRuntimeWithDeps(
		func(coretypes.Event) {},
		func(coretypes.StreamFrame, []byte) {},
		&stubSSHManager{},
		aws,
		&stubLocalManager{},
		&stubSerialManager{},
		sftp,
		containers,
		forwarding,
		ssmForwarding,
		nil,
		nil,
	)

	if err := runtime.RespondKeyboardInteractive("", "containers:endpoint", coretypes.KeyboardInteractiveRespondPayload{
		ChallengeID: "challenge-1",
		Responses:   []string{"secret"},
	}); err != nil {
		t.Fatalf("containers keyboard-interactive error = %v", err)
	}
	if !containers.responded {
		t.Fatal("expected containers keyboard-interactive to be used")
	}

	if err := runtime.RespondKeyboardInteractive("", "sftp:endpoint", coretypes.KeyboardInteractiveRespondPayload{
		ChallengeID: "challenge-2",
		Responses:   []string{"123456"},
	}); err != nil {
		t.Fatalf("sftp keyboard-interactive error = %v", err)
	}
	if !forwarding.responded || !sftp.responded {
		t.Fatalf("expected forwarding fallback then sftp response, got forwarding=%v sftp=%v", forwarding.responded, sftp.responded)
	}

	if err := runtime.StartPortForward("rule-1", "req-1", coretypes.PortForwardStartPayload{
		SourceEndpointID: "containers:endpoint",
	}); err != nil {
		t.Fatalf("StartPortForward() error = %v", err)
	}
	if containers.takeClientCalled != "containers:endpoint" || !forwarding.startedWith {
		t.Fatalf("expected StartWithClient path, got containers=%#v forwarding=%#v", containers, forwarding)
	}

	runtime.Shutdown()
	if aws.shutdownCall != 1 || sftp.shutdownCall != 1 || containers.shutdownCall != 1 || forwarding.shutdownCall != 1 || ssmForwarding.shutdownCall != 1 {
		t.Fatalf("expected shutdown on all services, got aws=%d sftp=%d containers=%d forwarding=%d ssm=%d", aws.shutdownCall, sftp.shutdownCall, containers.shutdownCall, forwarding.shutdownCall, ssmForwarding.shutdownCall)
	}
}
