//go:build android || darwin || ios

package mobile

// tailscale 의 "마지막으로 안 기본 경로" 를 갱신한다.
//
// 그 값을 들고 있는 플랫폼은 android(net/netmon/interfaces_android.go)와
// darwin·ios(net/netmon/defaultroute_darwin.go) 뿐이다. 다른 곳에서는 심볼 자체가 없으므로
// 제약 없이 부르면 linux·windows 빌드가 깨진다 — 실제로 그렇게 깨뜨린 적이 있다.
//
// 제약을 파일명 접미사(_android.go)로 주지 않는 이유는 그러면 맥에서 이 파일이 빠져서, 개발·로컬
// 테스트가 stub 만 타고 이 경로를 한 번도 흘려보지 못하기 때문이다. 이번 회귀가 CI 에서만 드러난
// 이유가 그것과 같은 종류다.

import (
	"strings"

	"tailscale.com/net/netmon"
)

// defaultRouteTracked 는 이 플랫폼에서 갱신이 실제로 반영되는지다. 테스트가 기본 경로를 단정할 수
// 있는 곳인지 가리는 데 쓴다.
const defaultRouteTracked = true

func updateDefaultRouteInterface(name string) {
	netmon.UpdateLastKnownDefaultRouteInterface(strings.TrimSpace(name))
}
