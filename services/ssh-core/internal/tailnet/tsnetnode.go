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

	"tailscale.com/health"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsconst"
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
	// OnNotify 는 백엔드가 상태 변화를 푸시했을 때 불린다(IPN 버스).
	//
	// 폴링 대신 이것으로 반응한다 — 만료·인증 필요·링크 발급은 모두 백엔드가 알려 주는
	// 사건이라, 주기적으로 물어볼 이유가 없다. 버스 goroutine 에서 불리므로 오래 걸리는 일을
	// 그 자리에서 하면 알림 수신이 밀린다. 받는 쪽이 별도 goroutine 으로 넘겨야 한다.
	OnNotify func()
}

// tsnetNode 는 tsnet.Server 로 Node 를 구현한다.
type tsnetNode struct {
	server *tsnet.Server
	dir    string
	// onNotify 는 백엔드가 상태 변화를 푸시했을 때 알린다. 폴링을 대신한다.
	onNotify func()

	mu      sync.Mutex
	started bool
	closed  bool

	// busAuthURL 은 IPN 버스가 푸시한 인증 링크다.
	//
	// 폴링만으로는 이 링크를 놓친다. 이미 떠 있는 노드의 키가 만료되면 백엔드는 링크를
	// Notify.BrowseToURL 로만 통보하는 경로가 있고(popBrowserAuthNow → tellRecipientToBrowseToURL),
	// 그 경우 Status 를 아무리 읽어도 빈 값이다 — 화면은 "링크를 받는 중" 에서 갇힌다.
	// 버스를 구독해 여기 담아 두고 Status 가 합쳐서 보고한다.
	busAuthURL string
	// busLoginError 는 백엔드가 확정한 로그인 실패 이유다(health 의 login-state 경고).
	//
	// Status 로는 알 수 없기 때문에 버스에서 받는다. 잘못된 auth key 도 상태는 needsAuth +
	// 링크 없음이어서, 링크를 기다리는 것과 구분할 방법이 이것뿐이다. 경고가 사라지면 함께
	// 지운다 — 버스는 매번 현재 경고 전체를 주므로 그 판단이 여기서 가능하다.
	busLoginError string
	// busErrMessage 는 백엔드가 마지막으로 보고한 오류다(Notify.ErrMessage).
	//
	// 컨트롤 플레인이 우리 요청을 거부한 이유가 이 경로로 온다. 붙으면 지운다 — 지나간 오류를
	// 계속 보고하면 화면이 멀쩡한 노드를 문제 있는 것으로 그린다.
	busErrMessage string
	// busIdentityInvalid 는 컨트롤 플레인이 이 노드 identity 를 찾을 수 없다고 구조적으로
	// 보고했는지다. 일반적인 map poll 중단과 분리해서 자동 재등록의 유일한 근거로 쓴다.
	busIdentityInvalid bool
	busControlError    string
	busStarted         bool
	busCancel          context.CancelFunc

	// reauthStarted 는 지금의 인증 대기 구간에서 이미 대화형 로그인을 개시했는지다. 표시가
	// 노드에 붙어 있는 것이 핵심이다 — 연결 시도는 여러 번 새로 생기지만(SSH 재연결·사용자
	// 재시도) 그때마다 개시하면 컨트롤 플레인이 새 링크를 발급하며 앞 링크를 무효화해,
	// 브라우저에서 로그인하던 사람이 끝낼 수 없게 된다. 붙으면 Status 가 표시를 지운다.
	reauthStarted bool
}

// ensureStarted 는 서버를 기동하고 그 사실을 기록한다.
//
// 기록이 필요한 이유는 Close 때문이다. tsnet 의 Close 는 Start 가 만든 내부 상태를
// 건드리므로 한 번도 기동하지 않은 서버에 부르면 nil 역참조로 죽는다. tailnet 을 설정만
// 해두고 한 번도 연결하지 않은 채 등록 해제하는 것은 충분히 흔한 경로다.
//
// Start 자체는 멱등이라 여러 번 불러도 문제없다.
func (n *tsnetNode) ensureStarted(ctx context.Context) error {
	n.mu.Lock()
	if n.closed {
		n.mu.Unlock()
		return errors.New("tailnet: node is closed")
	}
	n.mu.Unlock()

	if err := startWithCancel(ctx, n.server.Start); err != nil {
		return err
	}

	n.mu.Lock()
	n.started = true
	n.mu.Unlock()
	n.startBusWatch()
	return nil
}

// startBusWatch 는 IPN 버스 구독을 한 번 띄운다. 노드 수명과 함께 살아 있어야 한다 —
// 연결 시도 하나에 묶으면 시도가 끝날 때 구독이 끊겨, 그 뒤에 오는 링크를 놓친다.
func (n *tsnetNode) startBusWatch() {
	n.mu.Lock()
	if n.busStarted || n.closed {
		n.mu.Unlock()
		return
	}
	n.busStarted = true
	ctx, cancel := context.WithCancel(context.Background())
	n.busCancel = cancel
	n.mu.Unlock()

	go n.watchBus(ctx)
	if strings.TrimSpace(n.server.ControlURL) != "" {
		go n.watchIdentity(ctx)
	}
}

const (
	identityProbeInterval = 30 * time.Second
	identityProbeTimeout  = 5 * time.Second
)

// watchIdentity compensates for control servers that keep an old streaming map
// response open after deleting the current node. The probe is a normal
// non-streaming map update and cannot create another control-plane node.
func (n *tsnetNode) watchIdentity(ctx context.Context) {
	ticker := time.NewTicker(identityProbeInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			probeCtx, cancel := context.WithTimeout(ctx, identityProbeTimeout)
			_ = n.ProbeIdentity(probeCtx)
			cancel()
		}
	}
}

// watchBus 는 백엔드가 푸시하는 알림을 받아 인증 링크를 갈무리한다.
//
// 구독이 끊기면 다시 붙는다. 조용히 포기하면 폴링만 남아 이 수정이 무의미해진다.
func (n *tsnetNode) watchBus(ctx context.Context) {
	for ctx.Err() == nil {
		if n.consumeBus(ctx) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(busWatchRetryInterval):
		}
	}
}

// consumeBus 는 구독 하나를 소비한다. 더 시도할 이유가 없으면 true 를 돌려준다.
func (n *tsnetNode) consumeBus(ctx context.Context) (done bool) {
	client, err := n.server.LocalClient()
	if err != nil {
		return false
	}
	watcher, err := client.WatchIPNBus(ctx, ipn.NotifyInitialState)
	if err != nil {
		return false
	}
	defer watcher.Close()

	for {
		notify, err := watcher.Next()
		if err != nil {
			// ctx 가 끝났으면 노드가 닫힌 것이므로 더 붙지 않는다.
			return ctx.Err() != nil
		}
		n.applyNotify(&notify)
	}
}

// applyNotify 는 알림 하나를 인증 링크 상태에 반영한다.
//
// 규칙을 여기 모아 둔 이유는 검증 때문이다 — 살아 있는 백엔드 없이는 버스를 흘려볼 수 없다.
func (n *tsnetNode) applyNotify(notify *ipn.Notify) {
	if notify == nil {
		return
	}
	changed := false
	if notify.BrowseToURL != nil {
		n.setBusAuthURL(strings.TrimSpace(*notify.BrowseToURL))
		changed = true
	}
	// 로그인이 끝났으면 링크는 쓸모가 없다. 남겨 두면 이미 붙은 노드에 대해 낡은 링크를
	// 계속 보고해서, 화면이 인증을 다시 요구하는 것처럼 보인다.
	if notify.LoginFinished != nil {
		n.setBusAuthURL("")
		n.setBusErrMessage("")
		changed = true
	}
	if notify.State != nil {
		if *notify.State == ipn.Running {
			n.setBusAuthURL("")
			n.setBusErrMessage("")
		}
		changed = true
	}
	// 로그인이 확정적으로 실패했는지. 버스는 현재 경고 전체를 주므로, 경고가 없으면 지운다.
	//
	// 코드로 본다. 화면에 뜨는 영어 문장을 파싱하면 tailscale 문구가 바뀔 때 조용히 깨진다 —
	// 그 문장은 이 경고의 Text 이고, 우리가 쓸 것은 Args 에 들어 있는 원인이다.
	if notify.Health != nil {
		if warning, ok := notify.Health.Warnings[tsconst.HealthWarnableLoginState]; ok {
			n.setBusLoginError(strings.TrimSpace(warning.Args[health.ArgError]))
		} else {
			n.setBusLoginError("")
		}
		changed = true
	}

	// 오류는 내용을 쓴다. 예전에는 "뭔가 변했다" 로만 쓰고 버렸는데, 컨트롤 플레인이 거부한
	// 이유가 여기로만 오는 경우가 있어서 그러면 화면이 이유를 말할 수 없다.
	if notify.ErrMessage != nil {
		n.setBusErrMessage(strings.TrimSpace(*notify.ErrMessage))
		changed = true
	}
	if notify.ControlError != nil {
		n.setBusControlError(
			notify.ControlError.Kind == ipn.ControlErrorNodeNotFound,
			strings.TrimSpace(notify.ControlError.Message),
		)
		changed = true
	}

	// 넷맵도 판정에 영향을 준다 — 만료는 새 넷맵이 올 때 드러난다.
	if notify.NetMap != nil {
		changed = true
	}

	if changed && n.onNotify != nil {
		n.onNotify()
	}
}

// mergeBusState 는 버스에서 받아 둔 것을 상태에 합치고, 밖으로 나갈 문장에서 키를 가린다.
//
// 순수 함수로 둔 이유는 검증이다 — 살아 있는 백엔드 없이는 Status 를 통째로 흘려볼 수 없어서,
// 합치는 것을 빠뜨렸는지 가리는 것을 빠뜨렸는지 여기서만 확인할 수 있다.
// busState 는 버스에서 받아 둔 값들이다. 인자를 늘리는 대신 묶어서, 어느 값이 어디로 가는지
// 호출부에서 헷갈리지 않게 한다.
type busState struct {
	authURL         string
	loginError      string
	backendError    string
	controlError    string
	identityInvalid bool
}

func mergeBusState(status Status, bus busState, authKey string) Status {
	// 링크가 상태에 없으면 버스가 받아 둔 것을 쓴다. 만료된 노드의 재인증 링크는 이 경로로만
	// 오는 경우가 있어서, 이 합침이 없으면 화면이 링크를 영원히 기다린다.
	if status.AuthURL == "" && bus.authURL != "" {
		status.AuthURL = bus.authURL
	}

	// 로그인 실패는 버스로만 온다. Health 에는 같은 내용이 영어 문장으로 들어 있지만, 판정에 쓸
	// 값은 원인 그대로다.
	//
	// 키가 틀렸다는 오류에는 컨트롤 플레인이 **키를 실어** 보낸다. 이 값과 Health 는 그대로 화면까지
	// 올라가고 로그·스크린샷에도 남으므로, 코어 밖으로 나가는 이 자리에서 가린다.
	status.LoginError = redactAuthKey(bus.loginError, authKey)
	status.BackendError = redactAuthKey(bus.backendError, authKey)
	if status.BackendError == "" {
		status.BackendError = redactAuthKey(bus.controlError, authKey)
	}
	status.IdentityInvalid = bus.identityInvalid
	if len(status.Health) > 0 {
		// 새 슬라이스에 담는다. 원본은 백엔드가 들고 있는 것이라 제자리에서 고치면 안 된다.
		redacted := make([]string, 0, len(status.Health))
		for _, warning := range status.Health {
			redacted = append(redacted, redactAuthKey(warning, authKey))
		}
		status.Health = redacted
	}
	return status
}

func (n *tsnetNode) setBusErrMessage(message string) {
	n.mu.Lock()
	n.busErrMessage = message
	n.mu.Unlock()
}

func (n *tsnetNode) busErrMessageValue() string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.busErrMessage
}

func (n *tsnetNode) setBusControlError(identityInvalid bool, message string) {
	n.mu.Lock()
	n.busIdentityInvalid = identityInvalid
	n.busControlError = message
	n.mu.Unlock()
}

func (n *tsnetNode) busControlErrorValue() (identityInvalid bool, message string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.busIdentityInvalid, n.busControlError
}

func (n *tsnetNode) setBusLoginError(reason string) {
	n.mu.Lock()
	n.busLoginError = reason
	n.mu.Unlock()
}

func (n *tsnetNode) busLoginErrorValue() string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.busLoginError
}

func (n *tsnetNode) setBusAuthURL(url string) {
	n.mu.Lock()
	n.busAuthURL = url
	n.mu.Unlock()
}

func (n *tsnetNode) busAuthURLValue() string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.busAuthURL
}

// busWatchRetryInterval 은 끊긴 버스 구독을 다시 붙기 전 간격이다.
const busWatchRetryInterval = time.Second

// startWithCancel 은 기동을 기다리되 취소되면 그 이유로 돌아간다.
//
// tsnet 의 Start 는 ctx 를 받지 않고, 네트워크가 없으면 돌아오지 않는다. 그대로 기다리면
// 사용자가 취소를 눌러도 아무 일이 없다 — 취소는 ctx 를 끊는데 그 호출은 그것을 보지 못한다.
//
// 남은 고루틴은 Start 가 끝나면 스스로 사라진다. 그 노드는 어차피 닫히므로 결과를 쓸 일이 없다.
func startWithCancel(ctx context.Context, start func() error) error {
	started := make(chan error, 1)
	go func() { started <- start() }()

	select {
	case err := <-started:
		if err != nil {
			return fmt.Errorf("tailnet: start: %w", err)
		}
		return nil
	case <-ctx.Done():
		return fmt.Errorf("tailnet: start: %w", ctx.Err())
	}
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
		dir:      config.Dir,
		onNotify: config.OnNotify,
	}, nil
}

// ProbeIdentity asks a custom control server to validate the persisted node key
// with a fresh map request. Network and server failures remain ordinary probe
// errors; only a structured node-not-found response updates IdentityInvalid.
func (n *tsnetNode) ProbeIdentity(ctx context.Context) error {
	if strings.TrimSpace(n.server.ControlURL) == "" {
		return nil
	}
	if err := n.ensureStarted(ctx); err != nil {
		return err
	}
	controlErr, err := n.server.ProbeControlMap(ctx)
	if controlErr != nil {
		n.applyNotify(&ipn.Notify{ControlError: controlErr})
	}
	return err
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
	if err := n.ensureStarted(ctx); err != nil {
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
		Prefs: ipn.Prefs{
			WantRunning: true,
			// 서브넷 라우터가 광고한 경로도 받는다(tailscale 의 --accept-routes).
			//
			// 이것이 없으면 tailnet 안의 기기만 닿는다. 서브넷 라우터 뒤에 있는 호스트(사내
			// 10.x 같은 대역)는 PeerForIP 조회가 실패해서 **로컬 시스템 dialer** 로 떨어지고,
			// 그 대역을 지금 붙어 있는 랜에서 찾다가 timeout 난다.
			//
			// 유저스페이스라 켜도 기기에는 영향이 없다. tsnet 은 TUN 도, OS 라우팅 테이블도,
			// OS DNS 도 쓰지 않는다(dns.noopManager) — 이 pref 는 우리 netstack 이 어느 대역을
			// 받아들일지만 바꾸므로, 효과가 이 노드의 Dial 안에서 끝난다. 일반 Tailscale
			// 클라이언트의 --accept-routes 가 OS 경로를 고쳐 쓰는 것과 다른 점이다.
			//
			// 기본 경로(0.0.0.0/0)는 받지 않는다. routemanager 는 이 pref 를 "advertised subnet
			// routes (non-exit routes)" 에만 적용하고, exit 경로는 exit node 로 선택된 피어에만
			// 쓴다 — 그래서 일반 인터넷 연결이 tailnet 으로 빨려가지 않는다.
			RouteAll: true,
		},
		WantRunningSet: true,
		RouteAllSet:    true,
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

// localClient 는 bringUp·startLogin 이 쓰는 부분만 좁힌 것이다. 진짜 백엔드 없이 대기
// 규칙과 로그인 개시 규칙을 검증할 수 있게 한다.
type localClient interface {
	Status(ctx context.Context) (*ipnstate.Status, error)
	EditPrefs(ctx context.Context, prefs *ipn.MaskedPrefs) (*ipn.Prefs, error)
	StartLoginInteractive(ctx context.Context) error
}

// Reauth 는 인증이 필요한 노드의 대화형 로그인을 개시한다.
//
// 기동 경로와 갈리기 때문에 필요하다. 노드를 새로 기동하면 Start 가 등록을 처음부터 밟아
// 링크가 곧 나온다. 반면 **이미 떠 있는** 노드의 키가 만료되면 backend 는 NeedsLogin 이지만
// WantRunning 을 다시 켜는 것으로는 로그인이 시작되지 않는다 — 개시해 주지 않으면 백엔드가
// 자기 백오프 일정으로 재로그인할 때까지(수 분) 링크가 나오지 않는다.
//
// 링크는 Status 에 실리지 않고 IPN 버스로만 오는 경로가 있어서, 이 호출은 버스 구독
// (startBusWatch)과 함께여야 의미가 있다. 둘 중 하나만으로는 화면이 링크를 받지 못한다.
func (n *tsnetNode) Reauth(ctx context.Context) error {
	if err := n.ensureStarted(ctx); err != nil {
		return err
	}
	client, err := n.server.LocalClient()
	if err != nil {
		return fmt.Errorf("tailnet: local client: %w", err)
	}
	return n.startLogin(ctx, client)
}

// startLogin 은 인증 대기 구간마다 한 번만 실제로 개시한다. 실패하면 표시를 되돌려 다음
// 요청이 다시 시도할 수 있게 한다.
func (n *tsnetNode) startLogin(ctx context.Context, client localClient) error {
	n.mu.Lock()
	if n.closed {
		n.mu.Unlock()
		return errors.New("tailnet: node is closed")
	}
	if n.reauthStarted {
		n.mu.Unlock()
		return nil
	}
	n.reauthStarted = true
	n.mu.Unlock()

	if err := client.StartLoginInteractive(ctx); err != nil {
		n.clearReauth()
		return fmt.Errorf("tailnet: start login: %w", err)
	}
	return nil
}

func (n *tsnetNode) clearReauth() {
	n.mu.Lock()
	n.reauthStarted = false
	n.mu.Unlock()
}

// Status 는 등록 진행 상황을 보고한다. 설정 화면이 이걸 구독해 화면을 만든다.
//
// Dial 의 에러에 기대지 않는 이유가 있다. tsnet 의 awaitRunning 은 승인 대기 같은 상태를
// terminal 로 보고 "tsnet: backend in state NeedsMachineAuth" 같은 문자열로 뭉갠다.
// 사용자에게 보여줄 수 없는 형태라, 상태를 직접 읽어 우리 State 로 옮긴다.
func (n *tsnetNode) Status(ctx context.Context) (Status, error) {
	if err := n.ensureStarted(ctx); err != nil {
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

	identityInvalid, controlError := n.busControlErrorValue()
	status := mergeBusState(
		statusFromBackend(state, time.Now()),
		busState{
			authURL:         n.busAuthURLValue(),
			loginError:      n.busLoginErrorValue(),
			backendError:    n.busErrMessageValue(),
			controlError:    controlError,
			identityInvalid: identityInvalid,
		},
		n.server.AuthKey,
	)
	// 붙었으면 남은 링크와 개시 표시를 버린다(버스 알림을 놓친 경우의 안전망). 표시를 남기면
	// 다음에 다시 만료됐을 때 아무도 재인증을 개시해 주지 못한다.
	if status.State == StateRunning && !status.Expired {
		n.setBusAuthURL("")
		n.clearReauth()
	}
	return status, nil
}

// statusFromBackend 는 tsnet 이 보고한 상태를 우리 Status 로 옮긴다.
//
// 순수 함수로 둔 이유는, 살아 있는 tailnet 없이는 검증할 방법이 없기 때문이다 — 계정 정보가
// 비어 나오는 버그를 실기기에서야 발견했다. now 를 받는 것도 같은 이유다(키 만료 판정).
func statusFromBackend(state *ipnstate.Status, now time.Time) Status {
	if state == nil {
		return Status{State: StateStarting}
	}

	status := Status{
		State:        mapBackendState(state.BackendState),
		AuthURL:      state.AuthURL,
		BackendState: state.BackendState,
		Health:       state.Health,
	}

	// 누구로, 어느 tailnet 에 붙었는지. Tailscale 기본 서버는 설정이 전부 비어 있어서
	// 여러 개를 등록하면 화면상 구분이 안 된다 — 계정과 tailnet 이름이 유일한 단서다.
	if state.CurrentTailnet != nil {
		status.TailnetName = state.CurrentTailnet.Name
	}
	if state.Self != nil {
		// ipnlocal 이 이 값을 health.GetInPollNetMap() 으로 채운다 — 지금 컨트롤 플레인과
		// map poll 중인가. 만료되면 컨트롤 플레인이 그 세션을 끊으므로 여기서 드러난다.
		status.Online = state.Self.Online
		status.Expired = state.Self.Expired
		// Self.Expired 만으로는 부족하다 — 컨트롤 플레인에서 노드를 만료시켜도 실측에서
		// 켜지지 않았다. 키 만료 시각이 이미 지난 것도 만료의 확정 신호이므로 같이 본다.
		// 이 방향으로만 켜는 것이 안전하다: 살아 있는 노드의 만료 시각은 미래이고, 넷맵이
		// 낡았다면 예전의 미래 값이 남아 있어서 거짓 양성이 되지 않는다.
		if !status.Expired && keyExpired(state.Self.KeyExpiry, now) {
			status.Expired = true
		}
		if state.Self.KeyExpiry != nil && !state.Self.KeyExpiry.IsZero() {
			status.KeyExpiry = state.Self.KeyExpiry.Format(time.RFC3339)
		}
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

// keyExpired 는 노드 키의 만료 시각이 이미 지났는지다.
//
// 시각을 모르면(nil, 또는 제로) 판정하지 않는다 — 모르는 것을 만료로 읽으면 멀쩡한 노드를
// 만료라고 단정해 버린다. 화면은 확실할 때만 "만료" 라고 쓴다.
func keyExpired(expiry *time.Time, now time.Time) bool {
	return expiry != nil && !expiry.IsZero() && expiry.Before(now)
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
	busCancel := n.busCancel
	n.busCancel = nil
	n.mu.Unlock()

	// 버스 구독을 먼저 접는다. 서버를 닫는 중에 구독이 살아 있으면 무의미한 재접속을 돈다.
	if busCancel != nil {
		busCancel()
	}

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
