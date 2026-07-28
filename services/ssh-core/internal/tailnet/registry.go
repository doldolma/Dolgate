// Package tailnet 은 tailnet 마다 노드 하나를 유지하고 그 위로 dial 을 내준다.
//
// 단위는 호스트나 연결이 아니라 tailnet 이다. 한 tailnet 에 배정된 호스트들은 그
// tailnet 의 노드를 공유한다. 노드는 자원도 쓰지만 무엇보다 고객 tailnet 의 디바이스
// 목록에 자리를 차지하므로, 호스트마다 노드를 만들면 둘 다 호스트 수만큼 곱해진다.
//
// 이 파일에는 Tailscale 의존이 없다. 수명 규칙(누가 노드를 공유하는지, 언제 내리는지)이
// 검증할 값어치가 있는 부분인데, 노드 구현과 분리해 두면 컨트롤 플레인 없이 테스트할 수
// 있다.
package tailnet

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

// DefaultIdleGrace 는 마지막 소비자가 사라진 뒤 노드를 얼마나 더 유지할지다.
//
// 같은 tailnet 에 다시 붙는 일은 흔하다 — 터미널을 닫고 1분 뒤 다른 걸 연다. 노드를
// 다시 올리려면 컨트롤 플레인 핸드셰이크와 경로 탐색을 다시 하고, 그 사이 노드가 회수됐다면
// 재등록까지 필요하다. 잠시 붙들고 있으면 흔한 경우가 공짜가 된다. 영원히 붙들지 않는
// 이유는 ephemeral 노드가 "활동이 멈춰야" 회수되기 때문이고, 켜져 있는 노드는 사용자가
// 아무것도 하지 않는 동안에도 tailnet 디바이스 목록에 online 으로 남기 때문이다.
const DefaultIdleGrace = 30 * time.Minute

// State 는 노드가 올라오는 동안 보고하는 백엔드 상태다. IPC 경계를 그대로 건너가므로
// enum 이 아니라 문자열이다.
type State string

const (
	StateStopped   State = "stopped"
	StateNeedsAuth State = "needsAuth"
	// StateNeedsApproval 은 등록은 됐지만 관리자 인가가 남은 상태다. Tailscale 은 device
	// approval 이 켜져 있을 때 이 상태를 보고한다. OIDC 가 없는 Headscale 은 운영자가
	// 별도로 승인하는 동안 StateNeedsAuth 에 머물 수도 있다.
	StateNeedsApproval State = "needsApproval"
	StateStarting      State = "starting"
	StateRunning       State = "running"
)

// Status 는 노드가 올라오는 동안 설정 화면이 그리는 값이다.
type Status struct {
	State State
	// AuthURL 은 사용자가 방문해 노드를 인가해야 할 때 채워진다. 브라우저가 필요 없는
	// auth key 등록에서는 비어 있다.
	AuthURL string
	// Err 는 노드가 멈췄다면 그 이유다.
	Err string

	// 아래는 붙은 뒤에만 채워진다. Tailscale 기본 서버로 여러 개를 등록하면 설정이 전부
	// 같아서 화면에서 구분할 수 없다 — 누구로 어디에 붙었는지가 유일한 단서다.
	//
	// LoginName 은 로그인 계정("alice@example.com"), TailnetName 은 tailnet 이름,
	// NodeName 은 이 노드의 MagicDNS 이름, NodeIP 는 배정받은 주소다.
	LoginName   string
	TailnetName string
	NodeName    string
	NodeIP      string

	// Peers 는 이 tailnet 안에서 보이는 기기들과 지금 그 기기까지 가는 경로다.
	Peers []Peer
}

// Peer 는 tailnet 안의 기기 하나와 그 기기까지의 현재 경로다.
//
// 경로는 고정이 아니다. 유저스페이스 노드는 붙은 직후 릴레이로 시작해, 홀펀칭이 되면 직결로
// 승격한다. 그래서 "지금" 어느 쪽인지가 관찰 대상이다.
type Peer struct {
	// HostName 은 짧은 이름, DNSName 은 FQDN(끝점 제거)이다. 호스트 레코드의 주소가 둘 중
	// 무엇이든, 또는 tailnet IP 든 맞출 수 있어야 해서 다 담는다.
	HostName string
	DNSName  string
	IPs      []string
	// Direct 는 직결 경로가 서 있는지다. false 면 릴레이 경유다.
	Direct bool
	// Relay 는 이 기기와 쓰는 DERP 지역이다. 직결이어도 폴백으로 남아 채워질 수 있다.
	Relay   string
	RxBytes int64
	TxBytes int64
}

// Node 는 tailnet 멤버십 하나다. 노드는 그 tailnet 의 모든 호스트가 공유하므로 구현체는
// 동시 사용에 안전해야 한다.
type Node interface {
	// Dial 은 tailnet 을 통해 연결을 연다. 노드가 올라와 있지 않으면 먼저 올린다.
	Dial(ctx context.Context, network, address string) (net.Conn, error)
	Status(ctx context.Context) (Status, error)
	// Up 은 노드를 올린다. Down 한 뒤 다시 쓰려면 반드시 거쳐야 한다 — tsnet 의 Start 는
	// 한 번만 유효해서, 두 번째 호출은 Down 이 꺼 둔 WantRunning 을 되돌리지 않는다.
	// 멱등이므로 이미 올라와 있어도 부담 없이 부를 수 있다.
	Up(ctx context.Context) error
	// Down 은 네트워킹만 멈추고 등록은 남긴다. 그래서 다시 올릴 때 재인증이 필요 없다.
	Down(ctx context.Context) error
	// Logout 은 등록 자체를 버린다. 컨트롤 플레인이 노드를 지우고, 다음 기동에서 다시
	// 인증해야 한다.
	Logout(ctx context.Context) error
	// Close 는 노드를 완전히 놓는다. 닫힌 노드는 재사용할 수 없다.
	Close() error
	// Purge 는 노드의 로컬 상태를 지운다. 상태 파일은 Close 전까지 열려 있으므로 그
	// 뒤에 실행된다.
	Purge() error
}

// NodeFactory 는 레지스트리가 처음 보는 tailnet 의 노드를 만든다.
type NodeFactory func(id string) (Node, error)

// ErrClosed 는 레지스트리가 종료된 뒤의 요청에 반환된다.
var ErrClosed = errors.New("tailnet: registry is closed")

// Stopper 는 레지스트리가 타이머에서 쓰는 부분만 좁힌 것이다. 이렇게 좁혀 두면 테스트가
// 원하는 시점에 발동시킬 수 있는 대체물을 넣을 수 있다. *time.Timer 가 이 인터페이스를
// 만족하므로 실제 동작은 그대로 진짜 타이머를 쓴다.
type Stopper interface {
	Stop() bool
}

// AfterFunc 는 fn 을 예약하고 취소용 핸들을 돌려준다.
type AfterFunc func(d time.Duration, fn func()) Stopper

type entry struct {
	node Node
	refs int
	// idle 은 마지막 소비자가 떠난 뒤 유예 시간이 지나면 teardown 을 발동한다. 소비자가
	// 있는 동안에는 nil 이다.
	idle Stopper
	// teardown 은 이 노드를 해체하는 중일 때만 non-nil 이고, 끝나면 닫힌다.
	//
	// 해체(Down·Close·Logout·Purge)는 컨트롤 플레인이나 디스크와 통신하므로 락 밖에서 한다.
	// 그 사이에 도착한 Acquire 가 그냥 리스를 받아 가면, 그 소비자가 올린 노드를 뒤늦게 도착한
	// Down 이 꺼 버리거나, 지워지는 중인 상태 디렉터리로 두 번째 노드가 만들어진다.
	// Acquire 는 이 채널이 닫히기를 기다린 뒤 다시 시도한다.
	teardown chan struct{}
	// teardownCloses 는 진행 중인 해체가 노드를 Close 까지 하는지다(Reset·Forget). 종료 시
	// Registry.Close 가 같은 노드를 또 닫지 않으려면 구분이 필요하다 — Down 만 하는 해체
	// (유휴 만료·Disconnect)는 노드를 남기므로 종료 때 닫아야 한다.
	teardownCloses bool
}

// beginTeardown 은 해체 중임을 표시한다. 호출자가 락을 쥔 상태여야 한다. closes 는 이 해체가
// 노드를 Close 까지 하는지다.
func (e *entry) beginTeardown(closes bool) chan struct{} {
	done := make(chan struct{})
	e.teardown = done
	e.teardownCloses = closes
	return done
}

// endTeardown 은 표시를 지우고 기다리던 Acquire 들을 깨운다. 항목은 남긴다 — Down 은 등록을
// 유지하므로 다음 Acquire 가 재인증 없이 그 노드를 다시 쓴다.
//
// 순서가 계약이다. 필드를 먼저 비워야 한다 — 채널을 먼저 닫으면 깨어난 Acquire 가 아직
// 남아 있는 teardown 을 보고 이미 닫힌 채널을 다시 기다려 제자리를 돈다.
func (r *Registry) endTeardown(id string, existing *entry, done chan struct{}) {
	r.mu.Lock()
	// 그 사이 Reset/Forget 이 이 항목을 치웠을 수 있다. 그때는 남의 항목을 건드리지 않는다.
	if r.entries[id] == existing {
		existing.teardown = nil
		existing.teardownCloses = false
	}
	r.mu.Unlock()
	close(done)
}

// endTeardownRemoving 은 해체가 끝난 항목을 레지스트리에서 지우고 기다리던 Acquire 들을 깨운다.
//
// endTeardown 과 나뉘어 있는 이유: Down 은 노드를 다시 쓸 수 있게 남기지만 Close·Purge 는
// 그 노드를 못 쓰게 만든다. 항목을 남기면 다음 Acquire 가 닫힌 노드를 재사용한다.
//
// 여기서도 순서가 계약이다. 지도에서 먼저 빼야 한다 — 채널을 먼저 닫으면 깨어난 Acquire 가
// 아직 남아 있는 항목의 닫힌 teardown 을 다시 기다려 제자리를 돈다.
func (r *Registry) endTeardownRemoving(id string, existing *entry, done chan struct{}) {
	r.mu.Lock()
	if r.entries[id] == existing {
		// 해체 중에 리스가 풀려 유예가 예약됐을 수 있다(Forget 은 refs 를 보지 않는다). 항목이
		// 사라지면 발동해도 무해하지만, 30 분간 살아 있을 이유는 없다.
		if existing.idle != nil {
			existing.idle.Stop()
			existing.idle = nil
		}
		delete(r.entries, id)
	}
	r.mu.Unlock()
	close(done)
}

// lockEntrySettled 는 id 의 항목을 해체가 진행되지 않는 상태로 잡아 돌려준다. 진행 중이면
// 끝나기를 기다린 뒤 **다시 읽는다** — 그 사이 Reset/Forget 이 항목을 치웠거나 다른 소비자가
// 새로 만들었을 수 있다.
//
// 반환 시 락을 쥔 상태다. 호출자가 반드시 풀어야 한다. 항목이 없으면 nil 을 돌려주는데 그때도
// 락은 쥔 상태다 — "없음"을 확인한 뒤 만들기까지가 한 임계구역이어야 두 소비자가 같은 tailnet
// 노드를 두 개 만들지 않는다.
//
// 이 대기가 없으면 해체와 겹친 호출들이 서로의 teardown 표시를 덮어쓴다. 그러면 먼저 끝난
// 쪽이 남의 표시를 지워, 아직 Close·Purge 가 도는 중인데 Acquire 가 통과한다.
func (r *Registry) lockEntrySettled(id string) *entry {
	for {
		r.mu.Lock()
		existing, ok := r.entries[id]
		if !ok {
			return nil
		}
		if existing.teardown == nil {
			return existing
		}
		teardown := existing.teardown
		r.mu.Unlock()
		<-teardown
	}
}

// Registry 는 노드를 소유하고 언제 없앨지 결정한다.
type Registry struct {
	newNode   NodeFactory
	idleGrace time.Duration
	afterFunc AfterFunc

	mu      sync.Mutex
	entries map[string]*entry
	closed  bool
}

// Options 는 Registry 설정이다. 각 필드의 제로값은 기본값으로 대체된다.
type Options struct {
	IdleGrace time.Duration
	AfterFunc AfterFunc
}

func NewRegistry(newNode NodeFactory, options Options) *Registry {
	grace := options.IdleGrace
	if grace <= 0 {
		grace = DefaultIdleGrace
	}
	after := options.AfterFunc
	if after == nil {
		after = func(d time.Duration, fn func()) Stopper { return time.AfterFunc(d, fn) }
	}
	return &Registry{
		newNode:   newNode,
		idleGrace: grace,
		afterFunc: after,
		entries:   make(map[string]*entry),
	}
}

// Lease 는 tailnet 노드에 대한 점유권이다. 소비자 — 세션, SFTP 브라우저, 포트포워딩 —
// 마다 하나씩 들고, 마지막 하나가 놓일 때까지 노드는 유지된다.
type Lease struct {
	Node Node

	registry *Registry
	id       string
	// once 는 여러 번 놓아도 refcount 가 한 번만 깎이게 한다. 평범한 bool 이 아니라 Once 인
	// 이유는 겹치는 호출이 순차가 아니라 **동시**이기 때문이다 — leasedConn.Close 는 핸드셰이크
	// 실패 정리와 SSH 읽기 루프의 teardown 에서 각각 불리고, 그 둘은 다른 goroutine 이다.
	// bool 로는 둘 다 "아직 안 놓았다"를 읽어 두 번 깎고(살아 있는 세션 밑에서 노드가 내려간다),
	// 그 자체가 데이터 레이스다.
	once sync.Once
}

// Release 는 점유를 놓는다. 몇 번 불려도, 동시에 불려도 한 번만 놓는다.
func (l *Lease) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() { l.registry.release(l.id) })
}

// Acquire 는 tailnet 노드의 점유권을 돌려준다. 첫 소비자면 노드를 만든다. 유예 중인
// 노드에 도착한 호출자는 그 노드를 재사용하고 예약된 teardown 을 취소한다.
// 해체가 진행 중인 노드에는 리스를 내주지 않는다. 내주면 Down 이 이 소비자가 올린 노드를 꺼
// 버리고, Close·Purge 중이었다면 같은 상태 디렉터리로 두 번째 노드를 만들게 된다.
func (r *Registry) Acquire(id string) (*Lease, error) {
	existing := r.lockEntrySettled(id)
	defer r.mu.Unlock()

	if r.closed {
		return nil, ErrClosed
	}

	if existing == nil {
		node, err := r.newNode(id)
		if err != nil {
			return nil, fmt.Errorf("tailnet %q: %w", id, err)
		}
		existing = &entry{node: node}
		r.entries[id] = existing
	}

	// 예약돼 있던 teardown 은 취소한다 — 이 노드를 다시 쓰겠다는 뜻이므로.
	if existing.idle != nil {
		existing.idle.Stop()
		existing.idle = nil
	}
	existing.refs += 1

	return &Lease{Node: existing.node, registry: r, id: id}, nil
}

func (r *Registry) release(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	existing, ok := r.entries[id]
	if !ok {
		return
	}
	existing.refs -= 1
	if existing.refs > 0 {
		return
	}
	existing.refs = 0

	// 마지막 소비자가 떠났다. 지금 내리지 않고 유예를 시작한다.
	if existing.idle != nil {
		existing.idle.Stop()
	}
	existing.idle = r.afterFunc(r.idleGrace, func() { r.idleExpired(id) })
}

// idleExpired 는 유예가 지난 노드를 내린다. 노드는 레지스트리에 남겨 둔다 — Down 은
// 등록을 유지하므로 나중에 Acquire 하면 재인증 없이 다시 올라온다.
func (r *Registry) idleExpired(id string) {
	r.mu.Lock()
	existing, ok := r.entries[id]
	// 타이머가 발동한 뒤 이 락을 잡기까지 사이에 도착한 소비자가 이긴다. 노드가 다시
	// 쓰이는 중이므로 그 밑에서 내려버리면 안 된다.
	if !ok || existing.refs > 0 {
		r.mu.Unlock()
		return
	}
	existing.idle = nil
	done := existing.beginTeardown(false)
	node := existing.node
	r.mu.Unlock()

	// 락 밖에서: 노드를 내리는 건 컨트롤 플레인과 통신하는 일이라, 레지스트리 락을 쥔 채
	// 하면 다른 tailnet 전부가 멈춘다. 그래서 이 사이에 도착하는 Acquire 는 teardown 표시를
	// 보고 기다린다.
	_ = node.Down(context.Background())
	r.endTeardown(id, existing, done)
}

// Leases 는 이 tailnet 을 쓰는 중인 소비자 수다.
//
// 리스 누수가 이 구조의 주 실패 모드다 — 새면 노드가 유예에 들어가지 못해 영원히 떠 있고,
// 두 번 놓으면 아직 쓰는 중인 노드가 내려간다. 둘 다 조용히 일어나므로 관찰할 수단을 둔다.
func (r *Registry) Leases(id string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	existing, ok := r.entries[id]
	if !ok {
		return 0
	}
	return existing.refs
}

// Disconnect 는 노드를 지금 내린다. 유휴 유예를 기다리지 않을 뿐 결과는 같다 — 네트워킹만
// 끄고 등록과 노드키는 남으므로, 다시 쓰면 재인증 없이 올라온다.
//
// 노드는 레지스트리에 남겨 둔다. idleExpired 와 같은 이유다.
func (r *Registry) Disconnect(ctx context.Context, id string) error {
	existing := r.lockEntrySettled(id)
	if existing == nil {
		r.mu.Unlock()
		return nil
	}
	if existing.refs > 0 {
		r.mu.Unlock()
		return fmt.Errorf("%w: %q", ErrNodeInUse, id)
	}
	if existing.idle != nil {
		existing.idle.Stop()
		existing.idle = nil
	}
	done := existing.beginTeardown(false)
	node := existing.node
	r.mu.Unlock()

	// 락 밖에서: 노드를 내리는 건 컨트롤 플레인과 통신하는 일이다. idleExpired 와 같은 이유로
	// 이 사이에 도착하는 Acquire 는 기다리게 한다.
	err := node.Down(ctx)
	r.endTeardown(id, existing, done)
	return err
}

// Snapshot 은 지금 레지스트리가 들고 있는 노드들의 상태다.
//
// 여기 없는 tailnet 은 노드가 없다는 뜻이고, 그것 자체가 "연결 안 됨"이다. 없는 id 를 위해
// 노드를 만들지 않는다 — 설정 화면을 여는 것만으로 모든 tailnet 이 붙으면 안 된다.
func (r *Registry) Snapshot(ctx context.Context) map[string]Status {
	r.mu.Lock()
	nodes := make(map[string]Node, len(r.entries))
	for id, existing := range r.entries {
		nodes[id] = existing.node
	}
	r.mu.Unlock()

	statuses := make(map[string]Status, len(nodes))
	for id, node := range nodes {
		status, err := node.Status(ctx)
		if err != nil {
			statuses[id] = Status{State: StateStopped}
			continue
		}
		statuses[id] = status
	}
	return statuses
}

// ErrNodeInUse 는 쓰이는 중인 노드를 버리려 할 때 나온다.
var ErrNodeInUse = errors.New("tailnet node is in use")

// Reset 은 노드를 닫고 레지스트리에서 지우되 등록과 로컬 상태는 남긴다.
//
// 설정이 바뀌었을 때 쓴다. 노드는 만들어질 때 설정을 받으므로, 이미 있는 노드는 새 auth key
// 나 새 컨트롤 플레인을 알 방법이 없다 — 다음 Acquire 가 새 설정으로 다시 만들게 하려면
// 버리는 수밖에 없다. Forget 과 달리 로그아웃하지 않아서, 이미 인증된 tailnet 이라면 다시
// 만들어진 노드가 상태 파일을 읽어 재인증 없이 올라온다.
//
// 쓰이는 중이면 거절한다. 세션이 얹혀 있는 노드를 그 밑에서 닫으면 그 세션이 죽는다.
func (r *Registry) Reset(id string) error {
	existing := r.lockEntrySettled(id)
	if existing == nil {
		r.mu.Unlock()
		return nil
	}
	if existing.refs > 0 {
		r.mu.Unlock()
		return fmt.Errorf("%w: %q", ErrNodeInUse, id)
	}
	if existing.idle != nil {
		existing.idle.Stop()
		existing.idle = nil
	}
	// 항목은 여기서 지우지 않는다. Close 가 끝나기 전에 지우면 그 사이 도착한 Acquire 가 같은
	// 상태 디렉터리로 두 번째 노드를 만들어, 닫히는 중인 노드와 노드키를 두고 겹친다. 표시만
	// 남기고 Close 가 끝난 뒤 지운다.
	done := existing.beginTeardown(true)
	node := existing.node
	r.mu.Unlock()

	err := node.Close()
	r.endTeardownRemoving(id, existing, done)
	return err
}

// Forget 은 노드를 로그아웃시키고 버린다. 이것이 "등록 해제" 동작이다 — 컨트롤 플레인이
// 노드를 지우고, 다음 Acquire 는 처음부터 인증한다.
func (r *Registry) Forget(ctx context.Context, id string) error {
	existing := r.lockEntrySettled(id)
	if existing == nil {
		r.mu.Unlock()
		return nil
	}
	if existing.idle != nil {
		existing.idle.Stop()
		existing.idle = nil
	}
	// Reset 과 같은 이유로 항목을 남긴 채 해체한다. 여기서는 더 중요하다 — Purge 가 상태 파일을
	// 지우는 동안 새 노드가 같은 디렉터리를 붙잡고 있으면, 방금 만든 노드의 키가 지워진다.
	done := existing.beginTeardown(true)
	node := existing.node
	r.mu.Unlock()

	// 순서가 계약이다. 로그아웃이 먼저여야 노드가 실제로 지워진다 — 닫힌 노드는 컨트롤
	// 플레인에 닿지 못하므로 먼저 닫으면 등록이 남은 채 방치될 뿐이다. Purge 가 마지막인
	// 이유는 상태 파일이 Close 전까지 열려 있기 때문이다.
	//
	// 앞 단계가 실패해도 나머지는 모두 실행한다. 컨트롤 플레인에 닿지 못했다고 해서 노드를
	// 열어 둔 채 죽은 키까지 디스크에 남길 이유는 없다.
	logoutErr := node.Logout(ctx)
	closeErr := node.Close()
	purgeErr := node.Purge()

	r.endTeardownRemoving(id, existing, done)
	return errors.Join(logoutErr, closeErr, purgeErr)
}

// Close 는 모든 노드를 해체한다. Down 이 아니라 Close 인 이유는 이 함수가 프로세스가
// 종료될 때 실행되기 때문이다.
func (r *Registry) Close() error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	nodes := make([]Node, 0, len(r.entries))
	for _, existing := range r.entries {
		if existing.idle != nil {
			existing.idle.Stop()
		}
		// 이미 Close 까지 하는 해체가 도는 중이면 건너뛴다. 같은 노드를 두 번 닫게 된다.
		// Down 만 하는 해체는 노드를 남기므로 여기서 닫아야 한다.
		if existing.teardownCloses {
			continue
		}
		nodes = append(nodes, existing.node)
	}
	r.entries = make(map[string]*entry)
	r.mu.Unlock()

	var firstErr error
	for _, node := range nodes {
		if err := node.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
