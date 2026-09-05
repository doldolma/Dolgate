package autocomplete

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestPromptSettleGateFiresSettledAfterPrompt(t *testing.T) {
	gate := NewPromptSettleGate(20*time.Millisecond, time.Second)
	var settled, timedOut atomic.Int32
	gate.Arm(func([]byte) { settled.Add(1) }, func() { timedOut.Add(1) })

	// Banner output that is not a prompt must not fire.
	gate.Observe([]byte("Last login: Tue\r\nWelcome\r\n"))
	time.Sleep(40 * time.Millisecond)
	if settled.Load() != 0 {
		t.Fatalf("settled fired on non-prompt output")
	}

	// A prompt-looking tail then quiet must fire onSettled exactly once.
	gate.Observe([]byte("user@host:~$ "))
	time.Sleep(60 * time.Millisecond)
	if got := settled.Load(); got != 1 {
		t.Fatalf("onSettled fired %d times, want 1", got)
	}
	if timedOut.Load() != 0 {
		t.Fatalf("onTimeout fired unexpectedly")
	}
	// Further output after firing must be ignored (gate disarmed).
	gate.Observe([]byte("more$ "))
	time.Sleep(40 * time.Millisecond)
	if settled.Load() != 1 {
		t.Fatalf("onSettled fired again after disarm")
	}
}

func TestPromptSettleGateTimesOutWithoutPrompt(t *testing.T) {
	gate := NewPromptSettleGate(20*time.Millisecond, 40*time.Millisecond)
	var settled, timedOut atomic.Int32
	gate.Arm(func([]byte) { settled.Add(1) }, func() { timedOut.Add(1) })

	// Password prompt never looks like a shell prompt → should time out.
	gate.Observe([]byte("user@host's password: "))
	time.Sleep(80 * time.Millisecond)
	if timedOut.Load() != 1 {
		t.Fatalf("onTimeout fired %d times, want 1", timedOut.Load())
	}
	if settled.Load() != 0 {
		t.Fatalf("onSettled fired on a password prompt")
	}
}

func TestPromptSettleGateResetsQuietOnMoreOutput(t *testing.T) {
	gate := NewPromptSettleGate(50*time.Millisecond, time.Second)
	var settled atomic.Int32
	gate.Arm(func([]byte) { settled.Add(1) }, func() {})

	gate.Observe([]byte("host$ "))
	time.Sleep(30 * time.Millisecond) // less than quiet
	// A late continuation (e.g. multi-line prompt) cancels the pending settle.
	gate.Observe([]byte("\r\nsecond line no glyph"))
	time.Sleep(30 * time.Millisecond)
	if settled.Load() != 0 {
		t.Fatalf("settle should have been cancelled by non-prompt continuation")
	}
	gate.Observe([]byte("\r\nhost$ "))
	time.Sleep(80 * time.Millisecond)
	if settled.Load() != 1 {
		t.Fatalf("onSettled should fire once output rests at a prompt again")
	}
}

func TestPromptSettleGateCancelsPromptCandidateBeforeUserInputIsWritten(t *testing.T) {
	gate := NewPromptSettleGate(40*time.Millisecond, time.Second)
	var settled atomic.Int32
	gate.Arm(func([]byte) { settled.Add(1) }, func() {})

	gate.Observe([]byte("host$ "))
	time.Sleep(10 * time.Millisecond)
	gate.ObserveInput([]byte("echo >"))
	// A delayed remote echo ending in a prompt-shaped glyph is still user input.
	gate.Observe([]byte("echo >"))
	time.Sleep(70 * time.Millisecond)
	if got := settled.Load(); got != 0 {
		t.Fatalf("settled fired %d times on a user's partial input", got)
	}

	// Enter is observed before it is written. The echoed line is discarded and
	// only the fresh prompt after its line boundary may settle.
	gate.ObserveInput([]byte("\r"))
	gate.Observe([]byte("\r\ncommand output\r\nhost$ "))
	time.Sleep(70 * time.Millisecond)
	if got := settled.Load(); got != 1 {
		t.Fatalf("settled fired %d times after the next fresh prompt, want 1", got)
	}
}

func TestPromptSettleGateDoesNotReuseSubmittedLineEndingInPromptGlyph(t *testing.T) {
	gate := NewPromptSettleGate(30*time.Millisecond, time.Second)
	var settled atomic.Int32
	gate.Arm(func([]byte) { settled.Add(1) }, func() {})

	gate.Observe([]byte("host$ "))
	gate.ObserveInput([]byte(">\r"))
	gate.Observe([]byte(">"))
	time.Sleep(50 * time.Millisecond)
	if got := settled.Load(); got != 0 {
		t.Fatalf("settled fired %d times before the submitted line ended", got)
	}
	gate.Observe([]byte("\r\n"))
	time.Sleep(50 * time.Millisecond)
	if got := settled.Load(); got != 0 {
		t.Fatalf("settled fired %d times on the echoed submitted line", got)
	}
	gate.Observe([]byte("host$ "))
	time.Sleep(50 * time.Millisecond)
	if got := settled.Load(); got != 1 {
		t.Fatalf("settled fired %d times after the real prompt, want 1", got)
	}
}

func TestPromptSettleGateDisarm(t *testing.T) {
	gate := NewPromptSettleGate(20*time.Millisecond, 40*time.Millisecond)
	var settled, timedOut atomic.Int32
	gate.Arm(func([]byte) { settled.Add(1) }, func() { timedOut.Add(1) })
	gate.Disarm()
	gate.Observe([]byte("host$ "))
	time.Sleep(80 * time.Millisecond)
	if settled.Load() != 0 || timedOut.Load() != 0 {
		t.Fatalf("no callback should fire after Disarm (settled=%d timeout=%d)", settled.Load(), timedOut.Load())
	}
}

// 게이트는 안착한 프롬프트의 **출력 꼬리**를 콜백에 넘긴다. 부르는 쪽이 그걸 보고 "서브셸이
// 뜨지 않았다"(원래 셸이 마커 붙은 프롬프트를 그렸다)를 판정한다.
func TestSettledCallbackReceivesTheObservedTail(t *testing.T) {
	gate := NewPromptSettleGate(20*time.Millisecond, time.Second)
	got := make(chan []byte, 1)
	gate.Arm(func(tail []byte) { got <- tail }, func() {})

	gate.Observe([]byte("zsh: command not found: fish\r\n"))
	gate.Observe([]byte(PromptStartMarker + "user@host ~ % "))

	select {
	case tail := <-got:
		if !PromptAlreadyIntegrated(tail) {
			t.Fatalf("꼬리에 프롬프트 마커가 있어야 한다: %q", tail)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("게이트가 발화하지 않았다")
	}
}

// 새 셸의 맨 프롬프트에는 마커가 없다 — 그때는 주입해야 한다.
func TestFreshSubshellPromptIsNotReportedAsIntegrated(t *testing.T) {
	gate := NewPromptSettleGate(20*time.Millisecond, time.Second)
	got := make(chan []byte, 1)
	gate.Arm(func(tail []byte) { got <- tail }, func() {})

	gate.Observe([]byte("bash-3.2$ "))

	select {
	case tail := <-got:
		if PromptAlreadyIntegrated(tail) {
			t.Fatalf("마커 없는 프롬프트를 통합된 것으로 봤다: %q", tail)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("게이트가 발화하지 않았다")
	}
}

// ArmQuiet 는 꼬리 모양을 보지 않는다. RPROMPT 가 뒤에 그려진 zsh 프롬프트처럼 `$ # % >` 로 끝나지
// 않는 출력도 잠잠해지면 정착이다 — Arm 은 그런 꼬리에서 절대 정착하지 않는다(대조).
func TestPromptSettleGateArmQuietSettlesRegardlessOfTheTailShape(t *testing.T) {
	tail := []byte("user@host ~ % [14:08]")

	quiet := NewPromptSettleGate(30*time.Millisecond, time.Second)
	settled := make(chan struct{}, 1)
	quiet.ArmQuiet(func([]byte) { settled <- struct{}{} }, func() {})
	quiet.Observe(tail)
	select {
	case <-settled:
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("ArmQuiet 가 프롬프트 모양이 아닌 꼬리에서 정착하지 않았다")
	}

	shaped := NewPromptSettleGate(30*time.Millisecond, 200*time.Millisecond)
	settledShaped := make(chan struct{}, 1)
	timedOut := make(chan struct{}, 1)
	shaped.Arm(func([]byte) { settledShaped <- struct{}{} }, func() { timedOut <- struct{}{} })
	shaped.Observe(tail)
	select {
	case <-settledShaped:
		t.Fatalf("Arm 이 프롬프트 모양이 아닌 꼬리에서 정착했다 — 대조군이 깨졌다")
	case <-timedOut:
	case <-time.After(time.Second):
		t.Fatalf("Arm 이 타임아웃도 하지 않았다")
	}
}
