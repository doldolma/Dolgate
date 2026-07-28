package tailnet

import (
	"context"
	"net/netip"
	"sync"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
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

	status := statusFromBackend(state)

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
	})

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
	})

	if status.LoginName != "" {
		t.Errorf("LoginName = %q, want empty", status.LoginName)
	}
	if status.TailnetName != "gridwiz.com" || status.NodeName != "node.gridwiz.com" {
		t.Errorf("the rest should survive: %#v", status)
	}
}

func TestStatusFromBackendHandlesNil(t *testing.T) {
	if got := statusFromBackend(nil); got.State != StateStarting {
		t.Errorf("State = %q, want starting", got.State)
	}
}

// fakeLocalClient 는 백엔드 상태를 순서대로 돌려준다. 마지막 값은 계속 유지된다.
type fakeLocalClient struct {
	mu       sync.Mutex
	states   []string
	calls    int
	err      error
	editCall int
}

func (c *fakeLocalClient) EditPrefs(context.Context, *ipn.MaskedPrefs) (*ipn.Prefs, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.editCall += 1
	return nil, nil
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
