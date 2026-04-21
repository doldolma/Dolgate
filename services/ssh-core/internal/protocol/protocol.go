package protocol

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"

	"dolssh/services/ssh-core/pkg/coretypes"
)

type CommandType = coretypes.CommandType
type EventType = coretypes.EventType
type StreamType = coretypes.StreamType

const (
	CommandHealth                     = coretypes.CommandHealth
	CommandConnect                    = coretypes.CommandConnect
	CommandAWSConnect                 = coretypes.CommandAWSConnect
	CommandLocalConnect               = coretypes.CommandLocalConnect
	CommandSerialConnect              = coretypes.CommandSerialConnect
	CommandSerialListPorts            = coretypes.CommandSerialListPorts
	CommandSerialControl              = coretypes.CommandSerialControl
	CommandKeyboardInteractiveRespond = coretypes.CommandKeyboardInteractiveRespond
	CommandControlSignal              = coretypes.CommandControlSignal
	CommandResize                     = coretypes.CommandResize
	CommandDisconnect                 = coretypes.CommandDisconnect
	CommandProbeHostKey               = coretypes.CommandProbeHostKey
	CommandInspectCertificate         = coretypes.CommandInspectCertificate
	CommandPortForwardStart           = coretypes.CommandPortForwardStart
	CommandSSMPortForwardStart        = coretypes.CommandSSMPortForwardStart
	CommandPortForwardStop            = coretypes.CommandPortForwardStop
	CommandSSMPortForwardStop         = coretypes.CommandSSMPortForwardStop
	CommandSFTPConnect                = coretypes.CommandSFTPConnect
	CommandSFTPDisconnect             = coretypes.CommandSFTPDisconnect
	CommandSFTPList                   = coretypes.CommandSFTPList
	CommandSFTPMkdir                  = coretypes.CommandSFTPMkdir
	CommandSFTPRename                 = coretypes.CommandSFTPRename
	CommandSFTPChmod                  = coretypes.CommandSFTPChmod
	CommandSFTPDelete                 = coretypes.CommandSFTPDelete
	CommandSFTPTransferStart          = coretypes.CommandSFTPTransferStart
	CommandSFTPTransferCancel         = coretypes.CommandSFTPTransferCancel
	CommandContainersConnect          = coretypes.CommandContainersConnect
	CommandContainersDisconnect       = coretypes.CommandContainersDisconnect
	CommandContainersList             = coretypes.CommandContainersList
	CommandContainersInspect          = coretypes.CommandContainersInspect
	CommandContainersLogs             = coretypes.CommandContainersLogs
	CommandContainersStart            = coretypes.CommandContainersStart
	CommandContainersStop             = coretypes.CommandContainersStop
	CommandContainersRestart          = coretypes.CommandContainersRestart
	CommandContainersRemove           = coretypes.CommandContainersRemove
	CommandContainersStats            = coretypes.CommandContainersStats
	CommandContainersSearchLogs       = coretypes.CommandContainersSearchLogs
)

const (
	EventStatus                       = coretypes.EventStatus
	EventConnected                    = coretypes.EventConnected
	EventData                         = coretypes.EventData
	EventError                        = coretypes.EventError
	EventClosed                       = coretypes.EventClosed
	EventSerialPortsListed            = coretypes.EventSerialPortsListed
	EventSerialControlCompleted       = coretypes.EventSerialControlCompleted
	EventHostKeyProbed                = coretypes.EventHostKeyProbed
	EventCertificateInspected         = coretypes.EventCertificateInspected
	EventKeyboardInteractiveChallenge = coretypes.EventKeyboardInteractiveChallenge
	EventKeyboardInteractiveResolved  = coretypes.EventKeyboardInteractiveResolved
	EventPortForwardStarted           = coretypes.EventPortForwardStarted
	EventPortForwardStopped           = coretypes.EventPortForwardStopped
	EventPortForwardError             = coretypes.EventPortForwardError
	EventSFTPConnected                = coretypes.EventSFTPConnected
	EventSFTPDisconnected             = coretypes.EventSFTPDisconnected
	EventSFTPListed                   = coretypes.EventSFTPListed
	EventSFTPAck                      = coretypes.EventSFTPAck
	EventSFTPError                    = coretypes.EventSFTPError
	EventSFTPTransferProgress         = coretypes.EventSFTPTransferProgress
	EventSFTPTransferCompleted        = coretypes.EventSFTPTransferCompleted
	EventSFTPTransferFailed           = coretypes.EventSFTPTransferFailed
	EventSFTPTransferCancelled        = coretypes.EventSFTPTransferCancelled
	EventContainersConnected          = coretypes.EventContainersConnected
	EventContainersDisconnected       = coretypes.EventContainersDisconnected
	EventContainersListed             = coretypes.EventContainersListed
	EventContainersInspected          = coretypes.EventContainersInspected
	EventContainersLogs               = coretypes.EventContainersLogs
	EventContainersActionCompleted    = coretypes.EventContainersActionCompleted
	EventContainersStats              = coretypes.EventContainersStats
	EventContainersLogsSearched       = coretypes.EventContainersLogsSearched
	EventContainersError              = coretypes.EventContainersError
)

type FrameKind byte

const (
	FrameKindControl FrameKind = 1
	FrameKindStream  FrameKind = 2
)

const (
	StreamTypeWrite = coretypes.StreamTypeWrite
	StreamTypeData  = coretypes.StreamTypeData
)

type Request struct {
	ID         string          `json:"id"`
	Type       CommandType     `json:"type"`
	SessionID  string          `json:"sessionId,omitempty"`
	EndpointID string          `json:"endpointId,omitempty"`
	JobID      string          `json:"jobId,omitempty"`
	Payload    json.RawMessage `json:"payload"`
}

type Event = coretypes.Event
type StreamFrame = coretypes.StreamFrame
type ConnectPayload = coretypes.ConnectPayload
type AWSConnectPayload = coretypes.AWSConnectPayload
type LocalConnectPayload = coretypes.LocalConnectPayload
type SerialConnectPayload = coretypes.SerialConnectPayload
type SerialListPortsPayload = coretypes.SerialListPortsPayload
type SerialPortSummary = coretypes.SerialPortSummary
type SerialPortsListedPayload = coretypes.SerialPortsListedPayload
type SerialControlPayload = coretypes.SerialControlPayload
type SerialControlCompletedPayload = coretypes.SerialControlCompletedPayload
type SFTPConnectPayload = coretypes.SFTPConnectPayload
type ContainersConnectPayload = coretypes.ContainersConnectPayload
type HostKeyProbePayload = coretypes.HostKeyProbePayload
type CertificateInspectPayload = coretypes.CertificateInspectPayload
type CertificateInspectedPayload = coretypes.CertificateInspectedPayload
type KeyboardInteractivePrompt = coretypes.KeyboardInteractivePrompt
type KeyboardInteractiveChallengePayload = coretypes.KeyboardInteractiveChallengePayload
type KeyboardInteractiveRespondPayload = coretypes.KeyboardInteractiveRespondPayload
type ControlSignalPayload = coretypes.ControlSignalPayload
type ResizePayload = coretypes.ResizePayload
type SFTPListPayload = coretypes.SFTPListPayload
type SFTPMkdirPayload = coretypes.SFTPMkdirPayload
type SFTPRenamePayload = coretypes.SFTPRenamePayload
type SFTPChmodPayload = coretypes.SFTPChmodPayload
type SFTPDeletePayload = coretypes.SFTPDeletePayload
type ContainersInspectPayload = coretypes.ContainersInspectPayload
type ContainersLogsPayload = coretypes.ContainersLogsPayload
type ContainersActionPayload = coretypes.ContainersActionPayload
type ContainersStatsPayload = coretypes.ContainersStatsPayload
type ContainersSearchLogsPayload = coretypes.ContainersSearchLogsPayload
type TransferEndpointPayload = coretypes.TransferEndpointPayload
type TransferItemPayload = coretypes.TransferItemPayload
type SFTPTransferStartPayload = coretypes.SFTPTransferStartPayload
type PortForwardStartPayload = coretypes.PortForwardStartPayload
type SSMPortForwardStartPayload = coretypes.SSMPortForwardStartPayload
type StatusPayload = coretypes.StatusPayload
type ErrorPayload = coretypes.ErrorPayload
type ClosedPayload = coretypes.ClosedPayload
type SFTPConnectedPayload = coretypes.SFTPConnectedPayload
type ContainersConnectedPayload = coretypes.ContainersConnectedPayload
type HostKeyProbedPayload = coretypes.HostKeyProbedPayload
type PortForwardStartedPayload = coretypes.PortForwardStartedPayload
type AckPayload = coretypes.AckPayload
type SFTPFileEntry = coretypes.SFTPFileEntry
type SFTPListedPayload = coretypes.SFTPListedPayload
type ContainerSummary = coretypes.ContainerSummary
type ContainersListedPayload = coretypes.ContainersListedPayload
type ContainerMountSummary = coretypes.ContainerMountSummary
type ContainerNetworkSummary = coretypes.ContainerNetworkSummary
type ContainerPortBinding = coretypes.ContainerPortBinding
type ContainerPortSummary = coretypes.ContainerPortSummary
type KeyValuePair = coretypes.KeyValuePair
type ContainerDetailsPayload = coretypes.ContainerDetailsPayload
type ContainersLogsResultPayload = coretypes.ContainersLogsResultPayload
type ContainersActionCompletedPayload = coretypes.ContainersActionCompletedPayload
type ContainersStatsPayloadResult = coretypes.ContainersStatsPayloadResult
type ContainersSearchLogsResultPayload = coretypes.ContainersSearchLogsResultPayload
type SFTPTransferProgressPayload = coretypes.SFTPTransferProgressPayload

type Frame struct {
	Kind     FrameKind
	Metadata json.RawMessage
	Payload  []byte
}

const frameHeaderSize = 9

func ReadFrame(r io.Reader) (Frame, error) {
	header := make([]byte, frameHeaderSize)
	if _, err := io.ReadFull(r, header); err != nil {
		return Frame{}, err
	}

	metadataLength := binary.BigEndian.Uint32(header[1:5])
	payloadLength := binary.BigEndian.Uint32(header[5:9])

	metadata := make([]byte, metadataLength)
	if _, err := io.ReadFull(r, metadata); err != nil {
		return Frame{}, err
	}

	payload := make([]byte, payloadLength)
	if _, err := io.ReadFull(r, payload); err != nil {
		return Frame{}, err
	}

	return Frame{
		Kind:     FrameKind(header[0]),
		Metadata: metadata,
		Payload:  payload,
	}, nil
}

func WriteControlFrame(w io.Writer, value any) error {
	metadata, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writeFrame(w, FrameKindControl, metadata, nil)
}

func WriteStreamFrame(w io.Writer, metadataValue StreamFrame, payload []byte) error {
	metadata, err := json.Marshal(metadataValue)
	if err != nil {
		return err
	}
	return writeFrame(w, FrameKindStream, metadata, payload)
}

func writeFrame(w io.Writer, kind FrameKind, metadata []byte, payload []byte) error {
	header := make([]byte, frameHeaderSize)
	header[0] = byte(kind)
	binary.BigEndian.PutUint32(header[1:5], uint32(len(metadata)))
	binary.BigEndian.PutUint32(header[5:9], uint32(len(payload)))

	if _, err := w.Write(header); err != nil {
		return err
	}
	if _, err := w.Write(metadata); err != nil {
		return err
	}
	if len(payload) == 0 {
		return nil
	}
	if _, err := w.Write(payload); err != nil {
		return err
	}
	return nil
}

func DecodeControlFrame[T any](frame Frame, target *T) error {
	if frame.Kind != FrameKindControl {
		return fmt.Errorf("expected control frame, got %d", frame.Kind)
	}
	return json.Unmarshal(frame.Metadata, target)
}

func DecodeStreamFrame(frame Frame, target *StreamFrame) error {
	if frame.Kind != FrameKindStream {
		return fmt.Errorf("expected stream frame, got %d", frame.Kind)
	}
	return json.Unmarshal(frame.Metadata, target)
}
