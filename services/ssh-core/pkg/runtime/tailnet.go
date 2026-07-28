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
	mu     sync.Mutex
	byID   map[string]context.CancelFunc
	closed bool
}

func newTailnetTests() *tailnetTests {
	return &tailnetTests{byID: make(map[string]context.CancelFunc)}
}

// begin 은 취소 함수를 등록한다. 같은 tailnet 을 다시 시도하면 앞의 것을 접는다.
func (t *tailnetTests) begin(id string, cancel context.CancelFunc) {
	t.mu.Lock()
	previous, ok := t.byID[id]
	t.byID[id] = cancel
	t.mu.Unlock()

	if ok {
		previous()
	}
}

// end 는 자기 자신이 등록돼 있을 때만 지운다. 늦게 끝난 앞 시도가 새 시도를 지우면 안 된다.
func (t *tailnetTests) end(id string, cancel context.CancelFunc) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if current, ok := t.byID[id]; ok && &current == &cancel {
		delete(t.byID, id)
		return
	}
	delete(t.byID, id)
}

// cancel 은 진행 중이면 접고 그 사실을 알려 준다.
func (t *tailnetTests) cancel(id string) bool {
	t.mu.Lock()
	cancel, ok := t.byID[id]
	if ok {
		delete(t.byID, id)
	}
	t.mu.Unlock()

	if ok {
		cancel()
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
}

func newTailnetConfigs(root string) *tailnetConfigs {
	return &tailnetConfigs{root: root, byID: make(map[string]coretypes.TailnetConfigPayload)}
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

	return tailnet.NewNode(tailnet.NodeConfig{
		Hostname:   hostname,
		ControlURL: config.ControlURL,
		AuthKey:    config.AuthKey,
		Ephemeral:  config.Ephemeral,
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

// tailnetStatusPayload 는 노드 상태를 이벤트 페이로드로 옮긴다.
func tailnetStatusPayload(id string, status tailnet.Status) coretypes.TailnetStatusPayload {
	return coretypes.TailnetStatusPayload{
		ID:          id,
		State:       string(status.State),
		AuthURL:     status.AuthURL,
		LoginName:   status.LoginName,
		TailnetName: status.TailnetName,
		NodeName:    status.NodeName,
		NodeIP:      status.NodeIP,
		Peers:       tailnetPeerPayloads(status.Peers),
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
	}

	lease, err := runtime.tailnets.Acquire(id)
	if err != nil {
		return err
	}
	// 테스트는 노드를 붙들지 않는다. 놓아도 유예 동안 살아 있으므로, 곧바로 호스트에
	// 연결하면 이미 올라온 노드를 그대로 쓴다.
	defer lease.Release()

	timeout := tailnetTestTimeout
	if payload.TimeoutMs > 0 {
		timeout = time.Duration(payload.TimeoutMs) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	// 사용자가 중간에 그만둘 수 있어야 한다. 브라우저 로그인은 사람을 기다리는 구간이라
	// 최대 3 분까지 가는데, 접을 방법이 없으면 그때까지 갇힌다.
	if runtime.tailnetTests != nil {
		runtime.tailnetTests.begin(id, cancel)
		defer runtime.tailnetTests.end(id, cancel)
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

	for {
		status, err := lease.Node.Status(ctx)
		if err != nil {
			emit(coretypes.TailnetStatusPayload{ID: id, State: string(tailnet.StateStopped), Error: err.Error()})
			return err
		}

		emit(tailnetStatusPayload(id, status))

		if status.State == tailnet.StateRunning {
			return nil
		}

		select {
		case <-ctx.Done():
			// 사용자가 접은 것이면 실패가 아니다. 마지막 상태만 정리해 보내고 조용히 끝낸다.
			if errors.Is(ctx.Err(), context.Canceled) {
				emit(coretypes.TailnetStatusPayload{
					ID:    id,
					State: string(tailnet.StateStopped),
				})
				return nil
			}
			// 시간이 다 됐다는 것 자체가 결과다. 승인 대기나 미인증 상태로 끝났다면 마지막
			// 상태가 이미 나가 있으므로, 화면은 무엇을 기다리는 중이었는지 보여줄 수 있다.
			timeoutErr := fmt.Errorf("tailnet %q did not come up within %s", id, timeout)
			timedOut := tailnetStatusPayload(id, status)
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
		statuses = append(statuses, tailnetStatusPayload(id, status))
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
