package ssmdatachannel_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
	return f, srv
}

func (f *fakeAgentServer) handle(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		f.t.Errorf("upgrade failed: %v", err)
		return
	}
	defer ws.Close()

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
				if err := f.ack(ws, msg); err != nil {
					f.t.Errorf("sending ack: %v", err)
					return
				}
				if err := f.echo(ws, msg.Payload); err != nil {
					f.t.Errorf("sending echo: %v", err)
					return
				}
			case ssmdatachannel.Size:
				f.sizeMsgs <- string(msg.Payload)
				if err := f.ack(ws, msg); err != nil {
					f.t.Errorf("sending size ack: %v", err)
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
