// Package neterr 는 OS 소켓 오류를 **한 가지 문구 계통으로** 접어 준다.
//
// 코어가 올려 보내는 실패 문구는 앱이 원인을 판정하는 근거다
// (packages/shared-core/src/connection-failure.ts). 그런데 같은 원인이 플랫폼마다 다른 문장으로
// 온다:
//
//	리눅스·macOS : dial tcp 10.0.0.5:22: connect: connection refused
//	윈도우       : dial tcp 10.0.0.5:22: connectex: No connection could be made because the
//	               target machine actively refused it.
//	tailnet 경유 : connect tcp 100.64.0.2:22: connection was refused   (gvisor netstack)
//
// 앱이 이 셋을 모두 알아야 하는 구조는 계통이 늘 때마다 새고, 실제로 윈도우 계통을 통째로
// 놓쳤다. 그래서 **코어가** 원인을 판정해 정경 문구를 앞에 붙인다.
//
// 정경 문구는 새 슬러그가 아니라 유닉스·Go 계통의 문장 그대로다. 이미 배포된 앱의 판정 규칙이
// 그 문구를 알고 있어서, 코어만 갱신하면 옛 앱까지 함께 고쳐진다.
//
// 원문은 지우지 않는다 — `connectex: …` 나 `os error 10061` 이 우리 표가 틀렸을 때 남는 유일한
// 단서다.
package neterr

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"syscall"
)

// 정경 문구. 앱의 분류기가 이미 아는 표현이어야 한다 — 바꾸려면 그쪽 규칙과 함께 바꿔야 한다.
const (
	Refused            = "connection refused"
	Timeout            = "i/o timeout"
	Reset              = "connection reset"
	Aborted            = "connection aborted"
	NoRouteToHost      = "no route to host"
	NetworkUnreachable = "network is unreachable"
	HostDown           = "host is down"
	AddressInUse       = "address already in use"
	NoSuchHost         = "no such host"
	BrokenPipe         = "broken pipe"
)

// 앱이 쓰는 원인 코드. packages/shared-core/src/connection-failure.ts 의 ConnectionFailureCode
// 와 **같은 문자열**이어야 한다 — 이 값이 이벤트 payload 의 failure 필드로 올라가고, 앱은 그것을
// 문구 판정보다 뒤에 두고(더 구체적인 원인이 문장에 있을 수 있다) 폴백으로 쓴다.
const (
	CodeRefused      = "refused"
	CodeTimeout      = "timeout"
	CodeReset        = "reset"
	CodeNoRoute      = "no-route"
	CodeAddressInUse = "address-in-use"
	CodeDNS          = "dns-unresolved"
)

// 정경 문구 → 원인 코드. 문구가 사람을 위한 표현이고 코드가 기계를 위한 표현이다.
//
// 여러 문구가 한 코드로 접힌다 — 사용자가 할 일이 같기 때문이다("연결이 끊겼다" 는 reset 이든
// aborted 든 broken pipe 든 다시 붙는 것이고, 경로가 없다는 것은 host 든 network 든 네트워크를
// 봐야 하는 것이다).
var codeByCanonical = map[string]string{
	Refused:            CodeRefused,
	Timeout:            CodeTimeout,
	Reset:              CodeReset,
	Aborted:            CodeReset,
	BrokenPipe:         CodeReset,
	NoRouteToHost:      CodeNoRoute,
	NetworkUnreachable: CodeNoRoute,
	HostDown:           CodeNoRoute,
	AddressInUse:       CodeAddressInUse,
	NoSuchHost:         CodeDNS,
}

// Code 는 이 오류의 원인 코드를 돌려준다. 우리가 아는 원인이 아니면 빈 문자열이다.
func Code(err error) string {
	return codeByCanonical[Canonical(err)]
}

// Canonical 은 이 오류의 원인을 정경 문구로 돌려준다. 우리가 아는 원인이 아니면 빈 문자열이다.
//
// 판정 순서가 의미를 갖는다 — 위쪽이 근거가 더 확실하다. errno 는 OS 가 직접 준 번호라 문구·
// 로케일과 무관하고, 데드라인 만료는 errno 없이 인터페이스로만 드러난다(실측: 윈도우에서
// `dial tcp 10.255.255.1:22: i/o timeout` 은 errno 가 붙지 않는다).
func Canonical(err error) string {
	if err == nil {
		return ""
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if reason := errnoCanonical(errno); reason != "" {
			return reason
		}
	}
	if errors.Is(err, os.ErrDeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return Timeout
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return Timeout
	}
	// 이름 해석 실패. 타임아웃 판정 뒤에 둔다 — DNS 서버가 응답하지 않은 것과 이름이 없는 것은
	// 사용자가 할 일이 다르다(앞의 Timeout 이 IsTimeout 을 이미 걸러 준다).
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return NoSuchHost
	}
	return netstackCanonical(err.Error())
}

// Normalize 는 정경 문구를 앞에 붙인 오류를 돌려준다. 원인을 모르면 받은 오류를 그대로 돌려준다.
//
// 이미 정경 문구가 문장에 있으면 덧붙이지 않는다 — 아래 계층에서 한 번 지난 오류가 다시 이곳을
// 지나면(dial 사이트 → 라우터) 같은 말이 두 번 나온다.
func Normalize(err error) error {
	if err == nil {
		return nil
	}
	reason := Canonical(err)
	if reason == "" || strings.Contains(err.Error(), reason) {
		return err
	}
	return fmt.Errorf("%s: %w", reason, err)
}

// netstackCanonical 은 tsnet 의 사용자 공간 스택(gvisor)이 주는 문구를 접는다.
//
// 그쪽 오류는 syscall.Errno 도 net.Error 도 아니고 자기 문장만 갖고 있어서, 여기서는 문구를 볼
// 수밖에 없다. 표가 짧은 이유는 netstack 이 쓰는 문장이 고정되어 있기 때문이다.
func netstackCanonical(message string) string {
	lowered := strings.ToLower(message)
	switch {
	case strings.Contains(lowered, "connection was refused"):
		return Refused
	case strings.Contains(lowered, "machine is not on the network"):
		return NetworkUnreachable
	case strings.Contains(lowered, "host is down"):
		return HostDown
	case strings.Contains(lowered, "connection was reset"):
		return Reset
	case strings.Contains(lowered, "connection was aborted"):
		return Aborted
	default:
		return ""
	}
}
