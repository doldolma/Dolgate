package tailnet

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

// NodeConfig 는 tailnet 하나의 노드를 어떻게 만들지다.
type NodeConfig struct {
	// Hostname 은 tailnet 디바이스 목록에 보일 이름이다.
	Hostname string
	// ControlURL 이 비면 Tailscale, 채우면 Headscale 같은 다른 컨트롤 플레인이다.
	// 서버 선택은 인증 방식과 직교한다 — 어느 서버든 auth key 와 브라우저 둘 다 쓴다.
	ControlURL string
	// AuthKey 가 있으면 브라우저 없이 등록한다. 비면 대화형 로그인으로 간다.
	AuthKey string
	// Ephemeral 은 활동이 멈추면 컨트롤 플레인이 노드를 지우도록 요청한다. 인증 방식과
	// 무관하게 등록 요청에 실린다. 다만 tailcfg 문서상 이것은 "요청"이고 최종 판단은
	// 컨트롤 플레인이 한다 — 특히 Headscale 은 OIDC 경로에서 이를 무시하는 알려진 버그가
	// 있어(juanfont/headscale#2719) 그 조합에서는 영속 노드가 된다.
	Ephemeral bool
	// Dir 은 이 tailnet 의 상태 디렉터리다. 반드시 지정한다 — 비우면 tsnet 이
	// os.UserConfigDir()/tsnet-<prog> 에 만들어 앱 데이터 밖에 흩어진다. tailnet 마다
	// 달라야 하고, 노드키가 들어가므로 기기 로컬 전용이다(동기화 대상 아님).
	Dir string
}

// tsnetNode 는 tsnet.Server 로 Node 를 구현한다.
type tsnetNode struct {
	server *tsnet.Server
	dir    string

	mu      sync.Mutex
	started bool
	closed  bool
}

// ensureStarted 는 서버를 기동하고 그 사실을 기록한다.
//
// 기록이 필요한 이유는 Close 때문이다. tsnet 의 Close 는 Start 가 만든 내부 상태를
// 건드리므로 한 번도 기동하지 않은 서버에 부르면 nil 역참조로 죽는다. tailnet 을 설정만
// 해두고 한 번도 연결하지 않은 채 등록 해제하는 것은 충분히 흔한 경로다.
//
// Start 자체는 멱등이라 여러 번 불러도 문제없다.
func (n *tsnetNode) ensureStarted() error {
	n.mu.Lock()
	if n.closed {
		n.mu.Unlock()
		return errors.New("tailnet: node is closed")
	}
	n.mu.Unlock()

	if err := n.server.Start(); err != nil {
		return fmt.Errorf("tailnet: start: %w", err)
	}

	n.mu.Lock()
	n.started = true
	n.mu.Unlock()
	return nil
}

// NewNode 는 설정대로 tsnet 노드를 만든다. 서버는 여기서 기동하지 않는다 — tsnet 의
// Dial 이 lazy start 와 Running 대기를 이미 품고 있어서, 아무도 쓰지 않는 tailnet 을
// 미리 올릴 이유가 없다.
func NewNode(config NodeConfig) (Node, error) {
	if strings.TrimSpace(config.Dir) == "" {
		return nil, errors.New("tailnet: state directory is required")
	}
	if err := os.MkdirAll(config.Dir, 0o700); err != nil {
		return nil, fmt.Errorf("tailnet: state directory: %w", err)
	}

	return &tsnetNode{
		server: &tsnet.Server{
			Dir:        config.Dir,
			Hostname:   config.Hostname,
			ControlURL: config.ControlURL,
			AuthKey:    config.AuthKey,
			Ephemeral:  config.Ephemeral,
		},
		dir: config.Dir,
	}, nil
}

func (n *tsnetNode) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	// Down 된 노드로도 여기 들어올 수 있다(유휴 유예 만료 뒤 재사용). 그대로 Dial 하면
	// 올라오지 않는 노드를 기다리며 멈춘다.
	if err := n.Up(ctx); err != nil {
		return nil, err
	}
	return n.server.Dial(ctx, network, address)
}

// Up 은 노드를 올린다.
//
// tsnet 의 Start 는 처음 한 번만 실제로 동작한다 — 두 번째부터는 이미 시작된 것을 보고 곧장
// 반환하므로, Down 이 꺼 둔 WantRunning 을 되돌려 주지 않는다. 그래서 여기서 명시적으로
// 켠다. 이것이 없으면 "연결 종료 후 다시 연결"이 영원히 Stopped 에 머문다.
func (n *tsnetNode) Up(ctx context.Context) error {
	if err := n.ensureStarted(); err != nil {
		return err
	}
	client, err := n.server.LocalClient()
	if err != nil {
		return fmt.Errorf("tailnet: local client: %w", err)
	}
	return n.bringUp(ctx, client)
}

// bringUp 은 WantRunning 을 켜고 노드가 실제로 올라오기를 기다린다.
//
// Up 에서 떼어낸 이유는 이 두 단계가 **함께** 있어야 한다는 것이 계약이기 때문이다. 켜기만
// 하고 기다리지 않으면 첫 dial 이 NoState 로 즉시 깨진다. 좁힌 인터페이스로 받아 두면 살아
// 있는 백엔드 없이 그 배선을 검증할 수 있다.
func (n *tsnetNode) bringUp(ctx context.Context, client localClient) error {
	if _, err := client.EditPrefs(ctx, &ipn.MaskedPrefs{
		Prefs:          ipn.Prefs{WantRunning: true},
		WantRunningSet: true,
	}); err != nil {
		return fmt.Errorf("tailnet: bring up: %w", err)
	}
	return n.awaitBackendReady(ctx, client)
}

// awaitBackendReady 는 백엔드가 상태를 보고하기 시작할 때까지만 기다린다.
//
// 이것이 없으면 첫 dial 이 "tsnet: backend in state NoState" 로 즉시 실패한다. Start 는
// 백엔드를 비동기로 띄우므로 돌아온 직후에는 아직 아무 상태도 없는데, tsnet 의 awaitRunning
// 은 NeedsLogin·Starting 만 기다리고 나머지(NoState 포함)는 종료 상태로 보고 곧장 에러를 낸다.
//
// **Running 까지 기다리지는 않는다.** 그렇게 하면 브라우저 로그인이 필요한 노드에서 이 함수가
// 인증이 끝날 때까지 갇힌다. 설정 화면의 연결 테스트는 Up 이 돌아온 뒤에야 상태를 폴링해
// 인증 URL 을 방출하므로, 여기서 붙들면 URL 이 영원히 나가지 않고 브라우저도 열리지 않는다.
//
// NoState 만 벗어나면 뒤는 tsnet 이 맡는다 — awaitRunning 이 NeedsLogin·Starting 을 지켜보며
// 기다린다. 인증이 필요한 상태를 실패로 볼지는 호출자가 정할 일이고, 그 판단은 dial 경로에
// 있다(설정 화면은 기다려야 하고, 호스트 연결은 즉시 안내해야 한다).
func (n *tsnetNode) awaitBackendReady(ctx context.Context, client localClient) error {
	for {
		status, err := client.Status(ctx)
		if err != nil {
			return fmt.Errorf("tailnet: status: %w", err)
		}
		if backendHasReported(status.BackendState) {
			return nil
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("tailnet: backend did not start: %w", ctx.Err())
		case <-time.After(nodeStatusPollInterval):
		}
	}
}

// backendHasReported 는 백엔드가 상태를 보고했는지다. ipn.NoState 는 "아직 아무것도"라는
// 뜻이고, 그 상태로 dial 하면 tsnet 이 종료 상태로 오해해 즉시 실패한다.
func backendHasReported(backendState string) bool {
	trimmed := strings.TrimSpace(backendState)
	return trimmed != "" && trimmed != ipn.NoState.String()
}

// nodeStatusPollInterval 은 백엔드 기동을 기다리는 동안의 폴링 간격이다. 상태 변화는 컨트롤
// 플레인 왕복에 달려 있어 촘촘히 볼 이유가 없다.
const nodeStatusPollInterval = 150 * time.Millisecond

// localClient 는 bringUp 이 쓰는 부분만 좁힌 것이다. 진짜 백엔드 없이 대기 규칙을
// 검증할 수 있게 한다.
type localClient interface {
	Status(ctx context.Context) (*ipnstate.Status, error)
	EditPrefs(ctx context.Context, prefs *ipn.MaskedPrefs) (*ipn.Prefs, error)
}

// Status 는 등록 진행 상황을 보고한다. 설정 화면이 이걸 구독해 화면을 만든다.
//
// Dial 의 에러에 기대지 않는 이유가 있다. tsnet 의 awaitRunning 은 승인 대기 같은 상태를
// terminal 로 보고 "tsnet: backend in state NeedsMachineAuth" 같은 문자열로 뭉갠다.
// 사용자에게 보여줄 수 없는 형태라, 상태를 직접 읽어 우리 State 로 옮긴다.
func (n *tsnetNode) Status(ctx context.Context) (Status, error) {
	if err := n.ensureStarted(); err != nil {
		return Status{}, err
	}
	client, err := n.server.LocalClient()
	if err != nil {
		return Status{}, fmt.Errorf("tailnet: local client: %w", err)
	}
	state, err := client.Status(ctx)
	if err != nil {
		return Status{}, fmt.Errorf("tailnet: status: %w", err)
	}

	return statusFromBackend(state), nil
}

// statusFromBackend 는 tsnet 이 보고한 상태를 우리 Status 로 옮긴다.
//
// 순수 함수로 둔 이유는, 살아 있는 tailnet 없이는 검증할 방법이 없기 때문이다 — 계정 정보가
// 비어 나오는 버그를 실기기에서야 발견했다.
func statusFromBackend(state *ipnstate.Status) Status {
	if state == nil {
		return Status{State: StateStarting}
	}

	status := Status{
		State:   mapBackendState(state.BackendState),
		AuthURL: state.AuthURL,
	}

	// 누구로, 어느 tailnet 에 붙었는지. Tailscale 기본 서버는 설정이 전부 비어 있어서
	// 여러 개를 등록하면 화면상 구분이 안 된다 — 계정과 tailnet 이름이 유일한 단서다.
	if state.CurrentTailnet != nil {
		status.TailnetName = state.CurrentTailnet.Name
	}
	if state.Self != nil {
		status.Expired = state.Self.Expired
		// DNSName 은 끝에 점이 붙어 온다("host.tailnet.ts.net.").
		status.NodeName = strings.TrimSuffix(state.Self.DNSName, ".")
		if profile, ok := state.User[state.Self.UserID]; ok {
			status.LoginName = profile.LoginName
		}
	}
	if len(state.TailscaleIPs) > 0 {
		status.NodeIP = state.TailscaleIPs[0].String()
	}
	status.Peers = peersFromBackend(state)
	return status
}

// peersFromBackend 는 tailnet 안의 기기들과 그 경로를 옮긴다.
//
// 직결 판정은 CurAddr 이다 — 실제로 쓰는 엔드포인트가 정해져 있으면 직결이고, 비어 있으면
// 릴레이를 거친다. Relay 는 직결이어도 폴백 경로로 남아 채워지므로, 그것만 보고 릴레이라고
// 판단하면 안 된다.
func peersFromBackend(state *ipnstate.Status) []Peer {
	if len(state.Peer) == 0 {
		return nil
	}
	peers := make([]Peer, 0, len(state.Peer))
	for _, peer := range state.Peer {
		if peer == nil {
			continue
		}
		ips := make([]string, 0, len(peer.TailscaleIPs))
		for _, ip := range peer.TailscaleIPs {
			ips = append(ips, ip.String())
		}
		peers = append(peers, Peer{
			HostName: peer.HostName,
			DNSName:  strings.TrimSuffix(peer.DNSName, "."),
			IPs:      ips,
			Direct:   strings.TrimSpace(peer.CurAddr) != "",
			Relay:    peer.Relay,
			RxBytes:  peer.RxBytes,
			TxBytes:  peer.TxBytes,
		})
	}
	// 맵 순회 순서에 결과가 흔들리면 안 된다 — 화면에서 목록이 매 폴링마다 뒤바뀐다.
	sort.Slice(peers, func(a, b int) bool { return peers[a].DNSName < peers[b].DNSName })
	return peers
}

// mapBackendState 는 tsnet 의 상태 문자열을 우리 State 로 옮긴다. 모르는 값은 시작 중으로
// 본다 — 새 상태가 생겼을 때 "정지"로 표시해 사용자를 오도하는 것보다 낫다.
func mapBackendState(backend string) State {
	switch backend {
	case ipn.Running.String():
		return StateRunning
	case ipn.NeedsLogin.String():
		return StateNeedsAuth
	case ipn.NeedsMachineAuth.String():
		return StateNeedsApproval
	case ipn.Stopped.String():
		return StateStopped
	default:
		return StateStarting
	}
}

// Down 은 네트워킹만 끈다(tailscale down 상당). 등록과 노드키는 남으므로 다시 올릴 때
// 재인증이 없다.
func (n *tsnetNode) Down(ctx context.Context) error {
	// 기동한 적 없으면 이미 내려가 있는 것과 같다. 굳이 올렸다가 내리면 컨트롤 플레인에
	// 불필요한 등록이 생긴다.
	if !n.hasStarted() {
		return nil
	}
	client, err := n.server.LocalClient()
	if err != nil {
		return fmt.Errorf("tailnet: local client: %w", err)
	}
	_, err = client.EditPrefs(ctx, &ipn.MaskedPrefs{
		Prefs:          ipn.Prefs{WantRunning: false},
		WantRunningSet: true,
	})
	if err != nil {
		return fmt.Errorf("tailnet: bring down: %w", err)
	}
	return nil
}

// Logout 은 등록 자체를 버린다. 컨트롤 플레인이 노드를 지우므로 다음 기동은 처음부터
// 인증한다.
func (n *tsnetNode) Logout(ctx context.Context) error {
	// 기동한 적 없는 노드는 컨트롤 플레인에 존재하지 않는다. 로그아웃하려고 굳이 기동하면
	// 등록을 만들었다가 지우는 꼴이 된다.
	if !n.hasStarted() {
		return nil
	}
	client, err := n.server.LocalClient()
	if err != nil {
		return fmt.Errorf("tailnet: local client: %w", err)
	}
	if err := client.Logout(ctx); err != nil {
		return fmt.Errorf("tailnet: logout: %w", err)
	}
	return nil
}

// Close 는 서버를 해체한다. tsnet 의 Close 는 sync.Once 라 한 번 닫힌 인스턴스는 재사용할
// 수 없고, 그래서 레지스트리는 유예 만료에 Close 가 아니라 Down 을 쓴다.
func (n *tsnetNode) Close() error {
	n.mu.Lock()
	if n.closed {
		n.mu.Unlock()
		return nil
	}
	started := n.started
	n.closed = true
	n.mu.Unlock()

	// 기동한 적 없으면 닫을 것도 없다 — tsnet 의 Close 는 Start 가 만든 상태를 만지므로
	// 여기서 부르면 죽는다.
	if !started {
		return nil
	}

	if err := n.server.Close(); err != nil {
		// 이미 닫힌 서버를 닫는 건 오류가 아니다 — 등록 해제와 프로세스 종료가 겹치면
		// 자연스럽게 발생한다.
		if errors.Is(err, net.ErrClosed) {
			return nil
		}
		return fmt.Errorf("tailnet: close: %w", err)
	}
	return nil
}

func (n *tsnetNode) hasStarted() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.started
}

// Purge 는 상태 디렉터리를 지운다. Close 뒤에만 안전하다 — 그 전까지 tsnet 이 상태 파일을
// 열고 있다. 등록 해제 후 죽은 노드키를 디스크에 남기지 않기 위한 것이다.
func (n *tsnetNode) Purge() error {
	if err := os.RemoveAll(n.dir); err != nil {
		return fmt.Errorf("tailnet: purge state: %w", err)
	}
	return nil
}
