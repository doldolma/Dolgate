package runtime

import (
	"context"
	"errors"
	"net"
	"testing"

	"dolssh/services/ssh-core/internal/tailnet"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// dialNode 는 Dial 을 흉내내고 리스 수명을 관찰할 수 있게 하는 노드다.
type dialNode struct {
	ups     int
	dials   int
	dialErr error
	status  tailnet.Status
	conns   []*fakeConn
}

func (n *dialNode) Dial(context.Context, string, string) (net.Conn, error) {
	n.dials += 1
	if n.dialErr != nil {
		return nil, n.dialErr
	}
	conn := &fakeConn{}
	n.conns = append(n.conns, conn)
	return conn, nil
}

func (n *dialNode) Up(context.Context) error { n.ups += 1; return nil }
func (n *dialNode) Status(context.Context) (tailnet.Status, error) {
	if n.status.State == "" {
		return tailnet.Status{State: tailnet.StateRunning}, nil
	}
	return n.status, nil
}
func (n *dialNode) Down(context.Context) error   { return nil }
func (n *dialNode) Logout(context.Context) error { return nil }
func (n *dialNode) Close() error                 { return nil }
func (n *dialNode) Purge() error                 { return nil }

type fakeConn struct {
	net.Conn
	closes int
}

func (c *fakeConn) Close() error { c.closes += 1; return nil }

func leaseCount(instance *Runtime, id string) int {
	return instance.tailnets.Leases(id)
}

func newDialRuntime(t *testing.T, node tailnet.Node) *Runtime {
	t.Helper()
	instance := &Runtime{emitEvent: func(coretypes.Event) {}}
	instance.tailnetConfigs = newTailnetConfigs(t.TempDir())
	instance.tailnetTests = newTailnetTests()
	instance.tailnets = tailnet.NewRegistry(
		func(string) (tailnet.Node, error) { return node, nil },
		tailnet.Options{},
	)
	t.Cleanup(func() { _ = instance.tailnets.Close() })
	return instance
}

// 경로가 없으면 평소처럼 직접 TCP 로 나가야 한다. nil 이 그 신호다.
func TestTailnetDialWithoutARouteIsNil(t *testing.T) {
	instance := newDialRuntime(t, &dialNode{})

	dial, err := instance.tailnetDial(TailnetRoute{})
	if err != nil {
		t.Fatalf("tailnetDial() error = %v", err)
	}
	if dial != nil {
		t.Error("tailnetDial() returned a dialer for an empty route")
	}
	if _, err := instance.tailnetDial(TailnetRoute{ID: "   "}); err != nil {
		t.Errorf("a blank id should also mean no route: %v", err)
	}
}

// conn 이 닫힐 때 리스가 풀려야 한다. 이것이 이 설계의 전부다 — 호출부가 리스를 들고 다니지
// 않는 대신, conn 수명이 리스 수명이다.
func TestTailnetDialReleasesTheLeaseWhenTheConnCloses(t *testing.T) {
	node := &dialNode{}
	instance := newDialRuntime(t, node)

	dial, err := instance.tailnetDial(TailnetRoute{ID: "corp"})
	if err != nil {
		t.Fatalf("tailnetDial() error = %v", err)
	}
	conn, err := dial(context.Background(), "tcp", "server:22")
	if err != nil {
		t.Fatalf("dial() error = %v", err)
	}
	if node.ups != 1 {
		t.Errorf("Up called %d times, want 1", node.ups)
	}
	if leased := leaseCount(instance, "corp"); leased != 1 {
		t.Fatalf("leases = %d while the conn is open, want 1", leased)
	}

	if err := conn.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if leased := leaseCount(instance, "corp"); leased != 0 {
		t.Errorf("leases = %d after closing the conn, want 0", leased)
	}
	if node.conns[0].closes != 1 {
		t.Errorf("underlying conn closed %d times, want 1", node.conns[0].closes)
	}
}

// Close 는 여러 번 불릴 수 있다(핸드셰이크 실패 경로와 정상 종료가 겹칠 때). 리스를 두 번
// 풀면 아직 쓰는 중인 노드가 내려간다.
func TestTailnetDialReleasesTheLeaseOnlyOnce(t *testing.T) {
	node := &dialNode{}
	instance := newDialRuntime(t, node)

	dial, _ := instance.tailnetDial(TailnetRoute{ID: "corp"})
	first, err := dial(context.Background(), "tcp", "server:22")
	if err != nil {
		t.Fatalf("dial() error = %v", err)
	}
	second, err := dial(context.Background(), "tcp", "server:22")
	if err != nil {
		t.Fatalf("second dial() error = %v", err)
	}

	_ = first.Close()
	_ = first.Close()
	_ = first.Close()

	// 두 번째 연결이 아직 쓰는 중이므로 리스가 남아 있어야 한다.
	if leased := leaseCount(instance, "corp"); leased != 1 {
		t.Errorf("leases = %d after closing one conn three times, want 1", leased)
	}
	_ = second.Close()
	if leased := leaseCount(instance, "corp"); leased != 0 {
		t.Errorf("leases = %d after closing both, want 0", leased)
	}
}

// dial 이 실패하면 그 자리에서 리스를 놓아야 한다. 안 놓으면 노드가 유예에 못 들어가고
// 영원히 떠 있는다.
func TestTailnetDialReleasesTheLeaseWhenDialFails(t *testing.T) {
	node := &dialNode{dialErr: errors.New("no route to host")}
	instance := newDialRuntime(t, node)

	dial, _ := instance.tailnetDial(TailnetRoute{ID: "corp"})
	if _, err := dial(context.Background(), "tcp", "server:22"); err == nil {
		t.Fatal("dial() error = nil, want the failure")
	}
	if leased := leaseCount(instance, "corp"); leased != 0 {
		t.Errorf("leases = %d after a failed dial, want 0", leased)
	}
}

// 다른 계정으로 로그인해 엉뚱한 tailnet 에 붙은 상태로 연결을 진행하면, 그 tailnet 의 같은
// 이름 머신에 붙게 된다. 호스트 키 검증 전에 끊어야 한다.
func TestTailnetDialRefusesADifferentTailnet(t *testing.T) {
	node := &dialNode{status: tailnet.Status{
		State:       tailnet.StateRunning,
		TailnetName: "someone-else.example.com",
	}}
	instance := newDialRuntime(t, node)

	dial, _ := instance.tailnetDial(TailnetRoute{ID: "corp", ExpectedName: "gridwiz.com"})
	_, err := dial(context.Background(), "tcp", "server:22")

	if !errors.Is(err, ErrTailnetMismatch) {
		t.Fatalf("dial() error = %v, want ErrTailnetMismatch", err)
	}
	if node.dials != 0 {
		t.Error("dialled the target despite the mismatch")
	}
	if leased := leaseCount(instance, "corp"); leased != 0 {
		t.Errorf("leases = %d after a refused dial, want 0", leased)
	}
}

func TestTailnetDialAllowsTheExpectedTailnet(t *testing.T) {
	node := &dialNode{status: tailnet.Status{
		State:       tailnet.StateRunning,
		TailnetName: "gridwiz.com",
	}}
	instance := newDialRuntime(t, node)

	dial, _ := instance.tailnetDial(TailnetRoute{ID: "corp", ExpectedName: "gridwiz.com"})
	conn, err := dial(context.Background(), "tcp", "server:22")
	if err != nil {
		t.Fatalf("dial() error = %v", err)
	}
	_ = conn.Close()
}

// 이름을 모르는 설정(기록 전에 만든 것)까지 막으면 멀쩡한 설정이 전부 못 쓰게 된다.
func TestTailnetDialAllowsAnUnknownExpectedName(t *testing.T) {
	node := &dialNode{status: tailnet.Status{
		State:       tailnet.StateRunning,
		TailnetName: "gridwiz.com",
	}}
	instance := newDialRuntime(t, node)

	dial, _ := instance.tailnetDial(TailnetRoute{ID: "corp"})
	conn, err := dial(context.Background(), "tcp", "server:22")
	if err != nil {
		t.Fatalf("dial() error = %v", err)
	}
	_ = conn.Close()
}

// 컨트롤 플레인이 이름을 안 알려 주는 경우도 막지 않는다 — 우리가 모르는 것을 이유로 연결을
// 거부하면 안 된다.
func TestTailnetDialAllowsWhenTheControlPlaneReportsNoName(t *testing.T) {
	node := &dialNode{status: tailnet.Status{State: tailnet.StateRunning}}
	instance := newDialRuntime(t, node)

	dial, _ := instance.tailnetDial(TailnetRoute{ID: "corp", ExpectedName: "gridwiz.com"})
	conn, err := dial(context.Background(), "tcp", "server:22")
	if err != nil {
		t.Fatalf("dial() error = %v", err)
	}
	_ = conn.Close()
}

func TestTailnetDialRejectedWhenSupportIsDisabled(t *testing.T) {
	instance := &Runtime{}

	if _, err := instance.tailnetDial(TailnetRoute{ID: "corp"}); err == nil {
		t.Error("expected tailnetDial to be rejected without a registry")
	}
}
