package sshconn

import (
	"errors"
	"fmt"
	"testing"
)

func TestJumpDepthCountsHopsFromTheTarget(t *testing.T) {
	cause := errors.New("password auth requires a password")

	// 대상 바로 앞 홉의 인증 실패.
	last := wrapJumpHopError(cause)
	if got := JumpDepth(last); got != 1 {
		t.Fatalf("depth of the last hop = %d, want 1", got)
	}
	// 두 홉 체인의 첫 홉 실패 — 그 홉의 실패가 다음 홉에서 한 번 더 감싸인다.
	first := wrapJumpHopError(wrapJumpHopError(cause))
	if got := JumpDepth(first); got != 2 {
		t.Fatalf("depth of the first of two hops = %d, want 2", got)
	}

	// 문구는 예전 그대로다(재연결 판정·실패 문구가 접두사를 본다).
	if got, want := first.Error(), "jump host: jump host: password auth requires a password"; got != want {
		t.Fatalf("message = %q, want %q", got, want)
	}
	if !errors.Is(first, cause) {
		t.Fatal("the cause must stay reachable through the wrap")
	}
}

func TestJumpDepthSurvivesOuterWrapping(t *testing.T) {
	err := fmt.Errorf("session setup: %w", wrapJumpHopError(errors.New("unable to authenticate")))
	if got := JumpDepth(err); got != 1 {
		t.Fatalf("depth = %d, want 1", got)
	}
}

func TestJumpDepthIsZeroForTheTargetItself(t *testing.T) {
	if got := JumpDepth(errors.New("password auth requires a password")); got != 0 {
		t.Fatalf("depth = %d, want 0", got)
	}
	if got := JumpDepth(nil); got != 0 {
		t.Fatalf("depth of nil = %d, want 0", got)
	}
}
