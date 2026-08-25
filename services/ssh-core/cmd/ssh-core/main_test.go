package main

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

type stubCoreRuntime struct {
	// 재주입 요청에 실려 온 셸 이름(렌더러가 알아낸 값). 힌트가 흘러오는지 확인한다.
	reinjectShell       string
	awsConnectSession   string
	awsConnectPayload   protocol.AWSConnectPayload
	inputSession        string
	inputPayload        []byte
	awsConnectDone      chan struct{}
	tailnetTestID       string
	tailnetDisconnectID string
	tailnetCancelID     string
	tailnetConfigured   []protocol.TailnetConfigPayload
	tailnetSnapshots    int
	tailnetTestDone     chan struct{}
	tailnetForgetID     string
	tailnetForgetDone   chan struct{}
	// probeStarted·probeRelease 는 프로브가 사람의 답을 기다리는 상태를 흉내낸다.
	probeStarted        chan struct{}
	probeRelease        chan struct{}
	tailnetSnapshotDone chan struct{}

	// 아래는 라우터 테스트용이다. 라우터는 핸들러를 여러 고루틴에서 부르므로 여기 값들은 mutex 로
	// 지킨다(기존 테스트는 프레임을 하나씩 동기로 넣으므로 경쟁이 없다).
	mu sync.Mutex
	// inputs 는 세션 입력을 받은 순서다 — 같은 세션의 순서 보존을 확인한다.
	inputs []string
	// inputGate 가 있으면 첫 입력이 여기서 멈춘다(뒤 프레임이 새치기하는지 보려고).
	inputGate     chan struct{}
	inputGateUsed bool
	// 포워딩 시작이 사람을 기다리는 상태를 흉내낸다.
	forwardStarted     chan struct{}
	forwardRelease     chan struct{}
	forwardReleaseOnce sync.Once
	// forwardStopped 는 정지 핸들러가 실행됐다는 신호다.
	forwardStopped chan struct{}
	// cancelledInFlight 는 라우터가 끊으라고 지목한 대상들이다.
	cancelledInFlight []string
	// hostKeyTrustAnswers·hostKeyTrustDone 은 신뢰 응답 프레임이 처리됐다는 기록·신호다.
	hostKeyTrustAnswers []string
	hostKeyTrustDone    chan struct{}
	// respondDone 은 인증 응답 프레임이 처리됐다는 신호다.
	respondDone chan struct{}
	// configureRelease 가 있으면 tailnetConfigure 가 그동안 멈춘다(배리어 확인용).
	configureRelease chan struct{}
	// connectSawConfig 는 연결 핸들러가 돌 때 tailnet 설정이 이미 적용돼 있었는지다.
	connectSawConfig bool
	connectDone      chan struct{}
}

func (stub *stubCoreRuntime) EmitReady()              {}
func (stub *stubCoreRuntime) Health(requestID string) {}
func (stub *stubCoreRuntime) ConnectSSH(sessionID, requestID string, payload protocol.ConnectPayload) error {
	stub.mu.Lock()
	stub.connectSawConfig = len(stub.tailnetConfigured) > 0
	done := stub.connectDone
	stub.connectDone = nil
	stub.mu.Unlock()
	if done != nil {
		close(done)
	}
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
func (stub *stubCoreRuntime) ConnectTmux(sessionID, requestID string, payload protocol.ConnectPayload) error {
	return nil
}
func (stub *stubCoreRuntime) TmuxSplitPane(sessionID, direction string) error     { return nil }
func (stub *stubCoreRuntime) TmuxNewWindow(sessionID string) error                { return nil }
func (stub *stubCoreRuntime) TmuxSelectWindow(sessionID, windowID string) error   { return nil }
func (stub *stubCoreRuntime) TmuxSelectPane(sessionID string) error               { return nil }
func (stub *stubCoreRuntime) TmuxControlCommand(sessionID, command string) error  { return nil }
func (stub *stubCoreRuntime) TmuxKillPane(sessionID string) error                 { return nil }
func (stub *stubCoreRuntime) TmuxKillWindow(sessionID, windowID string) error     { return nil }
func (stub *stubCoreRuntime) TmuxKillSession(sessionID, sessionName string) error { return nil }
func (stub *stubCoreRuntime) TmuxRenameWindow(sessionID, windowID, name string) error {
	return nil
}
func (stub *stubCoreRuntime) TmuxDetach(sessionID string) error { return nil }
func (stub *stubCoreRuntime) ControlSerial(sessionID string, payload protocol.SerialControlPayload) error {
	return nil
}
func (stub *stubCoreRuntime) SendSessionInput(sessionID string, data []byte) error {
	stub.mu.Lock()
	stub.inputSession = sessionID
	stub.inputPayload = append([]byte(nil), data...)
	gate := stub.inputGate
	if gate != nil && !stub.inputGateUsed {
		stub.inputGateUsed = true
	} else {
		gate = nil
	}
	stub.mu.Unlock()

	// 첫 입력만 붙잡아 둔다. 순서가 보존되면 뒤의 입력은 이것이 풀린 뒤에야 기록된다.
	if gate != nil {
		<-gate
	}

	stub.mu.Lock()
	stub.inputs = append(stub.inputs, string(data))
	stub.mu.Unlock()
	return nil
}
func (stub *stubCoreRuntime) SendControlSignal(sessionID string, payload protocol.ControlSignalPayload) error {
	return nil
}
func (stub *stubCoreRuntime) ResizeSession(sessionID string, payload protocol.ResizePayload) error {
	return nil
}
func (stub *stubCoreRuntime) DisconnectSession(sessionID string) error              { return nil }
func (stub *stubCoreRuntime) PrepareAutocomplete(sessionID, requestID string) error { return nil }
func (stub *stubCoreRuntime) RefreshAutocomplete(sessionID, requestID string) error { return nil }
func (stub *stubCoreRuntime) StopAutocomplete(sessionID string)                     {}
func (stub *stubCoreRuntime) InstallShellIntegration(sessionID string) error        { return nil }
func (stub *stubCoreRuntime) ReinjectShellIntegration(sessionID string, shell string) error {
	stub.reinjectShell = shell
	return nil
}
func (stub *stubCoreRuntime) RunCompletionQuery(sessionID, requestID, command string, _, _ bool) error {
	return nil
}
func (stub *stubCoreRuntime) RunCommand(sessionID, requestID, command string, timeoutMs int) error {
	return nil
}
func (stub *stubCoreRuntime) TailnetTest(requestID string, payload protocol.TailnetTestPayload) error {
	stub.tailnetTestID = payload.Config.ID
	if stub.tailnetTestDone != nil {
		close(stub.tailnetTestDone)
	}
	return nil
}
func (stub *stubCoreRuntime) TailnetForget(requestID string, payload protocol.TailnetForgetPayload) error {
	stub.tailnetForgetID = payload.ID
	if stub.tailnetForgetDone != nil {
		close(stub.tailnetForgetDone)
	}
	return nil
}

func (stub *stubCoreRuntime) TailnetDisconnect(_ string, payload protocol.TailnetDisconnectPayload) error {
	stub.tailnetDisconnectID = payload.ID
	return nil
}

func (stub *stubCoreRuntime) TailnetCancel(_ string, payload protocol.TailnetDisconnectPayload) error {
	stub.tailnetCancelID = payload.ID
	return nil
}

func (stub *stubCoreRuntime) TailnetForwardOpen(
	_ string,
	_ protocol.TailnetForwardOpenPayload,
) error {
	return nil
}

func (stub *stubCoreRuntime) TailnetForwardClose(_ protocol.TailnetForwardClosePayload) error {
	return nil
}

func (stub *stubCoreRuntime) TailnetSnapshot(_ string) error {
	stub.mu.Lock()
	stub.tailnetSnapshots += 1
	stub.mu.Unlock()
	if stub.tailnetSnapshotDone != nil {
		close(stub.tailnetSnapshotDone)
	}
	return nil
}

func (stub *stubCoreRuntime) TailnetConfigure(payload protocol.TailnetConfigurePayload) error {
	if stub.configureRelease != nil {
		<-stub.configureRelease
	}
	stub.mu.Lock()
	stub.tailnetConfigured = payload.Configs
	stub.mu.Unlock()
	return nil
}
func (stub *stubCoreRuntime) ProbeHostKey(requestID string, payload protocol.HostKeyProbePayload) error {
	if stub.probeStarted != nil {
		close(stub.probeStarted)
	}
	if stub.probeRelease != nil {
		<-stub.probeRelease
	}
	return nil
}
func (stub *stubCoreRuntime) InspectCertificate(requestID string, payload protocol.CertificateInspectPayload) error {
	return nil
}
func (stub *stubCoreRuntime) GeneratePrivateKey(requestID string, payload protocol.PrivateKeyGeneratePayload) error {
	return nil
}
func (stub *stubCoreRuntime) InspectPrivateKey(requestID string, payload protocol.PrivateKeyInspectPayload) error {
	return nil
}
func (stub *stubCoreRuntime) InstallAuthorizedKey(requestID, correlationID string, payload protocol.AuthorizedKeyInstallPayload) error {
	return nil
}
func (stub *stubCoreRuntime) RespondHostKeyTrust(payload protocol.HostKeyTrustRespondPayload) error {
	stub.mu.Lock()
	stub.hostKeyTrustAnswers = append(stub.hostKeyTrustAnswers, payload.ChallengeID)
	stub.mu.Unlock()
	if stub.hostKeyTrustDone != nil {
		close(stub.hostKeyTrustDone)
	}
	return nil
}

func (stub *stubCoreRuntime) CancelInFlight(sessionID, endpointID string) {
	stub.mu.Lock()
	if sessionID != "" {
		stub.cancelledInFlight = append(stub.cancelledInFlight, sessionID)
	}
	if endpointID != "" {
		stub.cancelledInFlight = append(stub.cancelledInFlight, endpointID)
	}
	stub.mu.Unlock()
	// 스텁에서는 "붙는 중" 을 흉내내는 대기를 풀어 준다 — 실제 코어가 ctx 를 취소하는 것과 같은 효과다.
	stub.releaseForward()
}

// releaseForward 는 붙는 중인 포워딩을 한 번만 풀어 준다(취소와 테스트 정리가 겹칠 수 있다).
func (stub *stubCoreRuntime) releaseForward() {
	if stub.forwardRelease == nil {
		return
	}
	stub.forwardReleaseOnce.Do(func() { close(stub.forwardRelease) })
}

func (stub *stubCoreRuntime) RespondKeyboardInteractive(sessionID, endpointID string, payload protocol.KeyboardInteractiveRespondPayload) error {
	if stub.respondDone != nil {
		close(stub.respondDone)
	}
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
	if stub.forwardStarted != nil {
		close(stub.forwardStarted)
	}
	if stub.forwardRelease != nil {
		<-stub.forwardRelease
	}
	return nil
}
func (stub *stubCoreRuntime) StopPortForward(endpointID, requestID string) error {
	if stub.forwardStopped != nil {
		close(stub.forwardStopped)
	}
	return nil
}
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
func (stub *stubCoreRuntime) ChownSFTP(endpointID, requestID string, payload protocol.SFTPChownPayload) error {
	return nil
}
func (stub *stubCoreRuntime) ListSFTPPrincipals(endpointID, requestID string, payload protocol.SFTPListPrincipalsPayload) error {
	return nil
}
func (stub *stubCoreRuntime) DeleteSFTP(endpointID, requestID string, payload protocol.SFTPDeletePayload) error {
	return nil
}
func (stub *stubCoreRuntime) ReadFileSFTP(endpointID, requestID string, payload protocol.SFTPReadFilePayload) error {
	return nil
}
func (stub *stubCoreRuntime) WriteFileSFTP(endpointID, requestID string, payload protocol.SFTPWriteFilePayload) error {
	return nil
}
func (stub *stubCoreRuntime) StartSFTPTransfer(jobID string, payload protocol.SFTPTransferStartPayload) error {
	return nil
}
func (stub *stubCoreRuntime) CancelSFTPTransfer(jobID string) error { return nil }
func (stub *stubCoreRuntime) PauseSFTPTransfer(jobID string) error  { return nil }
func (stub *stubCoreRuntime) ResumeSFTPTransfer(jobID string) error { return nil }
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

func TestDispatchTailnetTestUsesRuntimeFacade(t *testing.T) {
	core := &stubCoreRuntime{tailnetTestDone: make(chan struct{})}
	payload, err := json.Marshal(protocol.TailnetTestPayload{
		Config: protocol.TailnetConfigPayload{
			ID:         "corp",
			Hostname:   "dolgate-laptop",
			ControlURL: "https://headscale.example.com",
			Ephemeral:  true,
		},
	})
	if err != nil {
		t.Fatalf("marshal tailnet payload: %v", err)
	}

	if err := dispatch(core, newEventWriter(), protocol.Request{
		ID:      "req-tailnet-1",
		Type:    protocol.CommandTailnetTest,
		Payload: payload,
	}); err != nil {
		t.Fatalf("dispatch() error = %v", err)
	}

	select {
	case <-core.tailnetTestDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for async tailnet test dispatch")
	}

	if core.tailnetTestID != "corp" {
		t.Fatalf("expected tailnet test for corp, got %q", core.tailnetTestID)
	}
}

func TestDispatchTailnetForgetUsesRuntimeFacade(t *testing.T) {
	core := &stubCoreRuntime{tailnetForgetDone: make(chan struct{})}
	payload, err := json.Marshal(protocol.TailnetForgetPayload{ID: "corp"})
	if err != nil {
		t.Fatalf("marshal forget payload: %v", err)
	}

	if err := dispatch(core, newEventWriter(), protocol.Request{
		ID:      "req-tailnet-2",
		Type:    protocol.CommandTailnetForget,
		Payload: payload,
	}); err != nil {
		t.Fatalf("dispatch() error = %v", err)
	}

	select {
	case <-core.tailnetForgetDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for async tailnet forget dispatch")
	}

	if core.tailnetForgetID != "corp" {
		t.Fatalf("expected tailnet forget for corp, got %q", core.tailnetForgetID)
	}
}

// Configure 는 동기여야 한다. 데스크톱이 코어를 띄운 직후 보내고 곧바로 연결을 요청하는데,
// 비동기로 돌리면 그 연결이 설정을 못 보고 "is not configured" 로 실패한다.
func TestDispatchTailnetConfigureAppliesBeforeReturning(t *testing.T) {
	core := &stubCoreRuntime{}
	payload, err := json.Marshal(protocol.TailnetConfigurePayload{
		Configs: []protocol.TailnetConfigPayload{{ID: "corp", AuthKey: "tskey-abc"}},
	})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	if err := dispatch(core, newEventWriter(), protocol.Request{
		ID:      "req-1",
		Type:    protocol.CommandTailnetConfigure,
		Payload: payload,
	}); err != nil {
		t.Fatalf("dispatch() error = %v", err)
	}

	if len(core.tailnetConfigured) != 1 || core.tailnetConfigured[0].ID != "corp" {
		t.Errorf("configured = %#v, want one config for corp", core.tailnetConfigured)
	}
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return encoded
}
