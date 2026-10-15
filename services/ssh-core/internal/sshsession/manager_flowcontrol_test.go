package sshsession_test

import (
	"bytes"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/flowcontrol"
	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshsession"
)

// floodShell 은 `yes` 처럼 끝없이 출력한다. 클라이언트가 읽지 않아 창이 바닥나면 Write 가 막힌다.
func floodShell(ch ssh.Channel, server *sshTestServer) {
	block := bytes.Repeat([]byte("0123456789012345678901234567890\n"), 1024)
	for {
		n, err := ch.Write(block)
		server.floodWritten.Add(int64(n))
		if err != nil {
			return
		}
	}
}

// finiteShell 은 n 바이트를 쓰고 끝난다 — exit-status 0 을 보내고 채널을 닫는다(`seq …; exit` 처럼).
func finiteShell(ch ssh.Channel, n int) {
	block := bytes.Repeat([]byte("0123456789012345678901234567890\n"), 1024)
	for written := 0; written < n; {
		chunk := block
		if rest := n - written; rest < len(chunk) {
			chunk = chunk[:rest]
		}
		count, err := ch.Write(chunk)
		written += count
		if err != nil {
			return
		}
	}
	_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
	_ = ch.Close()
}

// settle 은 값이 quiet 동안 더 늘지 않을 때까지 기다려 그 값을 준다.
func settle(t *testing.T, value *atomic.Int64, quiet, limit time.Duration) int64 {
	t.Helper()
	deadline := time.Now().Add(limit)
	last := value.Load()
	lastChange := time.Now()
	for time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
		if current := value.Load(); current != last {
			last = current
			lastChange = time.Now()
			continue
		}
		if time.Since(lastChange) >= quiet {
			return last
		}
	}
	t.Fatalf("값이 %v 안에 멈추지 않았다(마지막 %d)", limit, last)
	return 0
}

// 화면이 처리하지 못한 출력이 상한을 넘으면 채널을 읽지 않아, 서버가 창(2MB) 너머로는 보내지 못하고
// 기다려야 한다. 처리했다고 알리면 다시 흘러야 한다.
func TestManagerPausesRemoteOutputUntilAcked(t *testing.T) {
	server, _, cleanup := newSSHTestServer(t, func(s *sshTestServer) { s.floodingShell = true })
	defer cleanup()

	const high = 256 << 10
	flow := flowcontrol.NewWithLimits(high, 64<<10, time.Minute)
	events := make(chan protocol.Event, 16)
	var received atomic.Int64
	manager := sshsession.NewManagerWithConfig(func(event protocol.Event) {
		select {
		case events <- event:
		default:
		}
	}, func(frame protocol.StreamFrame, payload []byte) {
		// 런타임의 출력 통로가 하는 일(pkg/runtime): 내보낸 양을 센다.
		flow.Sent(frame.SessionID, len(payload))
		received.Add(int64(len(payload)))
	}, sshsession.ManagerConfig{FlowControl: flow})

	flow.Start("session-1")
	if err := manager.Connect("session-1", "req-1", protocol.ConnectPayload{
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
	defer func() { _ = manager.Disconnect("session-1") }()

	paused := settle(t, &received, 300*time.Millisecond, 5*time.Second)
	if paused < high || paused > high+64<<10 {
		t.Fatalf("멈췄을 때 받은 양 = %d, 상한(%d) 근처여야 한다", paused, high)
	}
	written := settle(t, &server.floodWritten, 300*time.Millisecond, 5*time.Second)
	if written > paused+(2<<20)+(64<<10) {
		t.Fatalf("서버가 %d 바이트를 보냈다 — 받은 양(%d)+창(2MB)을 넘으면 읽기를 멈춰도 쌓인다", written, paused)
	}

	flow.Ack("session-1", paused)
	resumed := settle(t, &received, 300*time.Millisecond, 5*time.Second)
	if resumed < paused+high {
		t.Fatalf("처리했다고 알렸는데 더 흐르지 않았다(%d → %d)", paused, resumed)
	}
}

// 원격이 끝날 때, 화면이 못 따라가 멈춰 둔 출력(받아 두었지만 아직 읽지 않은 것)이 closed 보다 먼저
// 나가야 한다. 녹화·공유·탭은 closed 에서 닫히므로 그 뒤에 나간 출력은 버려진다.
func TestManagerEmitsBufferedOutputBeforeClosed(t *testing.T) {
	const high = 256 << 10
	// 읽기를 멈춘 뒤에도 서버가 창(2MB) 안에서 마저 다 쓰고 끝낼 수 있는 양.
	const total = high + 1<<20
	server, _, cleanup := newSSHTestServer(t, func(s *sshTestServer) { s.finiteShellBytes = total })
	defer cleanup()

	flow := flowcontrol.NewWithLimits(high, 64<<10, time.Minute)
	var mu sync.Mutex
	received := 0
	receivedAtClose := -1
	closed := make(chan struct{})
	events := make(chan protocol.Event, 16)
	manager := sshsession.NewManagerWithConfig(func(event protocol.Event) {
		if event.Type == protocol.EventClosed {
			mu.Lock()
			if receivedAtClose < 0 {
				receivedAtClose = received
				close(closed)
			}
			mu.Unlock()
		}
		select {
		case events <- event:
		default:
		}
	}, func(frame protocol.StreamFrame, payload []byte) {
		flow.Sent(frame.SessionID, len(payload))
		mu.Lock()
		received += len(payload)
		mu.Unlock()
	}, sshsession.ManagerConfig{FlowControl: flow})

	flow.Start("session-1")
	if err := manager.Connect("session-1", "req-1", protocol.ConnectPayload{
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

	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("원격이 끝났는데 closed 가 오지 않았다")
	}
	// closed 뒤에 출력이 더 오는지 본다.
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if receivedAtClose != total || received != total {
		t.Fatalf("closed 때까지 받은 양 %d, 끝까지 받은 양 %d — 둘 다 %d 여야 한다", receivedAtClose, received, total)
	}
}
