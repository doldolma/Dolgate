package ssmforward

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/xtaci/smux"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/ssmdatachannel"
)

// fakePortForwardAgent performs the SSM port-forwarding handshake and then echoes
// any input stream data back as output stream data, standing in for the remote host.
type fakePortForwardAgent struct {
	t          *testing.T
	echoSeq    int64
	terminated chan struct{}
	// agentVersion and sessionProperties are advertised during the SSM
	// SessionType handshake. Leaving sessionProperties empty keeps existing
	// tests on the basic port-forwarding path; setting type=LocalPortForwarding
	// with a new enough agent enables smux.
	agentVersion      string
	sessionProperties map[string]any
	mux               bool
	// earlyOutput, when set before the runner opens the channel, is streamed to the
	// client immediately after the handshake — before any downstream connection —
	// mimicking sshd's banner, which a real SSM agent forwards on session start.
	earlyOutput []byte
	// pauseAfterInputBytes makes the fake MGS send pause_publication once after
	// enough client input has passed through. The real session-manager-plugin
	// ignores this on the client side; treating it as input backpressure wedges
	// large SFTP/SSH-over-SSM streams.
	pauseAfterInputBytes int
	inputBytes           int
	pauseSent            bool

	wg      sync.WaitGroup
	connMu  sync.Mutex
	conns   []*websocket.Conn
	writeMu sync.Mutex
}

func newFakePortForwardAgent(t *testing.T) (*fakePortForwardAgent, string) {
	agent := &fakePortForwardAgent{t: t, terminated: make(chan struct{}, 1)}
	server := httptest.NewServer(http.HandlerFunc(agent.handle))
	t.Cleanup(server.Close)
	// The handler goroutine must not outlive the test: t.Errorf after completion
	// panics the whole package. httptest's Close does not wait for hijacked
	// (websocket) connections, so close them to unblock reads and join explicitly.
	t.Cleanup(func() {
		agent.connMu.Lock()
		for _, ws := range agent.conns {
			_ = ws.Close()
		}
		agent.connMu.Unlock()
		agent.wg.Wait()
	})
	return agent, "ws" + strings.TrimPrefix(server.URL, "http")
}

func (f *fakePortForwardAgent) handle(w http.ResponseWriter, r *http.Request) {
	f.wg.Add(1)
	defer f.wg.Done()

	ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
	if err != nil {
		f.t.Errorf("upgrade: %v", err)
		return
	}
	defer ws.Close()
	f.connMu.Lock()
	f.conns = append(f.conns, ws)
	f.connMu.Unlock()
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

	if len(f.earlyOutput) > 0 {
		f.echo(ws, f.earlyOutput)
	}
	if f.mux {
		f.handleMux(ws)
		return
	}

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
			f.inputBytes += len(msg.Payload)
			f.ack(ws, msg)
			if f.pauseAfterInputBytes > 0 && !f.pauseSent && f.inputBytes >= f.pauseAfterInputBytes {
				f.pauseSent = true
				f.pausePublication(ws)
			}
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

func (f *fakePortForwardAgent) handleMux(ws *websocket.Conn) {
	agentConn, dataConn := net.Pipe()
	defer agentConn.Close()
	defer dataConn.Close()

	cfg := smux.DefaultConfig()
	cfg.KeepAliveDisabled = true
	session, err := smux.Server(agentConn, cfg)
	if err != nil {
		f.t.Errorf("smux server: %v", err)
		return
	}
	defer session.Close()

	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 32*1024)
		for {
			n, err := dataConn.Read(buf)
			if n > 0 {
				f.echo(ws, buf[:n])
			}
			if err != nil {
				return
			}
		}
	}()

	go func() {
		for {
			stream, err := session.AcceptStream()
			if err != nil {
				return
			}
			go func(stream *smux.Stream) {
				defer stream.Close()
				buf := make([]byte, 32*1024)
				for {
					n, err := stream.Read(buf)
					if n > 0 {
						if writeErr := writeAll(stream, buf[:n]); writeErr != nil {
							return
						}
					}
					if err != nil {
						return
					}
				}
			}(stream)
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
			f.t.Errorf("unmarshal: %v", err)
			return
		}
		if msg.MessageType != ssmdatachannel.InputStreamData {
			continue // ignore acks
		}
		switch msg.PayloadType {
		case ssmdatachannel.Output:
			f.ack(ws, msg)
			if err := writeAll(dataConn, msg.Payload); err != nil {
				return
			}
		case ssmdatachannel.Flag:
			f.ack(ws, msg)
			select {
			case f.terminated <- struct{}{}:
			default:
			}
			return
		}
		select {
		case <-done:
			return
		default:
		}
	}
}

func (f *fakePortForwardAgent) sendHandshakeRequest(ws *websocket.Conn) {
	agentVersion := f.agentVersion
	if agentVersion == "" {
		agentVersion = "3.1.1600.0"
	}
	params := map[string]any{"SessionType": "Port"}
	if f.sessionProperties != nil {
		params["Properties"] = f.sessionProperties
	}
	payload, _ := json.Marshal(ssmdatachannel.HandshakeRequestPayload{
		AgentVersion: agentVersion,
		RequestedClientActions: []ssmdatachannel.RequestedClientAction{
			{ActionType: ssmdatachannel.SessionType, ActionParameters: params},
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

func (f *fakePortForwardAgent) pausePublication(ws *websocket.Conn) {
	msg := ssmdatachannel.NewAgentMessage()
	msg.MessageType = ssmdatachannel.PausePublication
	msg.Flags = ssmdatachannel.Data
	msg.PayloadType = ssmdatachannel.Undefined
	msg.SequenceNumber = f.echoSeq
	f.write(ws, msg)
}

func (f *fakePortForwardAgent) write(ws *websocket.Conn, msg *ssmdatachannel.AgentMessage) {
	data, err := msg.MarshalBinary()
	if err != nil {
		f.t.Errorf("marshal: %v", err)
		return
	}
	// A failed send is not a test failure: the runner may close the channel at
	// any moment (Kill right after DisconnectPort), so losing the race on the
	// final acks is expected. The test's own assertions catch real breakage.
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	if err := ws.WriteMessage(websocket.BinaryMessage, data); err != nil {
		f.t.Logf("fake agent write (benign during teardown): %v", err)
	}
}

// The SSM agent forwards sshd's banner on session start, which can arrive before
// the first downstream connection attaches. The runner must buffer and deliver it,
// otherwise the first SSH handshake reads no version banner and fails with
// "overflow reading version string" (the observed EC2 tmux first-connect failure).
func TestDataChannelForwardRunnerDeliversEarlyServerBytes(t *testing.T) {
	agent, url := newFakePortForwardAgent(t)
	banner := []byte("SSH-2.0-OpenSSH_9.0\r\n")
	agent.earlyOutput = banner

	runner, err := startDataChannelForwardRunner(protocol.SSMPortForwardStartPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		TargetID:    "i-test",
		TargetKind:  "remote-host",
		RemoteHost:  "127.0.0.1",
		TargetPort:  22,
		BindAddress: "127.0.0.1",
		BindPort:    0,
		StreamURL:   url,
		TokenValue:  "test-token",
	})
	if err != nil {
		t.Fatalf("startDataChannelForwardRunner: %v", err)
	}
	defer runner.Close()

	bindPort := runner.(bindPortAwareRunner).ActualBindPort()

	// Let the banner arrive and (without the fix) get dropped before we connect.
	time.Sleep(300 * time.Millisecond)

	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(bindPort)), 5*time.Second)
	if err != nil {
		t.Fatalf("dial local tunnel: %v", err)
	}
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	got := make([]byte, len(banner))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("first connection never received the pre-connect server banner (dropped): %v", err)
	}
	if string(got) != string(banner) {
		t.Fatalf("banner = %q, want %q", got, banner)
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

func TestDataChannelForwardRunnerUsesSmuxForSupportedLocalPortForwarding(t *testing.T) {
	agent, url := newFakePortForwardAgent(t)
	agent.mux = true
	agent.agentVersion = "3.1.1600.0"
	agent.sessionProperties = map[string]any{
		"portNumber": "22",
		"type":       "LocalPortForwarding",
	}

	runner, err := startDataChannelForwardRunner(protocol.SSMPortForwardStartPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		TargetID:    "i-test",
		TargetKind:  "remote-host",
		RemoteHost:  "127.0.0.1",
		TargetPort:  22,
		BindAddress: "127.0.0.1",
		BindPort:    0,
		StreamURL:   url,
		TokenValue:  "test-token",
	})
	if err != nil {
		t.Fatalf("startDataChannelForwardRunner: %v", err)
	}
	defer runner.Close()

	if _, ok := runner.(*datachannelMuxForwardRunner); !ok {
		t.Fatalf("runner type = %T, want *datachannelMuxForwardRunner", runner)
	}

	bindPort := runner.(bindPortAwareRunner).ActualBindPort()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(bindPort)), 5*time.Second)
	if err != nil {
		t.Fatalf("dial local tunnel: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))

	payload := bytes.Repeat([]byte("smux-ssm-transfer-"), 32*1024)
	got := make([]byte, len(payload))
	readDone := make(chan error, 1)
	go func() {
		_, err := io.ReadFull(conn, got)
		readDone <- err
	}()

	writeDone := make(chan error, 1)
	go func() {
		writeDone <- writeAll(conn, payload)
	}()

	select {
	case err := <-writeDone:
		if err != nil {
			t.Fatalf("write smux payload: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("write smux payload timed out")
	}

	select {
	case err := <-readDone:
		if err != nil {
			t.Fatalf("read smux echo: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("read smux echo timed out")
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("smux echo payload changed")
	}
}

func TestDataChannelForwardRunnerIgnoresPausePublicationForClientInput(t *testing.T) {
	agent, url := newFakePortForwardAgent(t)
	agent.pauseAfterInputBytes = 4096

	runner, err := startDataChannelForwardRunner(protocol.SSMPortForwardStartPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		TargetID:    "i-test",
		TargetKind:  "remote-host",
		RemoteHost:  "127.0.0.1",
		TargetPort:  22,
		BindAddress: "127.0.0.1",
		BindPort:    0,
		StreamURL:   url,
		TokenValue:  "test-token",
	})
	if err != nil {
		t.Fatalf("startDataChannelForwardRunner: %v", err)
	}
	defer runner.Close()

	bindPort := runner.(bindPortAwareRunner).ActualBindPort()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(bindPort)), 5*time.Second)
	if err != nil {
		t.Fatalf("dial local tunnel: %v", err)
	}
	defer conn.Close()

	payload := bytes.Repeat([]byte{0x5a}, 128*1024)
	readDone := make(chan error, 1)
	got := make([]byte, len(payload))
	go func() {
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, err := io.ReadFull(conn, got)
		readDone <- err
	}()

	writeDone := make(chan error, 1)
	go func() {
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		written, err := conn.Write(payload)
		if err == nil && written != len(payload) {
			err = io.ErrShortWrite
		}
		writeDone <- err
	}()

	select {
	case err := <-writeDone:
		if err != nil {
			t.Fatalf("write payload through tunnel: %v", err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("write blocked after pause_publication")
	}

	select {
	case err := <-readDone:
		if err != nil {
			t.Fatalf("read echoed payload after pause_publication: %v", err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("read blocked after pause_publication")
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("echoed payload changed after pause_publication")
	}
	if !agent.pauseSent {
		t.Fatal("fake agent did not send pause_publication")
	}
}
