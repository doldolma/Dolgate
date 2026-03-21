package sshsession_test

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"keyterm/services/ssh-core/internal/protocol"
	"keyterm/services/ssh-core/internal/sshsession"
)

type sshTestServer struct {
	addr           string
	listener       net.Listener
	windowChanges  chan [2]int
	globalRequests chan string
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
		Host:     "127.0.0.1",
		Port:     server.port(),
		Username: "tester",
		AuthType: "password",
		Password: "s3cret",
		Cols:     80,
		Rows:     24,
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
		Host:           "127.0.0.1",
		Port:           server.port(),
		Username:       "tester",
		AuthType:       "privateKey",
		PrivateKeyPath: keyPath,
		Cols:           100,
		Rows:           30,
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
		Host:     "127.0.0.1",
		Port:     server.port(),
		Username: "tester",
		AuthType: "password",
		Password: "s3cret",
		Cols:     80,
		Rows:     24,
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

func newSSHTestServer(t *testing.T) (*sshTestServer, []byte, func()) {
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
		addr:           listener.Addr().String(),
		listener:       listener,
		windowChanges:  make(chan [2]int, 8),
		globalRequests: make(chan string, 8),
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
			go handleConnection(conn, serverConfig, server.windowChanges, server.globalRequests)
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

func handleConnection(raw net.Conn, config *ssh.ServerConfig, windowChanges chan<- [2]int, globalRequests chan<- string) {
	serverConn, chans, reqs, err := ssh.NewServerConn(raw, config)
	if err != nil {
		return
	}
	defer serverConn.Close()

	go func() {
		for req := range reqs {
			globalRequests <- req.Type
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
				switch req.Type {
				case "pty-req":
					_ = req.Reply(true, nil)
				case "shell":
					_ = req.Reply(true, nil)
					_, _ = ch.Write([]byte("welcome\n"))
					echoStarted.Do(func() {
						go func() {
							_, _ = io.Copy(ch, ch)
						}()
					})
				case "window-change":
					if len(req.Payload) >= 8 {
						cols := int(uint32(req.Payload[0])<<24 | uint32(req.Payload[1])<<16 | uint32(req.Payload[2])<<8 | uint32(req.Payload[3]))
						rows := int(uint32(req.Payload[4])<<24 | uint32(req.Payload[5])<<16 | uint32(req.Payload[6])<<8 | uint32(req.Payload[7]))
						windowChanges <- [2]int{cols, rows}
					}
				default:
					_ = req.Reply(false, nil)
				}
			}
		}(channel, requests)
	}
}
