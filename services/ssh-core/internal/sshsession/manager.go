package sshsession

import (
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshcmd"
	"dolssh/services/ssh-core/internal/sshconn"
)

// EventEmitter는 상태 이벤트를 상위 레이어로 흘려보내는 함수 타입이다.
type EventEmitter func(protocol.Event)

// StreamEmitter는 raw 터미널 바이트를 상위 레이어로 흘려보내는 함수 타입이다.
type StreamEmitter func(protocol.StreamFrame, []byte)

type sessionHandle struct {
	client    *ssh.Client
	session   *ssh.Session
	stdin     io.WriteCloser
	closed    chan struct{}
	closer    sync.Once
	handshake autocomplete.Handshake

	shellIntegrationMu             sync.Mutex
	shellIntegrationState          shellIntegrationState
	shellIntegrationFlushScheduled bool

	completionWorkerMu sync.Mutex
	completionWorker   *sshcmd.CompletionWorker
}

type ManagerConfig struct {
	// TCPDialTimeout은 초기 TCP 연결 수립에 허용할 최대 시간이다.
	TCPDialTimeout time.Duration
	// TCPKeepAliveInterval은 커널 수준 TCP keepalive probe 간격이다. 음수면 비활성화한다.
	TCPKeepAliveInterval time.Duration
	// SSHKeepAliveInterval은 애플리케이션 레벨 keepalive 전송 간격이다. 음수면 비활성화한다.
	SSHKeepAliveInterval time.Duration
	// SSHKeepAliveMaxFailures는 세션을 끊김으로 판단하기 전 허용하는 연속 keepalive
	// 실패 횟수다(OpenSSH의 ServerAliveCountMax에 해당). 단발 네트워크 블립으로 멀쩡한
	// 세션을 죽이는 오탐을 막는다. 0 이하면 기본값을 쓴다.
	SSHKeepAliveMaxFailures int
	// SSHKeepAliveProbeTimeout은 keepalive probe 한 번의 응답을 기다리는 최대 시간이다.
	// 커널 TCP 타임아웃에 끌려가지 않고 간격 기반으로 실패를 감지하기 위함이다.
	SSHKeepAliveProbeTimeout time.Duration
}

var defaultManagerConfig = ManagerConfig{
	TCPDialTimeout:           10 * time.Second,
	TCPKeepAliveInterval:     30 * time.Second,
	SSHKeepAliveInterval:     30 * time.Second,
	SSHKeepAliveMaxFailures:  3,
	SSHKeepAliveProbeTimeout: 10 * time.Second,
}

// 종료 사유 — ClosedPayload.Reason으로 renderer에 전달돼 자동 재연결 판단에 쓰인다.
const (
	closeReasonRemoteExit = "remote-exit" // 원격 셸 정상 종료(exit) → 재연결하지 않음
	closeReasonTransport  = "transport"   // 전송 단절 → 재연결 대상
	closeReasonKeepalive  = "keepalive"   // keepalive 연속 실패 → 재연결 대상
	closeReasonClient     = "client"      // 클라이언트 요청 종료 → 재연결하지 않음
)

type shellIntegrationState int

const (
	shellIntegrationUnknown shellIntegrationState = iota
	shellIntegrationInstalled
	shellIntegrationUnsupported
)

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
	if config.SSHKeepAliveMaxFailures <= 0 {
		config.SSHKeepAliveMaxFailures = defaultManagerConfig.SSHKeepAliveMaxFailures
	}
	if config.SSHKeepAliveProbeTimeout == 0 {
		config.SSHKeepAliveProbeTimeout = defaultManagerConfig.SSHKeepAliveProbeTimeout
	}

	return &Manager{
		sessions:          make(map[string]*sessionHandle),
		pendingChallenges: make(map[string]chan []string),
		emit:              emit,
		emitStream:        stream,
		config:            config,
	}
}

// buildEnvExportFallback는 SetEnv가 거부된 변수들을 대화형 셸에 주입할
// `export KEY='VALUE'` 줄(캐리지 리턴 구분)로 만든다. 값은 QuotePosix로 안전하게
// 감싸 셸 인젝션을 막는다.
func buildEnvExportFallback(envVars []protocol.EnvVar) string {
	var builder strings.Builder
	for _, envVar := range envVars {
		if envVar.Key == "" {
			continue
		}
		builder.WriteString("export ")
		builder.WriteString(envVar.Key)
		builder.WriteString("=")
		builder.WriteString(sshcmd.QuotePosix(envVar.Value))
		builder.WriteString("\r")
	}
	return builder.String()
}

func (m *Manager) Connect(sessionID, requestID string, payload protocol.ConnectPayload) error {
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

	// 환경변수 주입: SSH SetEnv를 먼저 시도한다(서버 AcceptEnv 허용 시 무가시 적용).
	// 서버가 거부한 변수는 export 폴백 목록에 모아 Shell 시작 후 PTY로 주입한다.
	var envFallback []protocol.EnvVar
	for _, envVar := range payload.Env {
		if envVar.Key == "" {
			continue
		}
		if err := session.Setenv(envVar.Key, envVar.Value); err != nil {
			envFallback = append(envFallback, envVar)
		}
	}

	if payload.Command != "" {
		if err := session.Start(payload.Command); err != nil {
			session.Close()
			client.Close()
			return fmt.Errorf("command start failed: %w", err)
		}
	} else if err := session.Shell(); err != nil {
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

	// bash/zsh 대화형 셸에는 OSC 133 통합 init을 서버측에서 즉시 주입한다. renderer 왕복
	// (connected→IPC→main→Go→stdin) 없이 stream goroutine보다 확실히 앞서므로, handshake가
	// 로그인 motd만 남기고 통합 전 첫 프롬프트와 명령 echo를 흡수해 "프롬프트 2개"를 막는다.
	// 셸 판정 실패/unsupported shell은 기존처럼 아무것도 주입하지 않는다.
	if payload.Command == "" {
		_, _ = m.installShellIntegrationIfSupported(sessionID, handle)
	}

	// SetEnv가 거부된 변수는 대화형 셸에 export로 폴백 주입한다. PTY가 입력을
	// 버퍼링하므로 첫 프롬프트에서 실행되어 startup command보다 먼저 적용된다.
	// 비대화형(command 실행) 세션에는 주입하지 않는다. shell integration이 설치된 경우에는
	// init 뒤에 와야 export echo도 통합 전 프롬프트와 함께 handshake에 흡수된다.
	if payload.Command == "" && len(envFallback) > 0 {
		_, _ = stdin.Write([]byte(buildEnvExportFallback(envFallback)))
	}

	// connected 이벤트는 renderer가 탭 상태를 연결 완료로 바꾸는 기준점이다.
	m.emit(protocol.Event{
		Type:      protocol.EventConnected,
		RequestID: requestID,
		SessionID: sessionID,
		Payload: protocol.StatusPayload{
			Status: "connected",
		},
	})

	go m.stream(sessionID, handle, stdout)
	go m.stream(sessionID, handle, stderr)
	// Wait는 별도 goroutine에서 감시해 원격 종료를 이벤트로 전파한다.
	go m.waitForSession(sessionID)
	// 접속 직후 보조채널로 원격 tmux 설치/세션을 감지해 하단바 신호를 보낸다(대화형 셸만).
	if payload.Command == "" {
		go m.detectAndEmitTmux(sessionID)
	}
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

func (m *Manager) HasSession(sessionID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.sessions[sessionID]
	return ok
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

func (m *Manager) CollectAutocomplete(sessionID string, revision int) (autocomplete.Result, error) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return autocomplete.Result{}, err
	}
	stdout, _, err := sshcmd.RunWithTimeout(
		session.client,
		autocomplete.RemoteSnapshotCommand(),
		3*time.Second,
	)
	if err != nil {
		return autocomplete.Degraded("", "metadata-unavailable"), nil
	}
	return autocomplete.ParseSnapshot(stdout, revision), nil
}

// detectAndEmitTmux는 접속 직후 보조 exec 채널로 원격 tmux 설치/버전/세션 목록을
// 조회해 EventTmuxAvailable로 emit한다(인터랙티브 셸 무영향). tmux 미설치/실패면
// 아무 이벤트도 보내지 않아 하단바가 뜨지 않는다.
func (m *Manager) detectAndEmitTmux(sessionID string) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return
	}
	// list-sessions 는 세션이 0개면 exit 1 이라 cmd 전체가 비-0 으로 끝나지만, stdout 에
	// "tmux <version>" 은 그대로 찍힌다. 그래서 err 는 무시하고 stdout 을 파싱한다(tmux
	// 미설치면 version 이 비어 아래에서 걸러진다). 세션이 없어도 하단바는 떠야 한다.
	stdout, _, _ := sshcmd.RunWithTimeout(session.client, TmuxDetectCommand, 3*time.Second)
	payload := ParseTmuxDetect(string(stdout))
	if payload.Version == "" {
		return
	}
	m.emit(protocol.Event{
		Type:      protocol.EventTmuxAvailable,
		SessionID: sessionID,
		Payload:   payload,
	})
}

// KillTmuxSession 은 감지 하단바(attach 전)에서 원격 tmux 세션을 보조 exec 채널로
// 종료한다. control mode 진입 없이 kill-session 을 실행한 뒤 목록을 재감지해 하단바를
// 갱신한다. kill 실패(이미 없는 세션 등)는 무시하고 항상 재감지로 실제 상태를 반영한다
// — 에러를 올리면 SSH 세션 자체가 영향받을 수 있어 best-effort 로 처리한다.
func (m *Manager) KillTmuxSession(sessionID, sessionName string) error {
	session, err := m.getSession(sessionID)
	if err != nil || sessionName == "" {
		return nil
	}
	// 이름은 작은따옴표로 감싸 셸 인젝션을 막는다(tmuxsession.KillSession 과 동일 escape).
	quoted := "'" + strings.ReplaceAll(sessionName, "'", `'\''`) + "'"
	_, _, _ = sshcmd.RunWithTimeout(
		session.client,
		fmt.Sprintf("tmux kill-session -t %s", quoted),
		3*time.Second,
	)
	m.detectAndEmitTmux(sessionID)
	return nil
}

// TmuxDetectCommand 는 원격 tmux 버전 + 세션 목록(탭 구분)을 한 번에 조회한다.
// control mode(tmuxsession)에서도 동일 명령으로 세션 목록을 라이브 조회한다.
const TmuxDetectCommand = "command -v tmux >/dev/null 2>&1 && { tmux -V; tmux list-sessions -F '#{session_name}\t#{session_windows}\t#{?session_attached,1,0}' 2>/dev/null; }"

const remoteShellProbeTimeout = 2 * time.Second
const remoteShellProbeCommand = `if [ -n "${BASH_VERSION:-}" ]; then printf 'bash\n'; elif [ -n "${ZSH_VERSION:-}" ]; then printf 'zsh\n'; fi`

// ParseTmuxDetect는 "tmux -V" 첫 줄 + "list-sessions -F" 탭 구분 줄들을 파싱한다.
func ParseTmuxDetect(out string) protocol.TmuxAvailablePayload {
	var payload protocol.TmuxAvailablePayload
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) == "" {
		return payload
	}
	// 첫 줄: "tmux 3.5a" → 버전 "3.5a"
	payload.Version = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(lines[0]), "tmux "))
	for _, line := range lines[1:] {
		parts := strings.Split(line, "\t")
		if len(parts) < 3 {
			continue
		}
		windows, _ := strconv.Atoi(strings.TrimSpace(parts[1]))
		payload.Sessions = append(payload.Sessions, protocol.TmuxSessionInfo{
			Name:     parts[0],
			Windows:  windows,
			Attached: strings.TrimSpace(parts[2]) == "1",
		})
	}
	return payload
}

// RunCompletionCommand runs a short read-only command on a separate exec
// channel (not the interactive shell) and returns its stdout, for dynamic
// completion. Bounded by CompletionTimeout and CapOutput.
func (m *Manager) RunCompletionCommand(sessionID, command string) (string, bool, error) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return "", false, err
	}
	stdout, truncated, err := session.runCompletionWorker(command)
	if err == nil || len(stdout) > 0 {
		return string(stdout), truncated, err
	}
	if !errors.Is(err, sshcmd.ErrCompletionWorkerUnavailable) {
		return "", false, err
	}

	fallbackStdout, _, err := sshcmd.RunWithTimeout(session.client, command, autocomplete.CompletionTimeout)
	// A completion command exiting non-zero is not fatal — return whatever it
	// printed (best-effort). Only surface an error when nothing was captured.
	if err != nil && len(fallbackStdout) == 0 {
		return "", false, err
	}
	out, truncated := autocomplete.CapOutput(fallbackStdout)
	return out, truncated, nil
}

func (h *sessionHandle) runCompletionWorker(command string) ([]byte, bool, error) {
	worker := h.getCompletionWorker()
	return worker.Run(command, autocomplete.CompletionTimeout, autocomplete.MaxCompletionBytes)
}

func (h *sessionHandle) getCompletionWorker() *sshcmd.CompletionWorker {
	h.completionWorkerMu.Lock()
	defer h.completionWorkerMu.Unlock()
	if h.completionWorker == nil {
		h.completionWorker = sshcmd.NewCompletionWorker(h.client)
	}
	return h.completionWorker
}

func (h *sessionHandle) closeCompletionWorker() {
	h.completionWorkerMu.Lock()
	worker := h.completionWorker
	h.completionWorker = nil
	h.completionWorkerMu.Unlock()
	if worker != nil {
		_ = worker.Close()
	}
}

// shellIntegrationHandshakeTimeout는 OSC 133;A 마커를 기다리는 한계 시간이다. 이 안에
// 마커가 안 오면(비호환 셸 등) handshake buffer를 flush해 motd가 갇히지 않게 한다. 느린
// 호스트나 무거운 prompt는 첫 프롬프트가 몇 초 늦을 수 있어 넉넉히 둔다(runtime의 동명 상수와 동일 의도).
const shellIntegrationHandshakeTimeout = 8 * time.Second

// InstallShellIntegration는 OSC 133 통합 init을 대화형 셸에 1회 주입한다. 서버측 Connect가
// 이미 주입했으면 once로 no-op이 된다. 자동완성 off에서도 cwd/프롬프트 마커가 필요한
// 경로(예: 드래그-SFTP)가 호출하지만, 실제 주입은 Connect에서 끝나 있는 경우가 대부분이다.
func (m *Manager) InstallShellIntegration(sessionID string) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	_, err = m.installShellIntegrationIfSupported(sessionID, session)
	return err
}

func (m *Manager) installShellIntegrationIfSupported(sessionID string, session *sessionHandle) (bool, error) {
	switch session.shellIntegrationStatus() {
	case shellIntegrationInstalled:
		return false, nil
	case shellIntegrationUnsupported:
		return false, nil
	}
	if !remoteShellSupportsIntegration(session.client) {
		session.markShellIntegrationUnsupported()
		return false, nil
	}
	return m.installShellIntegration(sessionID, session)
}

func remoteShellSupportsIntegration(client *ssh.Client) bool {
	if client == nil {
		return false
	}
	stdout, _, err := sshcmd.RunWithTimeout(client, remoteShellProbeCommand, remoteShellProbeTimeout)
	if err != nil {
		return false
	}
	return normalizeRemoteShellProbeOutput(stdout) != ""
}

func normalizeRemoteShellProbeOutput(stdout []byte) string {
	for _, field := range strings.Fields(string(stdout)) {
		if shell := autocomplete.NormalizeShell(field); shell != "" {
			return shell
		}
	}
	return ""
}

func (h *sessionHandle) shellIntegrationStatus() shellIntegrationState {
	h.shellIntegrationMu.Lock()
	defer h.shellIntegrationMu.Unlock()
	return h.shellIntegrationState
}

func (h *sessionHandle) markShellIntegrationUnsupported() {
	h.shellIntegrationMu.Lock()
	defer h.shellIntegrationMu.Unlock()
	if h.shellIntegrationState == shellIntegrationUnknown {
		h.shellIntegrationState = shellIntegrationUnsupported
	}
}

// installShellIntegration는 핸드셰이크를 preserveMotd 모드로 arm하고 통합 init 명령을 셸
// stdin에 1회만 쓴다. write 성공 후에만 installed 상태가 되므로 실패 시 재시도 가능하다.
func (m *Manager) installShellIntegration(sessionID string, session *sessionHandle) (bool, error) {
	session.shellIntegrationMu.Lock()
	switch session.shellIntegrationState {
	case shellIntegrationInstalled, shellIntegrationUnsupported:
		session.shellIntegrationMu.Unlock()
		return false, nil
	}

	session.handshake.Arm(true)
	if _, err := session.stdin.Write([]byte(autocomplete.ShellIntegrationInitCommand())); err != nil {
		flushed := session.handshake.Flush()
		session.shellIntegrationState = shellIntegrationUnknown
		session.shellIntegrationMu.Unlock()
		if len(flushed) > 0 {
			m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
		}
		return false, err
	}

	session.shellIntegrationState = shellIntegrationInstalled
	shouldScheduleFlush := !session.shellIntegrationFlushScheduled
	session.shellIntegrationFlushScheduled = true
	session.shellIntegrationMu.Unlock()

	if shouldScheduleFlush {
		m.scheduleShellIntegrationFlush(sessionID, session)
	}
	return true, nil
}

func (m *Manager) scheduleShellIntegrationFlush(sessionID string, session *sessionHandle) {
	go func() {
		timer := time.NewTimer(shellIntegrationHandshakeTimeout)
		defer timer.Stop()
		select {
		case <-session.closed:
		case <-timer.C:
			m.FlushShellIntegration(sessionID)
		}
	}()
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
	m.closeSession(sessionID, "client requested disconnect", closeReasonClient)
	return nil
}

// classifyWaitError는 Session.Wait() 결과를 종료 사유로 매핑한다.
// 셸이 스스로 끝낸 경우(exit status 0 / exit N)만 remote-exit(재연결 안 함)로 보고,
// 시그널 종료(reboot의 SIGHUP/SIGTERM)·상태 없이 채널이 닫힘(ExitMissingError)·EOF·
// 기타 전송 에러는 transport(재연결 대상)로 본다. reboot은 어떤 형태로 와도 transport가
// 되어 자동 재연결 머신이 탭을 살려 둔다.
func classifyWaitError(err error) string {
	if err == nil {
		// exit status 0 — 정상 로그아웃.
		return closeReasonRemoteExit
	}
	var exitErr *ssh.ExitError
	if errors.As(err, &exitErr) && exitErr.Signal() == "" {
		// 시그널 없이 종료 코드만 보냄(exit / exit N) — 사용자가 셸을 끝낸 것.
		return closeReasonRemoteExit
	}
	// 시그널 종료 / ExitMissingError(상태·시그널 없이 채널 닫힘) / io.EOF / I/O 단절.
	return closeReasonTransport
}

func (m *Manager) waitForSession(sessionID string) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return
	}
	waitErr := session.session.Wait()
	reason := classifyWaitError(waitErr)
	message := ""
	if reason == closeReasonTransport && waitErr != nil {
		// 전송 단절일 때만 진단 메시지를 싣는다(정상 종료는 메시지 없음).
		message = waitErr.Error()
	}
	m.closeSession(sessionID, message, reason)
}

func (m *Manager) stream(sessionID string, handle *sessionHandle, reader io.Reader) {
	// stdout/stderr 모두 동일한 raw stream frame으로 흘려 상위 레이어가 그대로 전달할 수 있게 한다.
	buffer := make([]byte, 4096)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buffer[:n])
			chunk = handle.handshake.Filter(chunk)
			if len(chunk) > 0 {
				m.emitStream(protocol.StreamFrame{
					Type:      protocol.StreamTypeData,
					SessionID: sessionID,
				}, chunk)
			}
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

	// 단발 블립으로 멀쩡한 세션을 죽이지 않도록 연속 실패가 임계값에 도달해야 종료한다
	// (OpenSSH ServerAliveCountMax와 동일한 개념). 자동 재연결에선 오탐=실세션 종료라 중요.
	consecutiveFailures := 0
	for {
		select {
		case <-session.closed:
			return
		case <-ticker.C:
			if rtt, ok := m.sendKeepAliveProbe(session); ok {
				consecutiveFailures = 0
				// probe round-trip 을 탭 인디게이터용 RTT 로 보고한다(rtt==0 은 종료 중
				// 센티넬이라 제외). keepalive 주기마다 갱신.
				if rtt > 0 {
					m.emit(protocol.Event{
						Type:      protocol.EventLatency,
						SessionID: sessionID,
						Payload:   protocol.LatencyPayload{RoundTripMs: int(rtt.Milliseconds())},
					})
				}
				continue
			}
			consecutiveFailures++
			if consecutiveFailures >= m.config.SSHKeepAliveMaxFailures {
				m.closeSession(
					sessionID,
					fmt.Sprintf("ssh keepalive failed after %d attempts", consecutiveFailures),
					closeReasonKeepalive,
				)
				return
			}
		}
	}
}

// sendKeepAliveProbe는 probe 한 번을 보내고 타임아웃 내 round-trip 성공 여부를 반환한다.
// SendRequest를 고루틴으로 감싸 커널 TCP 타임아웃에 끌려가지 않고 간격 기반으로 실패를
// 감지한다. probe가 늦게 끝나도 채널이 버퍼(1)라 고루틴은 누수 없이 정리된다.
func (m *Manager) sendKeepAliveProbe(session *sessionHandle) (time.Duration, bool) {
	start := time.Now()
	resultCh := make(chan error, 1)
	go func() {
		// wantReply=true로 보내야 연결이 실제로 살아 있는지 round-trip으로 확인된다.
		_, _, err := session.client.SendRequest("keepalive@openssh.com", true, nil)
		resultCh <- err
	}()
	select {
	case err := <-resultCh:
		return time.Since(start), err == nil
	case <-time.After(m.config.SSHKeepAliveProbeTimeout):
		return 0, false
	case <-session.closed:
		// 종료 중이면 실패로 치지 않는다(곧 keepAlive 루프가 빠져나간다). rtt=0 센티넬.
		return 0, true
	}
}

func (m *Manager) closeSession(sessionID string, message string, reason string) {
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
		session.closeCompletionWorker()
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
			Reason:  reason,
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
