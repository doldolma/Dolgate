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
	// IdentityInvalid 는 컨트롤 플레인이 현재 노드 identity 를 더 이상 모른다고 명시적으로
	// 응답했는지다. Online=false 와 달리 네트워크 장애를 포함하지 않는 확정 신호다.
	IdentityInvalid bool
	// AuthURL 은 사용자가 방문해 노드를 인가해야 할 때 채워진다. 브라우저가 필요 없는
	// auth key 등록에서는 비어 있다.
	AuthURL string
	// BackendError 는 백엔드가 마지막으로 보고한 오류다(IPN 버스의 ErrMessage).
	//
	// 컨트롤 플레인이 우리 요청을 거부하면 그 이유가 이 경로로 온다 — 잘못된 auth key 에서는
	// "invalid key: unable to validate API key" 가 왔다. 노드가 삭제된 뒤의 poll 재시도에서도
	// 오는지는 확인 중이고, 온다면 기다리지 않고 그 자리에서 확정할 수 있다.
	//
	// Status·Health 로는 안 오는 값이라 버스에서만 받을 수 있다.
	BackendError string

	// 아래는 붙은 뒤에만 채워진다. Tailscale 기본 서버로 여러 개를 등록하면 설정이 전부
	// 같아서 화면에서 구분할 수 없다 — 누구로 어디에 붙었는지가 유일한 단서다.
	//
	// LoginName 은 로그인 계정("alice@example.com"), TailnetName 은 tailnet 이름,
	// NodeName 은 이 노드의 MagicDNS 이름, NodeIP 는 배정받은 주소다.
	LoginName   string
	TailnetName string
	NodeName    string
	NodeIP      string
	// Expired 는 이 노드의 키가 만료됐는지다. BackendState 와 별개다 — 컨트롤 플레인에서
	// 노드를 만료시켜도 백엔드는 한동안 Running 으로 남는다.
	Expired bool
	// Online 은 지금 컨트롤 플레인과 세션이 살아 있는지다(map poll 중인지).
	//
	// State 와 Expired 는 컨트롤 플레인과 끊긴 뒤에도 그대로 남는다 — 등록이 만료돼도 새 netmap
	// 이 오지 않으니 running 인 채로, 기기 목록까지 낡은 값으로 유지된다. 그래서 이것 없이는
	// "확실히 연결됨" 을 표현할 수 없다.
	Online bool
	// BackendState 는 tsnet 이 보고한 원문 상태다. 우리 State 는 몇 가지로 뭉치므로, 무엇을
	// 보고 그렇게 판단했는지 확인하려면 원문이 필요하다.
	BackendState string
	// KeyExpiry 는 노드 키 만료 시각이다(모르면 빈 문자열). 만료를 판단하는 근거 자체라서
	// 화면에서 그대로 확인할 수 있어야 한다.
	KeyExpiry string
	// Health 는 백엔드가 스스로 보고하는 문제들이다.
	//
	// 만료를 상태만으로는 알 수 없기 때문에 필요하다 — 컨트롤 플레인에서 노드를 만료시켜도
	// State 는 running 으로 남는다. tailscale 은 로그아웃·마지막 로그인 오류·컨트롤 플레인과
	// 동기화 안 됨 같은 것을 여기에 담으므로, 상태가 정상으로 보일 때 유일하게 남는 단서다.
	Health []string
	// LoginError 는 백엔드가 "로그인이 실패했다" 고 확정해 알려 준 이유다(비어 있으면 그런 신호가
	// 없다는 뜻이다).
	//
	// 이것이 필요한 이유: auth key 를 잘못 넣은 노드도 상태는 needsAuth + 링크 없음이다 — 링크를
	// 기다리는 중인 것과 구분되지 않는다. 그래서 화면은 "링크를 받는 중" 을 그리고, 링크가 안 온다고
	// 보고 노드를 다시 세우기까지 한다(같은 키라 무의미하다). 실측에서 정상 대기 중에는 이 신호가
	// 아예 오지 않고, 키가 거부되면 2~3 초 안에 온다.
	LoginError string

	// Peers 는 이 tailnet 안에서 보이는 기기들과 지금 그 기기까지 가는 경로다.
	Peers []Peer
}

// Authorized 는 컨트롤 플레인이 이 노드를 인가했고 등록이 아직 유효한지다.
//
// Connected 와 나뉘어 있는 이유: 이 둘은 다른 질문이고, 하나로 답하면 한쪽이 다른 쪽을 끌어내린다.
// 등록과 로그인이 끝났는지는 **지금 컨트롤 플레인과 동기화되는지와 무관하다** — map poll 이 끊겨도
// 등록은 그대로다. 실제로 이것을 Connected 하나로 답하다가, 동기화만 끊긴 상태에서 화면이 이미
// 끝난 등록·로그인 단계를 "아직 안 됨" 으로 되돌려 그렸다(그 뒤의 단계에는 체크가 떠 있어서 순서가
// 뒤바뀐 것처럼 보였다).
func (s Status) Authorized() bool {
	return s.State == StateRunning && !s.Expired && !s.IdentityInvalid
}

// Connected 는 이 tailnet 을 통해 **확실히** 통신할 수 있는 상태인지다.
//
// 판정은 여기 한 곳에만 있다. 대기 관문과 화면 표시가 모두 이 결과를 쓴다 — 곳곳에서 각자 판단하면
// 기준이 갈리고, 어느 하나가 반쪽 기준이면 그 틈으로 낡은 상태가 통과한다.
//
// 인가(Authorized) 위에 "컨트롤 플레인과 세션이 살아 있다"(Online)를 더한 것이다. Online 이 없으면
// State·Expired·기기 목록이 모두 낡은 값이므로 "확실히" 라고 말할 수 없다. 다만 그것이 곧 통신
// 불가는 아니다 — 그 구간을 어떻게 다룰지는 관문이 정한다(BlockOffline 참조).
func (s Status) Connected() bool {
	return s.Authorized() && s.Online
}

// BlockedReason 은 지금 이 tailnet 으로 나갈 수 없는 확정적인 이유다. 없으면 빈 문자열이다.
//
// Connected 의 반대가 아니다. 그 둘은 다른 질문이다:
//
//   - Connected: "확실히 연결됐다" — 연결 흐름의 관문이 묻는다. 확실할 때만 다음 단계로 넘긴다.
//   - BlockedReason: "왜 못 나가는가" — dial 직전 안전망과 관문이 함께 묻는다. 노드가 막 올라오는
//     중(starting)이면 확실히 막힌 것이 아니므로 통과시킨다 — tsnet 의 Dial 이 Running 을 기다려
//     주고, 그 경로가 실기기에서 검증된 동작이다. 여기서 막으면 기동 직후 첫 연결이 깨진다.
//
// 이유마다 무게가 다르다. 인증·승인·만료·거부는 확정적으로 막힌 것이고, BlockOffline 은 "지금
// 상태를 믿을 수 없다" 까지다 — 그 차이를 쓰는 곳이 판단한다.
//
// 판정을 이 두 함수 밖에서 다시 조합하지 않는다. 곳곳에서 각자 판단하면 기준이 갈린다.
func (s Status) BlockedReason() BlockReason {
	switch {
	case s.LoginError != "":
		// 로그인이 확정적으로 거부된 상태다. 인증을 기다리는 것보다 먼저 본다 — 상태는 똑같이
		// needsAuth 이지만, 기다려서 풀리는 것이 아니라 설정을 고쳐야 하는 일이다.
		return BlockLoginFailed
	case s.IdentityInvalid:
		return BlockIdentityInvalid
	case s.State == StateNeedsAuth:
		return BlockNeedsAuth
	case s.State == StateNeedsApproval:
		return BlockNeedsApproval
	case s.Expired:
		return BlockExpired
	case s.State == StateRunning && !s.Online:
		// 컨트롤 플레인과 끊긴 채 running 으로 남은 상태다. State 도 기기 목록도 낡은 값이므로
		// 정상으로 보이는 것을 믿을 수 없다 — 만료가 아직 드러나지 않은 구간이 여기다.
		//
		// 다른 이유들과 성질이 다르다: 이것만으로는 **통신 불가가 아니다**. dial 안전망은 이것을
		// 막지 않는다(assertTailnetNotBlocked 참조) — 데이터 플레인은 이미 받아 둔 넷맵으로 계속
		// 통하고, 진짜 답은 dial 만 알고 있다. 관문이 이 이유를 보고 잠깐 기다릴 뿐이다.
		return BlockOffline
	default:
		return ""
	}
}

// BlockReason 은 나갈 수 없는 이유다. 화면 문구가 아니라 판정 결과를 옮기는 값이다.
type BlockReason string

const (
	BlockNeedsAuth     BlockReason = "needsAuth"
	BlockNeedsApproval BlockReason = "needsApproval"
	BlockExpired       BlockReason = "expired"
	// BlockIdentityInvalid 는 컨트롤 플레인이 현재 노드 identity 를 찾을 수 없다고 확정한
	// 상태다. 일시적인 offline 과 달리 같은 identity 로 재시도해서는 회복되지 않는다.
	BlockIdentityInvalid BlockReason = "identityInvalid"
	// BlockOffline 은 컨트롤 플레인과 동기화가 끊긴 것이다. 확정적으로 막힌 것이 아니라 "지금
	// 보고되는 값을 믿을 수 없다" 는 뜻이고, 그래서 dial 을 막지 않는다.
	BlockOffline BlockReason = "offline"
	// BlockLoginFailed 는 기다려서 풀리지 않는 유일한 이유다 — 설정(키·계정)을 고쳐야 한다.
	BlockLoginFailed BlockReason = "loginFailed"
)

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
	// Reauth 는 인증이 필요한 노드의 대화형 로그인을 개시해 인증 링크가 나오게 한다.
	// 이미 떠 있는 노드의 키가 만료된 경우처럼 Up 만으로는 로그인이 시작되지 않는 상황을
	// 푼다. 인증 대기 구간마다 한 번만 실제로 개시하므로 반복 호출은 안전하다.
	Reauth(ctx context.Context) error
	// Logout 은 등록 자체를 버린다. 컨트롤 플레인이 노드를 지우고, 다음 기동에서 다시
	// 인증해야 한다.
	Logout(ctx context.Context) error
	// Close 는 노드를 완전히 놓는다. 닫힌 노드는 재사용할 수 없다.
	Close() error
	// Purge 는 노드의 로컬 상태를 지운다. 상태 파일은 Close 전까지 열려 있으므로 그
	// 뒤에 실행된다.
	Purge() error
}

// IdentityProber is implemented by nodes whose control plane can validate a
// persisted identity with an explicit request. It is optional because transport
// implementations that do not have a control plane do not need this behavior.
type IdentityProber interface {
	ProbeIdentity(ctx context.Context) error
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
	// generation 은 이 항목의 일련번호다. 리스가 같은 값을 들고 다녀서, 강제 해체 뒤 남은 옛
	// 리스의 Release 를 골라낼 수 있다.
	generation uint64
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
	// generations 는 항목마다 붙는 일련번호의 출처다. 리스는 자기 세대를 들고 다니고, 세대가
	// 다른 Release 는 무시된다 — 그래야 강제 해체(Discard) 뒤에 남은 옛 리스가 나중에 만들어진
	// 새 항목의 refs 를 깎아 멀쩡한 노드를 내려버리는 일이 없다. release 는 id 로만 항목을
	// 찾으므로 이 표시가 없으면 그 사고를 막을 방법이 없다.
	generations uint64
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
	// generation 은 이 리스를 발급한 항목의 일련번호다. 강제 해체된 뒤의 Release 는 이 값이
	// 달라서 무시된다 — 그러지 않으면 새로 만들어진 항목의 refs 를 깎는다.
	generation uint64
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
	l.once.Do(func() { l.registry.release(l.id, l.generation) })
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
		r.generations += 1
		existing = &entry{node: node, generation: r.generations}
		r.entries[id] = existing
	}

	// 예약돼 있던 teardown 은 취소한다 — 이 노드를 다시 쓰겠다는 뜻이므로.
	if existing.idle != nil {
		existing.idle.Stop()
		existing.idle = nil
	}
	existing.refs += 1

	return &Lease{
		Node:       existing.node,
		registry:   r,
		id:         id,
		generation: existing.generation,
	}, nil
}

func (r *Registry) release(id string, generation uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()

	existing, ok := r.entries[id]
	if !ok {
		return
	}
	// 강제 해체된 뒤에 도착한 옛 리스다. 지금 항목은 다른 노드이므로 건드리면 안 된다 —
	// 깎으면 쓰는 중인 새 노드가 유예에 들어가거나 내려간다.
	if existing.generation != generation {
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

// idleExpired 는 유예가 지난 노드를 닫는다.
//
// 닫는다(Down 이 아니다). WantRunning 만 끄면 tsnet 서버가 살아남아서 계속 컨트롤 플레인과
// 통신하고 DERP 에 붙으려 한다 — 사용자에게는 "연결 안 됨" 인데 상태가 계속 바뀌고 경고가 뜬다.
// 게다가 그 노드는 낡은 netmap 을 메모리에 들고 있어서, 다음 연결 때 만료된 등록을 정상으로
// 보고한다.
//
// 등록과 노드 키는 상태 디렉터리에 남으므로, 다음 Acquire 가 새로 만든 노드는 재인증 없이
// 올라온다 — 그때는 netmap 이 없어서 컨트롤 플레인의 답이 그대로 진실이 된다.
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
	done := existing.beginTeardown(true)
	node := existing.node
	r.mu.Unlock()

	// 락 밖에서: 노드를 닫는 것은 시간이 걸리는 일이라, 레지스트리 락을 쥔 채 하면 다른 tailnet
	// 전부가 멈춘다. 그래서 이 사이에 도착하는 Acquire 는 teardown 표시를 보고 기다린다.
	_ = node.Close()
	r.endTeardownRemoving(id, existing, done)
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

// Disconnect 는 노드를 지금 닫는다. 유휴 유예를 기다리지 않을 뿐 결과는 같다.
//
// 닫는다(Down 이 아니다). WantRunning 만 끄면 tsnet 서버가 살아남아 계속 컨트롤 플레인과
// 통신하고 DERP 에 붙으려 한다 — 사용자가 "연결 종료" 를 눌렀는데 상태가 계속 바뀌고 경고가
// 뜨는 것이 그 때문이다. 등록과 노드 키는 상태 디렉터리에 남으므로 다시 연결할 때 재인증이
// 필요 없다.
//
// 쓰이는 중이면 거절한다. 세션이 얹혀 있는 노드를 그 밑에서 닫으면 그 세션이 죽는다.
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
	// 항목은 Close 가 끝난 뒤 지운다. 먼저 지우면 그 사이 도착한 Acquire 가 같은 상태
	// 디렉터리로 두 번째 노드를 만들어, 닫히는 중인 노드와 노드 키를 두고 겹친다.
	done := existing.beginTeardown(true)
	node := existing.node
	r.mu.Unlock()

	err := node.Close()
	r.endTeardownRemoving(id, existing, done)
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

// StatusOf 는 노드 하나의 상태다. 없는 id 면 두 번째 값이 false 다.
//
// 없는 노드를 위해 만들지 않는다 — 상태를 물어보는 것만으로 tailnet 이 붙으면 안 된다.
func (r *Registry) StatusOf(ctx context.Context, id string) (Status, bool) {
	r.mu.Lock()
	existing := r.entries[id]
	r.mu.Unlock()
	if existing == nil {
		return Status{}, false
	}

	status, err := existing.node.Status(ctx)
	if err != nil {
		return Status{State: StateStopped}, true
	}
	return status, true
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

// Discard 는 노드를 닫고 항목을 버린다. 쓰는 곳이 있어도 닫는다.
//
// 취소가 쓰는 동작이다. 취소는 "지금 이 서버를 없앤다"는 뜻이므로 리스를 이유로 남겨 두면
// 취소가 아니게 된다 — 노드가 그대로 살아 상태와 인증 링크를 계속 보고하고, 화면은 접은 것을
// 접지 못한 상태로 그린다. 아직 그 tailnet 이 필요한 소비자는 다시 요청하고, 그때 새 서버가
// 만들어져 처음부터 붙는다.
//
// 남아 있던 리스는 세대가 달라져 무효가 된다(그들의 Release 는 무시된다). Logout·Purge 는 하지
// 않으므로 등록과 노드 키는 그대로다 — 컨트롤 플레인에 기기가 새로 생기지 않는다.
func (r *Registry) Discard(id string) error {
	existing := r.lockEntrySettled(id)
	if existing == nil {
		r.mu.Unlock()
		return nil
	}
	if existing.idle != nil {
		existing.idle.Stop()
		existing.idle = nil
	}
	// 남은 소비자 수는 의미가 없어진다. 항목은 Close 가 끝난 뒤 지운다(Reset 과 같은 이유 —
	// 먼저 지우면 그 사이 도착한 Acquire 가 같은 상태 디렉터리로 두 번째 노드를 만든다).
	existing.refs = 0
	done := existing.beginTeardown(true)
	node := existing.node
	r.mu.Unlock()

	err := node.Close()
	r.endTeardownRemoving(id, existing, done)
	return err
}

// ReplaceInvalidIdentity 는 컨트롤 플레인이 더 이상 모르는 노드를 닫고 로컬 등록 상태를 지운다.
// 다음 Acquire 는 새 identity 로 등록을 처음부터 시작한다.
//
// Logout 은 호출하지 않는다. 이 메서드의 전제 자체가 컨트롤 플레인에서 노드가 이미 사라졌다는
// 확정 응답이고, 같은 죽은 identity 로 logout 을 보내 봐야 실패와 백오프만 더한다.
//
// 쓰는 곳이 있어도 교체한다. identity 가 무효인 노드 위의 새 연결은 회복될 수 없고, 남은 리스는
// 세대가 달라져 다음 Release 때 새 노드의 refcount 를 건드리지 않는다.
func (r *Registry) ReplaceInvalidIdentity(id string, invalid *Lease) (bool, error) {
	existing := r.lockEntrySettled(id)
	if existing == nil {
		r.mu.Unlock()
		return false, nil
	}
	// 다른 goroutine 이 먼저 교체했다. 관측했던 옛 lease 로 지금의 새 노드를 다시 지우면
	// 삭제 사건 하나가 노드를 계속 늘리는 원인이 된다.
	if invalid == nil || invalid.registry != r || invalid.id != id ||
		existing.generation != invalid.generation {
		r.mu.Unlock()
		return false, nil
	}
	if existing.idle != nil {
		existing.idle.Stop()
		existing.idle = nil
	}
	existing.refs = 0
	done := existing.beginTeardown(true)
	node := existing.node
	r.mu.Unlock()

	closeErr := node.Close()
	purgeErr := node.Purge()
	r.endTeardownRemoving(id, existing, done)
	return true, errors.Join(closeErr, purgeErr)
}

// DiscardInvalidIdentityIfIdle 는 사용 중이지 않은 노드가 컨트롤 플레인에서 삭제됐는지
// 현재 세대에서 다시 확인한 뒤, 그 노드와 로컬 등록 상태만 버린다. 새 노드는 만들지 않는다.
// 다음 실제 소비자의 Acquire 가 새 identity 등록을 시작한다.
//
// 상태를 확인하는 동안 관찰자 리스 하나를 잡는다. 그래야 유휴 타이머가 노드를 닫지 않고,
// 확인한 노드 세대를 ReplaceInvalidIdentity 에 그대로 넘겨 새로 만들어진 정상 노드를 지우지 않는다.
func (r *Registry) DiscardInvalidIdentityIfIdle(ctx context.Context, id string) (bool, error) {
	existing := r.lockEntrySettled(id)
	if existing == nil || r.closed || existing.refs != 0 {
		r.mu.Unlock()
		return false, nil
	}
	if existing.idle != nil {
		existing.idle.Stop()
		existing.idle = nil
	}
	existing.refs = 1
	observed := &Lease{
		Node:       existing.node,
		registry:   r,
		id:         id,
		generation: existing.generation,
	}
	r.mu.Unlock()

	status, err := observed.Node.Status(ctx)
	if err != nil {
		observed.Release()
		return false, err
	}
	if !status.IdentityInvalid {
		observed.Release()
		return false, nil
	}

	discarded, err := r.ReplaceInvalidIdentity(id, observed)
	if !discarded {
		observed.Release()
	}
	return discarded, err
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
