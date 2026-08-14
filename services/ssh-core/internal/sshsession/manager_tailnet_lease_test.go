package sshsession_test

import (
	"context"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/internal/sshsession"
)

// leaseCounter 는 tailnet 리스 회계를 흉내낸다.
//
// 실제 구조가 이것이다(tailnetservice/dial.go): dial 마다 리스를 하나 잡고, **그 conn 이 닫힐 때**
// 놓는다. 그래서 "세션 경로가 자기가 연 conn 을 반드시 닫는가" 가 곧 "리스가 새지 않는가" 다.
// 리스가 새면 노드가 유예에 들어가지 못해 "연결 종료" 가 영원히 거절된다 — 실기기에서 터미널을
// 여러 개 열었다 닫은 뒤 그 상태가 됐다.
type leaseCounter struct {
	dialTarget string

	held    atomic.Int64
	granted atomic.Int64
}

func (c *leaseCounter) dial(ctx context.Context, network, _ string) (net.Conn, error) {
	// 리스를 먼저 잡는다(dial.go 와 같은 순서).
	c.held.Add(1)
	c.granted.Add(1)
	dialer := &net.Dialer{}
	conn, err := dialer.DialContext(ctx, network, c.dialTarget)
	if err != nil {
		c.held.Add(-1)
		return nil, err
	}
	return &leasedTestConn{Conn: conn, counter: c}, nil
}

type leasedTestConn struct {
	net.Conn
	counter *leaseCounter
	once    sync.Once
}

func (c *leasedTestConn) Close() error {
	err := c.Conn.Close()
	// 실제 Lease.Release 는 멱등이다. 여기서도 같게 둔다 — 두 번 놓는 것을 성공으로 세면
	// 새는 것을 못 잡는다.
	c.once.Do(func() { c.counter.held.Add(-1) })
	return err
}

// waitForNoLeases 는 리스가 0 이 되기를 짧게 기다린다. 해제는 읽기 루프 goroutine 에서 일어나므로
// 종료 명령이 돌아온 직후에는 아직 진행 중일 수 있다.
func waitForNoLeases(t *testing.T, counter *leaseCounter) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if counter.held.Load() == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf(
		"tailnet 리스가 %d 개 남았다(발급 %d 개) — 노드가 유예에 들어가지 못해 '연결 종료' 가 거절된다",
		counter.held.Load(), counter.granted.Load(),
	)
}

func newLeaseCountingManager(
	t *testing.T,
	counter *leaseCounter,
) (*sshsession.Manager, chan protocol.Event) {
	t.Helper()
	events := make(chan protocol.Event, 64)
	manager := sshsession.NewManagerWithConfig(
		func(event protocol.Event) {
			select {
			case events <- event:
			default:
			}
		},
		func(protocol.StreamFrame, []byte) {},
		sshsession.ManagerConfig{
			TCPDialTimeout: 3 * time.Second,
			TailnetDial: func(string, string) (sshconn.DialFunc, error) {
				return counter.dial, nil
			},
		},
	)
	return manager, events
}

func tailnetConnectPayload(server *sshTestServer) protocol.ConnectPayload {
	return protocol.ConnectPayload{
		// tailnet 안의 이름이라 실제로 이 주소로 dial 되지는 않는다 — dialer 가 서버로 보낸다.
		Host:                 "host.tailnet",
		Port:                 22,
		Username:             "tester",
		AuthType:             "password",
		Password:             "s3cret",
		TrustedHostKeyBase64: server.hostKeyBase64,
		TailnetID:            "corp",
		Cols:                 80,
		Rows:                 24,
	}
}

// 기준선: 하나 열고 닫으면 리스가 돌아온다. 사용자도 "하나씩 하면 괜찮다" 고 했다.
func TestTailnetLeaseReturnsAfterASingleSession(t *testing.T) {
	server, _, cleanup := newSSHTestServer(t)
	defer cleanup()
	counter := &leaseCounter{dialTarget: server.addr}
	manager, events := newLeaseCountingManager(t, counter)

	if err := manager.Connect("session-1", "req-1", tailnetConnectPayload(server)); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	waitForEvent(t, events, protocol.EventConnected)
	if got := counter.held.Load(); got != 1 {
		t.Fatalf("연결 중 리스 = %d, want 1", got)
	}

	if err := manager.Disconnect("session-1"); err != nil {
		t.Fatalf("Disconnect() error = %v", err)
	}
	waitForNoLeases(t, counter)
}

// 사용자가 본 경우: 여러 개를 동시에 열고 전부 닫는다.
func TestTailnetLeasesReturnAfterManyConcurrentSessions(t *testing.T) {
	server, _, cleanup := newSSHTestServer(t)
	defer cleanup()
	counter := &leaseCounter{dialTarget: server.addr}
	manager, events := newLeaseCountingManager(t, counter)

	const sessions = 5
	var wg sync.WaitGroup
	errs := make(chan error, sessions)
	for index := 0; index < sessions; index += 1 {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			id := fmt.Sprintf("session-%d", index)
			if err := manager.Connect(id, "req-"+id, tailnetConnectPayload(server)); err != nil {
				errs <- fmt.Errorf("%s: %w", id, err)
			}
		}(index)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("Connect() error = %v", err)
	}
	for index := 0; index < sessions; index += 1 {
		waitForEvent(t, events, protocol.EventConnected)
	}
	if got := counter.held.Load(); got != sessions {
		t.Fatalf("연결 중 리스 = %d, want %d", got, sessions)
	}

	// 탭을 전부 닫는다.
	for index := 0; index < sessions; index += 1 {
		id := fmt.Sprintf("session-%d", index)
		if err := manager.Disconnect(id); err != nil {
			t.Fatalf("Disconnect(%s) error = %v", id, err)
		}
	}
	waitForNoLeases(t, counter)
}

// 아무도 답하지 않은 프롬프트가 이 연결을 붙잡고 있으면 안 된다.
//
// 이것이 실기기에서 tailnet 을 잠근 경로다. 코어는 사람의 답을 기다리며 tailnet 노드의 리스를 들고
// 있는데, 데스크톱은 자기 요청 예산이 지나면 오류만 보이고 **코어에는 아무것도 보내지 않는다**.
// 그래서 카드를 닫았거나 화면이 그 질문을 놓친 경우, 코어는 영원히 서 있고 설정의 "연결 종료" 는
// 계속 "이 Tailnet 을 사용하는 연결이 있습니다" 로 거절된다.
func TestUnansweredPromptDoesNotHoldTheTailnetLease(t *testing.T) {
	restore := sshconn.HumanAnswerBudget
	sshconn.HumanAnswerBudget = 300 * time.Millisecond
	defer func() { sshconn.HumanAnswerBudget = restore }()

	serverFailures := make(chan error, 4)
	server, _, cleanup := newSSHTestServer(t,
		withOtpKeyboardInteractive("s3cret", "123456", serverFailures),
	)
	defer cleanup()
	counter := &leaseCounter{dialTarget: server.addr}
	manager, events := newLeaseCountingManager(t, counter)

	connectDone := make(chan error, 1)
	go func() {
		connectDone <- manager.Connect("session-mute", "req-mute", tailnetConnectPayload(server))
	}()

	// 코드를 묻는 창이 떴다. 아무도 답하지 않는다 — 사용자가 카드를 닫은 상태와 같다.
	waitForEvent(t, events, protocol.EventKeyboardInteractiveChallenge)
	if got := counter.held.Load(); got != 1 {
		t.Fatalf("묻는 동안 리스 = %d, want 1", got)
	}

	select {
	case err := <-connectDone:
		if err == nil {
			t.Fatal("Connect() error = nil, want the unanswered-prompt failure")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("답이 없는 프롬프트가 연결을 붙잡고 있다 — 예산이 듣지 않는다")
	}
	waitForNoLeases(t, counter)
}

// 탭을 닫고 곧바로 다시 붙이는 경우(재연결). 매번 새 conn 이므로 매번 놓여야 한다.
//
// 세션 ID 는 라운드마다 새로 만든다 — 데스크톱도 연결마다 새 UUID 를 만든다(core-manager 의
// startCoreSession). 같은 ID 를 곧바로 재사용하면 앞 세션의 정리가 뒤 시도의 dial 을 끊는데, 그
// 경로는 제품에 존재하지 않으므로 여기서 흉내내지 않는다.
func TestTailnetLeasesReturnAcrossReconnects(t *testing.T) {
	server, _, cleanup := newSSHTestServer(t)
	defer cleanup()
	counter := &leaseCounter{dialTarget: server.addr}
	manager, events := newLeaseCountingManager(t, counter)

	for round := 0; round < 4; round += 1 {
		id := fmt.Sprintf("session-churn-%d", round)
		if err := manager.Connect(id, "req-churn", tailnetConnectPayload(server)); err != nil {
			t.Fatalf("round %d: Connect() error = %v", round, err)
		}
		waitForEvent(t, events, protocol.EventConnected)
		if err := manager.Disconnect(id); err != nil {
			t.Fatalf("round %d: Disconnect() error = %v", round, err)
		}
		waitForNoLeases(t, counter)
	}
	if got := counter.granted.Load(); got != 4 {
		t.Fatalf("발급된 리스 = %d, want 4 — 라운드마다 새 conn 이어야 한다", got)
	}
}
