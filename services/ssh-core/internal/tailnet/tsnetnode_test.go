package tailnet

import (
	"net/netip"
	"testing"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
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
