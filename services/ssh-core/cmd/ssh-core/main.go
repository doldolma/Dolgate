package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"

	"dolssh/services/ssh-core/internal/neterr"
	"dolssh/services/ssh-core/internal/protocol"
	coreruntime "dolssh/services/ssh-core/pkg/runtime"
)

type coreRuntime interface {
	EmitReady()
	Health(requestID string)
	ConnectSSH(sessionID, requestID string, payload protocol.ConnectPayload) error
	ConnectTmux(sessionID, requestID string, payload protocol.ConnectPayload) error
	TmuxSplitPane(sessionID, direction string) error
	TmuxNewWindow(sessionID string) error
	TmuxSelectWindow(sessionID, windowID string) error
	TmuxSelectPane(sessionID string) error
	TmuxControlCommand(sessionID, command string) error
	TmuxKillPane(sessionID string) error
	TmuxKillWindow(sessionID, windowID string) error
	TmuxKillSession(sessionID, sessionName string) error
	TmuxRenameWindow(sessionID, windowID, name string) error
	TmuxDetach(sessionID string) error
	TailnetTest(requestID string, payload protocol.TailnetTestPayload) error
	TailnetForget(requestID string, payload protocol.TailnetForgetPayload) error
	TailnetDisconnect(requestID string, payload protocol.TailnetDisconnectPayload) error
	TailnetCancel(requestID string, payload protocol.TailnetDisconnectPayload) error
	TailnetSnapshot(requestID string) error
	TailnetForwardOpen(requestID string, payload protocol.TailnetForwardOpenPayload) error
	TailnetForwardClose(payload protocol.TailnetForwardClosePayload) error
	TailnetConfigure(payload protocol.TailnetConfigurePayload) error
	ConnectAWS(sessionID, requestID string, payload protocol.AWSConnectPayload) error
	ConnectLocal(sessionID, requestID string, payload protocol.LocalConnectPayload) error
	ConnectSerial(sessionID, requestID string, payload protocol.SerialConnectPayload) error
	ListSerialPorts(requestID string, payload protocol.SerialListPortsPayload) error
	ControlSerial(sessionID string, payload protocol.SerialControlPayload) error
	SendSessionInput(sessionID string, data []byte) error
	SendControlSignal(sessionID string, payload protocol.ControlSignalPayload) error
	ResizeSession(sessionID string, payload protocol.ResizePayload) error
	DisconnectSession(sessionID string) error
	PrepareAutocomplete(sessionID, requestID string) error
	RefreshAutocomplete(sessionID, requestID string) error
	StopAutocomplete(sessionID string)
	RunCompletionQuery(sessionID, requestID, command string, background, elevate bool) error
	RunCommand(sessionID, requestID, command string, timeoutMs int) error
	InstallShellIntegration(sessionID string) error
	ReinjectShellIntegration(sessionID string, shell string) error
	ProbeHostKey(requestID string, payload protocol.HostKeyProbePayload) error
	InspectCertificate(requestID string, payload protocol.CertificateInspectPayload) error
	GeneratePrivateKey(requestID string, payload protocol.PrivateKeyGeneratePayload) error
	InspectPrivateKey(requestID string, payload protocol.PrivateKeyInspectPayload) error
	// correlationID 를 함께 받는다 — 호스트가 인증을 물으면 그 물음을 화면의 설치 대화상자에
	// 붙여야 한다(shared/ipc.ts 의 KEY_INSTALL_CORRELATION_PREFIX).
	InstallAuthorizedKey(requestID, correlationID string, payload protocol.AuthorizedKeyInstallPayload) error
	RespondKeyboardInteractive(sessionID, endpointID string, payload protocol.KeyboardInteractiveRespondPayload) error
	// RespondHostKeyTrust 는 연결 중 신뢰 질의의 답이다(호스트 키를 이 연결 안에서 확인한다).
	RespondHostKeyTrust(payload protocol.HostKeyTrustRespondPayload) error
	// CancelInFlight 는 정지·종료 명령을 배차하기 전에 진행 중인 작업을 끊는다(router.go 참고).
	CancelInFlight(sessionID, endpointID string)
	ConnectContainers(endpointID, requestID string, payload protocol.ContainersConnectPayload) error
	DisconnectContainers(endpointID, requestID string) error
	ListContainers(endpointID, requestID string) error
	InspectContainer(endpointID, requestID string, payload protocol.ContainersInspectPayload) error
	LogsContainers(endpointID, requestID string, payload protocol.ContainersLogsPayload) error
	StartContainer(endpointID, requestID string, payload protocol.ContainersActionPayload) error
	StopContainer(endpointID, requestID string, payload protocol.ContainersActionPayload) error
	RestartContainer(endpointID, requestID string, payload protocol.ContainersActionPayload) error
	RemoveContainer(endpointID, requestID string, payload protocol.ContainersActionPayload) error
	StatsContainers(endpointID, requestID string, payload protocol.ContainersStatsPayload) error
	SearchContainerLogs(endpointID, requestID string, payload protocol.ContainersSearchLogsPayload) error
	StartPortForward(endpointID, requestID string, payload protocol.PortForwardStartPayload) error
	StopPortForward(endpointID, requestID string) error
	StartSSMPortForward(endpointID, requestID string, payload protocol.SSMPortForwardStartPayload) error
	StopSSMPortForward(endpointID, requestID string) error
	ConnectSFTP(endpointID, requestID string, payload protocol.SFTPConnectPayload) error
	DisconnectSFTP(endpointID, requestID string) error
	ListSFTP(endpointID, requestID string, payload protocol.SFTPListPayload) error
	MkdirSFTP(endpointID, requestID string, payload protocol.SFTPMkdirPayload) error
	RenameSFTP(endpointID, requestID string, payload protocol.SFTPRenamePayload) error
	ChmodSFTP(endpointID, requestID string, payload protocol.SFTPChmodPayload) error
	ChownSFTP(endpointID, requestID string, payload protocol.SFTPChownPayload) error
	ListSFTPPrincipals(endpointID, requestID string, payload protocol.SFTPListPrincipalsPayload) error
	DeleteSFTP(endpointID, requestID string, payload protocol.SFTPDeletePayload) error
	ReadFileSFTP(endpointID, requestID string, payload protocol.SFTPReadFilePayload) error
	WriteFileSFTP(endpointID, requestID string, payload protocol.SFTPWriteFilePayload) error
	StartSFTPTransfer(jobID string, payload protocol.SFTPTransferStartPayload) error
	CancelSFTPTransfer(jobID string) error
	PauseSFTPTransfer(jobID string) error
	ResumeSFTPTransfer(jobID string) error
	Shutdown()
}

type eventWriter struct {
	mu sync.Mutex
}

func newEventWriter() *eventWriter {
	return &eventWriter{}
}

func (writer *eventWriter) emit(event protocol.Event) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	_ = protocol.WriteControlFrame(os.Stdout, event)
}

func (writer *eventWriter) emitStream(metadata protocol.StreamFrame, payload []byte) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	_ = protocol.WriteStreamFrame(os.Stdout, metadata, payload)
}

func main() {
	writer := newEventWriter()
	core := coreruntime.New(coreruntime.Options{
		EmitEvent:  writer.emit,
		EmitStream: writer.emitStream,
		// tailnet 노드 상태를 둘 곳. 앱이 자기 데이터 디렉터리를 알려준다 — 비워 두면
		// tsnet 이 os.UserConfigDir() 밑에 앱과 무관한 경로를 만들어, 사용자가 찾을 수도
		// 등록 해제로 지울 수도 없게 된다. 값이 없으면 tailnet 명령만 거절되고 나머지
		// 기능은 그대로 동작한다.
		TailnetStateDir: os.Getenv("DOLGATE_TAILNET_STATE_DIR"),
	})
	// 시그널로 죽으면 defer 는 실행되지 않는다. 데스크톱은 종료할 때 stdin 을 닫으면서
	// SIGTERM 도 같이 보내는데, 시그널이 EOF 보다 먼저 도착하면 Shutdown 이 통째로
	// 건너뛰어져 tailnet 노드가 컨트롤 플레인에 붙은 채로 남는다.
	var shutdownOnce sync.Once
	shutdown := func() { shutdownOnce.Do(core.Shutdown) }
	defer shutdown()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signals
		shutdown()
		os.Exit(0)
	}()

	core.EmitReady()

	// 읽기 고루틴은 읽고 배차만 한다. 핸들러를 여기서 실행하면 느린 작업 하나가 다른 모든 요청을
	// 막고, 사람의 답을 기다리는 작업은 그 답(다음 프레임)을 읽을 주체가 없어 교착이 된다.
	router := newFrameRouter(core, writer)

	for {
		frame, err := protocol.ReadFrame(os.Stdin)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return
			}
			writer.emit(protocol.Event{
				Type: protocol.EventError,
				Payload: protocol.ErrorPayload{
					Message: err.Error(),
				},
			})
			return
		}

		router.route(frame)
	}
}

func dispatchFrame(core coreRuntime, writer *eventWriter, frame protocol.Frame) error {
	if frame.Kind == protocol.FrameKindStream {
		var metadata protocol.StreamFrame
		if err := protocol.DecodeStreamFrame(frame, &metadata); err != nil {
			return fmt.Errorf("invalid stream frame: %w", err)
		}
		if metadata.Type != protocol.StreamTypeWrite {
			return fmt.Errorf("unsupported stream type: %s", metadata.Type)
		}
		return core.SendSessionInput(metadata.SessionID, frame.Payload)
	}

	var request protocol.Request
	if err := protocol.DecodeControlFrame(frame, &request); err != nil {
		return fmt.Errorf("invalid control frame: %w", err)
	}
	return dispatch(core, writer, request)
}

func dispatch(core coreRuntime, writer *eventWriter, request protocol.Request) error {
	switch request.Type {
	case protocol.CommandHealth:
		core.Health(request.ID)
		return nil
	case protocol.CommandConnect:
		var payload protocol.ConnectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		go emitAsyncError(writer, request.ID, request.SessionID, "", protocol.EventError, func() error {
			return core.ConnectSSH(request.SessionID, request.ID, payload)
		})()
		return nil
	case protocol.CommandTmuxConnect:
		var payload protocol.ConnectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		go emitAsyncError(writer, request.ID, request.SessionID, "", protocol.EventError, func() error {
			return core.ConnectTmux(request.SessionID, request.ID, payload)
		})()
		return nil
	case protocol.CommandAWSConnect:
		var payload protocol.AWSConnectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		go emitAsyncError(writer, request.ID, request.SessionID, "", protocol.EventError, func() error {
			return core.ConnectAWS(request.SessionID, request.ID, payload)
		})()
		return nil
	case protocol.CommandLocalConnect:
		var payload protocol.LocalConnectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		go emitAsyncError(writer, request.ID, request.SessionID, "", protocol.EventError, func() error {
			return core.ConnectLocal(request.SessionID, request.ID, payload)
		})()
		return nil
	case protocol.CommandSerialConnect:
		var payload protocol.SerialConnectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		go emitAsyncError(writer, request.ID, request.SessionID, "", protocol.EventError, func() error {
			return core.ConnectSerial(request.SessionID, request.ID, payload)
		})()
		return nil
	case protocol.CommandSerialListPorts:
		var payload protocol.SerialListPortsPayload
		if len(request.Payload) > 0 {
			if err := json.Unmarshal(request.Payload, &payload); err != nil {
				return err
			}
		}
		return core.ListSerialPorts(request.ID, payload)
	case protocol.CommandSerialControl:
		var payload protocol.SerialControlPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		if err := core.ControlSerial(request.SessionID, payload); err != nil {
			return err
		}
		writer.emit(protocol.Event{
			Type:      protocol.EventSerialControlCompleted,
			RequestID: request.ID,
			SessionID: request.SessionID,
			Payload: protocol.SerialControlCompletedPayload{
				Action:  payload.Action,
				Enabled: payload.Enabled,
			},
		})
		return nil
	case protocol.CommandTailnetTest:
		var payload protocol.TailnetTestPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		// 노드가 올라오기까지 사람이 브라우저에서 로그인하는 시간이 들어갈 수 있어 오래
		// 걸린다. 다른 요청을 막지 않도록 비동기로 돌린다.
		go emitAsyncError(writer, request.ID, "", "", protocol.EventError, func() error {
			return core.TailnetTest(request.ID, payload)
		})()
		return nil
	case protocol.CommandTailnetDisconnect:
		var payload protocol.TailnetDisconnectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		go emitAsyncError(writer, request.ID, "", "", protocol.EventError, func() error {
			return core.TailnetDisconnect(request.ID, payload)
		})()
		return nil
	case protocol.CommandTailnetCancel:
		var payload protocol.TailnetDisconnectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		go emitAsyncError(writer, request.ID, "", "", protocol.EventError, func() error {
			return core.TailnetCancel(request.ID, payload)
		})()
		return nil
	case protocol.CommandTailnetConfigure:
		var payload protocol.TailnetConfigurePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		// 동기다. 데스크톱이 코어를 띄운 직후 보내는데, 뒤따라오는 연결 요청이 설정을 볼 수
		// 있어야 한다. 노드를 올리지 않으므로 오래 걸리지도 않는다.
		return core.TailnetConfigure(payload)
	case protocol.CommandTailnetSnapshot:
		go emitAsyncError(writer, request.ID, "", "", protocol.EventError, func() error {
			return core.TailnetSnapshot(request.ID)
		})()
		return nil
	case protocol.CommandTailnetForwardOpen:
		var payload protocol.TailnetForwardOpenPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		go emitAsyncError(writer, request.ID, "", "", protocol.EventError, func() error {
			return core.TailnetForwardOpen(request.ID, payload)
		})()
		return nil
	case protocol.CommandTailnetForwardClose:
		var payload protocol.TailnetForwardClosePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.TailnetForwardClose(payload)
	case protocol.CommandTailnetForget:
		var payload protocol.TailnetForgetPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		go emitAsyncError(writer, request.ID, "", "", protocol.EventError, func() error {
			return core.TailnetForget(request.ID, payload)
		})()
		return nil
	case protocol.CommandProbeHostKey:
		var payload protocol.HostKeyProbePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		// 프로브는 점프 호스트의 대화형 인증(OTP) 때문에 사람을 기다릴 수 있다. 그 답은 다음
		// 프레임으로 오므로, 읽기 고루틴에서 실행하면 서로를 영원히 기다린다.
		//
		// 격리는 라우터가 한다 — 이 명령은 `probe:<requestID>` 라는 자기 줄에서 돌아서 다른 요청을
		// 막지 않는다(router.go 의 frameScope 참고). 그래서 여기서는 평범하게 부른다.
		return core.ProbeHostKey(request.ID, payload)
	case protocol.CommandInspectCertificate:
		var payload protocol.CertificateInspectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.InspectCertificate(request.ID, payload)
	case protocol.CommandGeneratePrivateKey:
		var payload protocol.PrivateKeyGeneratePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.GeneratePrivateKey(request.ID, payload)
	case protocol.CommandInspectPrivateKey:
		var payload protocol.PrivateKeyInspectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.InspectPrivateKey(request.ID, payload)
	case protocol.CommandInstallAuthorizedKey:
		var payload protocol.AuthorizedKeyInstallPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.InstallAuthorizedKey(request.ID, request.SessionID, payload)
	case protocol.CommandControlSignal:
		var payload protocol.ControlSignalPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.SendControlSignal(request.SessionID, payload)
	case protocol.CommandResize:
		var payload protocol.ResizePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.ResizeSession(request.SessionID, payload)
	case protocol.CommandDisconnect:
		return core.DisconnectSession(request.SessionID)
	case protocol.CommandTmuxSplitPane:
		var payload protocol.TmuxSplitPanePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.TmuxSplitPane(request.SessionID, payload.Direction)
	case protocol.CommandTmuxNewWindow:
		return core.TmuxNewWindow(request.SessionID)
	case protocol.CommandTmuxSelectWindow:
		var payload protocol.TmuxSelectWindowPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.TmuxSelectWindow(request.SessionID, payload.WindowID)
	case protocol.CommandTmuxSelectPane:
		return core.TmuxSelectPane(request.SessionID)
	case protocol.CommandTmuxCommand:
		var payload protocol.TmuxCommandPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.TmuxControlCommand(request.SessionID, payload.Command)
	case protocol.CommandTmuxKillPane:
		return core.TmuxKillPane(request.SessionID)
	case protocol.CommandTmuxKillWindow:
		var payload protocol.TmuxKillWindowPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.TmuxKillWindow(request.SessionID, payload.WindowID)
	case protocol.CommandTmuxKillSession:
		var payload protocol.TmuxKillSessionPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.TmuxKillSession(request.SessionID, payload.SessionName)
	case protocol.CommandTmuxRenameWindow:
		var payload protocol.TmuxRenameWindowPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.TmuxRenameWindow(request.SessionID, payload.WindowID, payload.Name)
	case protocol.CommandTmuxDetach:
		return core.TmuxDetach(request.SessionID)
	case protocol.CommandTerminalAutocompletePrepare:
		go emitAsyncError(writer, request.ID, request.SessionID, "", protocol.EventError, func() error {
			return core.PrepareAutocomplete(request.SessionID, request.ID)
		})()
		return nil
	case protocol.CommandTerminalAutocompleteRefresh:
		go emitAsyncError(writer, request.ID, request.SessionID, "", protocol.EventError, func() error {
			return core.RefreshAutocomplete(request.SessionID, request.ID)
		})()
		return nil
	case protocol.CommandTerminalAutocompleteStop:
		core.StopAutocomplete(request.SessionID)
		writer.emit(protocol.Event{
			Type:      protocol.EventTerminalAutocompleteCapability,
			RequestID: request.ID,
			SessionID: request.SessionID,
			Payload: protocol.TerminalAutocompleteCapabilityPayload{
				Status: "unsupported", Sources: []string{},
			},
		})
		return nil
	case protocol.CommandTerminalCompletionQuery:
		var payload protocol.TerminalCompletionQueryPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		// Completion is best-effort: it must never emit a session-scoped error
		// event (that would tear down the terminal), so it is NOT wrapped in
		// emitAsyncError. RunCompletionQuery always emits its own result event.
		go func() {
			_ = core.RunCompletionQuery(
				request.SessionID, request.ID, payload.Command, payload.Background, payload.Elevate,
			)
		}()
		return nil
	case protocol.CommandRunCommand:
		var payload protocol.RunCommandPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		// Best-effort, fire-and-forget: RunCommand always emits its own result
		// event (correlated by requestID), so it is NOT wrapped in emitAsyncError —
		// a failed AI command must never surface a session-fatal error that would
		// tear down the terminal.
		go func() {
			_ = core.RunCommand(request.SessionID, request.ID, payload.Command, payload.TimeoutMs)
		}()
		return nil
	case protocol.CommandShellIntegrationInstall:
		// Best-effort, fire-and-forget: install shell integration (OSC 7/133)
		// independent of autocomplete so cwd/markers work even with it disabled.
		go func() {
			_ = core.InstallShellIntegration(request.SessionID)
		}()
		return nil
	case protocol.CommandShellIntegrationReinject:
		// Best-effort, fire-and-forget: re-install shell integration into the
		// current foreground shell after the renderer detects a subshell entry
		// (nested ssh, sudo su, docker exec). Waits for the subshell prompt to
		// settle internally, so returning immediately is fine.
		//
		// 페이로드가 없을 수도 있다(예전 렌더러) — 그때는 셸을 모르는 것으로 본다.
		var reinject protocol.ShellIntegrationReinjectPayload
		if len(request.Payload) > 0 {
			_ = json.Unmarshal(request.Payload, &reinject)
		}
		go func() {
			_ = core.ReinjectShellIntegration(request.SessionID, reinject.Shell)
		}()
		return nil
	case protocol.CommandKeyboardInteractiveRespond:
		var payload protocol.KeyboardInteractiveRespondPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.RespondKeyboardInteractive(request.SessionID, request.EndpointID, payload)
	case protocol.CommandHostKeyTrustRespond:
		var payload protocol.HostKeyTrustRespondPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		// 대기표가 하나뿐이라 상관 ID 없이 챌린지 ID 로 찾는다.
		return core.RespondHostKeyTrust(payload)
	case protocol.CommandContainersConnect:
		var payload protocol.ContainersConnectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		go emitAsyncError(writer, request.ID, "", request.EndpointID, protocol.EventContainersError, func() error {
			return core.ConnectContainers(request.EndpointID, request.ID, payload)
		})()
		return nil
	case protocol.CommandContainersDisconnect:
		return core.DisconnectContainers(request.EndpointID, request.ID)
	case protocol.CommandContainersList:
		return core.ListContainers(request.EndpointID, request.ID)
	case protocol.CommandContainersInspect:
		var payload protocol.ContainersInspectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.InspectContainer(request.EndpointID, request.ID, payload)
	case protocol.CommandContainersLogs:
		var payload protocol.ContainersLogsPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.LogsContainers(request.EndpointID, request.ID, payload)
	case protocol.CommandContainersStart:
		var payload protocol.ContainersActionPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.StartContainer(request.EndpointID, request.ID, payload)
	case protocol.CommandContainersStop:
		var payload protocol.ContainersActionPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.StopContainer(request.EndpointID, request.ID, payload)
	case protocol.CommandContainersRestart:
		var payload protocol.ContainersActionPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.RestartContainer(request.EndpointID, request.ID, payload)
	case protocol.CommandContainersRemove:
		var payload protocol.ContainersActionPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.RemoveContainer(request.EndpointID, request.ID, payload)
	case protocol.CommandContainersStats:
		var payload protocol.ContainersStatsPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.StatsContainers(request.EndpointID, request.ID, payload)
	case protocol.CommandContainersSearchLogs:
		var payload protocol.ContainersSearchLogsPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.SearchContainerLogs(request.EndpointID, request.ID, payload)
	case protocol.CommandPortForwardStart:
		var payload protocol.PortForwardStartPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.StartPortForward(request.EndpointID, request.ID, payload)
	case protocol.CommandSSMPortForwardStart:
		var payload protocol.SSMPortForwardStartPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.StartSSMPortForward(request.EndpointID, request.ID, payload)
	case protocol.CommandPortForwardStop:
		return core.StopPortForward(request.EndpointID, request.ID)
	case protocol.CommandSSMPortForwardStop:
		return core.StopSSMPortForward(request.EndpointID, request.ID)
	case protocol.CommandSFTPConnect:
		var payload protocol.SFTPConnectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		go emitAsyncError(writer, request.ID, "", request.EndpointID, protocol.EventSFTPError, func() error {
			return core.ConnectSFTP(request.EndpointID, request.ID, payload)
		})()
		return nil
	case protocol.CommandSFTPDisconnect:
		return core.DisconnectSFTP(request.EndpointID, request.ID)
	case protocol.CommandSFTPList:
		var payload protocol.SFTPListPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.ListSFTP(request.EndpointID, request.ID, payload)
	case protocol.CommandSFTPMkdir:
		var payload protocol.SFTPMkdirPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.MkdirSFTP(request.EndpointID, request.ID, payload)
	case protocol.CommandSFTPRename:
		var payload protocol.SFTPRenamePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.RenameSFTP(request.EndpointID, request.ID, payload)
	case protocol.CommandSFTPChmod:
		var payload protocol.SFTPChmodPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.ChmodSFTP(request.EndpointID, request.ID, payload)
	case protocol.CommandSFTPChown:
		var payload protocol.SFTPChownPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.ChownSFTP(request.EndpointID, request.ID, payload)
	case protocol.CommandSFTPListPrincipals:
		var payload protocol.SFTPListPrincipalsPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.ListSFTPPrincipals(request.EndpointID, request.ID, payload)
	case protocol.CommandSFTPDelete:
		var payload protocol.SFTPDeletePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.DeleteSFTP(request.EndpointID, request.ID, payload)
	case protocol.CommandSFTPReadFile:
		var payload protocol.SFTPReadFilePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.ReadFileSFTP(request.EndpointID, request.ID, payload)
	case protocol.CommandSFTPWriteFile:
		var payload protocol.SFTPWriteFilePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.WriteFileSFTP(request.EndpointID, request.ID, payload)
	case protocol.CommandSFTPTransferStart:
		var payload protocol.SFTPTransferStartPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.StartSFTPTransfer(request.JobID, payload)
	case protocol.CommandSFTPTransferCancel:
		return core.CancelSFTPTransfer(request.JobID)
	case protocol.CommandSFTPTransferPause:
		return core.PauseSFTPTransfer(request.JobID)
	case protocol.CommandSFTPTransferResume:
		return core.ResumeSFTPTransfer(request.JobID)
	default:
		return fmt.Errorf("unknown command type: %s", request.Type)
	}
}

func emitAsyncError(
	writer *eventWriter,
	requestID string,
	sessionID string,
	endpointID string,
	eventType protocol.EventType,
	action func() error,
) func() {
	return func() {
		if err := action(); err != nil {
			writer.emit(protocol.Event{
				Type:       eventType,
				RequestID:  requestID,
				SessionID:  sessionID,
				EndpointID: endpointID,
				Payload: protocol.ErrorPayload{
					Message: neterr.Normalize(err).Error(),
					Failure: neterr.Code(err),
				},
			})
		}
	}
}

func frameRequestID(frame protocol.Frame) string {
	if frame.Kind == protocol.FrameKindControl {
		var request protocol.Request
		if err := protocol.DecodeControlFrame(frame, &request); err == nil {
			return request.ID
		}
		return ""
	}
	var metadata protocol.StreamFrame
	if err := protocol.DecodeStreamFrame(frame, &metadata); err == nil {
		return metadata.RequestID
	}
	return ""
}

func frameSessionID(frame protocol.Frame) string {
	if frame.Kind == protocol.FrameKindControl {
		var request protocol.Request
		if err := protocol.DecodeControlFrame(frame, &request); err == nil {
			return request.SessionID
		}
		return ""
	}
	var metadata protocol.StreamFrame
	if err := protocol.DecodeStreamFrame(frame, &metadata); err == nil {
		return metadata.SessionID
	}
	return ""
}

func frameEndpointID(frame protocol.Frame) string {
	if frame.Kind != protocol.FrameKindControl {
		return ""
	}
	var request protocol.Request
	if err := protocol.DecodeControlFrame(frame, &request); err == nil {
		return request.EndpointID
	}
	return ""
}

func frameJobID(frame protocol.Frame) string {
	if frame.Kind != protocol.FrameKindControl {
		return ""
	}
	var request protocol.Request
	if err := protocol.DecodeControlFrame(frame, &request); err == nil {
		return request.JobID
	}
	return ""
}

func isSFTPCommand(frame protocol.Frame) bool {
	if frame.Kind != protocol.FrameKindControl {
		return false
	}
	var request protocol.Request
	if err := protocol.DecodeControlFrame(frame, &request); err != nil {
		return false
	}
	switch request.Type {
	case protocol.CommandKeyboardInteractiveRespond:
		return request.EndpointID != ""
	case protocol.CommandSFTPConnect,
		protocol.CommandSFTPDisconnect,
		protocol.CommandSFTPList,
		protocol.CommandSFTPMkdir,
		protocol.CommandSFTPRename,
		protocol.CommandSFTPChmod,
		protocol.CommandSFTPChown,
		protocol.CommandSFTPListPrincipals,
		protocol.CommandSFTPDelete,
		protocol.CommandSFTPReadFile,
		protocol.CommandSFTPWriteFile,
		protocol.CommandSFTPTransferStart,
		protocol.CommandSFTPTransferCancel,
		protocol.CommandSFTPTransferPause,
		protocol.CommandSFTPTransferResume:
		return true
	default:
		return false
	}
}

func isContainersCommand(frame protocol.Frame) bool {
	if frame.Kind != protocol.FrameKindControl {
		return false
	}
	var request protocol.Request
	if err := protocol.DecodeControlFrame(frame, &request); err != nil {
		return false
	}
	switch request.Type {
	case protocol.CommandKeyboardInteractiveRespond:
		return strings.HasPrefix(request.EndpointID, "containers:")
	case protocol.CommandContainersConnect,
		protocol.CommandContainersDisconnect,
		protocol.CommandContainersList,
		protocol.CommandContainersInspect,
		protocol.CommandContainersLogs,
		protocol.CommandContainersStart,
		protocol.CommandContainersStop,
		protocol.CommandContainersRestart,
		protocol.CommandContainersRemove,
		protocol.CommandContainersStats,
		protocol.CommandContainersSearchLogs:
		return true
	default:
		return false
	}
}

func isPortForwardCommand(frame protocol.Frame) bool {
	if frame.Kind != protocol.FrameKindControl {
		return false
	}
	var request protocol.Request
	if err := protocol.DecodeControlFrame(frame, &request); err != nil {
		return false
	}
	switch request.Type {
	case protocol.CommandKeyboardInteractiveRespond:
		return request.EndpointID != "" && !strings.HasPrefix(request.EndpointID, "containers:")
	case protocol.CommandPortForwardStart, protocol.CommandSSMPortForwardStart, protocol.CommandPortForwardStop, protocol.CommandSSMPortForwardStop:
		return true
	default:
		return false
	}
}
