//go:build !windows

package hostmetrics

// 유닉스에서는 렌더러가 만든 POSIX 스크립트를 보조 채널에서 돌리는 기존 경로가 그대로 산다.
// 여기서 네이티브로 다시 짜면 잘 도는 것을 갈아엎는 셈이라 하지 않는다 — 자세한 이유는
// 패키지 주석에.
const supported = false

func collect(Options) (Sample, error) {
	return Sample{}, ErrUnsupported
}
