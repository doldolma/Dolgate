package sshsession_test

import (
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshsession"
)

// vanishingProxy 는 테스트 서버 앞에 서서, vanish() 뒤로는 오가는 바이트를 버린다. 읽기는 계속해 커널이
// ACK 를 보내므로 TCP 는 살아 있는 척한다 — 전원이 끊긴 서버를 향한 연결이 재전송 한도에 닿기 전까지의
// 모습이다(FIN/RST 가 오지 않는다).
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

func (proxy *vanishingProxy) port() int { return proxy.ln.Addr().(*net.TCPAddr).Port }

func (proxy *vanishingProxy) close() {
	_ = proxy.ln.Close()
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	for _, conn := range proxy.conns {
		_ = conn.Close()
	}
}

// 서버가 답 없이 사라졌을 때 자동완성·세션 패널 작업자가 보조 채널을 여는 중이면, 그 작업자는 잠금을 쥔
// 채 서버의 답을 기다린다. 세션 정리가 그 잠금을 기다리느라 연결을 끊는 데까지 가지 못해 탭이 닫히지
// 않았다 — 탭을 닫아도, keepalive 가 끊김을 알아채도.
func TestSessionClosesWhenServerVanishesMidAuxChannelOpen(t *testing.T) {
	cases := []struct {
		name      string
		keepalive bool
	}{
		{"tab close", false},
		{"keepalive", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server, _, cleanup := newSSHTestServer(t)
			defer cleanup()
			proxy := newVanishingProxy(t, server.addr)

			config := sshsession.ManagerConfig{SSHKeepAliveInterval: -1}
			if tc.keepalive {
				config = sshsession.ManagerConfig{
					SSHKeepAliveInterval:     100 * time.Millisecond,
					SSHKeepAliveProbeTimeout: 100 * time.Millisecond,
					SSHKeepAliveMaxFailures:  2,
				}
			}
			events := make(chan protocol.Event, 64)
			manager := sshsession.NewManagerWithConfig(func(event protocol.Event) {
				select {
				case events <- event:
				default:
				}
			}, func(protocol.StreamFrame, []byte) {}, config)
			if err := manager.Connect("session-1", "req-1", protocol.ConnectPayload{
				Host:                 "127.0.0.1",
				Port:                 proxy.port(),
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

			proxy.vanish()
			go func() { _, _ = manager.RunCompletionCommand("session-1", "echo hi", false, false) }()
			// 작업자가 보조 채널을 열며 서버의 답을 기다리기 시작할 때까지.
			time.Sleep(300 * time.Millisecond)

			if !tc.keepalive {
				go func() { _ = manager.Disconnect("session-1") }()
			}
			deadline := time.After(3 * time.Second)
			for {
				select {
				case event := <-events:
					if event.Type == protocol.EventClosed {
						return
					}
				case <-deadline:
					t.Fatal("서버가 사라진 세션이 닫히지 않았다(closed 이벤트 없음) — 탭이 남는다")
				}
			}
		})
	}
}
