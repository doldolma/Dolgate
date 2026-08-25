//go:build !windows

package neterr

import (
	"syscall"
	"testing"
)

func TestUnixErrnosMapToCanonicalWording(t *testing.T) {
	cases := map[syscall.Errno]string{
		syscall.ECONNREFUSED: Refused,
		syscall.ETIMEDOUT:    Timeout,
		syscall.ECONNRESET:   Reset,
		syscall.ECONNABORTED: Aborted,
		syscall.EHOSTUNREACH: NoRouteToHost,
		syscall.ENETUNREACH:  NetworkUnreachable,
		syscall.EHOSTDOWN:    HostDown,
		syscall.EADDRINUSE:   AddressInUse,
		syscall.EPIPE:        BrokenPipe,
	}
	for errno, want := range cases {
		if got := errnoCanonical(errno); got != want {
			t.Errorf("errno %v: %q, want %q", errno, got, want)
		}
	}
}
