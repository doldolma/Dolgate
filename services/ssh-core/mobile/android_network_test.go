package mobile

import (
	"net"
	"strings"
	"testing"

	"tailscale.com/net/netmon"
)

// 안드로이드가 준 목록이 tailscale 이 기대하는 형태로 옮겨져야 한다. 여기서 틀리면 tailnet 이
// 조용히 안 뜨는데, 살아 있는 안드로이드 없이는 그 경로를 흘려볼 방법이 없다.
func TestParseAndroidInterfacesMapsTheList(t *testing.T) {
	interfaces, err := parseAndroidInterfaces(`[
		{"name":"wlan0","index":12,"mtu":1500,"up":true,"loopback":false,
		 "pointToPoint":false,"multicast":true,
		 "addrs":["192.168.0.24/24","fe80::1122:3344:5566:7788/64"]},
		{"name":"lo","index":1,"mtu":65536,"up":true,"loopback":true,
		 "pointToPoint":false,"multicast":false,"addrs":["127.0.0.1/8"]}
	]`)
	if err != nil {
		t.Fatalf("parseAndroidInterfaces() error = %v", err)
	}
	if len(interfaces) != 2 {
		t.Fatalf("interfaces = %d, want 2", len(interfaces))
	}

	wlan := interfaces[0]
	if wlan.Name != "wlan0" || wlan.Index != 12 || wlan.MTU != 1500 {
		t.Errorf("wlan0 = %#v", wlan.Interface)
	}
	if !wlan.IsUp() {
		t.Error("wlan0 이 up 으로 오지 않았다 — tailscale 은 이 플래그로 쓸 수 있는지 가린다")
	}
	if wlan.IsLoopback() {
		t.Error("wlan0 을 loopback 으로 표시했다")
	}
	if wlan.Flags&net.FlagMulticast == 0 {
		t.Error("multicast 플래그가 빠졌다")
	}
	if !interfaces[1].IsLoopback() {
		t.Error("lo 를 loopback 으로 표시하지 않았다")
	}

	// 주소는 prefix 길이까지 살아야 한다 — tailscale 이 같은 대역인지 판단하는 근거다.
	addrs, err := wlan.Addrs()
	if err != nil {
		t.Fatalf("Addrs() error = %v", err)
	}
	if len(addrs) != 2 {
		t.Fatalf("addrs = %#v, want 2", addrs)
	}
	if got := addrs[0].String(); got != "192.168.0.24/24" {
		t.Errorf("addrs[0] = %q", got)
	}
	if got := addrs[1].String(); !strings.HasSuffix(got, "/64") {
		t.Errorf("addrs[1] = %q — IPv6 prefix 를 잃었다", got)
	}
}

// AltAddrs 가 nil 이면 Addrs() 가 embedded net.Interface 로 내려가 다시 netlink 를 타고, 우리가
// 피하려던 그 EPERM 이 난다. 주소가 하나도 없는 인터페이스에서도 nil 이 아니어야 한다.
func TestParseAndroidInterfacesNeverLeavesAltAddrsNil(t *testing.T) {
	interfaces, err := parseAndroidInterfaces(`[{"name":"dummy0","index":3,"up":true,"addrs":[]}]`)
	if err != nil {
		t.Fatalf("parseAndroidInterfaces() error = %v", err)
	}
	if interfaces[0].AltAddrs == nil {
		t.Fatal("AltAddrs = nil — Addrs() 가 netlink 로 내려가 안드로이드에서 실패한다")
	}
}

// 기기마다 조회가 실패하는 인터페이스가 하나씩 있을 수 있다. 그것 때문에 목록 전체를 버리면
// tailnet 이 뜨지 않는다.
func TestParseAndroidInterfacesSkipsBadEntries(t *testing.T) {
	interfaces, err := parseAndroidInterfaces(`[
		{"name":"  ","index":9,"up":true,"addrs":["10.0.0.1/8"]},
		{"name":"wlan0","index":12,"up":true,"addrs":["192.168.0.24/24","not-an-address","10.1.2.3"]}
	]`)
	if err != nil {
		t.Fatalf("parseAndroidInterfaces() error = %v", err)
	}
	if len(interfaces) != 1 || interfaces[0].Name != "wlan0" {
		t.Fatalf("interfaces = %#v — 이름 없는 항목만 건너뛰어야 한다", interfaces)
	}
	addrs, _ := interfaces[0].Addrs()
	if len(addrs) != 1 {
		// prefix 없는 "10.1.2.3" 도 버린다 — 대역을 모르면 tailscale 이 쓸 수 없다.
		t.Errorf("addrs = %#v, want 1 — 못 읽는 주소만 건너뛰어야 한다", addrs)
	}
}

// 목록이 비면 tailscale 은 "네트워크를 모르는" 상태가 된다. 조용히 빈 목록을 넘기면 그 이유가
// 어디에도 남지 않는다.
func TestParseAndroidInterfacesRejectsAnEmptyList(t *testing.T) {
	for _, payload := range []string{`[]`, `[{"name":""}]`} {
		if _, err := parseAndroidInterfaces(payload); err == nil {
			t.Errorf("payload %q: 오류 없이 통과했다", payload)
		}
	}
	if _, err := parseAndroidInterfaces("not json"); err == nil {
		t.Error("깨진 JSON 이 오류 없이 통과했다")
	}
}

// fakeAndroidNetwork 는 안드로이드 쪽 provider 를 대신한다.
type fakeAndroidNetwork struct {
	interfaces   string
	defaultRoute string
	calls        int
}

func (f *fakeAndroidNetwork) Interfaces() string { f.calls += 1; return f.interfaces }

func (f *fakeAndroidNetwork) DefaultRouteInterface() string { return f.defaultRoute }

// 등록하면 tailscale 이 우리 목록을 쓰고, 기본 경로 이름도 같이 들어가야 한다.
//
// 안드로이드의 defaultRoute() 는 그 이름만 돌려주므로(interfaces_android.go), 넣어 주지 않으면
// 기본 경로가 영원히 빈 값이다.
func TestSetAndroidNetworkProviderFeedsTailscale(t *testing.T) {
	t.Cleanup(func() { netmon.RegisterInterfaceGetter(nil) })

	provider := &fakeAndroidNetwork{
		interfaces:   `[{"name":"wlan0","index":12,"mtu":1500,"up":true,"multicast":true,"addrs":["192.168.0.24/24"]}]`,
		defaultRoute: " wlan0 ",
	}
	NewEngine().SetAndroidNetworkProvider(provider)

	list, err := netmon.GetInterfaceList()
	if err != nil {
		t.Fatalf("GetInterfaceList() error = %v", err)
	}
	if provider.calls == 0 {
		t.Fatal("tailscale 이 provider 를 쓰지 않았다 — 등록이 안 됐다")
	}
	if len(list) != 1 || list[0].Name != "wlan0" {
		t.Fatalf("list = %#v", list)
	}

	if !defaultRouteTracked {
		// tailscale 이 이 플랫폼에서는 기본 경로를 들고 있지 않다
		// (android_defaultroute_stub.go). 여기서 DefaultRouteInterface 를 물으면 OS 의 실제
		// 경로가 오므로 단정할 것이 없다.
		return
	}
	route, err := netmon.DefaultRouteInterface()
	if err != nil {
		t.Fatalf("DefaultRouteInterface() error = %v", err)
	}
	if route != "wlan0" {
		t.Errorf("기본 경로 = %q, want wlan0(공백은 정리돼야 한다)", route)
	}
}

// nil 을 주면 아무것도 등록하지 않는다 — iOS 는 이 메서드를 부르지 않고, 실수로 nil 이 들어와도
// tailscale 의 기본 경로가 살아 있어야 한다.
func TestSetAndroidNetworkProviderIgnoresNil(t *testing.T) {
	NewEngine().SetAndroidNetworkProvider(nil)

	if _, err := netmon.GetInterfaceList(); err != nil {
		t.Fatalf("GetInterfaceList() error = %v — 기본 경로가 막혔다", err)
	}
}
