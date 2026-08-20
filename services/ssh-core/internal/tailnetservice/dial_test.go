package tailnetservice

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
	reauths int
	dials   int
	closes  int
	purges  int
	logouts int
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
		return tailnet.Status{State: tailnet.StateRunning, Online: true}, nil
	}
	return n.status, nil
}
func (n *dialNode) Down(context.Context) error   { return nil }
func (n *dialNode) Reauth(context.Context) error { n.reauths += 1; return nil }
func (n *dialNode) Logout(context.Context) error { n.logouts += 1; return nil }
func (n *dialNode) Close() error                 { n.closes += 1; return nil }
func (n *dialNode) Purge() error                 { n.purges += 1; return nil }

type identityProbeDialNode struct {
	*dialNode
	probes   int
	probeErr error
}

func (n *identityProbeDialNode) ProbeIdentity(context.Context) error {
	n.probes++
	if n.probeErr == nil {
		n.status.IdentityInvalid = true
	}
	return n.probeErr
}

type fakeConn struct {
	net.Conn
	closes int
}

func (c *fakeConn) Close() error { c.closes += 1; return nil }

func leaseCount(instance *Service, id string) int {
	return instance.tailnets.Leases(id)
}

func newDialRuntime(t *testing.T, node tailnet.Node) *Service {
	t.Helper()
	instance := &Service{emitEvent: func(coretypes.Event) {}}
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
		Online:      true,
		TailnetName: "someone-else.example.com",
	}}
	instance := newDialRuntime(t, node)

	dial, _ := instance.tailnetDial(TailnetRoute{ID: "corp", ExpectedName: "acme-corp.com"})
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
		Online:      true,
		TailnetName: "acme-corp.com",
	}}
	instance := newDialRuntime(t, node)

	dial, _ := instance.tailnetDial(TailnetRoute{ID: "corp", ExpectedName: "acme-corp.com"})
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
		Online:      true,
		TailnetName: "acme-corp.com",
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
	node := &dialNode{status: tailnet.Status{State: tailnet.StateRunning, Online: true}}
	instance := newDialRuntime(t, node)

	dial, _ := instance.tailnetDial(TailnetRoute{ID: "corp", ExpectedName: "acme-corp.com"})
	conn, err := dial(context.Background(), "tcp", "server:22")
	if err != nil {
		t.Fatalf("dial() error = %v", err)
	}
	_ = conn.Close()
}

func TestTailnetDialRejectedWhenSupportIsDisabled(t *testing.T) {
	instance := &Service{}

	if _, err := instance.tailnetDial(TailnetRoute{ID: "corp"}); err == nil {
		t.Error("expected tailnetDial to be rejected without a registry")
	}
}

// 인증이 남은 노드로는 dial 하지 않는다. 그대로 넘기면 tsnet 이 인증이 끝나기를 기다리다
// 예산을 다 쓰고 타임아웃으로 실패하는데, 그 메시지로는 무엇을 해야 할지 알 수 없다.
//
// 반대로 이 판단을 노드 계층(Up)에 두면 안 된다. 설정 화면의 연결 테스트는 Up 이 돌아온 뒤에야
// 상태를 폴링해 인증 URL 을 방출하므로, 거기서 붙들면 브라우저가 영원히 열리지 않는다.
func TestTailnetDialRefusesANodeThatStillNeedsAuth(t *testing.T) {
	cases := []struct {
		state tailnet.State
		want  error
	}{
		{tailnet.StateNeedsAuth, ErrTailnetNeedsAuth},
		{tailnet.StateNeedsApproval, ErrTailnetNeedsApproval},
	}

	for _, testCase := range cases {
		node := &dialNode{status: tailnet.Status{State: testCase.state}}
		instance := newDialRuntime(t, node)

		dial, _ := instance.tailnetDial(TailnetRoute{ID: "corp"})
		_, err := dial(context.Background(), "tcp", "server:22")

		if !errors.Is(err, testCase.want) {
			t.Fatalf("state %s: dial() error = %v, want %v", testCase.state, err, testCase.want)
		}
		if node.dials != 0 {
			t.Errorf("state %s: dialled the target anyway", testCase.state)
		}
		// 거부한 연결이 리스를 들고 있으면 노드가 유예에 들어가지 못한다.
		if leased := leaseCount(instance, "corp"); leased != 0 {
			t.Errorf("state %s: leases = %d after a refused dial, want 0", testCase.state, leased)
		}
	}
}

// Starting 은 막지 않는다 — 곧 Running 이 될 상태이고, tsnet 의 awaitRunning 이 기다려 준다.
// 여기서 거부하면 정상적인 첫 연결이 실패한다.
func TestTailnetDialProceedsWhileTheNodeIsStarting(t *testing.T) {
	node := &dialNode{status: tailnet.Status{State: tailnet.StateStarting}}
	instance := newDialRuntime(t, node)

	dial, _ := instance.tailnetDial(TailnetRoute{ID: "corp"})
	conn, err := dial(context.Background(), "tcp", "server:22")
	if err != nil {
		t.Fatalf("dial() error = %v, want the dial to proceed", err)
	}
	_ = conn.Close()
	if node.dials != 1 {
		t.Errorf("dials = %d, want 1", node.dials)
	}
}

// 만료가 확인됐으면 dial 하지 않는다. 그대로 보내면 예산을 다 쓰고 원인을 알 수 없는 타임아웃으로
// 끝나는데, 사용자는 호스트가 죽은 줄 알고 엉뚱한 곳을 본다.
func TestTailnetDialRefusesAnExpiredRegistration(t *testing.T) {
	node := &dialNode{status: tailnet.Status{State: tailnet.StateRunning, Online: true, Expired: true}}
	runtime := newDialRuntime(t, node)

	dial, err := runtime.tailnetDial(TailnetRoute{ID: "corp"})
	if err != nil {
		t.Fatalf("tailnetDial: %v", err)
	}

	_, err = dial(context.Background(), "tcp", "nas.corp.ts.net:22")
	if !errors.Is(err, ErrTailnetExpired) {
		t.Fatalf("err = %v, want ErrTailnetExpired", err)
	}
	if node.dials != 0 {
		t.Errorf("dials = %d, want 0 — an expired registration must not be dialed", node.dials)
	}
}

// 컨트롤 플레인과 동기화가 끊긴 것으로는 막지 않는다.
//
// online 은 map poll 롱폴이 지금 열려 있는지일 뿐이고, 데이터 플레인은 이미 받아 둔 넷맵으로 계속
// 통한다 — tailscale 자신도 이 상태를 8분이 지나서야 경고로 올리고, magicsock 은 컨트롤과 끊기면
// DERP 홈을 유지한다. 막았을 때 실제로 통하는 연결을 시도조차 못 하고, 관문은 3분을 태운 뒤
// 실패했다(사용자는 취소하고 다시 시도해서 붙였다).
func TestTailnetDialProceedsWhileTheControlPlaneSyncIsDown(t *testing.T) {
	node := &dialNode{status: tailnet.Status{State: tailnet.StateRunning, Online: false}}
	instance := newDialRuntime(t, node)

	dial, err := instance.tailnetDial(TailnetRoute{ID: "corp"})
	if err != nil {
		t.Fatalf("tailnetDial: %v", err)
	}

	conn, err := dial(context.Background(), "tcp", "nas.corp.ts.net:22")
	if err != nil {
		t.Fatalf("dial() error = %v — 동기화 끊김으로 dial 을 막으면 안 된다", err)
	}
	_ = conn.Close()
	if node.dials != 1 {
		t.Errorf("dials = %d, want 1", node.dials)
	}
}

func TestTailnetDialReRegistersADeletedIdentityBeforeDialing(t *testing.T) {
	invalid := &dialNode{status: tailnet.Status{
		State:           tailnet.StateRunning,
		Online:          false,
		IdentityInvalid: true,
	}}
	replacement := &dialNode{status: tailnet.Status{State: tailnet.StateRunning, Online: true}}
	nodes := []*dialNode{invalid, replacement}
	built := 0
	instance := &Service{emitEvent: func(coretypes.Event) {}}
	instance.tailnetConfigs = newTailnetConfigs(t.TempDir())
	instance.tailnetTests = newTailnetTests()
	instance.tailnets = tailnet.NewRegistry(func(string) (tailnet.Node, error) {
		node := nodes[built]
		built += 1
		return node, nil
	}, tailnet.Options{})
	t.Cleanup(func() { _ = instance.tailnets.Close() })

	dial, err := instance.tailnetDial(TailnetRoute{ID: "corp"})
	if err != nil {
		t.Fatalf("tailnetDial: %v", err)
	}
	conn, err := dial(context.Background(), "tcp", "nas.corp.ts.net:22")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_ = conn.Close()

	if built != 2 {
		t.Fatalf("nodes built = %d, want 2", built)
	}
	if invalid.dials != 0 || invalid.closes != 1 || invalid.purges != 1 || invalid.logouts != 0 {
		t.Fatalf("invalid node: dials=%d closes=%d purges=%d logouts=%d",
			invalid.dials, invalid.closes, invalid.purges, invalid.logouts)
	}
	if replacement.dials != 1 {
		t.Fatalf("replacement dials = %d, want 1", replacement.dials)
	}
}

func TestTailnetDialReplacesAnInvalidIdentityOnlyOncePerConfigGeneration(t *testing.T) {
	first := &dialNode{status: tailnet.Status{
		State: tailnet.StateRunning, IdentityInvalid: true,
	}}
	second := &dialNode{status: tailnet.Status{
		State: tailnet.StateRunning, IdentityInvalid: true,
	}}
	nodes := []*dialNode{first, second}
	built := 0
	instance := &Service{emitEvent: func(coretypes.Event) {}}
	instance.tailnetConfigs = newTailnetConfigs(t.TempDir())
	instance.tailnetConfigs.set(coretypes.TailnetConfigPayload{ID: "corp"})
	instance.tailnetTests = newTailnetTests()
	instance.tailnets = tailnet.NewRegistry(func(string) (tailnet.Node, error) {
		if built >= len(nodes) {
			t.Fatal("identity retry created more than one replacement node")
		}
		node := nodes[built]
		built++
		return node, nil
	}, tailnet.Options{})
	t.Cleanup(func() { _ = instance.tailnets.Close() })

	dial, err := instance.tailnetDial(TailnetRoute{ID: "corp"})
	if err != nil {
		t.Fatalf("tailnetDial: %v", err)
	}
	if _, err := dial(context.Background(), "tcp", "nas:22"); !errors.Is(err, ErrTailnetIdentityInvalid) {
		t.Fatalf("first dial error = %v, want ErrTailnetIdentityInvalid", err)
	}
	if _, err := dial(context.Background(), "tcp", "nas:22"); !errors.Is(err, ErrTailnetIdentityInvalid) {
		t.Fatalf("second dial error = %v, want ErrTailnetIdentityInvalid", err)
	}
	if built != 2 {
		t.Fatalf("nodes built = %d, want 2", built)
	}
}

func TestTailnetDialProbesAndReRegistersADeletedIdentityBeforeDialing(t *testing.T) {
	stale := &identityProbeDialNode{dialNode: &dialNode{status: tailnet.Status{
		State:  tailnet.StateRunning,
		Online: true,
	}}}
	replacement := &dialNode{status: tailnet.Status{State: tailnet.StateRunning, Online: true}}
	nodes := []tailnet.Node{stale, replacement}
	built := 0
	instance := &Service{emitEvent: func(coretypes.Event) {}}
	instance.tailnetConfigs = newTailnetConfigs(t.TempDir())
	instance.tailnetTests = newTailnetTests()
	instance.tailnets = tailnet.NewRegistry(func(string) (tailnet.Node, error) {
		node := nodes[built]
		built++
		return node, nil
	}, tailnet.Options{})
	t.Cleanup(func() { _ = instance.tailnets.Close() })

	dial, err := instance.tailnetDial(TailnetRoute{ID: "corp"})
	if err != nil {
		t.Fatalf("tailnetDial: %v", err)
	}
	conn, err := dial(context.Background(), "tcp", "nas.corp.ts.net:22")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_ = conn.Close()

	if stale.probes != 1 {
		t.Fatalf("identity probes = %d, want 1", stale.probes)
	}
	if built != 2 || stale.dials != 0 || stale.closes != 1 || stale.purges != 1 {
		t.Fatalf("stale node: built=%d dials=%d closes=%d purges=%d",
			built, stale.dials, stale.closes, stale.purges)
	}
	if replacement.dials != 1 {
		t.Fatalf("replacement dials = %d, want 1", replacement.dials)
	}
}

func TestTailnetDialDoesNotReplaceIdentityWhenProbeCannotReachControl(t *testing.T) {
	node := &identityProbeDialNode{
		dialNode: &dialNode{status: tailnet.Status{State: tailnet.StateRunning, Online: false}},
		probeErr: errors.New("control request timed out"),
	}
	runtime := newDialRuntime(t, node)

	dial, err := runtime.tailnetDial(TailnetRoute{ID: "corp"})
	if err != nil {
		t.Fatalf("tailnetDial: %v", err)
	}
	conn, err := dial(context.Background(), "tcp", "nas.corp.ts.net:22")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_ = conn.Close()

	if node.probes != 1 || node.dials != 1 || node.closes != 0 || node.purges != 0 {
		t.Fatalf("node: probes=%d dials=%d closes=%d purges=%d",
			node.probes, node.dials, node.closes, node.purges)
	}
}

// 만료가 아니면 평소처럼 나간다. 만료 검사가 멀쩡한 연결을 막으면 tailnet 이 전부 못 쓰게 된다.
func TestTailnetDialProceedsWhenNotExpired(t *testing.T) {
	node := &dialNode{status: tailnet.Status{State: tailnet.StateRunning, Online: true}}
	runtime := newDialRuntime(t, node)

	dial, err := runtime.tailnetDial(TailnetRoute{ID: "corp"})
	if err != nil {
		t.Fatalf("tailnetDial: %v", err)
	}

	if _, err := dial(context.Background(), "tcp", "nas.corp.ts.net:22"); err != nil {
		t.Fatalf("dial: %v", err)
	}
	if node.dials != 1 {
		t.Errorf("dials = %d, want 1", node.dials)
	}
}
