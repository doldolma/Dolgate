package session

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
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
	// IntegrationShell is detected by Conn before this PTY channel opens. It is
	// internal engine state, not part of the gomobile options JSON.
	IntegrationShell string
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

	readers   sync.WaitGroup
	closeOnce sync.Once
	finishOne sync.Once
	done      chan struct{}
	onClosed  func(channelID uint32)

	detach func()

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

// SendData writes bytes to the shell's stdin.
func (s *Shell) SendData(data []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	if _, err := s.stdin.Write(data); err != nil {
		if isClosedErr(err) {
			return ErrShellClosed
		}
		return fmt.Errorf("write to shell: %w", err)
	}
	return nil
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
	s.reinjectGate.Arm(func(tail []byte) {
		if autocomplete.PromptAlreadyIntegrated(tail) {
			return
		}
		shell := autocomplete.NormalizeShellIntegrationShell(shellHint)
		if shell != "" {
			_ = s.injectShellIntegration(shell, true)
			return
		}
		s.integrationMu.Lock()
		unsupported := s.shellIntegrationUnsupported
		s.integrationMu.Unlock()
		if unsupported {
			return
		}
		command := autocomplete.ShellProbeCommand()
		_ = shellintegration.ProbeShellThenInject(shellintegration.ProbeTarget{
			Probe:        &s.shellProbe,
			Handshake:    &s.handshake,
			ProbeCommand: command,
			Write:        s.SendData,
			BeforeWrite: func() {
				s.ring.Append(ringbuf.StreamStdout, []byte("\r\x1b[2K"))
			},
			Emit: func(data []byte) {
				s.ring.Append(ringbuf.StreamStdout, data)
			},
			OnUnsupported: func() {
				s.integrationMu.Lock()
				s.shellIntegrationUnsupported = true
				s.integrationMu.Unlock()
				s.ring.Append(ringbuf.StreamStdout, []byte(autocomplete.CommandFinishedMarker))
			},
			OnShell: func(shell string) {
				_ = s.injectShellIntegration(shell, true)
			},
			Done: s.done,
		})
	}, func() {})
}

func (s *Shell) injectShellIntegration(shell string, reinject bool) error {
	commands := autocomplete.ShellIntegrationInitLines(shell)
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
		if err := s.SendData([]byte(command)); err != nil {
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
		info:         info,
		ring:         ringbuf.New(opts.RingCapacityBytes, opts.MaxChunkBytes),
		session:      sshSession,
		stdin:        stdin,
		done:         make(chan struct{}),
		onClosed:     opts.OnClosed,
		detach:       detach,
		installGate:  autocomplete.NewPromptSettleGate(150*time.Millisecond, 3*time.Second),
		reinjectGate: autocomplete.NewPromptSettleGate(0, 0),
	}
	if shellName := autocomplete.NormalizeShellIntegrationShell(opts.IntegrationShell); shellName != "" {
		shell.installGate.Arm(func(tail []byte) {
			if !autocomplete.PromptAlreadyIntegrated(tail) {
				_ = shell.injectShellIntegration(shellName, false)
			}
		}, func() {})
	}

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
