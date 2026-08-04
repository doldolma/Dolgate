//go:build !android && !darwin && !ios

package mobile

// linux·windows 에는 tailscale 의 "마지막으로 안 기본 경로" 가 없다(android_defaultroute.go 참고).
// 이 파일은 그 플랫폼에서도 mobile 패키지가 빌드되게 하려고 있다 — 데스크톱 CI 가 `go test ./...`
// 로 이 패키지까지 컴파일한다.
//
// 안드로이드 provider 는 이 플랫폼에서 등록되지 않으므로 이 함수는 테스트에서만 불린다.

const defaultRouteTracked = false

func updateDefaultRouteInterface(string) {}
