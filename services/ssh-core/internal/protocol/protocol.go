package protocol

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

// 프로토콜 상수는 Electron과 Go 코어가 동일한 문자열 계약을 공유하기 위한 기준점이다.
type CommandType string
type EventType string
type FrameKind byte
type StreamType string

const (
	// health는 코어 생존 여부 확인용이고, 나머지는 SSH 세션 조작 명령이다.
	CommandHealth                     CommandType = "health"
	CommandConnect                    CommandType = "connect"
	CommandAWSConnect                 CommandType = "awsConnect"
	CommandLocalConnect               CommandType = "localConnect"
	CommandKeyboardInteractiveRespond CommandType = "keyboardInteractiveRespond"
	CommandResize                     CommandType = "resize"
	CommandDisconnect                 CommandType = "disconnect"
	CommandProbeHostKey               CommandType = "probeHostKey"
	CommandPortForwardStart           CommandType = "portForwardStart"
	CommandSSMPortForwardStart        CommandType = "ssmPortForwardStart"
	CommandPortForwardStop            CommandType = "portForwardStop"
	CommandSSMPortForwardStop         CommandType = "ssmPortForwardStop"
	CommandSFTPConnect                CommandType = "sftpConnect"
	CommandSFTPDisconnect             CommandType = "sftpDisconnect"
	CommandSFTPList                   CommandType = "sftpList"
	CommandSFTPMkdir                  CommandType = "sftpMkdir"
	CommandSFTPRename                 CommandType = "sftpRename"
	CommandSFTPChmod                  CommandType = "sftpChmod"
	CommandSFTPDelete                 CommandType = "sftpDelete"
	CommandSFTPTransferStart          CommandType = "sftpTransferStart"
	CommandSFTPTransferCancel         CommandType = "sftpTransferCancel"
)

const (
	// status는 프로세스 전체 상태, connected/data/error/closed는 세션 단위 이벤트다.
	EventStatus                       EventType = "status"
	EventConnected                    EventType = "connected"
	EventData                         EventType = "data"
	EventError                        EventType = "error"
	EventClosed                       EventType = "closed"
	EventHostKeyProbed                EventType = "hostKeyProbed"
	EventKeyboardInteractiveChallenge EventType = "keyboardInteractiveChallenge"
	EventKeyboardInteractiveResolved  EventType = "keyboardInteractiveResolved"
	EventPortForwardStarted           EventType = "portForwardStarted"
	EventPortForwardStopped           EventType = "portForwardStopped"
	EventPortForwardError             EventType = "portForwardError"
	EventSFTPConnected                EventType = "sftpConnected"
	EventSFTPDisconnected             EventType = "sftpDisconnected"
	EventSFTPListed                   EventType = "sftpListed"
	EventSFTPAck                      EventType = "sftpAck"
	EventSFTPError                    EventType = "sftpError"
	EventSFTPTransferProgress         EventType = "sftpTransferProgress"
	EventSFTPTransferCompleted        EventType = "sftpTransferCompleted"
	EventSFTPTransferFailed           EventType = "sftpTransferFailed"
	EventSFTPTransferCancelled        EventType = "sftpTransferCancelled"
)

const (
	// control frame은 JSON 메타데이터만, stream frame은 raw payload까지 함께 가진다.
	FrameKindControl FrameKind = 1
	FrameKindStream  FrameKind = 2
)

const (
	// write는 main -> core 입력 스트림, data는 core -> main 출력 스트림이다.
	StreamTypeWrite StreamType = "write"
	StreamTypeData  StreamType = "data"
)

// Request는 control frame 안에 담겨 stdin으로 들어오는 제어 명령이다.
type Request struct {
	ID         string          `json:"id"`
	Type       CommandType     `json:"type"`
	SessionID  string          `json:"sessionId,omitempty"`
	EndpointID string          `json:"endpointId,omitempty"`
	JobID      string          `json:"jobId,omitempty"`
	Payload    json.RawMessage `json:"payload"`
}

// Event는 control frame 안에 담겨 stdout으로 나가는 상태 이벤트다.
type Event struct {
	Type       EventType `json:"type"`
	RequestID  string    `json:"requestId,omitempty"`
	SessionID  string    `json:"sessionId,omitempty"`
	EndpointID string    `json:"endpointId,omitempty"`
	JobID      string    `json:"jobId,omitempty"`
	Payload    any       `json:"payload,omitempty"`
}

// StreamFrame은 raw 바이트를 다루는 hot path용 메타데이터다.
type StreamFrame struct {
	Type      StreamType `json:"type"`
	SessionID string     `json:"sessionId"`
	RequestID string     `json:"requestId,omitempty"`
}

// Frame은 stdio 위의 binary 프레임 한 개를 표현한다.
type Frame struct {
	Kind     FrameKind
	Metadata json.RawMessage
	Payload  []byte
}

// ConnectPayload는 main 프로세스가 비밀값을 해석한 뒤 코어에 넘기는 최종 접속 정보다.
type ConnectPayload struct {
	Host                 string `json:"host"`
	Port                 int    `json:"port"`
	Username             string `json:"username"`
	AuthType             string `json:"authType"`
	Password             string `json:"password,omitempty"`
	PrivateKeyPEM        string `json:"privateKeyPem,omitempty"`
	PrivateKeyPath       string `json:"privateKeyPath,omitempty"`
	Passphrase           string `json:"passphrase,omitempty"`
	TrustedHostKeyBase64 string `json:"trustedHostKeyBase64"`
	Cols                 int    `json:"cols"`
	Rows                 int    `json:"rows"`
}

type AWSConnectPayload struct {
	ProfileName string `json:"profileName"`
	Region      string `json:"region"`
	InstanceID  string `json:"instanceId"`
	Cols        int    `json:"cols"`
	Rows        int    `json:"rows"`
}

type LocalConnectPayload struct {
	Cols  int    `json:"cols"`
	Rows  int    `json:"rows"`
	Title string `json:"title,omitempty"`
}

// SFTPConnectPayload는 원격 파일 브라우저 접속을 위한 인증 정보다.
type SFTPConnectPayload struct {
	Host                 string `json:"host"`
	Port                 int    `json:"port"`
	Username             string `json:"username"`
	AuthType             string `json:"authType"`
	Password             string `json:"password,omitempty"`
	PrivateKeyPEM        string `json:"privateKeyPem,omitempty"`
	PrivateKeyPath       string `json:"privateKeyPath,omitempty"`
	Passphrase           string `json:"passphrase,omitempty"`
	TrustedHostKeyBase64 string `json:"trustedHostKeyBase64"`
}

type HostKeyProbePayload struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

type KeyboardInteractivePrompt struct {
	Label string `json:"label"`
	Echo  bool   `json:"echo"`
}

type KeyboardInteractiveChallengePayload struct {
	ChallengeID string                      `json:"challengeId"`
	Attempt     int                         `json:"attempt"`
	Name        string                      `json:"name,omitempty"`
	Instruction string                      `json:"instruction"`
	Prompts     []KeyboardInteractivePrompt `json:"prompts"`
}

type KeyboardInteractiveRespondPayload struct {
	ChallengeID string   `json:"challengeId"`
	Responses   []string `json:"responses"`
}

// ResizePayload는 xterm 크기와 원격 PTY 크기를 맞추기 위한 요청이다.
type ResizePayload struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

type SFTPListPayload struct {
	Path string `json:"path"`
}

type SFTPMkdirPayload struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

type SFTPRenamePayload struct {
	Path     string `json:"path"`
	NextName string `json:"nextName"`
}

type SFTPChmodPayload struct {
	Path string `json:"path"`
	Mode int    `json:"mode"`
}

type SFTPDeletePayload struct {
	Paths []string `json:"paths"`
}

type TransferEndpointPayload struct {
	Kind       string `json:"kind"`
	EndpointID string `json:"endpointId,omitempty"`
	Path       string `json:"path"`
}

type TransferItemPayload struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	IsDirectory bool   `json:"isDirectory"`
	Size        int64  `json:"size"`
}

type SFTPTransferStartPayload struct {
	Source             TransferEndpointPayload `json:"source"`
	Target             TransferEndpointPayload `json:"target"`
	Items              []TransferItemPayload   `json:"items"`
	ConflictResolution string                  `json:"conflictResolution"`
}

type PortForwardStartPayload struct {
	Host                 string `json:"host"`
	Port                 int    `json:"port"`
	Username             string `json:"username"`
	AuthType             string `json:"authType"`
	Password             string `json:"password,omitempty"`
	PrivateKeyPEM        string `json:"privateKeyPem,omitempty"`
	PrivateKeyPath       string `json:"privateKeyPath,omitempty"`
	Passphrase           string `json:"passphrase,omitempty"`
	TrustedHostKeyBase64 string `json:"trustedHostKeyBase64"`
	Mode                 string `json:"mode"`
	BindAddress          string `json:"bindAddress"`
	BindPort             int    `json:"bindPort"`
	TargetHost           string `json:"targetHost,omitempty"`
	TargetPort           int    `json:"targetPort,omitempty"`
}

type SSMPortForwardStartPayload struct {
	ProfileName string `json:"profileName"`
	Region      string `json:"region"`
	InstanceID  string `json:"instanceId"`
	BindAddress string `json:"bindAddress"`
	BindPort    int    `json:"bindPort"`
	TargetKind  string `json:"targetKind"`
	TargetPort  int    `json:"targetPort"`
	RemoteHost  string `json:"remoteHost,omitempty"`
}

// StatusPayload는 프로세스/세션 상태를 짧은 문자열로 표현한다.
type StatusPayload struct {
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

// ErrorPayload는 사람이 바로 읽을 수 있는 진단 메시지를 담는다.
type ErrorPayload struct {
	Message string `json:"message"`
}

// ClosedPayload는 세션 종료 이유를 선택적으로 담는다.
type ClosedPayload struct {
	Message string `json:"message,omitempty"`
}

type SFTPConnectedPayload struct {
	Path string `json:"path"`
}

type HostKeyProbedPayload struct {
	Algorithm         string `json:"algorithm"`
	PublicKeyBase64   string `json:"publicKeyBase64"`
	FingerprintSHA256 string `json:"fingerprintSha256"`
}

type PortForwardStartedPayload struct {
	Transport   string `json:"transport,omitempty"`
	Status      string `json:"status"`
	Mode        string `json:"mode"`
	BindAddress string `json:"bindAddress"`
	BindPort    int    `json:"bindPort"`
	Message     string `json:"message,omitempty"`
}

type AckPayload struct {
	Message string `json:"message,omitempty"`
}

type SFTPFileEntry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	IsDirectory bool   `json:"isDirectory"`
	Size        int64  `json:"size"`
	Mtime       string `json:"mtime"`
	Kind        string `json:"kind"`
	Permissions string `json:"permissions,omitempty"`
}

type SFTPListedPayload struct {
	Path    string          `json:"path"`
	Entries []SFTPFileEntry `json:"entries"`
}

type SFTPTransferProgressPayload struct {
	Status              string  `json:"status"`
	BytesTotal          int64   `json:"bytesTotal"`
	BytesCompleted      int64   `json:"bytesCompleted"`
	ActiveItemName      string  `json:"activeItemName,omitempty"`
	SpeedBytesPerSecond float64 `json:"speedBytesPerSecond,omitempty"`
	ETASeconds          int64   `json:"etaSeconds,omitempty"`
	Message             string  `json:"message,omitempty"`
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
