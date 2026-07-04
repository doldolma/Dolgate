package http

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"dolssh/services/ssh-core/pkg/coretypes"
)

// fakeTunnelCore stands in for ssh-core's in-process SSM forwarder: on
// StartSSMPortForward it binds the requested local port and echoes bytes, which
// mimics the port-forward tunnel landing on the instance's sshd.
type fakeTunnelCore struct {
	mu        sync.Mutex
	listeners map[string]net.Listener
	startErr  error
	stopped   map[string]bool
}

func newFakeTunnelCore() *fakeTunnelCore {
	return &fakeTunnelCore{listeners: map[string]net.Listener{}, stopped: map[string]bool{}}
}

func (c *fakeTunnelCore) StartSSMPortForward(endpointID, _ string, payload coretypes.SSMPortForwardStartPayload) error {
	if c.startErr != nil {
		return c.startErr
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", payload.BindPort))
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.listeners[endpointID] = ln
	c.mu.Unlock()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	return nil
}

func (c *fakeTunnelCore) StopSSMPortForward(endpointID, _ string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopped[endpointID] = true
	if ln := c.listeners[endpointID]; ln != nil {
		delete(c.listeners, endpointID)
		return ln.Close()
	}
	return nil
}

func (c *fakeTunnelCore) Shutdown() {}

func (c *fakeTunnelCore) tunnelCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.listeners)
}

type fakeTunnelTokenIssuer struct{}

func (fakeTunnelTokenIssuer) IssueShellSession(context.Context, string, map[string]string, string) (awsSsmSessionToken, error) {
	return awsSsmSessionToken{SessionID: "s", StreamURL: "u", TokenValue: "t"}, nil
}

func (fakeTunnelTokenIssuer) IssuePortForwardSession(context.Context, string, map[string]string, string, int, int) (awsSsmSessionToken, error) {
	return awsSsmSessionToken{SessionID: "s", StreamURL: "u", TokenValue: "t"}, nil
}

type fakeTunnelEic struct {
	err    error
	mu     sync.Mutex
	gotPub string
	gotReq awsSftpCreateSessionRequest
}

func (e *fakeTunnelEic) SendSSHPublicKey(_ context.Context, request awsSftpCreateSessionRequest, publicKey string) error {
	e.mu.Lock()
	e.gotPub = publicKey
	e.gotReq = request
	e.mu.Unlock()
	return e.err
}

func newTestRelay(core awsSftpCoreRuntime, eic awsEc2InstanceConnectAPI) *AwsSshTunnelRelay {
	return &AwsSshTunnelRelay{
		runtime:   AwsSsmRuntime{Enabled: true},
		core:      core,
		ssmTokens: fakeTunnelTokenIssuer{},
		eic:       eic,
		upgrader:  websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
	}
}

func dialRelay(t *testing.T, relay *AwsSshTunnelRelay) (*websocket.Conn, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = relay.HandleWebSocket(w, r)
	}))
	t.Cleanup(srv.Close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial relay: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn, srv
}

func validTunnelStart() awsSshTunnelStartMessage {
	return awsSshTunnelStartMessage{
		Region:           "ap-northeast-2",
		InstanceID:       "i-abc",
		AvailabilityZone: "ap-northeast-2a",
		SSHUsername:      "ec2-user",
		SSHPort:          22,
		PublicKey:        "ssh-ed25519 AAAA...",
		Env:              map[string]string{"AWS_ACCESS_KEY_ID": "x"},
	}
}

func readControlFrame(t *testing.T, conn *websocket.Conn) awsSshTunnelControlFrame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read control frame: %v", err)
	}
	var frame awsSshTunnelControlFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		t.Fatalf("unmarshal control frame %q: %v", data, err)
	}
	return frame
}

func TestAwsSshTunnelRelayReadyAndEcho(t *testing.T) {
	core := newFakeTunnelCore()
	eic := &fakeTunnelEic{}
	relay := newTestRelay(core, eic)
	conn, _ := dialRelay(t, relay)

	start, _ := json.Marshal(validTunnelStart())
	if err := conn.WriteMessage(websocket.TextMessage, start); err != nil {
		t.Fatalf("send start: %v", err)
	}
	if frame := readControlFrame(t, conn); frame.Type != "ready" {
		t.Fatalf("expected ready, got %+v", frame)
	}

	// The EIC push must have carried the desktop's public key to the server.
	eic.mu.Lock()
	gotPub := eic.gotPub
	eic.mu.Unlock()
	if gotPub != "ssh-ed25519 AAAA..." {
		t.Fatalf("EIC public key = %q, want the start-message key", gotPub)
	}

	// Post-ready the socket is a raw byte pipe: write, expect the tunnel echo.
	payload := []byte("SSH-2.0-dolssh\r\n")
	if err := conn.WriteMessage(websocket.BinaryMessage, payload); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, echoed, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(echoed) != string(payload) {
		t.Fatalf("echo = %q, want %q", echoed, payload)
	}
}

func TestAwsSshTunnelRelayEicFailureTearsDown(t *testing.T) {
	core := newFakeTunnelCore()
	eic := &fakeTunnelEic{err: errors.New("eic push denied")}
	relay := newTestRelay(core, eic)
	conn, _ := dialRelay(t, relay)

	start, _ := json.Marshal(validTunnelStart())
	_ = conn.WriteMessage(websocket.TextMessage, start)

	frame := readControlFrame(t, conn)
	if frame.Type != "error" || !strings.Contains(frame.Message, "eic push denied") {
		t.Fatalf("expected error frame carrying the EIC failure, got %+v", frame)
	}
	// The tunnel opened before EIC must be stopped so we don't leak a listener.
	if core.tunnelCount() != 0 {
		t.Fatalf("tunnel was not stopped after EIC failure: %d open", core.tunnelCount())
	}
}

func TestAwsSshTunnelRelayRejectsInvalidStart(t *testing.T) {
	relay := newTestRelay(newFakeTunnelCore(), &fakeTunnelEic{})
	conn, _ := dialRelay(t, relay)

	bad := validTunnelStart()
	bad.PublicKey = "" // missing required field
	start, _ := json.Marshal(bad)
	_ = conn.WriteMessage(websocket.TextMessage, start)

	frame := readControlFrame(t, conn)
	if frame.Type != "error" || !strings.Contains(frame.Message, "publicKey") {
		t.Fatalf("expected validation error about publicKey, got %+v", frame)
	}
}
