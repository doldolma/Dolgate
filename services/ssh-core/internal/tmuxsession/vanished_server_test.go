package tmuxsession

import (
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/pkg/coretypes"
)

// vanishingProxy 는 vanish() 뒤로 오가는 바이트를 버린다. 읽기는 계속해 TCP 는 살아 있는 척한다 — 전원이
// 끊긴 서버를 향한 연결의 모습이다(FIN/RST 가 오지 않는다). sshsession 테스트에 같은 것이 있다.
type vanishingProxy struct {
	ln       net.Listener
	mu       sync.Mutex
	conns    []net.Conn
	vanished atomic.Bool
}

func newVanishingProxy(t *testing.T, target string) *vanishingProxy {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	proxy := &vanishingProxy{ln: ln}
	go func() {
		for {
			client, err := ln.Accept()
			if err != nil {
				return
			}
			server, err := net.Dial("tcp", target)
			if err != nil {
				_ = client.Close()
				continue
			}
			proxy.mu.Lock()
			proxy.conns = append(proxy.conns, client, server)
			proxy.mu.Unlock()
			go proxy.pipe(client, server)
			go proxy.pipe(server, client)
		}
	}()
	t.Cleanup(proxy.close)
	return proxy
}

func (proxy *vanishingProxy) pipe(dst, src net.Conn) {
	buf := make([]byte, 32<<10)
	for {
		n, err := src.Read(buf)
		if n > 0 && !proxy.vanished.Load() {
			if _, writeErr := dst.Write(buf[:n]); writeErr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (proxy *vanishingProxy) vanish() { proxy.vanished.Store(true) }

func (proxy *vanishingProxy) addr() string { return proxy.ln.Addr().String() }

func (proxy *vanishingProxy) close() {
	_ = proxy.ln.Close()
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	for _, conn := range proxy.conns {
		_ = conn.Close()
	}
}

// startHandshakeOnlySSHServer 는 인증까지만 받아 주는 SSH 서버다. 채널은 열어 주지 않는다.
func startHandshakeOnlySSHServer(t *testing.T) string {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{
		PasswordCallback: func(ssh.ConnMetadata, []byte) (*ssh.Permissions, error) { return nil, nil },
	}
	config.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				_, channels, requests, err := ssh.NewServerConn(conn, config)
				if err != nil {
					_ = conn.Close()
					return
				}
				go ssh.DiscardRequests(requests)
				for channel := range channels {
					_ = channel.Reject(ssh.Prohibited, "handshake-only test server")
				}
			}()
		}
	}()
	return ln.Addr().String()
}

// 서버가 답 없이 사라졌을 때 보조 채널을 열던 작업자 때문에 tmux 탭이 닫히지 않던 것(sshsession 과 같은
// 결함). 정리가 작업자의 잠금을 기다리느라 연결을 끊는 데까지 가지 못했다.
func TestTmuxClosesWhenServerVanishesMidAuxChannelOpen(t *testing.T) {
	proxy := newVanishingProxy(t, startHandshakeOnlySSHServer(t))
	client, err := ssh.Dial("tcp", proxy.addr(), &ssh.ClientConfig{
		User:            "tester",
		Auth:            []ssh.AuthMethod{ssh.Password("s3cret")},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	closed := make(chan struct{}, 1)
	m := NewManager(func(event coretypes.Event) {
		if event.Type == coretypes.EventClosed {
			select {
			case closed <- struct{}{}:
			default:
			}
		}
	}, func(coretypes.StreamFrame, []byte) {})
	handle := &controlHandle{id: "ctl", client: client, closed: make(chan struct{})}
	m.mu.Lock()
	m.controls["ctl"] = handle
	m.mu.Unlock()

	proxy.vanish()
	go func() { _, _ = m.RunCompletionCommand("ctl", "echo hi", false, false) }()
	// 작업자가 보조 채널을 열며 서버의 답을 기다리기 시작할 때까지.
	time.Sleep(300 * time.Millisecond)

	go m.closeSession("ctl", "client requested disconnect", "client")
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("서버가 사라진 tmux 연결이 닫히지 않았다(closed 이벤트 없음) — 탭이 남는다")
	}
}
