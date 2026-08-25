package neterr

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"syscall"
	"testing"
)

func TestCanonicalReadsDeadlineExpiry(t *testing.T) {
	// 데드라인 만료에는 errno 가 붙지 않는다 — 인터페이스로만 드러난다.
	for name, err := range map[string]error{
		"os.ErrDeadlineExceeded":      fmt.Errorf("dial failed: %w", os.ErrDeadlineExceeded),
		"context.DeadlineExceeded":    fmt.Errorf("dial failed: %w", context.DeadlineExceeded),
		"net.Error 의 Timeout() =true": &net.OpError{Op: "dial", Err: timeoutError{}},
	} {
		if got := Canonical(err); got != Timeout {
			t.Errorf("%s: Canonical = %q, want %q", name, got, Timeout)
		}
	}
}

func TestCanonicalReadsDNSFailures(t *testing.T) {
	err := &net.OpError{Op: "dial", Err: &net.DNSError{Err: "no such host", Name: "nas.local"}}
	if got := Canonical(err); got != NoSuchHost {
		t.Errorf("Canonical = %q, want %q", got, NoSuchHost)
	}
}

// 응답하지 않는 DNS 는 이름이 없는 것과 할 일이 다르다.
func TestCanonicalPrefersTimeoutOverDNSName(t *testing.T) {
	err := &net.DNSError{Err: "i/o timeout", Name: "nas.local", IsTimeout: true}
	if got := Canonical(err); got != Timeout {
		t.Errorf("Canonical = %q, want %q", got, Timeout)
	}
}

// tailnet 경유 dial 은 gvisor netstack 문구로 실패한다 — errno 도 net.Error 도 없다.
func TestCanonicalReadsNetstackWording(t *testing.T) {
	cases := map[string]string{
		"connect tcp 100.64.0.2:22: connection was refused":     Refused,
		"dial tcp 100.64.0.2:22: machine is not on the network": NetworkUnreachable,
		"dial tcp 100.64.0.2:22: host is down":                  HostDown,
		"read tcp 100.64.0.2:22: connection was reset":          Reset,
		"write tcp 100.64.0.2:22: connection was aborted":       Aborted,
		"ssh: handshake failed: no common host key algorithm":   "",
	}
	for message, want := range cases {
		if got := Canonical(errors.New(message)); got != want {
			t.Errorf("%q: Canonical = %q, want %q", message, got, want)
		}
	}
}

func TestNormalizePrefixesTheCanonicalWording(t *testing.T) {
	err := errors.New("connect tcp 100.64.0.2:22: connection was refused")
	normalized := Normalize(err).Error()
	if want := Refused + ": "; !strings.HasPrefix(normalized, want) {
		t.Fatalf("정경 문구가 앞에 붙지 않았다: %q", normalized)
	}
	// 원문을 지우면 우리 표가 틀렸을 때 단서가 없다.
	if !strings.Contains(normalized, "connection was refused") {
		t.Errorf("원문을 잃었다: %q", normalized)
	}
}

// 문구에 이미 정경 표현이 들어 있는 오류(유닉스·Go 계통)는 그대로 둔다. 붙일 이유가 없고, 그
// 오류가 이 함수를 지났다는 사실도 남지 않아야 한다.
func TestNormalizeLeavesCanonicalSentencesUntouched(t *testing.T) {
	err := &net.OpError{Op: "dial", Net: "tcp", Err: &net.DNSError{Err: "no such host", Name: "nas.local"}}
	if got := Normalize(err).Error(); got != err.Error() {
		t.Errorf("문구가 늘었다: %q", got)
	}
	if !errors.As(Normalize(err), new(*net.DNSError)) {
		t.Error("원인 오류를 잃었다 — %w 로 감싸야 한다")
	}
}

// 같은 오류가 dial 사이트와 라우터를 차례로 지난다. 두 번 붙으면 안 된다.
func TestNormalizeIsIdempotent(t *testing.T) {
	err := errors.New("connect tcp 100.64.0.2:22: connection was refused")
	once := Normalize(err)
	twice := Normalize(once)
	if once.Error() != twice.Error() {
		t.Errorf("두 번 지나며 문구가 늘었다: %q", twice.Error())
	}
}

func TestNormalizeLeavesUnknownCausesAlone(t *testing.T) {
	err := errors.New("ssh: unable to authenticate")
	if Normalize(err).Error() != err.Error() {
		t.Errorf("모르는 원인에 문구를 붙였다: %q", Normalize(err).Error())
	}
	if Normalize(nil) != nil {
		t.Error("nil 을 오류로 바꿨다")
	}
}

func TestErrnoTableIgnoresUnrelatedNumbers(t *testing.T) {
	if got := errnoCanonical(syscall.Errno(42)); got != "" {
		t.Errorf("errnoCanonical(42) = %q, want \"\"", got)
	}
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

func TestCodeFoldsWordingIntoAppCodes(t *testing.T) {
	cases := map[string]string{
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
	for wording, want := range cases {
		if got := codeByCanonical[wording]; got != want {
			t.Errorf("%q: code = %q, want %q", wording, got, want)
		}
	}
	// 모르는 원인에는 코드를 붙이지 않는다 — 앱이 그것을 근거로 판정하면 안 된다.
	if got := Code(errors.New("ssh: unable to authenticate")); got != "" {
		t.Errorf("Code = %q, want \"\"", got)
	}
	if got := Code(errors.New("connect tcp 100.64.0.2:22: connection was refused")); got != CodeRefused {
		t.Errorf("netstack 문구의 Code = %q, want %q", got, CodeRefused)
	}
}
