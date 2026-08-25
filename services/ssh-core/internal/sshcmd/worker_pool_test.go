package sshcmd

import (
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// startLocalShell 은 SSH exec 채널 대신 로컬 `sh -s` 를 띄운다. 채널의 계약(stdin 에 스크립트를
// 흘리고 stdout 에서 마커를 읽는다)이 같아서 worker 코드를 그대로 시험할 수 있다.
func startLocalShell() (*completionWorkerProcess, error) {
	cmd := exec.Command("sh", "-s")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, err
	}
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()
	return &completionWorkerProcess{
		stdin:  stdin,
		stdout: stdout,
		close: func() error {
			_ = stdin.Close()
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			select {
			case <-done:
			case <-time.After(time.Second):
			}
			return nil
		},
	}, nil
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (clock *fakeClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

func (clock *fakeClock) Advance(delta time.Duration) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now = clock.now.Add(delta)
}

// poolCounters 는 채널을 몇 번 열었는지(starts)와 지금 몇 개가 열려 있는지(open)를 센다.
// 서버의 MaxSessions 는 **동시에** 열린 개수를 제한하므로 둘을 갈라 세야 한다.
type poolCounters struct {
	starts int32
	open   int32
	max    int32
}

// newLocalWorkerPool 은 로컬 셸을 채널로 쓰는 풀을 만든다. 동시에 max 개를 넘겨 열려 하면
// sshd 가 MaxSessions 를 넘겼을 때와 같은 오류를 돌려준다.
func newLocalWorkerPool(t *testing.T, max int32, clock *fakeClock) (*WorkerPool, *poolCounters) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX completion worker requires sh")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh not available")
	}
	counters := &poolCounters{max: max}
	now := time.Now
	if clock != nil {
		now = clock.Now
	}
	pool := newWorkerPoolForTest(func() (*completionWorkerProcess, error) {
		if atomic.AddInt32(&counters.open, 1) > atomic.LoadInt32(&counters.max) {
			atomic.AddInt32(&counters.open, -1)
			return nil, fmt.Errorf(
				"%w: ssh: rejected: administratively prohibited (open failed)",
				ErrCompletionWorkerUnavailable,
			)
		}
		process, err := startLocalShell()
		if err != nil {
			atomic.AddInt32(&counters.open, -1)
			return nil, err
		}
		atomic.AddInt32(&counters.starts, 1)
		inner := process.close
		process.close = func() error {
			atomic.AddInt32(&counters.open, -1)
			return inner()
		}
		return process, nil
	}, now)
	return pool, counters
}

func runPool(t *testing.T, pool *WorkerPool, lane Lane, command string) string {
	t.Helper()
	output, _, err := pool.Run(lane, command, 5*time.Second, 4096)
	if err != nil {
		t.Fatalf("Run(%v, %q) error = %v", lane, command, err)
	}
	return strings.TrimSpace(string(output))
}

// 백그라운드 폴링이 채널을 물고 있어도 자동완성은 기다리지 않아야 한다 — 레인을 가른 이유가
// 그것이다(도커 `stats --no-stream` 한 번이 2초를 넘겨 타이핑이 멈춰 보이던 것).
func TestWorkerPoolInteractiveDoesNotWaitForBackground(t *testing.T) {
	pool, counters := newLocalWorkerPool(t, 2, nil)
	defer pool.Close()

	blocked := make(chan struct{})
	go func() {
		defer close(blocked)
		_, _, _ = pool.Run(LaneBackground, "sleep 2", 10*time.Second, 4096)
	}()

	// 백그라운드 명령이 실제로 채널을 물 때까지 기다린다(레이스 없이 "물려 있는 동안" 을 만든다).
	deadline := time.Now().Add(3 * time.Second)
	for atomic.LoadInt32(&counters.open) < 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	startedAt := time.Now()
	if got := runPool(t, pool, LaneInteractive, "printf ok"); got != "ok" {
		t.Fatalf("interactive output = %q, want %q", got, "ok")
	}
	if elapsed := time.Since(startedAt); elapsed > time.Second {
		t.Fatalf("interactive query waited %s for the background lane", elapsed)
	}

	<-blocked
	if got := atomic.LoadInt32(&counters.starts); got != 2 {
		t.Fatalf("opened %d channels, want 2 (one per lane)", got)
	}
}

// 두 번째 채널을 거절하는 서버(`MaxSessions 1`, 세션 채널이 하나뿐인 장비)에서는 조용히 한
// 레인을 같이 쓴다 — 기능이 빠지지 않고, 거절당한 뒤로는 헛되이 다시 두드리지도 않는다.
func TestWorkerPoolSharesLaneWhenSecondChannelDenied(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1_700_000_000, 0)}
	pool, counters := newLocalWorkerPool(t, 1, clock)
	defer pool.Close()

	if got := runPool(t, pool, LaneInteractive, "printf one"); got != "one" {
		t.Fatalf("interactive output = %q, want %q", got, "one")
	}
	if got := runPool(t, pool, LaneBackground, "printf two"); got != "two" {
		t.Fatalf("background output = %q, want %q", got, "two")
	}
	if got := runPool(t, pool, LaneBackground, "printf three"); got != "three" {
		t.Fatalf("background output = %q, want %q", got, "three")
	}
	if got := atomic.LoadInt32(&counters.starts); got != 1 {
		t.Fatalf("opened %d channels, want 1 (the second was denied and must not be retried)", got)
	}

	// 자리가 나면(SFTP 를 닫았다든지) 쿨다운 뒤에 다시 열어 본다.
	atomic.StoreInt32(&counters.max, 2)
	clock.Advance(backgroundRetryInterval + time.Second)

	if got := runPool(t, pool, LaneBackground, "printf four"); got != "four" {
		t.Fatalf("background output = %q, want %q", got, "four")
	}
	if got := atomic.LoadInt32(&counters.starts); got != 2 {
		t.Fatalf("opened %d channels after the cooldown, want 2", got)
	}
}

// 백그라운드 명령이 시간을 초과해도 자동완성 채널은 살아 있어야 한다. 예전에는 채널이 하나라
// 도커 왕복 한 번이 늦으면 그 채널이 통째로 죽고 다음 자동완성이 `sh -s` 부터 다시 열었다.
func TestWorkerPoolBackgroundTimeoutKeepsInteractiveChannel(t *testing.T) {
	pool, counters := newLocalWorkerPool(t, 2, nil)
	defer pool.Close()

	if got := runPool(t, pool, LaneInteractive, "printf warm"); got != "warm" {
		t.Fatalf("interactive output = %q, want %q", got, "warm")
	}
	if _, _, err := pool.Run(LaneBackground, "sleep 5", 200*time.Millisecond, 4096); err == nil {
		t.Fatal("expected the background query to time out")
	}
	if got := runPool(t, pool, LaneInteractive, "printf still-here"); got != "still-here" {
		t.Fatalf("interactive output = %q, want %q", got, "still-here")
	}
	// 대화형 채널 1 + 시간 초과로 버려진 백그라운드 채널 1. 대화형이 다시 열렸다면 3 이 된다.
	if got := atomic.LoadInt32(&counters.starts); got != 2 {
		t.Fatalf("opened %d channels, want 2 (the interactive channel must survive)", got)
	}
}
