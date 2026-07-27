package sshsession

import (
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
)

// stdinProbeHold widens the window a writer spends "inside" the pipe so that an
// unserialized second writer actually overlaps instead of slipping past.
const stdinProbeHold = 200 * time.Microsecond

// stdinProbe stands in for the session's real stdin. In production that is an
// x/crypto/ssh channel, and channel.WriteExtended reuses one packet buffer per
// stream — upstream documents that concurrent Write calls on it are a data race
// ("WriteExtended calls from different goroutines will be flagged as errors by
// the race detector"), and a partially written 1KB init command interleaved with
// keystrokes reaches the remote PTY as a corrupt command line. So the probe
// fails the test if two goroutines are ever inside Write at the same time, and
// records each Write as one indivisible payload.
type stdinProbe struct {
	inFlight atomic.Int32
	overlaps atomic.Int32

	mu       sync.Mutex
	payloads []string
}

func (p *stdinProbe) Write(b []byte) (int, error) {
	if p.inFlight.Add(1) > 1 {
		p.overlaps.Add(1)
	}
	time.Sleep(stdinProbeHold)
	p.mu.Lock()
	p.payloads = append(p.payloads, string(b))
	p.mu.Unlock()
	p.inFlight.Add(-1)
	return len(b), nil
}

func (p *stdinProbe) Close() error { return nil }

func (p *stdinProbe) snapshot() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.payloads...)
}

func (p *stdinProbe) contains(want string) bool {
	for _, got := range p.snapshot() {
		if got == want {
			return true
		}
	}
	return false
}

// Injected shell-integration commands are written from a timer goroutine while
// the user keeps typing, so every stdin writer must be serialized. Without that,
// the two writers race on the ssh channel's shared packet buffer and the ~1KB
// init command can reach the remote shell interleaved with keystrokes.
func TestStdinWritesAreSerializedAcrossInjectionAndUserInput(t *testing.T) {
	probe := &stdinProbe{}
	h := &sessionHandle{
		stdin:        probe,
		closed:       make(chan struct{}),
		reinjectGate: autocomplete.NewPromptSettleGate(20*time.Millisecond, time.Second),
	}
	m := NewManager(func(_ protocol.Event) {}, func(_ protocol.StreamFrame, _ []byte) {})
	m.mu.Lock()
	m.sessions["s1"] = h
	m.mu.Unlock()
	defer close(h.closed)

	if err := m.ReinjectShellIntegration("s1"); err != nil {
		t.Fatalf("arm reinject failed: %v", err)
	}

	// Keep user keystrokes in flight so the gate's injection lands in the middle
	// of them rather than in a quiet moment.
	injected := autocomplete.ShellIntegrationInitCommand()
	stop := make(chan struct{})
	var typists sync.WaitGroup
	for i := 0; i < 4; i++ {
		typists.Add(1)
		go func() {
			defer typists.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				if err := m.WriteBytes("s1", []byte("ls -al\r")); err != nil {
					t.Errorf("user input write failed: %v", err)
					return
				}
			}
		}()
	}

	h.reinjectGate.Observe([]byte("user@remote2:~$ "))
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && !probe.contains(injected) {
		time.Sleep(2 * time.Millisecond)
	}
	close(stop)
	typists.Wait()

	if !probe.contains(injected) {
		t.Fatalf("re-injection never reached stdin as a single write")
	}
	if got := probe.overlaps.Load(); got != 0 {
		t.Fatalf("stdin writers overlapped %d time(s): concurrent writes to the ssh channel corrupt the injected command", got)
	}
	// A torn injection would show up as a payload that is a strict fragment of
	// the init command rather than the whole thing.
	for _, payload := range probe.snapshot() {
		if payload != injected && strings.Contains(injected, payload) && len(payload) > len("ls -al\r") {
			t.Fatalf("injected command reached stdin torn into fragments: %q", payload)
		}
	}
}
