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
)

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
	pausePub      bool
	outMsgBuf     MessageBuffer
	inMsgBuf      MessageBuffer
	outboundDone  chan struct{}
	pingStop      chan struct{}
	pingStopOnce  sync.Once
	lastRows      uint32
	lastCols      uint32

	// onRTT, if set, is called with the websocket ping→pong round-trip time on
	// each keepalive cycle. It measures latency to the AWS SSM endpoint (the
	// control channel), not the full path to the instance shell.
	rttMu sync.Mutex
	onRTT func(time.Duration)
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
	c.outMsgBuf = NewMessageBuffer(50)
	c.inMsgBuf = NewMessageBuffer(50)
	c.outboundDone = make(chan struct{})

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

// detachBuffers switches the channel to unbuffered streaming and signals
// processOutboundQueue to exit; locked because that goroutine reads these fields.
func (c *SsmDataChannel) detachBuffers() {
	c.mu.Lock()
	c.inMsgBuf = nil
	c.outMsgBuf = nil
	c.handshakeCh = nil
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
			// make stream unbuffered
			c.detachBuffers()
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
	buf := make([]byte, 1536) // 1536 appears to be a default websocket max packet size
	var nr int

	for {
		nr, err = r.Read(buf)
		n += int64(nr)
		if err != nil {
			if errors.Is(err, io.EOF) {
				// the contract of ReaderFrom states that io.EOF should not be returned, just
				// exit the loop and return no error to indicate we are done
				err = nil
				log.Print("ReadFrom reader is closed")
			}
			break
		}

		if _, err = c.Write(buf[:nr]); err != nil {
			log.Printf("ReadFrom write error: %v", err)
			break
		}
	}
	return
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
// agent stalls on — it stops acknowledging past the gap, so outMsgBuf never
// drains and processOutboundQueue retransmits forever while input is dropped.
// Acknowledge and HandshakeResponse messages mirror the peer's sequence number,
// so they keep the caller-set value and do not advance the counter.
func (c *SsmDataChannel) WriteMsg(msg *AgentMessage) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	mirrorsPeerSeq := msg.MessageType == Acknowledge || msg.PayloadType == HandshakeResponse

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

	// MarshalBinary mutates msg (payload digest/length), and retransmits from
	// processOutboundQueue re-marshal the same instance the original writer may
	// still be reading, so marshaling must happen under the channel lock.
	data, err := msg.MarshalBinary()
	if err != nil {
		return 0, err
	}

	if c.outMsgBuf != nil && !mirrorsPeerSeq {
		err = c.outMsgBuf.Add(msg)
	}

	if !c.pausePub || mirrorsPeerSeq {
		_ = c.ws.SetWriteDeadline(time.Now().Add(dataChannelWriteTimeout))
		return int(msg.payloadLength), c.ws.WriteMessage(websocket.BinaryMessage, data)
	}
	return int(msg.payloadLength), err
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

	//nolint:exhaustive // we'll add more as we find them
	switch m.MessageType {
	case Acknowledge:
		if c.outMsgBuf != nil {
			c.outMsgBuf.Remove(m.SequenceNumber)
		}
	case PausePublication:
		c.mu.Lock()
		c.pausePub = true
		c.mu.Unlock()
	case StartPublication:
		c.mu.Lock()
		c.pausePub = false
		c.mu.Unlock()
	case OutputStreamData:
		switch m.PayloadType {
		case Output:
			// unbuffered - return payload directly
			if c.inMsgBuf == nil {
				_ = c.sendAcknowledgeMessage(m) // todo - handle error?
				return m.Payload, nil
			}

			// duplicate message - re-ack and discard
			if m.SequenceNumber < c.inSeqNum {
				_ = c.sendAcknowledgeMessage(m)
				return nil, nil
			}

			// queue everything else
			if err := c.inMsgBuf.Add(m); err != nil {
				return nil, err
			}
		case HandshakeRequest:
			// port forwarding session setup, we'll consider a handshake failure fatal
			if err := c.processHandshakeRequest(m); err != nil {
				return nil, err
			}
		case HandshakeComplete:
			c.handshakeOnce.Do(func() {
				if c.handshakeCh != nil {
					close(c.handshakeCh)
				}
			})
		default:
			return nil, fmt.Errorf("UNKNOWN INCOMING MSG PAYLOAD: %s\n%s", m, m.Payload)
		}
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

	if err := c.sendAcknowledgeMessage(m); err != nil {
		// todo - handle this better (retry?)
		return nil, err
	}

	return c.processInboundQueue()
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

func (c *SsmDataChannel) processInboundQueue() ([]byte, error) {
	if c.inMsgBuf == nil {
		return nil, nil
	}

	var err error
	data := new(bytes.Buffer)

	for {
		if msg := c.inMsgBuf.Get(c.inSeqNum); msg != nil {
			atomic.AddInt64(&c.inSeqNum, 1)

			if _, err = data.Write(msg.Payload); err != nil {
				break
			}

			c.inMsgBuf.Remove(msg.SequenceNumber)
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
	for {
		time.Sleep(500 * time.Millisecond)

		// Snapshot under the lock: pausePub and outMsgBuf are written by other
		// goroutines (HandleMsg, WaitForHandshakeComplete). The buffer must be
		// used outside the lock because WriteMsg locks c.mu itself.
		c.mu.Lock()
		buf, paused := c.outMsgBuf, c.pausePub
		c.mu.Unlock()

		if paused {
			continue
		}

		if buf == nil {
			return
		}

		for m := buf.Next(); m != nil; m = buf.Next() {
			// Retransmit via resendMsg, NOT WriteMsg: these messages already have
			// their sequence number and are already buffered. WriteMsg would
			// assign a NEW number, renumbering the stream and stalling the agent.
			if err := c.resendMsg(m); err != nil {
				// todo - handle error?
			}
		}
	}
}

// resendMsg retransmits an already-sequenced message from the outbound retransmit
// buffer. Unlike WriteMsg it must not assign a sequence number or re-buffer — the
// message keeps the number it was first sent with, so retransmits never renumber
// the stream.
func (c *SsmDataChannel) resendMsg(msg *AgentMessage) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pausePub {
		return nil
	}
	data, err := msg.MarshalBinary()
	if err != nil {
		return err
	}
	_ = c.ws.SetWriteDeadline(time.Now().Add(dataChannelWriteTimeout))
	return c.ws.WriteMessage(websocket.BinaryMessage, data)
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

	payload, err := json.Marshal(buildHandshakeResponse(req.RequestedClientActions))
	if err != nil {
		return err
	}

	out := NewAgentMessage()
	out.MessageType = InputStreamData
	out.SequenceNumber = msg.SequenceNumber
	out.Flags = Data
	out.PayloadType = HandshakeResponse
	out.Payload = payload

	_, err = c.WriteMsg(out)
	return err
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
func buildHandshakeResponse(actions []RequestedClientAction) *HandshakeResponsePayload {
	res := HandshakeResponsePayload{
		// seems this can be whatever we need it to be, however certain features may only be available at
		// certain client versions (must report at least version 1.1.70 to do stream muxing)
		ClientVersion:          "0.0.1",
		ProcessedClientActions: make([]ProcessedClientAction, len(actions)),
	}

	for i, a := range actions {
		action := new(ProcessedClientAction)

		if a.ActionType == SessionType {
			action.ActionType = a.ActionType
			action.ActionStatus = Success
		}

		res.ProcessedClientActions[i] = *action
	}

	return &res
}
