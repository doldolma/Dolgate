package runtime

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/tailnet"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// id 는 설정에서 오는 값이라 경로 구분자나 상위 참조가 섞일 수 있다. 그대로 쓰면 상태
// 디렉터리가 루트 밖으로 새어나가고, 노드키를 엉뚱한 경로에 쓰게 된다.
func TestSanitizeTailnetDirKeepsStateInsideTheRoot(t *testing.T) {
	cases := []struct {
		id   string
		want string
	}{
		{"corp", "corp"},
		{"my-tailnet_1", "my-tailnet_1"},
		{"../../etc", "______etc"},
		{"a/b", "a_b"},
		{`a\b`, "a_b"},
		{"", "unnamed"},
		{"..", "__"},
	}

	root := "/state"
	for _, testCase := range cases {
		got := sanitizeTailnetDir(testCase.id)
		if got != testCase.want {
			t.Errorf("sanitizeTailnetDir(%q) = %q, want %q", testCase.id, got, testCase.want)
		}

		full := filepath.Join(root, got)
		if !strings.HasPrefix(filepath.Clean(full), filepath.Clean(root)+string(filepath.Separator)) {
			t.Errorf("id %q produced %q, which escapes %q", testCase.id, full, root)
		}
	}
}

// 설정이 없는 tailnet 을 만들라는 요청은 조용히 넘어가면 안 된다 — 인증 정보 없이 노드를
// 만들면 사용자가 이유를 모르는 로그인 화면을 보게 된다.
func TestNewNodeRejectsUnconfiguredTailnet(t *testing.T) {
	configs := newTailnetConfigs(t.TempDir())

	if _, err := configs.newNode("never-registered"); err == nil {
		t.Fatal("expected an error for a tailnet with no configuration")
	}
}

// 상태 루트가 없으면 tsnet 이 os.UserConfigDir() 밑에 제멋대로 만든다. 앱 데이터 밖이라
// 사용자가 찾을 수도, 등록 해제로 지울 수도 없으므로 여기서 막는다.
func TestNewNodeRequiresAStateRoot(t *testing.T) {
	configs := newTailnetConfigs("")
	configs.set(coretypes.TailnetConfigPayload{ID: "corp"})

	_, err := configs.newNode("corp")
	if err == nil {
		t.Fatal("expected an error when no state directory is configured")
	}
	if !strings.Contains(err.Error(), "state directory") {
		t.Errorf("error %q does not explain the missing state directory", err)
	}
}

func TestNewNodeCreatesPerTailnetDirectories(t *testing.T) {
	root := t.TempDir()
	configs := newTailnetConfigs(root)
	configs.set(coretypes.TailnetConfigPayload{ID: "corp"})
	configs.set(coretypes.TailnetConfigPayload{ID: "home"})

	for _, id := range []string{"corp", "home"} {
		node, err := configs.newNode(id)
		if err != nil {
			t.Fatalf("newNode(%q): %v", id, err)
		}
		t.Cleanup(func() { _ = node.Close() })

		if _, err := filepath.Abs(filepath.Join(root, id)); err != nil {
			t.Fatalf("resolve dir: %v", err)
		}
	}

	// 두 tailnet 이 상태를 공유하면 노드키가 섞여 서로를 밀어낸다.
	corpDir := filepath.Join(root, "corp")
	homeDir := filepath.Join(root, "home")
	if corpDir == homeDir {
		t.Fatal("tailnets share a state directory")
	}
	for _, dir := range []string{corpDir, homeDir} {
		if info, err := statDir(dir); err != nil {
			t.Errorf("%s: %v", dir, err)
		} else if !info {
			t.Errorf("%s was not created", dir)
		}
	}
}

// remove 는 등록 해제 뒤 설정을 지운다. 남아 있으면 다음 Acquire 가 사라진 노드를 다시
// 만들어 버린다.
func TestRemoveDropsTheConfiguration(t *testing.T) {
	configs := newTailnetConfigs(t.TempDir())
	configs.set(coretypes.TailnetConfigPayload{ID: "corp"})
	configs.remove("corp")

	if _, err := configs.newNode("corp"); err == nil {
		t.Fatal("expected the removed tailnet to be unconfigured")
	}
}

// tailnet 지원이 꺼진 런타임은 명확히 거절해야 한다.
func TestTailnetCommandsRejectedWhenDisabled(t *testing.T) {
	instance := &Runtime{}

	if err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config: coretypes.TailnetConfigPayload{ID: "corp"},
	}); err == nil {
		t.Error("expected TailnetTest to be rejected without a registry")
	}
	if err := instance.TailnetForget("req-2", coretypes.TailnetForgetPayload{ID: "corp"}); err == nil {
		t.Error("expected TailnetForget to be rejected without a registry")
	}
}

func statDir(path string) (bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return false, err
	}
	return info.IsDir(), nil
}

// 종료가 tailnet 노드를 안 닫으면 컨트롤 플레인에 붙은 채로 남는다. 실제로 그랬다 —
// Shutdown 이 레지스트리를 건드리지 않아서, 앱을 꺼도 노드가 연결 상태로 보였다.
func TestShutdownClosesTailnetNodes(t *testing.T) {
	closed := 0
	instance := &Runtime{}
	instance.tailnets = tailnet.NewRegistry(func(string) (tailnet.Node, error) {
		return &countingNode{onClose: func() { closed += 1 }}, nil
	}, tailnet.Options{})

	lease, err := instance.tailnets.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	lease.Release()

	instance.shutdownTailnets()

	if closed != 1 {
		t.Errorf("nodes closed = %d, want 1", closed)
	}
}

// tailnet 이 꺼진 빌드/환경에서도 종료가 터지면 안 된다.
func TestShutdownWithoutTailnetRegistryIsSafe(t *testing.T) {
	instance := &Runtime{}
	instance.shutdownTailnets()
}

// 종료는 로그아웃하지 않는다. 로그아웃하면 등록이 사라져서 다음 실행 때 브라우저 로그인을
// 처음부터 다시 해야 한다.
func TestShutdownDoesNotLogOut(t *testing.T) {
	node := &countingNode{}
	instance := &Runtime{}
	instance.tailnets = tailnet.NewRegistry(func(string) (tailnet.Node, error) {
		return node, nil
	}, tailnet.Options{})

	lease, _ := instance.tailnets.Acquire("corp")
	lease.Release()
	instance.shutdownTailnets()

	if _, logouts := node.counts(); logouts != 0 {
		t.Errorf("logouts = %d on shutdown, want 0 — logging out would force a fresh browser login", logouts)
	}
}

// countingNode 는 노드 하나를 대신한다.
//
// 모든 접근에 락이 필요하다. TailnetTest 는 노드가 올라오는 동안 별도 goroutine 에서 상태를
// 폴링하므로, 테스트가 status 를 갈아 끼우는 것과 런타임이 그것을 읽는 것이 실제로 겹친다 —
// 락이 없으면 그 자체가 데이터 레이스이고, tailnet 런타임을 -race 로 검사할 수 없게 된다.
type countingNode struct {
	closes  int
	downs   int
	mu      sync.Mutex
	onClose func()
	logouts int
	ups     int
	upErr   error
	status  tailnet.Status
}

// setStatus 는 노드가 보고할 상태를 바꾼다. 폴링 중에도 안전하다.
func (n *countingNode) setStatus(status tailnet.Status) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.status = status
}

func (n *countingNode) counts() (ups, logouts int) {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.ups, n.logouts
}

func (n *countingNode) Dial(context.Context, string, string) (net.Conn, error) {
	return nil, errors.New("not dialable")
}
func (n *countingNode) Status(context.Context) (tailnet.Status, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.status.State == "" {
		return tailnet.Status{State: tailnet.StateStopped}, nil
	}
	return n.status, nil
}
func (n *countingNode) Up(context.Context) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.ups += 1
	return n.upErr
}

func (n *countingNode) Logout(context.Context) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.logouts += 1
	return nil
}

func (n *countingNode) Close() error {
	n.mu.Lock()
	n.closes += 1
	onClose := n.onClose
	n.mu.Unlock()
	if onClose != nil {
		onClose()
	}
	return nil
}

func (n *countingNode) Purge() error { return nil }

// 올리는 데 실패하면 기다리게 두지 말고 그대로 알려야 한다.
func TestTailnetTestReportsAFailureToBringTheNodeUp(t *testing.T) {
	node := &countingNode{
		status: tailnet.Status{State: tailnet.StateRunning, Online: true},
		upErr:  errors.New("control plane unreachable"),
	}
	var events []coretypes.Event
	instance := newTailnetTestRuntime(t, node)
	instance.emitEvent = func(event coretypes.Event) { events = append(events, event) }

	err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config: coretypes.TailnetConfigPayload{ID: "corp"},
	})

	if err == nil {
		t.Fatal("TailnetTest() error = nil, want the bring-up failure")
	}
	if len(events) != 1 {
		t.Fatalf("emitted %d events, want 1: %#v", len(events), events)
	}
	status, ok := events[0].Payload.(coretypes.TailnetStatusPayload)
	if !ok || status.Error == "" {
		t.Errorf("event did not carry the failure: %#v", events[0].Payload)
	}
}

func newTailnetTestRuntime(t *testing.T, node tailnet.Node) *Runtime {
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

// 노드 이름을 비워 두면 기기 이름을 쓴다. 상수를 쓰면 같은 사용자의 기기 둘이 같은 이름으로
// 등록돼 컨트롤 플레인이 -1, -2 를 붙이고, 설정이 동기화되면 더 확실히 겹친다.
func TestDefaultNodeHostnameCombinesThePrefixAndMachineName(t *testing.T) {
	machine, err := os.Hostname()
	if err != nil {
		t.Skipf("machine has no hostname: %v", err)
	}
	want := "dolgate-" + strings.TrimSuffix(machine, ".local")

	got := defaultNodeHostname()
	if got != want {
		t.Errorf("defaultNodeHostname() = %q, want %q", got, want)
	}
	// 접두사가 없으면 기기 목록에서 Dolgate 노드인지 알 수 없다 — 같은 기기의 진짜
	// Tailscale 클라이언트와 구분되지 않는다.
	if !strings.HasPrefix(got, "dolgate-") {
		t.Errorf("defaultNodeHostname() = %q, want a dolgate- prefix", got)
	}
	// 기기 이름이 없으면 같은 사용자의 기기끼리 겹친다.
	if got == "dolgate" {
		t.Error("fell back to the shared constant, which collides across devices")
	}
}

// 비워 둔 설정은 팩토리에서 기기 이름으로 채워져야 한다.
func TestNewNodeFillsInTheHostname(t *testing.T) {
	configs := newTailnetConfigs(t.TempDir())
	configs.set(coretypes.TailnetConfigPayload{ID: "corp"})

	// 노드를 실제로 만들되(tsnet 은 기동하지 않는다) 이름이 비어 있지 않은지만 본다.
	node, err := configs.newNode("corp")
	if err != nil {
		t.Fatalf("newNode() error = %v", err)
	}
	t.Cleanup(func() { _ = node.Close() })

	if defaultNodeHostname() == "" {
		t.Fatal("defaultNodeHostname() is empty, so the node would register unnamed")
	}
}

// 브라우저 로그인은 최대 3 분까지 사람을 기다린다. 접을 방법이 없으면 그때까지 갇힌다.
func TestTailnetCancelStopsAnInFlightTest(t *testing.T) {
	// Running 에 영영 도달하지 않는 노드. 취소가 없으면 타임아웃까지 폴링한다.
	node := &countingNode{status: tailnet.Status{State: tailnet.StateNeedsAuth}}
	instance := newTailnetTestRuntime(t, node)

	done := make(chan error, 1)
	go func() {
		done <- instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
			Config:    coretypes.TailnetConfigPayload{ID: "corp"},
			TimeoutMs: 60_000,
		})
	}()

	// 시도가 등록될 때까지 기다렸다가 접는다.
	deadline := time.After(2 * time.Second)
	for {
		if instance.tailnetTests.cancel("corp") {
			break
		}
		select {
		case <-deadline:
			t.Fatal("the test never registered itself as cancellable")
		case <-time.After(5 * time.Millisecond):
		}
	}

	select {
	case err := <-done:
		// 사용자가 접은 것은 실패가 아니다.
		if err != nil {
			t.Errorf("TailnetTest() error = %v, want nil after a cancel", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("TailnetTest did not return after being cancelled")
	}
}

// 없는 시도를 접는 것은 아무 일도 아니어야 한다.
func TestTailnetCancelWithNothingInFlight(t *testing.T) {
	instance := newTailnetTestRuntime(t, &countingNode{})

	if err := instance.TailnetCancel("req-1", coretypes.TailnetDisconnectPayload{
		ID: "corp",
	}); err != nil {
		t.Errorf("TailnetCancel() error = %v, want nil", err)
	}
}

// 같은 tailnet 을 다시 시도하면 앞의 것이 접혀야 한다. 아니면 폴링 루프가 둘 돈다.
func TestSecondTestSupersedesTheFirst(t *testing.T) {
	node := &countingNode{status: tailnet.Status{State: tailnet.StateNeedsAuth}}
	instance := newTailnetTestRuntime(t, node)

	first := make(chan error, 1)
	go func() {
		first <- instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
			Config:    coretypes.TailnetConfigPayload{ID: "corp"},
			TimeoutMs: 60_000,
		})
	}()

	deadline := time.After(2 * time.Second)
	for {
		instance.tailnetTests.mu.Lock()
		registered := len(instance.tailnetTests.byID)
		instance.tailnetTests.mu.Unlock()
		if registered == 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("the first test never registered")
		case <-time.After(5 * time.Millisecond):
		}
	}

	node.setStatus(tailnet.Status{State: tailnet.StateRunning, Online: true})
	if err := instance.TailnetTest("req-2", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 60_000,
	}); err != nil {
		t.Fatalf("second TailnetTest() error = %v", err)
	}

	select {
	case err := <-first:
		if err != nil {
			t.Errorf("first TailnetTest() error = %v, want nil after being superseded", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the first test kept polling after a second one started")
	}
}

// 취소는 실패가 아니라서 오류로 끝나지 않는다. 그래서 마지막 상태 이벤트가 "접혔다"고 말해
// 줘야 기다리는 쪽이 시도가 끝났음을 안다 — 노드가 올라오기 전에도 Stopped 가 진행 상태로
// 나가므로, 그 표시가 중복 제거에 걸려 묻히면 화면에서 취소를 눌러도 아무 일이 없다.
func TestTailnetCancelEmitsATerminalStatus(t *testing.T) {
	// Stopped 로 폴링을 시작하는 노드. 진행 이벤트로 Stopped 가 먼저 나간다.
	node := &countingNode{status: tailnet.Status{State: tailnet.StateStopped}}
	instance := newTailnetTestRuntime(t, node)

	var mu sync.Mutex
	var events []coretypes.TailnetStatusPayload
	instance.emitEvent = func(event coretypes.Event) {
		status, ok := event.Payload.(coretypes.TailnetStatusPayload)
		if !ok {
			return
		}
		mu.Lock()
		events = append(events, status)
		mu.Unlock()
	}

	done := make(chan error, 1)
	go func() {
		done <- instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
			Config:    coretypes.TailnetConfigPayload{ID: "corp"},
			TimeoutMs: 60_000,
		})
	}()

	deadline := time.After(2 * time.Second)
	for {
		if instance.tailnetTests.cancel("corp") {
			break
		}
		select {
		case <-deadline:
			t.Fatal("the test never registered itself as cancellable")
		case <-time.After(5 * time.Millisecond):
		}
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("TailnetTest() error = %v, want nil after a cancel", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("TailnetTest did not return after being cancelled")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(events) == 0 {
		t.Fatal("no status events were emitted")
	}
	last := events[len(events)-1]
	if !last.Cancelled {
		t.Errorf("last status = %#v, want Cancelled so the caller knows the attempt ended", last)
	}
}

// 만료를 상태로는 알 수 없다 — tsnet 은 메모리에 남은 낡은 netmap 으로 계속 running 을 보고한다.
// 그래서 확인 요청은 노드를 닫고 다시 만들어야 한다(netmap 없이 시작해야 컨트롤 플레인의 답을
// 받는다). 이걸 빠뜨리면 확인이 "이미 running 이네" 로 끝나서 아무것도 알아내지 못한다.
func TestTailnetTestForceReloginDropsTheStaleNode(t *testing.T) {
	closed := 0
	node := &countingNode{
		status:  tailnet.Status{State: tailnet.StateRunning, Online: true},
		onClose: func() { closed++ },
	}
	runtime := newTailnetTestRuntime(t, node)

	// 먼저 한 번 올려서 노드가 살아 있게 만든다(확인할 대상이 있어야 한다).
	if err := runtime.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config: coretypes.TailnetConfigPayload{ID: "corp"},
	}); err != nil {
		t.Fatalf("TailnetTest: %v", err)
	}
	if closed != 0 {
		t.Fatalf("plain test must not drop the node: closed = %d", closed)
	}

	if err := runtime.TailnetTest("req-2", coretypes.TailnetTestPayload{
		Config:       coretypes.TailnetConfigPayload{ID: "corp"},
		ForceRelogin: true,
	}); err != nil {
		t.Fatalf("TailnetTest(forceRelogin): %v", err)
	}

	if closed != 1 {
		t.Errorf("closed = %d, want 1 — the stale node must be dropped", closed)
	}
}

// 평소의 연결 테스트는 노드를 버리지 않는다. 매번 버리면 이미 붙어 있는 노드를 닫아 재등록
// 왕복을 물리고, 그 위에 얹힌 세션도 위험해진다.
func TestTailnetTestKeepsTheNodeByDefault(t *testing.T) {
	closed := 0
	node := &countingNode{
		status:  tailnet.Status{State: tailnet.StateRunning, Online: true},
		onClose: func() { closed++ },
	}
	runtime := newTailnetTestRuntime(t, node)

	for _, requestID := range []string{"req-1", "req-2"} {
		if err := runtime.TailnetTest(requestID, coretypes.TailnetTestPayload{
			Config: coretypes.TailnetConfigPayload{ID: "corp"},
		}); err != nil {
			t.Fatalf("TailnetTest: %v", err)
		}
	}

	if closed != 0 {
		t.Errorf("closed = %d, want 0", closed)
	}
}

// 다른 세션이 그 tailnet 을 쓰고 있으면 노드를 버릴 수 없다. 그런데 그건 등록이 살아 있다는
// 증거이므로 확인할 것이 없다 — 실패로 만들면 멀쩡한 연결이 오류로 끝난다.
func TestTailnetTestForceReloginProceedsWhenTheNodeIsInUse(t *testing.T) {
	node := &countingNode{status: tailnet.Status{State: tailnet.StateRunning, Online: true}}
	runtime := newTailnetTestRuntime(t, node)

	// 다른 소비자가 붙들고 있는 상태를 만든다.
	lease, err := runtime.tailnets.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer lease.Release()

	if err := runtime.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:       coretypes.TailnetConfigPayload{ID: "corp"},
		ForceRelogin: true,
	}); err != nil {
		t.Errorf("in-use node must not fail the check: %v", err)
	}
}

// 기다리던 요청만 접으면 노드는 인증 대기로 남는다. 그러면 취소한 화면은 끝난 것으로 보이는데
// 설정 화면은 "브라우저에서 인증을 마쳐 주세요" 를 계속 보여준다 — 같은 노드를 두고 두 화면이
// 다른 말을 한다.
func TestTailnetCancelStopsANodeThatNeverCameUp(t *testing.T) {
	node := &countingNode{status: tailnet.Status{State: tailnet.StateNeedsAuth, AuthURL: "https://login"}}
	runtime := newTailnetTestRuntime(t, node)

	// 노드를 만들어 둔다(취소는 이미 올라오려던 노드를 대상으로 한다).
	lease, err := runtime.tailnets.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	lease.Release()

	if err := runtime.TailnetCancel("req-1", coretypes.TailnetDisconnectPayload{ID: "corp"}); err != nil {
		t.Fatalf("TailnetCancel: %v", err)
	}

	if node.closes != 1 {
		t.Errorf("closes = %d, want 1 — 인증 대기 노드는 함께 닫혀야 한다", node.closes)
	}
}

// 이미 붙어 있는 노드는 건드리지 않는다. 취소가 멀쩡한 연결을 끊으면 그 위의 세션이 죽는다.
func TestTailnetCancelLeavesARunningNodeAlone(t *testing.T) {
	node := &countingNode{status: tailnet.Status{State: tailnet.StateRunning, Online: true}}
	runtime := newTailnetTestRuntime(t, node)

	lease, err := runtime.tailnets.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	lease.Release()

	if err := runtime.TailnetCancel("req-1", coretypes.TailnetDisconnectPayload{ID: "corp"}); err != nil {
		t.Fatalf("TailnetCancel: %v", err)
	}

	if node.closes != 0 {
		t.Errorf("closes = %d, want 0", node.closes)
	}
}

// 취소는 진행 중인 시도를 접는 것으로 끝나면 안 된다. 노드가 인증 대기로 남으면 설정 화면은
// "브라우저에서 인증을 마쳐 주세요" 를 계속 보여준다 — 취소한 사용자가 보기엔 취소가 안 먹은 것이다.
//
// 취소 명령이 직접 내리려 하면 그 시도가 아직 리스를 들고 있어서 거절당한다. 그래서 시도 자신이
// 끝나면서 내려야 한다.
func TestTailnetTestStopsTheNodeWhenCancelled(t *testing.T) {
	node := &countingNode{status: tailnet.Status{State: tailnet.StateNeedsAuth, AuthURL: "https://login"}}
	runtime := newTailnetTestRuntime(t, node)

	done := make(chan error, 1)
	go func() {
		done <- runtime.TailnetTest("req-1", coretypes.TailnetTestPayload{
			Config: coretypes.TailnetConfigPayload{ID: "corp"},
		})
	}()

	// 시도가 등록되기를 기다린다.
	deadline := time.Now().Add(2 * time.Second)
	for {
		if runtime.tailnetTests.cancel("corp") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("attempt never registered")
		}
		time.Sleep(5 * time.Millisecond)
	}

	if err := <-done; err != nil {
		t.Fatalf("cancelled test must not fail: %v", err)
	}
	if node.closes != 1 {
		t.Errorf("closes = %d, want 1 — 취소하면 인증 대기 노드도 닫혀야 한다", node.closes)
	}
}

// 만료된 노드는 running 으로 보고된다. 그것을 준비된 것으로 보면 연결 흐름이 tailnet 을 기다리지
// 않고 호스트 키·SSH 로 넘어가고, 그 dial 이 곧 실패해서 사용자가 브라우저에서 로그인하는 중에
// 화면이 실패로 뒤집힌다.
func TestTailnetTestDoesNotAcceptAnExpiredRunningNode(t *testing.T) {
	node := &countingNode{
		status: tailnet.Status{State: tailnet.StateRunning, Online: true, Expired: true},
	}
	runtime := newTailnetTestRuntime(t, node)

	// 만료가 풀리면(로그인 완료) 통과해야 한다. 그 전까지는 기다린다.
	go func() {
		time.Sleep(80 * time.Millisecond)
		node.setStatus(tailnet.Status{State: tailnet.StateRunning, Online: true})
	}()

	started := time.Now()
	if err := runtime.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 3000,
	}); err != nil {
		t.Fatalf("TailnetTest: %v", err)
	}

	if time.Since(started) < 60*time.Millisecond {
		t.Error("만료로 보고된 running 을 준비된 것으로 통과시켰다")
	}
}

// 준비 여부는 State 와 따로 바뀐다 — running 으로 보고되는 동안 컨트롤 플레인과 동기화되면서
// 준비됨으로 넘어간다. 그 전이가 곧 시도의 끝인데, 중복 제거가 그것을 앞의 running 과 같다고
// 버리면 기다리는 쪽이 영원히 끝을 못 본다(화면은 단계가 전부 완료인데 연결이 멈춘다).
func TestTailnetProgressKeepsTheReadyTransition(t *testing.T) {
	notReady := coretypes.TailnetStatusPayload{ID: "corp", State: "running"}
	ready := coretypes.TailnetStatusPayload{ID: "corp", State: "running", Ready: true, Online: true}

	if sameTailnetProgress(notReady, ready) {
		t.Error("준비됨으로 바뀐 것을 같은 상태로 보면 종료 신호가 사라진다")
	}
	if !sameTailnetProgress(ready, ready) {
		t.Error("같은 상태는 같다고 봐야 한다 — 안 그러면 폴링마다 이벤트가 쌓여 화면이 깜빡인다")
	}
}

// 컨트롤 플레인에서 노드를 지우면 디스크의 노드 키가 그쪽에 없다. 이미 떠 있던 노드는 그 죽은
// 키로 재등록을 반복하며 백오프에 들어가고, 그 사이 로그인 링크가 나오지 않는다 — 사용자는
// "링크를 받는 중" 에서 한도까지 갇힌다. 노드를 새로 만들면 등록을 처음부터 밟아 링크가 나온다.
func TestTailnetTestRestartsWhenTheAuthLinkNeverArrives(t *testing.T) {
	// 유예를 실제로 기다리면 테스트가 10 초를 쓴다. 규칙은 시간 길이가 아니라 "링크가 안 오면
	// 새로 만든다" 다.
	original := tailnetAuthURLGrace
	tailnetAuthURLGrace = 10 * time.Millisecond
	t.Cleanup(func() { tailnetAuthURLGrace = original })

	stuck := &countingNode{status: tailnet.Status{State: tailnet.StateNeedsAuth}}
	fresh := &countingNode{
		status: tailnet.Status{State: tailnet.StateRunning, Online: true},
	}

	built := 0
	instance := &Runtime{emitEvent: func(coretypes.Event) {}}
	instance.tailnetConfigs = newTailnetConfigs(t.TempDir())
	instance.tailnetTests = newTailnetTests()
	instance.tailnets = tailnet.NewRegistry(func(string) (tailnet.Node, error) {
		built += 1
		if built == 1 {
			return stuck, nil
		}
		return fresh, nil
	}, tailnet.Options{})
	t.Cleanup(func() { _ = instance.tailnets.Close() })

	// 유예를 넘겨도 한도 안에서 끝나야 한다.
	if err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 30_000,
	}); err != nil {
		t.Fatalf("TailnetTest: %v", err)
	}

	if built != 2 {
		t.Errorf("built = %d, want 2 — 갇힌 노드를 새로 만들어야 한다", built)
	}
	if stuck.closes != 1 {
		t.Errorf("갇힌 노드를 닫지 않았다 (closes=%d)", stuck.closes)
	}
}

// 링크가 온 뒤 사람이 로그인하는 동안은 유예를 한참 넘긴다. 그때 노드를 다시 만들면 브라우저가
// 두 번 뜨고 방금 받은 링크가 죽는다.
func TestTailnetTestKeepsTheNodeWhileTheLinkIsPending(t *testing.T) {
	original := tailnetAuthURLGrace
	tailnetAuthURLGrace = 10 * time.Millisecond
	t.Cleanup(func() { tailnetAuthURLGrace = original })

	// 링크는 있는데 사람이 로그인을 안 한 상태로 한도까지 간다.
	//
	// 한도는 폴링 두 번(링크가 있으면 1 초 간격)이 들어가게 잡는다 — 한 번만 돌면 유예를 넘긴
	// 판단이 아예 일어나지 않아서, 규칙이 깨져도 이 테스트가 알아채지 못한다.
	node := &countingNode{
		status: tailnet.Status{State: tailnet.StateNeedsAuth, AuthURL: "https://login"},
	}
	instance := newTailnetTestRuntime(t, node)

	if err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 1_500,
	}); err == nil {
		t.Fatal("로그인을 안 했으면 한도에서 끝나야 한다")
	}

	if node.closes != 0 {
		t.Errorf("링크가 있는데 노드를 다시 만들었다 (closes=%d)", node.closes)
	}
}

// 링크는 곧 올 수 있다. 유예도 주지 않고 다시 만들면 오는 중인 링크를 죽이고 등록을 처음부터
// 다시 밟는다 — 정상 연결이 느려지고 브라우저가 늦게 뜬다.
func TestTailnetTestWaitsOutTheGraceBeforeRestarting(t *testing.T) {
	original := tailnetAuthURLGrace
	tailnetAuthURLGrace = 5 * time.Second
	t.Cleanup(func() { tailnetAuthURLGrace = original })

	node := &countingNode{status: tailnet.Status{State: tailnet.StateNeedsAuth}}
	instance := newTailnetTestRuntime(t, node)

	// 유예 안에 링크가 도착한다. 그 사이 폴링이 여러 번 돈다(링크가 없으면 250ms 간격).
	go func() {
		time.Sleep(600 * time.Millisecond)
		node.setStatus(tailnet.Status{State: tailnet.StateNeedsAuth, AuthURL: "https://login"})
	}()

	if err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 1_200,
	}); err == nil {
		t.Fatal("로그인을 안 했으면 한도에서 끝나야 한다")
	}

	if node.closes != 0 {
		t.Errorf("유예를 기다리지 않고 노드를 다시 만들었다 (closes=%d)", node.closes)
	}
}

// 다시 만든 노드도 링크를 못 받을 수 있다. 그때 계속 다시 만들면 등록 요청이 폭주하고 컨트롤
// 플레인에 노드가 쌓인다. 한 번만 시도하고, 나머지는 한도까지 기다린 뒤 정직하게 끝낸다.
func TestTailnetTestRestartsOnlyOnce(t *testing.T) {
	original := tailnetAuthURLGrace
	tailnetAuthURLGrace = 10 * time.Millisecond
	t.Cleanup(func() { tailnetAuthURLGrace = original })

	built := 0
	instance := &Runtime{emitEvent: func(coretypes.Event) {}}
	instance.tailnetConfigs = newTailnetConfigs(t.TempDir())
	instance.tailnetTests = newTailnetTests()
	instance.tailnets = tailnet.NewRegistry(func(string) (tailnet.Node, error) {
		built += 1
		// 어느 노드도 링크를 받지 못한다.
		return &countingNode{status: tailnet.Status{State: tailnet.StateNeedsAuth}}, nil
	}, tailnet.Options{})
	t.Cleanup(func() { _ = instance.tailnets.Close() })

	err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 300,
	})
	if err == nil {
		t.Fatal("링크를 못 받았으면 한도에서 실패로 끝나야 한다")
	}

	if built != 2 {
		t.Errorf("built = %d, want 2 — 다시 만드는 것은 한 번뿐이다", built)
	}
}
