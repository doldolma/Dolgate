package awssession

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
)

type EventEmitter func(protocol.Event)
type StreamEmitter func(protocol.StreamFrame, []byte)

type runnerFactory func(protocol.AWSConnectPayload) (sessionRunner, error)

type sessionHandle struct {
	runner              sessionRunner
	streams             sync.WaitGroup
	disconnectRequested bool
	errorNotified       bool
	done                chan struct{}
	probeMu             sync.Mutex
	probe               *autocompleteProbe
	handshake           autocomplete.Handshake
}

type autocompleteProbe struct {
	nonce    string
	revision int
	buffer   []byte
	result   chan autocompleteProbeResult
}

type autocompleteProbeResult struct {
	result autocomplete.Result
	err    error
}

type Manager struct {
	mu           sync.RWMutex
	sessions     map[string]*sessionHandle
	emit         EventEmitter
	emitStream   StreamEmitter
	createRunner runnerFactory
}

const shutdownDrainTimeout = 2 * time.Second

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

func (m *Manager) Connect(sessionID, requestID string, payload protocol.AWSConnectPayload) error {
	runner, err := m.createRunner(payload)
	if err != nil {
		return err
	}

	handle := &sessionHandle{
		runner: runner,
		done:   make(chan struct{}),
	}
	m.mu.Lock()
	m.sessions[sessionID] = handle
	m.mu.Unlock()

	m.emit(protocol.Event{
		Type:      protocol.EventConnected,
		RequestID: requestID,
		SessionID: sessionID,
		Payload: protocol.StatusPayload{
			Status: "connected",
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
	nonceBytes := make([]byte, 12)
	if _, err := rand.Read(nonceBytes); err != nil {
		return autocomplete.Result{}, err
	}
	probe := &autocompleteProbe{
		nonce:    hex.EncodeToString(nonceBytes),
		revision: revision,
		result:   make(chan autocompleteProbeResult, 1),
	}
	session.probeMu.Lock()
	if session.probe != nil {
		session.probeMu.Unlock()
		return autocomplete.Degraded("", "metadata-unavailable"), nil
	}
	session.probe = probe
	session.probeMu.Unlock()

	if err := session.runner.Write([]byte(autocomplete.InBandProbeCommand(probe.nonce))); err != nil {
		m.clearAutocompleteProbe(session, probe)
		return autocomplete.Result{}, err
	}

	select {
	case response := <-probe.result:
		return response.result, response.err
	case <-time.After(2 * time.Second):
		m.clearAutocompleteProbe(session, probe)
		return autocomplete.Degraded("", "probe-timeout"), nil
	}
}

func (m *Manager) StopAutocomplete(sessionID string) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return
	}
	session.probeMu.Lock()
	session.probe = nil
	session.probeMu.Unlock()
}

// InstallShellIntegration arms the OSC 133 handshake filter and writes the
// integration init command into the SSM PTY. Must run before the snapshot probe
// so the prompt marker arrives ahead of the probe response.
func (m *Manager) InstallShellIntegration(sessionID string) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	session.handshake.Arm()
	return session.runner.Write([]byte(autocomplete.ShellIntegrationInitCommand()))
}

// FlushShellIntegration releases any output held by the handshake filter when
// the prompt marker never arrives within the handshake timeout.
func (m *Manager) FlushShellIntegration(sessionID string) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return
	}
	if flushed := session.handshake.Flush(); len(flushed) > 0 {
		m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
	}
}

func (m *Manager) SendControlSignal(sessionID, signal string) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	return session.runner.SendControlSignal(signal)
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

func (m *Manager) Shutdown() {
	sessions := m.snapshotSessionsForShutdown()
	if len(sessions) == 0 {
		return
	}

	for _, session := range sessions {
		_ = session.runner.Kill()
	}

	deadline := time.NewTimer(shutdownDrainTimeout)
	defer deadline.Stop()

	for _, session := range sessions {
		select {
		case <-session.done:
		case <-deadline.C:
			return
		}
	}
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
			// Suppress the integration command echo until the first prompt
			// marker, then let the 6973 snapshot probe parsing run on what
			// remains (the marker is injected before the probe, so it arrives
			// first and the probe response is never swallowed).
			chunk = handle.handshake.Filter(chunk)
			if len(chunk) > 0 {
				chunk = m.consumeAutocompleteProbe(handle, chunk)
			}
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

func (m *Manager) clearAutocompleteProbe(handle *sessionHandle, expected *autocompleteProbe) {
	handle.probeMu.Lock()
	if handle.probe == expected {
		handle.probe = nil
	}
	handle.probeMu.Unlock()
}

func (m *Manager) consumeAutocompleteProbe(handle *sessionHandle, chunk []byte) []byte {
	handle.probeMu.Lock()
	probe := handle.probe
	if probe == nil {
		handle.probeMu.Unlock()
		return chunk
	}
	probe.buffer = append(probe.buffer, chunk...)
	if len(probe.buffer) > autocomplete.MaxMetadataBytes*2 {
		handle.probe = nil
		handle.probeMu.Unlock()
		select {
		case probe.result <- autocompleteProbeResult{err: fmt.Errorf("autocomplete probe response exceeded limit")}:
		default:
		}
		return nil
	}
	prefix := []byte("\x1b]6973;" + probe.nonce + ";snapshot;")
	start := bytes.Index(probe.buffer, prefix)
	if start < 0 {
		if len(probe.buffer) > autocomplete.MaxMetadataBytes {
			handle.probe = nil
			select {
			case probe.result <- autocompleteProbeResult{err: fmt.Errorf("autocomplete probe response exceeded limit")}:
			default:
			}
		}
		handle.probeMu.Unlock()
		return nil
	}
	endOffset := bytes.IndexByte(probe.buffer[start+len(prefix):], '\a')
	if endOffset < 0 {
		handle.probeMu.Unlock()
		return nil
	}
	end := start + len(prefix) + endOffset
	encoded := append([]byte(nil), probe.buffer[start+len(prefix):end]...)
	remainder := append([]byte(nil), probe.buffer[end+1:]...)
	handle.probe = nil
	handle.probeMu.Unlock()
	result, err := autocomplete.DecodeInBandSnapshot(encoded, probe.revision)
	select {
	case probe.result <- autocompleteProbeResult{result: result, err: err}:
	default:
	}
	return remainder
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
		close(session.done)
	}()
}

func (m *Manager) snapshotSessionsForShutdown() []*sessionHandle {
	m.mu.Lock()
	defer m.mu.Unlock()

	sessions := make([]*sessionHandle, 0, len(m.sessions))
	for _, session := range m.sessions {
		session.disconnectRequested = true
		sessions = append(sessions, session)
	}
	return sessions
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
		return nil, fmt.Errorf("aws session %s not found", sessionID)
	}
	return session, nil
}
