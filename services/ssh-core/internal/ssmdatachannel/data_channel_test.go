package ssmdatachannel_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"dolssh/services/ssh-core/internal/ssmdatachannel"
)

const testToken = "test-token-value"

type channelOpenMessage struct {
	MessageSchemaVersion string
	RequestId            string
	TokenValue           string
	ClientId             string
	ClientVersion        string
}

// fakeAgentServer speaks just enough of the SSM agent data-channel protocol for a
// round-trip test: it validates the channel-open JSON, acknowledges every
// input_stream_data message, and echoes its payload back as output_stream_data.
type fakeAgentServer struct {
	t          *testing.T
	openMsgs   chan channelOpenMessage
	sizeMsgs   chan string
	inputSeqs  chan int64
	echoSeqNum int64
	// noAck makes the agent record input sequence numbers but never acknowledge
	// them, so the client's retransmit loop keeps re-sending unacked messages.
	noAck bool

	wg     sync.WaitGroup
	connMu sync.Mutex
	conns  []*websocket.Conn
}

func newFakeAgentServer(t *testing.T) (*fakeAgentServer, *httptest.Server) {
	f := &fakeAgentServer{
		t:         t,
		openMsgs:  make(chan channelOpenMessage, 1),
		sizeMsgs:  make(chan string, 4),
		inputSeqs: make(chan int64, 16),
	}
	srv := httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(srv.Close)
	// The handler goroutine must not outlive the test: t.Errorf after completion
	// panics the whole package. httptest's Close does not wait for hijacked
	// (websocket) connections, so close them to unblock reads and join explicitly.
	t.Cleanup(func() {
		f.connMu.Lock()
		for _, ws := range f.conns {
			_ = ws.Close()
		}
		f.connMu.Unlock()
		f.wg.Wait()
	})
	return f, srv
}

func (f *fakeAgentServer) handle(w http.ResponseWriter, r *http.Request) {
	f.wg.Add(1)
	defer f.wg.Done()

	upgrader := websocket.Upgrader{}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		f.t.Errorf("upgrade failed: %v", err)
		return
	}
	defer ws.Close()
	f.connMu.Lock()
	f.conns = append(f.conns, ws)
	f.connMu.Unlock()

	_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))

	// First message is the channel-open JSON (text frame).
	msgType, data, err := ws.ReadMessage()
	if err != nil {
		f.t.Errorf("reading channel-open message: %v", err)
		return
	}
	if msgType != websocket.TextMessage {
		f.t.Errorf("channel-open message type = %d, want text", msgType)
		return
	}
	var open channelOpenMessage
	if err := json.Unmarshal(data, &open); err != nil {
		f.t.Errorf("channel-open unmarshal: %v", err)
		return
	}
	f.openMsgs <- open

	for {
		_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))
		_, data, err := ws.ReadMessage()
		if err != nil {
			return // client closed
		}

		msg := new(ssmdatachannel.AgentMessage)
		if err := msg.UnmarshalBinary(data); err != nil {
			f.t.Errorf("agent message unmarshal: %v", err)
			return
		}

		switch msg.MessageType {
		case ssmdatachannel.Acknowledge:
			// The client acknowledges everything, including our acks. Ignore.
		case ssmdatachannel.InputStreamData:
			switch msg.PayloadType {
			case ssmdatachannel.Output:
				f.inputSeqs <- msg.SequenceNumber
				if f.noAck {
					continue
				}
				// Send failures are not test failures: the client may close the
				// channel right after the test saw what it was waiting for, so
				// losing the race on trailing acks/echoes is expected.
				if err := f.ack(ws, msg); err != nil {
					f.t.Logf("fake agent ack (benign during teardown): %v", err)
					return
				}
				if err := f.echo(ws, msg.Payload); err != nil {
					f.t.Logf("fake agent echo (benign during teardown): %v", err)
					return
				}
			case ssmdatachannel.Size:
				f.sizeMsgs <- string(msg.Payload)
				if err := f.ack(ws, msg); err != nil {
					f.t.Logf("fake agent size ack (benign during teardown): %v", err)
					return
				}
			default:
				f.t.Errorf("unexpected input payload type: %d", msg.PayloadType)
			}
		default:
			f.t.Errorf("unexpected message type: %s", msg.MessageType)
		}
	}
}

// ack mirrors the service behavior the client relies on: the acknowledge message's own
// SequenceNumber carries the acknowledged sequence number.
func (f *fakeAgentServer) ack(ws *websocket.Conn, received *ssmdatachannel.AgentMessage) error {
	payload, err := json.Marshal(map[string]any{
		"AcknowledgedMessageType":           received.MessageType,
		"AcknowledgedMessageSequenceNumber": received.SequenceNumber,
		"IsSequentialMessage":               true,
	})
	if err != nil {
		return err
	}

	msg := ssmdatachannel.NewAgentMessage()
	msg.MessageType = ssmdatachannel.Acknowledge
	msg.Flags = ssmdatachannel.Ack
	msg.PayloadType = ssmdatachannel.Undefined
	msg.SequenceNumber = received.SequenceNumber
	msg.Payload = payload
	return f.writeMsg(ws, msg)
}

func (f *fakeAgentServer) echo(ws *websocket.Conn, payload []byte) error {
	msg := ssmdatachannel.NewAgentMessage()
	msg.MessageType = ssmdatachannel.OutputStreamData
	msg.Flags = ssmdatachannel.Data
	msg.PayloadType = ssmdatachannel.Output
	msg.SequenceNumber = f.echoSeqNum
	msg.Payload = append([]byte(nil), payload...)
	f.echoSeqNum++
	return f.writeMsg(ws, msg)
}

func (f *fakeAgentServer) writeMsg(ws *websocket.Conn, msg *ssmdatachannel.AgentMessage) error {
	data, err := msg.MarshalBinary()
	if err != nil {
		return err
	}
	return ws.WriteMessage(websocket.BinaryMessage, data)
}

func wsURL(srv *httptest.Server) string {
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func TestReadReturnsBufferTooSmallForOversizedFrame(t *testing.T) {
	largePayload := bytes.Repeat([]byte("x"), 64*1024)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer ws.Close()
		if _, _, err := ws.ReadMessage(); err != nil { // channel-open JSON
			t.Errorf("read channel-open: %v", err)
			return
		}

		msg := ssmdatachannel.NewAgentMessage()
		msg.MessageType = ssmdatachannel.OutputStreamData
		msg.Flags = ssmdatachannel.Data
		msg.PayloadType = ssmdatachannel.Output
		msg.Payload = largePayload
		data, err := msg.MarshalBinary()
		if err != nil {
			t.Errorf("marshal large frame: %v", err)
			return
		}
		if err := ws.WriteMessage(websocket.BinaryMessage, data); err != nil {
			t.Errorf("write large frame: %v", err)
		}
	}))
	defer srv.Close()

	dc := new(ssmdatachannel.SsmDataChannel)
	if err := dc.OpenWithSessionToken(wsURL(srv), testToken); err != nil {
		t.Fatalf("OpenWithSessionToken: %v", err)
	}
	defer dc.Close()

	buf := make([]byte, 128)
	n, err := dc.Read(buf)
	if !errors.Is(err, ssmdatachannel.ErrReadBufferTooSmall) {
		t.Fatalf("Read error = %v, want ErrReadBufferTooSmall", err)
	}
	if n != len(buf) {
		t.Fatalf("Read copied %d bytes, want %d", n, len(buf))
	}
}

func TestWaitForHandshakeCompleteHonorsContext(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer ws.Close()
		if _, _, err := ws.ReadMessage(); err != nil { // channel-open JSON
			t.Errorf("read channel-open: %v", err)
			return
		}
		<-release
	}))
	defer srv.Close()
	t.Cleanup(func() { close(release) })

	dc := new(ssmdatachannel.SsmDataChannel)
	if err := dc.OpenWithSessionToken(wsURL(srv), testToken); err != nil {
		t.Fatalf("OpenWithSessionToken: %v", err)
	}
	defer dc.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	err := dc.WaitForHandshakeComplete(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("WaitForHandshakeComplete error = %v, want context deadline", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("WaitForHandshakeComplete ignored context; elapsed %s", elapsed)
	}
}

func TestOpenWithSessionTokenEchoRoundTrip(t *testing.T) {
	server, srv := newFakeAgentServer(t)

	dc := new(ssmdatachannel.SsmDataChannel)
	if err := dc.OpenWithSessionToken(wsURL(srv), testToken); err != nil {
		t.Fatalf("OpenWithSessionToken: %v", err)
	}
	defer dc.Close()

	select {
	case open := <-server.openMsgs:
		if open.TokenValue != testToken {
			t.Fatalf("channel-open TokenValue = %q, want %q", open.TokenValue, testToken)
		}
		if open.MessageSchemaVersion != "1.0" {
			t.Fatalf("channel-open MessageSchemaVersion = %q, want \"1.0\"", open.MessageSchemaVersion)
		}
		if open.RequestId == "" {
			t.Fatal("channel-open RequestId is empty")
		}
		if open.ClientId == "" {
			t.Fatal("channel-open ClientId is empty")
		}
		if open.ClientVersion == "" {
			t.Fatal("channel-open ClientVersion is empty")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for channel-open message")
	}

	payloads := make(chan []byte, 16)
	readErrs := make(chan error, 1)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := dc.Read(buf)
			if err != nil {
				readErrs <- err
				return
			}
			payload, err := dc.HandleMsg(buf[:n])
			if err != nil {
				if errors.Is(err, io.EOF) {
					return
				}
				readErrs <- err
				return
			}
			if len(payload) > 0 {
				payloads <- append([]byte(nil), payload...)
			}
		}
	}()

	want := []byte("hello dolgate")
	if _, err := dc.Write(want); err != nil {
		t.Fatalf("Write: %v", err)
	}

	select {
	case got := <-payloads:
		if !bytes.Equal(got, want) {
			t.Fatalf("echo payload = %q, want %q", got, want)
		}
	case err := <-readErrs:
		t.Fatalf("read loop error before echo: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for echo payload")
	}

	select {
	case seq := <-server.inputSeqs:
		if seq != 0 {
			t.Fatalf("first input sequence number = %d, want 0", seq)
		}
	default:
		t.Fatal("server did not record the input message")
	}

	if err := dc.SetTerminalSize(40, 120); err != nil {
		t.Fatalf("SetTerminalSize: %v", err)
	}
	select {
	case size := <-server.sizeMsgs:
		var dims map[string]uint32
		if err := json.Unmarshal([]byte(size), &dims); err != nil {
			t.Fatalf("size payload unmarshal: %v (payload %q)", err, size)
		}
		if dims["rows"] != 40 || dims["cols"] != 120 {
			t.Fatalf("size payload = %v, want rows=40 cols=120", dims)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for terminal-size message")
	}
}

// TestConcurrentWritesAssignGaplessSequenceNumbers is the regression test for the
// input-freeze bug: when several goroutines write at once (terminal-size + shell
// integration init + autocomplete probe + keystrokes at session start), the
// outbound sequence numbers must be assigned in wire order with no gaps. A gap
// makes the real SSM agent stop acknowledging past it, so the retransmit buffer
// never drains and input stops reaching the shell. WriteMsg assigns the number
// under the channel lock precisely so this can't happen.
func TestConcurrentWritesAssignGaplessSequenceNumbers(t *testing.T) {
	server, srv := newFakeAgentServer(t)

	dc := new(ssmdatachannel.SsmDataChannel)
	if err := dc.OpenWithSessionToken(wsURL(srv), testToken); err != nil {
		t.Fatalf("OpenWithSessionToken: %v", err)
	}
	defer dc.Close()

	// Drain the channel so the agent's acks/echoes are consumed; otherwise the
	// client socket backpressures and the agent stops reading input.
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := dc.Read(buf)
			if err != nil {
				return
			}
			_, _ = dc.HandleMsg(buf[:n])
		}
	}()

	const goroutines, perGoroutine = 8, 4
	total := goroutines * perGoroutine

	// Collect the sequence numbers the agent received, concurrently with the
	// writes, so acks flow promptly and legitimate retransmits stay rare.
	seen := make(map[int64]bool)
	var seenMu sync.Mutex
	enough := make(chan struct{})
	go func() {
		for {
			seq := <-server.inputSeqs
			seenMu.Lock()
			seen[seq] = true
			done := len(seen) >= total
			seenMu.Unlock()
			if done {
				close(enough)
				return
			}
		}
	}()

	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for k := 0; k < perGoroutine; k++ {
				if _, err := dc.Write([]byte{byte('a' + g)}); err != nil {
					t.Errorf("Write: %v", err)
					return
				}
			}
		}(g)
	}
	wg.Wait()

	select {
	case <-enough:
	case <-time.After(5 * time.Second):
		seenMu.Lock()
		defer seenMu.Unlock()
		t.Fatalf("saw %d/%d distinct sequence numbers: %v", len(seen), total, seen)
	}

	// Every sequence number 0..total-1 must be present — no gaps.
	seenMu.Lock()
	defer seenMu.Unlock()
	for seq := int64(0); seq < int64(total); seq++ {
		if !seen[seq] {
			t.Fatalf("missing sequence number %d (gap stalls the SSM stream); saw %v", seq, seen)
		}
	}
}

// TestRetransmitPreservesSequenceNumbers guards two datachannel failure modes:
// retransmits must keep their original sequence number, and the resend scheduler
// must not replay the whole unacked buffer on every tick. Replaying everything
// turns a large SFTP upload into duplicate datachannel traffic under load.
func TestRetransmitPreservesSequenceNumbers(t *testing.T) {
	// Construct with noAck set before the server starts so the retransmit loop
	// keeps firing (no data race on the flag: it is set before any handler runs).
	f := &fakeAgentServer{
		t:         t,
		noAck:     true,
		openMsgs:  make(chan channelOpenMessage, 1),
		sizeMsgs:  make(chan string, 4),
		inputSeqs: make(chan int64, 64),
	}
	srv := httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(srv.Close)
	t.Cleanup(func() {
		f.connMu.Lock()
		for _, ws := range f.conns {
			_ = ws.Close()
		}
		f.connMu.Unlock()
		f.wg.Wait()
	})

	dc := new(ssmdatachannel.SsmDataChannel)
	if err := dc.OpenWithSessionToken(wsURL(srv), testToken); err != nil {
		t.Fatalf("OpenWithSessionToken: %v", err)
	}
	defer dc.Close()

	// Two writes: seq 0 (Syn) and seq 1. The agent never acks, so only the
	// oldest unacked message (seq 0) should be retransmitted.
	if _, err := dc.Write([]byte("a")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := dc.Write([]byte("b")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// Collect what the agent receives across several retransmit cycles.
	received := make([]int64, 0, 16)
	deadline := time.After(2600 * time.Millisecond)
	for {
		select {
		case seq := <-f.inputSeqs:
			received = append(received, seq)
			continue
		case <-deadline:
		}
		break
	}

	if len(received) < 4 {
		t.Fatalf("expected retransmits (>=4 receives), got %d: %v", len(received), received)
	}
	// Every received sequence number must be 0 or 1 — retransmits reuse the
	// original numbers and never climb.
	counts := make(map[int64]int)
	for _, seq := range received {
		counts[seq]++
		if seq != 0 && seq != 1 {
			t.Fatalf("retransmit renumbered the stream: saw seq %d (want only 0/1), full: %v", seq, received)
		}
	}
	if counts[0] < 3 {
		t.Fatalf("oldest unacked message was not retransmitted enough: counts=%v received=%v", counts, received)
	}
	if counts[1] != 1 {
		t.Fatalf("non-oldest unacked message was retransmitted; counts=%v received=%v", counts, received)
	}
}
