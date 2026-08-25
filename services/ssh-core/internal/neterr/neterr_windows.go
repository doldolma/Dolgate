package neterr

import "syscall"

// winsock 번호 표.
//
// **번호로 비교해야 한다.** 윈도우에서는 `errors.Is(err, syscall.ECONNREFUSED)` 가 통하지 않는다
// — `syscall.Errno.Is` 가 매핑하는 것은 permission/exist/notexist/unsupported 뿐이고, 소켓 오류는
// 어느 쪽에도 없다(실측: 닫힌 포트 dial → errno 10061, errors.Is(ECONNREFUSED) = false).
//
// 상수를 여기 적어 두는 이유는 표준 syscall 패키지가 WSAE* 를 일부만 내보내기 때문이다.
const (
	wsaeNetUnreach  syscall.Errno = 10051
	wsaeConnAborted syscall.Errno = 10053
	wsaeConnReset   syscall.Errno = 10054
	wsaeTimedOut    syscall.Errno = 10060
	wsaeConnRefused syscall.Errno = 10061
	wsaeHostDown    syscall.Errno = 10064
	wsaeHostUnreach syscall.Errno = 10065
	wsaeAddrInUse   syscall.Errno = 10048
	wsaHostNotFound syscall.Errno = 11001
	wsaNoData       syscall.Errno = 11004
)

func errnoCanonical(errno syscall.Errno) string {
	switch errno {
	case wsaeConnRefused:
		return Refused
	case wsaeTimedOut:
		return Timeout
	case wsaeConnReset:
		return Reset
	case wsaeConnAborted:
		return Aborted
	case wsaeHostUnreach:
		return NoRouteToHost
	case wsaeNetUnreach:
		return NetworkUnreachable
	case wsaeHostDown:
		return HostDown
	case wsaeAddrInUse:
		return AddressInUse
	case wsaHostNotFound, wsaNoData:
		return NoSuchHost
	default:
		return ""
	}
}
