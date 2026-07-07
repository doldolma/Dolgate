package sshsession_test

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshsession"
)

type sshTestServer struct {
	addr            string
	listener        net.Listener
	windowChanges   chan [2]int
	globalRequests  chan string
	sessionRequests chan string
	hostKeyBase64   string

	shellPath                 string
	shellInputs               chan []byte
	promptMarkerOnIntegration bool
	execDelay                 time.Duration
	agentForwardingAccepted   bool
	// execResponder, when set, handles an exec request for a matching command by
	// returning custom stdout/stderr/exit status. Returning handled=false falls
	// through to the default behaviour (echo shellPath, exit 0).
	execResponder func(command string) (stdout, stderr string, status uint32, handled bool)
}

func TestManagerPasswordFlow(t *testing.T) {
	server, _, cleanup := newSSHTestServer(t)
	defer cleanup()

	events := make(chan protocol.Event, 16)
	streams := make(chan []byte, 16)
	manager := sshsession.NewManager(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, payload []byte) {
		streams <- payload
	})

	err := manager.Connect("session-1", "req-1", protocol.ConnectPayload{
		Host:                 "127.0.0.1",
		Port:                 server.port(),
		Username:             "tester",
		AuthType:             "password",
		Password:             "s3cret",
		TrustedHostKeyBase64: server.hostKeyBase64,
		Cols:                 80,
		Rows:                 24,
	})
	if err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	waitForEvent(t, events, protocol.EventConnected)

	if err := manager.WriteBytes("session-1", []byte("ping\n")); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	if err := manager.Resize("session-1", 120, 40); err != nil {
		t.Fatalf("resize failed: %v", err)
	}

	select {
	case dims := <-server.windowChanges:
		if dims != [2]int{120, 40} {
			t.Fatalf("unexpected window change: %#v", dims)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for window change")
	}

	decoded := waitForStream(t, streams)
	if !bytes.Contains(decoded, []byte("welcome")) && !bytes.Contains(decoded, []byte("ping")) {
		t.Fatalf("unexpected stream contents: %q", decoded)
	}

	if err := manager.Disconnect("session-1"); err != nil {
		t.Fatalf("disconnect failed: %v", err)
	}

	waitForEvent(t, events, protocol.EventClosed)
}

func TestManagerPrivateKeyFlow(t *testing.T) {
	server, privateKeyPEM, cleanup := newSSHTestServer(t)
	defer cleanup()

	keyPath := filepath.Join(t.TempDir(), "id_rsa")
	if err := os.WriteFile(keyPath, privateKeyPEM, 0o600); err != nil {
		t.Fatalf("write private key: %v", err)
	}

	events := make(chan protocol.Event, 16)
	manager := sshsession.NewManager(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, _ []byte) {})

	err := manager.Connect("session-2", "req-2", protocol.ConnectPayload{
		Host:                 "127.0.0.1",
		Port:                 server.port(),
		Username:             "tester",
		AuthType:             "privateKey",
		PrivateKeyPEM:        string(privateKeyPEM),
		TrustedHostKeyBase64: server.hostKeyBase64,
		Cols:                 100,
		Rows:                 30,
	})
	if err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	waitForEvent(t, events, protocol.EventConnected)
}

func TestManagerSendsKeepAliveRequests(t *testing.T) {
	server, _, cleanup := newSSHTestServer(t)
	defer cleanup()

	events := make(chan protocol.Event, 16)
	manager := sshsession.NewManagerWithConfig(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, _ []byte) {}, sshsession.ManagerConfig{
		SSHKeepAliveInterval: 25 * time.Millisecond,
	})

	err := manager.Connect("session-3", "req-3", protocol.ConnectPayload{
		Host:                 "127.0.0.1",
		Port:                 server.port(),
		Username:             "tester",
		AuthType:             "password",
		Password:             "s3cret",
		TrustedHostKeyBase64: server.hostKeyBase64,
		Cols:                 80,
		Rows:                 24,
	})
	if err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	waitForEvent(t, events, protocol.EventConnected)

	select {
	case requestType := <-server.globalRequests:
		if requestType != "keepalive@openssh.com" {
			t.Fatalf("unexpected global request: %s", requestType)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for keepalive request")
	}

	if err := manager.Disconnect("session-3"); err != nil {
		t.Fatalf("disconnect failed: %v", err)
	}

	waitForEvent(t, events, protocol.EventClosed)
}

func TestManagerEagerInstallsShellIntegrationForSupportedShell(t *testing.T) {
	server, _, cleanup := newSSHTestServer(
		t,
		// Models hosts where $SHELL may be /bin/sh but the exec shell exposes
		// BASH_VERSION, so the capability probe returns "bash".
		withRemoteShell("bash"),
		withPromptMarkerOnIntegration(),
	)
	defer cleanup()

	events := make(chan protocol.Event, 16)
	manager := sshsession.NewManager(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, _ []byte) {})

	err := manager.Connect("session-bash", "req-bash", protocol.ConnectPayload{
		Host:                 "127.0.0.1",
		Port:                 server.port(),
		Username:             "tester",
		AuthType:             "password",
		Password:             "s3cret",
		TrustedHostKeyBase64: server.hostKeyBase64,
		Cols:                 80,
		Rows:                 24,
	})
	if err != nil {
		t.Fatalf("connect failed: %v", err)
	}
	waitForEvent(t, events, protocol.EventConnected)

	input := waitForShellInput(t, server.shellInputs)
	if !bytes.Contains(input, []byte("__ds_o")) {
		t.Fatalf("expected shell integration init input, got %q", input)
	}

	if err := manager.InstallShellIntegration("session-bash"); err != nil {
		t.Fatalf("second install failed: %v", err)
	}
	assertNoShellInput(t, server.shellInputs)
}

func TestManagerSkipsEagerShellIntegrationForUnsupportedShell(t *testing.T) {
	server, _, cleanup := newSSHTestServer(t, withRemoteShell("/usr/bin/fish"))
	defer cleanup()

	events := make(chan protocol.Event, 16)
	manager := sshsession.NewManager(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, _ []byte) {})

	err := manager.Connect("session-fish", "req-fish", protocol.ConnectPayload{
		Host:                 "127.0.0.1",
		Port:                 server.port(),
		Username:             "tester",
		AuthType:             "password",
		Password:             "s3cret",
		TrustedHostKeyBase64: server.hostKeyBase64,
		Cols:                 80,
		Rows:                 24,
	})
	if err != nil {
		t.Fatalf("connect failed: %v", err)
	}
	waitForEvent(t, events, protocol.EventConnected)
	assertNoShellInput(t, server.shellInputs)
}

func TestManagerRequestsAgentForwardingBeforeShell(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix socket agent forwarding test is not supported on Windows")
	}

	server, _, cleanup := newSSHTestServer(t, withAgentForwardingAccepted())
	defer cleanup()
	agentSocket, agentCleanup := newFakeUnixAgentSocket(t)
	defer agentCleanup()

	events := make(chan protocol.Event, 16)
	manager := sshsession.NewManager(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, _ []byte) {})

	err := manager.Connect("session-agent", "req-agent", protocol.ConnectPayload{
		Host:                        "127.0.0.1",
		Port:                        server.port(),
		Username:                    "tester",
		AuthType:                    "password",
		Password:                    "s3cret",
		TrustedHostKeyBase64:        server.hostKeyBase64,
		Cols:                        80,
		Rows:                        24,
		AgentForwarding:             true,
		AgentForwardingEndpointKind: "unix",
		AgentForwardingEndpoint:     agentSocket,
	})
	if err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	event := waitForEvent(t, events, protocol.EventAgentForwardingStatus)
	payload, ok := event.Payload.(protocol.AgentForwardingStatusPayload)
	if !ok {
		t.Fatalf("unexpected agent forwarding payload: %#v", event.Payload)
	}
	if payload.Status != "active" {
		t.Fatalf("expected active agent forwarding status, got %#v", payload)
	}
	waitForEvent(t, events, protocol.EventConnected)

	waitForSessionRequest(t, server.sessionRequests, "pty-req")
	waitForSessionRequest(t, server.sessionRequests, "auth-agent-req@openssh.com")
	waitForSessionRequest(t, server.sessionRequests, "shell")
}

func TestManagerAgentForwardingMissingEndpointEmitsUnavailableAndContinues(t *testing.T) {
	server, _, cleanup := newSSHTestServer(t, withAgentForwardingAccepted())
	defer cleanup()

	events := make(chan protocol.Event, 16)
	manager := sshsession.NewManager(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, _ []byte) {})

	err := manager.Connect("session-agent-missing", "req-agent-missing", protocol.ConnectPayload{
		Host:                 "127.0.0.1",
		Port:                 server.port(),
		Username:             "tester",
		AuthType:             "password",
		Password:             "s3cret",
		TrustedHostKeyBase64: server.hostKeyBase64,
		Cols:                 80,
		Rows:                 24,
		AgentForwarding:      true,
	})
	if err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	event := waitForEvent(t, events, protocol.EventAgentForwardingStatus)
	payload, ok := event.Payload.(protocol.AgentForwardingStatusPayload)
	if !ok {
		t.Fatalf("unexpected agent forwarding payload: %#v", event.Payload)
	}
	if payload.Status != "unavailable" || payload.Reason != "agent-endpoint-missing" {
		t.Fatalf("expected missing endpoint status, got %#v", payload)
	}
	waitForEvent(t, events, protocol.EventConnected)

	waitForSessionRequest(t, server.sessionRequests, "pty-req")
	waitForSessionRequest(t, server.sessionRequests, "shell")
	assertNoSessionRequest(t, server.sessionRequests, "auth-agent-req@openssh.com")
}

func waitForEvent(t *testing.T, events <-chan protocol.Event, expected protocol.EventType) protocol.Event {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case event := <-events:
			if event.Type == expected {
				return event
			}
		case <-deadline:
			t.Fatalf("timed out waiting for event %s", expected)
		}
	}
}

func waitForSessionRequest(t *testing.T, requests <-chan string, expected string) {
	t.Helper()
	select {
	case requestType := <-requests:
		if requestType != expected {
			t.Fatalf("expected session request %s, got %s", expected, requestType)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for session request %s", expected)
	}
}

func assertNoSessionRequest(t *testing.T, requests <-chan string, unexpected string) {
	t.Helper()
	select {
	case requestType := <-requests:
		if requestType == unexpected {
			t.Fatalf("unexpected session request %s", unexpected)
		}
	case <-time.After(150 * time.Millisecond):
	}
}

func waitForStream(t *testing.T, streams <-chan []byte) []byte {
	t.Helper()
	select {
	case chunk := <-streams:
		return chunk
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for stream chunk")
		return nil
	}
}

func waitForShellInput(t *testing.T, inputs <-chan []byte) []byte {
	t.Helper()
	select {
	case input := <-inputs:
		return input
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for shell input")
		return nil
	}
}

func assertNoShellInput(t *testing.T, inputs <-chan []byte) {
	t.Helper()
	select {
	case input := <-inputs:
		t.Fatalf("unexpected shell input: %q", input)
	case <-time.After(150 * time.Millisecond):
	}
}

type sshTestServerOption func(*sshTestServer)

func withRemoteShell(path string) sshTestServerOption {
	return func(server *sshTestServer) {
		server.shellPath = path
	}
}

func withPromptMarkerOnIntegration() sshTestServerOption {
	return func(server *sshTestServer) {
		server.promptMarkerOnIntegration = true
	}
}

func withAgentForwardingAccepted() sshTestServerOption {
	return func(server *sshTestServer) {
		server.agentForwardingAccepted = true
	}
}

func newFakeUnixAgentSocket(t *testing.T) (string, func()) {
	t.Helper()

	dir, err := os.MkdirTemp("/tmp", "dg-agent-*")
	if err != nil {
		t.Fatalf("create unix agent socket dir: %v", err)
	}
	socketPath := filepath.Join(dir, "a.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		_ = os.RemoveAll(dir)
		t.Fatalf("listen unix agent socket: %v", err)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()

	return socketPath, func() {
		_ = listener.Close()
		<-done
		_ = os.RemoveAll(dir)
	}
}

func newSSHTestServer(t *testing.T, options ...sshTestServerOption) (*sshTestServer, []byte, func()) {
	t.Helper()

	hostPrivateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostPrivateKey)
	if err != nil {
		t.Fatalf("create host signer: %v", err)
	}

	userPrivateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate user key: %v", err)
	}
	userSigner, err := ssh.NewSignerFromKey(userPrivateKey)
	if err != nil {
		t.Fatalf("create user signer: %v", err)
	}

	privateKeyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(userPrivateKey),
	})

	serverConfig := &ssh.ServerConfig{
		PasswordCallback: func(conn ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			if conn.User() == "tester" && string(password) == "s3cret" {
				return nil, nil
			}
			return nil, fmt.Errorf("invalid password")
		},
		PublicKeyCallback: func(conn ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if conn.User() == "tester" && bytes.Equal(key.Marshal(), userSigner.PublicKey().Marshal()) {
				return nil, nil
			}
			return nil, fmt.Errorf("invalid public key")
		},
	}
	serverConfig.AddHostKey(hostSigner)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	server := &sshTestServer{
		addr:            listener.Addr().String(),
		listener:        listener,
		windowChanges:   make(chan [2]int, 8),
		globalRequests:  make(chan string, 8),
		sessionRequests: make(chan string, 16),
		shellInputs:     make(chan []byte, 16),
		hostKeyBase64:   base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
	}
	for _, option := range options {
		option(server)
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go handleConnection(conn, serverConfig, server)
		}
	}()

	cleanup := func() {
		_ = listener.Close()
		wg.Wait()
	}

	return server, privateKeyPEM, cleanup
}

func (s *sshTestServer) port() int {
	_, portText, _ := net.SplitHostPort(s.addr)
	var port int
	fmt.Sscanf(portText, "%d", &port)
	return port
}

func TestManagerRunHostCommand(t *testing.T) {
	server, _, cleanup := newSSHTestServer(t)
	defer cleanup()
	server.shellPath = "/bin/sh" // non-empty so exec requests are accepted
	// 명령은 로그인 셸(sh -lc '…')로 감싸져 오므로 부분 일치로 확인한다.
	server.execResponder = func(command string) (string, string, uint32, bool) {
		if strings.Contains(command, "do-thing") {
			return "line1\nline2\n", "oops\n", 7, true
		}
		return "", "", 0, false
	}

	events := make(chan protocol.Event, 16)
	manager := sshsession.NewManager(func(event protocol.Event) {
		select {
		case events <- event:
		default:
		}
	}, func(_ protocol.StreamFrame, _ []byte) {})

	if err := manager.Connect("session-run", "req-run", protocol.ConnectPayload{
		Host:                 "127.0.0.1",
		Port:                 server.port(),
		Username:             "tester",
		AuthType:             "password",
		Password:             "s3cret",
		TrustedHostKeyBase64: server.hostKeyBase64,
		Cols:                 80,
		Rows:                 24,
	}); err != nil {
		t.Fatalf("connect failed: %v", err)
	}
	waitForEvent(t, events, protocol.EventConnected)

	// Non-zero exit + stderr on a separate exec channel (not the PTY).
	stdout, stderr, exitCode, truncated, err := manager.RunHostCommand("session-run", "do-thing", 5000)
	if err != nil {
		t.Fatalf("RunHostCommand() error = %v", err)
	}
	if stdout != "line1\nline2\n" || stderr != "oops\n" || exitCode != 7 || truncated {
		t.Fatalf("unexpected result: stdout=%q stderr=%q exit=%d trunc=%v", stdout, stderr, exitCode, truncated)
	}

	// Unknown session surfaces an error (not a zero exit).
	if _, _, _, _, err := manager.RunHostCommand("missing", "ls", 1000); err == nil {
		t.Fatal("expected error for unknown session")
	}
}

func handleConnection(raw net.Conn, config *ssh.ServerConfig, server *sshTestServer) {
	serverConn, chans, reqs, err := ssh.NewServerConn(raw, config)
	if err != nil {
		return
	}
	defer serverConn.Close()

	go func() {
		for req := range reqs {
			server.globalRequests <- req.Type
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
		}
	}()

	for newChannel := range chans {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "unsupported channel type")
			continue
		}

		channel, requests, err := newChannel.Accept()
		if err != nil {
			continue
		}

		go func(ch ssh.Channel, in <-chan *ssh.Request) {
			defer ch.Close()
			var echoStarted sync.Once
			for req := range in {
				select {
				case server.sessionRequests <- req.Type:
				default:
				}
				switch req.Type {
				case "exec":
					if server.execDelay > 0 {
						time.Sleep(server.execDelay)
					}
					if server.shellPath == "" {
						_ = req.Reply(false, nil)
						return
					}
					_ = req.Reply(true, nil)
					if server.execResponder != nil {
						var execPayload struct{ Command string }
						_ = ssh.Unmarshal(req.Payload, &execPayload)
						if stdout, stderr, status, handled := server.execResponder(execPayload.Command); handled {
							if stdout != "" {
								_, _ = ch.Write([]byte(stdout))
							}
							if stderr != "" {
								_, _ = ch.Stderr().Write([]byte(stderr))
							}
							_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
							return
						}
					}
					_, _ = ch.Write([]byte(server.shellPath + "\n"))
					_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
					return
				case "pty-req":
					_ = req.Reply(true, nil)
				case "auth-agent-req@openssh.com":
					_ = req.Reply(server.agentForwardingAccepted, nil)
				case "shell":
					_ = req.Reply(true, nil)
					_, _ = ch.Write([]byte("welcome\n"))
					echoStarted.Do(func() {
						go echoShell(ch, server)
					})
				case "window-change":
					if len(req.Payload) >= 8 {
						cols := int(uint32(req.Payload[0])<<24 | uint32(req.Payload[1])<<16 | uint32(req.Payload[2])<<8 | uint32(req.Payload[3]))
						rows := int(uint32(req.Payload[4])<<24 | uint32(req.Payload[5])<<16 | uint32(req.Payload[6])<<8 | uint32(req.Payload[7]))
						server.windowChanges <- [2]int{cols, rows}
					}
				default:
					_ = req.Reply(false, nil)
				}
			}
		}(channel, requests)
	}
}

func echoShell(ch ssh.Channel, server *sshTestServer) {
	buffer := make([]byte, 4096)
	var markerOnce sync.Once
	for {
		n, err := ch.Read(buffer)
		if n > 0 {
			chunk := append([]byte(nil), buffer[:n]...)
			select {
			case server.shellInputs <- chunk:
			default:
			}
			_, _ = ch.Write(chunk)
			if server.promptMarkerOnIntegration && bytes.Contains(chunk, []byte("__ds_o")) {
				markerOnce.Do(func() {
					_, _ = ch.Write([]byte(autocomplete.PromptStartMarker + "tester$ "))
				})
			}
		}
		if err != nil {
			return
		}
	}
}
