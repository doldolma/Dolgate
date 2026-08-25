package autocomplete

import (
	"sync"
	"time"
)

// Default timing for subshell shell-integration re-injection.
const (
	// PromptSettleQuiet is how long output must stay quiet after a
	// prompt-looking tail before the (sub)shell is considered ready to receive
	// the injected init command.
	PromptSettleQuiet = 400 * time.Millisecond
	// PromptSettleMaxWait bounds how long to wait for a prompt to appear after a
	// subshell command (ssh/sudo su/docker exec) before giving up. Covers
	// interactive auth (password/2FA) taking a while before the remote prompt.
	PromptSettleMaxWait = 20 * time.Second
	// promptTailLimit caps the retained output tail used for prompt detection.
	promptTailLimit = 2048
)

// PromptSettleGate waits for a freshly entered (sub)shell to display a settled
// interactive prompt before its caller writes an injected shell-integration
// init command. Feed session output to Observe; the gate fires onSettled once
// the output tail looks like a shell prompt and output has then stayed quiet
// for the quiet window, or onTimeout if no prompt appears within maxWait.
//
// Unlike the AWS connect-time install, the gate deliberately does NOT arm the
// output-suppression handshake while waiting — the user must still see the
// subshell's login banner, motd and any password prompt. The caller arms the
// handshake and writes the init command inside onSettled, so only the injected
// command's echo is hidden.
//
// Exactly one of onSettled/onTimeout fires per Arm (unless Disarm is called
// first). Both run on a timer goroutine and must not call back into the gate.
type PromptSettleGate struct {
	quiet   time.Duration
	maxWait time.Duration
	tailCap int

	mu         sync.Mutex
	armed      bool
	tail       []byte
	quietTimer *time.Timer
	maxTimer   *time.Timer
	onSettled  func(tail []byte)
	onTimeout  func()
}

// NewPromptSettleGate builds a gate with the given quiet/maxWait windows. Zero
// or negative values fall back to the package defaults.
func NewPromptSettleGate(quiet, maxWait time.Duration) *PromptSettleGate {
	if quiet <= 0 {
		quiet = PromptSettleQuiet
	}
	if maxWait <= 0 {
		maxWait = PromptSettleMaxWait
	}
	return &PromptSettleGate{quiet: quiet, maxWait: maxWait, tailCap: promptTailLimit}
}

// Arm starts watching for a prompt. Any prior watch is cancelled first.
//
// onSettled 는 프롬프트가 안착했을 때 **그때까지의 출력 꼬리**와 함께 불린다. 부르는 쪽이 그
// 꼬리를 보고 "이 프롬프트에 이미 우리 마커가 있나"(=서브셸이 뜨지 않았고 원래 셸이 돌아왔다)
// 를 판정한다 — PromptAlreadyIntegrated 참고.
func (g *PromptSettleGate) Arm(onSettled func(tail []byte), onTimeout func()) {
	g.mu.Lock()
	g.stopTimersLocked()
	g.armed = true
	g.tail = g.tail[:0]
	g.onSettled = onSettled
	g.onTimeout = onTimeout
	g.maxTimer = time.AfterFunc(g.maxWait, g.fireTimeout)
	g.mu.Unlock()
}

// Observe feeds one chunk of raw session output to the gate. It is a no-op when
// the gate is not armed, so it is cheap to call unconditionally from a stream
// loop.
func (g *PromptSettleGate) Observe(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.armed {
		return
	}
	g.tail = append(g.tail, chunk...)
	if len(g.tail) > g.tailCap {
		g.tail = append(g.tail[:0], g.tail[len(g.tail)-g.tailCap:]...)
	}
	if LooksLikeShellPrompt(string(g.tail)) {
		if g.maxTimer != nil {
			g.maxTimer.Stop()
			g.maxTimer = nil
		}
		if g.quietTimer == nil {
			g.quietTimer = time.AfterFunc(g.quiet, g.fireSettled)
		} else {
			g.quietTimer.Reset(g.quiet)
		}
		return
	}
	// More output arrived that does not end at a prompt (still mid-command or a
	// multi-line banner) — cancel the pending settle so we only fire once output
	// truly comes to rest at a prompt.
	if g.quietTimer != nil {
		g.quietTimer.Stop()
		g.quietTimer = nil
	}
}

// Armed reports whether the gate is currently waiting for a prompt.
func (g *PromptSettleGate) Armed() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.armed
}

// Disarm cancels an in-flight watch without firing either callback.
func (g *PromptSettleGate) Disarm() {
	g.mu.Lock()
	g.armed = false
	g.stopTimersLocked()
	g.mu.Unlock()
}

func (g *PromptSettleGate) fireSettled() {
	g.mu.Lock()
	if !g.armed {
		g.mu.Unlock()
		return
	}
	g.armed = false
	// 꼬리는 stopTimersLocked 가 비우므로 먼저 복사한다.
	tail := append([]byte(nil), g.tail...)
	g.stopTimersLocked()
	cb := g.onSettled
	g.mu.Unlock()
	if cb != nil {
		cb(tail)
	}
}

func (g *PromptSettleGate) fireTimeout() {
	g.mu.Lock()
	if !g.armed {
		g.mu.Unlock()
		return
	}
	g.armed = false
	g.stopTimersLocked()
	cb := g.onTimeout
	g.mu.Unlock()
	if cb != nil {
		cb()
	}
}

func (g *PromptSettleGate) stopTimersLocked() {
	if g.quietTimer != nil {
		g.quietTimer.Stop()
		g.quietTimer = nil
	}
	if g.maxTimer != nil {
		g.maxTimer.Stop()
		g.maxTimer = nil
	}
	g.tail = g.tail[:0]
}
