// Package moshsession runs interactive terminals over mosh (Mobile Shell).
//
// A mosh connection is two stages: (1) a one-shot SSH "bootstrap" that launches
// mosh-server on the remote and reads back its UDP port + session key, then
// (2) a UDP SSP (State Synchronization Protocol) session that survives roaming,
// sleep/wake, and transient network loss. We reuse the existing SSH auth / jump
// / known-host plumbing (sshconn) for the bootstrap, and github.com/unixshells/
// mosh-go for the UDP transport. mosh-go's Recv returns ready-to-render ANSI
// escape sequences (framebuffer diffs), so the renderer / xterm.js path is the
// same as a normal SSH session.
//
// jump host is intentionally NOT supported with mosh: the UDP leg cannot cross a
// bastion. The desktop UI blocks the combination, so Jump is forwarded only
// defensively here.
package moshsession

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	mosh "github.com/unixshells/mosh-go"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshcmd"
	"dolssh/services/ssh-core/internal/sshconn"
)

// EventEmitter는 상태 이벤트를 상위 레이어로 흘려보내는 함수 타입이다.
type EventEmitter func(protocol.Event)

// StreamEmitter는 raw 터미널 바이트를 상위 레이어로 흘려보내는 함수 타입이다.
type StreamEmitter func(protocol.StreamFrame, []byte)

// 종료 사유 — sshsession과 동일한 의미로 ClosedPayload.Reason에 실린다. mosh는 UDP
// 로밍으로 전송 단절에 강인해 보통 client(사용자 종료)만 발생한다.
const (
	closeReasonClient = "client" // 클라이언트 요청 종료 → 재연결하지 않음
)

const (
	// mosh 상태 임계값. LastRecv(마지막 SSP 수신) 경과로 판정한다. mosh는 유휴에도
	// 양방향 heartbeat가 흘러 정상 연결이면 LastRecv가 항상 최근이다.
	moshReconnectingAfter = 4 * time.Second
	moshDisconnectedAfter = 12 * time.Second
	moshMonitorInterval   = 1 * time.Second
	// Recv 폴링 타임아웃. 짧게 잡아 close 신호에 빠르게 반응한다.
	moshRecvTimeout = 200 * time.Millisecond
	// 원격에서 mosh-server new가 MOSH CONNECT를 내놓기까지 허용하는 최대 시간.
	moshServerBootstrapTimeout = 15 * time.Second
)

// MOSH CONNECT <udp-port> <base64-key> 한 줄을 mosh-server new 출력에서 찾는다.
var moshConnectRe = regexp.MustCompile(`MOSH CONNECT (\d+) (\S+)`)

type ManagerConfig struct {
	// TCPDialTimeout은 bootstrap SSH의 초기 TCP 연결에 허용할 최대 시간이다.
	TCPDialTimeout time.Duration
	// TCPKeepAliveInterval은 bootstrap SSH 커널 keepalive probe 간격이다.
	TCPKeepAliveInterval time.Duration
}

var defaultManagerConfig = ManagerConfig{
	TCPDialTimeout:       10 * time.Second,
	TCPKeepAliveInterval: 30 * time.Second,
}

type sessionHandle struct {
	client *mosh.Client
	closed chan struct{}
	closer sync.Once
}

type Manager struct {
	// 여러 mosh 세션을 sessionId 기준으로 관리한다.
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
	return &Manager{
		sessions:          make(map[string]*sessionHandle),
		pendingChallenges: make(map[string]chan []string),
		emit:              emit,
		emitStream:        stream,
		config:            config,
	}
}

func (m *Manager) Connect(sessionID, requestID string, payload protocol.ConnectPayload) error {
	// 1) SSH bootstrap — mosh-server를 원격에서 띄우기 위한 1회성 SSH 연결.
	//    인증/jump/known-host 인프라는 sshsession과 동일하게 sshconn으로 재사용한다.
	attempt := 0
	client, err := sshconn.DialClient(sshconn.Target{
		Host:                  payload.Host,
		Port:                  payload.Port,
		Username:              payload.Username,
		AuthType:              payload.AuthType,
		Password:              payload.Password,
		PrivateKeyPEM:         payload.PrivateKeyPEM,
		CertificateText:       payload.CertificateText,
		Passphrase:            payload.Passphrase,
		TrustedHostKeyBase64:  payload.TrustedHostKeyBase64,
		TrustedHostKeysBase64: payload.TrustedHostKeysBase64,
		Jump:                  sshconn.JumpTargetFromCore(payload.Jump),
	}, sshconn.Config{
		TCPDialTimeout:       m.config.TCPDialTimeout,
		TCPKeepAliveInterval: m.config.TCPKeepAliveInterval,
	}, m.keyboardInteractiveResponder(sessionID, requestID, &attempt))
	if err != nil {
		return err
	}
	// bootstrap SSH는 mosh-server를 daemon으로 띄운 뒤 더 필요 없다. mosh-server는
	// fork+detach되어 SSH가 끊겨도 UDP로 계속 서비스하므로 부트스트랩이 끝나면 닫는다.
	defer client.Close()

	// 2) 원격에서 mosh-server new 실행 → "MOSH CONNECT <port> <key>" 회수.
	stdout, stderr, runErr := sshcmd.RunWithTimeout(
		client,
		moshServerCommand(payload.Env),
		moshServerBootstrapTimeout,
	)
	port, key, parseErr := parseMoshConnect(append(append([]byte{}, stdout...), stderr...))
	if parseErr != nil {
		// 명령 자체 실패(mosh 미설치 등)면 그 stderr를 함께 보고해 원인을 분명히 한다.
		if runErr != nil {
			detail := strings.TrimSpace(string(stderr))
			if detail == "" {
				detail = runErr.Error()
			}
			return fmt.Errorf("mosh-server bootstrap failed (is mosh installed on the host?): %s", detail)
		}
		return fmt.Errorf("mosh-server bootstrap: %w", parseErr)
	}

	// 3) mosh UDP 세션 수립. host는 부트스트랩과 동일(타깃이 UDP를 직접 서비스).
	moshClient, err := mosh.Dial(payload.Host, port, key)
	if err != nil {
		return fmt.Errorf("mosh dial failed: %w", err)
	}

	cols, rows := payload.Cols, payload.Rows
	if cols <= 0 {
		cols = 120
	}
	if rows <= 0 {
		rows = 32
	}
	moshClient.Resize(uint16(cols), uint16(rows))

	handle := &sessionHandle{
		client: moshClient,
		closed: make(chan struct{}),
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
	// 초기 mosh 상태를 즉시 알려 하단 상태바가 connected로 시작하게 한다.
	m.emit(protocol.Event{
		Type:      protocol.EventMoshState,
		SessionID: sessionID,
		Payload: protocol.MoshStatePayload{
			State: "connected",
		},
	})

	go m.stream(sessionID, handle)
	go m.monitor(sessionID, handle)
	return nil
}

// keyboardInteractiveResponder는 bootstrap SSH의 keyboard-interactive 챌린지를
// 상위로 emit하고 응답을 기다린다(sshsession과 동일한 메커니즘). 응답은
// RespondKeyboardInteractive로 들어온다.
func (m *Manager) keyboardInteractiveResponder(sessionID, requestID string, attempt *int) sshconn.InteractiveResponder {
	return func(challenge sshconn.InteractiveChallenge) ([]string, error) {
		*attempt += 1
		challengeID := fmt.Sprintf("%s-%d", sessionID, *attempt)
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
				Attempt:     *attempt,
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
	}
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

func (m *Manager) HasSession(sessionID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.sessions[sessionID]
	return ok
}

func (m *Manager) WriteBytes(sessionID string, data []byte) error {
	handle, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	handle.client.Send(data)
	return nil
}

func (m *Manager) Resize(sessionID string, cols, rows int) error {
	// 음수/0 크기는 UI 초기화 타이밍에 잠깐 들어올 수 있어 안전한 기본값으로 보정한다.
	handle, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	if cols <= 0 {
		cols = 120
	}
	if rows <= 0 {
		rows = 32
	}
	handle.client.Resize(uint16(cols), uint16(rows))
	return nil
}

func (m *Manager) Disconnect(sessionID string) error {
	m.closeSession(sessionID, "", closeReasonClient)
	return nil
}

// stream은 mosh-go의 Recv가 돌려주는 ANSI escape sequence(framebuffer diff)를 그대로
// StreamFrame으로 흘린다 → renderer/xterm.js가 SSH 세션과 동일하게 소비한다.
func (m *Manager) stream(sessionID string, handle *sessionHandle) {
	for {
		select {
		case <-handle.closed:
			return
		default:
		}
		data := handle.client.Recv(moshRecvTimeout)
		if len(data) == 0 {
			continue // timeout(유휴) — close 신호를 다시 확인하러 루프.
		}
		chunk := make([]byte, len(data))
		copy(chunk, data)
		m.emitStream(protocol.StreamFrame{
			Type:      protocol.StreamTypeData,
			SessionID: sessionID,
		}, chunk)
	}
}

// monitor는 Transport().LastRecv() 경과로 연결 상태를 판정해 변화가 있을 때만
// moshState 이벤트를 emit한다.
func (m *Manager) monitor(sessionID string, handle *sessionHandle) {
	ticker := time.NewTicker(moshMonitorInterval)
	defer ticker.Stop()

	lastState := "connected" // Connect에서 이미 connected를 한 번 emit했다.
	for {
		select {
		case <-handle.closed:
			return
		case <-ticker.C:
			transport := handle.client.Transport()
			lastRecv := transport.LastRecv()
			if lastRecv.IsZero() {
				continue // 아직 첫 SSP 수신 전 — 상태 판정 보류(연결 직후).
			}
			state := moshStateFor(time.Since(lastRecv))
			if state == lastState {
				continue
			}
			lastState = state
			m.emit(protocol.Event{
				Type:      protocol.EventMoshState,
				SessionID: sessionID,
				Payload: protocol.MoshStatePayload{
					State:          state,
					LastResponseAt: lastRecv.UTC().Format(time.RFC3339),
				},
			})
		}
	}
}

func (m *Manager) closeSession(sessionID, message, reason string) {
	// 맵에서 먼저 제거해 중복 종료 요청이 다시 같은 세션을 건드리지 않게 한다.
	m.mu.Lock()
	handle, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	challengeIDs := make([]string, 0)
	for challengeID := range m.pendingChallenges {
		if strings.HasPrefix(challengeID, sessionID+"-") {
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

	handle.closer.Do(func() {
		close(handle.closed)
		handle.client.Close()
	})

	m.emit(protocol.Event{
		Type:      protocol.EventClosed,
		SessionID: sessionID,
		Payload: protocol.ClosedPayload{
			Message: message,
			Reason:  reason,
		},
	})
}

func (m *Manager) getSession(sessionID string) (*sessionHandle, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	handle, ok := m.sessions[sessionID]
	if !ok {
		return nil, fmt.Errorf("session %s not found", sessionID)
	}
	return handle, nil
}

// moshServerCommand는 원격에서 실행할 mosh-server new 명령을 만든다. -l로 UTF-8 로케일을
// 전달한다(mosh는 UTF-8 로케일을 요구한다).
//
// -s(SSH 연결이 들어온 IP에만 bind)는 일부러 쓰지 않는다: Synology NAS처럼 멀티홈
// (eth0/docker0/가상 인터페이스) 환경에서는 SSH_CONNECTION의 IP가 클라이언트가 실제로
// UDP를 보내는 IP와 어긋나 패킷이 안 닿는 일이 있다. -s를 빼면 모든 인터페이스(0.0.0.0)에
// bind해 도달성이 높아진다(mosh는 1회용 키 인증이라 보안상 안전).
func moshServerCommand(env []protocol.EnvVar) string {
	locale := localeFromEnv(env)
	inner := "mosh-server new -c 8 -l " + sshcmd.QuotePosix("LANG="+locale)
	// 비대화형 SSH exec는 로그인 셸의 PATH 설정(/etc/profile, ~/.bash_profile 등)을 읽지
	// 않아, mosh-server가 /usr/local/bin·~/bin 등 비표준 경로에 있으면 "command not found"가
	// 난다(대화형 로그인에선 멀쩡히 찾는데도). 사용자 로그인 셸(-l)로 감싸 대화형 SSH와
	// 동일한 PATH에서 mosh-server를 찾게 한다.
	return "${SHELL:-/bin/sh} -l -c " + sshcmd.QuotePosix(inner)
}

// localeFromEnv는 호스트 환경변수에서 UTF-8 로케일을 고른다. 없으면 가장 흔한
// en_US.UTF-8로 폴백한다.
func localeFromEnv(env []protocol.EnvVar) string {
	for _, candidate := range []string{"LC_ALL", "LANG"} {
		for _, envVar := range env {
			if envVar.Key == candidate && strings.Contains(strings.ToUpper(envVar.Value), "UTF-8") {
				return envVar.Value
			}
		}
	}
	return "en_US.UTF-8"
}

func parseMoshConnect(output []byte) (int, string, error) {
	match := moshConnectRe.FindSubmatch(output)
	if match == nil {
		return 0, "", fmt.Errorf("MOSH CONNECT line not found in mosh-server output")
	}
	port, err := strconv.Atoi(string(match[1]))
	if err != nil || port <= 0 {
		return 0, "", fmt.Errorf("invalid mosh port %q", match[1])
	}
	return port, string(match[2]), nil
}

func moshStateFor(age time.Duration) string {
	switch {
	case age >= moshDisconnectedAfter:
		return "disconnected"
	case age >= moshReconnectingAfter:
		return "reconnecting"
	default:
		return "connected"
	}
}
