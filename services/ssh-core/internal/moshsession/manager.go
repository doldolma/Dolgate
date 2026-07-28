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
//
// tailnet 은 두 단계 모두 경유한다. bootstrap 만 태우면 UDP 가 일반 네트워크로 나가는데,
// tailnet 안에만 있는 호스트에는 닿지 않고 조용히 실패한다 — 호스트에 tailnet 을 지정한
// 사용자는 mosh 도 당연히 그 안으로 간다고 본다. UDP 도 같은 노드로 보낸다.
package moshsession

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
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

// moshNoUDPResponseMessage 는 부트스트랩은 됐는데 UDP 가 한 번도 오지 않았을 때의 안내다.
//
// 원인을 거의 항상 하나로 특정할 수 있어서 추측을 그대로 적는다 — mosh 의 UDP 포트는 SSH 와
// 다른 포트여서, SSH 만 열어 둔 서버에서는 반드시 이 증상이 난다. 실제로 이걸 찾는 데 한참
// 걸렸다.
const moshNoUDPResponseMessage = "mosh 서버가 UDP 로 응답하지 않습니다. " +
	"mosh 는 SSH 포트와 별개로 UDP 60000-61000 이 열려 있어야 합니다 — " +
	"서버 방화벽(ufw 등)과 클라우드 보안 그룹 양쪽을 확인하세요."

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
	// moshHandshakePollInterval 은 첫 응답을 기다리는 동안의 확인 간격이다. 한 왕복이면 오므로
	// 촘촘히 본다 — 정상 연결에서 이 간격이 곧 추가 지연이 된다.
	moshHandshakePollInterval = 20 * time.Millisecond
	moshMonitorInterval       = 1 * time.Second
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
	// TailnetDial 은 payload 의 tailnet 경로를 raw dialer 로 바꿔 준다. nil 이거나 경로가
	// 비어 있으면 평소처럼 직접 나간다.
	//
	// bootstrap SSH 와 그 위의 UDP 세션 **둘 다** 이 dialer 로 보낸다. dialer 가 network 를
	// 받으므로 같은 함수로 "tcp" 와 "udp" 를 다 열 수 있다.
	TailnetDial sshconn.TailnetDialResolver
	// TailnetDialTimeout 은 UDP 세션을 tailnet 으로 열 때 주는 예산이다. bootstrap 이 이미
	// 노드를 올려 둔 뒤라 짧아도 되지만, 노드가 그 사이 유휴로 내려갔을 수 있어 여유를 둔다.
	TailnetDialTimeout time.Duration
	// HandshakeTimeout 은 첫 SSP 응답을 기다리는 시간이다. 이 안에 아무것도 오지 않으면 연결
	// 실패로 본다. 테스트가 짧게 줄일 수 있도록 설정으로 둔다.
	HandshakeTimeout time.Duration
}

var defaultManagerConfig = ManagerConfig{
	TCPDialTimeout:       10 * time.Second,
	TCPKeepAliveInterval: 30 * time.Second,
	TailnetDialTimeout:   60 * time.Second,
	HandshakeTimeout:     10 * time.Second,
}

type sessionHandle struct {
	client *mosh.Client
	closed chan struct{}
	closer sync.Once
	// startedAt 은 UDP 세션을 만든 시각이다. "아직 한 번도 못 받았다"를 판정하는 기준점이다 —
	// mosh-go 의 NewTransport 가 lastRecv 를 time.Now() 로 초기화하므로 LastRecv() 만으로는
	// 실제 수신과 세션 생성을 구분할 수 없다.
	startedAt time.Time
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
	if config.TailnetDialTimeout == 0 {
		config.TailnetDialTimeout = defaultManagerConfig.TailnetDialTimeout
	}
	if config.HandshakeTimeout == 0 {
		config.HandshakeTimeout = defaultManagerConfig.HandshakeTimeout
	}
	return &Manager{
		sessions:          make(map[string]*sessionHandle),
		pendingChallenges: make(map[string]chan []string),
		emit:              emit,
		emitStream:        stream,
		config:            config,
	}
}

// dialMosh 는 mosh UDP 세션을 연다. tailnet 경로가 있으면 그 노드를 통해, 없으면 일반
// 네트워크로 나간다.
//
// 두 경우 모두 conn 을 여기서 열고 mosh.DialConn 에 넘긴다. mosh.Dial 을 쓰지 않는 이유가
// 있다 — 그 함수는 host 를 net.ParseIP 로 해석해서 **이름을 받지 못한다.** 이름을 넘기면
// ParseIP 가 nil 을 돌려주고, net.DialUDP 는 그것을 거부하지 않고 127.0.0.1 로 연결한다.
// UDP 는 핸드셰이크가 없으니 dial 도 write 도 성공하고, 부트스트랩까지 정상으로 보인 뒤
// 세션만 영원히 응답을 못 받는다("첫 출력을 보내는 중"에서 멈춤). 주소가 IP 리터럴인 호스트만
// 우연히 동작하던 셈이다.
//
// 직접 열면 tailnet 이든 아니든 이름이 해석된다 — 일반 경로는 net.Dialer 가, tailnet 경로는
// tsnet 이 MagicDNS 로.
//
// udp4 를 쓰는 것은 mosh-go 가 하던 선택을 그대로 따른 것이다. mosh-server 가 IPv4 로만
// 듣는 환경에서 이름이 AAAA 로도 풀릴 때 엉뚱한 족으로 붙는 것을 피한다.
func (m *Manager) dialMosh(
	dial sshconn.DialFunc,
	host string,
	port int,
	key string,
) (*mosh.Client, error) {
	// 키를 먼저 본다. dial 뒤에 검사하면 실패 경로에서 tailnet 리스를 잡았다가 놓을 자리가
	// 없어져, 노드가 유예에 들어가지 못하고 계속 떠 있는다.
	ocb, err := moshOCBFromKey(key)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), m.config.TailnetDialTimeout)
	defer cancel()

	addr := net.JoinHostPort(host, strconv.Itoa(port))
	var conn net.Conn
	if dial != nil {
		conn, err = dial(ctx, "udp4", addr)
		if err != nil {
			return nil, fmt.Errorf("tailnet udp: %w", err)
		}
	} else {
		var dialer net.Dialer
		conn, err = dialer.DialContext(ctx, "udp4", addr)
		if err != nil {
			return nil, fmt.Errorf("udp: %w", err)
		}
	}

	// 여기서부터 conn 의 수명은 mosh 클라이언트가 쥔다. 실패하면 우리가 닫아야 한다 — tailnet
	// 경유면 그 닫힘이 리스를 놓는 지점이기도 하다.
	client, err := mosh.DialConn(conn, ocb)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return client, nil
}

// moshOCBFromKey 는 bootstrap 이 회수한 base64 키를 mosh 암호 상태로 바꾼다.
//
// mosh.Dial 이 내부에서 하던 것과 같아야 한다. mosh-server 는 패딩 없는 base64 를 출력하므로
// 붙여 주지 않으면 디코딩이 실패한다.
func moshOCBFromKey(key string) (*mosh.OCB, error) {
	padded := key
	for len(padded)%4 != 0 {
		padded += "="
	}
	rawKey, err := base64.StdEncoding.DecodeString(padded)
	if err != nil {
		return nil, fmt.Errorf("mosh: bad key: %w", err)
	}
	return mosh.NewOCB(rawKey)
}

func (m *Manager) Connect(sessionID, requestID string, payload protocol.ConnectPayload) error {
	// 1) SSH bootstrap — mosh-server를 원격에서 띄우기 위한 1회성 SSH 연결.
	//    인증/jump/known-host 인프라는 sshsession과 동일하게 sshconn으로 재사용한다.
	attempt := 0
	target := sshconn.Target{
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
	}
	dial, dialErr := sshconn.ResolveTailnetDial(
		m.config.TailnetDial,
		payload.TailnetID,
		payload.TailnetName,
	)
	if dialErr != nil {
		return dialErr
	}

	// bootstrap SSH도 홉 진행을 방출(SessionID로 해당 탭에 매핑) — 세션과 동일한 공통 헬퍼.
	client, err := sshconn.DialClient(target, sshconn.Config{
		Dial:                  dial,
		TCPDialTimeout:        m.config.TCPDialTimeout,
		TCPKeepAliveInterval:  m.config.TCPKeepAliveInterval,
		Progress:              sshconn.HopProgress(target, sessionID, "", m.emit),
		AuthAgentEndpointKind: payload.AuthAgentEndpointKind,
		AuthAgentEndpoint:     payload.AuthAgentEndpoint,
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
	moshClient, err := m.dialMosh(dial, payload.Host, port, key)
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
		// DialConn 직후여야 한다. mosh-go 가 그 안에서 lastRecv 를 time.Now() 로 잡으므로,
		// 이 값보다 lastRecv 가 뒤여야 "실제로 받았다"가 된다.
		startedAt: time.Now(),
	}

	// SSP 응답이 올 때까지 기다린 뒤에 연결 성공을 보고한다.
	//
	// 여기서 기다리지 않고 곧바로 connected 를 보내면, 응답이 영원히 안 오는 경우가
	// "연결됐다가 나중에 끊긴 세션"이 된다. 그 경로는 탭을 조용히 없애서 사용자에게 이유가
	// 남지 않는다 — 실제로 그렇게 보였다. 연결 실패로 반환하면 평소의 연결 실패 안내(모달 +
	// 탭 유지)를 그대로 탄다.
	//
	// 성공 시에는 한 왕복이면 돌아오므로(수십 ms) 정상 연결이 느려지지 않는다.
	if err := m.awaitFirstResponse(handle); err != nil {
		handle.closer.Do(func() {
			close(handle.closed)
			moshClient.Close()
		})
		return err
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

			// Connect 가 첫 SSP 응답을 확인한 뒤에야 세션을 등록하므로, 여기서 lastRecv 는 항상 실제
			// 수신이다. mosh-go 가 lastRecv 를 생성 시각으로 초기화하는 것에 기대지 않아도 된다.
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

// awaitFirstResponse 는 첫 SSP 응답을 기다린다. 오지 않으면 무엇을 해야 하는지 담은 에러를
// 돌려준다.
//
// 부트스트랩(SSH)이 됐는데 UDP 가 한 번도 오지 않는 경우는 거의 항상 방화벽이다 — mosh 의 UDP
// 포트는 SSH 와 다른 포트여서, SSH 만 열어 둔 서버에서는 반드시 이 증상이 난다.
func (m *Manager) awaitFirstResponse(handle *sessionHandle) error {
	deadline := handle.startedAt.Add(m.config.HandshakeTimeout)
	for {
		if moshHasReceivedAnything(handle.startedAt, handle.client.Transport().LastRecv()) {
			return nil
		}
		if !time.Now().Before(deadline) {
			return errors.New(moshNoUDPResponseMessage)
		}
		time.Sleep(moshHandshakePollInterval)
	}
}

// moshHasReceivedAnything 은 SSP 응답을 실제로 받았는지 본다.
//
// mosh-go 의 NewTransport 가 lastRecv 를 time.Now() 로 초기화하므로, 세션 생성 시각보다 뒤로
// 갱신됐을 때만 실제 수신이다. IsZero 검사는 한 번도 발동하지 않는다.
func moshHasReceivedAnything(startedAt, lastRecv time.Time) bool {
	return lastRecv.After(startedAt)
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
