package awssession

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/ssmdatachannel"
)

type fakeAgentEvent struct {
	kind    string // "open", "input", "size", "terminate"
	payload []byte
}

// fakeSsmAgent speaks just enough of the data-channel protocol to exercise the
// runner: it acks input, echoes it back as output, and records what it saw.
type fakeSsmAgent struct {
	t       *testing.T
	events  chan fakeAgentEvent
	closeCh chan struct{} // closed when the client connection ends
	sendCh  chan *ssmdatachannel.AgentMessage
	echoSeq int64
}

func newFakeSsmAgent(t *testing.T) (*fakeSsmAgent, string) {
	agent := &fakeSsmAgent{
		t:       t,
		events:  make(chan fakeAgentEvent, 32),
		closeCh: make(chan struct{}),
		sendCh:  make(chan *ssmdatachannel.AgentMessage, 8),
	}
	server := httptest.NewServer(http.HandlerFunc(agent.handle))
	t.Cleanup(server.Close)
	return agent, "ws" + strings.TrimPrefix(server.URL, "http")
}

func (f *fakeSsmAgent) handle(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		f.t.Errorf("upgrade failed: %v", err)
		return
	}
	defer ws.Close()
	defer close(f.closeCh)

	_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, data, err := ws.ReadMessage()
	if err != nil {
		f.t.Errorf("reading channel-open: %v", err)
		return
	}
	f.events <- fakeAgentEvent{kind: "open", payload: append([]byte(nil), data...)}

	writeDone := make(chan struct{})
	defer func() { close(f.sendCh); <-writeDone }()
	go func() {
		defer close(writeDone)
		for msg := range f.sendCh {
			data, err := msg.MarshalBinary()
			if err != nil {
				f.t.Errorf("marshal outgoing: %v", err)
				return
			}
			if err := ws.WriteMessage(websocket.BinaryMessage, data); err != nil {
				return
			}
		}
	}()

	for {
		_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))
		_, data, err := ws.ReadMessage()
		if err != nil {
			return
		}
		msg := new(ssmdatachannel.AgentMessage)
		if err := msg.UnmarshalBinary(data); err != nil {
			f.t.Errorf("unmarshal incoming: %v", err)
			return
		}

		switch msg.MessageType {
		case ssmdatachannel.Acknowledge:
			// ignore
		case ssmdatachannel.InputStreamData:
			switch msg.PayloadType {
			case ssmdatachannel.Output:
				f.ack(msg)
				f.events <- fakeAgentEvent{kind: "input", payload: append([]byte(nil), msg.Payload...)}
				f.echo(msg.Payload)
			case ssmdatachannel.Size:
				f.ack(msg)
				f.events <- fakeAgentEvent{kind: "size", payload: append([]byte(nil), msg.Payload...)}
			case ssmdatachannel.Flag:
				f.ack(msg)
				if len(msg.Payload) == 4 &&
					ssmdatachannel.PayloadTypeFlag(binary.BigEndian.Uint32(msg.Payload)) == ssmdatachannel.TerminateSession {
					f.events <- fakeAgentEvent{kind: "terminate"}
				}
			default:
				f.t.Errorf("unexpected input payload type: %d", msg.PayloadType)
			}
		default:
			f.t.Errorf("unexpected message type: %s", msg.MessageType)
		}
	}
}

func (f *fakeSsmAgent) ack(received *ssmdatachannel.AgentMessage) {
	payload, _ := json.Marshal(map[string]any{
		"AcknowledgedMessageType":           received.MessageType,
		"AcknowledgedMessageSequenceNumber": received.SequenceNumber,
		"IsSequentialMessage":               true,
	})
	msg := ssmdatachannel.NewAgentMessage()
	msg.MessageType = ssmdatachannel.Acknowledge
	msg.Flags = ssmdatachannel.Ack
	msg.PayloadType = ssmdatachannel.Undefined
	msg.SequenceNumber = received.SequenceNumber
	msg.Payload = payload
	f.send(msg)
}

func (f *fakeSsmAgent) echo(payload []byte) {
	msg := ssmdatachannel.NewAgentMessage()
	msg.MessageType = ssmdatachannel.OutputStreamData
	msg.Flags = ssmdatachannel.Data
	msg.PayloadType = ssmdatachannel.Output
	msg.SequenceNumber = f.echoSeq
	msg.Payload = append([]byte(nil), payload...)
	f.echoSeq++
	f.send(msg)
}

func (f *fakeSsmAgent) channelClosed() {
	msg := ssmdatachannel.NewAgentMessage()
	msg.MessageType = ssmdatachannel.ChannelClosed
	msg.Flags = ssmdatachannel.Data
	msg.SequenceNumber = f.echoSeq
	f.echoSeq++
	payload, _ := json.Marshal(map[string]any{"SessionId": "sess-1"})
	msg.Payload = payload
	f.send(msg)
}

func (f *fakeSsmAgent) send(msg *ssmdatachannel.AgentMessage) {
	select {
	case f.sendCh <- msg:
	case <-time.After(5 * time.Second):
		f.t.Error("timed out queueing message to client")
	}
}

func (f *fakeSsmAgent) waitFor(t *testing.T, kind string) fakeAgentEvent {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case event := <-f.events:
			if event.kind == kind {
				return event
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q event", kind)
		}
	}
}

func startTestDataChannelRunner(t *testing.T, url string) sessionRunner {
	t.Helper()
	t.Setenv("DOLSSH_E2E_FAKE_AWS_SESSION", "")
	runner, err := defaultRunnerFactory(protocol.AWSConnectPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		InstanceID:  "i-test",
		Cols:        100,
		Rows:        30,
		StreamURL:   url,
		TokenValue:  "test-token",
	})
	if err != nil {
		t.Fatalf("defaultRunnerFactory: %v", err)
	}
	return runner
}

func TestDataChannelRunnerEchoAndControls(t *testing.T) {
	agent, url := newFakeSsmAgent(t)
	runner := startTestDataChannelRunner(t, url)

	agent.waitFor(t, "open")

	// The runner sends the initial terminal size right after opening.
	initialSize := agent.waitFor(t, "size")
	var dims map[string]uint32
	if err := json.Unmarshal(initialSize.payload, &dims); err != nil {
		t.Fatalf("initial size payload: %v", err)
	}
	if dims["rows"] != 30 || dims["cols"] != 100 {
		t.Fatalf("initial size = %v, want rows=30 cols=100", dims)
	}

	if err := runner.Write([]byte("ls\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	input := agent.waitFor(t, "input")
	if string(input.payload) != "ls\n" {
		t.Fatalf("agent received input %q, want %q", input.payload, "ls\n")
	}

	// The agent echoes input back; it must come out of the runner's stream.
	stream := runner.Streams()[0]
	buffer := make([]byte, 256)
	n, err := stream.Read(buffer)
	if err != nil {
		t.Fatalf("stream read: %v", err)
	}
	if string(buffer[:n]) != "ls\n" {
		t.Fatalf("stream output %q, want %q", buffer[:n], "ls\n")
	}

	if err := runner.SendControlSignal("interrupt"); err != nil {
		t.Fatalf("SendControlSignal: %v", err)
	}
	control := agent.waitFor(t, "input")
	if len(control.payload) != 1 || control.payload[0] != 0x03 {
		t.Fatalf("control payload = %v, want [0x03]", control.payload)
	}
	// The fake agent echoes everything, including the control byte; drain it so
	// the pump never stalls on pipe backpressure.
	n, err = stream.Read(buffer)
	if err != nil {
		t.Fatalf("stream read after control: %v", err)
	}
	if string(buffer[:n]) != "\x03" {
		t.Fatalf("echoed control = %q, want \\x03", buffer[:n])
	}

	if err := runner.Resize(80, 24); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	resize := agent.waitFor(t, "size")
	if err := json.Unmarshal(resize.payload, &dims); err != nil {
		t.Fatalf("resize payload: %v", err)
	}
	if dims["rows"] != 24 || dims["cols"] != 80 {
		t.Fatalf("resize = %v, want rows=24 cols=80", dims)
	}

	if err := runner.Kill(); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	exit, waitErr := runner.Wait()
	if waitErr != nil {
		t.Fatalf("Wait after Kill returned error: %v", waitErr)
	}
	if exit.ExitCode != 0 || exit.Signal != "" {
		t.Fatalf("Wait after Kill = %+v, want clean exit", exit)
	}
}

func TestDataChannelRunnerRemoteClose(t *testing.T) {
	agent, url := newFakeSsmAgent(t)
	runner := startTestDataChannelRunner(t, url)

	agent.waitFor(t, "open")
	agent.waitFor(t, "size")

	agent.channelClosed()

	exit, waitErr := runner.Wait()
	if waitErr != nil {
		t.Fatalf("Wait after remote close returned error: %v", waitErr)
	}
	if exit.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", exit.ExitCode)
	}

	stream := runner.Streams()[0]
	buffer := make([]byte, 64)
	if _, err := stream.Read(buffer); err != io.EOF {
		t.Fatalf("stream read after close = %v, want io.EOF", err)
	}
	_ = runner.Close()
}
