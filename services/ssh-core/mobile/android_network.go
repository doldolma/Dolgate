package mobile

// 안드로이드에서는 Go 가 네트워크 인터페이스를 스스로 조회할 수 없다.
//
// SDK 30 부터 SELinux 가 앱의 NETLINK_ROUTE 소켓 bind 를 막는다. Go 의 net.Interfaces() 는 그
// 소켓으로 커널 라우팅 테이블을 읽으므로 EPERM 이 나고, tsnet 은 기동할 때 인터페이스 목록이
// 필요해서 아예 뜨지 못한다:
//
//	tailnet: start: tsnet: route ip+net: netlinkrib: permission denied
//
// tailscale 이 아는 제약이고(net/netmon 주석이 tailscale#2293 을 인용) 대신 훅을 준다 — 목록과
// 기본 경로를 앱이 넣어 주면 된다. Java 의 NetworkInterface 는 다른 경로를 쓰기 때문에 그쪽에서는
// 조회가 허용된다. 이 파일이 그 두 훅을 채우는 자리다.
//
// iOS 에는 이 제한이 없다. SetAndroidNetworkProvider 를 부르지 않으면 tailscale 은 평소처럼
// net.Interfaces() 를 쓰므로, 이 파일은 안드로이드에서만 관여한다.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"

	"tailscale.com/net/netmon"
)

// AndroidNetworkProvider 는 안드로이드 쪽이 네트워크 사실을 알려 주는 통로다.
//
// gomobile 을 지나야 하므로 문자열만 주고받는다(TailnetEventListener 와 같은 방식). 한 번 찍은
// 스냅샷이 아니라 콜백이어야 한다 — tailscale 은 링크가 바뀔 때마다 다시 물어본다.
type AndroidNetworkProvider interface {
	// Interfaces 는 인터페이스 목록의 JSON 이다. 형태는 androidInterface 를 보라.
	Interfaces() string
	// DefaultRouteInterface 는 지금 기본 경로로 나가는 인터페이스 이름이다. 네트워크가 없으면
	// 빈 문자열이다.
	DefaultRouteInterface() string
}

// androidInterface 는 Java 가 보내는 인터페이스 하나의 형태다.
//
//	{"name":"wlan0","index":12,"mtu":1500,"up":true,"loopback":false,
//	 "pointToPoint":false,"multicast":true,"addrs":["192.168.0.24/24","fe80::1/64"]}
type androidInterface struct {
	Name         string `json:"name"`
	Index        int    `json:"index"`
	MTU          int    `json:"mtu"`
	Up           bool   `json:"up"`
	Loopback     bool   `json:"loopback"`
	PointToPoint bool   `json:"pointToPoint"`
	Multicast    bool   `json:"multicast"`
	// Addrs 는 CIDR 표기다("192.168.0.24/24"). prefix 길이가 있어야 tailscale 이 같은 대역인지
	// 판단할 수 있다.
	Addrs []string `json:"addrs"`
}

// SetAndroidNetworkProvider 는 인터페이스 조회를 앱 쪽으로 돌린다.
//
// 어떤 tailnet 호출보다 먼저 불려야 한다 — 등록 전에 tsnet 이 뜨면 그 기동은 여전히 실패한다.
// nil 을 주면 아무것도 하지 않는다(기본 경로로 되돌리는 수단은 두지 않는다. 되돌릴 이유가 없고,
// 되돌릴 수 있게 두면 안드로이드에서 실수로 끄는 길이 생긴다).
func (e *Engine) SetAndroidNetworkProvider(provider AndroidNetworkProvider) {
	if provider == nil {
		return
	}
	netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
		// 기본 경로를 같은 자리에서 갱신한다.
		//
		// 안드로이드의 defaultRoute() 는 이 값만 돌려주므로(net/netmon/interfaces_android.go)
		// 넣어 주지 않으면 기본 경로가 영원히 빈 값이다. 진입점을 목록 조회와 하나로 묶어 두면
		// 둘이 어긋나지 않는다 — 목록을 물어보는 시점이 곧 링크가 바뀌었을 수 있는 시점이다.
		//
		// 갱신 자체는 플랫폼마다 갈린다(android_defaultroute.go) — tailscale 이 그 값을 들고
		// 있는 플랫폼이 android·darwin·ios 뿐이다.
		updateDefaultRouteInterface(strings.TrimSpace(provider.DefaultRouteInterface()))
		return parseAndroidInterfaces(provider.Interfaces())
	})
}

// parseAndroidInterfaces 는 Java 가 준 JSON 을 tailscale 의 형태로 옮긴다.
//
// 순수 함수로 둔 이유는 검증이다 — 살아 있는 안드로이드 없이는 이 변환을 흘려볼 방법이 없고,
// 여기서 틀리면 tailnet 이 조용히 안 뜬다.
func parseAndroidInterfaces(payload string) ([]netmon.Interface, error) {
	var entries []androidInterface
	if err := json.Unmarshal([]byte(payload), &entries); err != nil {
		return nil, fmt.Errorf("mobile: android interface list: %w", err)
	}

	interfaces := make([]netmon.Interface, 0, len(entries))
	for _, entry := range entries {
		name := strings.TrimSpace(entry.Name)
		if name == "" {
			// 이름이 없으면 tailscale 이 구분할 수 없다. 이것 하나 때문에 목록 전체를 버리지는
			// 않는다 — 기기마다 조회가 실패하는 인터페이스가 하나씩 있을 수 있다.
			continue
		}
		interfaces = append(interfaces, netmon.Interface{
			Interface: &net.Interface{
				Index: entry.Index,
				MTU:   entry.MTU,
				Name:  name,
				Flags: androidInterfaceFlags(entry),
			},
			// AltAddrs 는 **비어도 nil 이 아니어야 한다.** nil 이면 Addrs() 가 embedded
			// net.Interface 로 내려가 다시 netlink 를 타고, 우리가 피하려던 그 EPERM 이 난다.
			AltAddrs: androidInterfaceAddrs(entry.Addrs),
		})
	}

	if len(interfaces) == 0 {
		// 목록이 비면 tailscale 은 "네트워크를 모르는" 상태가 된다. 빈 목록을 정상으로 넘기면
		// 그 이유가 어디에도 남지 않으므로 오류로 알린다.
		return nil, errors.New("mobile: android reported no usable network interfaces")
	}
	return interfaces, nil
}

func androidInterfaceFlags(entry androidInterface) net.Flags {
	var flags net.Flags
	if entry.Up {
		// tailscale 은 FlagUp 만 본다(netmon.isUp). FlagRunning 도 같이 세우는 것은 Go 가 실제
		// 인터페이스에서 채우는 모양과 맞추기 위한 것이다.
		flags |= net.FlagUp | net.FlagRunning
	}
	if entry.Loopback {
		flags |= net.FlagLoopback
	}
	if entry.PointToPoint {
		flags |= net.FlagPointToPoint
	}
	if entry.Multicast {
		flags |= net.FlagMulticast
	}
	return flags
}

// androidInterfaceAddrs 는 CIDR 문자열을 net.Addr 로 옮긴다. 못 읽는 항목은 건너뛴다.
func androidInterfaceAddrs(raw []string) []net.Addr {
	addrs := make([]net.Addr, 0, len(raw))
	for _, entry := range raw {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(entry))
		if err != nil {
			continue
		}
		addrs = append(addrs, &net.IPNet{
			IP:   prefix.Addr().AsSlice(),
			Mask: net.CIDRMask(prefix.Bits(), prefix.Addr().BitLen()),
		})
	}
	return addrs
}
