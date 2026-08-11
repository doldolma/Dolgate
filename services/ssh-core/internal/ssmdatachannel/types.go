package ssmdatachannel

import (
	"encoding/json"
	"time"
)

// MessageType is the label used in the AgentMessage.MessageType field
// REF: https://github.com/aws/amazon-ssm-agent/blob/master/agent/session/contracts/model.go.
type MessageType string

const (
	InteractiveShell MessageType = "interactive_shell"
	TaskReply        MessageType = "agent_task_reply"
	TaskComplete     MessageType = "agent_task_complete"
	Acknowledge      MessageType = "acknowledge"
	AgentSession     MessageType = "agent_session_state"
	ChannelClosed    MessageType = "channel_closed"
	OutputStreamData MessageType = "output_stream_data"
	InputStreamData  MessageType = "input_stream_data"
	PausePublication MessageType = "pause_publication"
	StartPublication MessageType = "start_publication"
)

// AgentMessageFlag is the value set in the AgentMessage.Flags field to indicate where in the stream this message belongs.
type AgentMessageFlag uint64

const (
	Data AgentMessageFlag = iota
	Syn  AgentMessageFlag = iota
	Fin  AgentMessageFlag = iota
	Ack  AgentMessageFlag = iota
)

// PayloadType is the value set in the AgentMessage.PayloadType field to indicate the data format of the Payload field.
type PayloadType uint32

const (
	Undefined            PayloadType = iota
	Output               PayloadType = iota
	Error                PayloadType = iota
	Size                 PayloadType = iota
	Parameter            PayloadType = iota
	HandshakeRequest     PayloadType = iota
	HandshakeResponse    PayloadType = iota
	HandshakeComplete    PayloadType = iota
	EncChallengeRequest  PayloadType = iota
	EncChallengeResponse PayloadType = iota
	Flag                 PayloadType = iota
	// StdErr·ExitCode 는 비대화형 명령 세션(AWS-StartNonInteractiveCommand)에서 출력 스트림을
	// 나눠 보낼 때 쓰인다. 대화형 셸(Standard_Stream)에는 오지 않지만, 우리가 광고하는 클라이언트
	// 버전(1.3.0.0)은 에이전트 기준으로 "출력 분리를 이해한다" 는 선언이므로 받을 수 있어야 한다.
	StdErr   PayloadType = iota
	ExitCode PayloadType = iota
)

// PayloadTypeFlag is the value set in the Payload of certain messages to indicate certain control operations.
type PayloadTypeFlag uint32

const (
	DisconnectToPort   PayloadTypeFlag = 1
	TerminateSession   PayloadTypeFlag = 2
	ConnectToPortError PayloadTypeFlag = 3
)

// ActionType is used in Handshake to determine action requested by the agent.
type ActionType string

const (
	KMSEncryption ActionType = "KMSEncryption"
	SessionType   ActionType = "SessionType"
)

// ActionStatus is use to communicate the result of an ActionType.
type ActionStatus int

const (
	Success     ActionStatus = 1
	Failed      ActionStatus = 2
	Unsupported ActionStatus = 3
)

// HandshakeRequestPayload is the data format sent from the agent to initiate a session handshake.
type HandshakeRequestPayload struct {
	AgentVersion           string
	RequestedClientActions []RequestedClientAction
}

// RequestedClientAction is the type of actions requested as part of the handshake negotiation.
type RequestedClientAction struct {
	ActionType       ActionType
	ActionParameters any
}

// SessionTypeRequest is part of the handshake process.
type SessionTypeRequest struct {
	SessionType string
	Properties  json.RawMessage
}

// HandshakeResponsePayload is the local client response to the offered handshake request.  The ProcessedClientActions
// field should have an entry for each RequestedClientActions in the handshake request.
type HandshakeResponsePayload struct {
	ClientVersion          string
	ProcessedClientActions []ProcessedClientAction
	Errors                 []string
}

// ProcessedClientAction is the result of a particular client action to send back to the remote agent.
type ProcessedClientAction struct {
	ActionType   ActionType
	ActionStatus ActionStatus
	ActionResult json.RawMessage
	Error        string
}

// HandshakeCompletePayload is the message returned from the agent when the handshake negotiation is successful.
type HandshakeCompletePayload struct {
	HandshakeTimeToComplete time.Duration
	CustomerMessage         string
}

// ChannelClosedPayload is the payload in a ChannelClosed message send from the agent.
type ChannelClosedPayload struct {
	MessageType   string
	MessageID     string
	DestinationID string
	SessionID     string
	SchemaVersion int
	CreatedDate   string
	Output        string
}
