package coretypes

import "encoding/json"

// Protocol semantic constants and payloads live here so callers can embed the
// core runtime without importing the wire framing adapter package.
type CommandType string
type EventType string
type StreamType string

const (
	CommandHealth                     CommandType = "health"
	CommandConnect                    CommandType = "connect"
	CommandAWSConnect                 CommandType = "awsConnect"
	CommandLocalConnect               CommandType = "localConnect"
	CommandSerialConnect              CommandType = "serialConnect"
	CommandSerialListPorts            CommandType = "serialListPorts"
	CommandSerialControl              CommandType = "serialControl"
	CommandKeyboardInteractiveRespond CommandType = "keyboardInteractiveRespond"
	CommandControlSignal              CommandType = "controlSignal"
	CommandResize                     CommandType = "resize"
	CommandDisconnect                 CommandType = "disconnect"
	CommandProbeHostKey               CommandType = "probeHostKey"
	CommandInspectCertificate         CommandType = "inspectCertificate"
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
	CommandSFTPChown                  CommandType = "sftpChown"
	CommandSFTPListPrincipals         CommandType = "sftpListPrincipals"
	CommandSFTPDelete                 CommandType = "sftpDelete"
	CommandSFTPTransferStart          CommandType = "sftpTransferStart"
	CommandSFTPTransferCancel         CommandType = "sftpTransferCancel"
	CommandContainersConnect          CommandType = "containersConnect"
	CommandContainersDisconnect       CommandType = "containersDisconnect"
	CommandContainersList             CommandType = "containersList"
	CommandContainersInspect          CommandType = "containersInspect"
	CommandContainersLogs             CommandType = "containersLogs"
	CommandContainersStart            CommandType = "containersStart"
	CommandContainersStop             CommandType = "containersStop"
	CommandContainersRestart          CommandType = "containersRestart"
	CommandContainersRemove           CommandType = "containersRemove"
	CommandContainersStats            CommandType = "containersStats"
	CommandContainersSearchLogs       CommandType = "containersSearchLogs"
)

const (
	EventStatus                       EventType = "status"
	EventConnected                    EventType = "connected"
	EventData                         EventType = "data"
	EventError                        EventType = "error"
	EventClosed                       EventType = "closed"
	EventSerialPortsListed            EventType = "serialPortsListed"
	EventSerialControlCompleted       EventType = "serialControlCompleted"
	EventHostKeyProbed                EventType = "hostKeyProbed"
	EventCertificateInspected         EventType = "certificateInspected"
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
	EventSFTPSudoStatus               EventType = "sftpSudoStatus"
	EventSFTPPrincipalsListed         EventType = "sftpPrincipalsListed"
	EventSFTPTransferProgress         EventType = "sftpTransferProgress"
	EventSFTPTransferCompleted        EventType = "sftpTransferCompleted"
	EventSFTPTransferFailed           EventType = "sftpTransferFailed"
	EventSFTPTransferCancelled        EventType = "sftpTransferCancelled"
	EventContainersConnected          EventType = "containersConnected"
	EventContainersDisconnected       EventType = "containersDisconnected"
	EventContainersListed             EventType = "containersListed"
	EventContainersInspected          EventType = "containersInspected"
	EventContainersLogs               EventType = "containersLogs"
	EventContainersActionCompleted    EventType = "containersActionCompleted"
	EventContainersStats              EventType = "containersStats"
	EventContainersLogsSearched       EventType = "containersLogsSearched"
	EventContainersError              EventType = "containersError"
)

const (
	StreamTypeWrite StreamType = "write"
	StreamTypeData  StreamType = "data"
)

type Event struct {
	Type       EventType `json:"type"`
	RequestID  string    `json:"requestId,omitempty"`
	SessionID  string    `json:"sessionId,omitempty"`
	EndpointID string    `json:"endpointId,omitempty"`
	JobID      string    `json:"jobId,omitempty"`
	Payload    any       `json:"payload,omitempty"`
}

type StreamFrame struct {
	Type      StreamType `json:"type"`
	SessionID string     `json:"sessionId"`
	RequestID string     `json:"requestId,omitempty"`
}

type ConnectPayload struct {
	Host                 string `json:"host"`
	Port                 int    `json:"port"`
	Username             string `json:"username"`
	AuthType             string `json:"authType"`
	Password             string `json:"password,omitempty"`
	PrivateKeyPEM        string `json:"privateKeyPem,omitempty"`
	CertificateText      string `json:"certificateText,omitempty"`
	Passphrase           string `json:"passphrase,omitempty"`
	TrustedHostKeyBase64 string `json:"trustedHostKeyBase64"`
	Cols                 int    `json:"cols"`
	Rows                 int    `json:"rows"`
	Command              string `json:"command,omitempty"`
}

type AWSConnectPayload struct {
	ProfileName string            `json:"profileName"`
	Region      string            `json:"region"`
	InstanceID  string            `json:"instanceId"`
	Cols        int               `json:"cols"`
	Rows        int               `json:"rows"`
	Env         map[string]string `json:"env,omitempty"`
	UnsetEnv    []string          `json:"unsetEnv,omitempty"`
}

type LocalConnectPayload struct {
	Cols             int               `json:"cols"`
	Rows             int               `json:"rows"`
	Title            string            `json:"title,omitempty"`
	ShellKind        string            `json:"shellKind,omitempty"`
	Executable       string            `json:"executable,omitempty"`
	Args             []string          `json:"args,omitempty"`
	Env              map[string]string `json:"env,omitempty"`
	WorkingDirectory string            `json:"workingDirectory,omitempty"`
}

type SerialConnectPayload struct {
	Transport          string  `json:"transport"`
	Cols               int     `json:"cols"`
	Rows               int     `json:"rows"`
	Title              string  `json:"title,omitempty"`
	DevicePath         string  `json:"devicePath,omitempty"`
	Host               string  `json:"host,omitempty"`
	Port               int     `json:"port,omitempty"`
	BaudRate           int     `json:"baudRate"`
	DataBits           int     `json:"dataBits"`
	Parity             string  `json:"parity"`
	StopBits           float64 `json:"stopBits"`
	FlowControl        string  `json:"flowControl"`
	TransmitLineEnding string  `json:"transmitLineEnding"`
	LocalEcho          bool    `json:"localEcho"`
	LocalLineEditing   bool    `json:"localLineEditing"`
}

type SerialListPortsPayload struct {
	IncludeBusy bool `json:"includeBusy,omitempty"`
}

type SerialPortSummary struct {
	Path         string `json:"path"`
	DisplayName  string `json:"displayName,omitempty"`
	Manufacturer string `json:"manufacturer,omitempty"`
}

type SerialPortsListedPayload struct {
	Ports []SerialPortSummary `json:"ports"`
}

type SerialControlPayload struct {
	Action  string `json:"action"`
	Enabled *bool  `json:"enabled,omitempty"`
}

type SerialControlCompletedPayload struct {
	Action  string `json:"action"`
	Enabled *bool  `json:"enabled,omitempty"`
}

type SFTPConnectPayload struct {
	Host                 string `json:"host"`
	Port                 int    `json:"port"`
	Username             string `json:"username"`
	AuthType             string `json:"authType"`
	Password             string `json:"password,omitempty"`
	PrivateKeyPEM        string `json:"privateKeyPem,omitempty"`
	CertificateText      string `json:"certificateText,omitempty"`
	Passphrase           string `json:"passphrase,omitempty"`
	TrustedHostKeyBase64 string `json:"trustedHostKeyBase64"`
}

type ContainersConnectPayload struct {
	Host                 string `json:"host"`
	Port                 int    `json:"port"`
	Username             string `json:"username"`
	AuthType             string `json:"authType"`
	Password             string `json:"password,omitempty"`
	PrivateKeyPEM        string `json:"privateKeyPem,omitempty"`
	CertificateText      string `json:"certificateText,omitempty"`
	Passphrase           string `json:"passphrase,omitempty"`
	TrustedHostKeyBase64 string `json:"trustedHostKeyBase64"`
}

type HostKeyProbePayload struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

type CertificateInspectPayload struct {
	CertificateText string `json:"certificateText"`
}

type CertificateInspectedPayload struct {
	Status      string   `json:"status"`
	ValidAfter  string   `json:"validAfter,omitempty"`
	ValidBefore string   `json:"validBefore,omitempty"`
	Principals  []string `json:"principals,omitempty"`
	KeyID       string   `json:"keyId,omitempty"`
	Serial      string   `json:"serial,omitempty"`
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

type ControlSignalPayload struct {
	Signal string `json:"signal"`
}

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

type SFTPChownPayload struct {
	Path         string `json:"path"`
	Owner        string `json:"owner,omitempty"`
	Group        string `json:"group,omitempty"`
	UID          *int   `json:"uid,omitempty"`
	GID          *int   `json:"gid,omitempty"`
	Recursive    bool   `json:"recursive,omitempty"`
	SudoPassword string `json:"sudoPassword,omitempty"`
}

type SFTPListPrincipalsPayload struct {
	Kind  string `json:"kind"`
	Query string `json:"query,omitempty"`
	Limit int    `json:"limit,omitempty"`
}

type SFTPDeletePayload struct {
	Paths []string `json:"paths"`
}

type ContainersInspectPayload struct {
	ContainerID string `json:"containerId"`
}

type ContainersLogsPayload struct {
	ContainerID  string `json:"containerId"`
	Tail         int    `json:"tail"`
	FollowCursor string `json:"followCursor,omitempty"`
}

type ContainersActionPayload struct {
	ContainerID string `json:"containerId"`
}

type ContainersStatsPayload struct {
	ContainerID string `json:"containerId"`
}

type ContainersSearchLogsPayload struct {
	ContainerID string `json:"containerId"`
	Tail        int    `json:"tail"`
	Query       string `json:"query"`
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
	CertificateText      string `json:"certificateText,omitempty"`
	Passphrase           string `json:"passphrase,omitempty"`
	TrustedHostKeyBase64 string `json:"trustedHostKeyBase64"`
	Mode                 string `json:"mode"`
	BindAddress          string `json:"bindAddress"`
	BindPort             int    `json:"bindPort"`
	TargetHost           string `json:"targetHost,omitempty"`
	TargetPort           int    `json:"targetPort,omitempty"`
	SourceEndpointID     string `json:"sourceEndpointId,omitempty"`
}

type SSMPortForwardStartPayload struct {
	ProfileName string            `json:"profileName"`
	Region      string            `json:"region"`
	TargetType  string            `json:"targetType"`
	TargetID    string            `json:"targetId"`
	BindAddress string            `json:"bindAddress"`
	BindPort    int               `json:"bindPort"`
	TargetKind  string            `json:"targetKind"`
	TargetPort  int               `json:"targetPort"`
	RemoteHost  string            `json:"remoteHost,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	UnsetEnv    []string          `json:"unsetEnv,omitempty"`
}

type StatusPayload struct {
	Status    string `json:"status"`
	Message   string `json:"message,omitempty"`
	ShellKind string `json:"shellKind,omitempty"`
}

type ErrorPayload struct {
	Message string `json:"message"`
}

type ClosedPayload struct {
	Message string `json:"message,omitempty"`
}

type SFTPConnectedPayload struct {
	Path       string `json:"path"`
	SudoStatus string `json:"sudoStatus,omitempty"`
}

type ContainersConnectedPayload struct {
	Runtime           string `json:"runtime,omitempty"`
	RuntimeCommand    string `json:"runtimeCommand,omitempty"`
	UnsupportedReason string `json:"unsupportedReason,omitempty"`
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
	Method      string `json:"method,omitempty"`
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
	UID         *int   `json:"uid,omitempty"`
	GID         *int   `json:"gid,omitempty"`
	Owner       string `json:"owner,omitempty"`
	Group       string `json:"group,omitempty"`
}

type SFTPListedPayload struct {
	Path    string          `json:"path"`
	Entries []SFTPFileEntry `json:"entries"`
}

type SFTPPrincipal struct {
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	ID          int    `json:"id"`
	DisplayName string `json:"displayName,omitempty"`
}

type SFTPPrincipalsListedPayload struct {
	Kind       string          `json:"kind"`
	Query      string          `json:"query,omitempty"`
	Principals []SFTPPrincipal `json:"principals"`
}

type SFTPSudoStatusPayload struct {
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

type ContainerSummary struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Runtime   string `json:"runtime"`
	Image     string `json:"image"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
	Ports     string `json:"ports"`
}

type ContainersListedPayload struct {
	Runtime    string             `json:"runtime,omitempty"`
	Containers []ContainerSummary `json:"containers"`
}

type ContainerMountSummary struct {
	Type        string `json:"type"`
	Source      string `json:"source"`
	Destination string `json:"destination"`
	Mode        string `json:"mode,omitempty"`
	ReadOnly    bool   `json:"readOnly"`
}

type ContainerNetworkSummary struct {
	Name      string   `json:"name"`
	IPAddress string   `json:"ipAddress,omitempty"`
	Aliases   []string `json:"aliases"`
}

type ContainerPortBinding struct {
	HostIP   string `json:"hostIp,omitempty"`
	HostPort int    `json:"hostPort,omitempty"`
}

type ContainerPortSummary struct {
	ContainerPort     int                    `json:"containerPort"`
	Protocol          string                 `json:"protocol"`
	PublishedBindings []ContainerPortBinding `json:"publishedBindings"`
}

type KeyValuePair struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type ContainerDetailsPayload struct {
	ID          string                    `json:"id"`
	Name        string                    `json:"name"`
	Runtime     string                    `json:"runtime"`
	Image       string                    `json:"image"`
	Status      string                    `json:"status"`
	CreatedAt   string                    `json:"createdAt"`
	Command     string                    `json:"command"`
	Entrypoint  string                    `json:"entrypoint"`
	Mounts      []ContainerMountSummary   `json:"mounts"`
	Networks    []ContainerNetworkSummary `json:"networks"`
	Ports       []ContainerPortSummary    `json:"ports"`
	Environment []KeyValuePair            `json:"environment"`
	Labels      []KeyValuePair            `json:"labels"`
}

type ContainersLogsResultPayload struct {
	Runtime     string   `json:"runtime"`
	ContainerID string   `json:"containerId"`
	Lines       []string `json:"lines"`
	Cursor      string   `json:"cursor,omitempty"`
}

type ContainersActionCompletedPayload struct {
	Runtime     string `json:"runtime"`
	Action      string `json:"action"`
	ContainerID string `json:"containerId"`
	Message     string `json:"message,omitempty"`
}

type ContainersStatsPayloadResult struct {
	Runtime          string  `json:"runtime"`
	ContainerID      string  `json:"containerId"`
	RecordedAt       string  `json:"recordedAt"`
	CPUPercent       float64 `json:"cpuPercent"`
	MemoryUsedBytes  int64   `json:"memoryUsedBytes"`
	MemoryLimitBytes int64   `json:"memoryLimitBytes"`
	MemoryPercent    float64 `json:"memoryPercent"`
	NetworkRxBytes   int64   `json:"networkRxBytes"`
	NetworkTxBytes   int64   `json:"networkTxBytes"`
	BlockReadBytes   int64   `json:"blockReadBytes"`
	BlockWriteBytes  int64   `json:"blockWriteBytes"`
}

type ContainersSearchLogsResultPayload struct {
	Runtime     string   `json:"runtime"`
	ContainerID string   `json:"containerId"`
	Query       string   `json:"query"`
	Lines       []string `json:"lines"`
	MatchCount  int      `json:"matchCount"`
}

type SFTPTransferProgressPayload struct {
	Status              string  `json:"status"`
	BytesTotal          int64   `json:"bytesTotal"`
	BytesCompleted      int64   `json:"bytesCompleted"`
	ActiveItemName      string  `json:"activeItemName,omitempty"`
	SpeedBytesPerSecond float64 `json:"speedBytesPerSecond,omitempty"`
	ETASeconds          int64   `json:"etaSeconds,omitempty"`
	Message             string  `json:"message,omitempty"`
	ErrorCode           string  `json:"errorCode,omitempty"`
	ErrorOperation      string  `json:"errorOperation,omitempty"`
	ErrorPath           string  `json:"errorPath,omitempty"`
	ErrorItemName       string  `json:"errorItemName,omitempty"`
	DetailMessage       string  `json:"detailMessage,omitempty"`
}

type RawPayload = json.RawMessage
