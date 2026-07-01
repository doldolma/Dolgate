package runtime

import (
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/awssession"
	containersvc "dolssh/services/ssh-core/internal/containers"
	"dolssh/services/ssh-core/internal/forwarding"
	"dolssh/services/ssh-core/internal/localsession"
	"dolssh/services/ssh-core/internal/moshsession"
	"dolssh/services/ssh-core/internal/serialsession"
	coresftp "dolssh/services/ssh-core/internal/sftp"
	"dolssh/services/ssh-core/internal/sshcmd"
	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/internal/sshsession"
	"dolssh/services/ssh-core/internal/ssmforward"
	"dolssh/services/ssh-core/internal/tmuxsession"
	"dolssh/services/ssh-core/pkg/coretypes"
)

type Options struct {
	EmitEvent  func(coretypes.Event)
	EmitStream func(coretypes.StreamFrame, []byte)
}

type sshSessionManager interface {
	Connect(sessionID, requestID string, payload coretypes.ConnectPayload) error
	WriteBytes(sessionID string, data []byte) error
	Resize(sessionID string, cols, rows int) error
	Disconnect(sessionID string) error
	RespondKeyboardInteractive(sessionID, challengeID string, responses []string) error
	HasSession(sessionID string) bool
	CollectAutocomplete(sessionID string, revision int) (autocomplete.Result, error)
	InstallShellIntegration(sessionID string) error
	FlushShellIntegration(sessionID string)
	RunCompletionCommand(sessionID, command string) (string, bool, error)
	// KillTmuxSession 은 감지 하단바에서 attach 없이 원격 tmux 세션을 종료한다(보조 exec).
	KillTmuxSession(sessionID, sessionName string) error
}

// moshSessionManager는 mosh(UDP) 세션을 다룬다. SSH bootstrap+UDP를 캡슐화하며,
// 자동완성/셸 통합은 v1에서 지원하지 않으므로 sshSessionManager보다 좁다.
type moshSessionManager interface {
	Connect(sessionID, requestID string, payload coretypes.ConnectPayload) error
	WriteBytes(sessionID string, data []byte) error
	Resize(sessionID string, cols, rows int) error
	Disconnect(sessionID string) error
	RespondKeyboardInteractive(sessionID, challengeID string, responses []string) error
	HasSession(sessionID string) bool
}

type awsSessionManager interface {
	Connect(sessionID, requestID string, payload coretypes.AWSConnectPayload) error
	HasSession(sessionID string) bool
	WriteBytes(sessionID string, data []byte) error
	SendControlSignal(sessionID, signal string) error
	Resize(sessionID string, cols, rows int) error
	Disconnect(sessionID string) error
	Shutdown()
	CollectAutocomplete(sessionID string, revision int) (autocomplete.Result, error)
	StopAutocomplete(sessionID string)
	InstallShellIntegration(sessionID string) error
	FlushShellIntegration(sessionID string)
}

type localSessionManager interface {
	Connect(sessionID, requestID string, payload coretypes.LocalConnectPayload) error
	HasSession(sessionID string) bool
	WriteBytes(sessionID string, data []byte) error
	Resize(sessionID string, cols, rows int) error
	Disconnect(sessionID string) error
	CollectAutocomplete(sessionID string, revision int) (autocomplete.Result, error)
	InstallShellIntegration(sessionID string) error
	FlushShellIntegration(sessionID string)
	RunCompletionCommand(sessionID, command string) (string, bool, error)
}

type serialSessionManager interface {
	Connect(sessionID, requestID string, payload coretypes.SerialConnectPayload) error
	ListPorts(requestID string, payload coretypes.SerialListPortsPayload) error
	HasSession(sessionID string) bool
	WriteBytes(sessionID string, data []byte) error
	Control(sessionID, action string, enabled *bool) error
	Resize(sessionID string, cols, rows int) error
	Disconnect(sessionID string) error
}

type sftpService interface {
	Connect(endpointID, requestID string, payload coretypes.SFTPConnectPayload) error
	Disconnect(endpointID, requestID string) error
	RespondKeyboardInteractive(endpointID, challengeID string, responses []string) error
	List(endpointID, requestID string, payload coretypes.SFTPListPayload) error
	Mkdir(endpointID, requestID string, payload coretypes.SFTPMkdirPayload) error
	Rename(endpointID, requestID string, payload coretypes.SFTPRenamePayload) error
	Chmod(endpointID, requestID string, payload coretypes.SFTPChmodPayload) error
	Chown(endpointID, requestID string, payload coretypes.SFTPChownPayload) error
	ListPrincipals(endpointID, requestID string, payload coretypes.SFTPListPrincipalsPayload) error
	Delete(endpointID, requestID string, payload coretypes.SFTPDeletePayload) error
	ReadFile(endpointID, requestID string, payload coretypes.SFTPReadFilePayload) error
	WriteFile(endpointID, requestID string, payload coretypes.SFTPWriteFilePayload) error
	StartTransfer(jobID string, payload coretypes.SFTPTransferStartPayload) error
	CancelTransfer(jobID string) error
	PauseTransfer(jobID string) error
	ResumeTransfer(jobID string) error
	Shutdown()
}

type containersService interface {
	Connect(endpointID, requestID string, payload coretypes.ContainersConnectPayload) error
	Disconnect(endpointID, requestID string) error
	TakeClient(endpointID string) (*ssh.Client, error)
	RespondKeyboardInteractive(endpointID, challengeID string, responses []string) error
	List(endpointID, requestID string) error
	Inspect(endpointID, requestID string, payload coretypes.ContainersInspectPayload) error
	Logs(endpointID, requestID string, payload coretypes.ContainersLogsPayload) error
	Start(endpointID, requestID string, payload coretypes.ContainersActionPayload) error
	Stop(endpointID, requestID string, payload coretypes.ContainersActionPayload) error
	Restart(endpointID, requestID string, payload coretypes.ContainersActionPayload) error
	Remove(endpointID, requestID string, payload coretypes.ContainersActionPayload) error
	Stats(endpointID, requestID string, payload coretypes.ContainersStatsPayload) error
	SearchLogs(endpointID, requestID string, payload coretypes.ContainersSearchLogsPayload) error
	Shutdown()
}

type forwardingService interface {
	RespondKeyboardInteractive(endpointID, challengeID string, responses []string) error
	Start(ruleID, requestID string, payload coretypes.PortForwardStartPayload) error
	StartWithClient(ruleID, requestID string, payload coretypes.PortForwardStartPayload, client *ssh.Client) error
	Stop(ruleID, requestID string) error
	Shutdown()
}

type ssmForwardingService interface {
	Start(ruleID, requestID string, payload coretypes.SSMPortForwardStartPayload) error
	Stop(ruleID, requestID string) error
	Shutdown()
}

type hostKeyProbeFunc func(payload coretypes.HostKeyProbePayload) (coretypes.HostKeyProbedPayload, error)
type certificateInspectFunc func(payload coretypes.CertificateInspectPayload) coretypes.CertificateInspectedPayload

type Runtime struct {
	emitEvent  func(coretypes.Event)
	emitStream func(coretypes.StreamFrame, []byte)
	ssh        sshSessionManager
	// tmux 는 control mode 명령(SplitPane/NewWindow/…)을 위해 concrete 타입으로 둔다.
	// sshSessionManager 인터페이스(HasSession/WriteBytes/…)도 만족하므로 라우팅에 그대로 쓰인다.
	tmux                      *tmuxsession.Manager
	mosh                      moshSessionManager
	aws                       awsSessionManager
	local                     localSessionManager
	serial                    serialSessionManager
	sftp                      sftpService
	containers                containersService
	forwarding                forwardingService
	ssmForwarding             ssmForwardingService
	probeHostKey              hostKeyProbeFunc
	inspectCertificate        certificateInspectFunc
	autocompleteMu            sync.Mutex
	autocompleteRevisions     map[string]int
	shellIntegrationInstalled map[string]bool
}

func New(options Options) *Runtime {
	emitEvent := options.EmitEvent
	if emitEvent == nil {
		emitEvent = func(coretypes.Event) {}
	}
	emitStream := options.EmitStream
	if emitStream == nil {
		emitStream = func(coretypes.StreamFrame, []byte) {}
	}

	return newRuntimeWithDeps(
		emitEvent,
		emitStream,
		sshsession.NewManager(emitEvent, emitStream),
		moshsession.NewManager(emitEvent, emitStream),
		awssession.NewManager(emitEvent, emitStream),
		localsession.NewManager(emitEvent, emitStream),
		serialsession.NewManager(emitEvent, emitStream),
		coresftp.New(emitEvent),
		containersvc.New(emitEvent),
		forwarding.New(emitEvent),
		ssmforward.New(emitEvent),
		func(payload coretypes.HostKeyProbePayload) (coretypes.HostKeyProbedPayload, error) {
			jump := sshconn.JumpTargetFromCore(payload.Jump)
			// 프로브도 홉 진행을 방출한다: 점프 체인은 DialClient가, 최종 타깃 홉은 ProbeHostKey가
			// config.Progress로 보고. 상관 ID는 renderer가 넘긴 sessionId/endpointId를 그대로 사용해
			// 프로브 홉이 실제 연결과 같은 오버레이에 표시되게 한다.
			probeConfig := sshconn.DefaultConfig
			probeConfig.Progress = sshconn.HopProgress(
				sshconn.Target{Host: payload.Host, Port: payload.Port, Jump: jump},
				payload.SessionID,
				payload.EndpointID,
				emitEvent,
			)
			result, err := sshconn.ProbeHostKey(payload.Host, payload.Port, jump, probeConfig)
			if err != nil {
				return coretypes.HostKeyProbedPayload{}, err
			}
			return coretypes.HostKeyProbedPayload{
				Algorithm:         result.Algorithm,
				PublicKeyBase64:   result.PublicKeyBase64,
				FingerprintSHA256: result.FingerprintSHA256,
			}, nil
		},
		func(payload coretypes.CertificateInspectPayload) coretypes.CertificateInspectedPayload {
			result := sshconn.InspectCertificate(payload.CertificateText, time.Now().UTC())
			inspected := coretypes.CertificateInspectedPayload{
				Status:     result.Status,
				Principals: result.Principals,
				KeyID:      result.KeyID,
			}
			if result.ValidAfter != nil {
				inspected.ValidAfter = result.ValidAfter.Format(time.RFC3339)
			}
			if result.ValidBefore != nil {
				inspected.ValidBefore = result.ValidBefore.Format(time.RFC3339)
			}
			if result.Serial != 0 {
				inspected.Serial = strconv.FormatUint(result.Serial, 10)
			}
			return inspected
		},
	)
}

func newRuntimeWithDeps(
	emitEvent func(coretypes.Event),
	emitStream func(coretypes.StreamFrame, []byte),
	ssh sshSessionManager,
	mosh moshSessionManager,
	aws awsSessionManager,
	local localSessionManager,
	serial serialSessionManager,
	sftp sftpService,
	containers containersService,
	forwarding forwardingService,
	ssmForwarding ssmForwardingService,
	probeHostKey hostKeyProbeFunc,
	inspectCertificate certificateInspectFunc,
) *Runtime {
	return &Runtime{
		emitEvent:                 emitEvent,
		emitStream:                emitStream,
		ssh:                       ssh,
		tmux:                      tmuxsession.NewManager(emitEvent, emitStream),
		mosh:                      mosh,
		aws:                       aws,
		local:                     local,
		serial:                    serial,
		sftp:                      sftp,
		containers:                containers,
		forwarding:                forwarding,
		ssmForwarding:             ssmForwarding,
		probeHostKey:              probeHostKey,
		inspectCertificate:        inspectCertificate,
		autocompleteRevisions:     make(map[string]int),
		shellIntegrationInstalled: make(map[string]bool),
	}
}

func (runtime *Runtime) EmitReady() {
	runtime.emitEvent(coretypes.Event{
		Type: coretypes.EventStatus,
		Payload: coretypes.StatusPayload{
			Status:  "ready",
			Message: "ssh core ready",
		},
	})
}

func (runtime *Runtime) Health(requestID string) {
	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventStatus,
		RequestID: requestID,
		Payload: coretypes.StatusPayload{
			Status:  "ok",
			Message: "ssh core healthy",
		},
	})
}

func (runtime *Runtime) ConnectSSH(sessionID, requestID string, payload coretypes.ConnectPayload) error {
	// mosh는 SSH 위의 확장이라 같은 connect 진입점/페이로드를 공유한다. UseMosh면 SSH
	// bootstrap과 UDP 전송을 담당하는 mosh 매니저로 위임한다.
	if payload.UseMosh {
		return runtime.mosh.Connect(sessionID, requestID, payload)
	}
	return runtime.ssh.Connect(sessionID, requestID, payload)
}

func (runtime *Runtime) ConnectTmux(sessionID, requestID string, payload coretypes.ConnectPayload) error {
	return runtime.tmux.Connect(sessionID, requestID, payload)
}

func (runtime *Runtime) TmuxSplitPane(sessionID, direction string) error {
	return runtime.tmux.SplitPane(sessionID, direction)
}

func (runtime *Runtime) TmuxNewWindow(sessionID string) error {
	return runtime.tmux.NewWindow(sessionID)
}

func (runtime *Runtime) TmuxSelectWindow(sessionID, windowID string) error {
	return runtime.tmux.SelectWindow(sessionID, windowID)
}

func (runtime *Runtime) TmuxSelectPane(sessionID string) error {
	return runtime.tmux.SelectPane(sessionID)
}

func (runtime *Runtime) TmuxControlCommand(sessionID, command string) error {
	return runtime.tmux.ControlCommand(sessionID, command)
}

func (runtime *Runtime) TmuxKillPane(sessionID string) error {
	return runtime.tmux.KillPane(sessionID)
}

func (runtime *Runtime) TmuxKillWindow(sessionID, windowID string) error {
	return runtime.tmux.KillWindow(sessionID, windowID)
}

func (runtime *Runtime) TmuxKillSession(sessionID, sessionName string) error {
	// control mode pane/세션이면 control 채널로 kill, 감지 하단바의 SSH 세션이면 보조
	// exec 채널로 kill(attach 없이 원격 세션 종료 + 목록 재감지).
	if runtime.tmux.HasSession(sessionID) {
		return runtime.tmux.KillSession(sessionID, sessionName)
	}
	return runtime.ssh.KillTmuxSession(sessionID, sessionName)
}

func (runtime *Runtime) TmuxRenameWindow(sessionID, windowID, name string) error {
	return runtime.tmux.RenameWindow(sessionID, windowID, name)
}

func (runtime *Runtime) TmuxDetach(sessionID string) error {
	return runtime.tmux.Detach(sessionID)
}

func (runtime *Runtime) ConnectAWS(sessionID, requestID string, payload coretypes.AWSConnectPayload) error {
	return runtime.aws.Connect(sessionID, requestID, payload)
}

func (runtime *Runtime) ConnectLocal(sessionID, requestID string, payload coretypes.LocalConnectPayload) error {
	return runtime.local.Connect(sessionID, requestID, payload)
}

func (runtime *Runtime) ConnectSerial(sessionID, requestID string, payload coretypes.SerialConnectPayload) error {
	return runtime.serial.Connect(sessionID, requestID, payload)
}

func (runtime *Runtime) ListSerialPorts(requestID string, payload coretypes.SerialListPortsPayload) error {
	return runtime.serial.ListPorts(requestID, payload)
}

func (runtime *Runtime) ControlSerial(sessionID string, payload coretypes.SerialControlPayload) error {
	return runtime.serial.Control(sessionID, payload.Action, payload.Enabled)
}

func (runtime *Runtime) SendSessionInput(sessionID string, data []byte) error {
	switch {
	case runtime.tmux.HasSession(sessionID):
		return runtime.tmux.WriteBytes(sessionID, data)
	case runtime.mosh.HasSession(sessionID):
		return runtime.mosh.WriteBytes(sessionID, data)
	case runtime.aws.HasSession(sessionID):
		return runtime.aws.WriteBytes(sessionID, data)
	case runtime.local.HasSession(sessionID):
		return runtime.local.WriteBytes(sessionID, data)
	case runtime.serial.HasSession(sessionID):
		return runtime.serial.WriteBytes(sessionID, data)
	default:
		return runtime.ssh.WriteBytes(sessionID, data)
	}
}

func (runtime *Runtime) SendControlSignal(sessionID string, payload coretypes.ControlSignalPayload) error {
	if runtime.aws.HasSession(sessionID) {
		return runtime.aws.SendControlSignal(sessionID, payload.Signal)
	}
	return nil
}

func (runtime *Runtime) ResizeSession(sessionID string, payload coretypes.ResizePayload) error {
	switch {
	case runtime.tmux.HasSession(sessionID):
		return runtime.tmux.Resize(sessionID, payload.Cols, payload.Rows)
	case runtime.mosh.HasSession(sessionID):
		return runtime.mosh.Resize(sessionID, payload.Cols, payload.Rows)
	case runtime.aws.HasSession(sessionID):
		return runtime.aws.Resize(sessionID, payload.Cols, payload.Rows)
	case runtime.local.HasSession(sessionID):
		return runtime.local.Resize(sessionID, payload.Cols, payload.Rows)
	case runtime.serial.HasSession(sessionID):
		return runtime.serial.Resize(sessionID, payload.Cols, payload.Rows)
	default:
		return runtime.ssh.Resize(sessionID, payload.Cols, payload.Rows)
	}
}

func (runtime *Runtime) DisconnectSession(sessionID string) error {
	runtime.StopAutocomplete(sessionID)
	switch {
	case runtime.tmux.HasSession(sessionID):
		return runtime.tmux.Disconnect(sessionID)
	case runtime.mosh.HasSession(sessionID):
		return runtime.mosh.Disconnect(sessionID)
	case runtime.aws.HasSession(sessionID):
		return runtime.aws.Disconnect(sessionID)
	case runtime.local.HasSession(sessionID):
		return runtime.local.Disconnect(sessionID)
	case runtime.serial.HasSession(sessionID):
		return runtime.serial.Disconnect(sessionID)
	default:
		return runtime.ssh.Disconnect(sessionID)
	}
}

func (runtime *Runtime) PrepareAutocomplete(sessionID, requestID string) error {
	return runtime.collectAutocomplete(sessionID, requestID)
}

// RunCompletionQuery runs a renderer-built read-only command on the host's
// auxiliary channel (SSH exec / local subprocess) and returns its stdout for
// dynamic completion. Unsupported on AWS SSM (single PTY, no aux channel).
func (runtime *Runtime) RunCompletionQuery(sessionID, requestID, command string) error {
	var (
		stdout    string
		truncated bool
	)
	switch {
	case runtime.tmux.HasSession(sessionID):
		stdout, truncated, _ = runtime.tmux.RunCompletionCommand(sessionID, command)
	case runtime.ssh.HasSession(sessionID):
		stdout, truncated, _ = runtime.ssh.RunCompletionCommand(sessionID, command)
	case runtime.local.HasSession(sessionID):
		stdout, truncated, _ = runtime.local.RunCompletionCommand(sessionID, command)
	}
	// Completion is strictly best-effort. Any failure (unknown session,
	// non-zero exit, timeout) yields an empty result rather than an error — an
	// error here would be emitted as a session-fatal event and tear down the
	// terminal. Always emit a result so the desktop request resolves promptly.
	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventTerminalCompletionResult,
		RequestID: requestID,
		SessionID: sessionID,
		Payload: coretypes.TerminalCompletionResultPayload{
			Stdout:    stdout,
			Truncated: truncated,
		},
	})
	return nil
}

func (runtime *Runtime) RefreshAutocomplete(sessionID, requestID string) error {
	return runtime.collectAutocomplete(sessionID, requestID)
}

func (runtime *Runtime) StopAutocomplete(sessionID string) {
	runtime.autocompleteMu.Lock()
	delete(runtime.autocompleteRevisions, sessionID)
	delete(runtime.shellIntegrationInstalled, sessionID)
	runtime.autocompleteMu.Unlock()
	// Release any output a mid-flight handshake is still holding so disabling
	// the feature never strands terminal output.
	switch {
	case runtime.aws.HasSession(sessionID):
		runtime.aws.StopAutocomplete(sessionID)
		runtime.aws.FlushShellIntegration(sessionID)
	case runtime.local.HasSession(sessionID):
		runtime.local.FlushShellIntegration(sessionID)
	case runtime.ssh.HasSession(sessionID):
		runtime.ssh.FlushShellIntegration(sessionID)
	}
}

// shellIntegrationHandshakeTimeout bounds how long the echo-suppression
// handshake waits for the first OSC 133;A prompt marker before releasing any
// buffered output. Kept generous: AWS SSM hops through `exec sudo` and ConPTY
// delivers output slowly (the init marker was observed at ~3.4s), and slow SSH
// servers / heavy prompts can also push the first prompt past a few seconds.
// Too short a value flushes the integration init command's echo onto the screen.
const shellIntegrationHandshakeTimeout = 8 * time.Second

// installShellIntegration injects the OSC 133 hooks into the interactive shell
// once per session (idempotent across refreshes) and schedules a flush so a
// failed handshake never strands output. Injection runs before the snapshot
// probe so the prompt marker arrives ahead of the probe response.
func (runtime *Runtime) installShellIntegration(sessionID string) error {
	runtime.autocompleteMu.Lock()
	if runtime.shellIntegrationInstalled[sessionID] {
		runtime.autocompleteMu.Unlock()
		return nil
	}
	runtime.shellIntegrationInstalled[sessionID] = true
	runtime.autocompleteMu.Unlock()

	var err error
	switch {
	case runtime.tmux.HasSession(sessionID):
		// control mode pane: tmux Manager 가 send-keys 로 init 을 주입하고 자체적으로
		// 1.5s 뒤 flush 한다(여기서 별도 AfterFunc 불필요).
		err = runtime.tmux.InstallShellIntegration(sessionID)
	case runtime.aws.HasSession(sessionID):
		err = runtime.aws.InstallShellIntegration(sessionID)
		if err == nil {
			time.AfterFunc(shellIntegrationHandshakeTimeout, func() {
				runtime.aws.FlushShellIntegration(sessionID)
			})
		}
	case runtime.local.HasSession(sessionID):
		err = runtime.local.InstallShellIntegration(sessionID)
		if err == nil {
			time.AfterFunc(shellIntegrationHandshakeTimeout, func() {
				runtime.local.FlushShellIntegration(sessionID)
			})
		}
	case runtime.ssh.HasSession(sessionID):
		// SSH manager가 지원 셸 가드, 중복 방지, flush 타이머를 내부에서 처리한다.
		err = runtime.ssh.InstallShellIntegration(sessionID)
	}
	if err != nil {
		runtime.autocompleteMu.Lock()
		delete(runtime.shellIntegrationInstalled, sessionID)
		runtime.autocompleteMu.Unlock()
	}
	return err
}

// InstallShellIntegration injects the OSC 7/133 shell hooks WITHOUT running the
// autocomplete snapshot probe, so cwd reporting and prompt markers work even when
// the autocomplete feature is disabled (e.g. for terminal drag-to-SFTP uploads).
// Idempotent per session (shares the same install-once flag as the probe path).
func (runtime *Runtime) InstallShellIntegration(sessionID string) error {
	return runtime.installShellIntegration(sessionID)
}

func (runtime *Runtime) collectAutocomplete(sessionID, requestID string) error {
	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventTerminalAutocompleteCapability,
		SessionID: sessionID,
		Payload: coretypes.TerminalAutocompleteCapabilityPayload{
			Status: "probing", Sources: []string{},
		},
	})
	runtime.autocompleteMu.Lock()
	revision := runtime.autocompleteRevisions[sessionID] + 1
	runtime.autocompleteRevisions[sessionID] = revision
	runtime.autocompleteMu.Unlock()

	// Install the OSC 133 hooks (once) before collecting the snapshot so the
	// prompt marker leads the snapshot probe response on shared in-band PTYs.
	_ = runtime.installShellIntegration(sessionID)

	var (
		result autocomplete.Result
		err    error
	)
	switch {
	case runtime.tmux.HasSession(sessionID):
		result, err = runtime.tmux.CollectAutocomplete(sessionID, revision)
	case runtime.aws.HasSession(sessionID):
		result, err = runtime.aws.CollectAutocomplete(sessionID, revision)
	case runtime.local.HasSession(sessionID):
		result, err = runtime.local.CollectAutocomplete(sessionID, revision)
	case runtime.ssh.HasSession(sessionID):
		result, err = runtime.ssh.CollectAutocomplete(sessionID, revision)
	default:
		result = autocomplete.Unsupported()
	}
	if err != nil {
		result = autocomplete.Degraded("", "metadata-unavailable")
	}
	if result.Snapshot != nil {
		runtime.emitEvent(coretypes.Event{
			Type:      coretypes.EventTerminalAutocompleteSnapshot,
			SessionID: sessionID,
			Payload:   *result.Snapshot,
		})
	}
	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventTerminalAutocompleteCapability,
		RequestID: requestID,
		SessionID: sessionID,
		Payload:   result.Capability,
	})
	if result.Capability.Shell != "" {
		runtime.emitEvent(coretypes.Event{
			Type:      coretypes.EventTerminalAutocompleteShellState,
			SessionID: sessionID,
			Payload: coretypes.TerminalAutocompleteShellStatePayload{
				Kind: "shellReady", Shell: result.Capability.Shell,
			},
		})
	}
	return nil
}

func (runtime *Runtime) ProbeHostKey(requestID string, payload coretypes.HostKeyProbePayload) error {
	result, err := runtime.probeHostKey(payload)
	if err != nil {
		return err
	}
	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventHostKeyProbed,
		RequestID: requestID,
		Payload:   result,
	})
	return nil
}

func (runtime *Runtime) InspectCertificate(requestID string, payload coretypes.CertificateInspectPayload) error {
	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventCertificateInspected,
		RequestID: requestID,
		Payload:   runtime.inspectCertificate(payload),
	})
	return nil
}

func (runtime *Runtime) InspectPrivateKey(requestID string, payload coretypes.PrivateKeyInspectPayload) error {
	result, err := sshconn.InspectPrivateKey(payload.PrivateKeyPEM, payload.Passphrase)
	if err != nil {
		return err
	}
	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventPrivateKeyInspected,
		RequestID: requestID,
		Payload: coretypes.PrivateKeyInspectedPayload{
			Algorithm:         result.Algorithm,
			PublicKey:         result.PublicKey,
			FingerprintSHA256: result.FingerprintSHA256,
		},
	})
	return nil
}

func (runtime *Runtime) GeneratePrivateKey(requestID string, payload coretypes.PrivateKeyGeneratePayload) error {
	result, err := sshconn.GeneratePrivateKey(sshconn.PrivateKeyGenerationRequest{
		Algorithm:        payload.Algorithm,
		Curve:            payload.Curve,
		RSABits:          payload.RSABits,
		PrivateKeyCipher: payload.PrivateKeyCipher,
		KDFRounds:        payload.KDFRounds,
		Comment:          payload.Comment,
		Passphrase:       payload.Passphrase,
	})
	if err != nil {
		return err
	}
	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventPrivateKeyGenerated,
		RequestID: requestID,
		Payload: coretypes.PrivateKeyGeneratedPayload{
			Algorithm:           result.Algorithm,
			PrivateKeyPEM:       result.PrivateKeyPEM,
			PublicKey:           result.PublicKey,
			FingerprintSHA256:   result.FingerprintSHA256,
			PrivateKeyEncrypted: result.PrivateKeyEncrypted,
			KeyCurve:            result.KeyCurve,
			KeyBits:             result.KeyBits,
			PrivateKeyCipher:    result.PrivateKeyCipher,
			PrivateKeyKDFRounds: result.PrivateKeyKDFRounds,
		},
	})
	return nil
}

const installAuthorizedKeyScript = `
set -eu
key=$(cat)
if [ -z "$key" ]; then
  echo "missing-public-key" >&2
  exit 2
fi
umask 077
dir="${HOME}/.ssh"
file="${dir}/authorized_keys"
mkdir -p "$dir"
touch "$file"
chmod 700 "$dir"
chmod 600 "$file"
if grep -qxF "$key" "$file" 2>/dev/null; then
  printf '%s\n' already-present
else
  printf '%s\n' "$key" >> "$file"
  chmod 600 "$file"
  printf '%s\n' installed
fi
`

func (runtime *Runtime) InstallAuthorizedKey(requestID string, payload coretypes.AuthorizedKeyInstallPayload) error {
	client, err := sshconn.DialClient(sshconn.Target{
		Host:                  payload.Host,
		Port:                  payload.Port,
		Username:              payload.Username,
		AuthType:              payload.AuthType,
		Password:              payload.Password,
		PrivateKeyPEM:         payload.PrivateKeyPEM,
		CertificateText:       payload.CertificateText,
		Passphrase:            payload.Passphrase,
		TrustedHostKeyBase64:  payload.TrustedHostKeyBase64,
		TrustedHostKeysBase64: payload.TrustedHostKeysBase64,
		Jump:                  sshconn.JumpTargetFromCore(payload.Jump),
	}, sshconn.DefaultConfig, nil)
	if err != nil {
		return err
	}
	defer client.Close()

	stdout, stderr, err := sshcmd.RunWithInputWithTimeout(
		client,
		"sh -c "+sshcmd.QuotePosix(installAuthorizedKeyScript),
		[]byte(strings.TrimSpace(payload.PublicKey)+"\n"),
		20*time.Second,
	)
	if err != nil {
		message := strings.TrimSpace(string(stderr))
		if message != "" {
			return errors.Join(err, errors.New(message))
		}
		return err
	}

	status := "installed"
	for _, line := range strings.Split(strings.TrimSpace(string(stdout)), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "installed" || trimmed == "already-present" {
			status = trimmed
		}
	}
	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventAuthorizedKeyInstalled,
		RequestID: requestID,
		Payload: coretypes.AuthorizedKeyInstalledPayload{
			Status: status,
		},
	})
	return nil
}

func (runtime *Runtime) RespondKeyboardInteractive(sessionID, endpointID string, payload coretypes.KeyboardInteractiveRespondPayload) error {
	if endpointID != "" {
		if len(endpointID) >= len("containers:") && endpointID[:len("containers:")] == "containers:" {
			return runtime.containers.RespondKeyboardInteractive(endpointID, payload.ChallengeID, payload.Responses)
		}
		if err := runtime.forwarding.RespondKeyboardInteractive(endpointID, payload.ChallengeID, payload.Responses); err == nil {
			return nil
		}
		return runtime.sftp.RespondKeyboardInteractive(endpointID, payload.ChallengeID, payload.Responses)
	}
	// mosh bootstrap도 KI 챌린지를 낼 수 있다. 챌린지는 connect 진행 중 발생해 세션이
	// 아직 등록 전이라 HasSession으로 구분 못 하므로, ssh→mosh 순으로 시도해 챌린지를
	// 가진 매니저가 처리하게 한다.
	if err := runtime.ssh.RespondKeyboardInteractive(sessionID, payload.ChallengeID, payload.Responses); err == nil {
		return nil
	}
	return runtime.mosh.RespondKeyboardInteractive(sessionID, payload.ChallengeID, payload.Responses)
}

func (runtime *Runtime) ConnectContainers(endpointID, requestID string, payload coretypes.ContainersConnectPayload) error {
	return runtime.containers.Connect(endpointID, requestID, payload)
}

func (runtime *Runtime) DisconnectContainers(endpointID, requestID string) error {
	return runtime.containers.Disconnect(endpointID, requestID)
}

func (runtime *Runtime) ListContainers(endpointID, requestID string) error {
	return runtime.containers.List(endpointID, requestID)
}

func (runtime *Runtime) InspectContainer(endpointID, requestID string, payload coretypes.ContainersInspectPayload) error {
	return runtime.containers.Inspect(endpointID, requestID, payload)
}

func (runtime *Runtime) LogsContainers(endpointID, requestID string, payload coretypes.ContainersLogsPayload) error {
	return runtime.containers.Logs(endpointID, requestID, payload)
}

func (runtime *Runtime) StartContainer(endpointID, requestID string, payload coretypes.ContainersActionPayload) error {
	return runtime.containers.Start(endpointID, requestID, payload)
}

func (runtime *Runtime) StopContainer(endpointID, requestID string, payload coretypes.ContainersActionPayload) error {
	return runtime.containers.Stop(endpointID, requestID, payload)
}

func (runtime *Runtime) RestartContainer(endpointID, requestID string, payload coretypes.ContainersActionPayload) error {
	return runtime.containers.Restart(endpointID, requestID, payload)
}

func (runtime *Runtime) RemoveContainer(endpointID, requestID string, payload coretypes.ContainersActionPayload) error {
	return runtime.containers.Remove(endpointID, requestID, payload)
}

func (runtime *Runtime) StatsContainers(endpointID, requestID string, payload coretypes.ContainersStatsPayload) error {
	return runtime.containers.Stats(endpointID, requestID, payload)
}

func (runtime *Runtime) SearchContainerLogs(endpointID, requestID string, payload coretypes.ContainersSearchLogsPayload) error {
	return runtime.containers.SearchLogs(endpointID, requestID, payload)
}

func (runtime *Runtime) StartPortForward(endpointID, requestID string, payload coretypes.PortForwardStartPayload) error {
	if payload.SourceEndpointID != "" {
		client, err := runtime.containers.TakeClient(payload.SourceEndpointID)
		if err != nil {
			return err
		}
		return runtime.forwarding.StartWithClient(endpointID, requestID, payload, client)
	}
	return runtime.forwarding.Start(endpointID, requestID, payload)
}

func (runtime *Runtime) StopPortForward(endpointID, requestID string) error {
	return runtime.forwarding.Stop(endpointID, requestID)
}

func (runtime *Runtime) StartSSMPortForward(endpointID, requestID string, payload coretypes.SSMPortForwardStartPayload) error {
	return runtime.ssmForwarding.Start(endpointID, requestID, payload)
}

func (runtime *Runtime) StopSSMPortForward(endpointID, requestID string) error {
	return runtime.ssmForwarding.Stop(endpointID, requestID)
}

func (runtime *Runtime) ConnectSFTP(endpointID, requestID string, payload coretypes.SFTPConnectPayload) error {
	return runtime.sftp.Connect(endpointID, requestID, payload)
}

func (runtime *Runtime) DisconnectSFTP(endpointID, requestID string) error {
	return runtime.sftp.Disconnect(endpointID, requestID)
}

func (runtime *Runtime) ListSFTP(endpointID, requestID string, payload coretypes.SFTPListPayload) error {
	return runtime.sftp.List(endpointID, requestID, payload)
}

func (runtime *Runtime) MkdirSFTP(endpointID, requestID string, payload coretypes.SFTPMkdirPayload) error {
	return runtime.sftp.Mkdir(endpointID, requestID, payload)
}

func (runtime *Runtime) RenameSFTP(endpointID, requestID string, payload coretypes.SFTPRenamePayload) error {
	return runtime.sftp.Rename(endpointID, requestID, payload)
}

func (runtime *Runtime) ChmodSFTP(endpointID, requestID string, payload coretypes.SFTPChmodPayload) error {
	return runtime.sftp.Chmod(endpointID, requestID, payload)
}

func (runtime *Runtime) ChownSFTP(endpointID, requestID string, payload coretypes.SFTPChownPayload) error {
	return runtime.sftp.Chown(endpointID, requestID, payload)
}

func (runtime *Runtime) ListSFTPPrincipals(endpointID, requestID string, payload coretypes.SFTPListPrincipalsPayload) error {
	return runtime.sftp.ListPrincipals(endpointID, requestID, payload)
}

func (runtime *Runtime) DeleteSFTP(endpointID, requestID string, payload coretypes.SFTPDeletePayload) error {
	return runtime.sftp.Delete(endpointID, requestID, payload)
}

func (runtime *Runtime) ReadFileSFTP(endpointID, requestID string, payload coretypes.SFTPReadFilePayload) error {
	return runtime.sftp.ReadFile(endpointID, requestID, payload)
}

func (runtime *Runtime) WriteFileSFTP(endpointID, requestID string, payload coretypes.SFTPWriteFilePayload) error {
	return runtime.sftp.WriteFile(endpointID, requestID, payload)
}

func (runtime *Runtime) StartSFTPTransfer(jobID string, payload coretypes.SFTPTransferStartPayload) error {
	return runtime.sftp.StartTransfer(jobID, payload)
}

func (runtime *Runtime) CancelSFTPTransfer(jobID string) error {
	return runtime.sftp.CancelTransfer(jobID)
}

func (runtime *Runtime) PauseSFTPTransfer(jobID string) error {
	return runtime.sftp.PauseTransfer(jobID)
}

func (runtime *Runtime) ResumeSFTPTransfer(jobID string) error {
	return runtime.sftp.ResumeTransfer(jobID)
}

func (runtime *Runtime) Shutdown() {
	runtime.aws.Shutdown()
	runtime.sftp.Shutdown()
	runtime.containers.Shutdown()
	runtime.forwarding.Shutdown()
	runtime.ssmForwarding.Shutdown()
}
