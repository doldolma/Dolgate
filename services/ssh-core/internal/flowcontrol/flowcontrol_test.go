package flowcontrol

import (
	"sync"
	"testing"
	"time"
)

// waitAsync 는 Wait 를 다른 고루틴에서 돌리고, 돌아오면 닫히는 채널을 준다.
func waitAsync(registry *Registry, sessionID string, closed <-chan struct{}) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		registry.Wait(sessionID, closed)
		close(done)
	}()
	return done
}

func requireReturns(t *testing.T, done <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal(message)
	}
}

func requireBlocked(t *testing.T, done <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-done:
		t.Fatal(message)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestNilRegistryNeverBlocks(t *testing.T) {
	var registry *Registry
	registry.Start("s1")
	registry.Sent("s1", 1<<30)
	registry.Ack("s1", 1)
	registry.SetHidden("s1", true)
	registry.Stop("s1")
	requireReturns(t, waitAsync(registry, "s1", nil), "nil registry must not block")
}

// 렌더러가 구독하지 않은 세션(모바일, 서버, 흐름 제어를 안 쓰는 세션)은 아무리 보내도 멈추지 않는다.
func TestSessionWithoutStartIsNeverPaused(t *testing.T) {
	registry := NewWithLimits(100, 10, time.Minute)
	registry.Sent("s1", 1000)
	requireReturns(t, waitAsync(registry, "s1", nil), "unstarted session must not block")
}

func TestPausesOverHighAndResumesAtLow(t *testing.T) {
	registry := NewWithLimits(100, 10, time.Minute)
	registry.Start("s1")

	registry.Sent("s1", 100)
	requireReturns(t, waitAsync(registry, "s1", nil), "at the high watermark reading continues")

	registry.Sent("s1", 1)
	done := waitAsync(registry, "s1", nil)
	requireBlocked(t, done, "over the high watermark reading must pause")

	// 상한 아래로 내려가도 하한까지는 계속 멈춰 있는다(한 바이트마다 멈췄다 풀렸다 하지 않게).
	registry.Ack("s1", 50)
	requireBlocked(t, done, "between the watermarks a paused session stays paused")

	registry.Ack("s1", 41)
	requireReturns(t, done, "at the low watermark reading resumes")
}

func TestReleasesEveryWaiter(t *testing.T) {
	registry := NewWithLimits(100, 10, time.Minute)
	registry.Start("s1")
	registry.Sent("s1", 200)
	stdout := waitAsync(registry, "s1", nil)
	stderr := waitAsync(registry, "s1", nil)
	requireBlocked(t, stdout, "stdout reader must pause")
	requireBlocked(t, stderr, "stderr reader must pause")

	registry.Ack("s1", 200)
	requireReturns(t, stdout, "stdout reader must resume")
	requireReturns(t, stderr, "stderr reader must resume")
}

func TestClosedSessionStopsWaiting(t *testing.T) {
	registry := NewWithLimits(100, 10, time.Minute)
	registry.Start("s1")
	registry.Sent("s1", 200)
	closed := make(chan struct{})
	done := waitAsync(registry, "s1", closed)
	requireBlocked(t, done, "must pause")

	close(closed)
	requireReturns(t, done, "a closed session must stop waiting")
}

func TestStopReleasesAndStopsCounting(t *testing.T) {
	registry := NewWithLimits(100, 10, time.Minute)
	registry.Start("s1")
	registry.Sent("s1", 200)
	done := waitAsync(registry, "s1", nil)
	requireBlocked(t, done, "must pause")

	registry.Stop("s1")
	requireReturns(t, done, "stop must release the reader")

	registry.Sent("s1", 200)
	requireReturns(t, waitAsync(registry, "s1", nil), "after stop nothing is counted")
}

// 창을 새로 고쳐 다시 구독하면 이전 셈을 버린다. 남기면 받을 렌더러가 없어 영영 멈춘다.
func TestRestartResetsTheCount(t *testing.T) {
	registry := NewWithLimits(100, 10, time.Minute)
	registry.Start("s1")
	registry.Sent("s1", 200)
	done := waitAsync(registry, "s1", nil)
	requireBlocked(t, done, "must pause")

	registry.Start("s1")
	requireReturns(t, done, "restart must release the reader")
}

// 다시 구독하면 이전 출력이 한 번 더 전달돼 보낸 것보다 많이 알릴 수 있다. 셈이 음수로 가면 그만큼
// 상한을 늦게 만나므로 0에서 멈춘다.
func TestAckNeverDrivesTheCountNegative(t *testing.T) {
	registry := NewWithLimits(100, 10, time.Minute)
	registry.Start("s1")
	registry.Ack("s1", 1000)
	registry.Sent("s1", 101)
	done := waitAsync(registry, "s1", nil)
	requireBlocked(t, done, "an over-ack must not leave credit behind")
	registry.Ack("s1", 101)
	requireReturns(t, done, "must resume")
}

// 렌더러가 죽으면 ack 가 영영 안 온다. 멈춘 채 그만큼 조용하면 풀고, 다시 ack 가 올 때까지 멈추지 않는다.
func TestStalledRendererReleasesUntilItAcksAgain(t *testing.T) {
	registry := NewWithLimits(100, 10, 80*time.Millisecond)
	registry.Start("s1")
	registry.Sent("s1", 200)
	requireReturns(t, waitAsync(registry, "s1", nil), "a silent renderer must not stall the session forever")

	registry.Sent("s1", 1000)
	requireReturns(t, waitAsync(registry, "s1", nil), "after a stall the session must not pause on its own")

	// 렌더러가 다시 답하면 그동안 센 양으로 다시 멈춘다 — 예전에는 다시 구독할 때까지 영영 꺼져 있었다.
	registry.Ack("s1", 0)
	done := waitAsync(registry, "s1", nil)
	requireBlocked(t, done, "once the renderer answers again the session must pause over the high watermark")
	registry.Ack("s1", 1200)
	requireReturns(t, done, "must resume when the renderer catches up")
}

// 숨은 창은 타이머가 1분에 한 번으로 줄어 ack 가 뜸하다. 숨은 동안은 안전망이 풀지 않는다 — 풀면
// 쏟아지는 출력이 렌더러에 끝없이 쌓였다(최소화 7분에 2.3GB).
func TestHiddenSessionStaysPausedPastTheStallTimeout(t *testing.T) {
	registry := NewWithLimits(100, 10, 60*time.Millisecond)
	registry.Start("s1")
	registry.SetHidden("s1", true)
	registry.Sent("s1", 200)
	done := waitAsync(registry, "s1", nil)
	time.Sleep(150 * time.Millisecond)
	requireBlocked(t, done, "a hidden window must not be released by the stall guard")

	registry.Ack("s1", 200)
	requireReturns(t, done, "must resume when the hidden window catches up")
}

// 다시 보이면 그 순간부터 잰다. 숨어 있던 시간을 조용했던 시간으로 치지 않는다.
func TestVisibleAgainRestartsTheStallClock(t *testing.T) {
	registry := NewWithLimits(100, 10, 100*time.Millisecond)
	registry.Start("s1")
	registry.SetHidden("s1", true)
	registry.Sent("s1", 200)
	done := waitAsync(registry, "s1", nil)
	time.Sleep(200 * time.Millisecond)

	registry.SetHidden("s1", false)
	requireBlocked(t, done, "becoming visible must not count the hidden time as a stall")
	requireReturns(t, done, "a visible window that stays silent is released by the stall guard")
}

// 다시 구독하면 새 창이다. 이전 구독의 숨김 상태를 이어받지 않는다(렌더러가 새로 알린다).
func TestRestartForgetsTheHiddenState(t *testing.T) {
	registry := NewWithLimits(100, 10, 60*time.Millisecond)
	registry.Start("s1")
	registry.SetHidden("s1", true)
	registry.Start("s1")
	registry.Sent("s1", 200)
	requireReturns(t, waitAsync(registry, "s1", nil), "a new subscription is visible until told otherwise")
}

// 조용하던 세션이 쏟아지기 시작한 경우: 마지막 ack 가 오래전이어도 멈춘 순간부터 기다린다.
func TestStallIsMeasuredFromThePause(t *testing.T) {
	registry := NewWithLimits(100, 10, 150*time.Millisecond)
	registry.Start("s1")
	time.Sleep(200 * time.Millisecond)

	registry.Sent("s1", 200)
	done := waitAsync(registry, "s1", nil)
	requireBlocked(t, done, "an idle period before the flood must not count as a stall")
	registry.Ack("s1", 200)
	requireReturns(t, done, "must resume")
}

// observed 는 StartObserved 의 pause·resume 호출을 센다.
type observed struct {
	mu      sync.Mutex
	pauses  int
	resumes int
}

func (o *observed) pause()  { o.mu.Lock(); o.pauses++; o.mu.Unlock() }
func (o *observed) resume() { o.mu.Lock(); o.resumes++; o.mu.Unlock() }
func (o *observed) counts() (int, int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.pauses, o.resumes
}

func requireCounts(t *testing.T, o *observed, pauses, resumes int) {
	t.Helper()
	if gotPauses, gotResumes := o.counts(); gotPauses != pauses || gotResumes != resumes {
		t.Fatalf("pause=%d resume=%d, want pause=%d resume=%d", gotPauses, gotResumes, pauses, resumes)
	}
}

// tmux 창은 읽기를 멈출 수 없다(모든 창이 채널 하나). 대신 상한을 넘으면 멈추라고, 하한 아래로
// 내려가면 다시 보내라고 한 번씩 말한다.
func TestObservedSessionAsksToPauseAndResume(t *testing.T) {
	registry := NewWithLimits(100, 10, time.Minute)
	o := &observed{}
	registry.StartObserved("tmux:c:1", o.pause, o.resume)

	registry.Sent("tmux:c:1", 100)
	requireCounts(t, o, 0, 0)
	registry.Sent("tmux:c:1", 1)
	requireCounts(t, o, 1, 0)
	// 멈추라고 한 뒤에도 이미 오던 출력은 더 들어온다. 다시 말하지 않는다.
	registry.Sent("tmux:c:1", 500)
	requireCounts(t, o, 1, 0)

	registry.Ack("tmux:c:1", 550)
	requireCounts(t, o, 1, 0)
	registry.Ack("tmux:c:1", 50)
	requireCounts(t, o, 1, 1)

	registry.Sent("tmux:c:1", 200)
	requireCounts(t, o, 2, 1)
}

// 렌더러가 구독을 끊거나 다시 구독하면, 멈춰 둔 창을 그대로 두지 않는다.
func TestObservedSessionResumesWhenStoppedOrRestarted(t *testing.T) {
	registry := NewWithLimits(100, 10, time.Minute)
	o := &observed{}
	registry.StartObserved("tmux:c:1", o.pause, o.resume)
	registry.Sent("tmux:c:1", 200)
	registry.Stop("tmux:c:1")
	requireCounts(t, o, 1, 1)

	again := &observed{}
	registry.StartObserved("tmux:c:1", again.pause, again.resume)
	registry.Sent("tmux:c:1", 200)
	registry.StartObserved("tmux:c:1", again.pause, again.resume)
	requireCounts(t, again, 1, 1)

	// 멈추지 않은 창을 끊을 때는 다시 보내라고 하지 않는다.
	idle := &observed{}
	registry.StartObserved("tmux:c:2", idle.pause, idle.resume)
	registry.Stop("tmux:c:2")
	requireCounts(t, idle, 0, 0)
}

// 렌더러가 죽으면 ack 가 영영 안 온다. 멈춘 채 그만큼 조용하면 다시 보내게 하고, 렌더러가 다시 답할
// 때까지 멈추라고 하지 않는다.
func TestObservedSessionResumesAfterAStall(t *testing.T) {
	registry := NewWithLimits(100, 10, 80*time.Millisecond)
	o := &observed{}
	registry.StartObserved("tmux:c:1", o.pause, o.resume)
	registry.Sent("tmux:c:1", 200)
	requireCounts(t, o, 1, 0)

	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, resumes := o.counts(); resumes == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a silent renderer must not keep the pane paused forever")
		}
		time.Sleep(10 * time.Millisecond)
	}
	registry.Sent("tmux:c:1", 1000)
	requireCounts(t, o, 1, 1)

	registry.Ack("tmux:c:1", 0)
	registry.Sent("tmux:c:1", 1)
	requireCounts(t, o, 2, 1)
}

func TestObservedHiddenPaneStaysPausedPastTheStallTimeout(t *testing.T) {
	registry := NewWithLimits(100, 10, 60*time.Millisecond)
	o := &observed{}
	registry.StartObserved("tmux:c:1", o.pause, o.resume)
	registry.SetHidden("tmux:c:1", true)
	registry.Sent("tmux:c:1", 200)
	time.Sleep(200 * time.Millisecond)
	requireCounts(t, o, 1, 0)

	// 다시 보인 뒤에도 조용하면, 보인 순간부터 잰 시간이 지나 다시 보내게 한다.
	registry.SetHidden("tmux:c:1", false)
	requireCounts(t, o, 1, 0)
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, resumes := o.counts(); resumes == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a visible pane that stays silent must be resumed by the stall guard")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestObservedSessionStaysPausedWhileTheRendererIsAlive(t *testing.T) {
	registry := NewWithLimits(100, 10, 120*time.Millisecond)
	o := &observed{}
	registry.StartObserved("tmux:c:1", o.pause, o.resume)
	registry.Sent("tmux:c:1", 200)
	for i := 0; i < 6; i++ {
		time.Sleep(50 * time.Millisecond)
		registry.Ack("tmux:c:1", 0)
	}
	requireCounts(t, o, 1, 0)
	registry.Ack("tmux:c:1", 200)
	requireCounts(t, o, 1, 1)
}

// pause·resume 은 락 밖에서 불려야 한다. 그 안에서 다시 셈을 건드려도 교착되지 않는다.
func TestObservedCallbacksRunOutsideTheLock(t *testing.T) {
	registry := NewWithLimits(100, 10, time.Minute)
	done := make(chan struct{})
	go func() {
		defer close(done)
		registry.StartObserved("tmux:c:1",
			func() { registry.Ack("tmux:c:1", 0) },
			func() { registry.Sent("tmux:c:2", 1) },
		)
		registry.Sent("tmux:c:1", 200)
		registry.Ack("tmux:c:1", 200)
	}()
	requireReturns(t, done, "callbacks must not run under the registry lock")
}

// 처리 중인 렌더러는 0 바이트 ack 로 살아 있음을 알린다(창이 다시 보일 때 쌓인 출력을 그리는 동안 등).
func TestZeroByteAckKeepsAPausedSessionAlive(t *testing.T) {
	registry := NewWithLimits(100, 10, 120*time.Millisecond)
	registry.Start("s1")
	registry.Sent("s1", 200)
	done := waitAsync(registry, "s1", nil)

	for i := 0; i < 6; i++ {
		time.Sleep(50 * time.Millisecond)
		registry.Ack("s1", 0)
	}
	requireBlocked(t, done, "heartbeats must keep the session paused, not released by the stall guard")

	registry.Ack("s1", 200)
	requireReturns(t, done, "must resume")
}
