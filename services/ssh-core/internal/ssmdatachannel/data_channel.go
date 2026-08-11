package ssmdatachannel

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// DataChannel is the interface definition for handling communication with the AWS SSM messaging service.
type DataChannel interface {
	OpenWithSessionToken(url, token string) error
	ReadFrame() ([]byte, error)
	HandleMsg(data []byte) ([]byte, error)
	SetTerminalSize(rows, cols uint32) error
	TerminateSession() error
	DisconnectPort() error
	WriteMsg(*AgentMessage) (int, error)
	io.ReadWriteCloser
	io.ReaderFrom
	io.WriterTo
}

// WebSocket liveness bounds. Without these a stalled/half-open connection to
// the SSM endpoint is never detected: reads park forever in ReadMessage and the
// session hangs indefinitely instead of erroring out (which would let the caller
// reconnect). We ping every dataChannelPingInterval and require any frame or a
// pong within dataChannelReadTimeout; writes are bounded by dataChannelWriteTimeout
// so a stuck write can't wedge the channel (and its mutex) forever. Mirrors the
// sync-api hub's keepalive on the outer websocket.
const (
	// 10s matches the SSH keepalive interval so the tab latency indicator
	// refreshes at the same cadence for both transports. Read timeout stays well
	// above it (tolerates several missed pongs before declaring the link dead).
	dataChannelPingInterval = 10 * time.Second
	dataChannelReadTimeout  = 45 * time.Second
	dataChannelWriteTimeout = 10 * time.Second
	// AWS' session-manager-plugin uses 1024-byte stream data payloads and adds a
	// tiny delay after each forwarded port chunk in the basic port-forward path.
	// Without this pacing, bulk SSH/SFTP writes can flood MGS/agent and the port
	// connection is dropped. Higher throughput needs the official mux/smux path.
	dataChannelStreamPayloadSize = 1024
	dataChannelStreamWriteDelay  = time.Millisecond
	dataChannelBufferSize        = 10000
	dataChannelResendInterval    = 100 * time.Millisecond
	dataChannelRetransmitAfter   = time.Second
	dataChannelResendMaxAttempts = 3000
	// Match the official session-manager-plugin generation. Agents use the
	// handshake client version to decide whether port sessions may use smux.
	dataChannelClientVersion = "1.3.0.0"
)

// errDataChannelClosed unblocks a WriteMsg parked on outbound-buffer
// backpressure when the channel is torn down.
var errDataChannelClosed = errors.New("ssm data channel closed")

var ErrReadBufferTooSmall = errors.New("ssm data channel read buffer too small")

// SsmDataChannel represents the data channel of the websocket connection used to communicate with the AWS
// SSM service.  A new(SsmDataChannel) is ready for use, and should immediately call the
// OpenWithSessionToken() method.
type SsmDataChannel struct {
	seqNum        int64
	inSeqNum      int64
	mu            sync.Mutex
	ws            *websocket.Conn
	synSent       bool
	handshakeCh   chan bool
	handshakeOnce sync.Once
	outMsgBuf     MessageBuffer
	inMsgBuf      MessageBuffer
	outboundDone  chan struct{}
	outSentAt     map[int64]time.Time
	outAttempts   map[int64]int
	// writeMu serializes ws.WriteMessage (gorilla permits a single concurrent
	// writer). It is separate from mu so a slow/backpressured write never blocks
	// pause/state handling or ACK sends that only need mu.
	writeMu      sync.Mutex
	bufferCond   *sync.Cond
	closed       bool
	pingStop     chan struct{}
	pingStopOnce sync.Once
	lastRows     uint32
	lastCols     uint32
	agentVersion string
	sessionType  string
	// Raw JSON properties from the SessionType handshake action. Port forwarding
	// uses this to distinguish basic/standard stream sessions from smux-capable
	// LocalPortForwarding sessions.
	sessionProperties json.RawMessage

	// onRTT, if set, is called with the websocket ping→pong round-trip time on
	// each keepalive cycle. It measures latency to the AWS SSM endpoint (the
	// control channel), not the full path to the instance shell.
	rttMu sync.Mutex
	onRTT func(time.Duration)
}

// AgentVersion returns the SSM agent version learned during the SessionType
// handshake.
func (c *SsmDataChannel) AgentVersion() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.agentVersion
}

// SessionType returns the negotiated SessionType value, such as "Port".
func (c *SsmDataChannel) SessionType() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sessionType
}

// SessionProperties returns a copy of the raw SessionType properties payload.
func (c *SsmDataChannel) SessionProperties() json.RawMessage {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.sessionProperties) == 0 {
		return nil
	}
	out := make([]byte, len(c.sessionProperties))
	copy(out, c.sessionProperties)
	return out
}

// SetRTTHandler registers a callback invoked with each keepalive ping→pong
// round-trip time. Safe to call concurrently with the ping loop.
func (c *SsmDataChannel) SetRTTHandler(fn func(time.Duration)) {
	c.rttMu.Lock()
	c.onRTT = fn
	c.rttMu.Unlock()
}

func (c *SsmDataChannel) reportRTT(rtt time.Duration) {
	c.rttMu.Lock()
	fn := c.onRTT
	c.rttMu.Unlock()
	if fn != nil {
		fn(rtt)
	}
}

// OpenWithSessionToken initializes the channel state (retransmit/reorder message buffers, handshake
// tracking, the outbound publish queue) and dials the SSM messages WebSocket endpoint using a
// caller-supplied stream URL and session token, as returned by ssm:StartSession or ecs:ExecuteCommand.
// Token issuance is the caller's responsibility; this package never touches AWS credentials.
func (c *SsmDataChannel) OpenWithSessionToken(url, token string) error {
	c.handshakeCh = make(chan bool, 1)
	c.handshakeOnce = sync.Once{}
	c.outMsgBuf = NewMessageBuffer(dataChannelBufferSize)
	c.inMsgBuf = NewMessageBuffer(dataChannelBufferSize)
	c.outboundDone = make(chan struct{})
	c.outSentAt = make(map[int64]time.Time)
	c.outAttempts = make(map[int64]int)

	go c.processOutboundQueue()

	if err := c.StartSessionFromDataChannelURL(url, token); err != nil {
		c.detachBuffers() // signals processOutboundQueue to exit
		return err
	}
	return nil
}

// Close shuts down the web socket connection with the AWS service. Type-specific actions (like sending
// TerminateSession for port forwarding should be handled before calling Close().
func (c *SsmDataChannel) Close() error {
	c.mu.Lock()
	c.closed = true
	if c.bufferCond != nil {
		c.bufferCond.Broadcast()
	}
	c.mu.Unlock()
	c.detachBuffers()
	if c.pingStop != nil {
		c.pingStopOnce.Do(func() { close(c.pingStop) })
	}
	var err error
	if c.ws != nil {
		err = c.ws.Close()
	}
	return err
}

// keepAlive pings the SSM endpoint periodically. A failed ping (dead/half-open
// connection) closes the socket so the read loop unblocks and the session
// errors out; the pong handler and Read() extend the read deadline on any
// received frame so a live-but-idle session is never falsely dropped.
func (c *SsmDataChannel) keepAlive() {
	ticker := time.NewTicker(dataChannelPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.pingStop:
			return
		case <-ticker.C:
			// Carry the send time in the ping payload; the peer echoes it back in
			// the pong (RFC 6455), letting the pong handler compute the round trip.
			// WriteControl is safe to call concurrently with WriteMessage.
			var buf [8]byte
			binary.BigEndian.PutUint64(buf[:], uint64(time.Now().UnixNano()))
			if err := c.ws.WriteControl(websocket.PingMessage, buf[:], time.Now().Add(dataChannelWriteTimeout)); err != nil {
				_ = c.ws.Close()
				return
			}
		}
	}
}

// detachBuffers tears down retransmit/reorder buffers and signals
// processOutboundQueue to exit; locked because that goroutine reads these fields.
func (c *SsmDataChannel) detachBuffers() {
	c.mu.Lock()
	c.inMsgBuf = nil
	c.outMsgBuf = nil
	c.outSentAt = nil
	c.outAttempts = nil
	c.handshakeCh = nil
	if c.bufferCond != nil {
		c.bufferCond.Broadcast()
	}
	c.mu.Unlock()
}

// WaitForHandshakeComplete blocks further processing until the required SSM handshake sequence used for
// port-based clients (including ssh) completes.
func (c *SsmDataChannel) WaitForHandshakeComplete(ctx context.Context) error {
	cancelRead := make(chan struct{})
	defer close(cancelRead)
	go func() {
		select {
		case <-ctx.Done():
			c.closeWebSocket()
		case <-cancelRead:
		}
	}()

	for {
		select {
		case <-c.handshakeCh:
			return nil
		case <-ctx.Done():
			c.detachBuffers()
			return ctx.Err()
		default:
			msg, err := c.ReadFrame()
			if err != nil {
				if ctx.Err() != nil {
					c.detachBuffers()
					return ctx.Err()
				}
				return err
			}

			if _, err = c.HandleMsg(msg); err != nil {
				return err
			}
		}
	}
}

// ReadFrame will get a single message from the websocket connection and return
// the full unprocessed message bytes. Prefer this over Read when the frame size
// is not known in advance.
func (c *SsmDataChannel) ReadFrame() ([]byte, error) {
	_, msg, err := c.ws.ReadMessage()
	if err != nil {
		// gorilla code states this is uber-fatal, and we just need to bail out
		if websocket.IsCloseError(err, 1000, 1001, 1006) {
			err = io.EOF
		}
		return nil, err
	}

	// Any received frame proves the connection is alive; extend the read window.
	if c.ws != nil {
		_ = c.ws.SetReadDeadline(time.Now().Add(dataChannelReadTimeout))
	}

	if len(msg) < agentMsgHeaderLen {
		return msg, errors.New("invalid message received, too short")
	}

	return msg, nil
}

// Read will get a single message from the websocket connection. If the caller's
// buffer is smaller than the frame, the prefix is copied and ErrReadBufferTooSmall
// is returned instead of panicking.
func (c *SsmDataChannel) Read(data []byte) (int, error) {
	msg, err := c.ReadFrame()
	n := copy(data, msg)
	if err != nil {
		return n, err
	}
	if n < len(msg) {
		return n, ErrReadBufferTooSmall
	}
	return n, nil
}

// WriteTo uses the data channel as an io.Copy read source, writing output to the provided writer.
func (c *SsmDataChannel) WriteTo(w io.Writer) (n int64, err error) {
	var nw int
	var payload []byte

	for {
		msg, err := c.ReadFrame()
		if err != nil {
			log.Printf("WriteTo read error: %v", err)
			return n, err
		}

		if len(msg) > 0 {
			payload, err = c.HandleMsg(msg)
			var isEOF bool
			if err != nil {
				if errors.Is(err, io.EOF) {
					isEOF = true
				} else {
					log.Printf("WriteTo HandleMsg error: %v", err)
					return n, err
				}
			}

			if len(payload) > 0 {
				nw, err = w.Write(payload)
				n += int64(nw)
				if err != nil {
					log.Printf("WriteTo write error: %v", err)
					return n, err
				}
			}

			if isEOF {
				return n, nil
			}
		}
	}
}

func (c *SsmDataChannel) closeWebSocket() {
	c.mu.Lock()
	ws := c.ws
	c.mu.Unlock()
	if ws != nil {
		_ = ws.Close()
	}
}

// ReadFrom uses the data channel as an io.Copy write destination, reading data from the provided reader.
func (c *SsmDataChannel) ReadFrom(r io.Reader) (n int64, err error) {
	buf := make([]byte, dataChannelStreamPayloadSize)

	for {
		var nr int
		nr, err = r.Read(buf)
		n += int64(nr)

		if nr > 0 {
			if _, writeErr := c.Write(buf[:nr]); writeErr != nil {
				log.Printf("ReadFrom write error: %v", writeErr)
				return n, writeErr
			}
			time.Sleep(dataChannelStreamWriteDelay)
		}

		if err != nil {
			if errors.Is(err, io.EOF) {
				// the contract of ReaderFrom states that io.EOF should not be returned, just
				// exit the loop and return no error to indicate we are done
				log.Print("ReadFrom reader is closed")
				return n, nil
			}
			return n, err
		}
	}
}

// Write sends an input stream data message type with the provided payload bytes as the message payload.
// The sequence number is assigned by WriteMsg under the channel lock (do not preset it here).
func (c *SsmDataChannel) Write(payload []byte) (int, error) {
	msg := NewAgentMessage()
	msg.MessageType = InputStreamData
	msg.Flags = Data
	msg.PayloadType = Output
	msg.Payload = payload

	return c.WriteMsg(msg)
}

// WriteMsg marshals an AgentMessage and sends it to the AWS service.
//
// The outbound sequence number is assigned HERE, under c.mu, so that the number
// a message carries is bound atomically to the order it is written to the
// socket. Assigning it in the caller (outside the lock) races when several
// goroutines write concurrently at session start (terminal-size + shell
// integration init + autocomplete probe + keystrokes): the numbers could be
// handed out in one order but hit the wire in another, leaving a gap the SSM
// agent stalls on: it stops acknowledging past the gap, so outMsgBuf never
// drains and processOutboundQueue retransmits forever while input is dropped.
// Acknowledge and HandshakeResponse messages mirror the peer's sequence number,
// so they keep the caller-set value and do not advance the counter.
func (c *SsmDataChannel) WriteMsg(msg *AgentMessage) (int, error) {
	mirrorsPeerSeq := msg.MessageType == Acknowledge || msg.PayloadType == HandshakeResponse

	c.mu.Lock()
	if !c.synSent {
		// The first message opens the stream: sequence 0 with the Syn flag.
		c.seqNum = 0
		c.synSent = true
		msg.Flags = Syn
		msg.SequenceNumber = 0
	} else if !mirrorsPeerSeq {
		c.seqNum++
		msg.SequenceNumber = c.seqNum
	}

	// MarshalBinary mutates msg (payload digest/length); marshaling under the channel
	// lock keeps it consistent with any concurrent handshake-phase retransmit.
	data, err := msg.MarshalBinary()
	if err != nil {
		c.mu.Unlock()
		return 0, err
	}
	if c.outMsgBuf != nil && !mirrorsPeerSeq {
		for {
			if err := c.outMsgBuf.Add(msg); err == nil {
				if c.outSentAt != nil {
					c.outSentAt[msg.SequenceNumber] = time.Now()
				}
				if c.outAttempts != nil {
					c.outAttempts[msg.SequenceNumber] = 0
				}
				break
			} else if !errors.Is(err, ErrBufferFull) {
				c.mu.Unlock()
				return 0, err
			}
			if c.bufferCond == nil {
				c.mu.Unlock()
				return 0, ErrBufferFull
			}
			c.bufferCond.Wait()
			if c.closed {
				c.mu.Unlock()
				return 0, errDataChannelClosed
			}
			if c.outMsgBuf == nil {
				break
			}
		}
	}
	c.mu.Unlock()

	// Write under writeMu, NOT the channel lock, so a slow/backpressured write never
	// blocks pause/state handling or concurrent ACK sends.
	c.writeMu.Lock()
	_ = c.ws.SetWriteDeadline(time.Now().Add(dataChannelWriteTimeout))
	werr := c.ws.WriteMessage(websocket.BinaryMessage, data)
	c.writeMu.Unlock()
	if werr != nil && !mirrorsPeerSeq {
		c.mu.Lock()
		c.removeOutboundTrackingLocked(msg.SequenceNumber)
		c.mu.Unlock()
	}
	return int(msg.payloadLength), werr
}

// HandleMsg takes the unprocessed message bytes from the websocket connection (a la Read()), unmarshals the data
// and takes the appropriate action based on the message type.  Messages which have an actionable payload (output
// payload types, and channel closed payloads) will have that data returned.  Errors will be returned for unknown/
// unhandled message or payload types.  A ChannelClosed message type will return an io.EOF error to indicate that
// this SSM data channel is shutting down and should no longer be used.
//
//nolint:gocognit,gocyclo
func (c *SsmDataChannel) HandleMsg(data []byte) ([]byte, error) {
	m := new(AgentMessage)
	if err := m.UnmarshalBinary(data); err != nil {
		// validation error
		return nil, err
	}

	var inboundQueue MessageBuffer

	//nolint:exhaustive // we'll add more as we find them
	switch m.MessageType {
	case Acknowledge:
		ackSeq := acknowledgedMessageSequenceNumber(m)
		c.mu.Lock()
		c.removeOutboundTrackingLocked(ackSeq)
		c.mu.Unlock()
		return nil, nil
	case PausePublication, StartPublication:
		// The AWS session-manager-plugin treats these as MGS/agent-side
		// publication controls and does not stop client input for them. Blocking
		// here wedges SSH/SFTP over port-forward sessions after MGS emits a pause
		// under bulk traffic.
		return nil, nil
	case OutputStreamData:
		c.mu.Lock()
		inBuf := c.inMsgBuf
		c.mu.Unlock()
		inboundQueue = inBuf

		if inBuf == nil {
			payload, err := c.processOutputStreamMessage(m, true)
			if err != nil {
				return nil, err
			}
			return payload, nil
		}

		expectedSeq := atomic.LoadInt64(&c.inSeqNum)
		if m.SequenceNumber < expectedSeq {
			_ = c.sendAcknowledgeMessage(m)
			return nil, nil
		}
		if m.SequenceNumber > expectedSeq {
			if err := inBuf.Add(m); err != nil {
				return nil, err
			}
			if err := c.sendAcknowledgeMessage(m); err != nil {
				return nil, err
			}
			return nil, nil
		}

		payload, err := c.processOutputStreamMessage(m, true)
		if err != nil {
			return nil, err
		}
		bufferedPayload, err := c.processInboundQueue(inboundQueue)
		if err != nil {
			return nil, err
		}
		if len(bufferedPayload) > 0 {
			payload = append(payload, bufferedPayload...)
		}
		return payload, nil
	case ChannelClosed:
		payload := new(ChannelClosedPayload)
		if err := json.Unmarshal(m.Payload, payload); err != nil {
			return nil, err
		}

		var output []byte
		if len(payload.Output) > 0 {
			output = []byte(payload.Output)
		}
		return output, io.EOF
	default:
		return nil, fmt.Errorf("UNKNOWN MESSAGE TYPE: %+v", m)
	}

	return c.processInboundQueue(inboundQueue)
}

// SetTerminalSize sends a message to the SSM service which indicates the size to use for the remote terminal
// when using a shell session client.
func (c *SsmDataChannel) SetTerminalSize(rows, cols uint32) error {
	if c.lastRows == rows && c.lastCols == cols {
		// skip if terminal size is unchanged
		return nil
	}

	input := map[string]uint32{
		"rows": rows,
		"cols": cols,
	}

	payload, err := json.Marshal(input)
	if err != nil {
		return err
	}

	msg := NewAgentMessage()
	msg.MessageType = InputStreamData
	msg.Flags = Data
	msg.PayloadType = Size
	msg.Payload = payload

	// Remind our future selves what the last-set values were:
	c.lastRows = rows
	c.lastCols = cols

	_, err = c.WriteMsg(msg)
	return err
}

// TerminateSession sends the TerminateSession message to the AWS service to indicate that the port forwarding
// session is ending, so it can clean up any connections used to communicate with the EC2 instance agent.
func (c *SsmDataChannel) TerminateSession() error {
	msg := NewAgentMessage()
	msg.MessageType = InputStreamData
	msg.Flags = Fin
	msg.PayloadType = Flag

	buf := make([]byte, 4)
	binary.BigEndian.PutUint32(buf, uint32(TerminateSession))
	msg.Payload = buf

	_, err := c.WriteMsg(msg)
	return err
}

// DisconnectPort sends the DisconnectToPort message to the AWS service to indicate that a non-muxing stream is
// shutting down and any connection used to communicate with the EC2 instance agent can be cleaned up.  Unlike
// the TerminateSession action, the websocket connection is still capable of initiating a new port forwarding
// stream to the agent without needing to restart the program.
func (c *SsmDataChannel) DisconnectPort() error {
	msg := NewAgentMessage()
	msg.MessageType = InputStreamData
	msg.Flags = Data
	msg.PayloadType = Flag

	buf := make([]byte, 4)
	binary.BigEndian.PutUint32(buf, uint32(DisconnectToPort))
	msg.Payload = buf

	_, err := c.WriteMsg(msg)
	return err
}

func (c *SsmDataChannel) processOutputStreamMessage(msg *AgentMessage, acknowledge bool) ([]byte, error) {
	var payload []byte

	switch msg.PayloadType {
	case Output:
		payload = msg.Payload
	case HandshakeRequest:
		// Port forwarding session setup. Keep this in the ordered stream: the
		// handshake request consumes an incoming sequence number just like normal
		// output data.
		if err := c.processHandshakeRequest(msg); err != nil {
			return nil, err
		}
	case HandshakeComplete:
		c.handshakeOnce.Do(func() {
			if c.handshakeCh != nil {
				close(c.handshakeCh)
			}
		})
	default:
		return nil, fmt.Errorf("UNKNOWN INCOMING MSG PAYLOAD: %s\n%s", msg, msg.Payload)
	}

	if acknowledge {
		if err := c.sendAcknowledgeMessage(msg); err != nil {
			return nil, err
		}
	}
	atomic.AddInt64(&c.inSeqNum, 1)
	return payload, nil
}

func (c *SsmDataChannel) processInboundQueue(inBuf MessageBuffer) ([]byte, error) {
	if inBuf == nil {
		return nil, nil
	}

	var err error
	data := new(bytes.Buffer)

	for {
		if msg := inBuf.Get(atomic.LoadInt64(&c.inSeqNum)); msg != nil {
			payload, processErr := c.processOutputStreamMessage(msg, false)
			if processErr != nil {
				err = processErr
				break
			}
			if len(payload) > 0 {
				if _, err = data.Write(payload); err != nil {
					break
				}
			}
			inBuf.Remove(msg.SequenceNumber)
		} else {
			break
		}
	}

	return data.Bytes(), err
}

func (c *SsmDataChannel) processOutboundQueue() {
	done := c.outboundDone
	defer func() {
		if done != nil {
			close(done)
		}
	}()
	ticker := time.NewTicker(dataChannelResendInterval)
	defer ticker.Stop()
	for {
		<-ticker.C

		// Snapshot under the lock: outMsgBuf is written by other goroutines
		// (HandleMsg, WaitForHandshakeComplete). The buffer must be used outside
		// the lock because WriteMsg locks c.mu itself.
		c.mu.Lock()
		buf := c.outMsgBuf
		if buf == nil {
			c.mu.Unlock()
			return
		}

		msg := buf.Oldest()
		if msg == nil {
			c.mu.Unlock()
			continue
		}
		sentAt := c.outSentAt[msg.SequenceNumber]
		if sentAt.IsZero() || time.Since(sentAt) < dataChannelRetransmitAfter {
			c.mu.Unlock()
			continue
		}
		attempts := c.outAttempts[msg.SequenceNumber]
		if attempts >= dataChannelResendMaxAttempts {
			c.mu.Unlock()
			c.closeWebSocket()
			return
		}
		if c.outAttempts != nil {
			c.outAttempts[msg.SequenceNumber] = attempts + 1
		}
		if c.outSentAt != nil {
			c.outSentAt[msg.SequenceNumber] = time.Now()
		}
		c.mu.Unlock()

		// Retransmit only the oldest expired message, mirroring the official
		// plugin's resend scheduler. Re-sending the whole unacked buffer every
		// tick multiplies large SFTP uploads into duplicate datachannel traffic.
		if err := c.resendMsg(msg); err != nil {
			c.closeWebSocket()
			return
		}
	}
}

func (c *SsmDataChannel) removeOutboundTrackingLocked(seqNum int64) {
	if c.outMsgBuf != nil {
		c.outMsgBuf.Remove(seqNum)
	}
	if c.outSentAt != nil {
		delete(c.outSentAt, seqNum)
	}
	if c.outAttempts != nil {
		delete(c.outAttempts, seqNum)
	}
	if c.bufferCond != nil {
		c.bufferCond.Broadcast()
	}
}

// resendMsg retransmits an already-sequenced message from the outbound retransmit
// buffer. Unlike WriteMsg it must not assign a sequence number or re-buffer; the
// message keeps the number it was first sent with, so retransmits never renumber
// the stream.
func (c *SsmDataChannel) resendMsg(msg *AgentMessage) error {
	c.mu.Lock()
	data, err := msg.MarshalBinary()
	c.mu.Unlock()
	if err != nil {
		return err
	}
	// Serialize with WriteMsg via writeMu (gorilla single-writer), off the channel lock.
	c.writeMu.Lock()
	_ = c.ws.SetWriteDeadline(time.Now().Add(dataChannelWriteTimeout))
	err = c.ws.WriteMessage(websocket.BinaryMessage, data)
	c.writeMu.Unlock()
	return err
}

func acknowledgedMessageSequenceNumber(msg *AgentMessage) int64 {
	payload := struct {
		AcknowledgedMessageSequenceNumber *int64 `json:"AcknowledgedMessageSequenceNumber"`
	}{}
	if len(msg.Payload) > 0 && json.Unmarshal(msg.Payload, &payload) == nil &&
		payload.AcknowledgedMessageSequenceNumber != nil {
		return *payload.AcknowledgedMessageSequenceNumber
	}
	return msg.SequenceNumber
}

// sendAcknowledgeMessage sends the Acknowledge message type for each incoming message read from
// the web socket connection, which is required as part of the SSM session protocol.
func (c *SsmDataChannel) sendAcknowledgeMessage(msg *AgentMessage) error {
	ack := map[string]any{
		"AcknowledgedMessageType":           msg.MessageType,
		"AcknowledgedMessageId":             msg.messageID.String(),
		"AcknowledgedMessageSequenceNumber": msg.SequenceNumber,
		"IsSequentialMessage":               true,
	}

	payload, err := json.Marshal(ack)
	if err != nil {
		return err
	}

	agentMsg := NewAgentMessage()
	agentMsg.MessageType = Acknowledge
	agentMsg.SequenceNumber = msg.SequenceNumber
	agentMsg.Flags = Ack
	agentMsg.PayloadType = Undefined
	agentMsg.Payload = payload

	_, err = c.WriteMsg(agentMsg)
	return err
}

// processHandshakeRequest handles the incoming handshake request message for a port forwarding session
// and sends the required HandshakeResponse message.  This must complete before sending data over the
// forwarded connection.
func (c *SsmDataChannel) processHandshakeRequest(msg *AgentMessage) error {
	req := new(HandshakeRequestPayload)
	if err := json.Unmarshal(msg.Payload, req); err != nil {
		return err
	}
	c.recordHandshakeRequest(req)

	response := buildHandshakeResponse(req.RequestedClientActions)
	payload, err := json.Marshal(response)
	if err != nil {
		return err
	}

	out := NewAgentMessage()
	out.MessageType = InputStreamData
	out.SequenceNumber = msg.SequenceNumber
	out.Flags = Data
	out.PayloadType = HandshakeResponse
	out.Payload = payload

	if _, err := c.WriteMsg(out); err != nil {
		return err
	}

	// 응답을 먼저 보내고 나서 오류로 올린다. 순서가 중요하다 — 에이전트는 거부 사실을 알아야
	// 자기 쪽 세션을 정리하고, 우리는 오류를 올려야 그 이유가 앱까지 간다.
	//
	// 안 올리면 에이전트가 조용히 세션을 끊고, 그건 앱에 "이유 없는 종료" 로 도착해서 탭만
	// 사라진다(무엇 때문인지 어디에도 남지 않는다).
	return unsupportedHandshakeError(response.ProcessedClientActions)
}

// unsupportedHandshakeError 는 우리가 거부한 액션이 있으면 사용자에게 보일 오류를 만든다.
func unsupportedHandshakeError(actions []ProcessedClientAction) error {
	for _, action := range actions {
		if action.ActionStatus != Unsupported {
			continue
		}
		if action.ActionType == KMSEncryption {
			return errors.New(
				"이 계정은 Session Manager 세션 암호화(KMS)를 사용합니다. 아직 지원하지 않는 방식이라 " +
					"연결할 수 없습니다 — 세션 관리자 기본 설정에서 KMS 암호화를 끄면 연결됩니다.",
			)
		}
		return fmt.Errorf("SSM 세션이 지원하지 않는 기능을 요구합니다: %s", action.ActionType)
	}
	return nil
}

func (c *SsmDataChannel) recordHandshakeRequest(req *HandshakeRequestPayload) {
	var sessionType string
	var properties json.RawMessage
	for _, action := range req.RequestedClientActions {
		if action.ActionType != SessionType {
			continue
		}
		parsed, err := parseSessionTypeAction(action.ActionParameters)
		if err != nil {
			continue
		}
		sessionType = parsed.SessionType
		if len(parsed.Properties) > 0 && string(parsed.Properties) != "null" {
			properties = append(properties[:0], parsed.Properties...)
		}
		break
	}

	c.mu.Lock()
	c.agentVersion = req.AgentVersion
	c.sessionType = sessionType
	if len(properties) > 0 {
		c.sessionProperties = append(c.sessionProperties[:0], properties...)
	} else {
		c.sessionProperties = nil
	}
	c.mu.Unlock()
}

func parseSessionTypeAction(params any) (SessionTypeRequest, error) {
	data, err := json.Marshal(params)
	if err != nil {
		return SessionTypeRequest{}, err
	}
	var req SessionTypeRequest
	if err := json.Unmarshal(data, &req); err != nil {
		return SessionTypeRequest{}, err
	}
	return req, nil
}

// StartSessionFromDataChannelURL dials the WebSocket stream URL and sends the channel-open message
// carrying the session token. Most callers want OpenWithSessionToken, which also initializes the
// message buffers; calling this directly leaves the channel in unbuffered mode (no retransmit).
func (c *SsmDataChannel) StartSessionFromDataChannelURL(url string, token string) error {
	ws, _, err := websocket.DefaultDialer.Dial(url, http.Header{}) //nolint:bodyclose
	if err != nil {
		return err
	}
	c.ws = ws
	c.closed = false
	c.bufferCond = sync.NewCond(&c.mu)

	// Arm liveness: initial read deadline, extend it on every pong, and start
	// the ping loop. A pong (or any frame) keeps a healthy idle session alive;
	// silence beyond dataChannelReadTimeout surfaces a dead connection.
	c.pingStop = make(chan struct{})
	_ = c.ws.SetReadDeadline(time.Now().Add(dataChannelReadTimeout))
	c.ws.SetPongHandler(func(appData string) error {
		// The pong echoes our ping's 8-byte send timestamp; decode it to report
		// the round-trip latency (best-effort — a malformed/empty pong is ignored).
		if len(appData) == 8 {
			sent := time.Unix(0, int64(binary.BigEndian.Uint64([]byte(appData))))
			if rtt := time.Since(sent); rtt > 0 {
				c.reportRTT(rtt)
			}
		}
		return c.ws.SetReadDeadline(time.Now().Add(dataChannelReadTimeout))
	})
	go c.keepAlive()

	if err = c.openDataChannel(token); err != nil {
		_ = c.Close()
		return err
	}

	return nil
}

func (c *SsmDataChannel) openDataChannel(token string) error {
	openDataChanInput := map[string]string{
		"MessageSchemaVersion": "1.0",
		"RequestId":            uuid.New().String(),
		"TokenValue":           token,
		"ClientId":             uuid.New().String(),
		"ClientVersion":        dataChannelClientVersion,
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.ws.SetWriteDeadline(time.Now().Add(dataChannelWriteTimeout))
	return c.ws.WriteJSON(openDataChanInput)
}

// the only requirement of the handshake response is that we include an element in ProcessedClientActions
// for each element of RequestedClientActions (there's only 2 types, and port forwarding only uses the
// SessionType action type, so there should only be 1 element), and the ActionStatus is Success.  Any
// non-success is considered a failure in the receiving agent.
//
// 우리가 처리하지 못하는 액션은 Unsupported 로 되돌려준다. 대표적인 것이 KMSEncryption 이다 —
// 계정의 Session Manager 설정에서 세션 암호화를 켜면 에이전트가 그걸 요청하는데, 이 구현에는
// 스트림 암호화가 없다(그 설정을 쓰는 계정에서는 셸·포트 포워딩·SSH over SSM 이 다 안 된다).
//
// 예전에는 그런 액션에 빈 항목(ActionType "", ActionStatus 0)을 실어 보냈다. 그러면 에이전트는
// 무효한 응답을 받고 끊는데, 어느 액션이 문제였는지가 어디에도 남지 않아 원인을 찾을 수 없다.
// Unsupported 를 명시하면 실패 이유가 분명해진다. 지원 여부 자체는 달라지지 않는다.
func buildHandshakeResponse(actions []RequestedClientAction) *HandshakeResponsePayload {
	res := HandshakeResponsePayload{
		// seems this can be whatever we need it to be, however certain features may only be available at
		// certain client versions (must report at least version 1.1.70 to do stream muxing)
		ClientVersion:          dataChannelClientVersion,
		ProcessedClientActions: make([]ProcessedClientAction, len(actions)),
	}

	for i, a := range actions {
		action := ProcessedClientAction{ActionType: a.ActionType}

		if a.ActionType == SessionType {
			action.ActionStatus = Success
		} else {
			action.ActionStatus = Unsupported
		}

		res.ProcessedClientActions[i] = action
	}

	return &res
}
