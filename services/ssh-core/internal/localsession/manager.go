package localsession

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
)

// shellIntegrationHandshakeTimeout bounds how long the echo-suppression
// handshake waits for the first OSC 133;A marker after a re-injection before
// releasing buffered output (non-bash/zsh subshell).
const shellIntegrationHandshakeTimeout = 8 * time.Second

type EventEmitter func(protocol.Event)
type StreamEmitter func(protocol.StreamFrame, []byte)

type runnerFactory func(protocol.LocalConnectPayload) (sessionRunner, error)

type sessionHandle struct {
	runner              sessionRunner
	streams             sync.WaitGroup
	disconnectRequested bool
	errorNotified       bool
	handshake           autocomplete.Handshake
	// reinjectGate re-installs OSC 133/7 hooks after the user enters a subshell
	// (sudo su, docker exec, ssh from a local shell). Created in Connect; a no-op
	// until Armed by ReinjectShellIntegration.
	reinjectGate *autocomplete.PromptSettleGate
}

type Manager struct {
	mu           sync.RWMutex
	sessions     map[string]*sessionHandle
	emit         EventEmitter
	emitStream   StreamEmitter
	createRunner runnerFactory
}

func NewManager(emit EventEmitter, stream StreamEmitter) *Manager {
	return NewManagerWithRunnerFactory(emit, stream, defaultRunnerFactory)
}

func NewManagerWithRunnerFactory(emit EventEmitter, stream StreamEmitter, createRunner runnerFactory) *Manager {
	if createRunner == nil {
		createRunner = defaultRunnerFactory
	}

	return &Manager{
		sessions:     make(map[string]*sessionHandle),
		emit:         emit,
		emitStream:   stream,
		createRunner: createRunner,
	}
}

func (m *Manager) Connect(sessionID, requestID string, payload protocol.LocalConnectPayload) error {
	runner, err := m.createRunner(payload)
	if err != nil {
		return err
	}

	handle := &sessionHandle{runner: runner, reinjectGate: autocomplete.NewPromptSettleGate(0, 0)}
	m.mu.Lock()
	m.sessions[sessionID] = handle
	m.mu.Unlock()

	m.emit(protocol.Event{
		Type:      protocol.EventConnected,
		RequestID: requestID,
		SessionID: sessionID,
		Payload: protocol.StatusPayload{
			Status:    "connected",
			ShellKind: runner.ShellKind(),
		},
	})

	for _, reader := range runner.Streams() {
		handle.streams.Add(1)
		go m.stream(sessionID, handle, reader)
	}

	go m.waitForSession(sessionID)
	return nil
}

func (m *Manager) HasSession(sessionID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.sessions[sessionID]
	return ok
}

func (m *Manager) WriteBytes(sessionID string, data []byte) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	return session.runner.Write(data)
}

func (m *Manager) CollectAutocomplete(sessionID string, revision int) (autocomplete.Result, error) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return autocomplete.Result{}, err
	}
	return autocomplete.CollectLocal(session.runner.ShellKind(), revision), nil
}

// RunCompletionCommand runs a short read-only command for dynamic completion in
// a one-off subprocess (separate from the interactive PTY). The renderer
// resolves directories to absolute paths (via OSC 7 cwd), so the subprocess cwd
// is not relied upon. Bounded by CompletionTimeout and CapOutput.
func (m *Manager) RunCompletionCommand(sessionID, command string) (string, bool, error) {
	if _, err := m.getSession(sessionID); err != nil {
		return "", false, err
	}
	// Completion commands are POSIX shell (`ls -1Ap`, `git branch`, …) run via
	// /bin/sh. A local Windows shell isn't POSIX, so dynamic completion isn't
	// supported there — degrade to nothing instead of failing on a missing
	// /bin/sh. (Remote SSH sessions still complete on the remote Unix host.)
	if runtime.GOOS == "windows" {
		return "", false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), autocomplete.CompletionTimeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, "/bin/sh", "-c", command).Output()
	if err != nil && len(output) == 0 {
		return "", false, err
	}
	out, truncated := autocomplete.CapOutput(output)
	return out, truncated, nil
}

// InstallShellIntegration arms the OSC 133 handshake filter and writes the
// integration init command into the interactive shell. The filter hides the
// command's echo until the first prompt marker is seen.
func (m *Manager) InstallShellIntegration(sessionID string) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	command, ok := autocomplete.ShellIntegrationInitCommandForShell(session.runner.ShellKind())
	if !ok {
		return nil
	}
	session.handshake.Arm(false)
	return session.runner.Write([]byte(command))
}

// ReinjectShellIntegration re-installs the OSC 133/7 hooks into the foreground
// shell after the user enters a subshell (sudo su, docker exec, ssh from the
// local shell), where the connect-time hooks are absent. It waits for the
// subshell prompt to settle before writing so it never corrupts input, then
// arms the echo-suppression handshake around the injected command. A non-bash/
// zsh subshell emits no marker and the handshake flush restores its output.
func (m *Manager) ReinjectShellIntegration(sessionID string) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	// The init script is POSIX-shell shaped; a Windows local shell subshell can't
	// use it, so skip there (mirrors RunCompletionCommand's platform guard).
	if runtime.GOOS == "windows" {
		return nil
	}
	session.reinjectGate.Arm(
		func() { m.performShellIntegrationReinject(sessionID, session) },
		func() {},
	)
	return nil
}

func (m *Manager) performShellIntegrationReinject(sessionID string, session *sessionHandle) {
	if !m.HasSession(sessionID) {
		return
	}
	session.handshake.Arm(true)
	if err := session.runner.Write([]byte(autocomplete.ShellIntegrationInitCommand())); err != nil {
		if flushed := session.handshake.Flush(); len(flushed) > 0 {
			m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
		}
		return
	}
	time.AfterFunc(shellIntegrationHandshakeTimeout, func() {
		m.FlushShellIntegration(sessionID)
	})
}

// FlushShellIntegration releases any output the handshake filter is holding,
// used when the prompt marker never arrives within the handshake timeout so the
// user still sees whatever the shell produced.
func (m *Manager) FlushShellIntegration(sessionID string) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return
	}
	if flushed := session.handshake.Flush(); len(flushed) > 0 {
		m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
	}
}

func (m *Manager) Resize(sessionID string, cols, rows int) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}

	cols, rows = normalizedSize(cols, rows)
	return session.runner.Resize(cols, rows)
}

func (m *Manager) Disconnect(sessionID string) error {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return nil
	}
	session.disconnectRequested = true
	m.mu.Unlock()

	return session.runner.Kill()
}

func (m *Manager) waitForSession(sessionID string) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return
	}

	exit, waitErr := session.runner.Wait()
	if !m.HasSession(sessionID) {
		return
	}

	disconnectRequested, _ := m.sessionFlags(sessionID)
	message := describeExit(exit, waitErr)
	if disconnectRequested {
		message = "client requested disconnect"
	}

	if !disconnectRequested && message != "" {
		m.emitSessionError(sessionID, message)
	}

	m.closeSession(sessionID, message)
}

func (m *Manager) stream(sessionID string, handle *sessionHandle, reader io.Reader) {
	defer handle.streams.Done()

	buffer := make([]byte, 4096)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buffer[:n])
			// 서브쉘 재주입 대기 중이면 raw 출력으로 프롬프트 안착을 감지한다(필터 전 관찰).
			handle.reinjectGate.Observe(chunk)
			chunk = handle.handshake.Filter(chunk)
			if len(chunk) > 0 {
				m.emitStream(protocol.StreamFrame{
					Type:      protocol.StreamTypeData,
					SessionID: sessionID,
				}, chunk)
			}
		}

		if err != nil {
			if err != io.EOF && m.HasSession(sessionID) {
				m.emitSessionError(sessionID, err.Error())
			}
			return
		}
	}
}

func (m *Manager) emitSessionError(sessionID, message string) {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if !ok || session.errorNotified {
		m.mu.Unlock()
		return
	}
	session.errorNotified = true
	m.mu.Unlock()

	m.emit(protocol.Event{
		Type:      protocol.EventError,
		SessionID: sessionID,
		Payload: protocol.ErrorPayload{
			Message: message,
		},
	})
}

func (m *Manager) closeSession(sessionID string, message string) {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()

	if !ok {
		return
	}

	m.emit(protocol.Event{
		Type:      protocol.EventClosed,
		SessionID: sessionID,
		Payload: protocol.ClosedPayload{
			Message: message,
		},
	})

	go func() {
		session.streams.Wait()
		_ = session.runner.Close()
	}()
}

func (m *Manager) sessionFlags(sessionID string) (disconnectRequested bool, errorNotified bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	session, ok := m.sessions[sessionID]
	if !ok {
		return false, false
	}
	return session.disconnectRequested, session.errorNotified
}

func (m *Manager) getSession(sessionID string) (*sessionHandle, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	session, ok := m.sessions[sessionID]
	if !ok {
		return nil, fmt.Errorf("local session %s not found", sessionID)
	}
	return session, nil
}
