package runtime

import (
	"strconv"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/awssession"
	containersvc "dolssh/services/ssh-core/internal/containers"
	"dolssh/services/ssh-core/internal/forwarding"
	"dolssh/services/ssh-core/internal/localsession"
	"dolssh/services/ssh-core/internal/serialsession"
	coresftp "dolssh/services/ssh-core/internal/sftp"
	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/internal/sshsession"
	"dolssh/services/ssh-core/internal/ssmforward"
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
}

type awsSessionManager interface {
	Connect(sessionID, requestID string, payload coretypes.AWSConnectPayload) error
	HasSession(sessionID string) bool
	WriteBytes(sessionID string, data []byte) error
	SendControlSignal(sessionID, signal string) error
	Resize(sessionID string, cols, rows int) error
	Disconnect(sessionID string) error
	Shutdown()
}

type localSessionManager interface {
	Connect(sessionID, requestID string, payload coretypes.LocalConnectPayload) error
	HasSession(sessionID string) bool
	WriteBytes(sessionID string, data []byte) error
	Resize(sessionID string, cols, rows int) error
	Disconnect(sessionID string) error
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
	emitEvent          func(coretypes.Event)
	emitStream         func(coretypes.StreamFrame, []byte)
	ssh                sshSessionManager
	aws                awsSessionManager
	local              localSessionManager
	serial             serialSessionManager
	sftp               sftpService
	containers         containersService
	forwarding         forwardingService
	ssmForwarding      ssmForwardingService
	probeHostKey       hostKeyProbeFunc
	inspectCertificate certificateInspectFunc
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
		awssession.NewManager(emitEvent, emitStream),
		localsession.NewManager(emitEvent, emitStream),
		serialsession.NewManager(emitEvent, emitStream),
		coresftp.New(emitEvent),
		containersvc.New(emitEvent),
		forwarding.New(emitEvent),
		ssmforward.New(emitEvent),
		func(payload coretypes.HostKeyProbePayload) (coretypes.HostKeyProbedPayload, error) {
			result, err := sshconn.ProbeHostKey(payload.Host, payload.Port, sshconn.DefaultConfig)
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
		emitEvent:          emitEvent,
		emitStream:         emitStream,
		ssh:                ssh,
		aws:                aws,
		local:              local,
		serial:             serial,
		sftp:               sftp,
		containers:         containers,
		forwarding:         forwarding,
		ssmForwarding:      ssmForwarding,
		probeHostKey:       probeHostKey,
		inspectCertificate: inspectCertificate,
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
	return runtime.ssh.Connect(sessionID, requestID, payload)
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
	switch {
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
	return runtime.ssh.RespondKeyboardInteractive(sessionID, payload.ChallengeID, payload.Responses)
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
