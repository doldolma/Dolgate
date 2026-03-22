package sshsession

import (
	"fmt"
	"io"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshconn"
)

// EventEmitter는 상태 이벤트를 상위 레이어로 흘려보내는 함수 타입이다.
type EventEmitter func(protocol.Event)

// StreamEmitter는 raw 터미널 바이트를 상위 레이어로 흘려보내는 함수 타입이다.
type StreamEmitter func(protocol.StreamFrame, []byte)

type sessionHandle struct {
	client  *ssh.Client
	session *ssh.Session
	stdin   io.WriteCloser
	closed  chan struct{}
	closer  sync.Once
}

type ManagerConfig struct {
	// TCPDialTimeout은 초기 TCP 연결 수립에 허용할 최대 시간이다.
	TCPDialTimeout time.Duration
	// TCPKeepAliveInterval은 커널 수준 TCP keepalive probe 간격이다. 음수면 비활성화한다.
	TCPKeepAliveInterval time.Duration
	// SSHKeepAliveInterval은 애플리케이션 레벨 keepalive 전송 간격이다. 음수면 비활성화한다.
	SSHKeepAliveInterval time.Duration
}

var defaultManagerConfig = ManagerConfig{
	TCPDialTimeout:       10 * time.Second,
	TCPKeepAliveInterval: 30 * time.Second,
	SSHKeepAliveInterval: 30 * time.Second,
}

type Manager struct {
	// 여러 SSH 세션을 sessionId 기준으로 관리한다.
	mu                sync.RWMutex
	sessions          map[string]*sessionHandle
	pendingChallenges map[string]chan []string
	emit              EventEmitter
	emitStream        StreamEmitter
	config            ManagerConfig
}

func NewManager(emit EventEmitter, stream StreamEmitter) *Manager {
	return NewManagerWithConfig(emit, stream, ManagerConfig{})
}

func NewManagerWithConfig(emit EventEmitter, stream StreamEmitter, config ManagerConfig) *Manager {
	if config.TCPDialTimeout == 0 {
		config.TCPDialTimeout = defaultManagerConfig.TCPDialTimeout
	}
	if config.TCPKeepAliveInterval == 0 {
		config.TCPKeepAliveInterval = defaultManagerConfig.TCPKeepAliveInterval
	}
	if config.SSHKeepAliveInterval == 0 {
		config.SSHKeepAliveInterval = defaultManagerConfig.SSHKeepAliveInterval
	}

	return &Manager{
		sessions:          make(map[string]*sessionHandle),
		pendingChallenges: make(map[string]chan []string),
		emit:              emit,
		emitStream:        stream,
		config:            config,
	}
}

func (m *Manager) Connect(sessionID, requestID string, payload protocol.ConnectPayload) error {
	attempt := 0
	client, err := sshconn.DialClient(sshconn.Target{
		Host:                 payload.Host,
		Port:                 payload.Port,
		Username:             payload.Username,
		AuthType:             payload.AuthType,
		Password:             payload.Password,
		PrivateKeyPEM:        payload.PrivateKeyPEM,
		PrivateKeyPath:       payload.PrivateKeyPath,
		Passphrase:           payload.Passphrase,
		TrustedHostKeyBase64: payload.TrustedHostKeyBase64,
	}, sshconn.Config{
		TCPDialTimeout:       m.config.TCPDialTimeout,
		TCPKeepAliveInterval: m.config.TCPKeepAliveInterval,
	}, func(challenge sshconn.InteractiveChallenge) ([]string, error) {
		attempt += 1
		challengeID := fmt.Sprintf("%s-%d", sessionID, attempt)
		responseCh := make(chan []string, 1)
		m.mu.Lock()
		m.pendingChallenges[challengeID] = responseCh
		m.mu.Unlock()
		defer func() {
			m.mu.Lock()
			delete(m.pendingChallenges, challengeID)
			m.mu.Unlock()
		}()

		prompts := make([]protocol.KeyboardInteractivePrompt, 0, len(challenge.Prompts))
		for _, prompt := range challenge.Prompts {
			prompts = append(prompts, protocol.KeyboardInteractivePrompt{
				Label: prompt.Label,
				Echo:  prompt.Echo,
			})
		}

		m.emit(protocol.Event{
			Type:      protocol.EventKeyboardInteractiveChallenge,
			RequestID: requestID,
			SessionID: sessionID,
			Payload: protocol.KeyboardInteractiveChallengePayload{
				ChallengeID: challengeID,
				Attempt:     attempt,
				Name:        challenge.Name,
				Instruction: challenge.Instruction,
				Prompts:     prompts,
			},
		})

		responses, ok := <-responseCh
		if !ok {
			return nil, fmt.Errorf("keyboard-interactive challenge was cancelled")
		}
		m.emit(protocol.Event{
			Type:      protocol.EventKeyboardInteractiveResolved,
			RequestID: requestID,
			SessionID: sessionID,
			Payload: map[string]any{
				"challengeId": challengeID,
			},
		})
		return responses, nil
	})
	if err != nil {
		return err
	}

	session, err := client.NewSession()
	if err != nil {
		client.Close()
		return fmt.Errorf("session creation failed: %w", err)
	}

	stdin, err := session.StdinPipe()
	if err != nil {
		session.Close()
		client.Close()
		return fmt.Errorf("stdin pipe failed: %w", err)
	}

	stdout, err := session.StdoutPipe()
	if err != nil {
		session.Close()
		client.Close()
		return fmt.Errorf("stdout pipe failed: %w", err)
	}

	stderr, err := session.StderrPipe()
	if err != nil {
		session.Close()
		client.Close()
		return fmt.Errorf("stderr pipe failed: %w", err)
	}

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}

	rows := payload.Rows
	if rows <= 0 {
		rows = 32
	}
	cols := payload.Cols
	if cols <= 0 {
		cols = 120
	}

	if err := session.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		session.Close()
		client.Close()
		return fmt.Errorf("pty request failed: %w", err)
	}

	if err := session.Shell(); err != nil {
		session.Close()
		client.Close()
		return fmt.Errorf("shell start failed: %w", err)
	}

	handle := &sessionHandle{
		client:  client,
		session: session,
		stdin:   stdin,
		closed:  make(chan struct{}),
	}

	// 세션 등록 이후에야 write/resize가 정상적으로 동작할 수 있다.
	m.mu.Lock()
	m.sessions[sessionID] = handle
	m.mu.Unlock()

	// connected 이벤트는 renderer가 탭 상태를 연결 완료로 바꾸는 기준점이다.
	m.emit(protocol.Event{
		Type:      protocol.EventConnected,
		RequestID: requestID,
		SessionID: sessionID,
		Payload: protocol.StatusPayload{
			Status: "connected",
		},
	})

	go m.stream(sessionID, stdout)
	go m.stream(sessionID, stderr)
	// Wait는 별도 goroutine에서 감시해 원격 종료를 이벤트로 전파한다.
	go m.waitForSession(sessionID)
	if m.config.SSHKeepAliveInterval > 0 {
		// SSH keepalive는 유휴 구간에도 애플리케이션 레벨 왕복을 만들어 중간 장비 timeout을 더 빨리 감지한다.
		go m.keepAlive(sessionID, handle)
	}

	return nil
}

func (m *Manager) RespondKeyboardInteractive(sessionID, challengeID string, responses []string) error {
	m.mu.Lock()
	responseCh, ok := m.pendingChallenges[challengeID]
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("keyboard-interactive challenge %s not found for session %s", challengeID, sessionID)
	}

	select {
	case responseCh <- responses:
		return nil
	default:
		return fmt.Errorf("keyboard-interactive challenge %s already has a pending response", challengeID)
	}
}

func (m *Manager) WriteBytes(sessionID string, data []byte) error {
	// stdin pipe는 사실상 사용자의 키 입력 스트림이다.
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	_, err = session.stdin.Write(data)
	return err
}

func (m *Manager) Resize(sessionID string, cols, rows int) error {
	// 음수/0 크기는 UI 초기화 타이밍에 잠깐 들어올 수 있어 안전한 기본값으로 보정한다.
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	if cols <= 0 {
		cols = 120
	}
	if rows <= 0 {
		rows = 32
	}
	return session.session.WindowChange(rows, cols)
}

func (m *Manager) Disconnect(sessionID string) error {
	// 명시적 종료와 원격 종료를 동일한 close 경로로 모아 정리 로직을 일원화한다.
	m.closeSession(sessionID, "client requested disconnect")
	return nil
}

func (m *Manager) waitForSession(sessionID string) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return
	}
	waitErr := session.session.Wait()
	if waitErr != nil && waitErr != io.EOF {
		// 원격 셸이 비정상 종료되면 그 이유를 renderer까지 전달한다.
		m.closeSession(sessionID, waitErr.Error())
		return
	}
	m.closeSession(sessionID, "")
}

func (m *Manager) stream(sessionID string, reader io.Reader) {
	// stdout/stderr 모두 동일한 raw stream frame으로 흘려 상위 레이어가 그대로 전달할 수 있게 한다.
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
			if err != io.EOF {
				// 스트림 수준 오류는 세션 전체 오류로 볼 수 있으므로 별도 error 이벤트를 남긴다.
				m.emit(protocol.Event{
					Type:      protocol.EventError,
					SessionID: sessionID,
					Payload: protocol.ErrorPayload{
						Message: err.Error(),
					},
				})
			}
			return
		}
	}
}

func (m *Manager) keepAlive(sessionID string, session *sessionHandle) {
	ticker := time.NewTicker(m.config.SSHKeepAliveInterval)
	defer ticker.Stop()

	for {
		select {
		case <-session.closed:
			return
		case <-ticker.C:
			// wantReply=true로 보내야 연결이 실제로 살아 있는지 round-trip 기준으로 확인할 수 있다.
			_, _, err := session.client.SendRequest("keepalive@openssh.com", true, nil)
			if err != nil {
				m.closeSession(sessionID, fmt.Sprintf("ssh keepalive failed: %v", err))
				return
			}
		}
	}
}

func (m *Manager) closeSession(sessionID string, message string) {
	// 맵에서 먼저 제거해 중복 종료 요청이 다시 같은 세션을 건드리지 않게 한다.
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	challengeIDs := make([]string, 0)
	for challengeID := range m.pendingChallenges {
		if len(challengeID) >= len(sessionID)+1 && challengeID[:len(sessionID)] == sessionID && challengeID[len(sessionID)] == '-' {
			challengeIDs = append(challengeIDs, challengeID)
		}
	}
	challenges := make([]chan []string, 0, len(challengeIDs))
	for _, challengeID := range challengeIDs {
		challenges = append(challenges, m.pendingChallenges[challengeID])
		delete(m.pendingChallenges, challengeID)
	}
	m.mu.Unlock()

	for _, challenge := range challenges {
		close(challenge)
	}

	if !ok {
		return
	}

	session.closer.Do(func() {
		close(session.closed)
		// stdin, session, client를 같은 순서로 정리해 하위 리소스를 남기지 않는다.
		_ = session.stdin.Close()
		_ = session.session.Close()
		_ = session.client.Close()
	})

	// closed 이벤트는 UI 탭 상태와 버퍼 정리를 유도하는 최종 신호다.
	m.emit(protocol.Event{
		Type:      protocol.EventClosed,
		SessionID: sessionID,
		Payload: protocol.ClosedPayload{
			Message: message,
		},
	})
}

func (m *Manager) getSession(sessionID string) (*sessionHandle, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	session, ok := m.sessions[sessionID]
	if !ok {
		return nil, fmt.Errorf("session %s not found", sessionID)
	}
	return session, nil
}
