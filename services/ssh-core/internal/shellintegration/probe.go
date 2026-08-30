package shellintegration

import (
	"errors"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
)

const DefaultHandshakeTimeout = 8 * time.Second

// ProbeTarget contains the transport-specific operations needed to identify
// the foreground shell and hand the result back to its integration installer.
// Probe/Handshake are owned by the shell or pane and must observe raw output in
// that order before the visible bytes are emitted.
type ProbeTarget struct {
	Probe         *autocomplete.ShellProbe
	Handshake     *autocomplete.Handshake
	ProbeCommand  string
	Write         func([]byte) error
	BeforeWrite   func()
	Emit          func([]byte)
	OnUnsupported func()
	OnShell       func(shell string)
	// OnFinished runs once after OnShell/OnUnsupported has completed, the probe
	// write failed, or the attempt ended/timed out. It lets transports release
	// user input that was held only to preserve ordering with the internal write.
	OnFinished func()
	Done       <-chan struct{}
	Timeout    time.Duration
}

// ProbeShellThenInject runs the shared in-band shell-identification sequence.
// It deliberately knows nothing about SSH, local PTYs, tmux panes, command
// blocks, or prompt clearing; those policies are supplied by ProbeTarget.
func ProbeShellThenInject(target ProbeTarget) error {
	var finishOnce sync.Once
	finish := func() {
		finishOnce.Do(func() {
			if target.OnFinished != nil {
				target.OnFinished()
			}
		})
	}
	if target.Probe == nil || target.Handshake == nil {
		finish()
		return errors.New("shell integration probe state is required")
	}
	if target.ProbeCommand == "" || target.Write == nil {
		if target.OnUnsupported != nil {
			target.OnUnsupported()
		}
		finish()
		return nil
	}

	probeGeneration := target.Probe.Arm(func(shell string) {
		defer finish()
		if shell == "" {
			if target.OnUnsupported != nil {
				target.OnUnsupported()
			}
			return
		}
		if target.OnShell != nil {
			target.OnShell(shell)
		}
	})
	handshakeGeneration := target.Handshake.ArmForShellProbe(false, target.ProbeCommand)
	if target.BeforeWrite != nil {
		target.BeforeWrite()
	}
	if err := target.Write([]byte(target.ProbeCommand)); err != nil {
		target.Probe.DisarmAttempt(probeGeneration)
		emit(target, target.Handshake.FlushAttempt(handshakeGeneration))
		finish()
		return err
	}

	timeout := target.Timeout
	if timeout <= 0 {
		timeout = DefaultHandshakeTimeout
	}
	go func() {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		if target.Done == nil {
			<-timer.C
		} else {
			select {
			case <-target.Done:
				target.Probe.DisarmAttempt(probeGeneration)
				finish()
				return
			case <-timer.C:
			}
		}
		if target.Probe.DisarmAttempt(probeGeneration) {
			emit(target, target.Handshake.FlushAttempt(handshakeGeneration))
			finish()
		}
	}()
	return nil
}

func emit(target ProbeTarget, data []byte) {
	if len(data) > 0 && target.Emit != nil {
		target.Emit(data)
	}
}
