package runtime

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/awssession"
	containersvc "dolssh/services/ssh-core/internal/containers"
	"dolssh/services/ssh-core/internal/forwarding"
	"dolssh/services/ssh-core/internal/hostkeytrust"
	"dolssh/services/ssh-core/internal/localsession"
	"dolssh/services/ssh-core/internal/moshsession"
	"dolssh/services/ssh-core/internal/serialsession"
	coresftp "dolssh/services/ssh-core/internal/sftp"
	"dolssh/services/ssh-core/internal/sshcmd"
	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/internal/sshdial"
	"dolssh/services/ssh-core/internal/sshsession"
	"dolssh/services/ssh-core/internal/ssmforward"
	"dolssh/services/ssh-core/internal/tailnetservice"
	"dolssh/services/ssh-core/internal/tmuxsession"
	"dolssh/services/ssh-core/pkg/coretypes"
)

type Options struct {
	EmitEvent  func(coretypes.Event)
	EmitStream func(coretypes.StreamFrame, []byte)
	// TailnetStateDir 는 tailnet 노드 상태를 두는 루트다. 비면 tailnet 명령이 명확한
	// 오류로 거절된다 — tsnet 에 맡기면 os.UserConfigDir() 밑에 앱과 무관한 경로를 만든다.
	TailnetStateDir string
}

type sshSessionManager interface {
	Connect(sessionID, requestID string, payload coretypes.ConnectPayload) error
	WriteBytes(sessionID string, data []byte) error
	Resize(sessionID string, cols, rows int) error
	Disconnect(sessionID string) error
	// CancelInFlight 는 아직 붙는 중인 연결을 끊는다(종료 명령이 그 뒤에 줄 서 있어도 되게).
	CancelInFlight(sessionID string)
	HasSession(sessionID string) bool
	CollectAutocomplete(sessionID string, revision int) (autocomplete.Result, error)
	InstallShellIntegration(sessionID string) error
	ReinjectShellIntegration(sessionID string, shell string) error
	FlushShellIntegration(sessionID string)
	RunCompletionCommand(sessionID, command string) (string, bool, error)
	// RunHostCommand 은 보조 exec 채널에서 임의 명령을 실행하고 stdout/stderr/exit 를 돌려준다(AI run_command).
	RunHostCommand(sessionID, command string, timeoutMs int) (string, string, int, bool, error)
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
	ReinjectShellIntegration(sessionID string, shell string) error
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
	CancelInFlight(endpointID string)
	SetHostKeyTrustPrompt(prompt func(ctx context.Context, correlation hostkeytrust.Correlation) sshconn.HostKeyTrustFunc)
	RespondKeyboardInteractive(endpointID, challengeID string, responses []string) error
	// CancelKeyboardInteractive 는 사용자가 닫은 물음을 접는다(답이 오지 않는 것과 다르다).
	CancelKeyboardInteractive(endpointID, challengeID string) error
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
	CancelInFlight(endpointID string)
	SetHostKeyTrustPrompt(prompt func(ctx context.Context, correlation hostkeytrust.Correlation) sshconn.HostKeyTrustFunc)
	TakeClient(endpointID string) (*ssh.Client, error)
	RespondKeyboardInteractive(endpointID, challengeID string, responses []string) error
	// CancelKeyboardInteractive 는 사용자가 닫은 물음을 접는다(답이 오지 않는 것과 다르다).
	CancelKeyboardInteractive(endpointID, challengeID string) error
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
	// CancelKeyboardInteractive 는 사용자가 닫은 물음을 접는다(답이 오지 않는 것과 다르다).
	CancelKeyboardInteractive(endpointID, challengeID string) error
	CancelInFlight(ruleID string)
	SetHostKeyTrustPrompt(prompt func(ctx context.Context, correlation hostkeytrust.Correlation) sshconn.HostKeyTrustFunc)
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

// requestID 를 함께 받는 이유: 점프 호스트가 대화형 인증을 요구하면 프로브가 챌린지를 화면으로
// 올리고 답을 기다려야 하고, 그 대기표를 이 요청에 묶어야 한다.
type hostKeyProbeFunc func(requestID string, payload coretypes.HostKeyProbePayload) (coretypes.HostKeyProbedPayload, error)
type certificateInspectFunc func(payload coretypes.CertificateInspectPayload) coretypes.CertificateInspectedPayload

type Runtime struct {
	emitEvent  func(coretypes.Event)
	emitStream func(coretypes.StreamFrame, []byte)
	ssh        sshSessionManager
	// tmux 는 control mode 명령(SplitPane/NewWindow/…)을 위해 concrete 타입으로 둔다.
	// sshSessionManager 인터페이스(HasSession/WriteBytes/…)도 만족하므로 라우팅에 그대로 쓰인다.
	tmux          *tmuxsession.Manager
	mosh          moshSessionManager
	aws           awsSessionManager
	local         localSessionManager
	serial        serialSessionManager
	sftp          sftpService
	containers    containersService
	forwarding    forwardingService
	ssmForwarding ssmForwardingService
	probeHostKey  hostKeyProbeFunc
	// probeChallenges 는 호스트 키 프로브가 낸 대화형 인증 챌린지의 대기표다(hostkey_probe_auth.go).
	probeChallenges *probeChallenges
	// hostKeyTrust 는 연결 중 신뢰 질의의 대기표다. 한 곳에 두면 챌린지 ID 가 전역에서 유일해서
	// 응답을 어느 서비스로 보낼지 고르는 분기가 필요 없다.
	hostKeyTrust *hostkeytrust.Registry
	// dialer 는 세션 계열이 공유하는 연결 경로다. 대화형 인증 대기표가 여기 하나뿐이라 응답을
	// 어느 매니저로 보낼지 고르는 분기가 없다(internal/sshdial).
	dialer                    *sshdial.Dialer
	inspectCertificate        certificateInspectFunc
	tailnetService            *tailnetservice.Service
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

	// 매니저는 런타임보다 먼저 만들어지는데 tailnet 레지스트리는 런타임 소유다. 그래서
	// dialer 는 아래에서 채워질 변수를 잡는 클로저로 넘긴다 — 실제 호출은 연결 시점이라
	// 그때는 이미 채워져 있다.
	var instance *Runtime
	tailnetDial := func(tailnetID, expectedName string) (sshconn.DialFunc, error) {
		return instance.tailnetDial(TailnetRoute{ID: tailnetID, ExpectedName: expectedName})
	}
	// 연결 중 신뢰 질의의 대기표. 서비스들이 이것으로 사람에게 묻는다 — 키를 미리 읽어 오는 별도
	// 연결(프로브)이 없으면 OTP 를 요구하는 점프 호스트에 인증을 두 번 하지 않는다.
	hostKeyTrustRegistry := hostkeytrust.New()
	hostKeyTrustPrompt := func(
		ctx context.Context,
		correlation hostkeytrust.Correlation,
	) sshconn.HostKeyTrustFunc {
		return hostKeyTrustRegistry.Prompt(ctx, emitEvent, correlation)
	}

	// 세션 계열이 함께 쓰는 연결 경로. 하나만 만들어 셋에 넘긴다 — 그래야 대화형 인증 대기표가
	// 한 곳이라 응답을 어느 매니저로 보낼지 고르는 분기가 없고, 새 기능이 세 경로에 함께 도착한다.
	sessionDialer := sshdial.New(emitEvent)
	sessionDialer.SetTailnetDial(tailnetDial)
	sessionDialer.SetHostKeyTrustPrompt(hostKeyTrustPrompt)

	sshManager := sshsession.NewManagerWithConfig(emitEvent, emitStream, sshsession.ManagerConfig{
		TailnetDial:        tailnetDial,
		HostKeyTrustPrompt: hostKeyTrustPrompt,
		Dialer:             sessionDialer,
	})
	moshManager := moshsession.NewManagerWithConfig(emitEvent, emitStream, moshsession.ManagerConfig{
		TailnetDial: tailnetDial,
		Dialer:      sessionDialer,
	})
	sftpService := coresftp.New(emitEvent)
	containersService := containersvc.New(emitEvent)
	forwardingService := forwarding.New(emitEvent)
	// 생성자에서 못 받는 것들. tailnet 레지스트리가 런타임 소유라 서비스보다 늦게 생긴다.
	sftpService.SetTailnetDial(tailnetDial)
	containersService.SetTailnetDial(tailnetDial)
	forwardingService.SetTailnetDial(tailnetDial)
	sftpService.SetHostKeyTrustPrompt(hostKeyTrustPrompt)
	containersService.SetHostKeyTrustPrompt(hostKeyTrustPrompt)
	forwardingService.SetHostKeyTrustPrompt(hostKeyTrustPrompt)

	instance = newRuntimeWithDeps(
		emitEvent,
		emitStream,
		sshManager,
		moshManager,
		awssession.NewManager(emitEvent, emitStream),
		localsession.NewManager(emitEvent, emitStream),
		serialsession.NewManager(emitEvent, emitStream),
		sftpService,
		containersService,
		forwardingService,
		ssmforward.New(emitEvent),
		func(requestID string, payload coretypes.HostKeyProbePayload) (coretypes.HostKeyProbedPayload, error) {
			jump := sshconn.JumpTargetFromCore(payload.Jump)
			// 프로브도 홉 진행을 방출한다: 점프 체인은 DialClient가, 최종 타깃 홉은 ProbeHostKey가
			// config.Progress로 보고. 상관 ID는 renderer가 넘긴 sessionId/endpointId를 그대로 사용해
			// 프로브 홉이 실제 연결과 같은 오버레이에 표시되게 한다.
			probeConfig := sshconn.DefaultConfig
			// 연결과 같은 tailnet 을 타야 한다. 경로가 없으면 dial 이 nil 이라 평소대로 나간다.
			probeDial, dialErr := instance.tailnetDial(TailnetRoute{
				ID:           payload.TailnetID,
				ExpectedName: payload.TailnetName,
			})
			if dialErr != nil {
				return coretypes.HostKeyProbedPayload{}, dialErr
			}
			probeConfig.Dial = probeDial
			// 점프 호스트가 대화형 인증(OTP 등)을 요구하면 사용자에게 물어야 한다. 창구가 없으면
			// 프로브가 그 자리에서 실패하고, 그 베스천 뒤의 호스트는 신뢰를 시작할 수도 없었다.
			probeConfig.InteractiveResponder = instance.probeInteractiveResponder(requestID, payload)
			probeConfig.Progress = sshconn.HopProgress(
				sshconn.Target{
					Host:    payload.Host,
					Port:    payload.Port,
					Jump:    jump,
					WSProxy: payload.WSProxy,
				},
				payload.SessionID,
				payload.EndpointID,
				emitEvent,
			)
			result, err := sshconn.ProbeHostKey(
				context.Background(),
				payload.Host,
				payload.Port,
				jump,
				payload.WSProxy,
				probeConfig,
			)
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

	// Tailnet orchestration은 공통 서비스가 소유한다. newRuntimeWithDeps 는 테스트가 직접
	// 부르는 생성자라 시그니처를 늘리지 않고, 실제 New 경로에서만 서비스를 붙인다.
	instance.tailnetService = tailnetservice.New(tailnetservice.Options{
		StateDir:  options.TailnetStateDir,
		EmitEvent: emitEvent,
	})
	// tmux 매니저는 newRuntimeWithDeps 안에서 만들어지므로 여기서 공유 경로를 쓰는 것으로 바꾼다.
	// 이것 없이는 tmux 만 자기 dialer 를 들고 있어 대기표가 갈린다.
	instance.tmux = tmuxsession.NewManagerWithConfig(emitEvent, emitStream, sshsession.ManagerConfig{
		TailnetDial:        tailnetDial,
		HostKeyTrustPrompt: hostKeyTrustPrompt,
		Dialer:             sessionDialer,
	})
	// 서비스들이 이미 이 대기표로 묻고 있으므로, 런타임의 응답 경로도 같은 것을 봐야 한다
	// (newRuntimeWithDeps 는 테스트용이라 시그니처를 늘리지 않는다 — tailnetService 와 같은 방식).
	instance.hostKeyTrust = hostKeyTrustRegistry
	instance.dialer = sessionDialer

	return instance
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
		probeChallenges:           newProbeChallenges(),
		hostKeyTrust:              hostkeytrust.New(),
		dialer:                    sshdial.New(emitEvent),
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

// RunCommand runs an arbitrary command on the session's auxiliary exec channel
// for the AI assistant's run_command tool, and emits the result correlated by
// requestID. v1 supports SSH sessions only (plain SSH / Warpgate / EC2-over-SSM);
// tmux control-mode, local and AWS SSM are unsupported and report an error in the
// result payload. Like RunCompletionQuery it is best-effort and never emits a
// session-fatal error that would tear down the terminal.
func (runtime *Runtime) RunCommand(sessionID, requestID, command string, timeoutMs int) error {
	if !runtime.ssh.HasSession(sessionID) {
		runtime.emitEvent(coretypes.Event{
			Type:      coretypes.EventRunCommandResult,
			RequestID: requestID,
			SessionID: sessionID,
			Payload: coretypes.RunCommandResultPayload{
				ExitCode: -1,
				Error:    "이 세션 유형은 명령 실행을 지원하지 않습니다.",
			},
		})
		return nil
	}
	stdout, stderr, exitCode, truncated, err := runtime.ssh.RunHostCommand(sessionID, command, timeoutMs)
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventRunCommandResult,
		RequestID: requestID,
		SessionID: sessionID,
		Payload: coretypes.RunCommandResultPayload{
			Stdout:    stdout,
			Stderr:    stderr,
			ExitCode:  exitCode,
			Truncated: truncated,
			Error:     errMsg,
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
// once per session (idempotent across refreshes). Managers that own delayed or
// transport-specific handshakes schedule their own flush; local sessions still
// use the runtime fallback timer. Injection runs before the snapshot probe so
// the prompt marker arrives ahead of the probe response.
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
		// AWS manager arms/writes/flushes the in-band handshake itself. Runtime
		// must not start a second flush timer here: SSM can delay the actual
		// init write until after AWS shell profile/run-as settles, and an early
		// runtime flush would release the raw first prompt before the integrated
		// prompt arrives.
		err = runtime.aws.InstallShellIntegration(sessionID)
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

// ReinjectShellIntegration re-installs the OSC 7/133 hooks into the shell that
// is currently in the foreground after the user enters a subshell (nested ssh,
// sudo su, docker exec). Only SSH and local sessions support it; other session
// types are a no-op. Unlike installShellIntegration it is not guarded by the
// once-per-session flag — re-injection is expected to run repeatedly as the
// user moves in and out of subshells. The manager waits for the subshell prompt
// to settle before writing, so this returns immediately after arming.
// shell 은 렌더러가 실행된 명령에서 알아낸 셸 이름이다(모르면 빈 문자열). 알면 그 셸 전용
// 스크립트 한 줄로 끝나고, 모르면 bash·zsh 겸용을 여러 줄로 보낸다.
func (runtime *Runtime) ReinjectShellIntegration(sessionID string, shell string) error {
	switch {
	case runtime.tmux.HasSession(sessionID):
		// control mode pane 도 서브셸에 들어가면 훅을 잃는다. 예전에는 이 분기가 없어 조용히
		// 아무 일도 하지 않았다 — tmux 로 작업하면 서브셸 통합이 아예 없었다.
		return runtime.tmux.ReinjectShellIntegration(sessionID, shell)
	case runtime.ssh.HasSession(sessionID):
		return runtime.ssh.ReinjectShellIntegration(sessionID, shell)
	case runtime.local.HasSession(sessionID):
		return runtime.local.ReinjectShellIntegration(sessionID, shell)
	default:
		return nil
	}
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
	result, err := runtime.probeHostKey(requestID, payload)
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

func (runtime *Runtime) InstallAuthorizedKey(requestID, correlationID string, payload coretypes.AuthorizedKeyInstallPayload) error {
	// 세션 계열과 같은 경로로 붙는다. 직접 조립하던 시절에는 tailnet dial 이 빠져 있어서
	// **tailnet 호스트에는 키를 설치할 수 없었다** — 조립을 한 곳에 두는 이유가 이것이다.
	//
	// 상관 ID 가 있으면 사람에게 물을 수 있다 — 화면이 그것으로 설치 대화상자를 찾아 입력창을
	// 띄운다. 없으면(옛 클라이언트) 예전처럼 아무것도 묻지 않고 인증 실패로 끝난다.
	client, _, err := runtime.dialer.Dial(context.Background(), sshdial.Request{
		SessionID: correlationID,
		RequestID: requestID,
		Payload:   payload.ConnectPayload,
	})
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

// RespondHostKeyTrust 는 "이 서버 키를 신뢰(교체)한다/하지 않는다" 는 사용자의 답을 전달한다.
//
// 대기표가 하나뿐이라 어느 서비스의 연결인지 고를 필요가 없다 — 챌린지 ID 가 그것을 담고 있다.
func (runtime *Runtime) RespondHostKeyTrust(payload coretypes.HostKeyTrustRespondPayload) error {
	return runtime.hostKeyTrust.Respond(payload.ChallengeID, payload.Trust)
}

// CancelInFlight 는 이 대상으로 진행 중인 연결 작업을 끊는다.
//
// 정지·종료 명령은 자기가 끊어야 할 작업과 같은 대상이라 그 뒤에 줄을 선다. 앞의 작업이 오래
// 기다리는 중이면 정지는 자기 차례를 못 받으므로, 프레임 라우터가 명령을 배차하기 **전에** 이것을
// 부른다. 어느 서비스의 것인지는 ID 만으로 알 수 없어 해당 계열 전부에 물어본다 — 끊을 것이 없으면
// 각 서비스에서 아무 일도 일어나지 않는다.
func (runtime *Runtime) CancelInFlight(sessionID, endpointID string) {
	if strings.TrimSpace(sessionID) != "" {
		runtime.ssh.CancelInFlight(sessionID)
	}
	if strings.TrimSpace(endpointID) != "" {
		runtime.forwarding.CancelInFlight(endpointID)
		runtime.sftp.CancelInFlight(endpointID)
		runtime.containers.CancelInFlight(endpointID)
	}
}

func (runtime *Runtime) RespondKeyboardInteractive(sessionID, endpointID string, payload coretypes.KeyboardInteractiveRespondPayload) error {
	// 사용자가 물음을 닫았으면 답이 아니라 취소다. 라우팅 규칙은 아래와 같다.
	if payload.Cancelled {
		return runtime.cancelKeyboardInteractive(endpointID, payload.ChallengeID)
	}
	// 호스트 키 프로브가 낸 챌린지는 어느 세션 매니저의 것도 아니다.
	//
	// 프로브는 상관용으로 연결과 **같은** sessionId·endpointId 를 쓰므로(그래야 화면이 이미 아는
	// 카드에 붙는다) 그 두 값으로는 구분할 수 없다. 그래서 챌린지 ID 앞자리로 가른다.
	//
	// 이 분기가 없으면 답이 세션 매니저로 갔다가 "challenge not found" 로 조용히 버려진다 —
	// 응답 보내기를 눌러도 아무 일도 없고 코어는 계속 사람을 기다린다. 실기기에서 그랬다.
	if isProbeChallenge(payload.ChallengeID) {
		return runtime.probeChallenges.respond(payload.ChallengeID, payload)
	}
	if endpointID != "" {
		if len(endpointID) >= len("containers:") && endpointID[:len("containers:")] == "containers:" {
			return runtime.containers.RespondKeyboardInteractive(endpointID, payload.ChallengeID, payload.Responses)
		}
		if err := runtime.forwarding.RespondKeyboardInteractive(endpointID, payload.ChallengeID, payload.Responses); err == nil {
			return nil
		}
		return runtime.sftp.RespondKeyboardInteractive(endpointID, payload.ChallengeID, payload.Responses)
	}
	// 세션 계열(SSH·mosh·tmux)은 대기표가 하나다 — 어느 매니저의 물음인지 고를 필요가 없다.
	//
	// 예전에는 "ssh 에 먼저 넣어 보고 실패하면 mosh" 였다. 챌린지가 connect 진행 중에 나서 세션이
	// 아직 등록 전이라 HasSession 으로 구분할 수 없었기 때문인데, 실패를 신호로 쓰는 방식이라
	// tmux 처럼 경로가 하나 늘 때마다 여기에 줄이 붙어야 했다. 대기표를 한 곳에 두면 그 분기가
	// 통째로 없어진다(internal/sshdial).
	if err := runtime.dialer.RespondKeyboardInteractive(payload); err != nil {
		return fmt.Errorf("%w (session %s)", err, sessionID)
	}
	return nil
}

// cancelKeyboardInteractive 는 사용자가 닫은 물음을 기다리던 쪽에 알린다.
//
// **왜 필요한가:** 화면에서 카드를 지우는 것만으로는 코어가 알 수 없다. 답을 기다리는 구간은
// 핸드셰이크 정지 감시가 일부러 꺼져 있어서(사람을 기다리는 것은 정지가 아니다) 그쪽이 대신 끊어
// 주지도 않는다. 그래서 예산 5분이 다 될 때까지 연결이 그대로 서 있었다 — 화면에는 "연결 중…" 이
// 남고, tailnet 을 경유하면 그 노드의 리스까지 잡은 채다.
//
// 어느 쪽 물음인지는 응답과 같은 규칙으로 가른다. 다만 여기서는 **찾을 때까지 훑는다** — 취소는
// 답과 달리 잘못된 곳에 가도 부작용이 없고(없으면 아무 일도 안 한다), 한 곳이라도 접히면 성공이다.
func (runtime *Runtime) cancelKeyboardInteractive(endpointID, challengeID string) error {
	if isProbeChallenge(challengeID) {
		return runtime.probeChallenges.cancel(challengeID)
	}
	if endpointID != "" {
		if strings.HasPrefix(endpointID, "containers:") {
			return runtime.containers.CancelKeyboardInteractive(endpointID, challengeID)
		}
		if err := runtime.forwarding.CancelKeyboardInteractive(endpointID, challengeID); err == nil {
			return nil
		}
		return runtime.sftp.CancelKeyboardInteractive(endpointID, challengeID)
	}
	return runtime.dialer.CancelChallenge(challengeID)
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

	runtime.shutdownTailnets()
}
