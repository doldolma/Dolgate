package sftp_test

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
	"sync"
	"testing"
	"time"

	pkgsftp "github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/protocol"
	coresftp "dolssh/services/ssh-core/internal/sftp"
)

type sftpTestServer struct {
	addr          string
	listener      net.Listener
	rootDir       string
	hostKeyBase64 string
}

func TestServiceBrowseAndManagePaths(t *testing.T) {
	server, cleanup := newSFTPTestServer(t)
	defer cleanup()

	events := make(chan protocol.Event, 32)
	service := coresftp.New(func(event protocol.Event) {
		events <- event
	})
	defer service.Shutdown()

	if err := service.Connect("endpoint-1", "req-connect", protocol.SFTPConnectPayload{
		Host:                 "127.0.0.1",
		Port:                 server.port(),
		Username:             "tester",
		AuthType:             "password",
		Password:             "s3cret",
		TrustedHostKeyBase64: server.hostKeyBase64,
	}); err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	connected := waitForEvent(t, events, protocol.EventSFTPConnected)
	rootPath := connected.Payload.(protocol.SFTPConnectedPayload).Path

	if err := service.Mkdir("endpoint-1", "req-mkdir", protocol.SFTPMkdirPayload{
		Path: rootPath,
		Name: "docs",
	}); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	waitForEvent(t, events, protocol.EventSFTPAck)

	if err := service.List("endpoint-1", "req-list", protocol.SFTPListPayload{Path: rootPath}); err != nil {
		t.Fatalf("list failed: %v", err)
	}
	listed := waitForEvent(t, events, protocol.EventSFTPListed)
	listing := listed.Payload.(protocol.SFTPListedPayload)
	if len(listing.Entries) != 1 || listing.Entries[0].Name != "docs" {
		t.Fatalf("unexpected listing: %#v", listing.Entries)
	}

	if err := service.Rename("endpoint-1", "req-rename", protocol.SFTPRenamePayload{
		Path:     filepath.ToSlash(filepath.Join(rootPath, "docs")),
		NextName: "notes",
	}); err != nil {
		t.Fatalf("rename failed: %v", err)
	}
	waitForEvent(t, events, protocol.EventSFTPAck)

	if err := service.Chmod("endpoint-1", "req-chmod", protocol.SFTPChmodPayload{
		Path: filepath.ToSlash(filepath.Join(rootPath, "notes")),
		Mode: 0o755,
	}); err != nil {
		t.Fatalf("chmod failed: %v", err)
	}
	waitForEvent(t, events, protocol.EventSFTPAck)

	if err := service.List("endpoint-1", "req-list-after-chmod", protocol.SFTPListPayload{Path: rootPath}); err != nil {
		t.Fatalf("list after chmod failed: %v", err)
	}
	listedAfterChmod := waitForEvent(t, events, protocol.EventSFTPListed)
	listingAfterChmod := listedAfterChmod.Payload.(protocol.SFTPListedPayload)
	if len(listingAfterChmod.Entries) != 1 {
		t.Fatalf("unexpected listing after chmod: %#v", listingAfterChmod.Entries)
	}
	if runtime.GOOS == "windows" {
		if listingAfterChmod.Entries[0].Name != "notes" || !listingAfterChmod.Entries[0].IsDirectory {
			t.Fatalf("unexpected listing after chmod: %#v", listingAfterChmod.Entries)
		}
	} else if listingAfterChmod.Entries[0].Permissions != "drwxr-xr-x" {
		t.Fatalf("unexpected listing after chmod: %#v", listingAfterChmod.Entries)
	}

	if err := service.Delete("endpoint-1", "req-delete", protocol.SFTPDeletePayload{
		Paths: []string{filepath.ToSlash(filepath.Join(rootPath, "notes"))},
	}); err != nil {
		t.Fatalf("delete failed: %v", err)
	}
	waitForEvent(t, events, protocol.EventSFTPAck)
}

func TestServiceTransfersLocalAndRemoteFiles(t *testing.T) {
	server, cleanup := newSFTPTestServer(t)
	defer cleanup()

	events := make(chan protocol.Event, 64)
	service := coresftp.New(func(event protocol.Event) {
		events <- event
	})
	defer service.Shutdown()

	if err := service.Connect("endpoint-1", "req-connect", protocol.SFTPConnectPayload{
		Host:                 "127.0.0.1",
		Port:                 server.port(),
		Username:             "tester",
		AuthType:             "password",
		Password:             "s3cret",
		TrustedHostKeyBase64: server.hostKeyBase64,
	}); err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	connected := waitForEvent(t, events, protocol.EventSFTPConnected)
	rootPath := connected.Payload.(protocol.SFTPConnectedPayload).Path

	sourceDir := t.TempDir()
	localFile := filepath.Join(sourceDir, "hello.txt")
	if err := os.WriteFile(localFile, []byte("hello from local"), 0o600); err != nil {
		t.Fatalf("write local source: %v", err)
	}

	if err := service.StartTransfer("job-1", protocol.SFTPTransferStartPayload{
		Source: protocol.TransferEndpointPayload{
			Kind: "local",
			Path: sourceDir,
		},
		Target: protocol.TransferEndpointPayload{
			Kind:       "remote",
			EndpointID: "endpoint-1",
			Path:       rootPath,
		},
		Items: []protocol.TransferItemPayload{
			{
				Name:        "hello.txt",
				Path:        localFile,
				IsDirectory: false,
				Size:        int64(len("hello from local")),
			},
		},
		ConflictResolution: "overwrite",
	}); err != nil {
		t.Fatalf("start transfer failed: %v", err)
	}

	waitForEvent(t, events, protocol.EventSFTPTransferCompleted)

	if err := service.List("endpoint-1", "req-list", protocol.SFTPListPayload{Path: rootPath}); err != nil {
		t.Fatalf("list remote after upload failed: %v", err)
	}
	listing := waitForEvent(t, events, protocol.EventSFTPListed).Payload.(protocol.SFTPListedPayload)
	if len(listing.Entries) == 0 || listing.Entries[0].Name != "hello.txt" {
		t.Fatalf("expected uploaded file in remote listing, got %#v", listing.Entries)
	}

	destinationDir := t.TempDir()
	if err := service.StartTransfer("job-2", protocol.SFTPTransferStartPayload{
		Source: protocol.TransferEndpointPayload{
			Kind:       "remote",
			EndpointID: "endpoint-1",
			Path:       rootPath,
		},
		Target: protocol.TransferEndpointPayload{
			Kind: "local",
			Path: destinationDir,
		},
		Items: []protocol.TransferItemPayload{
			{
				Name:        "hello.txt",
				Path:        filepath.ToSlash(filepath.Join(rootPath, "hello.txt")),
				IsDirectory: false,
				Size:        int64(len("hello from local")),
			},
		},
		ConflictResolution: "overwrite",
	}); err != nil {
		t.Fatalf("start download failed: %v", err)
	}

	waitForEvent(t, events, protocol.EventSFTPTransferCompleted)

	content, err := os.ReadFile(filepath.Join(destinationDir, "hello.txt"))
	if err != nil {
		t.Fatalf("read downloaded file: %v", err)
	}
	if !bytes.Equal(content, []byte("hello from local")) {
		t.Fatalf("unexpected downloaded content: %q", content)
	}
}

func TestServiceConnectsWithKeyboardInteractive(t *testing.T) {
	server, cleanup := newKeyboardInteractiveSFTPTestServer(t)
	defer cleanup()

	events := make(chan protocol.Event, 32)
	service := coresftp.New(func(event protocol.Event) {
		events <- event
	})
	defer service.Shutdown()

	connectDone := make(chan error, 1)
	go func() {
		connectDone <- service.Connect("endpoint-ki", "req-connect-ki", protocol.SFTPConnectPayload{
			Host:                 "127.0.0.1",
			Port:                 server.port(),
			Username:             "tester",
			AuthType:             "keyboardInteractive",
			TrustedHostKeyBase64: server.hostKeyBase64,
		})
	}()

	challengeEvent := waitForEvent(t, events, protocol.EventKeyboardInteractiveChallenge)
	if challengeEvent.EndpointID != "endpoint-ki" {
		t.Fatalf("unexpected challenge endpoint: %s", challengeEvent.EndpointID)
	}
	challenge := challengeEvent.Payload.(protocol.KeyboardInteractiveChallengePayload)
	if len(challenge.Prompts) != 2 {
		t.Fatalf("unexpected prompt count: %#v", challenge.Prompts)
	}

	if err := service.RespondKeyboardInteractive("endpoint-ki", challenge.ChallengeID, []string{"ABCD-1234", ""}); err != nil {
		t.Fatalf("respond keyboard interactive failed: %v", err)
	}

	resolvedEvent := waitForEvent(t, events, protocol.EventKeyboardInteractiveResolved)
	if resolvedEvent.EndpointID != "endpoint-ki" {
		t.Fatalf("unexpected resolved endpoint: %s", resolvedEvent.EndpointID)
	}
	connectedEvent := waitForEvent(t, events, protocol.EventSFTPConnected)
	if connectedEvent.EndpointID != "endpoint-ki" {
		t.Fatalf("unexpected connected endpoint: %s", connectedEvent.EndpointID)
	}

	if err := <-connectDone; err != nil {
		t.Fatalf("connect failed: %v", err)
	}
}

func waitForEvent(t *testing.T, events <-chan protocol.Event, expected protocol.EventType) protocol.Event {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case event := <-events:
			if event.Type == expected {
				return event
			}
		case <-timeout:
			t.Fatalf("timed out waiting for event %s", expected)
		}
	}
}

func newSFTPTestServer(t *testing.T) (*sftpTestServer, func()) {
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
	_ = pem.EncodeToMemory(&pem.Block{
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

	server := &sftpTestServer{
		addr:          listener.Addr().String(),
		listener:      listener,
		rootDir:       t.TempDir(),
		hostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
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
			go handleSFTPConnection(conn, serverConfig, server.rootDir)
		}
	}()

	return server, func() {
		_ = listener.Close()
		wg.Wait()
	}
}

func newKeyboardInteractiveSFTPTestServer(t *testing.T) (*sftpTestServer, func()) {
	t.Helper()

	hostPrivateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostPrivateKey)
	if err != nil {
		t.Fatalf("create host signer: %v", err)
	}

	serverConfig := &ssh.ServerConfig{
		KeyboardInteractiveCallback: func(conn ssh.ConnMetadata, challenger ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
			if conn.User() != "tester" {
				return nil, fmt.Errorf("invalid user")
			}
			responses, err := challenger(
				conn.User(),
				"Open https://warpgate.example.com/authorize and enter code ABCD-1234",
				[]string{"Verification code", "Press Enter to continue"},
				[]bool{true, true},
			)
			if err != nil {
				return nil, err
			}
			if len(responses) != 2 || responses[0] != "ABCD-1234" || responses[1] != "" {
				return nil, fmt.Errorf("unexpected keyboard-interactive responses: %#v", responses)
			}
			return nil, nil
		},
	}
	serverConfig.AddHostKey(hostSigner)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	server := &sftpTestServer{
		addr:          listener.Addr().String(),
		listener:      listener,
		rootDir:       t.TempDir(),
		hostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
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
			go handleSFTPConnection(conn, serverConfig, server.rootDir)
		}
	}()

	return server, func() {
		_ = listener.Close()
		wg.Wait()
	}
}

func (s *sftpTestServer) port() int {
	_, portText, _ := net.SplitHostPort(s.addr)
	var port int
	fmt.Sscanf(portText, "%d", &port)
	return port
}

func handleSFTPConnection(raw net.Conn, config *ssh.ServerConfig, rootDir string) {
	serverConn, chans, reqs, err := ssh.NewServerConn(raw, config)
	if err != nil {
		return
	}
	defer serverConn.Close()

	go ssh.DiscardRequests(reqs)

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
			for req := range in {
				switch req.Type {
				case "subsystem":
					var payload struct {
						Name string
					}
					if err := ssh.Unmarshal(req.Payload, &payload); err != nil || payload.Name != "sftp" {
						_ = req.Reply(false, nil)
						return
					}
					_ = req.Reply(true, nil)
					server, err := pkgsftp.NewServer(ch, pkgsftp.WithServerWorkingDirectory(rootDir))
					if err != nil {
						return
					}
					_ = server.Serve()
					_ = server.Close()
					return
				default:
					_ = req.Reply(false, nil)
				}
			}
		}(channel, requests)
	}
}
