package neterr

import (
	"errors"
	"net"
	"syscall"
	"testing"
	"time"
)

func TestWinsockNumbersMapToCanonicalWording(t *testing.T) {
	cases := map[syscall.Errno]string{
		10061: Refused,
		10060: Timeout,
		10054: Reset,
		10053: Aborted,
		10065: NoRouteToHost,
		10051: NetworkUnreachable,
		10064: HostDown,
		10048: AddressInUse,
		11001: NoSuchHost,
	}
	for errno, want := range cases {
		if got := errnoCanonical(errno); got != want {
			t.Errorf("errno %d: %q, want %q", errno, got, want)
		}
	}
}

// 표를 사람이 옮겨 적은 것이라, 실제 OS 가 주는 오류로 한 번 확인한다. 포트를 옮긴 sshd 에 예전
// 포트로 붙었을 때 사용자가 본 실패가 이것이다.
func TestRealWindowsRefusalIsClassified(t *testing.T) {
	conn, err := net.DialTimeout("tcp", "127.0.0.1:59999", 3*time.Second)
	if err == nil {
		_ = conn.Close()
		t.Skip("그 포트에 무언가 듣고 있다 — 확인할 것이 없다")
	}
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		t.Fatalf("errno 를 꺼낼 수 없다: %v", err)
	}
	if errno != 10061 {
		t.Skipf("거부가 아닌 실패다(errno=%d): %v", errno, err)
	}
	if got := Canonical(err); got != Refused {
		t.Fatalf("Canonical = %q, want %q (원문: %v)", got, Refused, err)
	}
	normalized := Normalize(err).Error()
	if !errors.As(Normalize(err), &errno) {
		t.Error("정규화가 원인 오류를 잃었다")
	}
	t.Logf("정규화된 문구: %s", normalized)
}
