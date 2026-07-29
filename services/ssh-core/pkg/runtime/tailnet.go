package runtime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/tailnet"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// tailnetTestTimeout 은 연결 테스트가 Running 을 기다리는 기본 한도다.
//
// 브라우저 로그인은 사람이 브라우저를 열고 로그인하는 시간을 포함하므로 넉넉해야 한다.
// auth key 경로는 훨씬 빨리 끝나지만, 같은 한도를 써도 먼저 Running 에 도달하면 그 즉시
// 반환하므로 손해가 없다.
const tailnetTestTimeout = 3 * time.Minute

// 폴링 간격은 무엇을 기다리는지에 따라 다르다.
//
// 인증 URL 이 나오기 전에는 컨트롤 플레인의 등록 왕복을 기다리는 중이다. 실측 2~3 초라
// 1 초 간격이면 그 자체로 최대 1 초를 더 얹는다 — 사용자가 아무것도 할 수 없는 구간이므로
// 촘촘히 본다. URL 이 나온 뒤에는 사람이 브라우저에서 로그인하기를 기다리는 것이라 촘촘할
// 이유가 없다.
const (
	tailnetStatusPollFast = 250 * time.Millisecond
	tailnetStatusPollSlow = time.Second
)

// tailnetAuthURLGrace 는 인증 링크를 기다려 주는 시간이다.
//
// 실측에서 링크는 2.05~15.41 초 사이에 왔다. 그 상한 위로 잡아야 한다 — 짧게 잡으면 느리게
// 오는 정상 링크를 죽이고 노드를 새로 만들어서, 잘 되던 연결이 갑자기 안 된다.
//
// 링크가 아예 오지 않는 경우(컨트롤 플레인에서 노드를 지운 뒤 죽은 키로 재등록을 반복하는 상태)만
// 잡으면 되므로, 상한보다 넉넉히 두어도 목적을 잃지 않는다.
var tailnetAuthURLGrace = 25 * time.Second

// restartNode 는 노드를 닫고 새로 만든다. 새 노드를 받으면 true 다.
//
// 리스를 들고 있으면 노드를 버릴 수 없으므로 우리 리스를 먼저 놓는다. 다른 소비자가 쓰고 있으면
// 버리지 못하는데, 그건 이 tailnet 으로 통신이 되고 있다는 뜻이라 다시 만들 이유도 없다 — 그때는
// 원래 리스를 그대로 다시 잡고 false 를 돌려준다.
func (runtime *Runtime) restartNode(id string, lease **tailnet.Lease) (bool, error) {
	(*lease).Release()

	if err := runtime.tailnets.Reset(id); err != nil {
		if !errors.Is(err, tailnet.ErrNodeInUse) {
			return false, err
		}
		again, acquireErr := runtime.tailnets.Acquire(id)
		if acquireErr != nil {
			return false, acquireErr
		}
		*lease = again
		return false, nil
	}

	fresh, err := runtime.tailnets.Acquire(id)
	if err != nil {
		return false, err
	}
	*lease = fresh
	return true, nil
}

// tailnetRecoveryDebounce 는 같은 노드의 알림이 몰려 올 때 복구 판정을 한 번으로 모으는
// 시간이다. 로그인 한 번에도 상태·넷맵·건강 알림이 연달아 오므로, 그때마다 판정하면 같은 일을
// 여러 번 한다.
const tailnetRecoveryDebounce = 700 * time.Millisecond

// onTailnetNotify 는 백엔드가 상태 변화를 푸시했을 때 불린다.
//
// 폴링하지 않는 이유가 이것이다 — 만료·인증 필요·링크 발급은 모두 백엔드가 IPN 버스로 알려
// 주는 사건이다. 버스 goroutine 에서 불리므로 판정은 별도 goroutine 으로 넘긴다(여기서 상태를
// 읽으면 알림 수신이 밀린다).
func (runtime *Runtime) onTailnetNotify(id string) {
	if runtime.tailnets == nil {
		return
	}
	runtime.tailnetRecoveryMu.Lock()
	if runtime.tailnetRecoveryPending == nil {
		runtime.tailnetRecoveryPending = make(map[string]bool)
	}
	if runtime.tailnetRecoveryPending[id] {
		runtime.tailnetRecoveryMu.Unlock()
		return
	}
	runtime.tailnetRecoveryPending[id] = true
	runtime.tailnetRecoveryMu.Unlock()

	go func() {
		// 알림 묶음이 지나가기를 기다린 뒤 한 번만 본다.
		time.Sleep(tailnetRecoveryDebounce)
		runtime.tailnetRecoveryMu.Lock()
		delete(runtime.tailnetRecoveryPending, id)
		runtime.tailnetRecoveryMu.Unlock()

		runtime.recoverTailnetIfExpired(id)
	}()
}

// awaitTailnetAttempt 는 먼저 시작된 시도의 결과를 기다려 자기 요청의 결말을 낸다.
//
// 노드를 다시 올리거나 만들지 않는다 — 그 일은 선행 시도가 하고 있다. 결과만 자기 requestID 로
// 한 번 보고해서, 기다리는 쪽(데스크톱)이 끝을 볼 수 있게 한다. 선행 시도가 보내는 진행 상황은
// 브로드캐스트로 이미 화면에 닿으므로 여기서 중복해 흘리지 않는다.
func (runtime *Runtime) awaitTailnetAttempt(
	ctx context.Context,
	requestID string,
	id string,
	attempt *tailnetAttempt,
) error {
	emit := func(payload coretypes.TailnetStatusPayload) {
		runtime.emitEvent(coretypes.Event{
			Type:      coretypes.EventTailnetStatus,
			RequestID: requestID,
			Payload:   payload,
		})
	}

	select {
	case <-attempt.done:
	case <-ctx.Done():
		// 이 요청만 접힌 것이다(선행 시도는 그대로 진행될 수 있다).
		if errors.Is(ctx.Err(), context.Canceled) {
			emit(coretypes.TailnetStatusPayload{
				ID:        id,
				State:     string(tailnet.StateStopped),
				Cancelled: true,
			})
			return nil
		}
		timeoutErr := fmt.Errorf("tailnet %q did not come up in time", id)
		emit(coretypes.TailnetStatusPayload{
			ID:    id,
			State: string(tailnet.StateStopped),
			Error: timeoutErr.Error(),
		})
		return timeoutErr
	}

	// 선행 시도가 끝났다. 지금 상태가 곧 결과다 — 판정은 코어 한 곳(Connected)만 본다.
	status, ok := runtime.tailnets.StatusOf(context.Background(), id)
	if !ok {
		// 노드가 사라졌다 = 선행 시도가 접혔다는 뜻이다.
		emit(coretypes.TailnetStatusPayload{
			ID:        id,
			State:     string(tailnet.StateStopped),
			Cancelled: true,
		})
		return nil
	}

	result := runtime.tailnetStatusPayloadFor(id, status)
	if !status.Connected() {
		// 붙지 못한 채 끝났다. 이유를 담아 끝을 알린다 — 담지 않으면 기다리는 쪽이 한도까지 매달린다.
		result.Error = fmt.Sprintf("tailnet %q did not come up", id)
	}
	emit(result)
	if result.Error != "" {
		return errors.New(result.Error)
	}
	return nil
}

// recoverTailnetIfExpired 는 만료된 노드의 복구를 시작한다.
//
// 복구 수단은 사용자가 "다시 시도" 로 하던 것과 같다(ForceRelogin) — 노드를 닫고 새로 만들면
// 등록을 처음부터 밟아 인증 링크가 곧바로 나온다. 이미 검증된 경로라 새 메커니즘을 만들지 않는다.
//
// 세션(터미널·SFTP·포워딩)이 복구를 맡으면 같은 노드를 두고 여러 곳이 각자 복구를 시도해 인증
// 링크가 서로를 무효화한다. 그래서 코어 한 곳에서만 한다.
func (runtime *Runtime) recoverTailnetIfExpired(id string) {
	// 취소는 억제 표시를 남기지 않는다. 취소가 노드를 없애므로 여기서 볼 것이 사라지고
	// (StatusOf 가 !ok), 다시 쓰려는 소비자가 요청하면 그때 새 노드로 시작한다.
	//
	// 아무도 쓰지 않는 tailnet 은 복구하지 않는다.
	//
	// 복구의 목적은 쓰고 있는 연결을 살리는 것이다. 소비자가 없으면 지금 복구할 이유가 없고,
	// 하면 해로운 쪽이 크다 — 복구가 리스를 잡아 유휴 타이머를 계속 되돌리므로 만료된 노드가
	// 30분 유휴 회수에 도달하지 못하고, 한도마다 인증 링크를 새로 발급해 churn 을 만든다.
	// 다음에 누가 쓰려 할 때 게이트가 같은 일을 한다.
	if runtime.tailnets.Leases(id) == 0 {
		return
	}
	status, ok := runtime.tailnets.StatusOf(context.Background(), id)
	if !ok || !status.Expired {
		return
	}
	// 진행 중인 시도가 있으면 건드리지 않는다. 끼어들면 그 시도가 취소되고, 사용자가
	// 브라우저에서 쓰던 링크가 무효화된다.
	if runtime.tailnetTests != nil && runtime.tailnetTests.active(id) {
		return
	}
	config, ok := runtime.tailnetConfigs.get(id)
	if !ok {
		return
	}

	// requestID 가 비어 있으면 상태가 브로드캐스트로 나간다 — 설정 화면과 연결 화면이 모두
	// 그것을 보고, 인증 링크는 메인 프로세스가 열어 준다.
	_ = runtime.TailnetTest("", coretypes.TailnetTestPayload{
		Config:       config,
		ForceRelogin: true,
	})
}

// statusWithCancel 는 상태 조회를 취소 가능하게 만든다.
//
// Node.Status 에는 ctx 를 존중하지 못하는 구간이 있다. 백엔드는 키가 만료되면 데이터 플레인을
// 내리는데(popBrowserAuthNow → stopEngineAndWaitLocked) 그 동안 자기 뮤텍스를 잡고 있고,
// status 요청은 그 뮤텍스를 기다린다 — 뮤텍스 대기는 ctx 취소로 풀리지 않는다.
//
// 그 안에서 기다리면 사용자가 취소를 눌러도 루프가 그것을 볼 기회를 얻지 못해, 요청이 한도까지
// 매달리고 화면은 마지막 문구에 얼어붙는다. 조회를 goroutine 으로 보내고 여기서 ctx 와
// 경합시켜 취소가 항상 이기게 한다. 남은 goroutine 은 조회가 끝나면 스스로 사라진다.
func statusWithCancel(ctx context.Context, node tailnet.Node) (tailnet.Status, error) {
	type result struct {
		status tailnet.Status
		err    error
	}
	done := make(chan result, 1)
	go func() {
		status, err := node.Status(ctx)
		done <- result{status: status, err: err}
	}()

	select {
	case outcome := <-done:
		return outcome.status, outcome.err
	case <-ctx.Done():
		return tailnet.Status{}, ctx.Err()
	}
}

// tailnetStatusPollFor 는 현재 무엇을 기다리는지로 간격을 고른다.
func tailnetStatusPollFor(status tailnet.Status) time.Duration {
	if status.AuthURL == "" {
		return tailnetStatusPollFast
	}
	return tailnetStatusPollSlow
}

// tailnetTests 는 진행 중인 연결 시도를 취소할 수 있게 들고 있는 것이다.
//
// 브라우저 로그인은 사람을 기다리는 구간이라 최대 3 분까지 간다. 그동안 사용자가 그만두고
// 싶을 수 있는데, 붙들 방법이 없으면 타임아웃까지 갇힌다.
type tailnetTests struct {
	mu   sync.Mutex
	byID map[string]*tailnetAttempt
}

// tailnetAttempt 는 시도 하나의 신원이다.
//
// 취소 함수 자체로는 자기 시도인지 알 수 없다 — Go 는 함수값을 비교할 수 없다. 포인터로
// 들고 있으면 신원 비교가 성립해서, 늦게 끝난 앞 시도가 뒤 시도의 취소를 지우는 일이 없다.
type tailnetAttempt struct {
	cancel context.CancelFunc
	// done 은 이 시도가 끝나면 닫힌다. 뒤에 온 요청이 합류해 기다리는 통로다.
	done chan struct{}
}

func newTailnetTests() *tailnetTests {
	return &tailnetTests{byID: make(map[string]*tailnetAttempt)}
}

// begin 은 시도를 등록하고 그 신원을 돌려준다.
//
// 이미 진행 중이면 그 시도를 그대로 돌려준다(joined=true) — 접지 않는다. 노드는 tailnet 하나에
// 하나뿐이라, 터미널·SFTP·포트포워딩·컨테이너가 각자 시도를 만들면 서로를 취소하고, 그 과정에서
// 노드가 닫히거나 재생성돼 사용자가 브라우저에서 쓰던 인증 링크가 죽는다. 하나만 일하고 나머지는
// 그 결과를 받는다.
//
// force 는 사용자가 명시적으로 처음부터 다시 하려는 경우다(다시 시도). 그때만 앞의 것을 접는다.
func (t *tailnetTests) begin(
	id string,
	cancel context.CancelFunc,
	force bool,
) (attempt *tailnetAttempt, joined bool) {
	t.mu.Lock()
	previous := t.byID[id]
	if previous != nil && !force {
		t.mu.Unlock()
		return previous, true
	}
	next := &tailnetAttempt{cancel: cancel, done: make(chan struct{})}
	t.byID[id] = next
	t.mu.Unlock()

	if previous != nil {
		previous.cancel()
	}
	return next, false
}

// end 는 자기 자신이 등록돼 있을 때만 지운다.
//
// 늦게 끝난 앞 시도가 새 시도를 지우면, 살아 있는 시도를 아무도 취소할 수 없게 된다 — 사용자
// 화면에서는 취소를 눌러도 아무 일이 없는 것으로 보인다.
func (t *tailnetTests) end(id string, attempt *tailnetAttempt) {
	t.mu.Lock()
	if t.byID[id] == attempt {
		delete(t.byID, id)
	}
	t.mu.Unlock()

	// 합류한 요청들을 풀어 준다. 시도를 만든 곳에서만 한 번 부르므로 두 번 닫히지 않는다.
	close(attempt.done)
}

// active 는 이 tailnet 에 진행 중인 시도가 있는지다. 감독자가 사용자의 시도에 끼어들지
// 않으려고 묻는다.
func (t *tailnetTests) active(id string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	_, ok := t.byID[id]
	return ok
}

// cancel 은 진행 중이면 접고 그 사실을 알려 준다.
func (t *tailnetTests) cancel(id string) bool {
	t.mu.Lock()
	attempt, ok := t.byID[id]
	if ok {
		delete(t.byID, id)
	}
	t.mu.Unlock()

	if ok {
		attempt.cancel()
	}
	return ok
}

// tailnetConfigs 는 tailnet id → 노드 설정이다.
//
// 레지스트리는 id 로만 노드를 만들고 설정은 모른다(수명 규칙만 담당). 설정은 요청 페이로드로
// 들어오므로 여기에 담아 두고 팩토리가 읽는다.
type tailnetConfigs struct {
	mu   sync.Mutex
	root string
	byID map[string]coretypes.TailnetConfigPayload
	// notify 는 노드가 백엔드 알림을 받았을 때 코어에 알리는 통로다. 노드를 만들 때 심는다.
	notify func(id string)
}

func newTailnetConfigs(root string) *tailnetConfigs {
	return &tailnetConfigs{root: root, byID: make(map[string]coretypes.TailnetConfigPayload)}
}

// get 은 저장된 설정을 돌려준다. 감독자가 복구를 시작할 때 쓴다 — 복구는 요청 페이로드 없이
// 코어가 스스로 하는 것이므로 설정을 여기서 읽어야 한다.
func (c *tailnetConfigs) get(id string) (coretypes.TailnetConfigPayload, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	config, ok := c.byID[id]
	return config, ok
}

// set 은 설정을 갈아 끼우고, 노드를 다시 만들어야 하는 변경이었는지 알려준다.
//
// 노드는 만들어질 때 설정을 받으므로, 이미 만들어진 노드는 새 auth key 나 새 컨트롤 플레인을
// 알 방법이 없다. 바뀐 값으로 다시 시험하려면 노드를 버려야 한다.
func (c *tailnetConfigs) set(config coretypes.TailnetConfigPayload) (changed bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	previous, existed := c.byID[config.ID]
	c.byID[config.ID] = config
	return existed && previous != config
}

// replaceAll 은 설정 전체를 갈아 끼우고, 노드를 다시 만들어야 하는 id 들을 알려준다.
//
// 목록에 없던 id 는 지운다. 그렇게 해야 코어의 상태가 데스크톱과 같아진다 — 삭제를 따로
// 통보받지 않아도 되고, 지워진 tailnet 의 auth key 를 코어가 계속 들고 있지도 않는다.
func (c *tailnetConfigs) replaceAll(configs []coretypes.TailnetConfigPayload) (changed []string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	next := make(map[string]coretypes.TailnetConfigPayload, len(configs))
	for _, config := range configs {
		id := strings.TrimSpace(config.ID)
		if id == "" {
			continue
		}
		config.ID = id
		next[id] = config
		if previous, existed := c.byID[id]; existed && previous != config {
			changed = append(changed, id)
		}
	}
	// 사라진 설정도 노드를 버려야 한다. 남겨 두면 지워진 tailnet 으로 계속 붙는다.
	for id := range c.byID {
		if _, kept := next[id]; !kept {
			changed = append(changed, id)
		}
	}

	c.byID = next
	return changed
}

func (c *tailnetConfigs) remove(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.byID, id)
}

// newNode 는 레지스트리의 NodeFactory 다.
func (c *tailnetConfigs) newNode(id string) (tailnet.Node, error) {
	c.mu.Lock()
	config, ok := c.byID[id]
	root := c.root
	c.mu.Unlock()

	if !ok {
		return nil, fmt.Errorf("tailnet %q is not configured", id)
	}
	if strings.TrimSpace(root) == "" {
		// 여기서 막지 않으면 tsnet 이 os.UserConfigDir() 밑에 제멋대로 상태를 만든다.
		return nil, errors.New("tailnet state directory is not configured")
	}

	hostname := strings.TrimSpace(config.Hostname)
	if hostname == "" {
		hostname = defaultNodeHostname()
	}

	c.mu.Lock()
	notify := c.notify
	c.mu.Unlock()

	return tailnet.NewNode(tailnet.NodeConfig{
		Hostname:   hostname,
		ControlURL: config.ControlURL,
		AuthKey:    config.AuthKey,
		Ephemeral:  config.Ephemeral,
		// 백엔드가 변화를 푸시하면 코어가 복구를 판단한다. 폴링하지 않는 근거가 이것이다.
		OnNotify: func() {
			if notify != nil {
				notify(id)
			}
		},
		// tailnet 마다 별도 디렉터리. 노드키가 들어가므로 기기 로컬 전용이고 동기화 대상이
		// 아니다. id 를 그대로 쓰지 않고 정제해 경로 조작을 막는다.
		Dir: filepath.Join(root, sanitizeTailnetDir(id)),
	})
}

// defaultNodeHostname 은 노드 이름을 정하지 않았을 때 쓸 이름이다. "dolgate-<기기 이름>".
//
// 두 가지를 동시에 만족해야 한다. 기기 이름이 들어가야 같은 사용자의 기기 둘이 겹치지 않고
// (겹치면 컨트롤 플레인이 -1, -2 를 붙인다), 접두사가 있어야 기기 목록에서 Dolgate 가 만든
// 노드임을 알아볼 수 있다 — 같은 기기에 진짜 Tailscale 클라이언트도 깔려 있으면 기기 이름만
// 으로는 구분이 안 된다. 접두사를 앞에 두면 목록에서 한데 모이기도 한다.
func defaultNodeHostname() string {
	const prefix = "dolgate"

	name, err := os.Hostname()
	if err != nil {
		return prefix
	}
	// macOS 는 "MacBook-Pro.local" 처럼 도메인을 붙여 준다. tailnet 이름에는 군더더기다.
	name = strings.TrimSpace(strings.TrimSuffix(name, ".local"))
	if name == "" {
		return prefix
	}
	return prefix + "-" + name
}

// sanitizeTailnetDir 는 id 를 디렉터리 이름으로 쓸 수 있게 만든다. id 는 설정에서 오므로
// 경로 구분자나 상위 참조가 섞이면 상태 디렉터리가 root 밖으로 새어나간다.
func sanitizeTailnetDir(id string) string {
	var builder strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			builder.WriteRune(r)
		default:
			builder.WriteByte('_')
		}
	}
	cleaned := builder.String()
	if cleaned == "" {
		return "unnamed"
	}
	return cleaned
}

// tailnetStatusPayloadFor 는 상태에 "지금 시도가 돌고 있는지"를 붙여서 내보낸다. 화면이
// 거짓 진행(아무도 손대지 않는데 스피너)을 그리지 않게 하는 유일한 근거다.
func (runtime *Runtime) tailnetStatusPayloadFor(
	id string,
	status tailnet.Status,
) coretypes.TailnetStatusPayload {
	payload := tailnetStatusPayload(id, status)
	if runtime.tailnetTests != nil {
		payload.Attempting = runtime.tailnetTests.active(id)
	}
	return payload
}

// tailnetStatusPayload 는 노드 상태를 이벤트 페이로드로 옮긴다.

func tailnetStatusPayload(id string, status tailnet.Status) coretypes.TailnetStatusPayload {
	return coretypes.TailnetStatusPayload{
		ID:           id,
		State:        string(status.State),
		AuthURL:      status.AuthURL,
		LoginName:    status.LoginName,
		TailnetName:  status.TailnetName,
		NodeName:     status.NodeName,
		NodeIP:       status.NodeIP,
		Expired:      status.Expired,
		Ready:        status.Connected(),
		Online:       status.Online,
		Health:       status.Health,
		BackendState: status.BackendState,
		KeyExpiry:    status.KeyExpiry,
		Peers:        tailnetPeerPayloads(status.Peers),
	}
}

func tailnetPeerPayloads(peers []tailnet.Peer) []coretypes.TailnetPeerPayload {
	if len(peers) == 0 {
		return nil
	}
	payloads := make([]coretypes.TailnetPeerPayload, 0, len(peers))
	for _, peer := range peers {
		payloads = append(payloads, coretypes.TailnetPeerPayload{
			HostName: peer.HostName,
			DNSName:  peer.DNSName,
			IPs:      peer.IPs,
			Direct:   peer.Direct,
			Relay:    peer.Relay,
			RxBytes:  peer.RxBytes,
			TxBytes:  peer.TxBytes,
		})
	}
	return payloads
}

// TailnetTest 는 노드를 올려 Running 까지 가는지 확인하고, 그 과정을 이벤트로 흘린다.
//
// Dial 의 에러에 기대지 않는다. tsnet 은 승인 대기 같은 상태를 terminal 로 보고 문자열
// 에러로 뭉개는데, 사용자에게 보여줄 수 있는 형태가 아니다. 상태를 직접 읽어야 "브라우저에서
// 로그인하세요"와 "관리자 승인을 기다리는 중"을 구분해 안내할 수 있다.
func (runtime *Runtime) TailnetTest(requestID string, payload coretypes.TailnetTestPayload) error {
	if runtime.tailnets == nil {
		return errors.New("tailnet support is not enabled")
	}
	id := strings.TrimSpace(payload.Config.ID)
	if id == "" {
		return errors.New("tailnet id is required")
	}

	// 설정이 바뀌었으면 옛 노드를 버린다. 그러지 않으면 auth key 를 고쳐 다시 시험해도 옛
	// 값으로 만들어진 노드가 그대로 답해서, 사용자는 고친 값이 반영되지 않은 결과를 본다.
	// 쓰이는 중이면 버릴 수 없다 — 그 위에 얹힌 세션이 죽는다.
	if runtime.tailnetConfigs.set(payload.Config) {
		if err := runtime.tailnets.Reset(id); err != nil {
			return err
		}
	} else if payload.ForceRelogin {
		// 만료를 상태로는 알 수 없다. 컨트롤 플레인에서 노드를 만료시켜도 tsnet 은 메모리에
		// 남은 낡은 netmap 으로 계속 running 을 보고한다 — 만료 여부는 새 netmap 이 올 때만
		// 계산되고(그런데 만료되면 그게 오지 않는다), running 은 한 번 되면 그대로 유지된다.
		// WantRunning 을 껐다 켜도 같은 netmap 으로 돌아오므로 달라지지 않는다.
		//
		// 그래서 노드를 닫고 다시 만든다. netmap 없이 시작하면 컨트롤 플레인의 답을 받아야
		// running 이 되므로, 만료라면 인증이 필요하다는 상태로 떨어진다. 노드 키는 상태
		// 디렉터리에 남으니 새로 발급되지 않는다 — 확인할 때마다 키가 쌓이지 않는다.
		//
		// 쓰이는 중이면 버릴 수 없는데, 그건 다른 세션이 이 tailnet 으로 통신하고 있다는
		// 뜻이라 등록이 살아 있다는 증거다. 확인할 것이 없으니 그대로 진행한다.
		if err := runtime.tailnets.Reset(id); err != nil &&
			!errors.Is(err, tailnet.ErrNodeInUse) {
			return err
		}
	}

	lease, err := runtime.tailnets.Acquire(id)
	if err != nil {
		return err
	}
	// 취소로 끝나면 노드도 내린다.
	//
	// 여기서 하는 이유: 취소 명령이 직접 내리려 하면 이 테스트가 아직 리스를 들고 있어서
	// 거절당한다(쓰이는 중인 노드는 내릴 수 없다). 리스를 놓는 시점을 아는 것은 이쪽이다.
	//
	// defer 는 늦게 등록한 것이 먼저 돌아서, 이 등록이 Release 보다 앞에 있어야 Release 다음에
	// 실행된다.
	cancelled := false
	defer func() {
		if !cancelled {
			return
		}
		// 별도 goroutine 으로 보낸다. 이 정리는 상태 조회를 하는데, 만료를 처리하는 백엔드는
		// 뮤텍스를 잡고 있어 그 조회가 몇 초 갇힐 수 있다 — 여기서 기다리면 시도가 끝난 사실이
		// 그만큼 늦게 알려져 사용자에게는 취소가 늦게 듣는 것으로 보인다. 실패는 원래 삼킨다.
		go runtime.stopUnauthenticatedNode(id)
	}()

	// 테스트는 노드를 붙들지 않는다. 놓아도 유예 동안 살아 있으므로, 곧바로 호스트에
	// 연결하면 이미 올라온 노드를 그대로 쓴다.
	//
	// 아래에서 노드를 새로 만들며 리스를 바꿔 낄 수 있어서, 그때그때의 리스를 놓는다.
	defer func() { lease.Release() }()

	timeout := tailnetTestTimeout
	if payload.TimeoutMs > 0 {
		timeout = time.Duration(payload.TimeoutMs) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	// 사용자가 중간에 그만둘 수 있어야 한다. 브라우저 로그인은 사람을 기다리는 구간이라
	// 최대 3 분까지 가는데, 접을 방법이 없으면 그때까지 갇힌다.
	// 이미 이 tailnet 을 올리는 중이면 그 시도에 합류한다. 각자 시도를 만들면 서로를 취소하고,
	// 그 과정에서 노드가 닫히거나 재생성돼 브라우저에서 쓰던 인증 링크가 죽는다.
	if runtime.tailnetTests != nil {
		attempt, joined := runtime.tailnetTests.begin(id, cancel, payload.ForceRelogin)
		if joined {
			return runtime.awaitTailnetAttempt(ctx, requestID, id, attempt)
		}
		defer runtime.tailnetTests.end(id, attempt)
	}

	// 이미 있는 노드는 Down 된 상태일 수 있다(사용자가 끊었거나 유휴 유예가 지났거나).
	// 올려 주지 않으면 Stopped 인 채로 타임아웃까지 폴링만 한다.
	if err := lease.Node.Up(ctx); err != nil {
		runtime.emitEvent(coretypes.Event{
			Type:      coretypes.EventTailnetStatus,
			RequestID: requestID,
			Payload: coretypes.TailnetStatusPayload{
				ID:    id,
				State: string(tailnet.StateStopped),
				Error: err.Error(),
			},
		})
		return err
	}

	var last coretypes.TailnetStatusPayload
	emit := func(status coretypes.TailnetStatusPayload) {
		// 같은 상태를 반복해 보내지 않는다 — 폴링 간격마다 이벤트가 쌓이면 UI 가 깜빡인다.
		//
		// Peers 는 비교에서 뺀다. 경로는 승격되며 계속 바뀌는데(릴레이→직결) 그것 때문에
		// 진행 이벤트가 매 폴링마다 다시 나가면 연결 화면이 깜빡인다. 이 이벤트는 "등록이
		// 어디까지 갔는가"를 보여주는 것이고, 경로는 스냅샷으로 본다.
		if sameTailnetProgress(status, last) {
			return
		}
		last = status
		runtime.emitEvent(coretypes.Event{
			Type:      coretypes.EventTailnetStatus,
			RequestID: requestID,
			Payload:   status,
		})
	}

	// 인증 링크를 기다린 시각. 링크가 안 오는 채로 갇히는 경우를 여기서 푼다.
	var waitingForAuthURLSince time.Time
	restarted := false

	reauthRequested := false

	for {
		status, err := statusWithCancel(ctx, lease.Node)
		if err != nil {
			// 취소는 실패가 아니다. 아래 select 와 같은 결말을 내야 한다 — 그러지 않으면
			// 기다리는 쪽이 취소를 오류로 받고, 화면에 이유 없는 실패가 뜬다.
			if errors.Is(err, context.Canceled) {
				cancelled = true
				emit(coretypes.TailnetStatusPayload{
					ID:        id,
					State:     string(tailnet.StateStopped),
					Cancelled: true,
				})
				return nil
			}
			emit(coretypes.TailnetStatusPayload{ID: id, State: string(tailnet.StateStopped), Error: err.Error()})
			return err
		}

		emit(runtime.tailnetStatusPayloadFor(id, status))

		// 만료는 재인증이 필요하다는 확정 신호다. 기다릴 이유가 없으므로 바로 로그인을 개시한다.
		//
		// 이미 떠 있는 노드는 WantRunning 을 다시 켜도 로그인이 시작되지 않는다. 개시해 주지
		// 않으면 백엔드가 자기 백오프 일정으로 재로그인할 때까지 링크가 나오지 않아, 화면이
		// 수 분간 "링크를 받는 중" 에 머문다.
		//
		// 별도 goroutine 으로 보내는 이유는 취소 때문이다. 이 호출도 백엔드 뮤텍스를 기다릴 수
		// 있어서, 여기서 기다리면 취소가 다시 묻힌다. 시도당 한 번만 요청하고(노드가 구간당
		// 한 번만 실제로 개시한다) 결과는 상태 폴링으로 확인한다.
		if status.Expired && !reauthRequested {
			reauthRequested = true
			go func() { _ = lease.Node.Reauth(ctx) }()
		}

		// 인증이 필요한데 링크가 오지 않는 상태로 갇힐 수 있다.
		//
		// 컨트롤 플레인에서 노드를 지우면 디스크의 노드 키가 그쪽에 존재하지 않는다. 이미 떠 있던
		// 노드의 컨트롤 클라이언트는 그 죽은 키로 재등록을 반복하며 백오프에 들어가고, 그 사이
		// 로그인 링크가 나오지 않는다 — 사용자는 "링크를 받는 중" 에서 끝까지 갇힌다.
		//
		// 노드를 새로 만들면 등록을 처음부터 밟아서 링크가 곧바로 나온다. 한 번만 한다 — 그래도
		// 안 되면 한도까지 기다린 뒤 정직하게 끝낸다.
		if status.State == tailnet.StateNeedsAuth && status.AuthURL == "" {
			if waitingForAuthURLSince.IsZero() {
				waitingForAuthURLSince = time.Now()
			} else if !restarted && time.Since(waitingForAuthURLSince) > tailnetAuthURLGrace {
				restarted = true
				fresh, restartErr := runtime.restartNode(id, &lease)
				if restartErr != nil {
					emit(coretypes.TailnetStatusPayload{
						ID:    id,
						State: string(tailnet.StateStopped),
						Error: restartErr.Error(),
					})
					return restartErr
				}
				if fresh {
					if err := lease.Node.Up(ctx); err != nil {
						emit(coretypes.TailnetStatusPayload{
							ID:    id,
							State: string(tailnet.StateStopped),
							Error: err.Error(),
						})
						return err
					}
					continue
				}
			}
		} else {
			waitingForAuthURLSince = time.Time{}
		}

		// 관문은 판정 한 곳만 본다. running 이나 만료 여부를 여기서 다시 조합하지 않는다 —
		// 그러면 기준이 갈리고, 반쪽 기준이 낡은 상태를 통과시킨다.
		if status.Connected() {
			return nil
		}

		select {
		case <-ctx.Done():
			// 사용자가 접은 것이면 실패가 아니다. 마지막 상태만 정리해 보내고 조용히 끝낸다.
			if errors.Is(ctx.Err(), context.Canceled) {
				cancelled = true
				emit(coretypes.TailnetStatusPayload{
					ID:        id,
					State:     string(tailnet.StateStopped),
					Cancelled: true,
				})
				return nil
			}
			// 시간이 다 됐다는 것 자체가 결과다. 승인 대기나 미인증 상태로 끝났다면 마지막
			// 상태가 이미 나가 있으므로, 화면은 무엇을 기다리는 중이었는지 보여줄 수 있다.
			timeoutErr := fmt.Errorf("tailnet %q did not come up within %s", id, timeout)
			timedOut := runtime.tailnetStatusPayloadFor(id, status)
			timedOut.Error = timeoutErr.Error()
			emit(timedOut)
			return timeoutErr
		case <-time.After(tailnetStatusPollFor(status)):
		}
	}
}

// TailnetCancel 은 진행 중인 연결 시도를 접는다. 시도 자체가 없으면 아무 일도 없다.
func (runtime *Runtime) TailnetCancel(requestID string, payload coretypes.TailnetDisconnectPayload) error {
	if runtime.tailnets == nil {
		return errors.New("tailnet support is not enabled")
	}
	id := strings.TrimSpace(payload.ID)
	if id == "" {
		return errors.New("tailnet id is required")
	}
	if runtime.tailnetTests != nil {
		runtime.tailnetTests.cancel(id)
	}

	// 서버를 닫고 없앤다. 쓰는 곳이 있어도 닫는다.
	//
	// 시도만 접으면 취소가 아니다 — 노드가 그대로 살아 상태와 인증 링크를 계속 보고하므로,
	// 화면은 접은 것을 접지 못한 상태로 그리고 사용자는 "가리기" 를 본다. 없애면 상태 자체가
	// 사라져서 그릴 것이 없다(첫 실행과 같은 상태다).
	//
	// 아직 그 tailnet 이 필요한 소비자는 스스로 다시 요청하고, 그때 새 서버가 만들어져 처음부터
	// 붙는다. 등록·노드 키는 그대로 두므로 컨트롤 플레인에 기기가 새로 생기지 않는다.
	//
	// 다만 붙어서 정상 동작하는 노드는 건드리지 않는다. 취소는 "지금 붙는 중인 것" 을 접는 것이고
	// 살아 있는 세션을 끊는 동작이 아니다.
	if !runtime.tailnetIsHealthy(id) {
		_ = runtime.tailnets.Discard(id)
	}

	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventTailnetStatus,
		RequestID: requestID,
		Payload: coretypes.TailnetStatusPayload{
			ID:    id,
			State: string(tailnet.StateStopped),
		},
	})
	return nil
}

// tailnetCancelHealthCheck 는 취소가 "이 노드는 정상인가" 를 묻고 기다려 주는 한도다.
const tailnetCancelHealthCheck = time.Second

// tailnetIsHealthy 는 짧은 한도 안에 "붙어서 정상" 이라고 답하는지 본다.
//
// 대답을 못 하면 정상이 아니라고 본다. 만료를 처리하는 백엔드는 데이터 플레인을 내리는 동안
// 자기 뮤텍스를 잡고 있어서 상태 조회가 ctx 취소로도 풀리지 않는다 — 여기서 그대로 기다리면
// 취소 명령 자체가 갇혀 다시 "취소가 안 먹는" 상태가 된다.
func (runtime *Runtime) tailnetIsHealthy(id string) bool {
	answered := make(chan bool, 1)
	go func() {
		status, ok := runtime.tailnets.StatusOf(context.Background(), id)
		answered <- ok && status.Connected()
	}()

	select {
	case healthy := <-answered:
		return healthy
	case <-time.After(tailnetCancelHealthCheck):
		return false
	}
}

// stopUnauthenticatedNode 는 아직 붙지 못한 노드를 내린다. 실패는 삼킨다 — 취소는 어떤 경우에도
// 사용자에게 오류로 보이면 안 된다.
func (runtime *Runtime) stopUnauthenticatedNode(id string) {
	status, ok := runtime.tailnets.StatusOf(context.Background(), id)
	if !ok || status.State == tailnet.StateRunning {
		return
	}
	_ = runtime.tailnets.Disconnect(context.Background(), id)
}

// TailnetDisconnect 는 노드를 지금 내린다. 유휴 유예를 기다리지 않을 뿐 결과는 같다 —
// 네트워킹만 끄고 등록은 남으므로, 다시 연결하면 재인증 없이 올라온다.
func (runtime *Runtime) TailnetDisconnect(requestID string, payload coretypes.TailnetDisconnectPayload) error {
	if runtime.tailnets == nil {
		return errors.New("tailnet support is not enabled")
	}
	id := strings.TrimSpace(payload.ID)
	if id == "" {
		return errors.New("tailnet id is required")
	}

	if err := runtime.tailnets.Disconnect(context.Background(), id); err != nil {
		return err
	}

	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventTailnetStatus,
		RequestID: requestID,
		Payload: coretypes.TailnetStatusPayload{
			ID:    id,
			State: string(tailnet.StateStopped),
		},
	})
	return nil
}

// TailnetSnapshot 은 지금 살아 있는 노드들의 상태를 돌려준다. 설정 화면이 "무엇이 연결돼
// 있는가"를 알 수 있는 유일한 수단이다 — 그전에는 이번 세션에서 시험한 결과밖에 없었다.
func (runtime *Runtime) TailnetSnapshot(requestID string) error {
	if runtime.tailnets == nil {
		return errors.New("tailnet support is not enabled")
	}

	statuses := make([]coretypes.TailnetStatusPayload, 0)
	for id, status := range runtime.tailnets.Snapshot(context.Background()) {
		statuses = append(statuses, runtime.tailnetStatusPayloadFor(id, status))
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].ID < statuses[j].ID })

	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventTailnetSnapshot,
		RequestID: requestID,
		Payload: coretypes.TailnetSnapshotPayload{
			Statuses:      statuses,
			LocalNodeName: defaultNodeHostname(),
		},
	})
	return nil
}

// sameTailnetProgress 는 등록 진행 표시에 쓰이는 필드만 비교한다.
func sameTailnetProgress(a, b coretypes.TailnetStatusPayload) bool {
	return a.ID == b.ID &&
		a.State == b.State &&
		a.AuthURL == b.AuthURL &&
		a.Error == b.Error &&
		// Cancelled 를 빼면 취소가 묻힌다 — 노드가 올라오기 전에도 Stopped 가 진행 상태로
		// 나가므로, 시도를 접었다는 마지막 이벤트가 앞의 Stopped 와 같다고 버려진다.
		a.Cancelled == b.Cancelled &&
		// Attempting 이 빠지면 "시도가 끝났다"는 전이가 묻힌다 — 화면이 스피너를 계속 그린다.
		a.Attempting == b.Attempting &&
		// Ready·Online 도 같은 이유다. 준비 여부는 State 와 따로 바뀐다 — running 으로 보고되는
		// 동안 컨트롤 플레인과 동기화되면서 준비됨으로 넘어간다. 그 전이가 곧 시도의 끝인데,
		// 여기서 빼면 앞의 running 과 같다고 버려져서 기다리는 쪽이 영원히 끝을 못 본다.
		a.Ready == b.Ready &&
		a.Online == b.Online &&
		a.LoginName == b.LoginName &&
		a.TailnetName == b.TailnetName &&
		a.NodeName == b.NodeName &&
		a.NodeIP == b.NodeIP
}

// TailnetConfigure 는 이 기기의 tailnet 설정을 코어에 심는다.
//
// 데스크톱이 코어를 띄운 직후와 설정이 바뀔 때마다 부른다. 이것이 있어야 설정 화면에서 미리
// 연결해 두지 않아도 호스트 연결이 노드를 알아서 올린다 — 연결 경로는 tailnetId 만 들고
// 오므로, 코어가 설정을 모르면 노드를 만들 수 없다.
//
// 노드를 올리지는 않는다. 여기서 올리면 앱을 켜는 것만으로 등록된 모든 tailnet 이 붙어
// 디바이스 목록에 online 으로 뜬다. 실제 기동은 첫 dial 이 한다.
func (runtime *Runtime) TailnetConfigure(payload coretypes.TailnetConfigurePayload) error {
	if runtime.tailnets == nil || runtime.tailnetConfigs == nil {
		return errors.New("tailnet support is not enabled")
	}

	// 설정이 바뀐 노드는 버린다 — 노드는 만들어질 때 설정을 받으므로, 살아 있는 노드는 새
	// auth key 나 새 컨트롤 플레인을 알 방법이 없다.
	//
	// 쓰이는 중이면 버릴 수 없다(그 위의 세션이 죽는다). 그때는 다음 기회에 정리된다 —
	// 리스가 다 풀린 뒤의 Configure 나, 유휴 유예가 지난 뒤의 Acquire 가 새 설정으로 만든다.
	var errs []error
	for _, id := range runtime.tailnetConfigs.replaceAll(payload.Configs) {
		if err := runtime.tailnets.Reset(id); err != nil && !errors.Is(err, tailnet.ErrNodeInUse) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// TailnetForget 은 노드 등록을 해제한다 — 컨트롤 플레인에서 노드를 지우고 로컬 상태까지
// 삭제한다. tailnet 설정 자체는 남으므로 다시 연결하면 최초 등록과 같은 흐름을 탄다.
func (runtime *Runtime) TailnetForget(requestID string, payload coretypes.TailnetForgetPayload) error {
	if runtime.tailnets == nil {
		return errors.New("tailnet support is not enabled")
	}
	id := strings.TrimSpace(payload.ID)
	if id == "" {
		return errors.New("tailnet id is required")
	}

	forgetErr := runtime.tailnets.Forget(context.Background(), id)
	runtime.tailnetConfigs.remove(id)

	result := coretypes.TailnetForgotPayload{ID: id}
	if forgetErr != nil {
		result.Error = forgetErr.Error()
	}
	runtime.emitEvent(coretypes.Event{
		Type:      coretypes.EventTailnetForgot,
		RequestID: requestID,
		Payload:   result,
	})
	return forgetErr
}
