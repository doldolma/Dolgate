package autocomplete

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestPromptSettleGateFiresSettledAfterPrompt(t *testing.T) {
	gate := NewPromptSettleGate(20*time.Millisecond, time.Second)
	var settled, timedOut atomic.Int32
	gate.Arm(func() { settled.Add(1) }, func() { timedOut.Add(1) })

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
	gate.Arm(func() { settled.Add(1) }, func() { timedOut.Add(1) })

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
	gate.Arm(func() { settled.Add(1) }, func() {})

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

func TestPromptSettleGateDisarm(t *testing.T) {
	gate := NewPromptSettleGate(20*time.Millisecond, 40*time.Millisecond)
	var settled, timedOut atomic.Int32
	gate.Arm(func() { settled.Add(1) }, func() { timedOut.Add(1) })
	gate.Disarm()
	gate.Observe([]byte("host$ "))
	time.Sleep(80 * time.Millisecond)
	if settled.Load() != 0 || timedOut.Load() != 0 {
		t.Fatalf("no callback should fire after Disarm (settled=%d timeout=%d)", settled.Load(), timedOut.Load())
	}
}
