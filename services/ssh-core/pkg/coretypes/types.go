package coretypes

import "encoding/json"

// Protocol semantic constants and payloads live here so callers can embed the
// core runtime without importing the wire framing adapter package.
type CommandType string
type EventType string
type StreamType string

const (
	CommandHealth                      CommandType = "health"
	CommandConnect                     CommandType = "connect"
	CommandAWSConnect                  CommandType = "awsConnect"
	CommandLocalConnect                CommandType = "localConnect"
	CommandSerialConnect               CommandType = "serialConnect"
	CommandSerialListPorts             CommandType = "serialListPorts"
	CommandSerialControl               CommandType = "serialControl"
	CommandKeyboardInteractiveRespond  CommandType = "keyboardInteractiveRespond"
	CommandControlSignal               CommandType = "controlSignal"
	CommandResize                      CommandType = "resize"
	CommandDisconnect                  CommandType = "disconnect"
	CommandProbeHostKey                CommandType = "probeHostKey"
	CommandInspectCertificate          CommandType = "inspectCertificate"
	CommandGeneratePrivateKey          CommandType = "generatePrivateKey"
	CommandInspectPrivateKey           CommandType = "inspectPrivateKey"
	CommandInstallAuthorizedKey        CommandType = "installAuthorizedKey"
	CommandPortForwardStart            CommandType = "portForwardStart"
	CommandSSMPortForwardStart         CommandType = "ssmPortForwardStart"
	CommandPortForwardStop             CommandType = "portForwardStop"
	CommandSSMPortForwardStop          CommandType = "ssmPortForwardStop"
	CommandSFTPConnect                 CommandType = "sftpConnect"
	CommandSFTPDisconnect              CommandType = "sftpDisconnect"
	CommandSFTPList                    CommandType = "sftpList"
	CommandSFTPMkdir                   CommandType = "sftpMkdir"
	CommandSFTPRename                  CommandType = "sftpRename"
	CommandSFTPChmod                   CommandType = "sftpChmod"
	CommandSFTPChown                   CommandType = "sftpChown"
	CommandSFTPListPrincipals          CommandType = "sftpListPrincipals"
	CommandSFTPDelete                  CommandType = "sftpDelete"
	CommandSFTPReadFile                CommandType = "sftpReadFile"
	CommandSFTPWriteFile               CommandType = "sftpWriteFile"
	CommandSFTPTransferStart           CommandType = "sftpTransferStart"
	CommandSFTPTransferCancel          CommandType = "sftpTransferCancel"
	CommandSFTPTransferPause           CommandType = "sftpTransferPause"
	CommandSFTPTransferResume          CommandType = "sftpTransferResume"
	CommandContainersConnect           CommandType = "containersConnect"
	CommandContainersDisconnect        CommandType = "containersDisconnect"
	CommandContainersList              CommandType = "containersList"
	CommandContainersInspect           CommandType = "containersInspect"
	CommandContainersLogs              CommandType = "containersLogs"
	CommandContainersStart             CommandType = "containersStart"
	CommandContainersStop              CommandType = "containersStop"
	CommandContainersRestart           CommandType = "containersRestart"
	CommandContainersRemove            CommandType = "containersRemove"
	CommandContainersStats             CommandType = "containersStats"
	CommandContainersSearchLogs        CommandType = "containersSearchLogs"
	CommandTailnetTest                 CommandType = "tailnetTest"
	CommandTailnetForget               CommandType = "tailnetForget"
	CommandTailnetDisconnect           CommandType = "tailnetDisconnect"
	CommandTailnetCancel               CommandType = "tailnetCancel"
	CommandTailnetSnapshot             CommandType = "tailnetSnapshot"
	CommandTailnetConfigure            CommandType = "tailnetConfigure"
	CommandTailnetForwardOpen          CommandType = "tailnetForwardOpen"
	CommandTailnetForwardClose         CommandType = "tailnetForwardClose"
	CommandTerminalAutocompletePrepare CommandType = "terminalAutocompletePrepare"
	CommandTerminalAutocompleteRefresh CommandType = "terminalAutocompleteRefresh"
	CommandTerminalAutocompleteStop    CommandType = "terminalAutocompleteStop"
	CommandTerminalCompletionQuery     CommandType = "terminalCompletionQuery"
	CommandShellIntegrationInstall     CommandType = "terminalShellIntegrationInstall"
	CommandShellIntegrationReinject    CommandType = "terminalShellIntegrationReinject"
	CommandRunCommand                  CommandType = "runCommand"
	CommandTmuxConnect                 CommandType = "tmuxConnect"
	CommandTmuxSendKeys                CommandType = "tmuxSendKeys"
	CommandTmuxSplitPane               CommandType = "tmuxSplitPane"
	CommandTmuxNewWindow               CommandType = "tmuxNewWindow"
	CommandTmuxSelectWindow            CommandType = "tmuxSelectWindow"
	CommandTmuxResizePane              CommandType = "tmuxResizePane"
	CommandTmuxKillPane                CommandType = "tmuxKillPane"
	CommandTmuxKillWindow              CommandType = "tmuxKillWindow"
	CommandTmuxKillSession             CommandType = "tmuxKillSession"
	CommandTmuxRenameWindow            CommandType = "tmuxRenameWindow"
	CommandTmuxDetach                  CommandType = "tmuxDetach"
	CommandTmuxSelectPane              CommandType = "tmuxSelectPane"
	// CommandTmuxCommand는 렌더러 키맵이 만든 tmux 명령을 control 채널로 그대로
	// 보내는 범용 통로다(단축키 확장용). 명령 문자열은 고정 키맵에서만 생성된다.
	CommandTmuxCommand CommandType = "tmuxCommand"
)

const (
	EventStatus                         EventType = "status"
	EventConnected                      EventType = "connected"
	EventData                           EventType = "data"
	EventError                          EventType = "error"
	EventClosed                         EventType = "closed"
	EventLatency                        EventType = "latency"
	EventConnectionHopProgress          EventType = "connectionHopProgress"
	EventSerialPortsListed              EventType = "serialPortsListed"
	EventSerialControlCompleted         EventType = "serialControlCompleted"
	EventHostKeyProbed                  EventType = "hostKeyProbed"
	EventCertificateInspected           EventType = "certificateInspected"
	EventTailnetStatus                  EventType = "tailnetStatus"
	EventTailnetForgot                  EventType = "tailnetForgot"
	EventTailnetSnapshot                EventType = "tailnetSnapshot"
	EventTailnetForwardOpened           EventType = "tailnetForwardOpened"
	EventPrivateKeyGenerated            EventType = "privateKeyGenerated"
	EventPrivateKeyInspected            EventType = "privateKeyInspected"
	EventAuthorizedKeyInstalled         EventType = "authorizedKeyInstalled"
	EventKeyboardInteractiveChallenge   EventType = "keyboardInteractiveChallenge"
	EventKeyboardInteractiveResolved    EventType = "keyboardInteractiveResolved"
	EventPortForwardStarted             EventType = "portForwardStarted"
	EventPortForwardStopped             EventType = "portForwardStopped"
	EventPortForwardError               EventType = "portForwardError"
	EventSFTPConnected                  EventType = "sftpConnected"
	EventSFTPDisconnected               EventType = "sftpDisconnected"
	EventSFTPListed                     EventType = "sftpListed"
	EventSFTPFileRead                   EventType = "sftpFileRead"
	EventSFTPAck                        EventType = "sftpAck"
	EventSFTPError                      EventType = "sftpError"
	EventSFTPSudoStatus                 EventType = "sftpSudoStatus"
	EventSFTPPrincipalsListed           EventType = "sftpPrincipalsListed"
	EventSFTPTransferProgress           EventType = "sftpTransferProgress"
	EventSFTPTransferCompleted          EventType = "sftpTransferCompleted"
	EventSFTPTransferFailed             EventType = "sftpTransferFailed"
	EventSFTPTransferCancelled          EventType = "sftpTransferCancelled"
	EventContainersConnected            EventType = "containersConnected"
	EventContainersDisconnected         EventType = "containersDisconnected"
	EventContainersListed               EventType = "containersListed"
	EventContainersInspected            EventType = "containersInspected"
	EventContainersLogs                 EventType = "containersLogs"
	EventContainersActionCompleted      EventType = "containersActionCompleted"
	EventContainersStats                EventType = "containersStats"
	EventContainersLogsSearched         EventType = "containersLogsSearched"
	EventContainersError                EventType = "containersError"
	EventTerminalAutocompleteCapability EventType = "terminalAutocompleteCapability"
	EventTerminalAutocompleteSnapshot   EventType = "terminalAutocompleteSnapshot"
	EventTerminalAutocompleteShellState EventType = "terminalAutocompleteShellState"
	EventTerminalCompletionResult       EventType = "terminalCompletionResult"
	EventRunCommandResult               EventType = "runCommandResult"
	EventMoshState                      EventType = "moshState"
	EventAgentForwardingStatus          EventType = "agentForwardingStatus"
	EventTmuxLayoutChange               EventType = "tmuxLayoutChange"
	EventTmuxWindowAdd                  EventType = "tmuxWindowAdd"
	EventTmuxWindowClose                EventType = "tmuxWindowClose"
	EventTmuxWindowRenamed              EventType = "tmuxWindowRenamed"
	EventTmuxSessionChanged             EventType = "tmuxSessionChanged"
	EventTmuxSessionsChanged            EventType = "tmuxSessionsChanged"
	EventTmuxPaused                     EventType = "tmuxPaused"
	EventTmuxContinue                   EventType = "tmuxContinue"
	// EventTmuxActivePaneChanged는 %window-pane-changed(서버의 활성 pane 변경)를
	// renderer로 전달해, 키보드 pane 이동 등에서 화면 포커스가 따라오게 한다.
	EventTmuxActivePaneChanged EventType = "tmuxActivePaneChanged"
	EventTmuxExit              EventType = "tmuxExit"
	EventTmuxAvailable         EventType = "tmuxAvailable"
)

const (
	StreamTypeWrite StreamType = "write"
	StreamTypeData  StreamType = "data"
)

// tmux control mode 이벤트 payload들. control mode pane은 가상 sessionId
// "tmux:<controlSessionId>:<paneId>" 로 노출되고, 구조 변화(window/layout)는
// 아래 payload를 가진 control frame 이벤트로 상위 레이어에 전달된다.
type TmuxLayoutChangePayload struct {
	ControlSessionID string `json:"controlSessionId"`
	WindowID         string `json:"windowId"`
	Layout           string `json:"layout"`
	// 아래 셋은 list-windows 응답에서만 채워진다(실시간 %layout-change 엔 없음).
	// 비어 있으면 상위 레이어가 기존 값을 유지한다(merge).
	// Index 는 포인터다 — int+omitempty 면 윈도우 0(index=0)이 JSON 에서 누락돼
	// 렌더러에서 undefined 가 되고 Ctrl-b 0 매칭이 깨진다. nil=미제공 / &0=index 0.
	Index  *int   `json:"index,omitempty"`
	Name   string `json:"name,omitempty"`
	Active bool   `json:"active,omitempty"`
	// 현재 attach 된 tmux 세션명(%session-changed 로 추적). 세션 그룹 푸터를 호스트명
	// 대신 세션명으로 그리는 데 쓴다. 비어 있으면 상위가 기존 값을 유지한다.
	SessionName string `json:"sessionName,omitempty"`
}

type TmuxWindowPayload struct {
	ControlSessionID string `json:"controlSessionId"`
	WindowID         string `json:"windowId"`
	Name             string `json:"name,omitempty"`
}

type TmuxPanePayload struct {
	ControlSessionID string `json:"controlSessionId"`
	PaneID           string `json:"paneId"`
}

// TmuxSessionChangedPayload는 %session-changed 가 알려온 현재 attach 된 tmux 세션
// 이름이다. attach 직후·세션 전환 시 발생하며, renderer 가 세션 그룹 푸터의
// 세션명(호스트명이 아니라 실제 tmux 세션명)을 갱신하는 데 쓴다.
type TmuxSessionChangedPayload struct {
	ControlSessionID string `json:"controlSessionId"`
	SessionName      string `json:"sessionName"`
}

type TmuxExitPayload struct {
	ControlSessionID string `json:"controlSessionId"`
	Reason           string `json:"reason,omitempty"`
}

// TmuxAvailablePayload는 SSH 접속 후 보조채널(별도 exec)로 감지한 원격 tmux 정보다.
// tmux 미설치면 이 이벤트 자체가 발생하지 않는다. control mode 진입(attach) 전에
// 하단바로 "tmux 세션 N개"를 표시하고 attach 진입점을 제공하는 데 쓴다.
type TmuxAvailablePayload struct {
	Version  string            `json:"version"`
	Sessions []TmuxSessionInfo `json:"sessions,omitempty"`
}

// TmuxSessionInfo는 원격 tmux 의 한 세션 요약이다(list-sessions 한 줄).
type TmuxSessionInfo struct {
	Name     string `json:"name"`
	Windows  int    `json:"windows"`
	Attached bool   `json:"attached"`
}

// TmuxSplitPanePayload는 분할 방향("h": 좌우, "v": 상하)을 나른다.
type TmuxSplitPanePayload struct {
	Direction string `json:"direction"`
}

// TmuxSelectWindowPayload는 전환할 window id(@N)를 나른다.
type TmuxSelectWindowPayload struct {
	WindowID string `json:"windowId"`
}

// TmuxKillWindowPayload는 종료할 window id(@N)를 나른다.
type TmuxKillWindowPayload struct {
	WindowID string `json:"windowId"`
}

// TmuxKillSessionPayload는 종료할 tmux 세션 이름을 나른다(kill-session -t <name>).
type TmuxKillSessionPayload struct {
	SessionName string `json:"sessionName"`
}

// TmuxRenameWindowPayload는 이름을 바꿀 window id(@N)와 새 이름을 나른다.
type TmuxRenameWindowPayload struct {
	WindowID string `json:"windowId"`
	Name     string `json:"name"`
}

// TmuxCommandPayload는 control 채널로 그대로 보낼 tmux 명령 한 줄을 나른다.
type TmuxCommandPayload struct {
	Command string `json:"command"`
}

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

// JumpTarget describes a bastion/jump host to tunnel a connection through
// (ProxyJump / `ssh -J`). It carries the same SSH connection + credential fields
// as a primary target; the desktop resolver fills these from the referenced
// saved host. Jump is recursive so multi-hop chains are representable, although
// the current UI configures only a single hop.
type JumpTarget struct {
	Host                  string      `json:"host"`
	Port                  int         `json:"port"`
	Username              string      `json:"username"`
	AuthType              string      `json:"authType"`
	Password              string      `json:"password,omitempty"`
	PrivateKeyPEM         string      `json:"privateKeyPem,omitempty"`
	CertificateText       string      `json:"certificateText,omitempty"`
	Passphrase            string      `json:"passphrase,omitempty"`
	TrustedHostKeyBase64  string      `json:"trustedHostKeyBase64,omitempty"`
	TrustedHostKeysBase64 []string    `json:"trustedHostKeysBase64,omitempty"`
	Jump                  *JumpTarget `json:"jump,omitempty"`
}

// WSProxyTarget routes the raw SSH transport through a WebSocket to sync-api
// instead of dialing the target host directly. Used for server-proxy (bastion)
// mode in IP-restricted VPCs: sync-api holds the AWS-facing socket, opens the SSM
// port-forward to the instance, and relays raw TCP over the WebSocket. ssh-core
// then speaks plain SSH over it, so shell/tmux/sftp/forwarding all work unchanged
// above the transport. StartMessage is an opaque JSON blob (AWS creds, instanceId,
// EIC public key, ...) that ssh-core forwards verbatim as the first frame, so
// ssh-core stays AWS-agnostic on this path. When set, Jump is ignored — the proxy
// itself is the path.
type WSProxyTarget struct {
	URL          string          `json:"url"`
	AuthToken    string          `json:"authToken,omitempty"`
	StartMessage json.RawMessage `json:"startMessage,omitempty"`
}

type EnvVar struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type ConnectPayload struct {
	Host                        string         `json:"host"`
	Port                        int            `json:"port"`
	Username                    string         `json:"username"`
	AuthType                    string         `json:"authType"`
	Password                    string         `json:"password,omitempty"`
	PrivateKeyPEM               string         `json:"privateKeyPem,omitempty"`
	CertificateText             string         `json:"certificateText,omitempty"`
	Passphrase                  string         `json:"passphrase,omitempty"`
	TrustedHostKeyBase64        string         `json:"trustedHostKeyBase64"`
	TrustedHostKeysBase64       []string       `json:"trustedHostKeysBase64,omitempty"`
	Jump                        *JumpTarget    `json:"jump,omitempty"`
	WSProxy                     *WSProxyTarget `json:"wsProxy,omitempty"`
	Cols                        int            `json:"cols"`
	Rows                        int            `json:"rows"`
	Command                     string         `json:"command,omitempty"`
	Env                         []EnvVar       `json:"env,omitempty"`
	AgentForwarding             bool           `json:"agentForwarding,omitempty"`
	AgentForwardingEndpointKind string         `json:"agentForwardingEndpointKind,omitempty"`
	AgentForwardingEndpoint     string         `json:"agentForwardingEndpoint,omitempty"`
	// AuthType이 "agent"일 때 서명을 위임할 로컬 ssh-agent 소켓/파이프(포워딩과 별개).
	AuthAgentEndpointKind string `json:"authAgentEndpointKind,omitempty"`
	AuthAgentEndpoint     string `json:"authAgentEndpoint,omitempty"`
	// TailnetID 가 있으면 그 tailnet 을 경유해 붙는다. 비면 일반 네트워크로 직접 붙는다.
	TailnetID string `json:"tailnetId,omitempty"`
	// TailnetName 은 설정에 박아 둔 tailnet 이름이다. 실제로 붙은 곳과 다르면 연결을
	// 거부한다 — 다른 계정으로 로그인해 엉뚱한 tailnet 의 동명 머신에 붙는 것을 막는다.
	TailnetName string `json:"tailnetName,omitempty"`
	// UseMosh가 true면 SSH 대신 mosh(UDP)로 연결한다. SSH는 mosh-server 부트스트랩에만
	// 쓰이고 이후 통신은 mosh SSP다. jump host와는 상호 배타(데스크톱 UI에서 차단).
	UseMosh bool `json:"useMosh,omitempty"`
	// TmuxVersion은 tmux control mode(tmuxConnect) 연결 시 데스크톱이 보조채널로 감지한
	// 원격 tmux 버전 문자열("3.0a","2.6" 등)이다. Go runtime 이 입력 인코딩(-H vs -l+키이름)
	// 과 refresh-client 인자 방언(콤마 vs WxH)을 버전별로 분기하는 데 쓴다. 비어 있으면
	// 미상으로 보고 안전 기본(최신 가정: -H + 콤마)을 쓴다. 일반 SSH 연결엔 무의미.
	TmuxVersion string `json:"tmuxVersion,omitempty"`
}

type AgentForwardingStatusPayload struct {
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

type AWSConnectPayload struct {
	ProfileName string            `json:"profileName"`
	Region      string            `json:"region"`
	InstanceID  string            `json:"instanceId"`
	Cols        int               `json:"cols"`
	Rows        int               `json:"rows"`
	Env         map[string]string `json:"env,omitempty"`
	UnsetEnv    []string          `json:"unsetEnv,omitempty"`
	// In-process SSM data channel: when StreamURL and TokenValue are both set
	// (issued by the Electron main process via ssm:StartSession), ssh-core opens
	// the SSM WebSocket itself instead of spawning aws + session-manager-plugin.
	StreamURL    string `json:"streamUrl,omitempty"`
	TokenValue   string `json:"tokenValue,omitempty"`
	SsmSessionID string `json:"ssmSessionId,omitempty"`
	// ShellKind names the shell the SSM session lands in ("powershell" on Windows
	// instances). Empty means a POSIX shell, which is what SSM opens on Linux.
	// It decides whether the shell-integration script can be typed in at all --
	// see beginShellIntegration in internal/awssession.
	ShellKind string `json:"shellKind,omitempty"`
}

type LocalConnectPayload struct {
	Cols             int               `json:"cols"`
	Rows             int               `json:"rows"`
	Title            string            `json:"title,omitempty"`
	ShellKind        string            `json:"shellKind,omitempty"`
	Executable       string            `json:"executable,omitempty"`
	Args             []string          `json:"args,omitempty"`
	Env              map[string]string `json:"env,omitempty"`
	UnsetEnv         []string          `json:"unsetEnv,omitempty"`
	WorkingDirectory string            `json:"workingDirectory,omitempty"`
}

type TerminalAutocompleteExecutable struct {
	Name string `json:"name"`
	Path string `json:"path,omitempty"`
}

type TerminalAutocompleteCapabilityPayload struct {
	Status     string   `json:"status"`
	Shell      string   `json:"shell,omitempty"`
	Sources    []string `json:"sources"`
	ReasonCode string   `json:"reasonCode,omitempty"`
}

type TerminalAutocompleteSnapshotPayload struct {
	Shell       string                           `json:"shell"`
	Revision    int                              `json:"revision"`
	History     []string                         `json:"history"`
	Executables []TerminalAutocompleteExecutable `json:"executables"`
	Truncated   bool                             `json:"truncated"`
}

type TerminalAutocompleteShellStatePayload struct {
	Kind    string `json:"kind"`
	Shell   string `json:"shell,omitempty"`
	Cwd     string `json:"cwd,omitempty"`
	Command string `json:"command,omitempty"`
}

// TerminalCompletionQueryPayload asks the host to run a short read-only command
// (built by the renderer) over the auxiliary channel for dynamic completion.
type TerminalCompletionQueryPayload struct {
	Command string `json:"command"`
}

type TerminalCompletionResultPayload struct {
	Stdout    string `json:"stdout"`
	Truncated bool   `json:"truncated,omitempty"`
}

// RunCommandPayload asks the host to run an arbitrary command on a separate exec
// channel (not the interactive PTY) and return its output. Used by the AI
// assistant's run_command tool. Distinct from TerminalCompletionQueryPayload: it
// surfaces stderr and the remote exit code, not just capped stdout.
type RunCommandPayload struct {
	Command   string `json:"command"`
	TimeoutMs int    `json:"timeoutMs,omitempty"`
}

// RunCommandResultPayload is the result of a RunCommandPayload. ExitCode is the
// remote command's exit status (0 on success; -1 when the exec itself could not
// run). Error is set only when the command could not be executed at all (session
// gone, unsupported session type, timeout) — never for a mere non-zero exit.
type RunCommandResultPayload struct {
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	ExitCode  int    `json:"exitCode"`
	Truncated bool   `json:"truncated,omitempty"`
	Error     string `json:"error,omitempty"`
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
	Host                  string         `json:"host"`
	Port                  int            `json:"port"`
	Username              string         `json:"username"`
	AuthType              string         `json:"authType"`
	Password              string         `json:"password,omitempty"`
	PrivateKeyPEM         string         `json:"privateKeyPem,omitempty"`
	CertificateText       string         `json:"certificateText,omitempty"`
	Passphrase            string         `json:"passphrase,omitempty"`
	TrustedHostKeyBase64  string         `json:"trustedHostKeyBase64"`
	TrustedHostKeysBase64 []string       `json:"trustedHostKeysBase64,omitempty"`
	Jump                  *JumpTarget    `json:"jump,omitempty"`
	WSProxy               *WSProxyTarget `json:"wsProxy,omitempty"`
	// AuthType이 "agent"일 때 서명을 위임할 로컬 ssh-agent 소켓/파이프.
	AuthAgentEndpointKind string `json:"authAgentEndpointKind,omitempty"`
	AuthAgentEndpoint     string `json:"authAgentEndpoint,omitempty"`
	// TailnetID 가 있으면 그 tailnet 을 경유해 붙는다. TailnetName 은 설정에 박아 둔 이름으로,
	// 실제로 붙은 곳과 다르면 코어가 연결을 거부한다.
	TailnetID   string `json:"tailnetId,omitempty"`
	TailnetName string `json:"tailnetName,omitempty"`
}

type ContainersConnectPayload struct {
	Host                  string         `json:"host"`
	Port                  int            `json:"port"`
	Username              string         `json:"username"`
	AuthType              string         `json:"authType"`
	Password              string         `json:"password,omitempty"`
	PrivateKeyPEM         string         `json:"privateKeyPem,omitempty"`
	CertificateText       string         `json:"certificateText,omitempty"`
	Passphrase            string         `json:"passphrase,omitempty"`
	TrustedHostKeyBase64  string         `json:"trustedHostKeyBase64"`
	TrustedHostKeysBase64 []string       `json:"trustedHostKeysBase64,omitempty"`
	Jump                  *JumpTarget    `json:"jump,omitempty"`
	WSProxy               *WSProxyTarget `json:"wsProxy,omitempty"`
	// AuthType이 "agent"일 때 서명을 위임할 로컬 ssh-agent 소켓/파이프.
	AuthAgentEndpointKind string `json:"authAgentEndpointKind,omitempty"`
	AuthAgentEndpoint     string `json:"authAgentEndpoint,omitempty"`
	// TailnetID 가 있으면 그 tailnet 을 경유해 붙는다. TailnetName 은 설정에 박아 둔 이름으로,
	// 실제로 붙은 곳과 다르면 코어가 연결을 거부한다.
	TailnetID   string `json:"tailnetId,omitempty"`
	TailnetName string `json:"tailnetName,omitempty"`
}

// TailnetConfigPayload 는 tailnet 노드를 어떻게 등록할지다. 컨트롤 플레인(서버)과 인증
// 방식은 직교한다 — 어느 서버든 auth key 와 브라우저 로그인 둘 다 쓸 수 있다.
type TailnetConfigPayload struct {
	ID string `json:"id"`
	// Hostname 은 tailnet 디바이스 목록에 보일 이름이다.
	Hostname string `json:"hostname,omitempty"`
	// ControlURL 이 비면 Tailscale, 채우면 Headscale 같은 다른 컨트롤 플레인이다.
	ControlURL string `json:"controlUrl,omitempty"`
	// AuthKey 가 있으면 브라우저 없이 등록한다. 비면 대화형 로그인으로 간다.
	AuthKey string `json:"authKey,omitempty"`
	// Ephemeral 은 활동이 멈추면 노드를 지우도록 요청한다. 컨트롤 플레인이 최종 판단하며,
	// Headscale 의 OIDC 경로는 이를 무시하는 알려진 버그가 있다.
	Ephemeral bool `json:"ephemeral,omitempty"`
}

// TailnetTestPayload 는 연결 테스트 요청이다. 노드를 올려 Running 까지 가는지 확인하고,
// 그 과정을 EventTailnetStatus 로 흘려보낸다.
type TailnetTestPayload struct {
	Config TailnetConfigPayload `json:"config"`
	// TimeoutMs 가 0 이면 기본값을 쓴다. 브라우저 로그인은 사람이 개입하므로 auth key
	// 경로보다 넉넉해야 한다.
	TimeoutMs int `json:"timeoutMs,omitempty"`
}

type TailnetForgetPayload struct {
	ID string `json:"id"`
}

// TailnetConfigurePayload 는 이 기기에 등록된 tailnet 설정 전체다.
//
// 코어가 설정을 알아야 노드를 만들 수 있다. 이것이 없으면 설정 화면에서 연결 테스트를 한
// tailnet 만 쓸 수 있고, 앱을 다시 켜면 그것도 잊는다 — 호스트 연결이 "is not configured"
// 로 실패한다. 그래서 코어가 뜰 때와 설정이 바뀔 때 전체를 밀어 넣는다.
//
// 목록에 없는 id 의 설정은 지운다. 삭제를 따로 통보하지 않아도 되고, 코어의 상태가 항상
// 데스크톱의 상태와 같아진다.
type TailnetConfigurePayload struct {
	Configs []TailnetConfigPayload `json:"configs"`
}

// TailnetStatusPayload 는 노드가 올라오는 동안 여러 번 방출된다. AuthURL 이 채워지면
// 사용자가 브라우저에서 인가해야 한다는 뜻이다.
type TailnetStatusPayload struct {
	ID      string `json:"id"`
	State   string `json:"state"`
	AuthURL string `json:"authUrl,omitempty"`
	Error   string `json:"error,omitempty"`

	// 아래는 붙은 뒤에만 채워진다. Tailscale 기본 서버로 여러 개를 등록하면 설정이 전부
	// 같아서 화면에서 구분할 수 없다 — 누구로 어디에 붙었는지가 유일한 단서다.
	LoginName   string `json:"loginName,omitempty"`
	TailnetName string `json:"tailnetName,omitempty"`
	NodeName    string `json:"nodeName,omitempty"`
	NodeIP      string `json:"nodeIp,omitempty"`
	// Expired 는 노드 키가 만료됐는지다. State 가 running 이어도 true 일 수 있다 — 컨트롤
	// 플레인에서 노드를 만료시켜도 백엔드는 한동안 Running 으로 남는다.
	Expired bool `json:"expired,omitempty"`
	// Health 는 백엔드가 스스로 보고하는 문제들이다. State 가 정상으로 보이는데 통신이 안 될
	// 때 유일하게 남는 단서다 — tailscale 은 로그아웃·로그인 오류·동기화 실패를 여기에 담는다.
	Health []string `json:"health,omitempty"`
	// Ready 는 이 tailnet 을 통해 **확실히** 통신할 수 있는지다. 판정은 코어 한 곳에서만 하고,
	// 화면은 다시 판단하지 않는다 — 곳곳에서 각자 판단하면 기준이 갈린다.
	Ready bool `json:"ready,omitempty"`
	// Authorized 는 등록과 로그인이 끝났는지다(컨트롤 플레인이 인가했고 만료되지 않았다).
	//
	// Ready 와 따로 있어야 하는 이유: 이 둘은 다른 질문인데 하나로 답하면 동기화만 끊긴 상태에서
	// 이미 끝난 등록·로그인 단계가 화면에서 "아직 안 됨" 으로 되돌아간다 — 그 아래 단계에는 체크가
	// 떠 있어서 순서가 뒤바뀐 것처럼 보인다.
	Authorized bool `json:"authorized,omitempty"`
	// IdentityInvalid 는 컨트롤 플레인이 현재 노드 identity 를 더 이상 모른다고 확정했는지다.
	// 일반적인 동기화 중단과 달리 자동 재등록을 시작할 수 있는 신호다.
	IdentityInvalid bool `json:"identityInvalid,omitempty"`
	// Online 은 컨트롤 플레인과 세션이 살아 있는지다(map poll 이 열려 있는지). Ready 의 근거이자,
	// 상태가 정상으로 보이는데 통신이 안 되는 경우를 설명하는 값이다.
	Online bool `json:"online,omitempty"`
	// Degraded 는 컨트롤 플레인과 동기화가 끊긴 채로 관문이 통과시켰다는 표시다.
	//
	// Ready 가 아닌데도 진행하기로 한 결정이므로 그 사실이 밖으로 나가야 한다. 기다리는 쪽은 이
	// 값으로 끝을 알고(없으면 한도까지 매달린다), 화면은 동기화 단계를 경고로 그린다.
	Degraded bool `json:"degraded,omitempty"`
	// BackendState 는 tsnet 이 보고한 원문 상태, KeyExpiry 는 노드 키 만료 시각이다.
	// 무엇을 보고 그렇게 판단했는지 화면에서 확인할 수 있어야 한다.
	BackendState string `json:"backendState,omitempty"`
	KeyExpiry    string `json:"keyExpiry,omitempty"`
	// Cancelled 는 사용자가 시도를 접어서 끝났다는 표시다. 실패가 아니므로 Error 는 비어
	// 있는데, Stopped 는 노드가 올라오기 전 진행 상태로도 나가기 때문에 상태만으로는 시도가
	// 끝났는지 알 수 없다. 요청을 기다리는 쪽은 이 표시로 끝을 안다.
	Cancelled bool `json:"cancelled,omitempty"`
	// Attempting 은 지금 이 tailnet 을 올리는 시도가 실제로 돌고 있는지다.
	//
	// 상태만으로는 알 수 없다 — 인증이 필요한 노드는 아무도 손대지 않아도 계속 needsAuth 로
	// 보고된다. 그것을 진행 중으로 그리면 화면이 거짓 진행을 보여준다(스피너와 "링크를 받는
	// 중" 이 뜨는데 실제로는 아무 일도 일어나지 않고, 취소할 대상도 없다).
	Attempting bool `json:"attempting,omitempty"`
	// Restarts 는 인증 링크를 받으려고 이 시도가 노드를 다시 세운 횟수, RestartRefused 는
	// 마지막 시도가 거절됐는지다(이 tailnet 을 쓰던 것이 아직 정리되지 않았다는 뜻이다).
	//
	// 코어가 한 일은 전부 상태로 나가야 한다. 이 두 값이 없으면 노드를 새로 세워도 화면에서는
	// 아무 일도 없는 것과 구분되지 않는다 — 닫는 데 0.0 초가 걸리고 전후 상태가 동일해서
	// 중복 제거가 이벤트를 버린다.
	Restarts       int  `json:"restarts,omitempty"`
	RestartRefused bool `json:"restartRefused,omitempty"`
	// ReRegistrations 는 삭제된 identity 를 버리고 새 identity 로 등록을 시작한 횟수다.
	ReRegistrations int `json:"reRegistrations,omitempty"`
	// LoginError 는 백엔드가 확정한 로그인 실패 이유다(잘못된 auth key 등).
	//
	// 이 값이 있으면 기다려서 풀리는 상태가 아니다 — 설정을 고쳐야 한다. 상태만으로는 링크를
	// 기다리는 것과 구분되지 않아서, 이것 없이는 화면이 "링크를 받는 중" 을 계속 그린다.
	LoginError string `json:"loginError,omitempty"`
	// BackendError 는 백엔드가 마지막으로 보고한 오류다(IPN 버스의 ErrMessage). 컨트롤 플레인이
	// 요청을 거부한 이유가 이 경로로만 오는 경우가 있어서, 없으면 화면이 이유를 말할 수 없다.
	BackendError string `json:"backendError,omitempty"`

	// Peers 는 이 tailnet 안에서 보이는 기기들과 그 경로다. 붙어 있지 않으면 빈 목록이다.
	Peers []TailnetPeerPayload `json:"peers,omitempty"`
}

// TailnetPeerPayload 는 이 tailnet 안의 기기 하나와, 그 기기까지 지금 어떤 경로로 가는지다.
//
// 경로를 노출하는 이유: 유저스페이스 노드는 붙은 직후 릴레이로 시작해 홀펀칭이 되면 직결로
// 승격한다. "느리다"가 릴레이 때문인지 다른 이유인지는 이 값 없이는 추측밖에 안 된다.
//
// 이름을 셋 다 실어 보낸다. 호스트 레코드의 주소가 MagicDNS 짧은 이름일 수도, FQDN 일 수도,
// tailnet IP 일 수도 있어서 어느 것으로든 맞출 수 있어야 한다.
type TailnetPeerPayload struct {
	// HostName 은 기기의 짧은 이름, DNSName 은 FQDN(끝점 제거됨)이다.
	HostName string   `json:"hostName,omitempty"`
	DNSName  string   `json:"dnsName,omitempty"`
	IPs      []string `json:"ips,omitempty"`
	// Direct 는 직결 경로가 서 있는지다. false 면 릴레이를 거친다.
	Direct bool `json:"direct"`
	// Relay 는 이 기기와 통신에 쓰는 DERP 지역이다. Direct 여도 폴백 경로로 남아 있어
	// 채워질 수 있다.
	Relay string `json:"relay,omitempty"`
	// Routes 는 이 기기가 서브넷 라우터로서 담당하는 대역(CIDR)이다. tailscale 이 깔려
	// 있지 않은 호스트는 이 대역을 통해 닿으므로, 그 호스트의 경로를 말하려면 필요하다.
	Routes []string `json:"routes,omitempty"`
	// RxBytes·TxBytes 는 이 노드가 만들어진 뒤의 누적치다. 경로가 실제로 쓰이고 있는지를
	// 구분하는 단서다 — 0 이면 아직 이 기기와 주고받은 것이 없다.
	RxBytes int64 `json:"rxBytes,omitempty"`
	TxBytes int64 `json:"txBytes,omitempty"`
}

type TailnetForgotPayload struct {
	ID    string `json:"id"`
	Error string `json:"error,omitempty"`
}

// TailnetDisconnectPayload 는 노드를 지금 내리라는 요청이다. 등록은 남으므로 다시 쓰면
// 재인증 없이 올라온다.
type TailnetDisconnectPayload struct {
	ID string `json:"id"`
}

// TailnetForwardOpenPayload 는 tailnet 안의 한 곳으로 이어 줄 로컬 포워드를 여는 요청이다.
//
// RDP 코어는 Rust 라서 tsnet 을 쓸 수 없다. 여기서 로컬 주소를 만들어 주면 그쪽은 평범한 TCP 로
// 붙기만 하면 된다.
type TailnetForwardOpenPayload struct {
	// ID 는 이 포워드를 가리키는 이름이다(RDP 는 세션 id). 같은 id 로 다시 열면 앞의 것을 닫는다.
	ID string `json:"id"`
	// TailnetID 는 어느 tailnet 으로 보낼지다.
	TailnetID string `json:"tailnetId"`
	// TailnetName 은 설정에 박아 둔 tailnet 이름이다. 다르면 연결을 거부한다.
	TailnetName string `json:"tailnetName,omitempty"`
	// Host·Port 는 tailnet 안의 대상이다.
	Host string `json:"host"`
	Port int    `json:"port"`
}

type TailnetForwardClosePayload struct {
	ID string `json:"id"`
}

// TailnetForwardOpenedPayload 는 열린 포워드의 로컬 주소다. 붙는 쪽은 이 주소로 TCP 를 연다.
type TailnetForwardOpenedPayload struct {
	ID string `json:"id"`
	// Address 는 항상 루프백이다(`127.0.0.1:<port>`).
	Address string `json:"address"`
}

// TailnetSnapshotPayload 는 지금 살아 있는 노드들의 상태다.
//
// 여기 없는 tailnet 은 노드가 없다는 뜻이고 그것 자체가 "연결 안 됨"이다. 화면을 여는 것
// 만으로 노드를 올리지 않기 위해, 없는 것을 위해 노드를 만들지는 않는다.
type TailnetSnapshotPayload struct {
	Statuses []TailnetStatusPayload `json:"statuses"`
	// LocalNodeName 은 이 기기가 tailnet 에 등록할 때 쓰는 이름이다. 붙어 있지 않아도
	// 알 수 있어야 한다 — 사용자가 기기 목록에서 자기 기기를 찾는 단서다.
	LocalNodeName string `json:"localNodeName,omitempty"`
}

type HostKeyProbePayload struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	// Jump이 설정되면 그 베스천을 경유해 타깃 호스트 키를 읽는다(베스천 뒤의 타깃 TOFU).
	Jump *JumpTarget `json:"jump,omitempty"`
	// SessionID/EndpointID는 renderer가 넘기는 상관 ID로, 프로브 중 방출하는 홉 진행
	// (ConnectionHopProgressPayload)을 해당 연결의 오버레이에 매핑하는 데 쓴다.
	SessionID  string `json:"sessionId,omitempty"`
	EndpointID string `json:"endpointId,omitempty"`
	// WSProxy가 설정되면 직접 TCP dial 대신 sync-api WebSocket으로 전송을 라우팅해
	// 호스트 키를 읽는다(서버 프록시/bastion — IP 제한 VPC에서 probe도 서버 IP 경유).
	WSProxy *WSProxyTarget `json:"wsProxy,omitempty"`
	// 프로브도 연결과 같은 통로로 가야 한다. 안 그러면 tailnet 안에만 있는 호스트의 키를
	// 읽을 수 없고, 읽더라도 tailnet 밖의 동명 호스트 키를 읽어 잘못 신뢰하게 된다.
	TailnetID   string `json:"tailnetId,omitempty"`
	TailnetName string `json:"tailnetName,omitempty"`
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

type PrivateKeyInspectPayload struct {
	PrivateKeyPEM string `json:"privateKeyPem"`
	Passphrase    string `json:"passphrase,omitempty"`
}

type PrivateKeyGeneratePayload struct {
	Algorithm        string `json:"algorithm,omitempty"`
	Curve            string `json:"curve,omitempty"`
	RSABits          int    `json:"rsaBits,omitempty"`
	PrivateKeyCipher string `json:"privateKeyCipher,omitempty"`
	KDFRounds        int    `json:"kdfRounds,omitempty"`
	Comment          string `json:"comment,omitempty"`
	Passphrase       string `json:"passphrase,omitempty"`
}

type PrivateKeyGeneratedPayload struct {
	Algorithm           string `json:"algorithm"`
	PrivateKeyPEM       string `json:"privateKeyPem"`
	PublicKey           string `json:"publicKey"`
	FingerprintSHA256   string `json:"fingerprintSha256"`
	PrivateKeyEncrypted bool   `json:"privateKeyEncrypted"`
	KeyCurve            string `json:"keyCurve,omitempty"`
	KeyBits             int    `json:"keyBits,omitempty"`
	PrivateKeyCipher    string `json:"privateKeyCipher,omitempty"`
	PrivateKeyKDFRounds int    `json:"privateKeyKdfRounds,omitempty"`
}

type PrivateKeyInspectedPayload struct {
	Algorithm         string `json:"algorithm"`
	PublicKey         string `json:"publicKey"`
	FingerprintSHA256 string `json:"fingerprintSha256"`
}

type AuthorizedKeyInstallPayload struct {
	ConnectPayload
	PublicKey string `json:"publicKey"`
}

type AuthorizedKeyInstalledPayload struct {
	Status string `json:"status"`
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

type SFTPReadFilePayload struct {
	Path string `json:"path"`
}

type SFTPWriteFilePayload struct {
	Path          string `json:"path"`
	Content       string `json:"content"`
	Mode          int    `json:"mode"`
	PreserveMtime bool   `json:"preserveMtime,omitempty"`
	ExpectedSize  *int64 `json:"expectedSize,omitempty"`
	ExpectedMtime string `json:"expectedMtime,omitempty"`
	SudoPassword  string `json:"sudoPassword,omitempty"`
	Force         bool   `json:"force,omitempty"`
}

type ContainersInspectPayload struct {
	ContainerID string `json:"containerId"`
}

type ContainersLogsPayload struct {
	ContainerID  string `json:"containerId"`
	Tail         int    `json:"tail"`
	FollowCursor string `json:"followCursor,omitempty"`
	StartTime    string `json:"startTime,omitempty"`
	EndTime      string `json:"endTime,omitempty"`
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
	StartTime   string `json:"startTime,omitempty"`
	EndTime     string `json:"endTime,omitempty"`
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
	PreserveMetadata   TransferMetadataPayload `json:"preserveMetadata,omitempty"`
	RetryOfJobID       string                  `json:"retryOfJobId,omitempty"`
}

type TransferMetadataPayload struct {
	Mtime       *bool `json:"mtime,omitempty"`
	Permissions *bool `json:"permissions,omitempty"`
}

type TransferFailedItemPayload struct {
	Item           TransferItemPayload `json:"item"`
	ErrorMessage   string              `json:"errorMessage"`
	ErrorCode      string              `json:"errorCode,omitempty"`
	ErrorOperation string              `json:"errorOperation,omitempty"`
	ErrorPath      string              `json:"errorPath,omitempty"`
}

type PortForwardStartPayload struct {
	Host                  string         `json:"host"`
	Port                  int            `json:"port"`
	Username              string         `json:"username"`
	AuthType              string         `json:"authType"`
	Password              string         `json:"password,omitempty"`
	PrivateKeyPEM         string         `json:"privateKeyPem,omitempty"`
	CertificateText       string         `json:"certificateText,omitempty"`
	Passphrase            string         `json:"passphrase,omitempty"`
	TrustedHostKeyBase64  string         `json:"trustedHostKeyBase64"`
	TrustedHostKeysBase64 []string       `json:"trustedHostKeysBase64,omitempty"`
	Jump                  *JumpTarget    `json:"jump,omitempty"`
	WSProxy               *WSProxyTarget `json:"wsProxy,omitempty"`
	AuthAgentEndpointKind string         `json:"authAgentEndpointKind,omitempty"`
	AuthAgentEndpoint     string         `json:"authAgentEndpoint,omitempty"`
	Mode                  string         `json:"mode"`
	BindAddress           string         `json:"bindAddress"`
	BindPort              int            `json:"bindPort"`
	TargetHost            string         `json:"targetHost,omitempty"`
	TargetPort            int            `json:"targetPort,omitempty"`
	SourceEndpointID      string         `json:"sourceEndpointId,omitempty"`
	// TailnetID 가 있으면 그 tailnet 을 경유해 붙는다. TailnetName 은 설정에 박아 둔 이름으로,
	// 실제로 붙은 곳과 다르면 코어가 연결을 거부한다.
	TailnetID   string `json:"tailnetId,omitempty"`
	TailnetName string `json:"tailnetName,omitempty"`
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
	// In-process SSM data channel: when StreamURL and TokenValue are both set
	// (issued by the Electron main process via ssm:StartSession with a
	// port-forwarding document), ssh-core opens the SSM WebSocket itself instead
	// of spawning aws + session-manager-plugin.
	StreamURL    string `json:"streamUrl,omitempty"`
	TokenValue   string `json:"tokenValue,omitempty"`
	SsmSessionID string `json:"ssmSessionId,omitempty"`
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
	// Reason는 종료 유형을 구분한다: "remote-exit"(원격 셸 정상 종료),
	// "transport"(전송 단절), "keepalive"(keepalive 연속 실패), "client"(클라이언트 요청).
	// 자동 재연결 판단에서 정상 종료(exit)를 되살리지 않도록 하는 데 쓰인다.
	Reason string `json:"reason,omitempty"`
}

// MoshStatePayload는 mosh 세션의 연결 상태 변화를 renderer에 알린다. State는
// "connected"|"reconnecting"|"disconnected" 중 하나다. LastResponseAt은 마지막으로
// 서버 응답(SSP)을 받은 시각(RFC3339)으로, UI가 "N초 전 응답"을 표시하는 데 쓴다.
type MoshStatePayload struct {
	State          string `json:"state"`
	LastResponseAt string `json:"lastResponseAt,omitempty"`
}

// LatencyPayload는 keepalive probe의 round-trip 시간(ms)을 renderer에 알린다. 탭
// 인디케이터가 활성 탭에 RTT를 표시하는 데 쓴다. keepalive 주기(기본 10s)마다 갱신.
type LatencyPayload struct {
	RoundTripMs int `json:"roundTripMs"`
}

// ConnectionHopProgressPayload는 다단 ProxyJump 연결 중 각 홉의 진행 상태를 renderer에 알린다.
// HopIndex는 1-based(가장 깊은 점프=1 … 최종 대상=HopCount). Stage는 connecting|connected|failed.
// SessionID/EndpointID 중 세팅된 쪽으로 renderer가 해당 연결(터미널 탭·SFTP pane·컨테이너 등)에
// 매핑한다 — 세션·SFTP·컨테이너·포트포워딩·호스트키 probe가 하나의 공통 오버레이를 공유한다.
type ConnectionHopProgressPayload struct {
	SessionID  string `json:"sessionId,omitempty"`
	EndpointID string `json:"endpointId,omitempty"`
	HopLabel   string `json:"hopLabel"`
	HopIndex   int    `json:"hopIndex"`
	HopCount   int    `json:"hopCount"`
	Stage      string `json:"stage"`
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

type SFTPFileReadPayload struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Size    int64  `json:"size"`
	Mtime   string `json:"mtime"`
	Mode    int    `json:"mode"`
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
	Status              string                      `json:"status"`
	BytesTotal          int64                       `json:"bytesTotal"`
	BytesCompleted      int64                       `json:"bytesCompleted"`
	CompletedItemCount  int                         `json:"completedItemCount,omitempty"`
	FailedItemCount     int                         `json:"failedItemCount,omitempty"`
	ActiveItemName      string                      `json:"activeItemName,omitempty"`
	SpeedBytesPerSecond float64                     `json:"speedBytesPerSecond,omitempty"`
	ETASeconds          int64                       `json:"etaSeconds,omitempty"`
	Message             string                      `json:"message,omitempty"`
	ErrorCode           string                      `json:"errorCode,omitempty"`
	ErrorOperation      string                      `json:"errorOperation,omitempty"`
	ErrorPath           string                      `json:"errorPath,omitempty"`
	ErrorItemName       string                      `json:"errorItemName,omitempty"`
	DetailMessage       string                      `json:"detailMessage,omitempty"`
	PartialPath         string                      `json:"partialPath,omitempty"`
	FailedItems         []TransferFailedItemPayload `json:"failedItems,omitempty"`
}

type RawPayload = json.RawMessage
