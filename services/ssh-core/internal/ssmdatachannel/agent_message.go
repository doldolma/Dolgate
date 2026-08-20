package ssmdatachannel

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"strings"
	"time"
)

const agentMsgHeaderLen = 116 // the binary size of all AgentMessage fields except payloadLength and Payload

// agentMsgMinHeaderLen 은 헤더의 최소 크기다 — channel_closed 는 PayloadType 이 없어 112 로 온다.
const agentMsgMinHeaderLen = agentMsgHeaderLen - 4

// payloadLengthFieldLen 은 헤더 뒤에 붙는 payloadLength 필드 크기다.
const payloadLengthFieldLen = 4

// AgentMessage is the structural representation of the binary format of an SSM agent message use for communication
// between local clients (like this), and remote agents installed on EC2 instances.
// This is the order the fields must appear as on the wire
// REF: https://github.com/aws/amazon-ssm-agent/blob/master/agent/session/contracts/agentmessage.go.
//
//nolint:maligned
type AgentMessage struct {
	headerLength   uint32
	MessageType    MessageType // this is a 32 byte space-padded string on the wire
	schemaVersion  uint32
	createdDate    time.Time // wire format is milliseconds since unix epoch (uint64), value set to time.Now() in NewAgentMessage
	SequenceNumber int64
	Flags          AgentMessageFlag // REF: https://github.com/aws/amazon-ssm-agent/blob/master/agent/session/contracts/agentmessage.go
	messageID      uuid.UUID        // 16 byte UUID, auto-generated in NewAgentMessage
	payloadDigest  []byte           // SHA256 digest, value calculated in MarshalBinary
	PayloadType    PayloadType      // REF: https://github.com/aws/amazon-ssm-agent/blob/master/agent/session/contracts/model.go
	payloadLength  uint32           // value calculated in MarshalBinary
	Payload        []byte
}

// NewAgentMessage creates an AgentMessage ready to load with payload.
func NewAgentMessage() *AgentMessage {
	return &AgentMessage{
		headerLength:  agentMsgHeaderLen,
		schemaVersion: 1,
		createdDate:   time.Now(),
		messageID:     uuid.New(),
	}
}

// ValidateMessage performs checks on the values of the AgentMessage to ensure they are sane.
func (m *AgentMessage) ValidateMessage() error {
	// close_channel message header is 112 bytes
	if m.headerLength > agentMsgHeaderLen || m.headerLength < agentMsgHeaderLen-4 {
		return errors.New("invalid message header length")
	}

	if m.schemaVersion < 1 {
		return errors.New("invalid schema version")
	}

	// this seems to be a good minimum number after checking the SSM agent source code
	if len(m.MessageType) < 10 {
		return errors.New("invalid message type")
	}

	if m.createdDate.IsZero() {
		return errors.New("invalid message date")
	}

	if len(m.messageID[:]) != 16 {
		return errors.New("invalid message id")
	}

	if len(m.Payload) != int(m.payloadLength) {
		return fmt.Errorf("payload length mismatch, WANT: %d, GOT: %d", m.payloadLength, len(m.Payload))
	}

	if !bytes.Equal(m.sha256PayloadDigest(), m.payloadDigest) {
		return errors.New("payload digest mismatch")
	}

	return nil
}

// UnmarshalBinary reads the wire format data and updates the fields in the method receiver.  Satisfies the
// encoding.BinaryUnmarshaler interface.
func (m *AgentMessage) UnmarshalBinary(data []byte) error {
	// **길이는 슬라이싱 전에 검사한다.** 아래 오프셋은 프레임이 스스로 신고한 headerLength·
	// payloadLength 를 그대로 쓰는데, 그 값이 프레임 크기와 어긋나면 슬라이싱에서 패닉이 난다.
	// 그리고 그 패닉은 세션 하나로 끝나지 않는다 — 모바일에서는 앱이, 데스크톱에서는 코어가,
	// sync-api 에서는 모든 사용자의 세션을 안고 있는 서버 프로세스가 같이 죽는다.
	//
	// ValidateMessage 에도 같은 검사가 있지만 슬라이싱 **뒤**라서 이 경우에는 닿지 못했다.
	if len(data) < agentMsgMinHeaderLen+payloadLengthFieldLen {
		return fmt.Errorf("ssm frame too short: %d bytes", len(data))
	}
	headerLength := binary.BigEndian.Uint32(data)
	if headerLength < agentMsgMinHeaderLen || headerLength > agentMsgHeaderLen {
		return fmt.Errorf("invalid message header length: %d", headerLength)
	}
	// uint32 로 더하면 신고 값이 클 때 넘쳐서 검사를 통과해 버린다.
	payloadLenEnd := uint64(headerLength) + payloadLengthFieldLen
	if payloadLenEnd > uint64(len(data)) {
		return fmt.Errorf("ssm frame too short for its %d byte header: %d bytes", headerLength, len(data))
	}
	payloadLength := binary.BigEndian.Uint32(data[headerLength:payloadLenEnd])
	if payloadLenEnd+uint64(payloadLength) > uint64(len(data)) {
		return fmt.Errorf(
			"payload length mismatch, WANT: %d, GOT: %d",
			payloadLength, uint64(len(data))-payloadLenEnd,
		)
	}

	m.headerLength = headerLength
	m.MessageType = parseMessageType(data[4:36])
	m.schemaVersion = binary.BigEndian.Uint32(data[36:40])
	m.createdDate = parseTime(data[40:48])
	m.SequenceNumber = int64(binary.BigEndian.Uint64(data[48:56]))
	m.Flags = AgentMessageFlag(binary.BigEndian.Uint64(data[56:64]))
	m.messageID = uuid.Must(uuid.FromBytes(formatUUIDBytes(data[64:80])))
	m.payloadDigest = data[80 : 80+sha256.Size]

	// The channel_closed message has a header length of 112 bytes, assuming this is what's dropped
	if m.headerLength == agentMsgHeaderLen {
		m.PayloadType = PayloadType(binary.BigEndian.Uint32(data[112:m.headerLength]))
	}

	m.payloadLength = payloadLength
	m.Payload = data[payloadLenEnd : payloadLenEnd+uint64(payloadLength)]

	return m.ValidateMessage()
}

// MarshalBinary converts the fields in the method receiver to the expected wire format used by the websocket
// protocol with the SSM messaging service.  Satisfies the encoding.BinaryMarshaler interface.
func (m *AgentMessage) MarshalBinary() ([]byte, error) {
	buf := new(bytes.Buffer)

	m.sha256PayloadDigest()
	m.payloadLength = uint32(len(m.Payload))

	if err := m.ValidateMessage(); err != nil {
		return nil, err
	}

	if err := binary.Write(buf, binary.BigEndian, m.headerLength); err != nil {
		return nil, err
	}
	if err := binary.Write(buf, binary.BigEndian, m.convertMessageType()); err != nil {
		return nil, err
	}
	if err := binary.Write(buf, binary.BigEndian, m.schemaVersion); err != nil {
		return nil, err
	}
	if err := binary.Write(buf, binary.BigEndian, time.Duration(m.createdDate.UnixNano()).Milliseconds()); err != nil {
		return nil, err
	}
	if err := binary.Write(buf, binary.BigEndian, m.SequenceNumber); err != nil {
		return nil, err
	}
	if err := binary.Write(buf, binary.BigEndian, m.Flags); err != nil {
		return nil, err
	}
	// []byte values are written directly (no endian-ness), but for consistency's sake ...
	if err := binary.Write(buf, binary.BigEndian, formatUUIDBytes(m.messageID[:])); err != nil {
		return nil, err
	}
	if err := binary.Write(buf, binary.BigEndian, m.payloadDigest[:sha256.Size]); err != nil {
		return nil, err
	}
	if err := binary.Write(buf, binary.BigEndian, m.PayloadType); err != nil {
		return nil, err
	}
	if err := binary.Write(buf, binary.BigEndian, m.payloadLength); err != nil {
		return nil, err
	}
	if err := binary.Write(buf, binary.BigEndian, m.Payload); err != nil {
		return nil, err
	}

	return buf.Bytes(), nil
}

func (m *AgentMessage) String() string {
	sb := new(strings.Builder)
	sb.WriteString("AgentMessage{")
	sb.WriteString(fmt.Sprintf("TYPE: %s, ", m.MessageType))
	sb.WriteString(fmt.Sprintf("SCHEMA VERSION: %d, ", m.schemaVersion))
	sb.WriteString(fmt.Sprintf("SEQUENCE: %d, ", m.SequenceNumber))
	sb.WriteString(fmt.Sprintf("MESSAGE ID: %s, ", m.messageID))
	sb.WriteString(fmt.Sprintf("PAYLOAD TYPE: %d, ", m.PayloadType))
	sb.WriteString(fmt.Sprintf("PAYLOAD LENGTH: %d", m.payloadLength))
	sb.WriteString(fmt.Sprintln("}"))
	return sb.String()
}

func (m *AgentMessage) convertMessageType() []byte {
	var msgTypeLen = 32 // per spec
	var msgType []byte

	if len(m.MessageType) >= msgTypeLen {
		msgType = []byte(m.MessageType)
	} else {
		msgType = []byte(m.MessageType)
		msgType = append(msgType, bytes.Repeat([]byte{0x20}, msgTypeLen-len(m.MessageType))...)
	}

	return msgType[:msgTypeLen]
}

func (m *AgentMessage) sha256PayloadDigest() []byte {
	digest := sha256.New()
	_, _ = digest.Write(m.Payload)
	m.payloadDigest = digest.Sum(nil)
	return m.payloadDigest
}

// channel_closed message type is nul padded, others are space padded.  Handle both.
func parseMessageType(data []byte) MessageType {
	return MessageType(bytes.TrimSpace(bytes.TrimRight(data, string(rune(0x00)))))
}

func parseTime(data []byte) time.Time {
	ts := binary.BigEndian.Uint64(data)
	d := time.Duration(ts) * time.Millisecond
	return time.Unix(0, d.Nanoseconds())
}

func formatUUIDBytes(data []byte) []byte {
	return append(data[8:], data[:8]...)
}
