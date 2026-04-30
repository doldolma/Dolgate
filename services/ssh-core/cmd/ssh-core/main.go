package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"dolssh/services/ssh-core/internal/protocol"
	coreruntime "dolssh/services/ssh-core/pkg/runtime"
)

type coreRuntime interface {
	EmitReady()
	Health(requestID string)
	ConnectSSH(sessionID, requestID string, payload protocol.ConnectPayload) error
	ConnectAWS(sessionID, requestID string, payload protocol.AWSConnectPayload) error
	ConnectLocal(sessionID, requestID string, payload protocol.LocalConnectPayload) error
	ConnectSerial(sessionID, requestID string, payload protocol.SerialConnectPayload) error
	ListSerialPorts(requestID string, payload protocol.SerialListPortsPayload) error
	ControlSerial(sessionID string, payload protocol.SerialControlPayload) error
	SendSessionInput(sessionID string, data []byte) error
	SendControlSignal(sessionID string, payload protocol.ControlSignalPayload) error
	ResizeSession(sessionID string, payload protocol.ResizePayload) error
	DisconnectSession(sessionID string) error
	ProbeHostKey(requestID string, payload protocol.HostKeyProbePayload) error
	InspectCertificate(requestID string, payload protocol.CertificateInspectPayload) error
	RespondKeyboardInteractive(sessionID, endpointID string, payload protocol.KeyboardInteractiveRespondPayload) error
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
	})
	defer core.Shutdown()
	core.EmitReady()

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

		if err := dispatchFrame(core, writer, frame); err != nil {
			eventType := protocol.EventError
			if isSFTPCommand(frame) {
				eventType = protocol.EventSFTPError
			} else if isContainersCommand(frame) {
				eventType = protocol.EventContainersError
			} else if isPortForwardCommand(frame) {
				eventType = protocol.EventPortForwardError
			}
			writer.emit(protocol.Event{
				Type:       eventType,
				RequestID:  frameRequestID(frame),
				SessionID:  frameSessionID(frame),
				EndpointID: frameEndpointID(frame),
				JobID:      frameJobID(frame),
				Payload: protocol.ErrorPayload{
					Message: err.Error(),
				},
			})
		}
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
	case protocol.CommandProbeHostKey:
		var payload protocol.HostKeyProbePayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.ProbeHostKey(request.ID, payload)
	case protocol.CommandInspectCertificate:
		var payload protocol.CertificateInspectPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.InspectCertificate(request.ID, payload)
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
	case protocol.CommandKeyboardInteractiveRespond:
		var payload protocol.KeyboardInteractiveRespondPayload
		if err := json.Unmarshal(request.Payload, &payload); err != nil {
			return err
		}
		return core.RespondKeyboardInteractive(request.SessionID, request.EndpointID, payload)
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
					Message: err.Error(),
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
