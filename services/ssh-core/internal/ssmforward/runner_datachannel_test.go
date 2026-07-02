package ssmforward

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/ssmdatachannel"
)

// fakePortForwardAgent performs the SSM port-forwarding handshake and then echoes
// any input stream data back as output stream data, standing in for the remote host.
type fakePortForwardAgent struct {
	t        *testing.T
	echoSeq  int64
	terminated chan struct{}
}

func newFakePortForwardAgent(t *testing.T) (*fakePortForwardAgent, string) {
	agent := &fakePortForwardAgent{t: t, terminated: make(chan struct{}, 1)}
	server := httptest.NewServer(http.HandlerFunc(agent.handle))
	t.Cleanup(server.Close)
	return agent, "ws" + strings.TrimPrefix(server.URL, "http")
}

func (f *fakePortForwardAgent) handle(w http.ResponseWriter, r *http.Request) {
	ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
	if err != nil {
		f.t.Errorf("upgrade: %v", err)
		return
	}
	defer ws.Close()
	_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))

	if _, _, err := ws.ReadMessage(); err != nil { // channel-open JSON
		f.t.Errorf("read channel-open: %v", err)
		return
	}

	f.sendHandshakeRequest(ws)

	// Read until we get the client's HandshakeResponse (ignore its acks).
	for {
		_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))
		_, data, err := ws.ReadMessage()
		if err != nil {
			f.t.Errorf("read handshake response: %v", err)
			return
		}
		msg := new(ssmdatachannel.AgentMessage)
		if err := msg.UnmarshalBinary(data); err != nil {
			f.t.Errorf("unmarshal: %v", err)
			return
		}
		if msg.MessageType == ssmdatachannel.InputStreamData &&
			msg.PayloadType == ssmdatachannel.HandshakeResponse {
			break
		}
	}

	f.sendHandshakeComplete(ws)

	// Echo loop.
	for {
		_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))
		_, data, err := ws.ReadMessage()
		if err != nil {
			return
		}
		msg := new(ssmdatachannel.AgentMessage)
		if err := msg.UnmarshalBinary(data); err != nil {
			f.t.Errorf("unmarshal: %v", err)
			return
		}
		if msg.MessageType != ssmdatachannel.InputStreamData {
			continue // ignore acks
		}
		switch msg.PayloadType {
		case ssmdatachannel.Output:
			f.ack(ws, msg)
			f.echo(ws, msg.Payload)
		case ssmdatachannel.Flag:
			// DisconnectPort or TerminateSession.
			f.ack(ws, msg)
			select {
			case f.terminated <- struct{}{}:
			default:
			}
		}
	}
}

func (f *fakePortForwardAgent) sendHandshakeRequest(ws *websocket.Conn) {
	payload, _ := json.Marshal(ssmdatachannel.HandshakeRequestPayload{
		AgentVersion: "3.1.1600.0",
		RequestedClientActions: []ssmdatachannel.RequestedClientAction{
			{ActionType: ssmdatachannel.SessionType, ActionParameters: map[string]any{"SessionType": "Port"}},
		},
	})
	msg := ssmdatachannel.NewAgentMessage()
	msg.MessageType = ssmdatachannel.OutputStreamData
	msg.Flags = ssmdatachannel.Data
	msg.PayloadType = ssmdatachannel.HandshakeRequest
	msg.SequenceNumber = f.echoSeq
	msg.Payload = payload
	f.echoSeq++
	f.write(ws, msg)
}

func (f *fakePortForwardAgent) sendHandshakeComplete(ws *websocket.Conn) {
	payload, _ := json.Marshal(ssmdatachannel.HandshakeCompletePayload{CustomerMessage: "ready"})
	msg := ssmdatachannel.NewAgentMessage()
	msg.MessageType = ssmdatachannel.OutputStreamData
	msg.Flags = ssmdatachannel.Data
	msg.PayloadType = ssmdatachannel.HandshakeComplete
	msg.SequenceNumber = f.echoSeq
	msg.Payload = payload
	f.echoSeq++
	f.write(ws, msg)
}

func (f *fakePortForwardAgent) ack(ws *websocket.Conn, received *ssmdatachannel.AgentMessage) {
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
	f.write(ws, msg)
}

func (f *fakePortForwardAgent) echo(ws *websocket.Conn, payload []byte) {
	msg := ssmdatachannel.NewAgentMessage()
	msg.MessageType = ssmdatachannel.OutputStreamData
	msg.Flags = ssmdatachannel.Data
	msg.PayloadType = ssmdatachannel.Output
	msg.SequenceNumber = f.echoSeq
	msg.Payload = append([]byte(nil), payload...)
	f.echoSeq++
	f.write(ws, msg)
}

func (f *fakePortForwardAgent) write(ws *websocket.Conn, msg *ssmdatachannel.AgentMessage) {
	data, err := msg.MarshalBinary()
	if err != nil {
		f.t.Errorf("marshal: %v", err)
		return
	}
	if err := ws.WriteMessage(websocket.BinaryMessage, data); err != nil {
		f.t.Errorf("write: %v", err)
	}
}

func TestDataChannelForwardRunnerRoundTrip(t *testing.T) {
	agent, url := newFakePortForwardAgent(t)

	runner, err := startDataChannelForwardRunner(protocol.SSMPortForwardStartPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		TargetID:    "i-test",
		TargetKind:  "remote-host",
		RemoteHost:  "127.0.0.1",
		TargetPort:  5432,
		BindAddress: "127.0.0.1",
		BindPort:    0, // OS-assigned
		StreamURL:   url,
		TokenValue:  "test-token",
	})
	if err != nil {
		t.Fatalf("startDataChannelForwardRunner: %v", err)
	}
	defer runner.Close()

	awareRunner, ok := runner.(bindPortAwareRunner)
	if !ok {
		t.Fatal("runner is not bind-port aware")
	}
	bindPort := awareRunner.ActualBindPort()
	if bindPort <= 0 {
		t.Fatalf("actual bind port = %d, want > 0", bindPort)
	}

	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(bindPort)), 5*time.Second)
	if err != nil {
		t.Fatalf("dial local tunnel: %v", err)
	}
	defer conn.Close()

	want := []byte("SELECT 1;\n")
	if _, err := conn.Write(want); err != nil {
		t.Fatalf("write to tunnel: %v", err)
	}

	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	got := make([]byte, len(want))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read echo from tunnel: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("tunnel echo = %q, want %q", got, want)
	}

	// Closing the downstream connection should trigger a DisconnectPort to the agent.
	_ = conn.Close()
	select {
	case <-agent.terminated:
	case <-time.After(5 * time.Second):
		t.Fatal("agent did not observe DisconnectPort/Terminate after connection close")
	}

	if err := runner.Kill(); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	exit, waitErr := runner.Wait()
	if waitErr != nil {
		t.Fatalf("Wait after Kill: %v", waitErr)
	}
	if exit.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", exit.ExitCode)
	}
}
