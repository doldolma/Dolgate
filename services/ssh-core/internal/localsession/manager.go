package localsession

import (
	"fmt"
	"io"
	"sync"

	"dolssh/services/ssh-core/internal/protocol"
)

type EventEmitter func(protocol.Event)
type StreamEmitter func(protocol.StreamFrame, []byte)

type runnerFactory func(protocol.LocalConnectPayload) (sessionRunner, error)

type sessionHandle struct {
	runner              sessionRunner
	streams             sync.WaitGroup
	disconnectRequested bool
	errorNotified       bool
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

	handle := &sessionHandle{runner: runner}
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
			m.emitStream(protocol.StreamFrame{
				Type:      protocol.StreamTypeData,
				SessionID: sessionID,
			}, chunk)
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
