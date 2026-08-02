package tailnetservice

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

func TestIdentityReplacementBudgetResetsOnlyAfterAuthorizationOrConfigChange(t *testing.T) {
	instance := &Service{tailnetConfigs: newTailnetConfigs(t.TempDir())}
	instance.tailnetConfigs.set(coretypes.TailnetConfigPayload{ID: "corp", AuthKey: "old"})
	firstGeneration, _ := instance.tailnetConfigs.generation("corp")

	if !instance.claimTailnetIdentityReplacement("corp", firstGeneration) {
		t.Fatal("first replacement claim was rejected")
	}
	if instance.claimTailnetIdentityReplacement("corp", firstGeneration) {
		t.Fatal("same configuration generation received a second replacement budget")
	}
	instance.markTailnetIdentityAuthorized("corp", tailnet.Status{State: tailnet.StateRunning})
	if !instance.claimTailnetIdentityReplacement("corp", firstGeneration) {
		t.Fatal("authorized replacement did not restore the retry budget")
	}

	instance.tailnetConfigs.set(coretypes.TailnetConfigPayload{ID: "corp", AuthKey: "new"})
	secondGeneration, _ := instance.tailnetConfigs.generation("corp")
	if secondGeneration == firstGeneration {
		t.Fatal("configuration change did not advance the generation")
	}
	if !instance.claimTailnetIdentityReplacement("corp", secondGeneration) {
		t.Fatal("new configuration generation inherited the old replacement budget")
	}
}

func TestTailnetConfigurePurgesRemovedColdIdentityWithoutStartingANode(t *testing.T) {
	root := t.TempDir()
	instance := New(Options{StateDir: root})
	t.Cleanup(func() { _ = instance.Close() })
	if err := instance.TailnetConfigure(coretypes.TailnetConfigurePayload{
		Configs: []coretypes.TailnetConfigPayload{{ID: "corp"}},
	}); err != nil {
		t.Fatal(err)
	}

	identityDir := filepath.Join(root, "corp")
	if err := os.MkdirAll(identityDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(identityDir, "tailscaled.state"), []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := instance.TailnetConfigure(coretypes.TailnetConfigurePayload{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(identityDir); !os.IsNotExist(err) {
		t.Fatalf("removed cold identity remains on disk: %v", err)
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
	instance := &Service{}

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
	instance := &Service{}
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
	instance := &Service{}
	instance.shutdownTailnets()
}

// 종료는 로그아웃하지 않는다. 로그아웃하면 등록이 사라져서 다음 실행 때 브라우저 로그인을
// 처음부터 다시 해야 한다.
func TestShutdownDoesNotLogOut(t *testing.T) {
	node := &countingNode{}
	instance := &Service{}
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
	purges  int
	downs   int
	mu      sync.Mutex
	onClose func()
	logouts int
	ups     int
	upErr   error
	reauths int
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

func (n *countingNode) Reauth(context.Context) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.reauths += 1
	return nil
}

func (n *countingNode) Purge() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.purges += 1
	return nil
}

// 만료된 노드는 코어가 스스로 복구를 시작해야 한다.
//
// 복구할 주체가 없으면 붙은 뒤에 만료된 노드는 아무 일도 일어나지 않는다 — 관문 루프는 연결
// 시도 동안만 존재하므로, 화면은 "인증 링크를 받는 중" 을 보여주는데 실제로 진행되는 것은 없고
// 사용자가 직접 "다시 시도" 를 눌러야만 풀린다. 실제로 그렇게 깨졌다.
func TestTailnetSupervisorRecoversAnExpiredNode(t *testing.T) {
	node := &countingNode{status: tailnet.Status{
		State:   tailnet.StateRunning,
		Online:  true,
		Expired: true,
	}}
	instance := newTailnetTestRuntime(t, node)
	instance.tailnetConfigs.set(coretypes.TailnetConfigPayload{ID: "corp"})

	// 감독자가 보려면 노드가 살아 있어야 한다(Snapshot 은 없는 tailnet 을 깨우지 않는다).
	lease, err := instance.tailnets.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	defer lease.Release()

	// 백엔드가 변화를 푸시한 것과 같은 경로로 들어간다(폴링이 아니다).
	instance.onTailnetNotify("corp")

	// 알림 묶음을 모으는 시간 뒤에 복구가 시작된다.
	deadline := time.Now().Add(3 * time.Second)
	started := false
	for time.Now().Before(deadline) {
		if instance.tailnetTests.active("corp") {
			started = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !started {
		t.Fatal("만료된 노드에 대해 복구 시도가 시작되지 않았다")
	}

	// 백그라운드 시도를 다음 테스트까지 남기지 않는다. 전역 테스트 유예값을 다음 테스트가
	// 바꾸는 동안 이 goroutine 이 읽으면 race 가 되고, 실제 프로세스 종료도 늦어진다.
	node.setStatus(tailnet.Status{State: tailnet.StateRunning, Online: true})
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && instance.tailnetTests.active("corp") {
		time.Sleep(20 * time.Millisecond)
	}
	if instance.tailnetTests.active("corp") {
		t.Fatal("복구가 끝났는데 시도가 남아 있다")
	}
}

// 만료가 아닌 상태는 감독자가 건드리지 않는다.
//
// 올라오는 중이거나 인증을 기다리는 것은 "붙지 못한" 상태이고, 처리는 진행 중인 시도 안에서 한다. 감독자가 여기까지 손을 뻗으면
// 아무도 요청하지 않은 시도가 계속 태워지고, 그 시도가 유휴 타이머를 되돌려 노드가 회수되지 않는다.
func TestTailnetSupervisorOnlyRecoversExpiredNodes(t *testing.T) {
	for _, status := range []tailnet.Status{
		{State: tailnet.StateNeedsAuth},
		{State: tailnet.StateStarting},
		{State: tailnet.StateNeedsApproval},
		// 단순 offline(running 이지만 컨트롤 플레인과 끊김)은 감독자가 건드리지 않는다.
		// 삭제는 이 상태와 별개인 IdentityInvalid 로 구분된다.
		{State: tailnet.StateRunning, Online: false},
	} {
		node := &countingNode{status: status}
		instance := newTailnetTestRuntime(t, node)
		instance.tailnetConfigs.set(coretypes.TailnetConfigPayload{ID: "corp"})

		lease, err := instance.tailnets.Acquire("corp")
		if err != nil {
			t.Fatalf("Acquire() error = %v", err)
		}

		instance.onTailnetNotify("corp")
		time.Sleep(tailnetRecoveryDebounce + 300*time.Millisecond)

		if instance.tailnetTests.active("corp") {
			t.Errorf("state %q: 감독자가 시도를 태웠다", status.State)
		}
		lease.Release()
	}
}

// 노드는 tailnet 하나에 하나뿐이다. 터미널·SFTP·포트포워딩·컨테이너가 각자 시도를 만들면
// 서로를 취소하고, 그 과정에서 노드가 닫히거나 재생성돼 사용자가 브라우저에서 쓰던 인증 링크가
// 죽는다. 뒤에 온 요청은 합류해서 같은 결과를 받아야 한다.
func TestTailnetTestJoinsAnInFlightAttempt(t *testing.T) {
	tests := newTailnetTests()

	first, joined := tests.begin("corp", func() {})
	if joined {
		t.Fatal("첫 시도가 합류로 처리됐다")
	}

	cancelled := false
	second, joined := tests.begin("corp", func() { cancelled = true })
	if !joined {
		t.Fatal("진행 중인 시도가 있는데 새 시도를 만들었다 — 서로를 취소한다")
	}
	if second != first {
		t.Fatal("합류인데 다른 시도를 돌려줬다")
	}
	if cancelled {
		t.Fatal("합류가 앞의 시도를 취소했다 — 인증 링크가 죽는다")
	}

	// 선행 시도가 끝나면 합류한 쪽이 풀려야 한다.
	go tests.end("corp", first)
	select {
	case <-first.done:
	case <-time.After(2 * time.Second):
		t.Fatal("선행 시도가 끝났는데 합류한 요청이 풀리지 않았다")
	}
}

// 앞의 시도를 접고 새로 시작하는 통로는 두지 않는다.
//
// 처음부터 다시 하려면 취소를 거쳐야 한다 — 취소가 시도와 노드를 함께 없애므로 다음 요청이
// 자연히 새 노드로 시작한다. 그 통로를 요청 필드로 열어 두면 "강도" 를 요청하는 쪽이 정하게
// 되고, 진행 중인 인증 링크를 남이 죽일 수 있다.
func TestTailnetAttemptsCannotBePreempted(t *testing.T) {
	tests := newTailnetTests()

	cancelled := false
	first, _ := tests.begin("corp", func() { cancelled = true })

	second, joined := tests.begin("corp", func() {})
	if !joined {
		t.Fatal("진행 중인 시도를 밀어내고 새 시도를 만들었다")
	}
	if second != first {
		t.Fatal("합류인데 다른 시도를 돌려줬다")
	}
	if cancelled {
		t.Fatal("뒤에 온 요청이 앞의 시도를 접었다 — 인증 링크가 죽는다")
	}

	// 취소가 그 통로다. 접고 나면 다음 요청이 새 시도를 만든다.
	if !tests.cancel("corp") {
		t.Fatal("진행 중인 시도를 취소하지 못했다")
	}
	if !cancelled {
		t.Fatal("취소가 시도를 접지 않았다")
	}
	third, joined := tests.begin("corp", func() {})
	if joined || third == first {
		t.Fatal("취소 뒤에도 옛 시도에 합류했다")
	}
}

// 취소는 서버를 닫고 없앤다. 쓰는 곳이 있어도 없앤다.
//
// 시도만 접으면 취소가 아니다 — 노드가 살아 상태와 인증 링크를 계속 보고하므로 화면은 접은 것을
// 접지 못한 상태로 그린다(사용자에게는 "가리기" 로 보인다). 없애면 상태 자체가 사라진다.
func TestTailnetCancelDiscardsTheNode(t *testing.T) {
	node := &countingNode{status: tailnet.Status{
		State:   tailnet.StateRunning,
		Online:  true,
		Expired: true,
	}}
	instance := newTailnetTestRuntime(t, node)
	instance.tailnetConfigs.set(coretypes.TailnetConfigPayload{ID: "corp"})

	// 소비자가 붙어 있는 상태(터미널이 쓰는 중)에서 취소한다.
	lease, err := instance.tailnets.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	defer lease.Release()

	if err := instance.TailnetCancel("req-1", coretypes.TailnetDisconnectPayload{ID: "corp"}); err != nil {
		t.Fatalf("TailnetCancel() error = %v", err)
	}

	node.mu.Lock()
	closes := node.closes
	node.mu.Unlock()
	if closes != 1 {
		t.Fatalf("closes = %d, want 1 — 취소가 tsnet 서버를 닫지 않았다", closes)
	}
	// 항목이 사라져야 첫 실행과 같은 상태가 된다(그릴 상태도, 인증 링크도 없다).
	if _, ok := instance.tailnets.StatusOf(context.Background(), "corp"); ok {
		t.Fatal("취소 뒤에도 노드가 레지스트리에 남아 있다")
	}
}

// 취소 뒤 다시 쓰려는 소비자가 요청하면 새 서버로 처음부터 시작한다. 취소가 영구 차단이면
// 그 뒤로는 아무도 그 tailnet 을 쓸 수 없다.
func TestTailnetCancelAllowsAFreshStart(t *testing.T) {
	built := 0
	instance := &Service{emitEvent: func(coretypes.Event) {}}
	instance.tailnetConfigs = newTailnetConfigs(t.TempDir())
	instance.tailnetTests = newTailnetTests()
	instance.tailnets = tailnet.NewRegistry(func(string) (tailnet.Node, error) {
		built += 1
		// 인증이 남은 노드다 — 취소가 없애는 대상이다(정상 동작 중인 노드는 건드리지 않는다).
		return &countingNode{status: tailnet.Status{State: tailnet.StateNeedsAuth}}, nil
	}, tailnet.Options{})
	t.Cleanup(func() { _ = instance.tailnets.Close() })

	first, err := instance.tailnets.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}

	if err := instance.TailnetCancel("req-1", coretypes.TailnetDisconnectPayload{ID: "corp"}); err != nil {
		t.Fatalf("TailnetCancel() error = %v", err)
	}
	// 옛 리스를 놓는 것이 새 노드를 건드리면 안 된다(세대가 다르므로 무시돼야 한다).
	first.Release()

	second, err := instance.tailnets.Acquire("corp")
	if err != nil {
		t.Fatalf("취소 뒤 다시 잡을 수 없다: %v", err)
	}
	defer second.Release()

	if built != 2 {
		t.Fatalf("built = %d, want 2 — 취소 뒤에는 새 서버로 시작해야 한다", built)
	}
	if instance.tailnets.Leases("corp") != 1 {
		t.Fatalf("leases = %d, want 1 — 옛 리스의 Release 가 새 노드를 깎았다", instance.tailnets.Leases("corp"))
	}
}

// 아무도 쓰지 않는 tailnet 은 만료돼도 복구하지 않는다.
//
// 복구하면 리스를 잡아 유휴 타이머를 계속 되돌려서, 만료된 노드가 30분 유휴 회수에 도달하지
// 못한다. 게다가 한도마다 인증 링크를 새로 발급해 사용자가 쓰지도 않는 링크가 계속 열린다.
func TestTailnetSupervisorSkipsUnusedTailnets(t *testing.T) {
	node := &countingNode{status: tailnet.Status{
		State:   tailnet.StateRunning,
		Online:  true,
		Expired: true,
	}}
	instance := newTailnetTestRuntime(t, node)
	instance.tailnetConfigs.set(coretypes.TailnetConfigPayload{ID: "corp"})

	// 노드는 있지만 소비자는 없다(리스를 잡았다 놓은 상태).
	lease, err := instance.tailnets.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	lease.Release()

	instance.onTailnetNotify("corp")
	time.Sleep(tailnetRecoveryDebounce + 300*time.Millisecond)

	if instance.tailnetTests.active("corp") {
		t.Fatal("아무도 쓰지 않는데 복구를 시작했다 — 유휴 회수가 막히고 링크만 쌓인다")
	}
}

// 진행 중인 시도에 끼어들면 안 된다. 끼어들면 그 시도가 취소되고, 사용자가 브라우저에서 쓰던
// 인증 링크가 무효화된다.
func TestTailnetSupervisorLeavesAnInFlightAttemptAlone(t *testing.T) {
	node := &countingNode{status: tailnet.Status{
		State:   tailnet.StateRunning,
		Online:  true,
		Expired: true,
	}}
	instance := newTailnetTestRuntime(t, node)
	instance.tailnetConfigs.set(coretypes.TailnetConfigPayload{ID: "corp"})

	lease, err := instance.tailnets.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	defer lease.Release()

	// 사용자가 시작한 시도가 이미 진행 중인 상황.
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	attempt, _ := instance.tailnetTests.begin("corp", cancel)
	defer instance.tailnetTests.end("corp", attempt)

	instance.onTailnetNotify("corp")
	time.Sleep(tailnetRecoveryDebounce + 300*time.Millisecond)

	// 그 시도가 그대로 남아 있어야 한다(감독자가 새 시도로 갈아치우지 않았다).
	instance.tailnetTests.mu.Lock()
	current := instance.tailnetTests.byID["corp"]
	instance.tailnetTests.mu.Unlock()
	if current != attempt {
		t.Fatal("감독자가 진행 중인 시도를 갈아치웠다 — 사용자의 인증 링크가 무효화된다")
	}
}

// blockingNode 는 상태 조회가 걸려 버린 백엔드를 재현한다.
//
// 실제로 그런 구간이 있다. 키가 만료되면 tailscale 백엔드는 popBrowserAuthNow 에서
// stopEngineAndWaitLocked 로 데이터 플레인을 내리는데, 그 동안 백엔드 뮤텍스를 잡고 있어서
// localapi 의 status 요청이 그 뮤텍스를 기다린다 — 그리고 **뮤텍스 대기는 ctx 를 보지 않는다.**
type blockingNode struct {
	release chan struct{}
	mu      sync.Mutex
	statusN int
}

func (n *blockingNode) Dial(context.Context, string, string) (net.Conn, error) {
	return nil, errors.New("not dialable")
}

func (n *blockingNode) Status(ctx context.Context) (tailnet.Status, error) {
	n.mu.Lock()
	n.statusN += 1
	first := n.statusN == 1
	n.mu.Unlock()
	if first {
		// 첫 조회는 인증이 필요한 상태를 알려 준다(화면이 "링크를 받는 중"으로 들어간다).
		return tailnet.Status{State: tailnet.StateNeedsAuth}, nil
	}
	// 그 다음부터는 갇힌다. ctx 취소로도 풀리지 않는 상황을 흉내낸다. 상한을 두는 이유는
	// 테스트 하네스까지 얼어붙지 않게 하기 위해서다(실제 백엔드도 언젠가는 풀린다).
	select {
	case <-n.release:
	case <-time.After(5 * time.Second):
	}
	return tailnet.Status{State: tailnet.StateNeedsAuth}, nil
}

func (n *blockingNode) Up(context.Context) error     { return nil }
func (n *blockingNode) Reauth(context.Context) error { return nil }
func (n *blockingNode) Logout(context.Context) error { return nil }
func (n *blockingNode) Close() error                 { return nil }
func (n *blockingNode) Purge() error                 { return nil }

// 취소는 백엔드가 어떤 상태든 즉시 들어야 한다.
//
// 상태 조회가 걸려 있으면 루프가 취소를 볼 기회 자체를 얻지 못한다 — 사용자가 취소를 눌러도
// 아무 일이 없고, 요청은 한도(3분)까지 매달린다. 실제로 그렇게 깨졌다.
func TestTailnetCancelWorksWhileTheBackendIsWedged(t *testing.T) {
	node := &blockingNode{release: make(chan struct{})}
	t.Cleanup(func() { close(node.release) })

	events := make(chan coretypes.TailnetStatusPayload, 32)
	instance := newTailnetTestRuntime(t, node)
	instance.emitEvent = func(event coretypes.Event) {
		if payload, ok := event.Payload.(coretypes.TailnetStatusPayload); ok {
			select {
			case events <- payload:
			default:
			}
		}
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
			Config:    coretypes.TailnetConfigPayload{ID: "corp"},
			TimeoutMs: 60_000,
		})
	}()

	// 상태 조회가 갇힐 때까지 기다린다.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		node.mu.Lock()
		wedged := node.statusN >= 2
		node.mu.Unlock()
		if wedged {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if err := instance.TailnetCancel("req-2", coretypes.TailnetDisconnectPayload{ID: "corp"}); err != nil {
		t.Fatalf("TailnetCancel() error = %v", err)
	}

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("취소 후에도 시도가 끝나지 않았다 — 사용자에게는 취소가 안 먹는 것으로 보인다")
	}

	var cancelled bool
	for {
		select {
		case payload := <-events:
			if payload.Cancelled {
				cancelled = true
			}
			continue
		default:
		}
		break
	}
	if !cancelled {
		t.Fatal("취소를 알리는 마지막 상태가 나가지 않았다 — 기다리는 쪽이 끝을 못 본다")
	}
}

// 만료는 재인증이 필요하다는 확정 신호다. 유예를 기다리지 않고 곧바로 로그인을 개시해야
// 한다 — 개시하지 않으면 백엔드가 자기 백오프 일정으로 재로그인할 때까지 수 분간 링크가
// 나오지 않고, 화면은 "링크를 받는 중" 에 머문다.
func TestTailnetTestStartsReauthImmediatelyWhenExpired(t *testing.T) {
	node := &countingNode{status: tailnet.Status{
		State:   tailnet.StateRunning,
		Online:  true,
		Expired: true,
	}}
	instance := newTailnetTestRuntime(t, node)

	// 만료 상태이므로 관문은 통과하지 못하고 한도에서 끝난다. 짧게 준다.
	_ = instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 200,
	})

	node.mu.Lock()
	reauths := node.reauths
	node.mu.Unlock()
	if reauths == 0 {
		t.Fatal("reauths = 0 — 만료면 곧바로 로그인을 개시해야 한다")
	}
}

// online=false 만으로는 아무것도 하지 않는다. 네트워크 장애와 control poll 재접속 구간이 모두
// 같은 모양이고, 그때는 기존 identity 를 유지해야 한다. 삭제는 별도 IdentityInvalid 신호로 온다.
func TestTailnetTestLeavesAnOfflineRegistrationAlone(t *testing.T) {
	original := tailnetAuthURLGrace
	tailnetAuthURLGrace = 10 * time.Millisecond
	t.Cleanup(func() { tailnetAuthURLGrace = original })

	var mu sync.Mutex
	built := 0
	instance := &Service{emitEvent: func(coretypes.Event) {}}
	instance.tailnetConfigs = newTailnetConfigs(t.TempDir())
	instance.tailnetTests = newTailnetTests()
	var node *countingNode
	instance.tailnets = tailnet.NewRegistry(func(string) (tailnet.Node, error) {
		mu.Lock()
		built += 1
		mu.Unlock()
		created := &countingNode{status: tailnet.Status{
			State:  tailnet.StateRunning,
			Online: false,
		}}
		if node == nil {
			node = created
		}
		return created, nil
	}, tailnet.Options{})
	t.Cleanup(func() { _ = instance.tailnets.Close() })

	// 유예를 여러 번 넘길 만큼 돈다.
	_ = instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 1_200,
	})

	mu.Lock()
	defer mu.Unlock()
	node.mu.Lock()
	reauths := node.reauths
	closes := node.closes
	node.mu.Unlock()

	if reauths != 0 {
		t.Errorf("reauths = %d, want 0 — 삭제된 등록에 자동으로 다시 들어갔다", reauths)
	}
	if closes != 0 || built != 1 {
		t.Errorf("closes = %d, built = %d — 노드를 다시 세웠다", closes, built)
	}
}

func TestTailnetTestReRegistersAnIdentityDeletedByTheControlPlane(t *testing.T) {
	var mu sync.Mutex
	var nodes []*countingNode
	instance := &Service{emitEvent: func(coretypes.Event) {}}
	instance.tailnetConfigs = newTailnetConfigs(t.TempDir())
	instance.tailnetTests = newTailnetTests()
	instance.tailnets = tailnet.NewRegistry(func(string) (tailnet.Node, error) {
		mu.Lock()
		defer mu.Unlock()
		status := tailnet.Status{State: tailnet.StateRunning, Online: true}
		if len(nodes) == 0 {
			status.Online = false
			status.IdentityInvalid = true
		}
		node := &countingNode{status: status}
		nodes = append(nodes, node)
		return node, nil
	}, tailnet.Options{})
	t.Cleanup(func() { _ = instance.tailnets.Close() })

	var eventsMu sync.Mutex
	var events []coretypes.TailnetStatusPayload
	instance.emitEvent = func(event coretypes.Event) {
		if payload, ok := event.Payload.(coretypes.TailnetStatusPayload); ok {
			eventsMu.Lock()
			events = append(events, payload)
			eventsMu.Unlock()
		}
	}

	err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp", AuthKey: "reusable-key"},
		TimeoutMs: 2000,
	})
	if err != nil {
		t.Fatalf("TailnetTest() error = %v", err)
	}

	mu.Lock()
	if len(nodes) != 2 {
		mu.Unlock()
		t.Fatalf("nodes built = %d, want 2", len(nodes))
	}
	stale, replacement := nodes[0], nodes[1]
	mu.Unlock()

	stale.mu.Lock()
	staleCloses, stalePurges, staleLogouts := stale.closes, stale.purges, stale.logouts
	stale.mu.Unlock()
	if staleCloses != 1 || stalePurges != 1 || staleLogouts != 0 {
		t.Fatalf("stale node: closes=%d purges=%d logouts=%d, want 1/1/0",
			staleCloses, stalePurges, staleLogouts)
	}
	replacement.mu.Lock()
	replacementUps := replacement.ups
	replacement.mu.Unlock()
	if replacementUps == 0 {
		t.Fatal("replacement node was not brought up")
	}

	eventsMu.Lock()
	last := events[len(events)-1]
	eventsMu.Unlock()
	if !last.Ready || last.IdentityInvalid || last.ReRegistrations != 1 {
		t.Fatalf("final status = %#v", last)
	}
}

func TestTailnetSupervisorDiscardsADeletedIdentityWhileIdle(t *testing.T) {
	var nodes []*countingNode
	instance := &Service{emitEvent: func(coretypes.Event) {}}
	instance.tailnetConfigs = newTailnetConfigs(t.TempDir())
	instance.tailnetTests = newTailnetTests()
	instance.tailnets = tailnet.NewRegistry(func(string) (tailnet.Node, error) {
		status := tailnet.Status{State: tailnet.StateRunning, Online: true}
		if len(nodes) == 0 {
			status.Online = false
			status.IdentityInvalid = true
		}
		node := &countingNode{status: status}
		nodes = append(nodes, node)
		return node, nil
	}, tailnet.Options{})
	t.Cleanup(func() { _ = instance.tailnets.Close() })
	instance.tailnetConfigs.set(coretypes.TailnetConfigPayload{
		ID:      "corp",
		AuthKey: "reusable-key",
	})

	lease, err := instance.tailnets.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	lease.Release()
	if got := instance.tailnets.Leases("corp"); got != 0 {
		t.Fatalf("leases = %d, want idle", got)
	}

	instance.recoverTailnetIfNeeded("corp")

	if len(nodes) != 1 {
		t.Fatalf("nodes built = %d, want 1 — idle recovery must not create a control-plane node", len(nodes))
	}
	nodes[0].mu.Lock()
	closes, purges, logouts := nodes[0].closes, nodes[0].purges, nodes[0].logouts
	nodes[0].mu.Unlock()
	if closes != 1 || purges != 1 || logouts != 0 {
		t.Fatalf("invalid node closes=%d purges=%d logouts=%d, want 1/1/0", closes, purges, logouts)
	}
	if _, ok := instance.tailnets.StatusOf(context.Background(), "corp"); ok {
		t.Fatal("discarded identity remained in the registry")
	}

	// 다음 실제 사용이 새 노드를 만든다. 삭제 이벤트 자체는 새 registration 을 만들지 않는다.
	fresh, err := instance.tailnets.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire() after discard error = %v", err)
	}
	defer fresh.Release()
	if len(nodes) != 2 {
		t.Fatalf("nodes built after next use = %d, want 2", len(nodes))
	}
	status, err := fresh.Node.Status(context.Background())
	if err != nil || !status.Connected() {
		t.Fatalf("fresh status = %#v, err=%v", status, err)
	}
}

// 만료가 아니면 재인증을 개시하지 않는다. 멀쩡한 노드에 로그인을 개시하면 발급된 링크가
// 무효화되거나 불필요한 컨트롤 플레인 요청이 된다.
func TestTailnetTestDoesNotReauthWhenHealthy(t *testing.T) {
	node := &countingNode{status: tailnet.Status{
		State:  tailnet.StateRunning,
		Online: true,
	}}
	instance := newTailnetTestRuntime(t, node)

	if err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 500,
	}); err != nil {
		t.Fatalf("TailnetTest() error = %v", err)
	}

	node.mu.Lock()
	reauths := node.reauths
	node.mu.Unlock()
	if reauths != 0 {
		t.Fatalf("reauths = %d, want 0 — 멀쩡한 노드에는 개시하지 않는다", reauths)
	}
}

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

func newTailnetTestRuntime(t *testing.T, node tailnet.Node) *Service {
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

// 요청은 "강도" 를 정하지 않는다.
//
// 예전에는 페이로드에 forceRelogin 이 있어서, 요청하는 쪽이 "먼저 노드를 버려라" 를 지시했다.
// 그러면 정책이 요청 필드를 타고 흐르고, 렌더러가 취소·플래그·재시도를 조립하게 된다. 지금은
// 붙어 있는 노드가 있으면 그대로 쓰고, 다시 세울지는 코어가 링크 확보 과정에서 판단한다.
func TestTailnetTestReusesAConnectedNode(t *testing.T) {
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
			t.Fatalf("TailnetTest(%s): %v", requestID, err)
		}
	}

	if closed != 0 {
		t.Errorf("closed = %d, want 0 — 붙어 있는 노드를 버렸다", closed)
	}
	if node.ups < 2 {
		t.Errorf("ups = %d, want 2 이상 — 두 번째 요청이 같은 노드를 쓰지 않았다", node.ups)
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

// 다른 세션이 그 tailnet 을 쓰고 있어도 연결 요청은 실패가 아니다. 그 세션이 통신하고 있다는
// 것 자체가 등록이 살아 있다는 증거다 — 실패로 만들면 멀쩡한 연결이 오류로 끝난다.
func TestTailnetTestSucceedsWhileAnotherConsumerHoldsTheNode(t *testing.T) {
	node := &countingNode{status: tailnet.Status{State: tailnet.StateRunning, Online: true}}
	runtime := newTailnetTestRuntime(t, node)

	// 다른 소비자가 붙들고 있는 상태를 만든다.
	lease, err := runtime.tailnets.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer lease.Release()

	if err := runtime.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config: coretypes.TailnetConfigPayload{ID: "corp"},
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

	// 노드를 내리는 것은 시도가 끝난 뒤 별도 goroutine 에서 한다 — 그 정리가 상태 조회에서
	// 갇힐 수 있어서, 기다리면 취소가 끝난 사실이 늦게 알려진다. 그래서 결과를 기다려 확인한다.
	closed := time.Now().Add(2 * time.Second)
	for time.Now().Before(closed) {
		node.mu.Lock()
		closes := node.closes
		node.mu.Unlock()
		if closes == 1 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Error("취소했는데 인증 대기 노드가 닫히지 않았다")
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

// 동기화가 끊긴 채로 넘긴다는 결정도 전이다. 상태 자체는 그 전과 완전히 같아서(running, online
// 없음) 이 값이 유일한 차이다 — 여기서 빠지면 유일한 종료 신호가 묻히고 요청이 한도까지 매달린다.
func TestTailnetProgressKeepsTheDegradedDecision(t *testing.T) {
	waiting := coretypes.TailnetStatusPayload{ID: "corp", State: "running", Authorized: true}
	passed := waiting
	passed.Degraded = true

	if sameTailnetProgress(waiting, passed) {
		t.Error("동기화 없이 넘긴 결정을 같은 상태로 보면 종료 신호가 사라진다")
	}

	// 등록·로그인이 끝나는 전이도 마찬가지다. Expired 는 비교 목록에 없어서, Authorized 가 없으면
	// 만료가 드러나는 전이까지 함께 묻힌다.
	unauthorized := coretypes.TailnetStatusPayload{ID: "corp", State: "running"}
	if sameTailnetProgress(unauthorized, waiting) {
		t.Error("인가 여부가 바뀐 것을 같은 상태로 보면 화면이 낡은 단계를 그린다")
	}
}

// 동기화가 끊긴 구간에 사람 로그인 예산(3분)을 쓰지 않는다.
//
// 이 구간에는 사람이 할 일도, 코어가 확정적으로 고칠 일도 없다(단순 offline 은 재등록 근거가 아니다).
// 그래서 예산을 그대로 쓰면 확정적으로 3분을 태운 뒤 실패하고, 그 사이 상태가 하나도 바뀌지 않아
// 화면은 얼어붙는다 — 실제로 사용자는 멈춘 것으로 보고 취소했다.
//
// 유예가 지나면 통과시킨다. 데이터 플레인은 이미 받아 둔 넷맵으로 통하고, 진짜 답은 dial 만 안다.
func TestTailnetTestProceedsWhenTheSyncNeverComesBack(t *testing.T) {
	original := tailnetSyncGrace
	tailnetSyncGrace = 10 * time.Millisecond
	t.Cleanup(func() { tailnetSyncGrace = original })

	node := &countingNode{status: tailnet.Status{State: tailnet.StateRunning, Online: false}}
	instance := newTailnetTestRuntime(t, node)
	var mu sync.Mutex
	var events []coretypes.TailnetStatusPayload
	instance.emitEvent = func(event coretypes.Event) {
		if payload, ok := event.Payload.(coretypes.TailnetStatusPayload); ok {
			mu.Lock()
			events = append(events, payload)
			mu.Unlock()
		}
	}

	started := time.Now()
	if err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 3000,
	}); err != nil {
		t.Fatalf("TailnetTest() error = %v — 유예가 지나면 통과해야 한다", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Errorf("통과에 %s 걸렸다 — 사람 로그인 예산을 태우고 있다", elapsed)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(events) == 0 {
		t.Fatal("이벤트가 없다 — 기다리는 쪽이 끝을 알 방법이 없다")
	}
	last := events[len(events)-1]
	if !last.Degraded {
		t.Errorf("마지막 이벤트에 degraded 가 없다: %#v", last)
	}
	if last.Ready {
		t.Error("동기화가 끊긴 것을 ready 라고 하면 안 된다 — 그건 다른 판정이다")
	}
	if !last.Authorized {
		t.Error("등록·로그인은 끝난 상태다. authorized 가 없으면 화면이 그 단계를 되돌려 그린다")
	}

	// 노드를 다시 세우지 않는다. 일반 네트워크 장애를 재등록으로 오판하면 새 노드가 쌓인다.
	node.mu.Lock()
	defer node.mu.Unlock()
	if node.reauths != 0 || node.closes != 0 {
		t.Errorf("reauths = %d, closes = %d — 동기화 끊김에 노드를 건드렸다", node.reauths, node.closes)
	}
}

// 통과시킨 결정은 시도가 끝난 뒤에도 남아야 한다.
//
// 화면은 1 초마다 스냅샷을 다시 읽는다. 결정이 시도 안에만 있으면 그 스냅샷이 곧 지워서, 통과한
// 단계가 다시 "대기" 로 그려지고 호스트 계층은 시작도 안 한 것처럼 보인다 — 화면이 낡은 값을 들고
// 있는 것처럼 보이는 문제가 이 모양이었다.
//
// 동기화가 돌아오면 그 결정은 사라져야 한다. 남으면 멀쩡한 연결에 경고가 붙어 있다.
func TestTailnetSnapshotKeepsTheDegradedDecision(t *testing.T) {
	original := tailnetSyncGrace
	tailnetSyncGrace = 10 * time.Millisecond
	t.Cleanup(func() { tailnetSyncGrace = original })

	node := &countingNode{status: tailnet.Status{State: tailnet.StateRunning, Online: false}}
	instance := newTailnetTestRuntime(t, node)
	var mu sync.Mutex
	var snapshots []coretypes.TailnetSnapshotPayload
	instance.emitEvent = func(event coretypes.Event) {
		if payload, ok := event.Payload.(coretypes.TailnetSnapshotPayload); ok {
			mu.Lock()
			snapshots = append(snapshots, payload)
			mu.Unlock()
		}
	}

	if err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 3000,
	}); err != nil {
		t.Fatalf("TailnetTest: %v", err)
	}

	if err := instance.TailnetSnapshot("req-2"); err != nil {
		t.Fatalf("TailnetSnapshot: %v", err)
	}
	mu.Lock()
	first := snapshots[len(snapshots)-1].Statuses
	mu.Unlock()
	if len(first) != 1 || !first[0].Degraded {
		t.Fatalf("스냅샷이 결정을 잃었다: %#v", first)
	}

	// 동기화가 돌아오면 그냥 연결된 것이다.
	node.setStatus(tailnet.Status{State: tailnet.StateRunning, Online: true})
	if err := instance.TailnetSnapshot("req-3"); err != nil {
		t.Fatalf("TailnetSnapshot: %v", err)
	}
	mu.Lock()
	second := snapshots[len(snapshots)-1].Statuses
	mu.Unlock()
	if len(second) != 1 || second[0].Degraded || !second[0].Ready {
		t.Fatalf("동기화가 돌아왔는데 경고가 남았다: %#v", second)
	}
}

// 유예 안에 동기화가 돌아오면 평소처럼 통과한다 — degraded 를 달지 않는다. 그러지 않으면 잠깐 끊겼다
// 붙은 정상 연결에까지 경고가 남는다.
func TestTailnetTestWaitsOutABriefSyncGap(t *testing.T) {
	original := tailnetSyncGrace
	tailnetSyncGrace = 2 * time.Second
	t.Cleanup(func() { tailnetSyncGrace = original })

	node := &countingNode{status: tailnet.Status{State: tailnet.StateRunning, Online: false}}
	instance := newTailnetTestRuntime(t, node)
	var mu sync.Mutex
	var events []coretypes.TailnetStatusPayload
	instance.emitEvent = func(event coretypes.Event) {
		if payload, ok := event.Payload.(coretypes.TailnetStatusPayload); ok {
			mu.Lock()
			events = append(events, payload)
			mu.Unlock()
		}
	}

	go func() {
		time.Sleep(80 * time.Millisecond)
		node.setStatus(tailnet.Status{State: tailnet.StateRunning, Online: true})
	}()

	if err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 3000,
	}); err != nil {
		t.Fatalf("TailnetTest: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	last := events[len(events)-1]
	if last.Degraded {
		t.Errorf("동기화가 돌아왔는데 degraded 를 달았다: %#v", last)
	}
	if !last.Ready {
		t.Errorf("돌아온 뒤에는 ready 여야 한다: %#v", last)
	}
}

// 컨트롤 플레인에서 노드를 지우면 디스크의 노드 키가 그쪽에 없다. 이미 떠 있던 노드는 그 죽은
// 키로 재등록을 반복하며 백오프에 들어가고, 그 사이 로그인 링크가 나오지 않는다 — 사용자는
// "링크를 받는 중" 에서 한도까지 갇힌다. 노드를 새로 만들면 등록을 처음부터 밟아 링크가 나온다.
func TestTailnetTestRestartsWhenTheAuthLinkNeverArrives(t *testing.T) {
	// 유예를 실제로 기다리면 테스트가 25 초를 쓴다. 규칙은 시간 길이가 아니라 "링크가 안 오면
	// 새로 만든다" 다.
	original := tailnetAuthURLGrace
	tailnetAuthURLGrace = 10 * time.Millisecond
	t.Cleanup(func() { tailnetAuthURLGrace = original })

	stuck := &countingNode{status: tailnet.Status{State: tailnet.StateNeedsAuth}}
	fresh := &countingNode{
		status: tailnet.Status{State: tailnet.StateRunning, Online: true},
	}

	built := 0
	var mu sync.Mutex
	var events []coretypes.TailnetStatusPayload
	instance := &Service{emitEvent: func(event coretypes.Event) {
		if payload, ok := event.Payload.(coretypes.TailnetStatusPayload); ok {
			mu.Lock()
			events = append(events, payload)
			mu.Unlock()
		}
	}}
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

	// 다시 세운 것이 상태로 나가야 한다. 나가지 않으면 화면에서는 아무 일도 없는 것과 구분되지
	// 않는다 — 닫는 데 0.0 초가 걸리고 전후 상태가 동일해서 중복 제거가 이벤트를 버린다.
	mu.Lock()
	defer mu.Unlock()
	seen := false
	for _, event := range events {
		if event.Restarts > 0 {
			seen = true
			break
		}
	}
	if !seen {
		t.Errorf("노드를 다시 세운 사실이 상태로 나가지 않았다 (이벤트 %d 개)", len(events))
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

// 다시 세운 노드도 링크를 못 받을 수 있다. 그때 한 번으로 멈추면 링크 확보를 스스로 포기하는
// 것이다 — 그것이 Go 의 책임이므로 한도까지 계속 시도한다.
//
// 노드가 쌓이는 걱정은 없다. 발급만 받고 버린 등록은 기기를 만들지 않는다(노드는 사용자가 링크를
// 방문할 때 생성된다). 요청 부하만 남고, 그 상한이 시도 전체의 한도다.
func TestTailnetTestKeepsTryingUntilTheLinkArrives(t *testing.T) {
	original := tailnetAuthURLGrace
	tailnetAuthURLGrace = 10 * time.Millisecond
	t.Cleanup(func() { tailnetAuthURLGrace = original })

	var mu sync.Mutex
	built := 0
	instance := &Service{emitEvent: func(coretypes.Event) {}}
	instance.tailnetConfigs = newTailnetConfigs(t.TempDir())
	instance.tailnetTests = newTailnetTests()
	instance.tailnets = tailnet.NewRegistry(func(string) (tailnet.Node, error) {
		mu.Lock()
		built += 1
		mu.Unlock()
		// 어느 노드도 링크를 받지 못한다.
		return &countingNode{status: tailnet.Status{State: tailnet.StateNeedsAuth}}, nil
	}, tailnet.Options{})
	t.Cleanup(func() { _ = instance.tailnets.Close() })

	// 링크 없는 구간의 폴링은 250ms 다. 한도를 그 몇 배로 두어 재시도가 여러 번 들어가게 한다.
	err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 1_200,
	})
	if err == nil {
		t.Fatal("링크를 못 받았으면 한도에서 실패로 끝나야 한다")
	}

	mu.Lock()
	defer mu.Unlock()
	if built < 3 {
		t.Errorf("built = %d, want 3 이상 — 한 번 만들어 보고 포기했다", built)
	}
}

// 로그인이 거부됐으면 기다리지도, 다시 세우지도 않는다.
//
// 잘못된 auth key 가 이 경우다. 상태는 링크를 기다리는 것과 똑같아서(needsAuth + 링크 없음) 예전에는
// 화면이 "인증 링크 받는 중" 에 3 분을 앉아 있었고, 그 사이 노드를 새로 만들기까지 했다 — 같은 키를
// 다시 쓰니 무의미한 반복이다. 사람이 설정을 고쳐야 하는 일이므로 그 이유로 즉시 끝낸다.
func TestTailnetTestStopsWhenTheLoginWasRejected(t *testing.T) {
	original := tailnetAuthURLGrace
	tailnetAuthURLGrace = 10 * time.Millisecond
	t.Cleanup(func() { tailnetAuthURLGrace = original })

	var mu sync.Mutex
	built := 0
	instance := &Service{emitEvent: func(coretypes.Event) {}}
	instance.tailnetConfigs = newTailnetConfigs(t.TempDir())
	instance.tailnetTests = newTailnetTests()
	instance.tailnets = tailnet.NewRegistry(func(string) (tailnet.Node, error) {
		mu.Lock()
		built += 1
		mu.Unlock()
		return &countingNode{status: tailnet.Status{
			State:      tailnet.StateNeedsAuth,
			LoginError: "invalid key: unable to validate API key",
		}}, nil
	}, tailnet.Options{})
	t.Cleanup(func() { _ = instance.tailnets.Close() })

	started := time.Now()
	err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 5_000,
	})
	if err == nil {
		t.Fatal("로그인이 거부됐으면 실패로 끝나야 한다")
	}
	if !errors.Is(err, ErrTailnetLoginRejected) {
		t.Errorf("err = %v, want ErrTailnetLoginRejected", err)
	}
	// 이유가 붙어 나가야 한다. "실패했다" 만으로는 키를 고쳐야 하는지 알 수 없다.
	if !strings.Contains(err.Error(), "unable to validate API key") {
		t.Errorf("err = %v — 백엔드가 준 이유가 빠졌다", err)
	}
	// 한도(5 초)를 기다리지 않고 곧바로 끝나야 한다.
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Errorf("%.1fs 만에 끝났다 — 거부됐는데 한도까지 기다렸다", elapsed.Seconds())
	}

	mu.Lock()
	defer mu.Unlock()
	if built != 1 {
		t.Errorf("built = %d, want 1 — 같은 키로 노드를 다시 세웠다", built)
	}
}

// 그 tailnet 을 쓰는 것이 남아 있으면 노드를 버릴 수 없다(그 거절이 세션을 지킨다). 그때 기회를
// 소진하면 안 된다 — 쓰던 것이 정리되는 즉시 다시 세울 수 있어야 한다.
//
// 예전에는 거절도 한 번의 기회를 태워서, 세션이 죽은 뒤에도 그 요청에서는 다시 시도하지 않았다.
func TestTailnetTestRetriesAfterARefusedRebuild(t *testing.T) {
	original := tailnetAuthURLGrace
	tailnetAuthURLGrace = 10 * time.Millisecond
	t.Cleanup(func() { tailnetAuthURLGrace = original })

	var mu sync.Mutex
	built := 0
	var events []coretypes.TailnetStatusPayload
	instance := &Service{emitEvent: func(event coretypes.Event) {
		if payload, ok := event.Payload.(coretypes.TailnetStatusPayload); ok {
			mu.Lock()
			events = append(events, payload)
			mu.Unlock()
		}
	}}
	instance.tailnetConfigs = newTailnetConfigs(t.TempDir())
	instance.tailnetTests = newTailnetTests()
	instance.tailnets = tailnet.NewRegistry(func(string) (tailnet.Node, error) {
		mu.Lock()
		built += 1
		mu.Unlock()
		return &countingNode{status: tailnet.Status{State: tailnet.StateNeedsAuth}}, nil
	}, tailnet.Options{})
	t.Cleanup(func() { _ = instance.tailnets.Close() })

	// 다른 소비자(살아 있는 세션)가 붙들고 있는 상태에서 시작한다.
	held, err := instance.tailnets.Acquire("corp")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	// 시도가 도는 동안 그 세션이 정리된다.
	go func() {
		time.Sleep(500 * time.Millisecond)
		held.Release()
	}()

	if err := instance.TailnetTest("req-1", coretypes.TailnetTestPayload{
		Config:    coretypes.TailnetConfigPayload{ID: "corp"},
		TimeoutMs: 1_500,
	}); err == nil {
		t.Fatal("링크를 못 받았으면 한도에서 실패로 끝나야 한다")
	}

	mu.Lock()
	defer mu.Unlock()
	if built < 2 {
		t.Errorf("built = %d, want 2 이상 — 거절이 기회를 태웠다", built)
	}
	refused := false
	for _, event := range events {
		if event.RestartRefused {
			refused = true
			break
		}
	}
	if !refused {
		t.Error("거절이 상태로 나가지 않았다 — 화면이 무엇을 기다리는지 알 수 없다")
	}
}
