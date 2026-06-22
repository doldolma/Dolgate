package sshsession_test

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"fmt"
	"net"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshsession"
)

// 종료 형태별로 ClosedPayload.Reason이 올바르게 분류되는지 엔드투엔드로 검증한다.
// 셸이 스스로 종료(exit-status 0)하면 remote-exit(탭 닫힘), reboot류 비정상 종료
// (시그널 종료 / 상태 없이 채널 닫힘)는 transport(재연결 대상)여야 한다.
func TestManagerCloseReasonClassification(t *testing.T) {
	cases := []struct {
		name string
		mode terminationMode
		want string
	}{
		{name: "exit-status 0 → remote-exit", mode: terminateExitZero, want: "remote-exit"},
		{name: "exit-signal HUP(reboot) → transport", mode: terminateSignal, want: "transport"},
		{name: "상태 없이 채널 닫힘 → transport", mode: terminateAbrupt, want: "transport"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			server, cleanup := newTerminatingSSHServer(t, tc.mode)
			defer cleanup()

			events := make(chan protocol.Event, 16)
			manager := sshsession.NewManager(func(event protocol.Event) {
				events <- event
			}, func(_ protocol.StreamFrame, _ []byte) {})

			if err := manager.Connect("sess", "req", protocol.ConnectPayload{
				Host:                 "127.0.0.1",
				Port:                 server.port,
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

			// 연결 수립 후 서버가 설정된 방식으로 세션을 종료하게 한다.
			close(server.terminate)

			closed := waitForEvent(t, events, protocol.EventClosed)
			payload, ok := closed.Payload.(protocol.ClosedPayload)
			if !ok {
				t.Fatalf("closed payload type = %T, want protocol.ClosedPayload", closed.Payload)
			}
			if payload.Reason != tc.want {
				t.Fatalf("close reason = %q, want %q", payload.Reason, tc.want)
			}
		})
	}
}

type terminationMode int

const (
	terminateExitZero terminationMode = iota // exit-status 0 전송 후 채널 닫음
	terminateSignal                          // exit-signal(HUP) 전송 후 채널 닫음
	terminateAbrupt                          // exit 정보 없이 채널만 닫음(ExitMissingError 유발)
)

type terminatingSSHServer struct {
	port          int
	hostKeyBase64 string
	terminate     chan struct{}
}

func newTerminatingSSHServer(t *testing.T, mode terminationMode) (*terminatingSSHServer, func()) {
	t.Helper()

	hostPrivateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostPrivateKey)
	if err != nil {
		t.Fatalf("create host signer: %v", err)
	}

	config := &ssh.ServerConfig{
		PasswordCallback: func(conn ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			if conn.User() == "tester" && string(password) == "s3cret" {
				return nil, nil
			}
			return nil, fmt.Errorf("invalid password")
		},
	}
	config.AddHostKey(hostSigner)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	_, portText, _ := net.SplitHostPort(listener.Addr().String())
	var port int
	fmt.Sscanf(portText, "%d", &port)

	server := &terminatingSSHServer{
		port:          port,
		hostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
		terminate:     make(chan struct{}),
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
			go handleTerminatingConnection(conn, config, mode, server.terminate)
		}
	}()

	cleanup := func() {
		_ = listener.Close()
		wg.Wait()
	}

	return server, cleanup
}

func handleTerminatingConnection(raw net.Conn, config *ssh.ServerConfig, mode terminationMode, terminate <-chan struct{}) {
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
			for req := range in {
				switch req.Type {
				case "pty-req":
					_ = req.Reply(true, nil)
				case "shell":
					_ = req.Reply(true, nil)
					_, _ = ch.Write([]byte("welcome\n"))
					// 테스트가 신호를 줄 때까지 기다렸다가 설정된 방식으로 종료한다.
					go func() {
						<-terminate
						terminateChannel(ch, mode)
					}()
				default:
					_ = req.Reply(false, nil)
				}
			}
		}(channel, requests)
	}
}

func terminateChannel(ch ssh.Channel, mode terminationMode) {
	switch mode {
	case terminateExitZero:
		// exit-status 0 → 클라이언트 Wait()가 nil 반환(정상 종료).
		_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{Status: 0}))
		_ = ch.Close()
	case terminateSignal:
		// exit-signal HUP → 클라이언트 Wait()가 *ssh.ExitError(Signal=="HUP") 반환.
		_, _ = ch.SendRequest("exit-signal", false, ssh.Marshal(struct {
			Signal     string
			CoreDumped bool
			Error      string
			Lang       string
		}{Signal: "HUP"}))
		_ = ch.Close()
	case terminateAbrupt:
		// exit 정보 없이 채널만 닫음 → 클라이언트 Wait()가 *ssh.ExitMissingError 반환.
		_ = ch.Close()
	}
}
