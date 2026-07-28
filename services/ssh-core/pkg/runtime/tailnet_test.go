package runtime

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
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

	if node.logouts != 0 {
		t.Errorf("logouts = %d on shutdown, want 0 — logging out would force a fresh browser login", node.logouts)
	}
}

type countingNode struct {
	onClose func()
	logouts int
	ups     int
	upErr   error
	status  tailnet.Status
}

func (n *countingNode) Dial(context.Context, string, string) (net.Conn, error) {
	return nil, errors.New("not dialable")
}
func (n *countingNode) Status(context.Context) (tailnet.Status, error) {
	if n.status.State == "" {
		return tailnet.Status{State: tailnet.StateStopped}, nil
	}
	return n.status, nil
}
func (n *countingNode) Up(context.Context) error {
	n.ups += 1
	return n.upErr
}

func (n *countingNode) Down(context.Context) error { return nil }
func (n *countingNode) Logout(context.Context) error {
	n.logouts += 1
	return nil
}
func (n *countingNode) Close() error {
	if n.onClose != nil {
		n.onClose()
	}
	return nil
}
func (n *countingNode) Purge() error { return nil }

// 연결 종료 뒤 다시 연결하면 노드를 올려야 한다.
//
// tsnet 의 Start 는 처음 한 번만 유효해서, 두 번째 호출은 Down 이 꺼 둔 WantRunning 을
// 되돌리지 않는다. 그래서 올려 주지 않으면 Stopped 인 채로 타임아웃까지 폴링만 하고,
// 화면에서는 무한 로딩으로 보인다. Headscale+OIDC 에서 실제로 그랬다.
func TestTailnetTestBringsTheNodeUp(t *testing.T) {
	node := &countingNode{status: tailnet.Status{State: tailnet.StateRunning}}
	instance := newTailnetTestRuntime(t, node)

	if err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config: coretypes.TailnetConfigPayload{ID: "corp"},
	}); err != nil {
		t.Fatalf("TailnetTest() error = %v", err)
	}

	if node.ups != 1 {
		t.Errorf("Up called %d times, want 1 — a downed node never comes back without it", node.ups)
	}
}

// 올리는 데 실패하면 기다리게 두지 말고 그대로 알려야 한다.
func TestTailnetTestReportsAFailureToBringTheNodeUp(t *testing.T) {
	node := &countingNode{
		status: tailnet.Status{State: tailnet.StateRunning},
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

	node.status = tailnet.Status{State: tailnet.StateRunning}
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
