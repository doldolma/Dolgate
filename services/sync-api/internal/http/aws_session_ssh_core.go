package http

import (
	"fmt"
	"sync"

	"github.com/google/uuid"

	"dolssh/services/ssh-core/pkg/coretypes"
	coreruntime "dolssh/services/ssh-core/pkg/runtime"
)

const (
	sshCoreDefaultCols = 120
	sshCoreDefaultRows = 32
)

type AwsSessionBridge struct {
	core *coreruntime.Runtime

	mu       sync.RWMutex
	sessions map[string]*directAwsSession
}

type directAwsSession struct {
	bridge          *AwsSessionBridge
	sessionID       string
	events          chan awsSessionRuntimeEvent
	eventsCloseOnce sync.Once
	shutdownOnce    sync.Once
}

func NewAwsSessionBridge() *AwsSessionBridge {
	bridge := &AwsSessionBridge{
		sessions: make(map[string]*directAwsSession),
	}
	bridge.core = coreruntime.New(coreruntime.Options{
		EmitEvent:  bridge.handleEvent,
		EmitStream: bridge.handleStream,
	})
	return bridge
}

func (bridge *AwsSessionBridge) Close() {
	bridge.mu.Lock()
	sessions := make([]*directAwsSession, 0, len(bridge.sessions))
	for _, session := range bridge.sessions {
		sessions = append(sessions, session)
	}
	bridge.sessions = make(map[string]*directAwsSession)
	bridge.mu.Unlock()

	for _, session := range sessions {
		_ = session.Close()
	}
	bridge.core.Shutdown()
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
		events:    make(chan awsSessionRuntimeEvent, 64),
	}

	bridge.mu.Lock()
	bridge.sessions[session.sessionID] = session
	bridge.mu.Unlock()

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
		bridge.unregister(session.sessionID)
		session.closeEvents()
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
		session.emit(awsSessionRuntimeEvent{
			Type:    "exit",
			Message: extractRuntimeMessage(event.Payload),
		})
		bridge.unregister(event.SessionID)
		session.closeEvents()
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
	session.shutdownOnce.Do(func() {
		session.bridge.unregister(session.sessionID)
		_ = session.bridge.core.DisconnectSession(session.sessionID)
		session.closeEvents()
	})
	return nil
}

func (session *directAwsSession) emit(event awsSessionRuntimeEvent) {
	session.events <- event
}

func (session *directAwsSession) closeEvents() {
	session.eventsCloseOnce.Do(func() {
		close(session.events)
	})
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
