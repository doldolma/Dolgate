package sshcmd

import (
	"errors"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// Lane 은 명령을 어느 보조 채널에 태울지다.
//
// 보조 채널 하나(CompletionWorker)는 명령이 도는 **내내** 잠긴다. 그래서 레인을 가르지 않으면
// 세션 패널의 폴링이 도는 동안 사용자가 치는 자동완성이 통째로 그 뒤에 줄 선다 — 도커 섹션의
// `stats --no-stream` 은 데몬이 CPU 차분을 재느라 흔히 2초를 넘기는데, 그 2초 동안 타이핑이
// 멈춘 것처럼 보였다.
//
// 그래서 사람이 키를 누르고 결과를 기다리는 것과 화면이 알아서 갱신되는 것을 다른 채널에
// 태운다. 백그라운드끼리는 서로 기다려도 된다 — 기다리는 사람이 없다.
type Lane int

const (
	// LaneInteractive 는 사람이 결과를 기다리는 질의다(자동완성).
	LaneInteractive Lane = iota
	// LaneBackground 는 스스로 도는 폴링이다(세션 패널의 도커·호스트 지표).
	LaneBackground
)

// backgroundRetryInterval 은 두 번째 채널을 거절당한 뒤 다시 열어 볼 때까지 기다리는 시간이다.
//
// 거절은 영구적일 수도(`MaxSessions 1` 로 잠근 서버, 세션 채널이 하나뿐인 네트워크 장비)
// 일시적일 수도(그 순간 SFTP 가 마지막 자리를 쓰고 있었다) 있다. 영영 포기하지도, 폴링마다
// 실패할 채널 열기로 왕복을 낭비하지도 않는다.
const backgroundRetryInterval = 5 * time.Minute

// WorkerPool 은 한 SSH 연결 위의 보조 채널을 레인별로 나눠 쓴다.
//
// 두 번째 채널을 못 열면 조용히 첫 번째 레인을 같이 쓴다 — 빡빡한 서버에서 기능이 빠지는 대신
// 지금까지와 똑같이 동작한다(더 나빠지지 않는다).
type WorkerPool struct {
	newWorker func() *CompletionWorker
	now       func() time.Time

	mu          sync.Mutex
	interactive *CompletionWorker
	background  *CompletionWorker
	// denied 는 두 번째 채널을 거절당했다는 뜻이다. deniedAt 부터 backgroundRetryInterval 동안
	// 백그라운드 질의도 대화형 레인을 같이 쓴다.
	denied   bool
	deniedAt time.Time
}

func NewWorkerPool(client *ssh.Client) *WorkerPool {
	return &WorkerPool{
		newWorker: func() *CompletionWorker { return NewCompletionWorker(client) },
		now:       time.Now,
	}
}

func newWorkerPoolForTest(start completionWorkerStarter, now func() time.Time) *WorkerPool {
	return &WorkerPool{
		newWorker: func() *CompletionWorker { return newCompletionWorkerForTest(start) },
		now:       now,
	}
}

// Run 은 레인의 채널에서 명령을 돌린다. 백그라운드 레인의 채널을 열지 못하면 그 사실을 기억하고
// 이번 명령은 대화형 레인에서 마저 돌린다 — 채널을 못 얻었다고 도커 섹션이 비지는 않게.
func (pool *WorkerPool) Run(
	lane Lane,
	command string,
	timeout time.Duration,
	maxBytes int,
) (CompletionOutput, error) {
	if lane == LaneBackground {
		if worker := pool.backgroundWorker(); worker != nil {
			output, err := worker.Run(command, timeout, maxBytes)
			// 채널을 못 연 것만 대화형으로 넘긴다. 명령이 실패했거나 시간이 초과된 것은
			// 그 레인의 결과다 — 같은 명령을 대화형 채널에서 한 번 더 돌리면 사람이 기다리는
			// 자동완성을 두 배로 막는다.
			if err == nil || len(output.Stdout) > 0 || !errors.Is(err, ErrCompletionWorkerUnavailable) {
				return output, err
			}
			pool.denyBackground()
		}
	}
	return pool.interactiveWorker().Run(command, timeout, maxBytes)
}

func (pool *WorkerPool) interactiveWorker() *CompletionWorker {
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if pool.interactive == nil {
		pool.interactive = pool.newWorker()
	}
	return pool.interactive
}

// backgroundWorker 는 두 번째 레인의 worker 를 준다. 최근에 거절당했으면 nil 이라 호출자가
// 곧장 대화형 레인을 쓴다.
func (pool *WorkerPool) backgroundWorker() *CompletionWorker {
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if pool.denied {
		if pool.now().Sub(pool.deniedAt) < backgroundRetryInterval {
			return nil
		}
		// 자리가 났을 수도 있다(SFTP 를 닫았다든지) — 한 번 더 열어 본다.
		pool.denied = false
	}
	if pool.background == nil {
		pool.background = pool.newWorker()
	}
	return pool.background
}

func (pool *WorkerPool) denyBackground() {
	pool.mu.Lock()
	defer pool.mu.Unlock()
	pool.denied = true
	pool.deniedAt = pool.now()
	// 닫힌 worker 는 다시 뜨지 않는다(Close 가 closed 를 세운다) — 버리고 다음에 새로 만든다.
	if pool.background != nil {
		_ = pool.background.Close()
		pool.background = nil
	}
}

func (pool *WorkerPool) Close() error {
	pool.mu.Lock()
	interactive, background := pool.interactive, pool.background
	pool.interactive, pool.background = nil, nil
	pool.mu.Unlock()

	var err error
	if interactive != nil {
		err = interactive.Close()
	}
	if background != nil {
		if closeErr := background.Close(); err == nil {
			err = closeErr
		}
	}
	return err
}
