package tailnet

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

// fakeNode 는 레지스트리가 자기에게 무엇을 했는지 기록한다. 진짜 노드에는 컨트롤 플레인이
// 필요하지만, 여기서 검증하는 수명 규칙은 어느 것도 컨트롤 플레인에 의존하지 않는다.
type fakeNode struct {
	id string

	mu       sync.Mutex
	ups      int
	upEr     error
	logouts  int
	closes   int
	ops      []string
	status   Status
	logoutEr error
	closeEr  error
	purgeEr  error

	downEntered  chan struct{}
	closeEntered chan struct{}
	closeGate    chan struct{}
}

func (n *fakeNode) Dial(context.Context, string, string) (net.Conn, error) {
	return nil, errors.New("not dialled in these tests")
}

func (n *fakeNode) Status(context.Context) (Status, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.status.State == "" {
		return Status{State: StateRunning}, nil
	}
	return n.status, nil
}

func (n *fakeNode) Up(context.Context) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.ups += 1
	n.ops = append(n.ops, "up")
	return n.upEr
}

func (n *fakeNode) Logout(context.Context) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.logouts += 1
	n.ops = append(n.ops, "logout")
	return n.logoutEr
}

func (n *fakeNode) Close() error {
	n.mu.Lock()
	entered, gate := n.closeEntered, n.closeGate
	n.mu.Unlock()
	if entered != nil {
		entered <- struct{}{}
	}
	if gate != nil {
		<-gate
	}

	n.mu.Lock()
	defer n.mu.Unlock()
	n.closes += 1
	n.ops = append(n.ops, "close")
	return n.closeEr
}

// gateClose 는 다음 Close 를 붙잡아 둔다. Reset·Forget 의 해체가 락 밖에서 도는 창을 재현한다.
func (n *fakeNode) gateClose() (entered <-chan struct{}, release func()) {
	enteredCh := make(chan struct{}, 1)
	gate := make(chan struct{})
	n.mu.Lock()
	n.closeEntered = enteredCh
	n.closeGate = gate
	n.mu.Unlock()
	return enteredCh, func() { close(gate) }
}

// Discard 는 쓰는 곳이 있어도 서버를 닫는다. 취소가 쓰는 동작이다 — 리스를 이유로 남겨 두면
// 노드가 계속 살아 상태와 인증 링크를 보고해서 취소가 취소가 아니게 된다.
func TestDiscardClosesEvenWhileInUse(t *testing.T) {
	node := &fakeNode{}
	registry := NewRegistry(func(string) (Node, error) { return node, nil }, Options{})
	t.Cleanup(func() { _ = registry.Close() })

	lease, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}

	if err := registry.Discard("corp"); err != nil {
		t.Fatalf("Discard() error = %v", err)
	}
	if _, got := node.counts(); got != 1 {
		t.Fatalf("closes = %d, want 1 — 쓰는 중이라고 닫지 않았다", got)
	}

	// 없앤 뒤에는 그 tailnet 이 레지스트리에 없어야 한다(첫 실행과 같은 상태).
	if _, ok := registry.StatusOf(context.Background(), "corp"); ok {
		t.Fatal("Discard 뒤에도 항목이 남아 있다")
	}
	lease.Release()
}

// 강제 해체 뒤 남은 옛 리스가 새 노드를 깎으면 안 된다.
//
// release 는 id 로만 항목을 찾으므로, 세대 표시가 없으면 옛 리스의 Release 가 나중에 만들어진
// 노드의 refs 를 깎는다 — 쓰는 중인 노드가 유예에 들어가거나 내려간다.
func TestStaleLeaseReleaseIgnoredAfterDiscard(t *testing.T) {
	built := 0
	registry := NewRegistry(func(string) (Node, error) {
		built += 1
		return &fakeNode{}, nil
	}, Options{})
	t.Cleanup(func() { _ = registry.Close() })

	stale, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	if err := registry.Discard("corp"); err != nil {
		t.Fatalf("Discard() error = %v", err)
	}

	fresh, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("두 번째 Acquire() error = %v", err)
	}
	defer fresh.Release()
	if built != 2 {
		t.Fatalf("built = %d, want 2 — 해체 뒤에는 새 노드를 만들어야 한다", built)
	}

	stale.Release()

	if got := registry.Leases("corp"); got != 1 {
		t.Fatalf("leases = %d, want 1 — 옛 리스의 Release 가 새 노드를 깎았다", got)
	}
}

func (n *fakeNode) Reauth(context.Context) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.ops = append(n.ops, "reauth")
	return nil
}

func (n *fakeNode) Purge() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.ops = append(n.ops, "purge")
	return n.purgeEr
}

func (n *fakeNode) counts() (logouts, closes int) {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.logouts, n.closes
}

// order 는 수행된 순서대로 동작을 돌려준다. 계약의 일부는 발생 여부가 아니라 순서다.
func (n *fakeNode) order() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string(nil), n.ops...)
}

// manualTimer 는 time.AfterFunc 를 대신해 유예를 원하는 시점에 발동시킨다. 진짜 타이머를
// 기다리면 테스트가 느려지고, 진짜 타이머의 상태만으로는 "레지스트리가 취소했다"와 "아직
// 발동하지 않았다"를 구분할 수 없다 — 가짜는 취소를 직접 기록한다.
type manualTimer struct {
	mu      sync.Mutex
	pending []*pendingCall
}

type pendingCall struct {
	fn      func()
	stopped bool
	timer   *manualTimer
}

// Stop 은 Stopper 구현이다. time.Timer.Stop 과 동일하게 아직 예약돼 있었는지를 돌려준다.
func (c *pendingCall) Stop() bool {
	c.timer.mu.Lock()
	defer c.timer.mu.Unlock()
	if c.stopped {
		return false
	}
	c.stopped = true
	return true
}

func (m *manualTimer) afterFunc(_ time.Duration, fn func()) Stopper {
	m.mu.Lock()
	defer m.mu.Unlock()
	call := &pendingCall{fn: fn, timer: m}
	m.pending = append(m.pending, call)
	return call
}

// live 는 아직 예약돼 있는 콜백 수다. idleExpired 의 refcount 가드 덕분에 낡은 타이머가
// 발동해도 무해하므로, 동작만 단정해서는 레지스트리가 실제로 취소했는지 알 수 없다 —
// 이 함수가 "teardown 이 취소됐다"를 관찰 가능하게 만든다.
func (m *manualTimer) live() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for _, call := range m.pending {
		if !call.stopped {
			count += 1
		}
	}
	return count
}

// scheduled 는 취소 여부와 무관하게 타이머에 넘겨진 모든 콜백을 돌려준다. 이미 발동을
// 시작한 타이머는 되돌릴 수 없는데, 테스트가 그 상황을 재현하는 수단이다.
func (m *manualTimer) scheduled() []func() {
	m.mu.Lock()
	defer m.mu.Unlock()
	fns := make([]func(), 0, len(m.pending))
	for _, call := range m.pending {
		fns = append(fns, call.fn)
	}
	return fns
}

// fireAll 은 취소되지 않은 예약 콜백을 전부 실행한다.
func (m *manualTimer) fireAll() {
	m.mu.Lock()
	calls := make([]*pendingCall, 0, len(m.pending))
	for _, call := range m.pending {
		if !call.stopped {
			call.stopped = true
			calls = append(calls, call)
		}
	}
	m.pending = nil
	m.mu.Unlock()

	for _, call := range calls {
		call.fn()
	}
}

func newTestRegistry(t *testing.T) (*Registry, *manualTimer, map[string]*fakeNode) {
	t.Helper()
	timer := &manualTimer{}
	nodes := make(map[string]*fakeNode)
	var mu sync.Mutex
	registry := NewRegistry(func(id string) (Node, error) {
		mu.Lock()
		defer mu.Unlock()
		node := &fakeNode{id: id}
		nodes[id] = node
		return node, nil
	}, Options{AfterFunc: timer.afterFunc})
	t.Cleanup(func() { _ = registry.Close() })
	return registry, timer, nodes
}

// tailnet 을 키로 쓰는 이유 자체: 같은 tailnet 의 호스트들이 각자 노드를 갖게 되면 안 된다.
func TestAcquireSharesOneNodePerTailnet(t *testing.T) {
	registry, _, nodes := newTestRegistry(t)

	first, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	second, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	other, err := registry.Acquire("home")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}

	if first.Node != second.Node {
		t.Error("two consumers of the same tailnet got different nodes")
	}
	if first.Node == other.Node {
		t.Error("different tailnets share a node")
	}
	if len(nodes) != 2 {
		t.Errorf("built %d nodes, want 2", len(nodes))
	}
}

// 여러 소비자 중 하나를 놓는다고 나머지가 영향을 받으면 안 된다.
func TestNodeStaysUpWhileAnyConsumerRemains(t *testing.T) {
	registry, timer, nodes := newTestRegistry(t)

	first, _ := registry.Acquire("corp")
	second, _ := registry.Acquire("corp")

	first.Release()
	timer.fireAll()

	if _, closes := nodes["corp"].counts(); closes != 0 {
		t.Errorf("node was closed with a consumer still holding it (closes=%d)", closes)
	}

	second.Release()
	timer.fireAll()

	if _, closes := nodes["corp"].counts(); closes != 1 {
		t.Errorf("closes = %d after the last release, want 1", closes)
	}
}

// 유예는 닫은 직후의 재연결을 공짜로 만들기 위해 있다.
func TestReacquireDuringGraceKeepsTheNodeUp(t *testing.T) {
	registry, timer, nodes := newTestRegistry(t)

	lease, _ := registry.Acquire("corp")
	lease.Release()

	if timer.live() != 1 {
		t.Fatalf("release scheduled %d teardowns, want 1", timer.live())
	}

	// 유예가 지나기 전에 누군가 다시 온다.
	again, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("re-acquire: %v", err)
	}

	// 예약된 teardown 은 refcount 가드에 의해 무해해지는 게 아니라 실제로 취소돼야 한다 —
	// 아니면 낡은 타이머가 프로세스가 사는 내내 쌓인다.
	if live := timer.live(); live != 0 {
		t.Errorf("re-acquire left %d teardown(s) scheduled, want 0", live)
	}

	timer.fireAll()

	if _, closes := nodes["corp"].counts(); closes != 0 {
		t.Errorf("node was closed despite being re-acquired during grace (closes=%d)", closes)
	}
	if again.Node != nodes["corp"] {
		t.Error("re-acquire built a new node instead of reusing the idle one")
	}
}

// 타이머 취소만으로는 부족하다. 유예가 끝나 teardown 이 시작되는 순간에 새 소비자가 도착할
// 수 있다. 이미 발동을 시작한 타이머는 Stop 해도 소용없으므로, teardown 이 락을 잡은 뒤
// refcount 를 다시 확인해야 한다.
func TestTeardownAlreadyInFlightYieldsToANewConsumer(t *testing.T) {
	registry, timer, nodes := newTestRegistry(t)

	lease, _ := registry.Acquire("corp")
	lease.Release()

	// 아직 예약 상태일 때 콜백을 붙잡아 둔다 — 곧 실행될 teardown 이다.
	inFlight := timer.scheduled()
	if len(inFlight) != 1 {
		t.Fatalf("release scheduled %d teardowns, want 1", len(inFlight))
	}

	// 소비자가 먼저 도착해 타이머를 취소하지만, 콜백은 이미 가는 중이라 그대로 실행된다.
	again, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("re-acquire: %v", err)
	}
	inFlight[0]()

	if _, closes := nodes["corp"].counts(); closes != 0 {
		t.Errorf("an in-flight teardown closed a node that had been re-acquired (closes=%d)", closes)
	}

	// 그리고 그 뒤에도 노드는 정상적으로 쓰인다.
	again.Release()
	timer.fireAll()
	if _, closes := nodes["corp"].counts(); closes != 1 {
		t.Errorf("closes = %d after the real release, want 1", closes)
	}
}

// 유휴 해체는 노드를 **닫는다**.
//
// Down(WantRunning 만 끄기)으로는 tsnet 서버가 살아남아 계속 컨트롤 플레인과 통신하고 DERP 에
// 붙으려 한다 — 사용자에게는 연결이 끝난 것인데 상태가 계속 바뀌고, 그 노드가 낡은 netmap 을
// 들고 있어서 다음 연결 때 만료된 등록을 정상으로 보고한다.
//
// 등록과 노드 키는 상태 디렉터리에 남으므로, 다음 Acquire 가 만드는 새 노드는 재인증 없이
// 올라온다. 로그아웃은 하지 않는다 — 그것이 등록을 버리는 동작이다.
func TestIdleTeardownClosesButKeepsTheRegistration(t *testing.T) {
	registry, timer, nodes := newTestRegistry(t)

	lease, _ := registry.Acquire("corp")
	first := nodes["corp"]
	lease.Release()
	timer.fireAll()

	logouts, closes := first.counts()
	if closes != 1 {
		t.Errorf("closes = %d, want 1", closes)
	}
	if logouts != 0 {
		t.Errorf("유휴 해체가 로그아웃했다 — 등록을 버리면 다음 연결에 재인증이 생긴다 (logouts=%d)", logouts)
	}

	// 다음 소비자는 새 노드를 받는다. 닫힌 노드를 재사용하면 통신하지 못한다.
	again, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("acquire after idle teardown: %v", err)
	}
	if again.Node == first {
		t.Error("닫힌 노드를 그대로 다시 내줬다")
	}
	again.Release()
}

// 등록 해제는 노드를 닫기 전에 컨트롤 플레인에 닿아야 한다 — 닫힌 노드는 통신하지 못하므로
// 순서가 실제 삭제 여부를 가른다.
func TestForgetLogsOutThenCloses(t *testing.T) {
	registry, _, nodes := newTestRegistry(t)

	lease, _ := registry.Acquire("corp")
	lease.Release()

	if err := registry.Forget(context.Background(), "corp"); err != nil {
		t.Fatalf("forget: %v", err)
	}

	// 순서가 중요하다. 닫힌 노드는 컨트롤 플레인에 닿지 못하므로 먼저 닫으면 등록이 남은 채
	// 방치될 뿐이다. Purge 는 파일이 닫힌 뒤라야 하므로 마지막이다.
	if got := nodes["corp"].order(); len(got) != 3 ||
		got[0] != "logout" || got[1] != "close" || got[2] != "purge" {
		t.Errorf("operations were %v, want [logout close purge]", got)
	}

	// 다음 Acquire 는 새 노드로 처음부터 시작한다.
	previous := nodes["corp"]
	if _, err := registry.Acquire("corp"); err != nil {
		t.Fatalf("acquire after forget: %v", err)
	}
	if nodes["corp"] == previous {
		t.Error("acquire after forget reused the forgotten node")
	}
}

// 로그아웃이 실패해도 노드는 닫아야 한다 — 아니면 실패한 등록 해제가 프로세스가 사는 내내
// 노드를 누수시킨다.
func TestForgetClosesEvenWhenLogoutFails(t *testing.T) {
	registry, _, nodes := newTestRegistry(t)

	lease, _ := registry.Acquire("corp")
	lease.Release()
	nodes["corp"].logoutEr = errors.New("control plane unreachable")

	err := registry.Forget(context.Background(), "corp")
	if err == nil {
		t.Fatal("expected the logout failure to surface")
	}
	// 로그아웃 실패가 뒤 단계를 건너뛰게 만들면, 노드는 열린 채로 죽은 키까지 디스크에 남는다.
	if got := nodes["corp"].order(); len(got) != 3 ||
		got[0] != "logout" || got[1] != "close" || got[2] != "purge" {
		t.Errorf("operations were %v after a failed logout, want [logout close purge]", got)
	}
}

func TestForgetUnknownTailnetIsNotAnError(t *testing.T) {
	registry, _, _ := newTestRegistry(t)

	if err := registry.Forget(context.Background(), "never-registered"); err != nil {
		t.Errorf("forget on an unknown tailnet returned %v, want nil", err)
	}
}

func TestReleaseIsIdempotent(t *testing.T) {
	registry, timer, nodes := newTestRegistry(t)

	first, _ := registry.Acquire("corp")
	second, _ := registry.Acquire("corp")

	first.Release()
	first.Release() // defer Release 와 명시적 Release 가 겹치는 경우

	timer.fireAll()

	// 이중 Release 가 두 번째 소비자까지 없애버리면 안 된다.
	if _, closes := nodes["corp"].counts(); closes != 0 {
		t.Errorf("double release tore down a node still in use (closes=%d)", closes)
	}
	second.Release()
}

func TestCloseClosesEveryNodeAndRefusesFurtherAcquires(t *testing.T) {
	registry, _, nodes := newTestRegistry(t)

	corp, _ := registry.Acquire("corp")
	home, _ := registry.Acquire("home")
	corp.Release()
	home.Release()

	if err := registry.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	for id, node := range nodes {
		if _, closes := node.counts(); closes != 1 {
			t.Errorf("%s: closes = %d, want 1", id, closes)
		}
	}

	if _, err := registry.Acquire("corp"); !errors.Is(err, ErrClosed) {
		t.Errorf("acquire after close returned %v, want ErrClosed", err)
	}
}

func TestAcquirePropagatesFactoryFailure(t *testing.T) {
	registry := NewRegistry(func(string) (Node, error) {
		return nil, errors.New("no credentials configured")
	}, Options{})
	t.Cleanup(func() { _ = registry.Close() })

	if _, err := registry.Acquire("corp"); err == nil {
		t.Fatal("expected the factory failure to surface")
	}
}

// 설정이 바뀌면 노드를 다시 만들어야 한다. Reset 이 등록까지 지워 버리면 auth key 하나
// 고칠 때마다 브라우저 로그인을 다시 해야 하므로, 로그아웃하지 않는 것이 핵심이다.
func TestResetClosesWithoutLoggingOut(t *testing.T) {
	registry, _, nodes := newTestRegistry(t)

	lease, _ := registry.Acquire("corp")
	lease.Release()
	previous := nodes["corp"]

	if err := registry.Reset("corp"); err != nil {
		t.Fatalf("Reset() error = %v", err)
	}

	if got := previous.order(); len(got) != 1 || got[0] != "close" {
		t.Errorf("operations were %v, want [close] — logout/purge would drop the registration", got)
	}

	again, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("acquire after reset: %v", err)
	}
	if again.Node == previous {
		t.Error("acquire after reset reused the old node, so the new config never took effect")
	}
}

// 세션이 얹힌 노드를 그 밑에서 닫으면 그 세션이 죽는다.
func TestResetRefusesWhileInUse(t *testing.T) {
	registry, _, nodes := newTestRegistry(t)

	lease, _ := registry.Acquire("corp")
	defer lease.Release()

	err := registry.Reset("corp")
	if !errors.Is(err, ErrNodeInUse) {
		t.Fatalf("Reset() error = %v, want ErrNodeInUse", err)
	}
	if got := nodes["corp"].order(); len(got) != 0 {
		t.Errorf("operations were %v, want none — the node must be untouched", got)
	}
}

func TestResetUnknownTailnetIsNotAnError(t *testing.T) {
	registry, _, _ := newTestRegistry(t)

	if err := registry.Reset("never-registered"); err != nil {
		t.Errorf("Reset() on an unknown tailnet error = %v, want nil", err)
	}
}

// 유예 타이머가 남아 있으면 나중에 발동해 새 노드를 엉뚱하게 내린다.
func TestResetStopsTheIdleTimer(t *testing.T) {
	registry, timer, nodes := newTestRegistry(t)

	lease, _ := registry.Acquire("corp")
	lease.Release() // 유예 시작

	if err := registry.Reset("corp"); err != nil {
		t.Fatalf("Reset() error = %v", err)
	}
	if timer.live() != 0 {
		t.Errorf("live timers = %d after Reset, want 0", timer.live())
	}

	again, _ := registry.Acquire("corp")
	timer.fireAll()
	if _, closes := nodes["corp"].counts(); closes != 0 {
		t.Errorf("the stale timer closed the replacement node (closes=%d)", closes)
	}
	again.Release()
}

// 사용자가 지금 끊겠다고 한 것. 유휴 유예를 기다리지 않을 뿐, 등록은 남아야 한다 —
// 로그아웃하면 다음 연결에서 브라우저 로그인을 다시 해야 한다.
func TestDisconnectClosesWithoutLoggingOut(t *testing.T) {
	registry, _, nodes := newTestRegistry(t)

	lease, _ := registry.Acquire("corp")
	first := nodes["corp"]
	lease.Release()

	if err := registry.Disconnect(context.Background(), "corp"); err != nil {
		t.Fatalf("Disconnect() error = %v", err)
	}

	// 닫기만 한다. 로그아웃은 등록을 버리는 동작이라, 그러면 다시 연결할 때 재인증이 생긴다.
	if got := first.order(); len(got) != 1 || got[0] != "close" {
		t.Errorf("operations were %v, want [close]", got)
	}

	// 다음 소비자는 새 노드를 받는다 — 등록은 상태 디렉터리에 남아 있으므로 재인증은 없다.
	again, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("acquire after disconnect: %v", err)
	}
	if again.Node == first {
		t.Error("닫힌 노드를 그대로 다시 내줬다")
	}
	again.Release()
}

// 유예 타이머를 세워 둔 채 닫으면, 나중에 그 타이머가 발동해 새로 올라온 노드를 닫는다.
func TestDisconnectStopsTheIdleTimer(t *testing.T) {
	registry, timer, nodes := newTestRegistry(t)

	lease, _ := registry.Acquire("corp")
	first := nodes["corp"]
	lease.Release() // 유예 시작

	if err := registry.Disconnect(context.Background(), "corp"); err != nil {
		t.Fatalf("Disconnect() error = %v", err)
	}
	if timer.live() != 0 {
		t.Errorf("live timers = %d after Disconnect, want 0", timer.live())
	}
	if _, closes := first.counts(); closes != 1 {
		t.Errorf("closes = %d, want 1 — 연결 종료는 노드를 닫는다", closes)
	}

	again, _ := registry.Acquire("corp")
	replacement := nodes["corp"]
	timer.fireAll()
	if _, closes := replacement.counts(); closes != 0 {
		t.Errorf("낡은 타이머가 새 노드를 닫았다 (closes=%d)", closes)
	}
	again.Release()
}

func TestDisconnectUnknownTailnetIsNotAnError(t *testing.T) {
	registry, _, _ := newTestRegistry(t)

	if err := registry.Disconnect(context.Background(), "never-registered"); err != nil {
		t.Errorf("Disconnect() on an unknown tailnet error = %v, want nil", err)
	}
}

// 설정 화면이 "무엇이 연결돼 있는가"를 아는 유일한 수단. 없는 tailnet 을 위해 노드를
// 만들어 버리면, 화면을 여는 것만으로 전부 붙어 버린다.
func TestSnapshotOnlyReportsLiveNodes(t *testing.T) {
	registry, _, nodes := newTestRegistry(t)

	lease, _ := registry.Acquire("corp")
	lease.Release()
	nodes["corp"].status = Status{State: StateRunning}

	snapshot := registry.Snapshot(context.Background())

	if len(snapshot) != 1 {
		t.Fatalf("snapshot has %d entries, want 1: %#v", len(snapshot), snapshot)
	}
	if snapshot["corp"].State != StateRunning {
		t.Errorf("corp state = %q, want running", snapshot["corp"].State)
	}
	if _, ok := snapshot["never-acquired"]; ok {
		t.Error("snapshot invented a node that was never acquired")
	}
	if len(nodes) != 1 {
		t.Errorf("snapshot built %d nodes, want 1", len(nodes))
	}
}

// leasedConn.Close 는 핸드셰이크 실패 정리와 SSH 읽기 루프에서 각각 불리고, 그 둘은 다른
// goroutine 이다. 겹쳐 불렸을 때 refcount 가 두 번 깎이면 아직 쓰는 중인 노드가 유예에
// 들어간다 — 같은 tailnet 에 다른 세션이 얹혀 있으면 그 세션이 30 분 뒤 끊긴다.
//
// -race 로 돌려야 의미가 있다. bool 가드였을 때 이 테스트는 레이스로 잡혔다.
func TestConcurrentReleaseDecrementsOnce(t *testing.T) {
	registry, timer, _ := newTestRegistry(t)

	survivor, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer survivor.Release()
	doubled, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 4; i += 1 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			doubled.Release()
		}()
	}
	wg.Wait()

	if got := registry.Leases("corp"); got != 1 {
		t.Errorf("Leases() = %d, want 1 — 살아 있는 리스가 있는데 refcount 가 더 깎였다", got)
	}
	// refs 가 남아 있으므로 유예 자체가 예약되지 않아야 한다.
	if got := timer.live(); got != 0 {
		t.Errorf("live timers = %d, want 0 — 쓰는 중인 노드에 teardown 이 예약됐다", got)
	}
}

// 유예가 만료돼 Down 이 진행되는 중(락 밖)에 도착한 Acquire 는 기다려야 한다. 기다리지
// 않으면 그 소비자가 Up 으로 올린 노드를 뒤늦게 도착한 Down 이 다시 꺼 버린다.
func TestAcquireWaitsForInFlightIdleTeardown(t *testing.T) {
	registry, timer, nodes := newTestRegistry(t)

	lease, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	node := nodes["corp"]
	entered, release := node.gateClose()
	lease.Release()

	teardownDone := make(chan struct{})
	go func() { defer close(teardownDone); timer.fireAll() }()
	<-entered // 해체가 락을 놓고 Down 안에 들어왔다

	acquired := make(chan *Lease, 1)
	go func() {
		fresh, ferr := registry.Acquire("corp")
		if ferr != nil {
			t.Errorf("acquire during teardown: %v", ferr)
			acquired <- nil
			return
		}
		acquired <- fresh
	}()

	// 해체가 끝나기 전에는 리스가 나오지 않아야 한다.
	select {
	case <-acquired:
		t.Fatal("해체 중인 노드에 리스가 발급됐다 — Close 가 이 소비자 뒤에 도착한다")
	case <-time.After(50 * time.Millisecond):
	}

	release()
	<-teardownDone

	fresh := <-acquired
	if fresh == nil {
		t.Fatal("해체가 끝난 뒤에도 리스를 받지 못했다")
	}
	defer fresh.Release()

	// 기다린 소비자는 **새** 노드를 받아야 한다. 닫히는 중이던 그 노드를 내주면 통신하지 못한다.
	if fresh.Node == node {
		t.Error("닫히는 중이던 노드를 기다린 소비자에게 내줬다")
	}
	if got := node.order(); len(got) != 1 || got[0] != "close" {
		t.Errorf("order() = %v, want [close]", got)
	}
}

// countingRegistry 는 노드를 몇 개 만들었는지 센다. Reset·Forget 의 핵심 위험이 "닫히는 중인
// 노드 밑에서 두 번째 노드가 만들어지는 것"이라, 노드 수가 곧 계약이다.
func countingRegistry(t *testing.T) (*Registry, *manualTimer, func() int, func() *fakeNode) {
	t.Helper()
	timer := &manualTimer{}
	var mu sync.Mutex
	built := 0
	var last *fakeNode
	registry := NewRegistry(func(id string) (Node, error) {
		mu.Lock()
		defer mu.Unlock()
		built += 1
		last = &fakeNode{id: id}
		return last, nil
	}, Options{AfterFunc: timer.afterFunc})
	t.Cleanup(func() { _ = registry.Close() })
	return registry, timer,
		func() int { mu.Lock(); defer mu.Unlock(); return built },
		func() *fakeNode { mu.Lock(); defer mu.Unlock(); return last }
}

// Reset 이 Close 를 끝내기 전에 항목을 지우면, 그 창에 도착한 Acquire 가 같은 상태 디렉터리로
// 두 번째 노드를 만든다. tsnet 서버 둘이 같은 노드키 파일을 두고 겹치게 된다.
func TestResetDoesNotLetANewNodeStartWhileClosing(t *testing.T) {
	registry, _, built, lastNode := countingRegistry(t)

	lease, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	node := lastNode()
	lease.Release()

	entered, release := node.gateClose()
	resetDone := make(chan error, 1)
	go func() { resetDone <- registry.Reset("corp") }()
	<-entered // Reset 이 락을 놓고 Close 안에 들어왔다

	acquired := make(chan *Lease, 1)
	go func() {
		fresh, ferr := registry.Acquire("corp")
		if ferr != nil {
			t.Errorf("acquire during reset: %v", ferr)
		}
		acquired <- fresh
	}()

	select {
	case <-acquired:
		t.Fatal("닫히는 중인 노드 위에서 Acquire 가 통과했다 — 두 번째 노드가 같은 상태로 뜬다")
	case <-time.After(50 * time.Millisecond):
	}
	if got := built(); got != 1 {
		t.Fatalf("nodes built = %d during close, want 1", got)
	}

	release()
	if err := <-resetDone; err != nil {
		t.Fatalf("Reset() error = %v", err)
	}

	fresh := <-acquired
	if fresh == nil {
		t.Fatal("Reset 이 끝난 뒤에도 리스를 받지 못했다")
	}
	defer fresh.Release()

	// Reset 의 목적은 새 설정으로 다시 만들게 하는 것이다 — 닫힌 노드를 재사용하면 안 된다.
	if got := built(); got != 2 {
		t.Errorf("nodes built = %d, want 2 — Reset 뒤 Acquire 는 새 노드를 만들어야 한다", got)
	}
	if fresh.Node == node {
		t.Error("Acquire reused the closed node")
	}
}

// Forget 은 Purge 까지 한다. 그 창에 새 노드가 같은 디렉터리를 잡으면 방금 만든 노드의 키가
// 지워진다 — Reset 보다 나쁘다.
func TestForgetDoesNotLetANewNodeStartWhileTearingDown(t *testing.T) {
	registry, _, built, lastNode := countingRegistry(t)

	lease, err := registry.Acquire("corp")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	node := lastNode()
	lease.Release()

	entered, release := node.gateClose()
	forgetDone := make(chan error, 1)
	go func() { forgetDone <- registry.Forget(context.Background(), "corp") }()
	<-entered

	acquired := make(chan *Lease, 1)
	go func() {
		fresh, ferr := registry.Acquire("corp")
		if ferr != nil {
			t.Errorf("acquire during forget: %v", ferr)
		}
		acquired <- fresh
	}()

	select {
	case <-acquired:
		t.Fatal("Purge 가 남은 해체 중에 Acquire 가 통과했다 — 새 노드의 키가 지워진다")
	case <-time.After(50 * time.Millisecond):
	}

	release()
	if err := <-forgetDone; err != nil {
		t.Fatalf("Forget() error = %v", err)
	}

	fresh := <-acquired
	if fresh == nil {
		t.Fatal("Forget 이 끝난 뒤에도 리스를 받지 못했다")
	}
	defer fresh.Release()

	// 해체 순서는 그대로 지켜져야 한다. Purge 가 Close 뒤여야 상태 파일이 닫힌 뒤 지워진다.
	if got := node.order(); len(got) < 3 ||
		got[len(got)-3] != "logout" || got[len(got)-2] != "close" || got[len(got)-1] != "purge" {
		t.Errorf("order() = %v, want …logout, close, purge", got)
	}
	if got := built(); got != 2 {
		t.Errorf("nodes built = %d, want 2", got)
	}
}

// 판정은 이 두 함수에만 있다. 여기가 흔들리면 관문과 dial 안전망이 동시에 흔들린다.
func TestStatusConnectedRequiresALiveControlPlaneSession(t *testing.T) {
	// 만료돼도 새 netmap 이 오지 않으면 running 이 그대로 남는다. 그것을 연결됨으로 읽으면
	// 연결 흐름이 tailnet 을 기다리지 않고 SSH 로 넘어가고, 사용자는 브라우저에서 로그인하는
	// 중에 화면이 실패로 뒤집히는 것을 본다.
	for name, status := range map[string]Status{
		"컨트롤 플레인과 끊김": {State: StateRunning, Online: false},
		"만료":          {State: StateRunning, Online: true, Expired: true},
		"인증 대기":       {State: StateNeedsAuth, Online: true},
		"승인 대기":       {State: StateNeedsApproval, Online: true},
		"기동 중":        {State: StateStarting, Online: true},
		"중단됨":         {State: StateStopped, Online: true},
	} {
		t.Run(name, func(t *testing.T) {
			if status.Connected() {
				t.Errorf("%s 은 확실히 연결된 것이 아니다: %#v", name, status)
			}
		})
	}

	connected := Status{State: StateRunning, Online: true}
	if !connected.Connected() {
		t.Error("살아 있는 세션 + 인가 + 만료 아님은 연결됨이어야 한다")
	}
}

// 관문과 다른 질문이다. 노드가 막 올라오는 중이면 확실히 막힌 것이 아니므로 통과시켜야 한다 —
// tsnet 의 Dial 이 Running 을 기다려 주고, 여기서 막으면 기동 직후 첫 연결이 깨진다.
func TestStatusBlockedReasonOnlyReportsDefiniteBlockers(t *testing.T) {
	for name, expected := range map[string]struct {
		status Status
		reason BlockReason
	}{
		"인증 대기":      {Status{State: StateNeedsAuth}, BlockNeedsAuth},
		"승인 대기":      {Status{State: StateNeedsApproval}, BlockNeedsApproval},
		"만료":         {Status{State: StateRunning, Online: true, Expired: true}, BlockExpired},
		"낡은 running": {Status{State: StateRunning, Online: false}, BlockOffline},
		"기동 중":       {Status{State: StateStarting}, ""},
		"연결됨":        {Status{State: StateRunning, Online: true}, ""},
	} {
		t.Run(name, func(t *testing.T) {
			if got := expected.status.BlockedReason(); got != expected.reason {
				t.Errorf("BlockedReason() = %q, want %q", got, expected.reason)
			}
		})
	}
}
