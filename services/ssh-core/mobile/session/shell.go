package session

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/shellintegration"
	"dolssh/services/ssh-core/mobile/ringbuf"
)

// ErrShellClosed is returned by operations on a shell whose channel is gone.
var ErrShellClosed = errors.New("shell session is closed")

// Size of each read from the shell's output pipes. Whatever a read returns is
// appended immediately rather than buffered further: the ring is what absorbs
// bursts, and holding bytes back here would only add latency to the terminal.
const readBufferBytes = 32 * 1024

// ShellOptions configures a shell channel. Zero values take defaults.
type ShellOptions struct {
	Term       TerminalType
	Rows       uint32
	Cols       uint32
	PixelWidth uint32
	// PixelHeight, with PixelWidth, is advertised in the pty-req for programs
	// that draw graphics. Note that a later Resize cannot update it: the SSH
	// window-change request carries character dimensions only.
	PixelHeight uint32
	// Modes overrides the pty-req terminal modes. Empty means
	// DefaultTerminalModes.
	Modes []TerminalMode
	// RingCapacityBytes and MaxChunkBytes size the output history; non-positive
	// values take the ringbuf defaults.
	RingCapacityBytes int
	MaxChunkBytes     int
	// IntegrationShell is detected by Conn before this PTY channel opens. Empty
	// falls back to a safe in-band probe after the first prompt. It is internal
	// engine state, not part of the gomobile options JSON.
	IntegrationShell string
	// OnIntegrationShellDetected receives a supported shell found by the in-band
	// PTY probe. Conn uses it to retain the shell identity when auxiliary exec
	// channels are unavailable, so degraded autocomplete can still expose its
	// session-local sources.
	OnIntegrationShellDetected func(shell string)
	// OnClosed fires once, after the channel has ended and all output has been
	// stored. It runs on an internal goroutine.
	OnClosed func(channelID uint32)
}

// ShellInfo identifies a shell channel.
type ShellInfo struct {
	// ChannelID is assigned by this engine, not taken from the SSH protocol:
	// x/crypto/ssh does not expose the channel number. It is unique within a
	// Conn and is only ever used as a handle.
	ChannelID     uint32
	CreatedAtMs   float64
	ConnectedAtMs float64
	Term          TerminalType
	ConnectionID  string
}

// Shell is a live PTY-backed shell whose output is retained in a ring buffer.
type Shell struct {
	info ShellInfo
	ring *ringbuf.Ring

	session *ssh.Session
	stdin   io.WriteCloser

	// writeMu serializes stdin writes; the app can send keystrokes from more
	// than one place (terminal view, paste, control signals).
	writeMu sync.Mutex
	// integrationWritePending is set without writeMu on purpose. beginIntegrationWrite
	// runs inside the settle gate's lock, and taking writeMu there would mean holding
	// that lock across a PTY write that can block on a full SSH window — the output
	// pump calls Observe on the same lock, so the terminal would stop rendering until
	// the write drained. Ordering still holds: a user write cannot pass ObserveInput
	// until the gate releases its lock, so the flag is already set when it reads it.
	integrationWritePending atomic.Bool
	pendingIntegrationInput []byte

	readers   sync.WaitGroup
	closeOnce sync.Once
	finishOne sync.Once
	done      chan struct{}
	onClosed  func(channelID uint32)

	detach func()

	onIntegrationShellDetected func(shell string)

	// integrationResolved is set once the first-prompt gate reached a verdict:
	// installed, already present, or this shell cannot take it. Until then a
	// submitted line re-arms the gate — see rearmInstallGateOnSubmit.
	integrationResolved atomic.Bool
	// armInstallGate re-arms the first-prompt gate with the same callbacks.
	armInstallGate func()

	handshake                   autocomplete.Handshake
	shellProbe                  autocomplete.ShellProbe
	installGate                 *autocomplete.PromptSettleGate
	reinjectGate                *autocomplete.PromptSettleGate
	shellIntegrationUnsupported bool
	integrationMu               sync.Mutex
}

// Info returns the shell's identity.
func (s *Shell) Info() ShellInfo { return s.info }

// Ring exposes the output history, for reads and for following live output.
func (s *Shell) Ring() *ringbuf.Ring { return s.ring }

// Done is closed once the channel has ended and all output has been stored.
func (s *Shell) Done() <-chan struct{} { return s.done }

// SendData writes user-originated bytes to the shell's stdin. Prompt settle
// gates observe them before the remote echo can arrive, so an integration
// probe/init command is never appended to a line the user has started editing.
func (s *Shell) SendData(data []byte) error {
	s.rearmInstallGateOnSubmit(data)
	if s.installGate != nil {
		s.installGate.ObserveInput(data)
	}
	if s.reinjectGate != nil {
		s.reinjectGate.ObserveInput(data)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.integrationWritePending.Load() {
		s.pendingIntegrationInput = append(s.pendingIntegrationInput, data...)
		return nil
	}
	return s.writeDataLocked(data)
}

// rearmInstallGateOnSubmit gives the first-prompt gate another chance when the
// user submits a line.
//
// A keystroke during the login banner invalidates the prompt candidate on
// purpose — appending our init command to a line the user has started editing
// would run a garbled command. But the gate then has nowhere to recover from:
// its window ends and nothing re-arms it, so that session never gets shell
// integration at all. Enter is exactly the moment the edited line goes away and
// a fresh prompt is coming, so we start watching again.
//
// This stops on its own. Once the gate reaches a verdict (installed, already
// present, or this shell cannot take it) integrationResolved is set and no
// further re-arm happens; a re-arm after a successful install would settle on a
// prompt that already carries our marker and return immediately anyway.
func (s *Shell) rearmInstallGateOnSubmit(data []byte) {
	if s.installGate == nil || s.armInstallGate == nil || s.integrationResolved.Load() {
		return
	}
	if s.installGate.Armed() || !bytes.ContainsAny(data, "\r\n") {
		return
	}
	select {
	case <-s.done:
		return
	default:
	}
	// Re-arm before ObserveInput runs, so this very submission marks the fresh
	// watch as "input in flight" and the echoed line cannot pose as a prompt.
	s.armInstallGate()
}

// sendInternalData bypasses user-input observation for the gate's own
// probe/init writes. Both paths still share writeMu to preserve PTY byte order.
func (s *Shell) sendInternalData(data []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.writeDataLocked(data)
}

func (s *Shell) writeDataLocked(data []byte) error {
	if _, err := s.stdin.Write(data); err != nil {
		if isClosedErr(err) {
			return ErrShellClosed
		}
		return fmt.Errorf("write to shell: %w", err)
	}
	return nil
}

// beginIntegrationWrite holds user input until the internal probe/init write has
// gone out. It takes no lock — see the field comment for why that matters.
func (s *Shell) beginIntegrationWrite() {
	s.integrationWritePending.Store(true)
}

func (s *Shell) finishIntegrationWrite() {
	s.writeMu.Lock()
	s.integrationWritePending.Store(false)
	pending := append([]byte(nil), s.pendingIntegrationInput...)
	s.pendingIntegrationInput = s.pendingIntegrationInput[:0]
	if len(pending) > 0 {
		_ = s.writeDataLocked(pending)
	}
	s.writeMu.Unlock()
}

// Resize tells the remote side the terminal geometry changed.
func (s *Shell) Resize(rows, cols uint32) error {
	if rows == 0 {
		rows = DefaultRows
	}
	if cols == 0 {
		cols = DefaultCols
	}
	if err := s.session.WindowChange(int(rows), int(cols)); err != nil {
		if isClosedErr(err) {
			return ErrShellClosed
		}
		return fmt.Errorf("resize shell: %w", err)
	}
	return nil
}

// Close ends the shell channel. It is idempotent and safe to call concurrently
// with reads and writes.
func (s *Shell) Close() error {
	var err error
	s.closeOnce.Do(func() {
		s.installGate.Disarm()
		s.reinjectGate.Disarm()
		s.shellProbe.Disarm()
		// Closing the session ends the channel, which lands the output readers
		// on EOF and lets the lifecycle goroutine finish normally.
		if closeErr := s.session.Close(); closeErr != nil && !isClosedErr(closeErr) {
			err = fmt.Errorf("close shell: %w", closeErr)
		}
	})
	return err
}

// pump copies one output stream into the ring until it ends.
func (s *Shell) pump(reader io.Reader, stream ringbuf.StreamKind) {
	defer s.readers.Done()

	buf := make([]byte, readBufferBytes)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			// Append copies, so reusing buf across reads is safe.
			chunk := append([]byte(nil), buf[:n]...)
			chunk = s.filterShellIntegrationOutput(chunk)
			if len(chunk) > 0 {
				s.ring.Append(stream, chunk)
			}
		}
		if err != nil {
			return
		}
	}
}

func (s *Shell) filterShellIntegrationOutput(chunk []byte) []byte {
	s.installGate.Observe(chunk)
	s.reinjectGate.Observe(chunk)
	s.shellProbe.Observe(chunk)
	s.integrationMu.Lock()
	if s.shellIntegrationUnsupported && bytes.Contains(chunk, []byte(autocomplete.PromptStartMarker)) {
		s.shellIntegrationUnsupported = false
	}
	s.integrationMu.Unlock()
	return s.handshake.Filter(chunk)
}

// ReinjectShellIntegration waits for the foreground subshell's prompt and then
// installs the shared OSC 7/133 hooks. Empty shellHint uses the safe in-band
// probe; a known direct shell skips that round trip.
func (s *Shell) ReinjectShellIntegration(shellHint string) {
	normalizedHint := shellintegration.NormalizeRemoteShell(shellHint)
	if strings.TrimSpace(shellHint) != "" && normalizedHint == "" {
		return
	}
	s.reinjectGate.ArmWithCommit(s.beginIntegrationWrite, func(tail []byte) {
		if autocomplete.PromptAlreadyIntegrated(tail) {
			s.finishIntegrationWrite()
			return
		}
		if normalizedHint != "" {
			_ = s.injectShellIntegration(normalizedHint, true)
			s.finishIntegrationWrite()
			return
		}
		s.integrationMu.Lock()
		unsupported := s.shellIntegrationUnsupported
		s.integrationMu.Unlock()
		if unsupported {
			s.finishIntegrationWrite()
			return
		}
		_ = s.probeAndInjectShellIntegration(true)
	}, func() {})
}

// probeAndInjectShellIntegration identifies the foreground shell through the
// interactive PTY and installs only that shell's integration command. This is
// also the initial-install fallback: many SSH servers allow a PTY but reject
// the auxiliary exec channel used by DetectRemoteShell, and skipping the PTY
// probe in that case left mobile shell integration permanently disabled.
func (s *Shell) probeAndInjectShellIntegration(reinject bool) error {
	markUnsupported := func() {
		s.integrationResolved.Store(true)
		s.integrationMu.Lock()
		s.shellIntegrationUnsupported = true
		s.integrationMu.Unlock()
		if reinject {
			s.ring.Append(ringbuf.StreamStdout, []byte(autocomplete.CommandFinishedMarker))
		}
	}
	return shellintegration.ProbeShellThenInject(shellintegration.ProbeTarget{
		Probe:        &s.shellProbe,
		Handshake:    &s.handshake,
		ProbeCommand: autocomplete.ShellProbeCommand(),
		Write:        s.sendInternalData,
		BeforeWrite: func() {
			s.ring.Append(ringbuf.StreamStdout, []byte("\r\x1b[2K"))
		},
		Emit: func(data []byte) {
			s.ring.Append(ringbuf.StreamStdout, data)
		},
		OnUnsupported: markUnsupported,
		OnShell: func(shell string) {
			normalized := shellintegration.NormalizeRemoteShell(shell)
			if normalized == "" {
				markUnsupported()
				return
			}
			if s.onIntegrationShellDetected != nil {
				s.onIntegrationShellDetected(normalized)
			}
			s.integrationResolved.Store(true)
			_ = s.injectShellIntegration(normalized, reinject)
		},
		OnFinished: s.finishIntegrationWrite,
		Done:       s.done,
	})
}

func (s *Shell) injectShellIntegration(shell string, reinject bool) error {
	commands := autocomplete.ShellIntegrationInitLines(shellintegration.NormalizeRemoteShell(shell))
	if len(commands) == 0 {
		return nil
	}
	generation := s.handshake.ArmForCommand(false, commands...)
	prefix := "\r\x1b[2K"
	if reinject {
		prefix = autocomplete.CommandFinishedMarker + prefix
	}
	s.ring.Append(ringbuf.StreamStdout, []byte(prefix))
	for _, command := range commands {
		if err := s.sendInternalData([]byte(command)); err != nil {
			if flushed := s.handshake.FlushAttempt(generation); len(flushed) > 0 {
				s.ring.Append(ringbuf.StreamStdout, flushed)
			}
			return err
		}
	}
	go func() {
		timer := time.NewTimer(shellintegration.DefaultHandshakeTimeout)
		defer timer.Stop()
		select {
		case <-s.done:
		case <-timer.C:
			if flushed := s.handshake.FlushAttempt(generation); len(flushed) > 0 {
				s.ring.Append(ringbuf.StreamStdout, flushed)
			}
		}
	}()
	return nil
}

// awaitEnd finishes the shell once its output is fully stored.
//
// The readers are waited on before the ring is closed so that output already in
// flight when the channel ended still reaches the app; closing the ring first
// would discard the tail of the session, which is usually the part explaining
// why it ended.
func (s *Shell) awaitEnd() {
	s.readers.Wait()
	_ = s.session.Wait()
	s.finish()
}

func (s *Shell) finish() {
	s.finishOne.Do(func() {
		s.ring.Close()
		if s.detach != nil {
			s.detach()
		}
		close(s.done)
		if s.onClosed != nil {
			s.onClosed(s.info.ChannelID)
		}
	})
}

// startShell opens a PTY-backed shell on client and begins storing its output.
func startShell(client *ssh.Client, info ShellInfo, opts ShellOptions, detach func()) (*Shell, error) {
	sshSession, err := client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("open shell channel: %w", err)
	}

	rows := opts.Rows
	if rows == 0 {
		rows = DefaultRows
	}
	cols := opts.Cols
	if cols == 0 {
		cols = DefaultCols
	}

	if err := sshSession.RequestPty(opts.Term.SSHName(), int(rows), int(cols), terminalModes(opts.Modes)); err != nil {
		sshSession.Close()
		return nil, fmt.Errorf("request pty: %w", err)
	}

	stdin, err := sshSession.StdinPipe()
	if err != nil {
		sshSession.Close()
		return nil, fmt.Errorf("open shell stdin: %w", err)
	}
	stdout, err := sshSession.StdoutPipe()
	if err != nil {
		sshSession.Close()
		return nil, fmt.Errorf("open shell stdout: %w", err)
	}
	stderr, err := sshSession.StderrPipe()
	if err != nil {
		sshSession.Close()
		return nil, fmt.Errorf("open shell stderr: %w", err)
	}

	shell := &Shell{
		info:                       info,
		ring:                       ringbuf.New(opts.RingCapacityBytes, opts.MaxChunkBytes),
		session:                    sshSession,
		stdin:                      stdin,
		done:                       make(chan struct{}),
		onClosed:                   opts.OnClosed,
		detach:                     detach,
		onIntegrationShellDetected: opts.OnIntegrationShellDetected,
		installGate:                autocomplete.NewPromptSettleGate(150*time.Millisecond, 3*time.Second),
		reinjectGate:               autocomplete.NewPromptSettleGate(0, 0),
	}
	shellName := shellintegration.NormalizeRemoteShell(opts.IntegrationShell)
	// Always arm the first-prompt gate. IntegrationShell comes from a separate
	// non-interactive exec channel and is only an optimization; a PTY-capable
	// server is allowed to reject that channel. In that common failure mode the
	// in-band probe below is the only way to activate mobile integration.
	installOnSettled := func(tail []byte) {
		if autocomplete.PromptAlreadyIntegrated(tail) {
			shell.integrationResolved.Store(true)
			shell.finishIntegrationWrite()
			return
		}
		// DetectRemoteShell returns empty both when exec is rejected and when the
		// remote login shell is not safe to type into. A standard PowerShell
		// prompt is distinguishable here; never send the POSIX probe into it.
		if shellName == "" && autocomplete.LooksLikePowerShellPrompt(string(tail)) {
			shell.integrationResolved.Store(true)
			shell.integrationMu.Lock()
			shell.shellIntegrationUnsupported = true
			shell.integrationMu.Unlock()
			shell.finishIntegrationWrite()
			return
		}
		// cmd.exe (and drive-prompt themes) run no POSIX shell: the probe's printf
		// prints a "not recognized" error into the user's terminal. Treat it like
		// PowerShell — integration off, no typing.
		if shellName == "" && autocomplete.LooksLikeWindowsCommandLinePrompt(string(tail)) {
			shell.integrationResolved.Store(true)
			shell.integrationMu.Lock()
			shell.shellIntegrationUnsupported = true
			shell.integrationMu.Unlock()
			shell.finishIntegrationWrite()
			return
		}
		if shellName != "" {
			shell.integrationResolved.Store(true)
			_ = shell.injectShellIntegration(shellName, false)
			shell.finishIntegrationWrite()
			return
		}
		_ = shell.probeAndInjectShellIntegration(false)
	}
	// Kept as a field so a submitted line can start the watch again after it ran
	// out — see rearmInstallGateOnSubmit.
	shell.armInstallGate = func() {
		shell.installGate.ArmWithCommit(shell.beginIntegrationWrite, installOnSettled, func() {})
	}
	shell.armInstallGate()

	// Start pumping before Shell() so nothing the remote side sends immediately
	// after the request is missed.
	shell.readers.Add(2)
	go shell.pump(stdout, ringbuf.StreamStdout)
	go shell.pump(stderr, ringbuf.StreamStderr)

	if err := sshSession.Shell(); err != nil {
		sshSession.Close()
		shell.readers.Wait()
		shell.ring.Close()
		return nil, fmt.Errorf("start shell: %w", err)
	}

	shell.info.ConnectedAtMs = nowMs()
	go shell.awaitEnd()
	return shell, nil
}

func nowMs() float64 {
	return float64(time.Now().UnixNano()) / float64(time.Millisecond)
}

// isClosedErr reports whether err just means the channel or connection is
// already gone, which callers treat as ErrShellClosed rather than a failure.
//
// x/crypto/ssh exports no sentinel for this, so the string check follows the
// same approach as internal/sftp.
func isClosedErr(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe) || errors.Is(err, net.ErrClosed) {
		return true
	}
	message := err.Error()
	return strings.Contains(message, "use of closed network connection") ||
		strings.Contains(message, "session is closed") ||
		strings.Contains(message, "channel closed")
}
