package inflight

import (
	"testing"
	"time"
)

func TestCancelStopsTheWork(t *testing.T) {
	registry := New()
	ctx, release := registry.Begin("rule-1")
	defer release()

	registry.Cancel("rule-1")

	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("취소가 작업에 닿지 않았다")
	}
}

// 끝난 작업의 등록은 남지 않아야 한다. 남으면 다음 정지가 이미 끝난 작업을 취소하려 든다.
func TestReleaseRemovesTheEntry(t *testing.T) {
	registry := New()
	_, release := registry.Begin("endpoint-1")
	release()

	registry.mu.Lock()
	remaining := len(registry.entries)
	registry.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("남은 등록 = %d, want 0", remaining)
	}
}

// 한 키에 두 작업이 겹쳐도 서로의 등록을 지우지 않아야 한다.
func TestOverlappingWorkOnOneKey(t *testing.T) {
	registry := New()
	firstCtx, releaseFirst := registry.Begin("session-1")
	secondCtx, releaseSecond := registry.Begin("session-1")

	// 첫 작업만 끝난다 — 두 번째 등록은 남아 있어야 한다.
	releaseFirst()
	registry.mu.Lock()
	remaining := len(registry.entries["session-1"])
	registry.mu.Unlock()
	if remaining != 1 {
		t.Fatalf("남은 등록 = %d, want 1", remaining)
	}

	registry.Cancel("session-1")
	select {
	case <-secondCtx.Done():
	case <-time.After(time.Second):
		t.Fatal("두 번째 작업이 취소되지 않았다")
	}
	// 첫 작업은 이미 정리 함수로 취소됐다.
	select {
	case <-firstCtx.Done():
	default:
		t.Fatal("정리 함수가 ctx 를 취소하지 않았다")
	}
	releaseSecond()
}

func TestCancelUnknownKeyIsHarmless(t *testing.T) {
	registry := New()
	registry.Cancel("nobody")
}

func TestCancelAllStopsEverything(t *testing.T) {
	registry := New()
	first, releaseFirst := registry.Begin("a")
	second, releaseSecond := registry.Begin("b")
	defer releaseFirst()
	defer releaseSecond()

	registry.CancelAll()

	for name, ctx := range map[string]<-chan struct{}{"a": first.Done(), "b": second.Done()} {
		select {
		case <-ctx:
		case <-time.After(time.Second):
			t.Fatalf("%s 가 취소되지 않았다", name)
		}
	}
}
