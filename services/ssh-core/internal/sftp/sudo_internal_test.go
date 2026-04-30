package sftp

import (
	"crypto/rand"
	"crypto/rsa"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/protocol"
)

type fakeExecRecord struct {
	command string
	stdin   string
}

type fakeExecResponse struct {
	stdout     string
	stderr     string
	exitStatus uint32
}

type fakeExecServer struct {
	listener net.Listener
	wg       sync.WaitGroup
	mu       sync.Mutex
	records  []fakeExecRecord
	handler  func(command string, stdin string) fakeExecResponse
}

func TestProbeSudoClassifiesCapabilities(t *testing.T) {
	tests := []struct {
		name          string
		authType      string
		loginPassword string
		handler       func(command string, stdin string) fakeExecResponse
		wantStatus    string
		assertRecords func(t *testing.T, records []fakeExecRecord)
	}{
		{
			name:       "root user",
			authType:   "privateKey",
			wantStatus: "root",
			handler: func(command string, _ string) fakeExecResponse {
				if command == "id -u" {
					return fakeExecResponse{stdout: "0\n"}
				}
				return fakeExecResponse{stderr: "unexpected command", exitStatus: 1}
			},
			assertRecords: func(t *testing.T, records []fakeExecRecord) {
				t.Helper()
				if got := commandList(records); strings.Join(got, ",") != "id -u" {
					t.Fatalf("unexpected commands: %#v", got)
				}
			},
		},
		{
			name:       "passwordless sudo",
			authType:   "privateKey",
			wantStatus: "passwordless",
			handler: func(command string, _ string) fakeExecResponse {
				switch command {
				case "id -u":
					return fakeExecResponse{stdout: "1000\n"}
				case "sudo -n -v":
					return fakeExecResponse{}
				default:
					return fakeExecResponse{stderr: "unexpected command", exitStatus: 1}
				}
			},
		},
		{
			name:          "password auth reuses login password through stdin",
			authType:      "password",
			loginPassword: "login-secret",
			wantStatus:    "passwordless",
			handler: func(command string, stdin string) fakeExecResponse {
				switch command {
				case "id -u":
					return fakeExecResponse{stdout: "1000\n"}
				case "sudo -n -v":
					return fakeExecResponse{stderr: "sudo: a password is required\n", exitStatus: 1}
				case "sudo -S -p '' -v":
					if stdin != "login-secret\n" {
						return fakeExecResponse{stderr: "wrong stdin", exitStatus: 1}
					}
					return fakeExecResponse{}
				default:
					return fakeExecResponse{stderr: "unexpected command", exitStatus: 1}
				}
			},
			assertRecords: func(t *testing.T, records []fakeExecRecord) {
				t.Helper()
				record := findExecRecord(records, "sudo -S -p '' -v")
				if record == nil {
					t.Fatalf("expected sudo -S probe, got %#v", commandList(records))
				}
				if record.stdin != "login-secret\n" {
					t.Fatalf("expected login password on stdin, got %q", record.stdin)
				}
				if strings.Contains(record.command, "login-secret") {
					t.Fatalf("sudo password leaked into command: %q", record.command)
				}
			},
		},
		{
			name:          "private key passphrase is not reused as sudo password",
			authType:      "privateKey",
			loginPassword: "key-passphrase",
			wantStatus:    "passwordRequired",
			handler: func(command string, _ string) fakeExecResponse {
				switch command {
				case "id -u":
					return fakeExecResponse{stdout: "1000\n"}
				case "sudo -n -v":
					return fakeExecResponse{stderr: "sudo: a password is required\n", exitStatus: 1}
				default:
					return fakeExecResponse{stderr: "unexpected command", exitStatus: 1}
				}
			},
			assertRecords: func(t *testing.T, records []fakeExecRecord) {
				t.Helper()
				if findExecRecord(records, "sudo -S -p '' -v") != nil {
					t.Fatalf("private key passphrase was reused for sudo: %#v", records)
				}
			},
		},
		{
			name:       "no sudoers",
			authType:   "password",
			wantStatus: "unavailable",
			handler: func(command string, _ string) fakeExecResponse {
				switch command {
				case "id -u":
					return fakeExecResponse{stdout: "1000\n"}
				case "sudo -n -v":
					return fakeExecResponse{stderr: "tester is not in the sudoers file\n", exitStatus: 1}
				default:
					return fakeExecResponse{stderr: "unexpected command", exitStatus: 1}
				}
			},
		},
		{
			name:       "requiretty",
			authType:   "password",
			wantStatus: "unavailable",
			handler: func(command string, _ string) fakeExecResponse {
				switch command {
				case "id -u":
					return fakeExecResponse{stdout: "1000\n"}
				case "sudo -n -v":
					return fakeExecResponse{stderr: "sudo: sorry, you must have a tty to run sudo\n", exitStatus: 1}
				default:
					return fakeExecResponse{stderr: "unexpected command", exitStatus: 1}
				}
			},
		},
		{
			name:          "wrong login password leaves sudo password required",
			authType:      "password",
			loginPassword: "wrong-secret",
			wantStatus:    "passwordRequired",
			handler: func(command string, stdin string) fakeExecResponse {
				switch command {
				case "id -u":
					return fakeExecResponse{stdout: "1000\n"}
				case "sudo -n -v":
					return fakeExecResponse{stderr: "sudo: a password is required\n", exitStatus: 1}
				case "sudo -S -p '' -v":
					if stdin != "wrong-secret\n" {
						return fakeExecResponse{stderr: "wrong stdin", exitStatus: 1}
					}
					return fakeExecResponse{stderr: "Sorry, try again.\n", exitStatus: 1}
				default:
					return fakeExecResponse{stderr: "unexpected command", exitStatus: 1}
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			service, events, server, cleanup := newSudoTestService(t, tt.handler, "probing", "")
			defer cleanup()

			service.probeSudo("endpoint-1", tt.authType, tt.loginPassword)
			status := waitForSudoStatus(t, events)
			if status.Status != tt.wantStatus {
				t.Fatalf("sudo status = %q, want %q; message=%q", status.Status, tt.wantStatus, status.Message)
			}
			if tt.assertRecords != nil {
				tt.assertRecords(t, server.Records())
			}
		})
	}
}

func TestChownCommandUsesSafeQuotingAndStdin(t *testing.T) {
	targetPath := "/srv/Team's files/[붙임2] 전력시장운영규칙전문(260318)_PDF.pdf"

	t.Run("root recursive command", func(t *testing.T) {
		service, events, server, cleanup := newSudoTestService(t, successExecHandler, "root", "")
		defer cleanup()

		if err := service.Chown("endpoint-1", "req-chown", protocol.SFTPChownPayload{
			Path:      targetPath,
			Owner:     "app user",
			Group:     "deploy;rm -rf /",
			Recursive: true,
		}); err != nil {
			t.Fatalf("chown failed: %v", err)
		}
		waitForAck(t, events)

		records := server.Records()
		if len(records) != 1 {
			t.Fatalf("expected one chown command, got %#v", records)
		}
		expected := buildChownCommand("", "app user:deploy;rm -rf /", targetPath, true)
		if records[0].command != expected {
			t.Fatalf("command = %q, want %q", records[0].command, expected)
		}
		if !strings.Contains(records[0].command, "chown -R -- ") {
			t.Fatalf("recursive chown command is missing -R and --: %q", records[0].command)
		}
	})

	t.Run("passwordless sudo does not send stdin", func(t *testing.T) {
		service, events, server, cleanup := newSudoTestService(t, successExecHandler, "passwordless", "")
		defer cleanup()

		if err := service.Chown("endpoint-1", "req-chown", protocol.SFTPChownPayload{
			Path:  "-leading-target",
			Owner: "-leading-owner",
			Group: "staff",
		}); err != nil {
			t.Fatalf("chown failed: %v", err)
		}
		waitForAck(t, events)

		record := server.Records()[0]
		expected := buildChownCommand("sudo -n", "-leading-owner:staff", "-leading-target", false)
		if record.command != expected {
			t.Fatalf("command = %q, want %q", record.command, expected)
		}
		if record.stdin != "" {
			t.Fatalf("passwordless sudo should not send stdin, got %q", record.stdin)
		}
	})

	t.Run("sudo password is passed through stdin only", func(t *testing.T) {
		service, events, server, cleanup := newSudoTestService(t, successExecHandler, "passwordRequired", "")
		defer cleanup()

		if err := service.Chown("endpoint-1", "req-chown", protocol.SFTPChownPayload{
			Path:         "/srv/app.txt",
			Owner:        "root",
			Group:        "root",
			SudoPassword: "sudo-secret",
		}); err != nil {
			t.Fatalf("chown failed: %v", err)
		}
		waitForAck(t, events)

		record := server.Records()[0]
		expected := buildChownCommand("sudo -S -p ''", "root:root", "/srv/app.txt", false)
		if record.command != expected {
			t.Fatalf("command = %q, want %q", record.command, expected)
		}
		if record.stdin != "sudo-secret\n" {
			t.Fatalf("sudo password should be passed on stdin, got %q", record.stdin)
		}
		if strings.Contains(record.command, "sudo-secret") {
			t.Fatalf("sudo password leaked into command: %q", record.command)
		}
	})

	t.Run("cached sudo password is passed through stdin only", func(t *testing.T) {
		service, events, server, cleanup := newSudoTestService(t, successExecHandler, "passwordless", "cached-secret")
		defer cleanup()

		if err := service.Chown("endpoint-1", "req-chown", protocol.SFTPChownPayload{
			Path:  "/srv/app.txt",
			Owner: "root",
		}); err != nil {
			t.Fatalf("chown failed: %v", err)
		}
		waitForAck(t, events)

		record := server.Records()[0]
		if record.stdin != "cached-secret\n" {
			t.Fatalf("cached sudo password should be passed on stdin, got %q", record.stdin)
		}
		if strings.Contains(record.command, "cached-secret") {
			t.Fatalf("cached sudo password leaked into command: %q", record.command)
		}
	})
}

func TestBuildChownOwnerSpecValidation(t *testing.T) {
	uid := 1001
	gid := 1002
	negative := -1
	tests := []struct {
		name    string
		payload protocol.SFTPChownPayload
		want    string
		wantErr bool
	}{
		{name: "owner and group", payload: protocol.SFTPChownPayload{Owner: "app", Group: "staff"}, want: "app:staff"},
		{name: "uid and gid override names", payload: protocol.SFTPChownPayload{Owner: "app", Group: "staff", UID: &uid, GID: &gid}, want: "1001:1002"},
		{name: "group only", payload: protocol.SFTPChownPayload{Group: "staff"}, want: ":staff"},
		{name: "owner contains colon", payload: protocol.SFTPChownPayload{Owner: "bad:owner"}, wantErr: true},
		{name: "group contains colon", payload: protocol.SFTPChownPayload{Group: "bad:group"}, wantErr: true},
		{name: "negative uid", payload: protocol.SFTPChownPayload{UID: &negative}, wantErr: true},
		{name: "negative gid", payload: protocol.SFTPChownPayload{GID: &negative}, wantErr: true},
		{name: "empty", payload: protocol.SFTPChownPayload{}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := buildChownOwnerSpec(tt.payload)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got spec %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("spec = %q, want %q", got, tt.want)
			}
		})
	}
}

func successExecHandler(string, string) fakeExecResponse {
	return fakeExecResponse{}
}

func newSudoTestService(
	t *testing.T,
	handler func(command string, stdin string) fakeExecResponse,
	status string,
	sudoPassword string,
) (*Service, <-chan protocol.Event, *fakeExecServer, func()) {
	t.Helper()
	events := make(chan protocol.Event, 16)
	client, server, cleanup := newFakeExecClient(t, handler)
	service := New(func(event protocol.Event) {
		events <- event
	})
	service.mu.Lock()
	service.endpoints["endpoint-1"] = &endpointHandle{
		client:       client,
		sudoStatus:   status,
		sudoPassword: sudoPassword,
	}
	service.mu.Unlock()
	return service, events, server, func() {
		_ = client.Close()
		cleanup()
	}
}

func newFakeExecClient(
	t *testing.T,
	handler func(command string, stdin string) fakeExecResponse,
) (*ssh.Client, *fakeExecServer, func()) {
	t.Helper()
	hostKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostKey)
	if err != nil {
		t.Fatalf("create host signer: %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &fakeExecServer{
		listener: listener,
		handler:  handler,
	}
	config := &ssh.ServerConfig{NoClientAuth: true}
	config.AddHostKey(hostSigner)
	server.wg.Add(1)
	go server.serve(config)

	client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{
		User:            "tester",
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	})
	if err != nil {
		_ = listener.Close()
		server.wg.Wait()
		t.Fatalf("dial fake exec server: %v", err)
	}

	return client, server, func() {
		_ = listener.Close()
		server.wg.Wait()
	}
}

func (server *fakeExecServer) serve(config *ssh.ServerConfig) {
	defer server.wg.Done()
	for {
		conn, err := server.listener.Accept()
		if err != nil {
			return
		}
		server.wg.Add(1)
		go func() {
			defer server.wg.Done()
			server.handleConn(conn, config)
		}()
	}
}

func (server *fakeExecServer) handleConn(raw net.Conn, config *ssh.ServerConfig) {
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
		go server.handleSession(channel, requests)
	}
}

func (server *fakeExecServer) handleSession(channel ssh.Channel, requests <-chan *ssh.Request) {
	defer channel.Close()
	for req := range requests {
		if req.Type != "exec" {
			_ = req.Reply(false, nil)
			continue
		}
		var payload struct {
			Command string
		}
		if err := ssh.Unmarshal(req.Payload, &payload); err != nil {
			_ = req.Reply(false, nil)
			return
		}
		_ = req.Reply(true, nil)

		stdin := ""
		if strings.Contains(payload.Command, "sudo -S") {
			input, _ := io.ReadAll(channel)
			stdin = string(input)
		}
		server.record(fakeExecRecord{
			command: payload.Command,
			stdin:   stdin,
		})

		response := fakeExecResponse{}
		if server.handler != nil {
			response = server.handler(payload.Command, stdin)
		}
		if response.stdout != "" {
			_, _ = channel.Write([]byte(response.stdout))
		}
		if response.stderr != "" {
			_, _ = channel.Stderr().Write([]byte(response.stderr))
		}
		_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct {
			Status uint32
		}{Status: response.exitStatus}))
		return
	}
}

func (server *fakeExecServer) record(record fakeExecRecord) {
	server.mu.Lock()
	defer server.mu.Unlock()
	server.records = append(server.records, record)
}

func (server *fakeExecServer) Records() []fakeExecRecord {
	server.mu.Lock()
	defer server.mu.Unlock()
	return append([]fakeExecRecord(nil), server.records...)
}

func waitForSudoStatus(t *testing.T, events <-chan protocol.Event) protocol.SFTPSudoStatusPayload {
	t.Helper()
	timeout := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			if event.Type != protocol.EventSFTPSudoStatus {
				continue
			}
			payload, ok := event.Payload.(protocol.SFTPSudoStatusPayload)
			if !ok {
				t.Fatalf("unexpected sudo payload: %#v", event.Payload)
			}
			return payload
		case <-timeout:
			t.Fatal("timed out waiting for sudo status")
		}
	}
}

func waitForAck(t *testing.T, events <-chan protocol.Event) {
	t.Helper()
	timeout := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			if event.Type == protocol.EventSFTPAck {
				return
			}
		case <-timeout:
			t.Fatal("timed out waiting for ack")
		}
	}
}

func findExecRecord(records []fakeExecRecord, command string) *fakeExecRecord {
	for i := range records {
		if records[i].command == command {
			return &records[i]
		}
	}
	return nil
}

func commandList(records []fakeExecRecord) []string {
	commands := make([]string, 0, len(records))
	for _, record := range records {
		commands = append(commands, record.command)
	}
	return commands
}

func (record fakeExecRecord) String() string {
	return fmt.Sprintf("%s stdin=%q", record.command, record.stdin)
}
