package http

import (
	"errors"
	"fmt"
	"log"
	"sync"

	"github.com/google/uuid"

	"dolssh/services/ssh-core/pkg/coretypes"
	coreruntime "dolssh/services/ssh-core/pkg/runtime"
)

const (
	sshCoreDefaultCols         = 120
	sshCoreDefaultRows         = 32
	awsSessionEventsBufferSize = 64
)

type awsSessionCoreRuntime interface {
	ConnectAWS(sessionID, requestID string, payload coretypes.AWSConnectPayload) error
	SendSessionInput(sessionID string, data []byte) error
	ResizeSession(sessionID string, payload coretypes.ResizePayload) error
	DisconnectSession(sessionID string) error
	Shutdown()
}

type AwsSessionBridge struct {
	core awsSessionCoreRuntime

	mu        sync.RWMutex
	sessions  map[string]*directAwsSession
	closing   bool
	closeOnce sync.Once
}

type directAwsSession struct {
	bridge       *AwsSessionBridge
	sessionID    string
	events       chan awsSessionRuntimeEvent
	shutdownOnce sync.Once
	finalizeOnce sync.Once
	done         chan struct{}

	mu             sync.Mutex
	finalized      bool
	shutdownReason string
}

func NewAwsSessionBridge() *AwsSessionBridge {
	return newAwsSessionBridgeWithCore(nil)
}

func newAwsSessionBridgeWithCore(core awsSessionCoreRuntime) *AwsSessionBridge {
	bridge := &AwsSessionBridge{
		sessions: make(map[string]*directAwsSession),
	}
	if core == nil {
		core = coreruntime.New(coreruntime.Options{
			EmitEvent:  bridge.handleEvent,
			EmitStream: bridge.handleStream,
		})
	}
	bridge.core = core
	return bridge
}

func (bridge *AwsSessionBridge) Close() {
	bridge.closeOnce.Do(func() {
		sessions := bridge.markClosing()
		for _, session := range sessions {
			_ = session.CloseWithReason("server_shutdown")
		}
		bridge.core.Shutdown()
		for _, session := range bridge.snapshotSessions() {
			session.finalize(nil)
		}
	})
}

func (bridge *AwsSessionBridge) RunnerFactory() awsSessionRunnerFactory {
	return func(_ AwsSsmRuntime, request awsSessionStartRequest) (awsSessionRunner, error) {
		return bridge.NewRunner(request)
	}
}

func (bridge *AwsSessionBridge) NewRunner(request awsSessionStartRequest) (awsSessionRunner, error) {
	session := &directAwsSession{
		bridge:    bridge,
		sessionID: uuid.NewString(),
		events:    make(chan awsSessionRuntimeEvent, awsSessionEventsBufferSize),
		done:      make(chan struct{}),
	}

	if !bridge.register(session) {
		session.finalize(nil)
		return nil, errors.New("AWS session runtime bridge is shutting down")
	}

	cols, rows := normalizeSshCoreSize(request.Cols, request.Rows)
	if err := bridge.core.ConnectAWS(session.sessionID, uuid.NewString(), coretypes.AWSConnectPayload{
		ProfileName: request.ProfileName,
		Region:      request.Region,
		InstanceID:  request.InstanceID,
		Cols:        cols,
		Rows:        rows,
		Env:         request.Env,
		UnsetEnv:    request.UnsetEnv,
	}); err != nil {
		session.finalize(nil)
		return nil, fmt.Errorf("start AWS session: %w", err)
	}

	return session, nil
}

func (bridge *AwsSessionBridge) handleEvent(event coretypes.Event) {
	if event.SessionID == "" {
		return
	}

	session := bridge.lookup(event.SessionID)
	if session == nil {
		return
	}

	switch event.Type {
	case coretypes.EventConnected:
		session.emit(awsSessionRuntimeEvent{Type: "ready"})
	case coretypes.EventError:
		session.emit(awsSessionRuntimeEvent{
			Type:    "error",
			Message: extractRuntimeMessage(event.Payload),
		})
	case coretypes.EventClosed:
		session.finalize(&awsSessionRuntimeEvent{
			Type:    "exit",
			Message: extractRuntimeMessage(event.Payload),
		})
	}
}

func (bridge *AwsSessionBridge) handleStream(metadata coretypes.StreamFrame, payload []byte) {
	if metadata.SessionID == "" || metadata.Type != coretypes.StreamTypeData {
		return
	}
	session := bridge.lookup(metadata.SessionID)
	if session == nil {
		return
	}
	session.emit(awsSessionRuntimeEvent{
		Type: "output",
		Data: append([]byte(nil), payload...),
	})
}

func (bridge *AwsSessionBridge) register(session *directAwsSession) bool {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()

	if bridge.closing {
		return false
	}
	bridge.sessions[session.sessionID] = session
	return true
}

func (bridge *AwsSessionBridge) lookup(sessionID string) *directAwsSession {
	bridge.mu.RLock()
	defer bridge.mu.RUnlock()
	return bridge.sessions[sessionID]
}

func (bridge *AwsSessionBridge) unregister(sessionID string) {
	bridge.mu.Lock()
	delete(bridge.sessions, sessionID)
	bridge.mu.Unlock()
}

func (bridge *AwsSessionBridge) markClosing() []*directAwsSession {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()

	bridge.closing = true
	sessions := make([]*directAwsSession, 0, len(bridge.sessions))
	for _, session := range bridge.sessions {
		sessions = append(sessions, session)
	}
	return sessions
}

func (bridge *AwsSessionBridge) snapshotSessions() []*directAwsSession {
	bridge.mu.RLock()
	defer bridge.mu.RUnlock()

	sessions := make([]*directAwsSession, 0, len(bridge.sessions))
	for _, session := range bridge.sessions {
		sessions = append(sessions, session)
	}
	return sessions
}

func (session *directAwsSession) Events() <-chan awsSessionRuntimeEvent {
	return session.events
}

func (session *directAwsSession) Write(data []byte) error {
	return session.bridge.core.SendSessionInput(session.sessionID, data)
}

func (session *directAwsSession) Resize(cols, rows int) error {
	cols, rows = normalizeSshCoreSize(cols, rows)
	return session.bridge.core.ResizeSession(session.sessionID, coretypes.ResizePayload{
		Cols: cols,
		Rows: rows,
	})
}

func (session *directAwsSession) Close() error {
	return session.CloseWithReason("client_close")
}

func (session *directAwsSession) CloseWithReason(reason string) error {
	session.requestShutdown(reason)
	return nil
}

func (session *directAwsSession) requestShutdown(reason string) {
	session.shutdownOnce.Do(func() {
		session.storeShutdownReason(reason)
		if reason != "" {
			log.Printf("aws session %s shutdown requested: reason=%s", session.sessionID, reason)
		}
		if err := session.bridge.core.DisconnectSession(session.sessionID); err != nil {
			log.Printf("aws session %s disconnect failed: %v", session.sessionID, err)
			session.finalize(nil)
		}
	})
}

func (session *directAwsSession) emit(event awsSessionRuntimeEvent) bool {
	session.mu.Lock()
	if session.finalized {
		session.mu.Unlock()
		return false
	}
	select {
	case session.events <- event:
		session.mu.Unlock()
		return true
	default:
		session.mu.Unlock()
		session.requestShutdown("backpressure")
		return false
	}
}

func (session *directAwsSession) finalize(exitEvent *awsSessionRuntimeEvent) {
	session.finalizeOnce.Do(func() {
		session.bridge.unregister(session.sessionID)
		session.mu.Lock()
		if exitEvent != nil {
			select {
			case session.events <- *exitEvent:
			default:
			}
		}
		session.finalized = true
		close(session.events)
		session.mu.Unlock()
		close(session.done)
	})
}

func (session *directAwsSession) storeShutdownReason(reason string) {
	if reason == "" {
		return
	}

	session.mu.Lock()
	defer session.mu.Unlock()
	if session.shutdownReason == "" {
		session.shutdownReason = reason
	}
}

func normalizeSshCoreSize(cols, rows int) (int, int) {
	if cols <= 0 {
		cols = sshCoreDefaultCols
	}
	if rows <= 0 {
		rows = sshCoreDefaultRows
	}
	return cols, rows
}

func extractRuntimeMessage(payload any) string {
	switch value := payload.(type) {
	case coretypes.ErrorPayload:
		return value.Message
	case *coretypes.ErrorPayload:
		if value != nil {
			return value.Message
		}
	case coretypes.ClosedPayload:
		return value.Message
	case *coretypes.ClosedPayload:
		if value != nil {
			return value.Message
		}
	case coretypes.StatusPayload:
		return value.Message
	case *coretypes.StatusPayload:
		if value != nil {
			return value.Message
		}
	case map[string]any:
		if message, ok := value["message"].(string); ok {
			return message
		}
	}
	return ""
}
