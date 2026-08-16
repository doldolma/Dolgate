package sshconn

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
	"time"
)

// tailnet 구간은 일반 TCP 보다 넉넉한 예산을 받아야 한다.
//
// 노드가 막 깨어났거나 릴레이(DERP)를 거치면 첫 연결이 10초를 넘는다. 일반 TCP 예산으로 자르면
// 실기기에서 겪은 그 상태가 된다 — `context deadline exceeded` 만 남고 재연결만 반복.
func TestTailnetDialGetsALongerBudgetThanPlainTCP(t *testing.T) {
	if TailnetDialTimeout <= DefaultConfig.TCPDialTimeout {
		t.Fatalf(
			"tailnet 예산 %s 가 일반 TCP %s 보다 길지 않다",
			TailnetDialTimeout, DefaultConfig.TCPDialTimeout,
		)
	}
}

// 실패 문구는 **무엇이 늦었는지** 말해야 한다. 원인을 지운 한 줄만 남으면 사용자도 지원도
// 어느 계층이 문제인지 알 수 없다.
func TestTailnetDialTimeoutSaysWhatTimedOut(t *testing.T) {
	err := annotateTailnetDialFailure(
		context.DeadlineExceeded,
		context.Background(),
		30*time.Second,
	)

	if !strings.Contains(err.Error(), "tailnet") {
		t.Errorf("문구에 tailnet 이 없다: %v", err)
	}
	if !strings.Contains(err.Error(), "30s") {
		t.Errorf("문구에 예산이 없다: %v", err)
	}
	// 원문을 남겨야 재연결 분류기가 지금처럼 동작한다.
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("원인 오류가 지워졌다: %v", err)
	}
}

// 사용자가 탭을 닫아 끊은 것은 실패가 아니다 — 그 자리에 "경로가 없습니다" 를 붙이면 거짓말이다.
func TestCancelledTailnetDialIsNotAnnotated(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := annotateTailnetDialFailure(context.Canceled, ctx, 30*time.Second)

	if strings.Contains(err.Error(), "tailnet") {
		t.Errorf("사용자 취소에 tailnet 진단을 붙였다: %v", err)
	}
}

// 시간 초과가 아닌 실패(경로 없음 등)도 어느 계층인지는 밝힌다.
func TestOtherTailnetDialFailuresNameTheLayer(t *testing.T) {
	err := annotateTailnetDialFailure(
		&net.AddrError{Err: "no route", Addr: "10.0.0.9"},
		context.Background(),
		30*time.Second,
	)

	if !strings.Contains(err.Error(), "tailnet") {
		t.Errorf("문구에 tailnet 이 없다: %v", err)
	}
}
