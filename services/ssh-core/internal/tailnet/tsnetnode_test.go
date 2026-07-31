package tailnet

import (
	"context"
	"errors"
	"net/netip"
	"sync"
	"testing"
	"time"

	"tailscale.com/health"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/tsconst"
	"tailscale.com/types/empty"
	"tailscale.com/types/key"
)

// 붙고 나서 화면에 뭘 보여줄지는 전부 이 매핑에 달려 있다. 살아 있는 tailnet 없이는
// 검증할 수 없어서, 실기기에서 "연결됐는데 정보가 하나도 없다"로 발견됐다.
func TestStatusFromBackendCarriesTheAccountAndTailnet(t *testing.T) {
	state := &ipnstate.Status{
		BackendState:   ipn.Running.String(),
		CurrentTailnet: &ipnstate.TailnetStatus{Name: "gridwiz.com"},
		TailscaleIPs:   []netip.Addr{netip.MustParseAddr("100.101.102.103")},
		Self: &ipnstate.PeerStatus{
			UserID: tailcfg.UserID(7),
			// tsnet 은 끝에 점을 붙여 준다.
			DNSName: "dolgate-macbook.gridwiz.com.",
		},
		User: map[tailcfg.UserID]tailcfg.UserProfile{
			7: {ID: 7, LoginName: "dolma@gridwiz.com", DisplayName: "도영 허"},
		},
	}

	status := statusFromBackend(state, time.Now())

	if status.State != StateRunning {
		t.Errorf("State = %q, want running", status.State)
	}
	if status.TailnetName != "gridwiz.com" {
		t.Errorf("TailnetName = %q", status.TailnetName)
	}
	if status.LoginName != "dolma@gridwiz.com" {
		t.Errorf("LoginName = %q", status.LoginName)
	}
	if status.NodeName != "dolgate-macbook.gridwiz.com" {
		t.Errorf("NodeName = %q — the trailing dot must go", status.NodeName)
	}
	if status.NodeIP != "100.101.102.103" {
		t.Errorf("NodeIP = %q", status.NodeIP)
	}
}

// 아직 안 붙었으면 CurrentTailnet 이 nil 이고 Self 도 비어 있다. 그것 자체는 정상이다.
func TestStatusFromBackendBeforeConnecting(t *testing.T) {
	status := statusFromBackend(&ipnstate.Status{
		BackendState: ipn.NeedsLogin.String(),
		AuthURL:      "https://login.tailscale.com/a/abc",
	}, time.Now())

	if status.State != StateNeedsAuth {
		t.Errorf("State = %q, want needsAuth", status.State)
	}
	if status.AuthURL != "https://login.tailscale.com/a/abc" {
		t.Errorf("AuthURL = %q", status.AuthURL)
	}
	if status.TailnetName != "" || status.LoginName != "" || status.NodeName != "" || status.NodeIP != "" {
		t.Errorf("identity should be empty before connecting: %#v", status)
	}
}

// 계정 프로필이 안 실려 와도 나머지는 보여줄 수 있어야 한다.
func TestStatusFromBackendToleratesAMissingUserProfile(t *testing.T) {
	status := statusFromBackend(&ipnstate.Status{
		BackendState:   ipn.Running.String(),
		CurrentTailnet: &ipnstate.TailnetStatus{Name: "gridwiz.com"},
		Self:           &ipnstate.PeerStatus{UserID: tailcfg.UserID(7), DNSName: "node.gridwiz.com."},
	}, time.Now())

	if status.LoginName != "" {
		t.Errorf("LoginName = %q, want empty", status.LoginName)
	}
	if status.TailnetName != "gridwiz.com" || status.NodeName != "node.gridwiz.com" {
		t.Errorf("the rest should survive: %#v", status)
	}
}

func TestStatusFromBackendHandlesNil(t *testing.T) {
	if got := statusFromBackend(nil, time.Now()); got.State != StateStarting {
		t.Errorf("State = %q, want starting", got.State)
	}
}

// fakeLocalClient 는 백엔드 상태를 순서대로 돌려준다. 마지막 값은 계속 유지된다.
type fakeLocalClient struct {
	logins   int
	loginErr error
	mu       sync.Mutex
	states   []string
	calls    int
	err      error
	editCall int
	// lastPrefs 는 마지막으로 요청한 prefs 다. 무엇을 켜 달라고 했는지까지 봐야 한다 — 호출
	// 횟수만 세면 켜는 항목이 빠져도 테스트가 통과한다.
	lastPrefs *ipn.MaskedPrefs
}

func (c *fakeLocalClient) StartLoginInteractive(ctx context.Context) error {
	c.logins++
	return c.loginErr
}

func (c *fakeLocalClient) EditPrefs(_ context.Context, prefs *ipn.MaskedPrefs) (*ipn.Prefs, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.editCall += 1
	c.lastPrefs = prefs
	return nil, nil
}

func (c *fakeLocalClient) prefs() *ipn.MaskedPrefs {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastPrefs
}

func (c *fakeLocalClient) edits() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.editCall
}

func (c *fakeLocalClient) Status(context.Context) (*ipnstate.Status, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return nil, c.err
	}
	index := c.calls
	if index >= len(c.states) {
		index = len(c.states) - 1
	}
	c.calls += 1
	return &ipnstate.Status{BackendState: c.states[index]}, nil
}

func (c *fakeLocalClient) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

// 실기기에서 잡은 것: 첫 dial 이 "tsnet: backend in state NoState" 로 즉시 실패했다.
//
// Start 는 백엔드를 비동기로 띄우므로 돌아온 직후에는 아직 아무 상태도 없다. tsnet 의
// awaitRunning 은 NeedsLogin·Starting 만 기다리고 NoState 는 종료 상태로 보고 곧장 에러를
// 내므로, 상태가 나오기를 기다려 주지 않으면 자동 연결이 늘 그 창에서 깨진다.
func TestUpWaitsOutNoState(t *testing.T) {
	node := &tsnetNode{}
	client := &fakeLocalClient{states: []string{"NoState", "NoState", "Starting"}}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := node.awaitBackendReady(ctx, client); err != nil {
		t.Fatalf("awaitBackendReady() error = %v, want nil — NoState 는 기다려야 한다", err)
	}
	if got := client.count(); got < 3 {
		t.Errorf("Status() calls = %d, want at least 3 — 상태 전이를 따라가지 않았다", got)
	}
}

// Running 까지 기다리면 안 된다. 브라우저 로그인이 필요한 노드에서 이 함수가 인증이 끝날
// 때까지 갇히고, 그러면 설정 화면이 인증 URL 을 방출하지 못해 브라우저가 열리지 않는다 —
// 사용자에게는 "연결 중"에서 5 분째 멈춘 화면으로 보인다. 실제로 그렇게 깨졌다.
func TestUpDoesNotBlockOnAStateThatNeedsTheUser(t *testing.T) {
	for _, state := range []string{"NeedsLogin", "NeedsMachineAuth", "Starting", "Stopped"} {
		node := &tsnetNode{}
		client := &fakeLocalClient{states: []string{state}}

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err := node.awaitBackendReady(ctx, client)
		cancel()

		if err != nil {
			t.Errorf("state %s: awaitBackendReady() error = %v, want nil — 여기서 붙들면 안 된다", state, err)
		}
		if got := client.count(); got != 1 {
			t.Errorf("state %s: Status() calls = %d, want 1", state, got)
		}
	}
}

// 백엔드가 영원히 NoState 면 예산이 끝나고 실패해야 한다. 무한정 기다리면 연결 시도가
// 걸린 채 남는다.
func TestUpFailsIfTheBackendNeverReports(t *testing.T) {
	node := &tsnetNode{}
	client := &fakeLocalClient{states: []string{"NoState"}}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	if err := node.awaitBackendReady(ctx, client); err == nil {
		t.Fatal("awaitBackendReady() error = nil, want a timeout")
	}
}

// 빈 문자열도 "아직 보고 없음"이다. tsnet 이 상태를 채우기 전에 Status 가 돌아올 수 있다.
func TestBackendHasReportedTreatsEmptyAsNotYet(t *testing.T) {
	for _, notYet := range []string{"", "  ", "NoState"} {
		if backendHasReported(notYet) {
			t.Errorf("backendHasReported(%q) = true, want false", notYet)
		}
	}
	for _, reported := range []string{"NeedsLogin", "Starting", "Running", "Stopped"} {
		if !backendHasReported(reported) {
			t.Errorf("backendHasReported(%q) = false, want true", reported)
		}
	}
}

// 켜기와 기다리기는 함께 있어야 한다. 예전에는 WantRunning 만 켜고 곧바로 dial 로 넘어가서,
// 자동 연결이 늘 "backend in state NoState" 로 깨졌다.
func TestBringUpTurnsOnAndThenWaits(t *testing.T) {
	node := &tsnetNode{}
	client := &fakeLocalClient{states: []string{"NoState", "Starting"}}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := node.bringUp(ctx, client); err != nil {
		t.Fatalf("bringUp() error = %v", err)
	}
	if got := client.edits(); got != 1 {
		t.Errorf("EditPrefs calls = %d, want 1 — WantRunning 을 켜지 않았다", got)
	}
	if got := client.count(); got < 2 {
		t.Errorf("Status() calls = %d, want at least 2 — 올라오기를 기다리지 않았다", got)
	}

	prefs := client.prefs()
	if prefs == nil {
		t.Fatal("prefs 를 요청하지 않았다")
	}
	if !prefs.WantRunningSet || !prefs.WantRunning {
		t.Errorf("WantRunning 을 켜지 않았다: %#v", prefs)
	}
}

// 서브넷 라우터 뒤의 호스트로도 연결해야 한다.
//
// 이것이 없으면 tailnet 안의 기기만 닿는다 — 사내 10.x 같은 대역은 PeerForIP 조회가 실패해서
// 로컬 시스템 dialer 로 떨어지고, 그 대역을 지금 붙어 있는 랜에서 찾다가 timeout 난다.
//
// 마스크까지 본다. 값만 켜고 마스크를 빼면 EditPrefs 가 그 항목을 무시하므로 조용히 아무 일도
// 일어나지 않는다.
func TestBringUpAcceptsSubnetRoutes(t *testing.T) {
	node := &tsnetNode{}
	client := &fakeLocalClient{states: []string{"Starting"}}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := node.bringUp(ctx, client); err != nil {
		t.Fatalf("bringUp() error = %v", err)
	}

	prefs := client.prefs()
	if prefs == nil {
		t.Fatal("prefs 를 요청하지 않았다")
	}
	if !prefs.RouteAllSet {
		t.Error("RouteAll 마스크가 빠졌다 — EditPrefs 가 값을 무시한다")
	}
	if !prefs.RouteAll {
		t.Error("RouteAll 을 켜지 않았다 — 서브넷 라우터 뒤 호스트에 닿지 못한다")
	}
}

// 인증 링크는 상태에 안 실리고 버스로만 오는 경로가 있다(만료된 노드의 재인증). 그것을
// 갈무리하지 않으면 화면이 "링크를 받는 중" 에서 영원히 갇힌다.
func TestBusNotifyCapturesTheAuthURL(t *testing.T) {
	node := &tsnetNode{}
	url := "https://login.tailscale.com/a/abc123"

	node.applyNotify(&ipn.Notify{BrowseToURL: &url})

	if got := node.busAuthURLValue(); got != url {
		t.Fatalf("busAuthURL = %q, want %q", got, url)
	}
}

// 붙은 뒤에는 링크를 버려야 한다. 남겨 두면 이미 연결된 노드에 대해 낡은 링크를 계속 보고해서
// 화면이 인증을 다시 요구하는 것처럼 보인다.
func TestBusNotifyDropsTheAuthURLOnceLoggedIn(t *testing.T) {
	url := "https://login.tailscale.com/a/abc123"
	running := ipn.Running

	for _, tc := range []struct {
		name   string
		notify *ipn.Notify
	}{
		{"login finished", &ipn.Notify{LoginFinished: &empty.Message{}}},
		{"state running", &ipn.Notify{State: &running}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			node := &tsnetNode{}
			node.applyNotify(&ipn.Notify{BrowseToURL: &url})
			node.applyNotify(tc.notify)

			if got := node.busAuthURLValue(); got != "" {
				t.Fatalf("busAuthURL = %q, want empty", got)
			}
		})
	}
}

// 관계없는 알림은 링크를 건드리지 않아야 한다 — 사용자가 브라우저에서 로그인하는 동안 다른
// 알림이 계속 오는데, 그때 링크가 지워지면 누를 것이 사라진다.
func TestBusNotifyKeepsTheAuthURLWhileWaiting(t *testing.T) {
	node := &tsnetNode{}
	url := "https://login.tailscale.com/a/abc123"
	starting := ipn.Starting

	node.applyNotify(&ipn.Notify{BrowseToURL: &url})
	node.applyNotify(&ipn.Notify{State: &starting})
	node.applyNotify(&ipn.Notify{})

	if got := node.busAuthURLValue(); got != url {
		t.Fatalf("busAuthURL = %q, want it kept as %q", got, url)
	}
}

// 로그인이 거부된 사실은 버스로만 온다.
//
// 잘못된 auth key 를 넣으면 상태는 needsAuth + 링크 없음인데, 그것은 링크를 기다리는 것과 똑같다.
// 실측(v1.102.0)에서 정상 대기 중에는 이 경고가 아예 오지 않고, 키가 거부되면 2~3 초 안에 온다 —
// 그래서 이 신호가 둘을 가르는 유일한 값이다.
//
// 코드로 잡고 이유는 Args 에서 꺼낸다. 화면에 뜨는 영어 문장(Text)을 파싱하면 tailscale 문구가
// 바뀔 때 조용히 깨진다.
func TestBusNotifyCapturesTheLoginError(t *testing.T) {
	node := &tsnetNode{}

	node.applyNotify(&ipn.Notify{Health: &health.State{
		Warnings: map[health.WarnableCode]health.UnhealthyState{
			tsconst.HealthWarnableLoginState: {
				WarnableCode: tsconst.HealthWarnableLoginState,
				Text:         "You are logged out. The last login error was: invalid key",
				Args:         health.Args{health.ArgError: "invalid key: unable to validate API key"},
			},
		},
	}})

	if got := node.busLoginErrorValue(); got != "invalid key: unable to validate API key" {
		t.Fatalf("busLoginError = %q — Args 의 원인을 꺼내지 못했다", got)
	}
}

// 경고가 사라지면 함께 지운다. 버스는 매번 현재 경고 전체를 주므로 없는 것이 곧 정상이라는 뜻이다.
// 남겨 두면 로그인에 성공한 뒤에도 실패로 보고해서, 붙었는데 못 붙은 화면이 된다.
func TestBusNotifyClearsTheLoginErrorWhenHealthy(t *testing.T) {
	node := &tsnetNode{}
	node.setBusLoginError("invalid key: unable to validate API key")

	node.applyNotify(&ipn.Notify{Health: &health.State{}})

	if got := node.busLoginErrorValue(); got != "" {
		t.Fatalf("busLoginError = %q, want empty", got)
	}
}

// 컨트롤 플레인이 요청을 거부한 이유가 이 경로로만 오는 경우가 있다. 예전에는 알림을 받고도
// "뭔가 변했다" 로만 쓰고 내용을 버려서, 화면이 이유를 말할 수 없었다.
func TestBusNotifyCapturesTheBackendError(t *testing.T) {
	node := &tsnetNode{}
	message := "invalid key: unable to validate API key"

	node.applyNotify(&ipn.Notify{ErrMessage: &message})

	if got := node.busErrMessageValue(); got != message {
		t.Fatalf("busErrMessage = %q, want %q", got, message)
	}
}

func TestBusNotifyDistinguishesADeletedNodeFromAnOfflineNode(t *testing.T) {
	node := &tsnetNode{}
	node.applyNotify(&ipn.Notify{ControlError: &ipn.ControlError{
		Kind:       ipn.ControlErrorNodeNotFound,
		StatusCode: 400,
		Message:    "initial fetch failed 400: node not found",
	}})

	identityInvalid, message := node.busControlErrorValue()
	if !identityInvalid {
		t.Fatal("node-not-found control error did not mark the identity invalid")
	}
	if message == "" {
		t.Fatal("structured control error message was dropped")
	}

	status := mergeBusState(Status{State: StateRunning}, busState{
		identityInvalid: identityInvalid,
		controlError:    message,
	}, "")
	if !status.IdentityInvalid {
		t.Fatal("IdentityInvalid was not carried into Status")
	}
	if status.BackendError != message {
		t.Fatalf("BackendError = %q, want %q", status.BackendError, message)
	}

	// A successful map poll sends an empty structured error to clear the incident.
	node.applyNotify(&ipn.Notify{ControlError: new(ipn.ControlError)})
	identityInvalid, message = node.busControlErrorValue()
	if identityInvalid || message != "" {
		t.Fatalf("cleared control error remained: invalid=%v message=%q", identityInvalid, message)
	}
}

// 붙으면 지나간 오류를 버린다. 남겨 두면 멀쩡한 노드를 문제 있는 것으로 그린다.
func TestBusNotifyClearsTheBackendErrorOnceConnected(t *testing.T) {
	message := "invalid key: unable to validate API key"
	running := ipn.Running

	for _, tc := range []struct {
		name   string
		notify *ipn.Notify
	}{
		{"login finished", &ipn.Notify{LoginFinished: &empty.Message{}}},
		{"state running", &ipn.Notify{State: &running}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			node := &tsnetNode{}
			node.applyNotify(&ipn.Notify{ErrMessage: &message})
			node.applyNotify(tc.notify)

			if got := node.busErrMessageValue(); got != "" {
				t.Fatalf("busErrMessage = %q, want empty", got)
			}
		})
	}
}

// 다른 경고(기동 중 등)는 로그인 실패가 아니다. 그것으로 실패를 내면 정상 연결이 시작하자마자
// 끊긴다 — 실측에서 warming-up 이 login-state 와 같이 오는 구간이 있었다.
func TestBusNotifyIgnoresUnrelatedHealthWarnings(t *testing.T) {
	node := &tsnetNode{}

	node.applyNotify(&ipn.Notify{Health: &health.State{
		Warnings: map[health.WarnableCode]health.UnhealthyState{
			"warming-up": {Text: "Tailscale is starting. Please wait."},
		},
	}})

	if got := node.busLoginErrorValue(); got != "" {
		t.Fatalf("busLoginError = %q, want empty", got)
	}
}

// 경로 판정의 기준은 CurAddr 이다. Relay 는 직결이어도 폴백으로 남아 채워지므로, 그것만
// 보고 릴레이라고 판단하면 직결인 연결을 릴레이로 표시하게 된다.
func TestPeersFromBackendJudgesDirectByCurAddr(t *testing.T) {
	state := &ipnstate.Status{
		Peer: map[key.NodePublic]*ipnstate.PeerStatus{
			key.NewNode().Public(): {
				HostName: "agt-1",
				DNSName:  "agt-1.example.ts.net.",
				CurAddr:  "100.64.0.9:41641",
				Relay:    "sel",
				RxBytes:  4096,
			},
			key.NewNode().Public(): {
				HostName: "agt-2",
				DNSName:  "agt-2.example.ts.net.",
				CurAddr:  "",
				Relay:    "sel",
			},
		},
	}

	peers := peersFromBackend(state)
	if len(peers) != 2 {
		t.Fatalf("peersFromBackend() = %d peers, want 2", len(peers))
	}

	// DNSName 순으로 정렬된다 — 폴링마다 목록이 뒤바뀌면 화면에서 읽을 수 없다.
	if peers[0].HostName != "agt-1" || peers[1].HostName != "agt-2" {
		t.Fatalf("peers not sorted by DNS name: %+v", peers)
	}
	if !peers[0].Direct {
		t.Error("peer with a CurAddr should be direct")
	}
	if peers[1].Direct {
		t.Error("peer without a CurAddr is relayed, even though Relay is set on both")
	}
	// FQDN 의 끝점은 떼어 둔다. 호스트 레코드의 주소와 그대로 맞춰야 한다.
	if peers[0].DNSName != "agt-1.example.ts.net" {
		t.Errorf("DNSName = %q, want the trailing dot stripped", peers[0].DNSName)
	}
	if peers[0].RxBytes != 4096 {
		t.Errorf("RxBytes = %d, want 4096", peers[0].RxBytes)
	}
}

// 컨트롤 플레인에서 노드를 만료시켜도 Self.Expired 는 실측에서 켜지지 않았다. 그래서 키 만료
// 시각도 같이 보는데, 그 판정이 실제로 "만료" 로 이어지는지가 여기서 지켜지는 것이다 —
// 화면은 이 값이 확실할 때만 만료라고 단정하고, 아니면 확인할 곳만 알린다.
func TestStatusFromBackendTreatsAPastKeyExpiryAsExpired(t *testing.T) {
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	past := now.Add(-time.Hour)

	status := statusFromBackend(&ipnstate.Status{
		BackendState: ipn.Running.String(),
		Self:         &ipnstate.PeerStatus{Expired: false, KeyExpiry: &past},
	}, now)

	if !status.Expired {
		t.Error("a key expiry in the past means the registration is expired")
	}
}

// 반대 방향으로는 절대 켜지지 않아야 한다. 멀쩡한 노드를 만료라고 쓰면, 사용자는 있지도 않은
// 재인증을 하러 간다.
func TestStatusFromBackendKeepsAValidKeyUnexpired(t *testing.T) {
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	future := now.Add(180 * 24 * time.Hour)
	zero := time.Time{}

	for name, self := range map[string]*ipnstate.PeerStatus{
		"expiry in the future": {KeyExpiry: &future},
		"expiry unknown":       {KeyExpiry: nil},
		// 모르는 값이 제로로 올 수도 있다. 그것을 "1년 0월 0일에 만료" 로 읽으면 모든 노드가
		// 만료가 된다.
		"expiry zero": {KeyExpiry: &zero},
	} {
		t.Run(name, func(t *testing.T) {
			status := statusFromBackend(&ipnstate.Status{
				BackendState: ipn.Running.String(),
				Self:         self,
			}, now)

			if status.Expired {
				t.Errorf("%s must not read as expired", name)
			}
		})
	}
}

// 백엔드가 만료라고 말하면 키 만료 시각과 무관하게 만료다.
func TestStatusFromBackendKeepsBackendExpiredFlag(t *testing.T) {
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	future := now.Add(time.Hour)

	status := statusFromBackend(&ipnstate.Status{
		BackendState: ipn.Running.String(),
		Self:         &ipnstate.PeerStatus{Expired: true, KeyExpiry: &future},
	}, now)

	if !status.Expired {
		t.Error("Self.Expired must survive")
	}
}

// tsnet 의 Start 는 ctx 를 받지 않고, 네트워크가 없으면 돌아오지 않는다. 그것을 그대로 기다리면
// 사용자가 취소를 눌러도 아무 일이 없다 — 취소는 ctx 를 끊는데 그 호출은 그것을 보지 못한다.
func TestStartWithCancelGivesUpWhenCancelled(t *testing.T) {
	blocked := make(chan struct{})
	t.Cleanup(func() { close(blocked) })

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- startWithCancel(ctx, func() error {
			<-blocked // 네트워크가 없어 돌아오지 않는 Start 를 흉내낸다.
			return nil
		})
	}()

	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("취소했는데 돌아오지 않았다 — 네트워크가 없으면 여기서 영원히 갇힌다")
	}
}

// 평소에는 기동 결과를 그대로 돌려줘야 한다. 취소 처리를 붙이면서 성공·실패를 삼키면 안 된다.
func TestStartWithCancelPassesTheResultThrough(t *testing.T) {
	if err := startWithCancel(context.Background(), func() error { return nil }); err != nil {
		t.Errorf("err = %v, want nil", err)
	}

	failure := errors.New("no network interfaces")
	err := startWithCancel(context.Background(), func() error { return failure })
	if !errors.Is(err, failure) {
		t.Errorf("err = %v, want it to wrap the start failure", err)
	}
}
