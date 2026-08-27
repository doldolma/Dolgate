package sshsession

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/hostkeytrust"
	"dolssh/services/ssh-core/internal/neterr"
	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshcmd"
	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/internal/sshdial"
)

// EventEmitter는 상태 이벤트를 상위 레이어로 흘려보내는 함수 타입이다.
type EventEmitter func(protocol.Event)

// StreamEmitter는 raw 터미널 바이트를 상위 레이어로 흘려보내는 함수 타입이다.
type StreamEmitter func(protocol.StreamFrame, []byte)

type sessionHandle struct {
	client  *ssh.Client
	session *ssh.Session
	// stdin은 여러 goroutine이 쓴다(사용자 키 입력·connect의 env export 폴백·shell
	// integration 주입·서브셸 재주입 타이머). 반드시 writeStdin/closeStdin으로만
	// 접근할 것 — 직접 Write하면 stdinMu를 우회한다.
	stdin io.WriteCloser
	// stdinMu는 stdin 접근을 직렬화한다. 실제 stdin은 x/crypto/ssh 채널이고
	// channel.WriteExtended는 스트림별 packet 버퍼(packetPool)를 재사용하므로
	// 동시 Write는 상류가 명시한 데이터 레이스다. 레이스가 아니어도 1KB짜리 통합 init
	// 명령이 사용자 키 입력과 바이트 단위로 섞여 원격 PTY에 깨진 명령줄로 도착한다.
	// Close(=CloseWrite)도 Write가 읽는 sentEOF를 건드리므로 같은 락으로 묶는다.
	stdinMu   sync.Mutex
	closed    chan struct{}
	closer    sync.Once
	handshake autocomplete.Handshake

	shellIntegrationMu             sync.Mutex
	shellIntegrationState          shellIntegrationState
	shellIntegrationFlushScheduled bool

	// shellProbe 는 "너 누구냐" 한 줄의 답을 기다린다. 셸을 모를 때만 무장된다.
	shellProbe autocomplete.ShellProbe
	// 이 세션의 앞 셸이 통합을 넣을 수 없는 것(dash·busybox 등)으로 확인됐다. 다시 묻지 않는다.
	shellIntegrationUnsupported atomic.Bool
	// reinjectGate는 서브셸(중첩 ssh·sudo su·docker exec 등) 진입 후 새 프롬프트가
	// 안착하면 OSC 133/7 통합 스크립트를 1회 다시 주입하기 위한 프롬프트 감지기다.
	// Connect에서 생성되며 Arm 되기 전에는 Observe가 no-op이다.
	reinjectGate *autocomplete.PromptSettleGate

	completionPoolMu sync.Mutex
	completionPool   *sshcmd.WorkerPool

	// sudo 는 세션 패널이 도커를 읽으려는데 소켓 권한이 없고 `sudo -n` 도 막혔을 때만 쓴다.
	//
	// **로그인 비밀번호를 세션이 사는 동안 들고 있는다는 뜻이다.** 예전에는 인증이 끝나면
	// 버렸다. 되물리려면 가지고 있어야 하고, 대신 범위를 좁게 둔다 — 비밀번호로 붙은 세션에서만
	// 채우고, 명령줄이 아니라 stdin 으로만 흘리고(sshcmd.BuildSudoCommand), 한 번 틀리면
	// denied 를 세워 이 세션에서는 다시 시도하지 않는다. 틀린 sudo 시도는 pam_faillock 카운터를
	// 올려 계정을 잠글 수 있어서, 주기적으로 재시도하는 것이 실제 피해가 된다.
	sudoMu       sync.Mutex
	sudoPassword string
	sudoDenied   bool
}

// setSudoPassword 는 비밀번호로 붙은 세션에만 되물릴 값을 남긴다.
func (h *sessionHandle) setSudoPassword(authType, password string) {
	if authType != "password" || password == "" {
		return
	}
	h.sudoMu.Lock()
	defer h.sudoMu.Unlock()
	h.sudoPassword = password
}

// takeSudoPassword 는 지금 되물릴 수 있는 비밀번호를 준다. 없거나 이미 한 번 거절당했으면
// 빈 값이다 — 호출자는 원격을 건드리지 않고 끝낸다.
func (h *sessionHandle) takeSudoPassword() string {
	h.sudoMu.Lock()
	defer h.sudoMu.Unlock()
	if h.sudoDenied {
		return ""
	}
	return h.sudoPassword
}

// denySudo 는 되물린 비밀번호가 통하지 않았다고 표시한다. 이 세션에서는 다시 시도하지 않는다.
func (h *sessionHandle) denySudo() {
	h.sudoMu.Lock()
	defer h.sudoMu.Unlock()
	h.sudoDenied = true
}

// writeStdin writes p to the session's stdin as one indivisible unit. Every
// stdin writer must go through here: the underlying ssh channel is not safe for
// concurrent Write, and an injected command that interleaves with the user's
// keystrokes corrupts the remote command line.
func (h *sessionHandle) writeStdin(p []byte) (int, error) {
	h.stdinMu.Lock()
	defer h.stdinMu.Unlock()
	return h.stdin.Write(p)
}

// closeStdin closes stdin under the write lock so a concurrent writeStdin never
// overlaps the channel's CloseWrite.
func (h *sessionHandle) closeStdin() error {
	h.stdinMu.Lock()
	defer h.stdinMu.Unlock()
	return h.stdin.Close()
}

type ManagerConfig struct {
	// TCPDialTimeout은 초기 TCP 연결 수립에 허용할 최대 시간이다.
	TCPDialTimeout time.Duration
	// TCPKeepAliveInterval은 커널 수준 TCP keepalive probe 간격이다. 음수면 비활성화한다.
	TCPKeepAliveInterval time.Duration
	// SSHKeepAliveInterval은 애플리케이션 레벨 keepalive 전송 간격이다. 음수면 비활성화한다.
	SSHKeepAliveInterval time.Duration
	// TailnetDial 은 payload 의 tailnet 경로를 raw dialer 로 바꿔 준다. nil 이거나 경로가
	// 비어 있으면 평소처럼 직접 TCP 로 나간다.
	//
	// 여기서 받는 이유는 tailnet 레지스트리가 런타임 소유라서다. 매니저가 레지스트리를 직접
	// 알면 세션 계층이 tailnet 수명 관리까지 떠안게 된다 — 반환된 dialer 가 만든 conn 이
	// 닫힐 때 리스가 풀리므로, 매니저는 평소처럼 client 만 닫으면 된다.
	TailnetDial sshconn.TailnetDialResolver
	// SSHKeepAliveMaxFailures는 세션을 끊김으로 판단하기 전 허용하는 연속 keepalive
	// 실패 횟수다(OpenSSH의 ServerAliveCountMax에 해당). 단발 네트워크 블립으로 멀쩡한
	// 세션을 죽이는 오탐을 막는다. 0 이하면 기본값을 쓴다.
	SSHKeepAliveMaxFailures int
	// SSHKeepAliveProbeTimeout은 keepalive probe 한 번의 응답을 기다리는 최대 시간이다.
	// 커널 TCP 타임아웃에 끌려가지 않고 간격 기반으로 실패를 감지하기 위함이다.
	SSHKeepAliveProbeTimeout time.Duration
	// HostKeyTrustPrompt 는 처음 보는(또는 바뀐) 서버 키를 이 연결 안에서 물을 창구를 만든다.
	//
	// 런타임이 대기표를 하나 들고 있고(internal/hostkeytrust), 여기서는 그것을 받아 dial 에 넘긴다.
	// 없으면 예전대로 신뢰되지 않은 키에서 연결이 끝난다.
	//
	// Dialer 를 함께 주면 이 값은 무시된다 — 그때는 dialer 가 이미 자기 창구를 들고 있다.
	HostKeyTrustPrompt func(ctx context.Context, correlation hostkeytrust.Correlation) sshconn.HostKeyTrustFunc
	// Dialer 는 세션 계열(SSH·mosh·tmux)과 원격 키 설치가 **함께 쓰는** 연결 경로다.
	//
	// 런타임은 하나를 만들어 모두에게 넘긴다. 그래야 대화형 인증 대기표가 한 곳이라 응답을 어느
	// 매니저로 보낼지 고르는 분기가 없어지고(예전에는 "ssh 에 먼저 넣어 보고 실패하면 mosh" 였다),
	// 새 기능이 세 경로에 동시에 도착한다.
	//
	// nil 이면 위 설정값으로 하나 만들어 이 매니저만 쓴다 — 매니저 하나만 세우는 테스트용이다.
	Dialer *sshdial.Dialer
}

var defaultManagerConfig = ManagerConfig{
	TCPDialTimeout:           10 * time.Second,
	TCPKeepAliveInterval:     30 * time.Second,
	SSHKeepAliveInterval:     10 * time.Second,
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
	mu         sync.RWMutex
	sessions   map[string]*sessionHandle
	emit       EventEmitter
	emitStream StreamEmitter
	config     ManagerConfig
	// dialer 는 연결을 여는 공통 경로다. 대화형 인증 대기표와 "붙는 중" 등록도 그쪽이 든다
	// (internal/sshdial).
	dialer *sshdial.Dialer
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
		sessions:   make(map[string]*sessionHandle),
		dialer:     resolveDialer(emit, config),
		emit:       emit,
		emitStream: stream,
		config:     config,
	}
}

// resolveDialer 는 쓸 연결 경로를 고른다.
//
// 런타임이 넘겨준 것이 있으면 그것을 쓴다 — 세 세션 계열이 대기표를 공유해야 응답 라우팅에 분기가
// 생기지 않는다. 없으면(매니저 하나만 세우는 테스트) 이 설정값으로 하나 만들어 쓴다.
func resolveDialer(emit EventEmitter, config ManagerConfig) *sshdial.Dialer {
	if config.Dialer != nil {
		return config.Dialer
	}
	dialer := sshdial.New(emit)
	dialer.SetTailnetDial(config.TailnetDial)
	dialer.SetHostKeyTrustPrompt(config.HostKeyTrustPrompt)
	dialer.SetTimeouts(config.TCPDialTimeout, config.TCPKeepAliveInterval)
	return dialer
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
	// 붙는 동안 탭을 닫으면 이 ctx 가 취소돼 dial·핸드셰이크가 즉시 끝난다.
	ctx, release := m.dialer.Begin(sessionID)
	defer release()

	// 연결 조립은 sshdial 한 곳에 있다 — tailnet 경로, 홉 진행 보고, 호스트 키 신뢰 질의, 서버
	// 배너, 대화형 인증 대기표가 모두 거기서 붙는다(mosh·tmux 도 같은 것을 쓴다).
	client, _, err := m.dialer.Dial(ctx, sshdial.Request{
		SessionID: sessionID,
		RequestID: requestID,
		Payload:   payload,
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

	m.setupAgentForwarding(sessionID, requestID, client, session, payload)

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
		client:       client,
		session:      session,
		stdin:        stdin,
		closed:       make(chan struct{}),
		reinjectGate: autocomplete.NewPromptSettleGate(0, 0),
	}
	// 도커 소켓이 막혔을 때 `sudo -S` 로 한 번 되물릴 값(위 sudo 필드 주석 참고).
	handle.setSudoPassword(payload.AuthType, payload.Password)

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
		_, _ = handle.writeStdin([]byte(buildEnvExportFallback(envFallback)))
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

// RespondKeyboardInteractive 는 사용자의 답을 전달한다.
//
// 대기표는 dialer 가 든다 — 세션·mosh·tmux 가 그것을 공유하므로 어느 매니저의 물음인지 고르는
// 분기가 없다. sessionID 는 문구에만 쓴다.
func (m *Manager) RespondKeyboardInteractive(sessionID string, payload protocol.KeyboardInteractiveRespondPayload) error {
	if err := m.dialer.RespondKeyboardInteractive(payload); err != nil {
		return fmt.Errorf("%w (session %s)", err, sessionID)
	}
	return nil
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
	_, err = session.writeStdin(data)
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
const remoteShellProbeCommand = `test -n "$BASH_VERSION" && printf 'bash\n'; test -n "$ZSH_VERSION" && printf 'zsh\n'; test -n "$version" && printf 'fish\n'; printf '%s\n' "$SHELL"`

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
//
// background 는 사람이 결과를 기다리지 않는 질의(세션 패널의 도커·호스트 지표 폴링)라는
// 뜻이다. 그런 질의는 두 번째 보조 채널에서 돌아 자동완성을 막지 않는다 — 도커의
// `stats --no-stream` 한 번이 2초를 넘기는 일이 흔한데, 그동안 타이핑이 멈춰 보였다.
func (m *Manager) RunCompletionCommand(
	sessionID, command string,
	background, elevate bool,
) (string, bool, error) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return "", false, err
	}
	return autocomplete.RunCompletion(
		autocomplete.PoolTarget(
			session.getCompletionPool(),
			session.client,
			// 비밀번호로 붙은 연결만 되물릴 값을 갖는다. 한 번 거절당한 뒤에는 빈 값이 온다.
			session.takeSudoPassword,
			session.denySudo,
		),
		command,
		background,
		elevate,
	)
}

// runHostCommandMaxBytes caps captured stdout/stderr per stream to protect the
// IPC pipe. The Node run_command tool trims further for the model context.
const runHostCommandMaxBytes = 1 << 18 // 256 KiB

const (
	runHostCommandDefaultTimeout = 15 * time.Second
	runHostCommandMaxTimeout     = 120 * time.Second
)

// RunHostCommand runs an arbitrary command on a separate exec channel (not the
// interactive PTY) and returns stdout, stderr and the remote exit code. Used by
// the AI assistant's run_command tool. Unlike RunCompletionCommand it surfaces
// stderr and the exit status. A non-zero exit is NOT an error (err==nil,
// exitCode set); err is returned only when the command could not be run at all.
func (m *Manager) RunHostCommand(sessionID, command string, timeoutMs int) (string, string, int, bool, error) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return "", "", -1, false, err
	}
	timeout := time.Duration(timeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = runHostCommandDefaultTimeout
	}
	if timeout > runHostCommandMaxTimeout {
		timeout = runHostCommandMaxTimeout
	}
	// 로그인 셸로 감싸 대화형 세션과 같은 PATH/환경을 로드한다(그냥 exec 하면 docker 등이
	// PATH 에 없어 "command not found" 가 나기 쉽다 — Synology 등에서 흔함).
	wrapped := "sh -lc " + sshcmd.QuotePosix(command)
	stdout, stderr, runErr := sshcmd.RunWithTimeout(session.client, wrapped, timeout)
	exitCode := 0
	var execErr error
	if runErr != nil {
		var exitError *ssh.ExitError
		if errors.As(runErr, &exitError) {
			// Remote command ran and exited non-zero — not an exec failure.
			exitCode = exitError.ExitStatus()
		} else {
			// Channel error / timeout / killed by signal: could not obtain an exit
			// status. -1 marks "no exit status"; surface the underlying error.
			exitCode = -1
			execErr = runErr
		}
	}
	outStr, outTrunc := capRunCommandOutput(stdout)
	errStr, errTrunc := capRunCommandOutput(stderr)
	return outStr, errStr, exitCode, outTrunc || errTrunc, execErr
}

func capRunCommandOutput(b []byte) (string, bool) {
	if len(b) <= runHostCommandMaxBytes {
		return string(b), false
	}
	return string(b[:runHostCommandMaxBytes]), true
}

func (h *sessionHandle) getCompletionPool() *sshcmd.WorkerPool {
	h.completionPoolMu.Lock()
	defer h.completionPoolMu.Unlock()
	if h.completionPool == nil {
		h.completionPool = sshcmd.NewWorkerPool(h.client)
	}
	return h.completionPool
}

func (h *sessionHandle) closeCompletionWorker() {
	h.completionPoolMu.Lock()
	pool := h.completionPool
	h.completionPool = nil
	h.completionPoolMu.Unlock()
	if pool != nil {
		_ = pool.Close()
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

// ReinjectShellIntegration re-installs the OSC 133/7 hooks into whatever shell
// is currently in the foreground of an existing session. It is used after the
// user enters a subshell (nested ssh, sudo su, docker exec, another bash/zsh),
// where the connect-time hooks do not exist so command status and cwd go stale.
// It does not inject immediately: writing into a shell that is still
// connecting/authenticating would corrupt input, so it waits (via reinjectGate)
// until the subshell shows a settled prompt, then arms the echo-suppression
// handshake and writes the shell-agnostic init command over the existing PTY.
// Because it targets the current foreground shell, nested ssh/su/docker are
// covered without a new channel; a non-bash/zsh subshell emits no OSC 133;A
// marker and the handshake flush restores its output.
func (m *Manager) ReinjectShellIntegration(sessionID string, shell string) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	session.reinjectGate.Arm(
		func(tail []byte) { m.performShellIntegrationReinject(sessionID, session, shell, tail) },
		// No prompt settled within the window (unusual prompt, non-shell
		// foreground, or still authenticating): leave the session untouched.
		func() {},
	)
	return nil
}

func (m *Manager) performShellIntegrationReinject(
	sessionID string,
	session *sessionHandle,
	shell string,
	tail []byte,
) {
	if !m.HasSession(sessionID) {
		return
	}
	// 서브셸이 뜨지 않았으면(진입 명령 실패 → 원래 셸이 새 프롬프트를 그림) 그 프롬프트에 이미
	// 우리 마커가 있다. 보내 봐야 프롬프트만 한 번 더 남는다.
	if autocomplete.PromptAlreadyIntegrated(tail) {
		return
	}
	// 셸을 모르면 **먼저 물어본다.**
	//
	// 예전에는 모를 때 bash·zsh 겸용 스크립트를 보냈는데, 그것이 여러 줄이라 dash·busybox 에서
	// PS2 계속 프롬프트와 스크립트 전문이 화면에 남았다. 짧은 한 줄로 셸을 확인하고 그 셸 전용
	// 한 줄만 보내면, 지원하지 않는 셸에는 애초에 아무것도 가지 않는다.
	if strings.TrimSpace(shell) == "" {
		if session.shellIntegrationUnsupported.Load() {
			// 지금 앞에 있는 그 셸에는 이미 물어봤고 답이 "없다" 였다. 다시 묻지 않는다.
			//
			// 표시는 **그 셸에서 나오면 지워진다**(stream 이 바깥 프롬프트 마커를 보고 지운다).
			// 세션에 영구히 걸어 두면 alpine 에 한 번 들어갔다 나온 뒤로는 bash 컨테이너에도
			// 통합이 안 붙고, 바깥 블록을 닫아 주지도 못해 블록이 계속 열린 채로 남았다.
			return
		}
		m.probeShellThenReinject(sessionID, session)
		return
	}
	// Arm the handshake immediately before writing so only the injected command's
	// echo (and its prompt redraw) is hidden — the subshell's own login/motd and
	// prompt were already shown to the user while the gate was waiting.
	// 셸을 알면 그 셸 것 한 줄로 끝난다. 지원하지 않는 셸이면 아무것도 보내지 않는다.
	commands := autocomplete.ShellIntegrationInitLines(shell)
	if len(commands) == 0 {
		return
	}
	// preserveMotd=false 인 이유는 프로브 쪽과 같다(shell_probe.go 주석).
	session.handshake.ArmForCommand(false, commands...)
	// 프롬프트를 보고 쓰므로 그 프롬프트가 이미 화면에 있다 — 그 줄을 지워 새 프롬프트가 같은
	// 자리에 오게 한다(지우지 않으면 bash 에서 프롬프트가 두 번 찍힌다).
	//
	// 함께 바깥 명령 블록을 닫는다. 여기서부터는 **안쪽 셸이 자기 블록을 만들기 때문**이다 —
	// 안 닫으면 아직 열려 있는 바깥 블록(`docker exec …`) 안에 안쪽 블록들이 들어앉는다.
	m.emitStream(
		protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID},
		[]byte(autocomplete.CommandFinishedMarker+"\r\x1b[2K"),
	)
	for _, command := range commands {
		if _, err := session.writeStdin([]byte(command)); err != nil {
			if flushed := session.handshake.Flush(); len(flushed) > 0 {
				m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
			}
			return
		}
	}
	// If the foreground shell is not bash/zsh the OSC 133;A marker never arrives,
	// so release the buffered output after the handshake window instead of hiding
	// it forever. Flush is a no-op once the marker already completed the handshake.
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

func (m *Manager) installShellIntegrationIfSupported(sessionID string, session *sessionHandle) (bool, error) {
	switch session.shellIntegrationStatus() {
	case shellIntegrationInstalled:
		return false, nil
	case shellIntegrationUnsupported:
		return false, nil
	}
	shell := remoteShellIntegrationShell(session.client)
	if shell == "" {
		session.markShellIntegrationUnsupported()
		return false, nil
	}
	return m.installShellIntegration(sessionID, session, shell)
}

func remoteShellSupportsIntegration(client *ssh.Client) bool {
	return remoteShellIntegrationShell(client) != ""
}

func remoteShellIntegrationShell(client *ssh.Client) string {
	if client == nil {
		return ""
	}
	stdout, _, err := sshcmd.RunWithTimeout(client, remoteShellProbeCommand, remoteShellProbeTimeout)
	if err != nil {
		return ""
	}
	return normalizeRemoteShellProbeOutput(stdout)
}

func normalizeRemoteShellProbeOutput(stdout []byte) string {
	for _, field := range strings.Fields(string(stdout)) {
		if shell := autocomplete.NormalizeShellIntegrationShell(field); shell != "" {
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
func (m *Manager) installShellIntegration(sessionID string, session *sessionHandle, shell string) (bool, error) {
	// 접속 때 원격 셸을 이미 물어봤다 — 그 셸 것 하나만 보낸다.
	commands := autocomplete.ShellIntegrationInitLines(shell)
	if len(commands) == 0 {
		session.markShellIntegrationUnsupported()
		return false, nil
	}

	session.shellIntegrationMu.Lock()
	switch session.shellIntegrationState {
	case shellIntegrationInstalled, shellIntegrationUnsupported:
		session.shellIntegrationMu.Unlock()
		return false, nil
	}

	// 걷어낼 echo 는 지금 주입하는 명령이다 — 셸에 따라 스크립트가 다르므로(fish·pwsh) bash 를
	// 가정하면 마커 뒤의 프롬프트 재출력이 화면에 남는다.
	session.handshake.ArmForCommand(true, commands...)
	for _, command := range commands {
		if _, err := session.writeStdin([]byte(command)); err != nil {
			flushed := session.handshake.Flush()
			session.shellIntegrationState = shellIntegrationUnknown
			session.shellIntegrationMu.Unlock()
			if len(flushed) > 0 {
				m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
			}
			return false, err
		}
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

// CancelInFlight 는 아직 붙는 중인 연결을 끊는다(forwarding 과 같은 이유).
func (m *Manager) CancelInFlight(sessionID string) {
	m.dialer.CancelInFlight(sessionID)
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
			// 서브셸 재주입 대기 중이면 raw 출력으로 프롬프트 안착을 감지한다(핸드셰이크
			// 필터 전에 관찰해야 원본 프롬프트를 본다). Arm 전에는 no-op이다.
			handle.reinjectGate.Observe(chunk)
			// 셸 프로브의 답도 필터 전에 본다 — 필터는 이 답을 앵커로 삼아 버퍼를 버리므로
			// 뒤에서 보면 이미 사라지고 없다.
			handle.shellProbe.Observe(chunk)
			// 통합 없는 셸에 들어가 있는 동안에는 프롬프트 마커가 올 리 없다. 그러니 마커가
			// 보이면 그 셸에서 나와 원래 셸로 돌아온 것이다 — 다음 서브셸은 다시 물어봐야 한다.
			// 세션에 영구히 걸어 두었더니 alpine 에 한 번 들어갔다 나온 뒤로는 bash 컨테이너에도
			// 통합이 안 붙고, 바깥 블록도 안 닫혀 계속 열린 채로 남았다.
			if handle.shellIntegrationUnsupported.Load() &&
				bytes.Contains(chunk, []byte(autocomplete.PromptStartMarker)) {
				handle.shellIntegrationUnsupported.Store(false)
			}
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
						Message: neterr.Normalize(err).Error(),
						Failure: neterr.Code(err),
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
	// 아직 붙는 중이면 그 작업부터 끊는다. 이것이 없으면 dial 이 끝날 때까지(타임아웃까지) 종료가
	// 아무 일도 하지 않는 것처럼 보인다. 사람의 답을 기다리는 물음도 함께 접는다.
	m.dialer.CancelInFlight(sessionID)
	m.dialer.CancelChallenges(sessionID)

	// 맵에서 먼저 제거해 중복 종료 요청이 다시 같은 세션을 건드리지 않게 한다.
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()

	if !ok {
		return
	}

	session.closer.Do(func() {
		close(session.closed)
		session.closeCompletionWorker()
		// stdin, session, client를 같은 순서로 정리해 하위 리소스를 남기지 않는다.
		_ = session.closeStdin()
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
