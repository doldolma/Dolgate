package shellintegration

import (
	"strings"

	"dolssh/services/ssh-core/internal/autocomplete"
)

// ReinjectTarget is one transport's half of "wait for the subshell's prompt,
// then put the integration in".
//
// The half that lives here is the part every transport had written out for
// itself: normalize the hint, refuse shells that cannot take the integration,
// wait for a settled prompt, notice that no subshell actually appeared, and
// decide between "inject what we know" and "ask the shell who it is". The half
// that stays with the caller is everything that differs — where output goes
// (protocol frames, a ring buffer, a tmux pane), how a session is looked up,
// and whether this shell already answered "no".
type ReinjectTarget struct {
	Gate *autocomplete.PromptSettleGate
	// ShellHint is what the caller already knows about the subshell. Empty means
	// "ask it", which is the normal case for `sudo su` and `docker exec`.
	ShellHint string
	// Alive reports that the session still exists when the prompt settles. The
	// gate can fire seconds after arming, and the session may be gone by then.
	Alive func() bool
	// Commit runs after the quiet timer wins but before the verdict below. Only
	// mobile uses it, to hold user input while the internal write goes out.
	Commit func()
	// Finish undoes Commit on the paths that end here rather than in Inject or
	// Probe — those two release it themselves, since they know when their own
	// write is done.
	Finish func()
	// Unsupported reports that the foreground shell was already asked and said
	// it cannot take the integration. Transports without that memory pass nil.
	Unsupported func() bool
	// Inject receives a shell that is safe to type into (bash, zsh or fish).
	Inject func(shell string)
	// Probe runs the in-band identification when the shell is unknown. It is
	// normally ProbeShellThenInject wired to this transport.
	Probe func()
}

func (t ReinjectTarget) finish() {
	if t.Finish != nil {
		t.Finish()
	}
}

// ArmReinject waits for the subshell's prompt and then hands off to the target.
//
// It returns whether the gate was armed. A named shell that cannot take the
// integration (dash, ksh, PowerShell over a remote PTY) is refused here rather
// than after a round trip: we already know the answer, and typing a probe into
// it would only leave a "not recognized" line on the user's screen.
func ArmReinject(target ReinjectTarget) bool {
	if target.Gate == nil || (target.Inject == nil && target.Probe == nil) {
		return false
	}
	shell := NormalizeRemoteShell(target.ShellHint)
	if strings.TrimSpace(target.ShellHint) != "" && shell == "" {
		return false
	}

	onSettled := func(tail []byte) {
		if target.Alive != nil && !target.Alive() {
			target.finish()
			return
		}
		// 서브셸이 뜨지 않았으면(진입 명령 실패 → 원래 셸이 새 프롬프트를 그림) 그 프롬프트에
		// 이미 우리 마커가 있다. 보내 봐야 프롬프트만 한 번 더 남는다.
		if autocomplete.PromptAlreadyIntegrated(tail) {
			target.finish()
			return
		}
		if shell != "" {
			if target.Inject == nil {
				target.finish()
				return
			}
			target.Inject(shell)
			return
		}
		// 지금 앞에 있는 그 셸에는 이미 물어봤고 답이 "없다" 였다. 다시 묻지 않는다.
		if target.Unsupported != nil && target.Unsupported() {
			target.finish()
			return
		}
		if target.Probe == nil {
			target.finish()
			return
		}
		target.Probe()
	}

	// 프롬프트가 창 안에 안 뜨면(낯선 프롬프트, 셸이 아닌 것이 앞에 있음, 아직 인증 중)
	// 세션을 건드리지 않고 그냥 둔다.
	onTimeout := func() { target.finish() }
	if target.Commit != nil {
		target.Gate.ArmWithCommit(target.Commit, onSettled, onTimeout)
		return true
	}
	target.Gate.Arm(onSettled, onTimeout)
	return true
}
