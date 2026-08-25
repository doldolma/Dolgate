//go:build !windows

package neterr

import "syscall"

// 유닉스 errno 표. 번호는 플랫폼마다 다르므로(ECONNREFUSED 가 리눅스 111, macOS 61) 이름으로
// 비교한다 — 여기서는 그것이 통한다.
func errnoCanonical(errno syscall.Errno) string {
	switch errno {
	case syscall.ECONNREFUSED:
		return Refused
	case syscall.ETIMEDOUT:
		return Timeout
	case syscall.ECONNRESET:
		return Reset
	case syscall.ECONNABORTED:
		return Aborted
	case syscall.EHOSTUNREACH:
		return NoRouteToHost
	case syscall.ENETUNREACH:
		return NetworkUnreachable
	case syscall.EHOSTDOWN:
		return HostDown
	case syscall.EADDRINUSE:
		return AddressInUse
	case syscall.EPIPE:
		return BrokenPipe
	default:
		return ""
	}
}
