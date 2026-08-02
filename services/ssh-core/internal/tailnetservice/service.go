package tailnetservice

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

// Options configures the shared Tailnet orchestration service. The service owns
// node state, connection attempts, recovery, and status event delivery so the
// desktop runtime and mobile bindings can reuse the same lifecycle rules.
type Options struct {
	StateDir        string
	EmitEvent       func(coretypes.Event)
	RegistryOptions tailnet.Options
}

// Service owns all Tailnet orchestration state for one application runtime.
type Service struct {
	emitEvent      func(coretypes.Event)
	tailnets       *tailnet.Registry
	tailnetConfigs *tailnetConfigs
	tailnetTests   *tailnetTests

	tailnetRecoveryMu         sync.Mutex
	tailnetRecoveryPending    map[string]bool
	tailnetDegradedMu         sync.Mutex
	tailnetDegraded           map[string]bool
	tailnetReplacementMu      sync.Mutex
	tailnetReplacementPending map[string]uint64
}

func New(options Options) *Service {
	emitEvent := options.EmitEvent
	if emitEvent == nil {
		emitEvent = func(coretypes.Event) {}
	}

	service := &Service{emitEvent: emitEvent}
	service.tailnetConfigs = newTailnetConfigs(options.StateDir)
	service.tailnetTests = newTailnetTests()
	service.tailnets = tailnet.NewRegistry(
		service.tailnetConfigs.newNode,
		options.RegistryOptions,
	)
	service.tailnetConfigs.notify = service.onTailnetNotify
	return service
}

// Close stops Tailnet nodes without logging them out, preserving their local
// identity for the next application launch.
func (service *Service) Close() error {
	if service == nil || service.tailnets == nil {
		return nil
	}
	return service.tailnets.Close()
}

func (service *Service) shutdownTailnets() {
	_ = service.Close()
}

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

const tailnetIdentityProbeTimeout = 5 * time.Second

// probeTailnetIdentity performs a best-effort control-plane identity check.
// Failure to reach control is deliberately ignored: only the node's structured
// IdentityInvalid status is allowed to trigger replacement.
func probeTailnetIdentity(ctx context.Context, node tailnet.Node) {
	prober, ok := node.(tailnet.IdentityProber)
	if !ok {
		return
	}
	probeCtx, cancel := context.WithTimeout(ctx, tailnetIdentityProbeTimeout)
	defer cancel()
	_ = prober.ProbeIdentity(probeCtx)
}

// tailnetAuthURLGrace 는 인증 링크를 기다려 주는 시간이다.
//
// 실측에서 정상 링크는 15 표본 중 13 개가 1.9~8.0 초에 왔고, 꼬리로 15.7 초와 25 초 초과가
// 각각 하나 있었다(이전 계측 최대 49.8 초). 어디서 끊어도 정답이 아니다 — 시간은 "이 노드로는
// 링크가 나올 수 없다"를 모르기 때문에 대신 세는 대리 지표다.
//
// 확정 신호가 있는 경우는 이 유예를 쓰지 않는다 — 로그인이 거부되면 백엔드가 알려 주므로
// (Status.LoginError) 기다리지 않고 끝낸다. 삭제된 identity 도 구조화된 control 오류로 즉시
// 구분한다. 유예는 그런 신호 없이 링크가 오지 않는 백엔드 정체의 마지막 수단이다.
var tailnetAuthURLGrace = 25 * time.Second

// tailnetSyncGrace 는 컨트롤 플레인 동기화(map poll)가 돌아오기를 기다려 주는 시간이다.
//
// 이 구간에 사람 로그인 예산(tailnetTestTimeout)을 쓰면 안 된다. 여기에는 사람이 할 일이 없고
// 코어도 아무 조치를 하지 않기로 되어 있어서(authLinkWanted 참조), 그 예산을 쓰면 **확정적으로**
// 3분을 태운 뒤 실패한다 — 그동안 상태가 하나도 바뀌지 않아 중복 제거가 이벤트를 다 버리고,
// 화면은 한 글자도 움직이지 않는다(실측에서 사용자는 멈춘 것으로 보고 취소했다).
//
// 8 초인 이유: 살아 있는 poll 의 keep-alive·재접속은 초 단위다. 재시도 백오프 상한(30초)까지
// 기다려도 얻는 것은 dial 을 그만큼 늦추는 것뿐이다.
//
// 유예가 지나면 **통과시킨다.** Online 은 컨트롤 플레인 map poll 이 열려 있는지일 뿐이고 데이터
// 플레인은 이미 받아 둔 넷맵으로 계속 통한다(assertTailnetNotBlocked 의 근거 참조). 진짜 답은
// dial 만 알고 있으므로, 더 기다리는 대신 시도하게 하고 동기화가 끊긴 사실은 상태로 내보낸다.
var tailnetSyncGrace = 8 * time.Second

// rebuildNode 는 노드를 닫고 새로 만든다. 새 노드를 받으면 true 다.
//
// 코어 안에서 노드를 다시 세우는 유일한 수단이다 — 요청 페이로드로 "강도"를 받지 않는다.
//
// 리스를 들고 있으면 노드를 버릴 수 없으므로 우리 리스를 먼저 놓는다. 그래도 남아 있으면
// (세션·SFTP·포워딩이 이 tailnet 을 쓰는 중이면) Reset 이 거절하는데, **그 거절이 세션을
// 지킨다**: 서버를 교체하면 netstack 이 사라져서, 만료 후 재인증으로 이어질 수 있었던 연결이
// 끊긴다. 그때는 원래 리스를 그대로 다시 잡고 false 를 돌려준다.
func (runtime *Service) rebuildNode(id string, lease **tailnet.Lease) (bool, error) {
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

// replaceInvalidIdentity 는 컨트롤 플레인이 삭제했다고 확정한 identity 를 버리고 새 노드를
// 올린다. 일반적인 offline 에서는 절대 호출하지 않는다.
func (runtime *Service) replaceInvalidIdentity(
	ctx context.Context,
	id string,
	lease **tailnet.Lease,
) (bool, error) {
	// Generation zero supports embedders/tests that provide a registry factory
	// directly without the configuration store. Production configurations
	// always receive a positive generation.
	generation, _ := runtime.tailnetConfigs.generation(id)
	if !runtime.claimTailnetIdentityReplacement(id, generation) {
		return false, fmt.Errorf(
			"%w: tailnet %q already replaced its identity for this configuration",
			ErrTailnetIdentityInvalid,
			id,
		)
	}

	invalid := *lease
	invalid.Release()
	replaced, err := runtime.tailnets.ReplaceInvalidIdentity(id, invalid)
	if err != nil {
		return false, err
	}

	fresh, err := runtime.tailnets.Acquire(id)
	if err != nil {
		return false, err
	}
	*lease = fresh
	runtime.forgetTailnetDegraded(id)
	return replaced, fresh.Node.Up(ctx)
}

// claimTailnetIdentityReplacement gives one configuration generation a single
// replacement budget. Failed attempts remain claimed until the replacement is
// authorized or the configuration changes, preventing retry-driven node churn.
func (runtime *Service) claimTailnetIdentityReplacement(id string, generation uint64) bool {
	runtime.tailnetReplacementMu.Lock()
	defer runtime.tailnetReplacementMu.Unlock()
	if runtime.tailnetReplacementPending == nil {
		runtime.tailnetReplacementPending = make(map[string]uint64)
	}
	if pendingGeneration, exists := runtime.tailnetReplacementPending[id]; exists && pendingGeneration == generation {
		return false
	}
	runtime.tailnetReplacementPending[id] = generation
	return true
}

func (runtime *Service) clearTailnetIdentityReplacement(id string, generation uint64) {
	runtime.tailnetReplacementMu.Lock()
	if runtime.tailnetReplacementPending[id] == generation {
		delete(runtime.tailnetReplacementPending, id)
	}
	runtime.tailnetReplacementMu.Unlock()
}

func (runtime *Service) clearTailnetIdentityReplacementForID(id string) {
	runtime.tailnetReplacementMu.Lock()
	delete(runtime.tailnetReplacementPending, id)
	runtime.tailnetReplacementMu.Unlock()
}

func (runtime *Service) markTailnetIdentityAuthorized(id string, status tailnet.Status) {
	if !status.Authorized() {
		return
	}
	generation, _ := runtime.tailnetConfigs.generation(id)
	runtime.clearTailnetIdentityReplacement(id, generation)
}

// identityKeeper 는 한 연결 시도 안에서 무효 identity 를 정확히 한 번만 교체한다.
// 새 identity 도 같은 오류를 내면 반복해서 컨트롤 플레인에 노드를 만들지 않고 실패시킨다.
type identityKeeper struct {
	runtime       *Service
	id            string
	replacements  int
	attemptedOnce bool
}

func (k *identityKeeper) decorate(payload *coretypes.TailnetStatusPayload) {
	payload.ReRegistrations = k.replacements
}

func (k *identityKeeper) ensure(
	ctx context.Context,
	status tailnet.Status,
	lease **tailnet.Lease,
) (bool, error) {
	if !status.IdentityInvalid {
		return false, nil
	}
	if k.attemptedOnce {
		return false, fmt.Errorf("tailnet %q replacement identity was also rejected", k.id)
	}
	k.attemptedOnce = true
	replaced, err := k.runtime.replaceInvalidIdentity(ctx, k.id, lease)
	if err != nil {
		return false, fmt.Errorf("tailnet %q re-register: %w", k.id, err)
	}
	if replaced {
		k.replacements += 1
	}
	return true, nil
}

// authLinkKeeper 는 인증이 필요한 흐름에서 **인증 링크를 확보하는 책임**이다.
//
// 링크 확보가 Go 의 일이라는 것이 이 타입의 존재 이유다. 인증이 있는 흐름은 여기 들어오지
// 않는다 — 그쪽은 올려서 판정만 하면 되고, 링크라는 개념이 등장하지 않는다.
//
// 하는 일은 두 가지뿐이다.
//
//   - 만료가 드러나면 재인증을 개시한다(노드당 한 번). 이미 떠 있는 노드는 WantRunning 을 다시
//     켜는 것으로 로그인이 시작되지 않아서, 개시해 주지 않으면 백엔드가 자기 백오프 일정으로
//     재로그인할 때까지(수 분) 링크가 나오지 않는다.
//   - 링크가 오지 않는 채로 유예가 지나면 tsnet 서버만 다시 세운다. 등록 상태는 유지하므로
//     이것은 재등록이 아니다. 삭제된 identity 는 identityKeeper 가 별도로 처리한다.
//
// 한 번 거절되면 포기하지 않는다. 거절은 이 tailnet 을 쓰던 것이 아직 정리되지 않았다는 뜻이고,
// 그것이 닫히면 다음 주기에 성공한다. 링크 확보를 여기서 책임지므로 스스로 손을 놓지 않는다.
type authLinkKeeper struct {
	runtime *Service
	id      string

	// waitingSince 는 링크 없이 기다리기 시작한 시각이다. 링크가 오거나 흐름이 바뀌면 지운다.
	waitingSince    time.Time
	reauthRequested bool
	restarts        int
	refused         bool
}

// authLinkWanted 는 이 상태가 링크 확보 대상인지다.
//
// 판정을 새로 만들지 않고 BlockedReason 을 쓴다 — "왜 나갈 수 없는가" 는 이미 한 곳에서 가린다.
//
//   - needsAuth: 링크를 기다리는 중이다
//   - expired: 만료가 드러났다. 낡은 넷맵 때문에 running 으로 보고되는 경우도 여기 들어온다
//
// needsApproval 은 뺀다. 관리자가 승인해야 하는 일이라 우리가 개시할 것이 없다.
//
// offline(running 이라고 보고하지만 컨트롤 플레인과 끊긴 상태)도 뺀다. 네트워크가 끊긴 경우는
// 가만히 두면 클라이언트가 스스로 poll 을 회복한다. 노드 삭제는 별도의 IdentityInvalid 로 오므로
// 여기서 offline 을 추측해 재등록할 필요가 없다.
func authLinkWanted(status tailnet.Status) bool {
	switch status.BlockedReason() {
	case tailnet.BlockNeedsAuth, tailnet.BlockExpired:
		return true
	default:
		return false
	}
}

// decorate 는 지금까지의 확보 시도를 상태에 실는다.
//
// 코어가 한 일은 전부 상태로 나가야 한다. 그러지 않으면 노드를 새로 세워도 화면에서는 아무 일도
// 없는 것과 구분되지 않는다 — 실제로 그랬다(닫는 데 0.0 초, 전후 상태가 동일해서 중복 제거가
// 이벤트를 버렸다).
func (k *authLinkKeeper) decorate(payload *coretypes.TailnetStatusPayload) {
	payload.Restarts = k.restarts
	payload.RestartRefused = k.refused
}

// startReauth 는 대화형 로그인을 개시한다. 시도당 한 번만 부른다.
//
// 별도 goroutine 으로 보내는 이유는 취소다. 이 호출도 백엔드 뮤텍스를 기다릴 수 있어서 여기서
// 기다리면 취소가 묻힌다. 결과는 상태 폴링으로 확인한다.
func (k *authLinkKeeper) startReauth(ctx context.Context, lease **tailnet.Lease) {
	k.reauthRequested = true
	node := (*lease).Node
	go func() { _ = node.Reauth(ctx) }()
}

// ensure 는 링크를 확보하려고 이번 주기에 할 일을 한다. 노드를 다시 세웠으면 true 다.
func (k *authLinkKeeper) ensure(
	ctx context.Context,
	status tailnet.Status,
	lease **tailnet.Lease,
	now time.Time,
) (bool, error) {
	// 로그인이 거부됐으면 기다릴 것도, 다시 세울 것도 없다.
	//
	// 진입 조건보다 먼저 본다 — 이 판정은 "무엇을 기다리는 중인가" 와 무관하게 끝을 내는 것이다.
	//
	// 잘못된 auth key 가 이 경우다 — 상태는 링크를 기다리는 것과 똑같지만 링크는 영원히 오지
	// 않고, 노드를 새로 만들어도 같은 키를 다시 쓴다. 사람이 설정을 고쳐야 하는 일이므로 그
	// 이유를 그대로 들고 끝낸다. 실측에서 이 신호는 2~3 초 안에 오고, 정상 대기 중에는 오지 않는다.
	if status.LoginError != "" {
		return false, fmt.Errorf("%w: %s", ErrTailnetLoginRejected, status.LoginError)
	}

	if !authLinkWanted(status) {
		k.waitingSince = time.Time{}
		return false, nil
	}

	if status.Expired && !k.reauthRequested {
		k.startReauth(ctx, lease)
	}

	// 링크가 있으면 사람을 기다리는 구간이다. 여기서 노드를 다시 세우면 사용자가 브라우저에서
	// 쓰던 링크가 죽고 브라우저가 두 번 뜬다.
	if status.AuthURL != "" {
		k.waitingSince = time.Time{}
		return false, nil
	}

	if k.waitingSince.IsZero() {
		k.waitingSince = now
		return false, nil
	}
	if now.Sub(k.waitingSince) <= tailnetAuthURLGrace {
		return false, nil
	}

	// 성공이든 거절이든 다음 유예를 새로 센다. 거절이 기회를 태우지 않는다.
	k.waitingSince = now

	fresh, err := k.runtime.rebuildNode(k.id, lease)
	if err != nil {
		return false, err
	}
	if !fresh {
		k.refused = true
		return false, nil
	}

	k.refused = false
	k.restarts += 1
	// 새 노드다. 재인증 개시 표시는 노드에 딸린 것이므로 함께 지운다.
	k.reauthRequested = false
	if err := (*lease).Node.Up(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// syncGate 는 관문이 언제 다음 단계로 넘길지 정한다.
//
// 판정을 새로 만들지 않는다 — "확실히 연결됐나"(Connected)와 "왜 못 나가나"(BlockedReason)는 이미
// 코어 한 곳에 있다. 여기서 더하는 것은 **시간** 하나다: 동기화가 끊긴 구간을 얼마나 기다릴지.
type syncGate struct {
	// stalledSince 는 동기화가 끊긴 것을 처음 본 시각이다. 회복되거나 다른 이유로 막히면 지운다.
	stalledSince time.Time
}

// decide 는 이번 주기에 관문을 열지, 열더라도 동기화가 끊긴 채인지 답한다.
func (g *syncGate) decide(status tailnet.Status, now time.Time) (pass bool, degraded bool) {
	if status.Connected() {
		g.stalledSince = time.Time{}
		return true, false
	}
	// 동기화 말고 다른 이유로 막힌 것이면 여기서 시간을 세지 않는다 — 인증·승인·만료·거부는 각자의
	// 흐름이 있고(authLinkKeeper), 그쪽은 사람이나 컨트롤 플레인을 기다리는 구간이다.
	if status.BlockedReason() != tailnet.BlockOffline {
		g.stalledSince = time.Time{}
		return false, false
	}
	if g.stalledSince.IsZero() {
		g.stalledSince = now
		return false, false
	}
	if now.Sub(g.stalledSince) <= tailnetSyncGrace {
		return false, false
	}
	return true, true
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
func (runtime *Service) onTailnetNotify(id string) {
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

		runtime.recoverTailnetIfNeeded(id)
	}()
}

// awaitTailnetAttempt 는 먼저 시작된 시도의 결과를 기다려 자기 요청의 결말을 낸다.
//
// 노드를 다시 올리거나 만들지 않는다 — 그 일은 선행 시도가 하고 있다. 결과만 자기 requestID 로
// 한 번 보고해서, 기다리는 쪽(데스크톱)이 끝을 볼 수 있게 한다. 선행 시도가 보내는 진행 상황은
// 브로드캐스트로 이미 화면에 닿으므로 여기서 중복해 흘리지 않는다.
func (runtime *Service) awaitTailnetAttempt(
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

	// 결말은 선행 시도가 정한 것을 따른다. 여기서 상태를 다시 판정하면 어긋난다 — 동기화가 끊긴
	// 채로 통과한 결정은 Connected 로는 보이지 않아서, 통과한 시도를 실패로 보고하게 된다.
	// (그 결정 자체는 페이로드가 코어의 표시에서 채운다.)
	result := runtime.tailnetStatusPayloadFor(id, status)
	if !attempt.passed && !status.Connected() {
		// 붙지 못한 채 끝났다. 이유를 담아 끝을 알린다 — 담지 않으면 기다리는 쪽이 한도까지 매달린다.
		result.Error = fmt.Sprintf("tailnet %q did not come up", id)
	}
	emit(result)
	if result.Error != "" {
		return errors.New(result.Error)
	}
	return nil
}

// recoverTailnetIfNeeded 는 만료되거나 identity 가 삭제된 노드의 복구를 시작한다.
//
// 실제 소비자가 있으면 만료는 재인증하고, IdentityInvalid 는 로컬 등록 상태를 버린 뒤 새
// identity 로 등록한다. 유휴 노드의 IdentityInvalid 는 로컬 상태까지만 버리고, 다음 실제 사용이
// 새 등록을 시작하게 한다. 단순 offline 은 어느 쪽에도 포함하지 않는다.
//
// 아직 올라오는 중(starting)이나 인증 대기(needsAuth)도 보지 않는다 — 그것은 "붙지 못한" 상태이고
// 그 처리는 진행 중인 시도 안에서 한다.
//
// 복구 수단은 평소 연결과 같은 것이다 — 시도를 하나 태우면 그 안의 링크 확보(authLinkKeeper)가
// 재인증을 개시하고, 필요하면 노드를 다시 세운다. 복구 전용 메커니즘을 따로 만들지 않는다.
//
// 세션(터미널·SFTP·포워딩)이 복구를 맡으면 같은 노드를 두고 여러 곳이 각자 복구를 시도해 인증
// 링크가 서로를 무효화한다. 그래서 코어 한 곳에서만 한다.
func (runtime *Service) recoverTailnetIfNeeded(id string) {
	// 취소는 억제 표시를 남기지 않는다. 취소가 노드를 없애므로 여기서 볼 것이 사라지고
	// (StatusOf 가 !ok), 다시 쓰려는 소비자가 요청하면 그때 새 노드로 시작한다.
	//
	// 아무도 쓰지 않는 tailnet 은 지금 새 등록이나 재인증을 시작하지 않는다.
	//
	// 만료는 그대로 두고 다음 소비자가 생길 때 재인증한다. 삭제된 identity 는 다시 쓸 수 없으므로
	// Close + Purge 하되, 여기서 새 노드를 만들지는 않는다. 그러면 컨트롤 플레인에는 실제 사용이
	// 시작될 때만 새 registration 이 생긴다.
	status, ok := runtime.tailnets.StatusOf(context.Background(), id)
	if !ok || (!status.Expired && !status.IdentityInvalid) {
		return
	}
	if runtime.tailnets.Leases(id) == 0 {
		if status.IdentityInvalid {
			discarded, err := runtime.tailnets.DiscardInvalidIdentityIfIdle(context.Background(), id)
			if discarded {
				runtime.forgetTailnetDegraded(id)
				payload := coretypes.TailnetStatusPayload{
					ID:    id,
					State: string(tailnet.StateStopped),
				}
				if err != nil {
					payload.Error = err.Error()
				}
				runtime.emitEvent(coretypes.Event{
					Type:    coretypes.EventTailnetStatus,
					Payload: payload,
				})
			}
		}
		return
	}
	// 진행 중인 시도가 있으면 건드리지 않는다. 끼어들면 그 시도가 취소되고, 사용자가
	// 브라우저에서 쓰던 링크가 무효화된다.
	if runtime.tailnetTests != nil && runtime.tailnetTests.active(id) {
		return
	}
	// 설정이 없는 tailnet 은 노드를 만들 수 없다. 복구할 것도 없다.
	if _, ok := runtime.tailnetConfigs.get(id); !ok {
		return
	}

	// requestID 가 비어 있으면 상태가 브로드캐스트로 나간다 — 설정 화면과 연결 화면이 모두
	// 그것을 보고, 인증 링크는 메인 프로세스가 열어 준다.
	//
	// 요청 입구(TailnetTest)를 되부르지 않는다. 되부르면 requestID 없는 가짜 페이로드를 만들어야
	// 하고, 복구 정책이 요청 필드를 타고 흐르게 된다.
	_ = runtime.runTailnetAttempt("", id, tailnetTestTimeout)
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
	// passed·degraded 는 이 시도의 결말이다. 합류한 요청이 자기 결말을 낼 때 쓴다.
	//
	// 상태를 다시 읽는 것으로는 부족하다 — 관문이 동기화가 끊긴 채로 통과시켰다면 그 결정은
	// 상태에 남지 않아서, 합류한 쪽이 같은 상태를 보고 실패로 보고한다. 결정을 시도에 남긴다.
	//
	// 락이 없어도 되는 이유: 쓰는 것은 시도를 만든 goroutine 이고 done 이 닫히기 **전**이며,
	// 읽는 것은 done 이 닫힌 **뒤**다. 채널 닫힘이 그 순서를 보장한다.
	passed   bool
	degraded bool
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
// 앞의 것을 접고 새로 시작하는 통로는 두지 않는다. 사용자가 처음부터 다시 하려면 취소를 거치고,
// 취소는 시도와 노드를 함께 없애므로 다음 요청이 자연히 새 노드로 시작한다.
func (t *tailnetTests) begin(
	id string,
	cancel context.CancelFunc,
) (attempt *tailnetAttempt, joined bool) {
	t.mu.Lock()
	if previous := t.byID[id]; previous != nil {
		t.mu.Unlock()
		return previous, true
	}
	next := &tailnetAttempt{cancel: cancel, done: make(chan struct{})}
	t.byID[id] = next
	t.mu.Unlock()

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
	mu             sync.Mutex
	root           string
	byID           map[string]coretypes.TailnetConfigPayload
	generations    map[string]uint64
	nextGeneration uint64
	// notify 는 노드가 백엔드 알림을 받았을 때 코어에 알리는 통로다. 노드를 만들 때 심는다.
	notify func(id string)
}

func newTailnetConfigs(root string) *tailnetConfigs {
	return &tailnetConfigs{
		root:        root,
		byID:        make(map[string]coretypes.TailnetConfigPayload),
		generations: make(map[string]uint64),
	}
}

// get 은 저장된 설정을 돌려준다. 감독자가 복구를 시작할 때 쓴다 — 복구는 요청 페이로드 없이
// 코어가 스스로 하는 것이므로 설정을 여기서 읽어야 한다.
func (c *tailnetConfigs) get(id string) (coretypes.TailnetConfigPayload, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	config, ok := c.byID[id]
	return config, ok
}

func (c *tailnetConfigs) generation(id string) (uint64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	generation, ok := c.generations[id]
	return generation, ok
}

func (c *tailnetConfigs) advanceGenerationLocked(id string) {
	c.nextGeneration++
	c.generations[id] = c.nextGeneration
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
	if !existed || previous != config {
		c.advanceGenerationLocked(config.ID)
	}
	return existed && previous != config
}

type tailnetConfigChanges struct {
	Changed []string
	Removed []string
}

// replaceAll 은 설정 전체를 갈아 끼우고, 노드를 다시 만들어야 하는 id 들을 알려준다.
//
// 목록에 없던 id 는 지운다. 그렇게 해야 코어의 상태가 데스크톱과 같아진다 — 삭제를 따로
// 통보받지 않아도 되고, 지워진 tailnet 의 auth key 를 코어가 계속 들고 있지도 않는다.
func (c *tailnetConfigs) replaceAll(configs []coretypes.TailnetConfigPayload) tailnetConfigChanges {
	c.mu.Lock()
	defer c.mu.Unlock()

	var changes tailnetConfigChanges
	next := make(map[string]coretypes.TailnetConfigPayload, len(configs))
	for _, config := range configs {
		id := strings.TrimSpace(config.ID)
		if id == "" {
			continue
		}
		config.ID = id
		next[id] = config
		previous, existed := c.byID[id]
		if !existed || previous != config {
			c.advanceGenerationLocked(id)
		}
		if existed && previous != config {
			changes.Changed = append(changes.Changed, id)
		}
	}
	// 사라진 설정도 노드를 버려야 한다. 남겨 두면 지워진 tailnet 으로 계속 붙는다.
	for id := range c.byID {
		if _, kept := next[id]; !kept {
			changes.Removed = append(changes.Removed, id)
			delete(c.generations, id)
		}
	}

	c.byID = next
	return changes
}

func (c *tailnetConfigs) remove(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.byID, id)
	delete(c.generations, id)
}

func (c *tailnetConfigs) purgeState(id string) error {
	c.mu.Lock()
	root := strings.TrimSpace(c.root)
	c.mu.Unlock()
	if root == "" {
		return nil
	}
	return os.RemoveAll(filepath.Join(root, sanitizeTailnetDir(id)))
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
func (runtime *Service) tailnetStatusPayloadFor(
	id string,
	status tailnet.Status,
) coretypes.TailnetStatusPayload {
	payload := tailnetStatusPayload(id, status)
	if runtime.tailnetTests != nil {
		payload.Attempting = runtime.tailnetTests.active(id)
	}
	// 동기화 없이 진행하기로 한 결정. 모든 페이로드가 이 한 곳을 지나므로, 진행 이벤트와 스냅샷이
	// 어긋나지 않는다 — 어긋나면 1 초마다 오는 스냅샷이 그 결정을 지워 화면이 되돌아간다.
	payload.Degraded = runtime.tailnetDegradedFor(id, status)
	return payload
}

// markTailnetDegraded 는 동기화가 끊긴 채로 통과시켰다는 결정을 남긴다.
func (runtime *Service) markTailnetDegraded(id string) {
	runtime.tailnetDegradedMu.Lock()
	defer runtime.tailnetDegradedMu.Unlock()
	if runtime.tailnetDegraded == nil {
		runtime.tailnetDegraded = make(map[string]bool)
	}
	runtime.tailnetDegraded[id] = true
}

// forgetTailnetDegraded 는 등록을 버린 tailnet 의 결정을 지운다.
func (runtime *Service) forgetTailnetDegraded(id string) {
	runtime.tailnetDegradedMu.Lock()
	defer runtime.tailnetDegradedMu.Unlock()
	delete(runtime.tailnetDegraded, id)
}

// tailnetDegradedFor 는 그 결정이 아직 유효한지 답하고, 아니면 지운다.
//
// 지우는 조건이 두 개다. 동기화가 돌아왔으면 그냥 연결된 것이고(Ready), 인가가 풀렸으면
// (만료·재인증·노드 교체) 그 결정은 다른 노드에 대한 것이 된다 — 남겨 두면 아직 올라오지도 않은
// 노드를 두고 화면이 다음 단계로 넘어간다.
func (runtime *Service) tailnetDegradedFor(id string, status tailnet.Status) bool {
	runtime.tailnetDegradedMu.Lock()
	defer runtime.tailnetDegradedMu.Unlock()
	if !runtime.tailnetDegraded[id] {
		return false
	}
	if status.Online || !status.Authorized() {
		delete(runtime.tailnetDegraded, id)
		return false
	}
	return true
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
		Expired:     status.Expired,
		Ready:       status.Connected(),
		// 등록·로그인이 끝났는지는 동기화와 다른 질문이다. 이것이 없으면 화면이 Ready 하나로 두
		// 단계를 판정해서, 동기화만 끊긴 상태에서 이미 끝난 단계가 미완료로 되돌아간다.
		Authorized:      status.Authorized(),
		IdentityInvalid: status.IdentityInvalid,
		Online:          status.Online,
		Health:          status.Health,
		BackendState:    status.BackendState,
		KeyExpiry:       status.KeyExpiry,
		// 로그인이 거부된 이유. 화면은 이것이 있으면 "링크를 받는 중" 이 아니라 그 실패를 그린다.
		LoginError: status.LoginError,
		// 백엔드가 마지막으로 보고한 오류. 무엇을 보고 그렇게 판단했는지 화면에서 확인할 수 있어야 한다.
		BackendError: status.BackendError,
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
func (runtime *Service) TailnetTest(requestID string, payload coretypes.TailnetTestPayload) error {
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
		runtime.clearTailnetIdentityReplacementForID(id)
		if _, err := runtime.tailnets.Retire(id, tailnet.RetireForReset); err != nil {
			return err
		}
	}

	timeout := tailnetTestTimeout
	if payload.TimeoutMs > 0 {
		timeout = time.Duration(payload.TimeoutMs) * time.Millisecond
	}
	return runtime.runTailnetAttempt(requestID, id, timeout)
}

// runTailnetAttempt 는 노드를 올려 붙을 때까지 기다리고, 그 과정을 상태로 흘린다.
//
// 요청 입구(TailnetTest)와 코어 내부의 복구가 **같은 이 함수**를 부른다. 복구가 요청 입구를
// 되부르면 requestID 없는 가짜 요청을 만들어야 하고, "처음부터 다시" 같은 정책이 페이로드를 타고
// 흐르게 된다 — 실제로 그렇게 돼 있었다.
func (runtime *Service) runTailnetAttempt(requestID string, id string, timeout time.Duration) error {
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

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	// 사용자가 중간에 그만둘 수 있어야 한다. 브라우저 로그인은 사람을 기다리는 구간이라
	// 최대 3 분까지 가는데, 접을 방법이 없으면 그때까지 갇힌다.
	// 이미 이 tailnet 을 올리는 중이면 그 시도에 합류한다. 각자 시도를 만들면 서로를 취소하고,
	// 그 과정에서 노드가 닫히거나 재생성돼 브라우저에서 쓰던 인증 링크가 죽는다.
	// attempt 는 이 시도의 신원이다. 결말(passed·degraded)을 여기에 남겨야 합류한 요청이 같은
	// 결말을 낼 수 있다.
	var attempt *tailnetAttempt
	if runtime.tailnetTests != nil {
		existing, joined := runtime.tailnetTests.begin(id, cancel)
		if joined {
			return runtime.awaitTailnetAttempt(ctx, requestID, id, existing)
		}
		attempt = existing
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
	probeTailnetIdentity(ctx, lease.Node)

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

	// 인증이 필요한 흐름에서 링크를 확보하는 책임. 인증이 있는 흐름은 여기 들어오지 않는다.
	keeper := &authLinkKeeper{runtime: runtime, id: id}
	// 컨트롤 플레인이 삭제했다고 확정한 identity 만 교체한다. SSH dial 결과나 Online 은 보지 않는다.
	identity := &identityKeeper{runtime: runtime, id: id}
	// 언제 다음 단계로 넘길지. 동기화가 끊긴 구간에 예산을 얼마나 쓸지가 이 안에 있다.
	gate := &syncGate{}

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

		runtime.markTailnetIdentityAuthorized(id, status)
		progress := runtime.tailnetStatusPayloadFor(id, status)
		keeper.decorate(&progress)
		identity.decorate(&progress)
		emit(progress)

		replaced, replaceErr := identity.ensure(ctx, status, &lease)
		if replaceErr != nil {
			if errors.Is(replaceErr, context.Canceled) {
				cancelled = true
				emit(coretypes.TailnetStatusPayload{
					ID:        id,
					State:     string(tailnet.StateStopped),
					Cancelled: true,
				})
				return nil
			}
			failed := runtime.tailnetStatusPayloadFor(id, status)
			keeper.decorate(&failed)
			identity.decorate(&failed)
			failed.Error = replaceErr.Error()
			emit(failed)
			return replaceErr
		}
		if replaced {
			continue
		}

		// 링크 확보. 인증이 필요한 흐름이 아니면 아무 일도 하지 않는다.
		rebuilt, keepErr := keeper.ensure(ctx, status, &lease, time.Now())
		if keepErr != nil {
			// 취소는 실패가 아니다. 노드를 세우는 중에 접히면 여기로 온다.
			if errors.Is(keepErr, context.Canceled) {
				cancelled = true
				emit(coretypes.TailnetStatusPayload{
					ID:        id,
					State:     string(tailnet.StateStopped),
					Cancelled: true,
				})
				return nil
			}
			emit(coretypes.TailnetStatusPayload{
				ID:    id,
				State: string(tailnet.StateStopped),
				Error: keepErr.Error(),
			})
			return keepErr
		}
		// 새 노드를 세웠으면 기다리지 않고 곧바로 그 상태를 읽어 내보낸다.
		if rebuilt {
			continue
		}

		// 관문은 판정 한 곳만 본다. running 이나 만료 여부를 여기서 다시 조합하지 않는다 —
		// 그러면 기준이 갈리고, 반쪽 기준이 낡은 상태를 통과시킨다.
		if pass, degraded := gate.decide(status, time.Now()); pass {
			if degraded {
				// 동기화가 끊긴 채로 넘긴다는 결정을 남기고 그대로 내보낸다. 기다리는 쪽은 Ready 가
				// 아니어도 이 값으로 끝을 알고(없으면 한도까지 매달린다), 화면은 동기화 단계를
				// 경고로 그린다. 남겨 두는 것이 핵심이다 — 시도가 끝난 뒤에도 스냅샷이 같은 말을
				// 해야 화면이 되돌아가지 않는다.
				runtime.markTailnetDegraded(id)
				passed := runtime.tailnetStatusPayloadFor(id, status)
				keeper.decorate(&passed)
				identity.decorate(&passed)
				emit(passed)
			}
			if attempt != nil {
				attempt.passed = true
				attempt.degraded = degraded
			}
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
			keeper.decorate(&timedOut)
			identity.decorate(&timedOut)
			timedOut.Error = timeoutErr.Error()
			emit(timedOut)
			return timeoutErr
		case <-time.After(tailnetStatusPollFor(status)):
		}
	}
}

// TailnetCancel 은 진행 중인 연결 시도를 접는다. 시도 자체가 없으면 아무 일도 없다.
func (runtime *Service) TailnetCancel(requestID string, payload coretypes.TailnetDisconnectPayload) error {
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
func (runtime *Service) tailnetIsHealthy(id string) bool {
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
func (runtime *Service) stopUnauthenticatedNode(id string) {
	status, ok := runtime.tailnets.StatusOf(context.Background(), id)
	if !ok || status.State == tailnet.StateRunning {
		return
	}
	_ = runtime.tailnets.Disconnect(context.Background(), id)
}

// TailnetDisconnect 는 노드를 지금 내린다. 유휴 유예를 기다리지 않을 뿐 결과는 같다 —
// 네트워킹만 끄고 등록은 남으므로, 다시 연결하면 재인증 없이 올라온다.
func (runtime *Service) TailnetDisconnect(requestID string, payload coretypes.TailnetDisconnectPayload) error {
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
func (runtime *Service) TailnetSnapshot(requestID string) error {
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
		// Authorized 와 Degraded 도 같은 이유다. 등록·로그인이 끝나는 전이와, 동기화가 끊긴 채로
		// 넘긴다는 결정이 여기서 빠지면 묻힌다 — 후자는 기다리는 쪽이 끝을 아는 유일한 신호다.
		// (Authorized 는 State·Expired 에서 나오므로, 비교에서 빠져 있던 Expired 도 함께 메운다.)
		a.Authorized == b.Authorized &&
		a.IdentityInvalid == b.IdentityInvalid &&
		a.Degraded == b.Degraded &&
		// 노드를 다시 세운 것도 여기서 빠지면 묻힌다. 재시작 전후의 상태는 동일하기 때문에
		// (needsAuth·링크 없음) 이 값이 유일한 차이다 — 실제로 그래서 성공한 재시작이 "아무 일도
		// 없음" 과 구분되지 않았다.
		a.Restarts == b.Restarts &&
		a.ReRegistrations == b.ReRegistrations &&
		a.RestartRefused == b.RestartRefused &&
		// 백엔드 오류도 비교에 넣는다. 빼면 "거부됐다" 는 전이가 묻혀서 화면이 이유를 못 받는다.
		a.BackendError == b.BackendError &&
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
func (runtime *Service) TailnetConfigure(payload coretypes.TailnetConfigurePayload) error {
	if runtime.tailnets == nil || runtime.tailnetConfigs == nil {
		return errors.New("tailnet support is not enabled")
	}

	// 설정이 바뀐 노드는 버린다 — 노드는 만들어질 때 설정을 받으므로, 살아 있는 노드는 새
	// auth key 나 새 컨트롤 플레인을 알 방법이 없다.
	//
	// 쓰이는 중이면 기존 연결만 유지하고 새 리스를 막는다. 마지막 리스가 풀리는 즉시 유휴
	// 유예 없이 폐기되므로 새 설정과 옛 노드가 새 연결에서 섞이지 않는다.
	var errs []error
	changes := runtime.tailnetConfigs.replaceAll(payload.Configs)
	for _, id := range changes.Changed {
		runtime.clearTailnetIdentityReplacementForID(id)
		if _, err := runtime.tailnets.Retire(id, tailnet.RetireForReset); err != nil {
			errs = append(errs, err)
		}
	}
	for _, id := range changes.Removed {
		runtime.clearTailnetIdentityReplacementForID(id)
		retired, err := runtime.tailnets.Retire(id, tailnet.RetireForForget)
		if err != nil {
			errs = append(errs, err)
		}
		if !retired {
			if err := runtime.tailnetConfigs.purgeState(id); err != nil {
				errs = append(errs, err)
			}
		}
		runtime.forgetTailnetDegraded(id)
	}
	return errors.Join(errs...)
}

// TailnetForget 은 노드 등록, 로컬 상태, 런타임 설정을 삭제한다. 영구 설정 저장소는 호출자가
// 소유하며, 다시 사용하려면 TailnetConfigure/TailnetTest 로 설정을 적용한다.
func (runtime *Service) TailnetForget(requestID string, payload coretypes.TailnetForgetPayload) error {
	if runtime.tailnets == nil {
		return errors.New("tailnet support is not enabled")
	}
	id := strings.TrimSpace(payload.ID)
	if id == "" {
		return errors.New("tailnet id is required")
	}

	forgetErr := runtime.tailnets.Forget(context.Background(), id)
	runtime.tailnetConfigs.remove(id)
	runtime.clearTailnetIdentityReplacementForID(id)
	forgetErr = errors.Join(forgetErr, runtime.tailnetConfigs.purgeState(id))
	// 등록을 버렸으면 이 tailnet 에 대한 판단도 함께 버린다. 상태 조회로는 지워지지 않는다 —
	// 노드가 사라져서 그 id 의 상태가 더는 나오지 않는다.
	runtime.forgetTailnetDegraded(id)

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
