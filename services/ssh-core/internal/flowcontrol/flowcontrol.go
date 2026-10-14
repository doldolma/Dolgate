// Package flowcontrol 는 데스크톱 화면이 아직 처리하지 못한 출력이 너무 쌓이면 그 세션의 출력 읽기를
// 멈춘다.
//
// 코어는 출력이 오는 대로 읽어 보내는데 화면(xterm)이 그리는 속도는 초당 25MB 남짓이다. 그보다
// 빨리 쏟아지면 못 그린 출력이 렌더러에 쌓여 메모리가 GB 단위로 늘고, Ctrl+C 를 눌러도 쌓인 것을 다
// 그릴 때까지 프롬프트가 돌아오지 않았다(10초 쏟아지면 큐 180MB, 프롬프트까지 7초).
//
// 읽기를 멈추면 쌓이는 곳이 출력하는 프로그램 쪽으로 옮겨 간다. 로컬 셸은 PTY 가 차서, SSH 는 우리가
// 채널에서 읽은 만큼만 서버에 창을 다시 열어 주므로(x/crypto) 원격 프로그램이 출력하다가 기다린다.
// 입력은 반대 방향이라 멈추지 않는다 — Ctrl+C 는 그대로 간다.
//
// 렌더러가 세션 출력을 구독하면 Start, 처리한 만큼 Ack, 구독을 끊으면 Stop 이 온다. 그 사이에만 센다.
// 기본은 꺼져 있어서 렌더러가 없는 곳(모바일, 서버)과 흐름 제어를 쓰지 않는 세션 종류는 영향이 없다.
//
// 창이 숨으면 SetHidden 이 온다. 숨은 창은 타이머가 1분에 한 번으로 줄어 ack 가 그만큼 뜸해지므로,
// 그동안은 안전망(DefaultStallTimeout)을 재지 않고 멈춘 채 기다린다.
package flowcontrol

import (
	"sync"
	"time"
)

const (
	// DefaultHighWatermark 를 넘게 처리 안 된 출력이 쌓이면 읽기를 멈춘다. Ctrl+C 뒤 화면에 남는
	// 양이 이만큼(+SSH 창 2MB)이라 0.1초 안팎에 다 그린다.
	DefaultHighWatermark int64 = 1 << 20
	// DefaultLowWatermark 아래로 내려가면 다시 읽는다. 상한과 벌려 두어 한 바이트마다 멈췄다
	// 풀렸다 하지 않게 한다.
	DefaultLowWatermark int64 = 256 << 10
	// DefaultStallTimeout 동안 멈춘 채 ack 가 하나도 없으면 렌더러가 사라진 것으로 보고 푼다.
	// 렌더러는 처리 중이면 0 바이트 ack 로도 살아 있음을 알리므로, 정상이면 이 시간에 닿지 않는다.
	// 푼 뒤에도 세기는 계속하고, 렌더러가 다시 ack 하면 다시 멈출 수 있게 된다.
	DefaultStallTimeout = 10 * time.Second
)

// Registry 는 세션별 "렌더러로 보냈지만 아직 처리되지 않은 바이트" 를 센다. nil 이면 모든 메서드가
// 아무것도 하지 않는다 — 흐름 제어를 쓰지 않는 매니저는 nil 을 들고 있으면 된다.
type Registry struct {
	mu       sync.Mutex
	sessions map[string]*gate
	high     int64
	low      int64
	stall    time.Duration
	now      func() time.Time
}

type gate struct {
	unacked int64
	paused  bool
	// resume 은 멈춤이 풀릴 때 닫힌다. 기다리는 읽기 루프가 여럿일 수 있다(SSH 는 stdout·stderr).
	resume chan struct{}
	// lastSign 은 렌더러가 마지막으로 살아 있음을 알린 시각이다(Start·Ack·멈춘 시각 중 늦은 것).
	lastSign time.Time
	// onPause·onResume 이 있으면(StartObserved) 기다리는 대신 상한·하한을 넘을 때 이것을 부른다.
	onPause  func()
	onResume func()
	// stallTimer 는 StartObserved 의 안전망이다(Wait 가 없어서 따로 잰다).
	stallTimer *time.Timer
	// hidden 이면 구독한 창이 안 보인다(SetHidden). 숨은 창은 타이머가 1분에 한 번으로 줄어(Chromium)
	// ack 도 0 바이트 ack 도 그만큼 뜸해진다. 그동안 안전망이 풀면 쏟아지는 출력이 렌더러에 끝없이
	// 쌓였다(실측: 최소화 7분에 2.3GB). 숨은 동안은 안전망을 재지 않는다.
	hidden bool
	// disabled 면 안전망이 풀어 둔 세션이다. 세기는 계속하고 멈추지는 않는다. 렌더러가 다시 ack 하면
	// 풀린다 — 예전에는 다시 구독할 때까지 흐름 제어가 영영 꺼져 있었다.
	disabled bool
}

func New() *Registry {
	return NewWithLimits(DefaultHighWatermark, DefaultLowWatermark, DefaultStallTimeout)
}

func NewWithLimits(high, low int64, stall time.Duration) *Registry {
	return &Registry{
		sessions: make(map[string]*gate),
		high:     high,
		low:      low,
		stall:    stall,
		now:      time.Now,
	}
}

// Start 는 세션의 셈을 0부터 시작한다. 이미 세고 있었으면 다시 0으로 돌린다 — 창을 새로 고쳐 다시
// 구독하면 이전 셈은 받을 렌더러가 없어 영영 줄지 않는다.
func (r *Registry) Start(sessionID string) {
	r.start(sessionID, nil, nil)
}

// StartObserved 는 읽기를 멈출 수 없는 출력의 셈을 시작한다. tmux 창이 그렇다 — 모든 창이 채널 하나로
// 와서, 읽기를 멈추면 다른 창과 명령 응답까지 멈춘다.
//
// 기다리는 대신 상대에게 멈추라고 말한다. 처리 안 된 출력이 상한을 넘으면 pause, 하한 아래로 내려가면
// resume 을 부른다. 둘 다 락 밖에서, Sent·Ack 를 부른 고루틴에서 불린다.
func (r *Registry) StartObserved(sessionID string, pause, resume func()) {
	r.start(sessionID, pause, resume)
}

func (r *Registry) start(sessionID string, pause, resume func()) {
	if r == nil {
		return
	}
	r.mu.Lock()
	resumePrevious := r.dropLocked(sessionID)
	r.sessions[sessionID] = &gate{
		resume:   make(chan struct{}),
		lastSign: r.now(),
		onPause:  pause,
		onResume: resume,
	}
	r.mu.Unlock()
	call(resumePrevious)
}

// Stop 은 세지 않게 하고, 기다리는 읽기를 푼다(StartObserved 로 멈춰 두었으면 다시 보내게 한다).
func (r *Registry) Stop(sessionID string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	resume := r.dropLocked(sessionID)
	r.mu.Unlock()
	call(resume)
}

// dropLocked 는 세션의 셈을 지우고, 멈춰 둔 상대를 다시 보내게 할 함수를 돌려준다(없으면 nil).
func (r *Registry) dropLocked(sessionID string) func() {
	current, ok := r.sessions[sessionID]
	if !ok {
		return nil
	}
	current.release()
	current.stopStallTimer()
	delete(r.sessions, sessionID)
	if current.paused {
		return current.onResume
	}
	return nil
}

// Sent 는 렌더러로 보낸 출력 바이트를 더한다. 세고 있지 않은 세션이면 아무것도 하지 않는다.
func (r *Registry) Sent(sessionID string, n int) {
	if r == nil || n <= 0 {
		return
	}
	r.mu.Lock()
	current, ok := r.sessions[sessionID]
	if !ok {
		r.mu.Unlock()
		return
	}
	current.unacked += int64(n)
	var pause func()
	if current.onPause != nil && !current.paused && !current.disabled && current.unacked > r.high {
		current.paused = true
		// 조용하던 창이 막 쏟아지기 시작했을 수 있다. 멈춘 순간부터 렌더러의 답을 기다린다.
		current.lastSign = r.now()
		r.armStallTimerLocked(sessionID, current)
		pause = current.onPause
	}
	r.mu.Unlock()
	call(pause)
}

// Ack 는 렌더러가 처리한 바이트를 뺀다. 0 바이트 ack 는 "아직 살아서 처리 중" 이라는 뜻이다.
func (r *Registry) Ack(sessionID string, n int64) {
	if r == nil {
		return
	}
	r.mu.Lock()
	current, ok := r.sessions[sessionID]
	if !ok {
		r.mu.Unlock()
		return
	}
	current.lastSign = r.now()
	// 안전망이 풀어 둔 세션에 렌더러가 다시 답했다. 그동안 보낸 것도 세어 왔으므로, 처리 안 된 양이
	// 상한 위면 다음 읽기(tmux 창은 다음 출력)에서 다시 멈춘다.
	current.disabled = false
	if n > 0 {
		current.unacked -= n
	}
	// 다시 구독하면 이전 출력(최대 1MB)이 한 번 더 전달돼 보낸 것보다 많이 알릴 수 있다.
	if current.unacked < 0 {
		current.unacked = 0
	}
	var resume func()
	if current.paused && current.unacked <= r.low {
		current.paused = false
		current.release()
		current.stopStallTimer()
		resume = current.onResume
	}
	r.mu.Unlock()
	call(resume)
}

// armStallTimerLocked 는 StartObserved 의 안전망을 건다. 멈춘 채 stall 동안 렌더러가 아무 말이 없으면
// 상대를 다시 보내게 하고, 렌더러가 다시 ack 할 때까지 멈추지 않는다(Wait 의 안전망과 같다).
func (r *Registry) armStallTimerLocked(sessionID string, current *gate) {
	current.stopStallTimer()
	current.stallTimer = time.AfterFunc(r.stall, func() { r.checkObservedStall(sessionID, current) })
}

func (r *Registry) checkObservedStall(sessionID string, watched *gate) {
	r.mu.Lock()
	if r.sessions[sessionID] != watched || !watched.paused {
		r.mu.Unlock()
		return
	}
	if watched.hidden {
		// 숨은 창은 멈춘 채 기다린다. 다시 보이면(SetHidden) 그때부터 다시 잰다.
		watched.stallTimer = nil
		r.mu.Unlock()
		return
	}
	if remaining := r.stall - r.now().Sub(watched.lastSign); remaining > 0 {
		// 그 사이 렌더러가 살아 있다고 알렸다. 남은 만큼 다시 잰다.
		watched.stallTimer = time.AfterFunc(remaining, func() { r.checkObservedStall(sessionID, watched) })
		r.mu.Unlock()
		return
	}
	watched.stallTimer = nil
	watched.paused = false
	watched.disabled = true
	resume := watched.onResume
	r.mu.Unlock()
	call(resume)
}

// SetHidden 은 세션을 구독한 창이 안 보이게(hidden) 또는 다시 보이게 됐다는 뜻이다. 숨은 동안은 멈춘
// 채 기다리고, 다시 보이면 그 순간부터 안전망을 잰다. 렌더러가 숨은 채 사라지면 메인이 Stop 을 보낸다.
func (r *Registry) SetHidden(sessionID string, hidden bool) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	current, ok := r.sessions[sessionID]
	if !ok || current.hidden == hidden {
		return
	}
	current.hidden = hidden
	if hidden || !current.paused {
		return
	}
	current.lastSign = r.now()
	if current.onPause != nil {
		r.armStallTimerLocked(sessionID, current)
		return
	}
	// 기다리는 읽기를 깨워 새 시한으로 다시 기다리게 한다. 멈춤은 그대로다.
	current.release()
}

func (g *gate) stopStallTimer() {
	if g.stallTimer != nil {
		g.stallTimer.Stop()
		g.stallTimer = nil
	}
}

func call(callback func()) {
	if callback != nil {
		callback()
	}
}

// Wait 는 처리 안 된 출력이 상한을 넘었으면 하한 아래로 내려갈 때까지 기다린다. 세션이 닫히거나
// (closed), 흐름 제어가 꺼지거나, 창이 보이는데 멈춘 채 stall 동안 렌더러가 아무 말이 없으면 바로
// 돌아온다.
//
// 읽기 루프가 Read 하기 전에 부른다. 읽지 않으면 그 출력은 PTY·SSH 창에 머물고 프로그램이 기다린다.
func (r *Registry) Wait(sessionID string, closed <-chan struct{}) {
	if r == nil {
		return
	}
	for {
		r.mu.Lock()
		current, ok := r.sessions[sessionID]
		if !ok || current.disabled || (!current.paused && current.unacked <= r.high) {
			r.mu.Unlock()
			return
		}
		if !current.paused {
			current.paused = true
			// 조용하던 세션이 막 쏟아지기 시작했을 수 있다. 멈춘 순간부터 기다린다.
			current.lastSign = r.now()
		}
		resume := current.resume
		// 숨은 창은 시한 없이 기다린다(timeout 이 nil 이면 그 case 는 오지 않는다).
		var timeout <-chan time.Time
		var timer *time.Timer
		if !current.hidden {
			remaining := r.stall - r.now().Sub(current.lastSign)
			if remaining <= 0 {
				// 렌더러가 죽었거나 버그로 ack 가 끊겼다. 세션이 영영 멈추지 않게 풀고, 렌더러가 다시
				// ack 할 때까지 멈추지 않는다.
				current.paused = false
				current.disabled = true
				current.release()
				r.mu.Unlock()
				return
			}
			timer = time.NewTimer(remaining)
			timeout = timer.C
		}
		r.mu.Unlock()

		select {
		case <-resume:
		case <-closed:
			stopTimer(timer)
			return
		case <-timeout:
		}
		stopTimer(timer)
	}
}

func stopTimer(timer *time.Timer) {
	if timer != nil {
		timer.Stop()
	}
}

// release 는 기다리는 쪽을 모두 깨운다. 여러 번 불러도 된다.
func (g *gate) release() {
	close(g.resume)
	g.resume = make(chan struct{})
}
