package tmuxsession

import (
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/shellintegration"
	"dolssh/services/ssh-core/internal/sshcmd"
	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/internal/sshdial"
	"dolssh/services/ssh-core/internal/sshsession"
	"dolssh/services/ssh-core/pkg/coretypes"

	"golang.org/x/crypto/ssh"
)

// EventEmitter / StreamEmitter 는 sshsession 과 동일한 시그니처다.
// coretypes.Event 는 protocol.Event 와 동일 타입(alias)이라 runtime 의 emit 콜백을 그대로 받는다.
// 마커가 끝내 오지 않는 셸에서 붙잡고 있던 pane 출력을 놓아주기까지의 시간.
const shellIntegrationFlushDelay = 1500 * time.Millisecond

type EventEmitter func(coretypes.Event)
type StreamEmitter func(coretypes.StreamFrame, []byte)

const sessionPrefix = "tmux:"

// Manager 는 하나의 tmux -CC control 채널 위에 여러 pane 을 가상 sessionId 로 노출한다.
// 가상 sessionId 체계: "tmux:<controlSessionId>:<paneNumber>" (paneNumber 는 tmux pane id "%N" 의 N).
type Manager struct {
	emit       EventEmitter
	emitStream StreamEmitter
	config     sshsession.ManagerConfig
	// dialer 는 연결을 여는 공통 경로다(internal/sshdial).
	//
	// 이것을 쓰면서 tmux 도 대화형 인증을 받는다 — 예전에는 그 자리에서 "not supported" 로
	// 끊어서, OTP 를 요구하는 호스트에는 tmux 로 붙을 수 없었다. 호스트 키 신뢰 질의·서버
	// 배너·취소 가능한 ctx 도 함께 온다.
	dialer *sshdial.Dialer

	mu       sync.RWMutex
	controls map[string]*controlHandle // controlSessionID -> handle
}

type controlHandle struct {
	id      string
	client  *ssh.Client
	session *ssh.Session
	stdin   io.WriteCloser
	stdinMu sync.Mutex
	parser  ControlParser
	// version 은 원격 tmux 버전(major.minor)이다. 입력 인코딩(-H vs -l+키이름)과
	// refresh-client 인자 방언(콤마 vs WxH)을 버전별로 분기하는 데 쓴다. known=false
	// (버전 미상)면 안전 기본=최신 가정(현행 control mode 경로: -H + 콤마).
	version tmuxVersion
	// %begin~%end 블록(명령 응답) 수집 상태. list-windows 응답에서 layout을 추출한다.
	collecting bool
	collected  []string
	// sawControl: control 프로토콜(% notification)이 한 번이라도 시작됐는지. 시작 전에
	// 채널이 닫히면 원격에 tmux 가 없거나(-CC 미지원/명령 없음) 시작 실패로 보고 탭을
	// 조용히 닫는 대신 에러로 표시한다. earlyOutput: 그때 셸이 내놓은 텍스트(예:
	// "tmux: command not found")를 모아 에러 메시지에 싣는다. (둘 다 stream 고루틴
	// 단독 접근 → 락 불필요.)
	sawControl  bool
	earlyOutput []byte
	// 현재 attach 된 tmux 세션명(%session-changed 로 갱신). layout-change payload 에 실어
	// renderer 가 세션 그룹 푸터를 호스트명 대신 세션명으로 그리게 한다(이벤트 순서 무관).
	sessionName string
	closed      chan struct{}
	closer      sync.Once
	// pane(%N)별 OSC 133 핸드셰이크. 셸 통합 init 을 pane 에 주입할 때 그 에코를 마커
	// 도착 전까지 숨긴다(sshsession 과 동일 패턴, pane 단위). nil/미armed 면 pass-through.
	handshakes map[string]*autocomplete.Handshake
	// pane(%N)별 셸 통합 주입 완료 플래그. renderer 는 윈도우 전환(=pane remount)마다
	// InstallShellIntegration 을 다시 호출하므로, 이미 주입한 pane 은 건너뛰어 init
	// 스크립트가 재주입되며 프롬프트가 중복 출력되는 것을 막는다. (reconnect 는 새
	// controlHandle 이라 이 맵도 비어 있어 자동으로 재설치된다.)
	integrated map[string]bool
	// pane(%N)별 서브셸 재주입 게이트. 사용자가 pane 안에서 서브셸(sudo su·docker exec …)로
	// 들어가면 그 셸에는 훅이 없다 — 새 프롬프트가 안착하면 다시 심는다. nil/미armed 면 no-op.
	reinjectGates map[string]*autocomplete.PromptSettleGate
	shellProbes   map[string]*autocomplete.ShellProbe
	handshakesMu  sync.Mutex

	completionPoolMu sync.Mutex
	completionPool   *sshcmd.WorkerPool

	// sudo 는 세션 패널이 도커를 읽으려는데 소켓 권한이 없고 `sudo -n` 도 막혔을 때만 쓴다.
	// sshsession 의 sessionHandle 과 같은 규칙이다 — 비밀번호로 붙은 연결에서만 채우고,
	// stdin 으로만 흘리고(sshcmd.BuildSudoCommand), 한 번 거절당하면 이 연결에서는 다시
	// 내밀지 않는다(틀린 sudo 시도는 pam_faillock 카운터를 올린다).
	sudoMu       sync.Mutex
	sudoPassword string
	sudoDenied   bool
}

// setSudoPassword 는 비밀번호로 붙은 연결에만 되물릴 값을 남긴다.
func (h *controlHandle) setSudoPassword(authType, password string) {
	if authType != "password" || password == "" {
		return
	}
	h.sudoMu.Lock()
	defer h.sudoMu.Unlock()
	h.sudoPassword = password
}

// takeSudoPassword 는 지금 되물릴 수 있는 비밀번호를 준다. 없거나 이미 거절당했으면 빈 값이다.
func (h *controlHandle) takeSudoPassword() string {
	h.sudoMu.Lock()
	defer h.sudoMu.Unlock()
	if h.sudoDenied {
		return ""
	}
	return h.sudoPassword
}

// denySudo 는 되물린 비밀번호가 통하지 않았다고 표시한다.
func (h *controlHandle) denySudo() {
	h.sudoMu.Lock()
	defer h.sudoMu.Unlock()
	h.sudoDenied = true
}

// markIntegrated 는 pane 에 셸 통합 주입을 1회로 제한한다. 아직 주입 안 했으면
// 표시하고 true, 이미 했으면 false 를 돌려준다(재주입=프롬프트 중복 방지).
func (h *controlHandle) markIntegrated(paneID string) bool {
	h.handshakesMu.Lock()
	defer h.handshakesMu.Unlock()
	if h.integrated[paneID] {
		return false
	}
	if h.integrated == nil {
		h.integrated = make(map[string]bool)
	}
	h.integrated[paneID] = true
	return true
}

// armPaneHandshake 는 pane 의 핸드셰이크를 만들고 arm 한다(이후 출력은 OSC 133;A 마커
// 전까지 숨겨진다). init 주입 직전에 호출한다.
func (h *controlHandle) armPaneHandshake(paneID string, commands []string) {
	h.handshakesMu.Lock()
	if h.handshakes == nil {
		h.handshakes = make(map[string]*autocomplete.Handshake)
	}
	hs := h.handshakes[paneID]
	if hs == nil {
		hs = &autocomplete.Handshake{}
		h.handshakes[paneID] = hs
	}
	h.handshakesMu.Unlock()
	// 걷어낼 echo 는 지금 보내는 조각들이다.
	hs.ArmForCommand(false, commands...)
}

// filterPaneOutput 는 pane 출력에 핸드셰이크 필터를 적용한다(없으면 그대로 통과).
func (h *controlHandle) filterPaneOutput(paneID string, data []byte) []byte {
	h.handshakesMu.Lock()
	hs := h.handshakes[paneID]
	h.handshakesMu.Unlock()
	if hs == nil {
		return data
	}
	return hs.Filter(data)
}

// paneReinjectGate 는 pane 의 재주입 게이트를 돌려준다(없으면 만든다).
func (h *controlHandle) paneReinjectGate(paneID string) *autocomplete.PromptSettleGate {
	h.handshakesMu.Lock()
	defer h.handshakesMu.Unlock()
	if h.reinjectGates == nil {
		h.reinjectGates = make(map[string]*autocomplete.PromptSettleGate)
	}
	gate := h.reinjectGates[paneID]
	if gate == nil {
		gate = autocomplete.NewPromptSettleGate(0, 0)
		h.reinjectGates[paneID] = gate
	}
	return gate
}

// paneShellProbe 는 pane 의 "누구냐" 대기자를 돌려준다(없으면 만든다).
func (h *controlHandle) paneShellProbe(paneID string) *autocomplete.ShellProbe {
	h.handshakesMu.Lock()
	defer h.handshakesMu.Unlock()
	if h.shellProbes == nil {
		h.shellProbes = make(map[string]*autocomplete.ShellProbe)
	}
	probe := h.shellProbes[paneID]
	if probe == nil {
		probe = &autocomplete.ShellProbe{}
		h.shellProbes[paneID] = probe
	}
	return probe
}

// observePaneOutput 는 재주입 대기 중인 pane 에 원본 출력을 흘려 프롬프트 안착을 보게 한다.
// 대기 중이 아니면 no-op 이다(필터 **전** 에 봐야 원본 프롬프트를 본다).
func (h *controlHandle) observePaneOutput(paneID string, data []byte) {
	h.handshakesMu.Lock()
	gate := h.reinjectGates[paneID]
	probe := h.shellProbes[paneID]
	h.handshakesMu.Unlock()
	if gate != nil {
		gate.Observe(data)
	}
	// 셸 프로브의 답도 필터 전에 본다 — 필터는 이 답을 앵커로 삼아 버퍼를 버린다.
	if probe != nil {
		probe.Observe(data)
	}
}

// paneHandshake 는 pane 의 핸드셰이크를 반환한다(없으면 nil).
func (h *controlHandle) paneHandshake(paneID string) *autocomplete.Handshake {
	h.handshakesMu.Lock()
	defer h.handshakesMu.Unlock()
	return h.handshakes[paneID]
}

func (h *controlHandle) ensurePaneHandshake(paneID string) *autocomplete.Handshake {
	h.handshakesMu.Lock()
	defer h.handshakesMu.Unlock()
	if h.handshakes == nil {
		h.handshakes = make(map[string]*autocomplete.Handshake)
	}
	hs := h.handshakes[paneID]
	if hs == nil {
		hs = &autocomplete.Handshake{}
		h.handshakes[paneID] = hs
	}
	return hs
}

// tmux -CC는 초기/단순 상태에서 %layout-change를 보내지 않으므로(window-add + output만),
// 연결·window 추가 시 이 명령으로 각 window의 layout을 직접 쿼리해 layout 이벤트를 합성한다.
// window_name 은 공백을 포함할 수 있고 window_visible_layout 은 공백이 없으므로,
// 응답 파싱은 앞 3토큰(id/index/active)과 마지막 토큰(layout)을 고정으로 떼고
// 가운데를 name 으로 본다(parseListWindowsLine).
const listWindowsCommand = "list-windows -F \"#{window_id} #{window_index} #{window_active} #{window_name} #{window_visible_layout}\"\n"
const defaultControlCommand = "if tmux list-sessions >/dev/null 2>&1; then exec tmux -CC attach; else exec tmux -CC new-session -A -s dolgate; fi"

// SetTailnetDial 은 tailnet 경로를 raw dialer 로 바꾸는 함수를 주입한다.
//
// 생성자에서 못 받는 이유: 이 매니저는 테스트가 직접 부르는 런타임 생성자 안에서 만들어지고,
// tailnet 레지스트리는 그 뒤에 붙는다. 그 생성자의 시그니처를 늘리지 않기로 했으므로 세터를
// 쓴다. 다른 서비스들(sftp·containers·forwarding)과 같은 방식이다.
func (m *Manager) SetTailnetDial(resolve sshconn.TailnetDialResolver) {
	m.mu.Lock()
	m.config.TailnetDial = resolve
	m.mu.Unlock()
	// 실제로 dial 하는 것은 dialer 다. 여기만 세우면 tailnet 경로가 반영되지 않는다.
	m.dialer.SetTailnetDial(resolve)
}

func NewManager(emit EventEmitter, stream StreamEmitter) *Manager {
	return NewManagerWithConfig(emit, stream, sshsession.ManagerConfig{})
}

// NewManagerWithConfig 는 keepalive 등 설정을 받아 Manager 를 만든다. 0 값 필드는
// SSH 세션(sshsession)과 동일한 기본값으로 채워, tmux control 채널도 같은 cadence
// (30s probe, 연속 3회 실패)로 죽은 소켓을 감지한다.
func NewManagerWithConfig(emit EventEmitter, stream StreamEmitter, config sshsession.ManagerConfig) *Manager {
	if config.TCPDialTimeout == 0 {
		config.TCPDialTimeout = 10 * time.Second
	}
	if config.TCPKeepAliveInterval == 0 {
		config.TCPKeepAliveInterval = 30 * time.Second
	}
	if config.SSHKeepAliveInterval == 0 {
		config.SSHKeepAliveInterval = 10 * time.Second
	}
	if config.SSHKeepAliveMaxFailures <= 0 {
		config.SSHKeepAliveMaxFailures = 3
	}
	if config.SSHKeepAliveProbeTimeout == 0 {
		config.SSHKeepAliveProbeTimeout = 10 * time.Second
	}
	return &Manager{
		emit:       emit,
		emitStream: stream,
		config:     config,
		dialer:     resolveDialer(emit, config),
		controls:   make(map[string]*controlHandle),
	}
}

// resolveDialer 는 쓸 연결 경로를 고른다(sshsession 과 같은 규칙).
func resolveDialer(emit EventEmitter, config sshsession.ManagerConfig) *sshdial.Dialer {
	if config.Dialer != nil {
		return config.Dialer
	}
	dialer := sshdial.New(emit)
	dialer.SetTailnetDial(config.TailnetDial)
	dialer.SetHostKeyTrustPrompt(config.HostKeyTrustPrompt)
	dialer.SetTimeouts(config.TCPDialTimeout, config.TCPKeepAliveInterval)
	return dialer
}

// paneSessionID 는 control 세션과 tmux pane id("%N")로 가상 sessionId 를 만든다.
func paneSessionID(controlID, paneID string) string {
	return sessionPrefix + controlID + ":" + strings.TrimPrefix(paneID, "%")
}

// parsePaneSessionID 는 가상 sessionId 에서 (controlID, paneID "%N") 를 복원한다.
func parsePaneSessionID(sessionID string) (controlID, paneID string, ok bool) {
	if !strings.HasPrefix(sessionID, sessionPrefix) {
		return "", "", false
	}
	rest := sessionID[len(sessionPrefix):]
	idx := strings.LastIndexByte(rest, ':')
	if idx < 0 {
		return "", "", false
	}
	return rest[:idx], "%" + rest[idx+1:], true
}

// Connect 는 tmux -CC control 채널을 연다. sessionID 는 control 세션 id 다.
func (m *Manager) Connect(sessionID, requestID string, payload coretypes.ConnectPayload) error {
	// 붙는 동안 탭을 닫으면 이 ctx 가 취소돼 dial·핸드셰이크가 즉시 끝난다.
	ctx, release := m.dialer.Begin(sessionID)
	defer release()

	// 연결 조립은 sshdial 한 곳에 있다(터미널 세션·mosh 와 같은 것) — tailnet 경로, 홉 진행 보고,
	// 호스트 키 신뢰 질의, 서버 배너, 대화형 인증이 모두 거기서 붙는다.
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

	cols, rows := payload.Cols, payload.Rows
	if cols <= 0 {
		cols = 120
	}
	if rows <= 0 {
		rows = 32
	}
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := session.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		session.Close()
		client.Close()
		return fmt.Errorf("pty request failed: %w", err)
	}

	command := payload.Command
	if command == "" {
		// 기존 세션이 있으면 그것(가장 최근)에 attach 하고, 없을 때만 'dolgate'를 만든다.
		// 고정 이름으로만 attach 하면 사용자가 rename-session(Ctrl-b $) 으로 이름을 바꿨을 때
		// 재접속 시 옛 이름을 못 찾아 중복 세션이 생긴다. attach 우선이면 이름이 바뀌어도 잇는다.
		// control-mode attach 실패는 "%exit"를 stdout에 남길 수 있어, 세션이 없는 첫 연결에서
		// 탭이 정상 종료처럼 닫힌다. control mode 진입 전 일반 tmux 명령으로 세션 존재만 확인한다.
		command = defaultControlCommand
	}
	if err := session.Start(command); err != nil {
		session.Close()
		client.Close()
		return fmt.Errorf("tmux start failed: %w", err)
	}

	// 입력 인코더/리사이즈 방언이 쓸 tmux 버전. 렌더러가 알려주면(일반 경로: SSH 접속 후
	// 감지된 버전을 전달) 그대로 쓰고, 모르면(예: 홈 화면에서 호스트 우클릭 'tmux로 연결'
	// — 사전 접속/감지가 없어 미상) control 세션의 SSH 클라이언트로 직접 tmux 버전을 조회해
	// 채운다. 이래야 그 진입점에서도 구버전(2.6 등)에 맞는 인코딩(-l)이 적용된다.
	ver := parseTmuxVersion(payload.TmuxVersion)
	if !ver.known {
		if out, _, e := sshcmd.RunWithTimeout(client, sshsession.TmuxDetectCommand, 3*time.Second); e == nil {
			if probed := parseTmuxVersion(sshsession.ParseTmuxDetect(string(out)).Version); probed.known {
				ver = probed
				debugTmux("tmux control %s: 버전 미상 → tmux -V 조회 결과 %d.%d (patch %d)", sessionID, ver.major, ver.minor, ver.patch)
			}
		}
	}
	handle := &controlHandle{
		id:      sessionID,
		client:  client,
		session: session,
		stdin:   stdin,
		closed:  make(chan struct{}),
		version: ver,
	}
	// 도커 조회가 sudo 를 요구하는 호스트에서 되물릴 값. SSH 세션과 같은 조건으로만 남는다.
	handle.setSudoPassword(payload.AuthType, payload.Password)
	m.mu.Lock()
	m.controls[sessionID] = handle
	m.mu.Unlock()

	m.emit(coretypes.Event{
		Type:      coretypes.EventConnected,
		RequestID: requestID,
		SessionID: sessionID,
		Payload:   coretypes.StatusPayload{Status: "connected"},
	})
	go m.stream(handle, stdout)
	if m.config.SSHKeepAliveInterval > 0 {
		// control 채널에도 app-level keepalive 를 돌려 죽은 소켓을 커널 TCP 타임아웃
		// (~100-300s)보다 빨리(~30-90s) 감지한다. 연속 실패 시 reason="keepalive" 로
		// 닫혀 renderer 가 tmux 그룹을 자동 재연결한다(SSH 세션과 동일).
		go m.keepAlive(handle)
	}
	// 초기 layout을 직접 쿼리한다(아래 %begin~%end 응답에서 layout 이벤트 합성).
	_ = handle.writeStdin(listWindowsCommand)
	// 원격 tmux 세션 목록도 1회 조회해 emit(푸터 세션 메뉴 초기 채움). 보조 exec 채널.
	go m.emitSessions(handle)
	return nil
}

func (m *Manager) stream(handle *controlHandle, reader io.Reader) {
	buffer := make([]byte, 4096)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			for _, ev := range handle.parser.Feed(buffer[:n]) {
				if ev.Kind != ControlOther {
					handle.sawControl = true
				} else if !handle.sawControl {
					// tmux 시작 전 셸이 내놓는 텍스트(예: "tmux: command not found")를
					// 모아둔다 — 시작 실패 시 에러 메시지에 싣는다.
					if len(ev.Args) > 0 {
						handle.appendEarlyOutput(ev.Args[0])
					}
				}
				m.handleControlEvent(handle, ev)
			}
		}
		if err != nil {
			if !handle.sawControl {
				// control 프로토콜이 한 번도 시작되지 않고 채널이 닫혔다 — 원격에 tmux 가
				// 없거나(-CC 미지원/명령 없음) 시작에 실패한 것이다. 탭을 조용히 닫는 대신
				// EventError 로 표시해 사용자가 원인(tmux 미설치 등)을 알 수 있게 한다.
				m.failTmuxStart(handle)
				return
			}
			// 정상 종료(%exit)는 ControlExit 이벤트에서 이미 remote-exit 로 닫는다.
			// 여기까지 도달한 read 에러는 %exit 없이 채널이 끊긴 것 — 네트워크 단절
			// 등 비정상 단절이므로 transport 로 분류해 renderer 가 탭을 유지한 채
			// 자동 재연결하게 한다. (EOF 를 remote-exit 로 오인하면 SSH 채널 종료가
			// 정상 종료로 처리되어 tmux 탭이 통째로 제거됐다.)
			m.closeSession(handle.id, "control channel closed", "transport")
			return
		}
	}
}

func (m *Manager) handleControlEvent(handle *controlHandle, ev ControlEvent) {
	switch ev.Kind {
	case ControlBegin:
		handle.collecting = true
		handle.collected = nil
	case ControlEnd, ControlError:
		if ev.Kind == ControlError {
			// %error 는 직전 명령(send-keys/refresh-client 등)이 거부된 것이다. 예전엔
			// 조용히 삼켜 2.6 같은 구버전에서 잘못된 문법(예: -H, WxH)이 실패해도 단서가
			// 없었다. 디버그 로그(DOLGATE_TMUX_DEBUG=1)로 원문을 남겨 진단을 돕는다.
			debugTmux("tmux %%error (control %s): %s", handle.id, strings.Join(ev.Args, " "))
		}
		m.flushCollectedLayouts(handle)
	case ControlOther:
		if handle.collecting && len(ev.Args) > 0 {
			handle.collected = append(handle.collected, ev.Args[0])
		}
	case ControlOutput:
		// 서브셸 재주입을 기다리는 pane 이면 원본 출력으로 프롬프트 안착을 본다(필터 전에).
		handle.observePaneOutput(ev.PaneID, ev.Data)
		// 셸 통합 주입 중이면 그 pane 의 에코를 마커 전까지 숨긴다(없으면 그대로 통과).
		data := handle.filterPaneOutput(ev.PaneID, ev.Data)
		if len(data) > 0 {
			m.emitStream(coretypes.StreamFrame{
				Type:      coretypes.StreamTypeData,
				SessionID: paneSessionID(handle.id, ev.PaneID),
			}, data)
		}
	case ControlLayoutChange:
		m.emit(coretypes.Event{
			Type:      coretypes.EventTmuxLayoutChange,
			SessionID: handle.id,
			Payload: coretypes.TmuxLayoutChangePayload{
				ControlSessionID: handle.id,
				WindowID:         ev.WindowID,
				Layout:           ev.Layout,
				SessionName:      handle.sessionName,
			},
		})
	case ControlWindowAdd:
		m.emitWindow(handle.id, coretypes.EventTmuxWindowAdd, ev.WindowID, "")
		_ = handle.writeStdin(listWindowsCommand)
	case ControlWindowClose:
		m.emitWindow(handle.id, coretypes.EventTmuxWindowClose, ev.WindowID, "")
	case ControlWindowRenamed:
		m.emitWindow(handle.id, coretypes.EventTmuxWindowRenamed, ev.WindowID, ev.Name)
	case ControlSessionChanged:
		// %session-changed $<id> <name>: attach 된 tmux 세션명을 handle 에 기록(이후
		// layout-change payload 에 실린다)하고 renderer 로도 전달해, 세션 그룹 푸터가
		// 호스트명 대신 실제 세션명을 보이게 한다.
		handle.sessionName = ev.Name
		m.emit(coretypes.Event{
			Type:      coretypes.EventTmuxSessionChanged,
			SessionID: handle.id,
			Payload: coretypes.TmuxSessionChangedPayload{
				ControlSessionID: handle.id,
				SessionName:      ev.Name,
			},
		})
	case ControlSessionRenamed:
		// rename-session(Ctrl-b $) → 현재 세션 이름을 즉시 갱신(푸터 라벨)하고 세션 목록도
		// 재조회한다. 이게 없으면 재연결 전까지 옛 이름이 남는다.
		if ev.Name != "" {
			handle.sessionName = ev.Name
			m.emit(coretypes.Event{
				Type:      coretypes.EventTmuxSessionChanged,
				SessionID: handle.id,
				Payload: coretypes.TmuxSessionChangedPayload{
					ControlSessionID: handle.id,
					SessionName:      ev.Name,
				},
			})
		}
		go m.emitSessions(handle)
	case ControlSessionsChanged:
		// 세션 목록 변화(new/kill/rename) → 재조회해 페이로드와 함께 emit(푸터 메뉴 갱신).
		go m.emitSessions(handle)
	case ControlWindowPaneChanged:
		// 서버의 활성 pane 변경 → renderer가 화면 포커스를 따라오게 한다(키보드 pane 이동).
		m.emitPane(handle.id, coretypes.EventTmuxActivePaneChanged, ev.PaneID)
	case ControlPause:
		m.emitPane(handle.id, coretypes.EventTmuxPaused, ev.PaneID)
	case ControlContinue:
		m.emitPane(handle.id, coretypes.EventTmuxContinue, ev.PaneID)
	case ControlExit:
		m.emit(coretypes.Event{
			Type:      coretypes.EventTmuxExit,
			SessionID: handle.id,
			Payload:   coretypes.TmuxExitPayload{ControlSessionID: handle.id, Reason: ev.Name},
		})
		m.closeSession(handle.id, "tmux exited", "remote-exit")
	}
}

func (m *Manager) emitWindow(controlID string, kind coretypes.EventType, windowID, name string) {
	m.emit(coretypes.Event{
		Type:      kind,
		SessionID: controlID,
		Payload:   coretypes.TmuxWindowPayload{ControlSessionID: controlID, WindowID: windowID, Name: name},
	})
}

func (m *Manager) emitPane(controlID string, kind coretypes.EventType, paneID string) {
	m.emit(coretypes.Event{
		Type:      kind,
		SessionID: controlID,
		Payload:   coretypes.TmuxPanePayload{ControlSessionID: controlID, PaneID: paneID},
	})
}

// WriteBytes 는 가상 pane sessionId 로 들어온 입력을 send-keys -H(hex) 로 변환해
// control 채널 stdin 에 기록한다.
func (m *Manager) WriteBytes(sessionID string, data []byte) error {
	controlID, paneID, ok := parsePaneSessionID(sessionID)
	if !ok {
		// control 세션 id 자체로 들어온 raw 입력은 의미가 없다(입력은 pane 으로
		// send-keys 한다). 흡수 직전 control 터미널/자동완성이 보낸 stray write 가
		// 여기로 오는데, 에러를 내면 그 에러가 세션 'error' 이벤트가 되어 control
		// 세션 탭이 죽고 → isTmuxControlConnected=false → 모든 pane 입력이 영구히
		// 막힌다(IDC 서버 freeze 의 근본 원인). 알려진 control 세션이면 조용히 무시.
		if m.getControl(sessionID) != nil {
			return nil
		}
		return fmt.Errorf("not a tmux pane session: %s", sessionID)
	}
	handle := m.getControl(controlID)
	if handle == nil {
		return fmt.Errorf("tmux control session not found: %s", controlID)
	}
	// 버전별 입력 인코딩: 신버전(>=3.1)은 send-keys -H(hex) 한 줄, 구버전(2.6~3.0)은
	// 출력가능 런(-l 리터럴) + 제어바이트(키이름)로 분해한 여러 줄(순서 보존).
	for _, cmd := range encodeInput(paneID, data, handle.version) {
		if err := handle.writeStdin(cmd); err != nil {
			return err
		}
	}
	return nil
}

// controlOf 는 가상 pane sessionId(또는 control sessionId)에서 control 채널 핸들과
// pane id(%N; control sessionId 만 주면 빈 문자열)를 찾는다.
func (m *Manager) controlOf(sessionID string) (*controlHandle, string, error) {
	controlID, paneID, ok := parsePaneSessionID(sessionID)
	if !ok {
		controlID = sessionID
	}
	handle := m.getControl(controlID)
	if handle == nil {
		return nil, "", fmt.Errorf("tmux control session not found: %s", controlID)
	}
	return handle, paneID, nil
}

// SplitPane 은 현재 pane 을 분할한다(direction "h": 좌우, "v": 상하). 결과는 control
// 채널이 %layout-change 로 알려와 renderer 의 workspace 분할에 반영된다.
func (m *Manager) SplitPane(sessionID, direction string) error {
	handle, paneID, err := m.controlOf(sessionID)
	if err != nil {
		return err
	}
	if paneID == "" {
		return fmt.Errorf("not a tmux pane session: %s", sessionID)
	}
	if direction != "h" && direction != "v" {
		direction = "h"
	}
	return handle.writeStdin(fmt.Sprintf("split-window -%s -t %s\n", direction, paneID))
}

// NewWindow 는 새 tmux window 를 만든다(새 탭으로 반영된다).
func (m *Manager) NewWindow(sessionID string) error {
	handle, _, err := m.controlOf(sessionID)
	if err != nil {
		return err
	}
	return handle.writeStdin("new-window\n")
}

// SelectWindow 는 windowID(@N) 로 활성 window 를 바꾼다.
func (m *Manager) SelectWindow(sessionID, windowID string) error {
	handle, _, err := m.controlOf(sessionID)
	if err != nil {
		return err
	}
	if windowID == "" {
		return fmt.Errorf("empty window id")
	}
	return handle.writeStdin(fmt.Sprintf("select-window -t %s\n", windowID))
}

// SelectPane 은 paneID(%N) 로 활성 pane 을 바꾼다.
func (m *Manager) SelectPane(sessionID string) error {
	handle, paneID, err := m.controlOf(sessionID)
	if err != nil {
		return err
	}
	if paneID == "" {
		return fmt.Errorf("not a tmux pane session: %s", sessionID)
	}
	return handle.writeStdin(fmt.Sprintf("select-pane -t %s\n", paneID))
}

// RefreshSessionsCommand 는 ControlCommand 로 들어오면 control 채널에 쓰지 않고 세션 목록을
// 즉시 재조회(emitSessions)하는 특수 신호다. 렌더러도 같은 문자열을 보낸다(terminal.ts).
const RefreshSessionsCommand = "__dolssh_refresh_sessions__"

// ControlCommand 은 renderer 키맵이 만든 tmux 명령(예: "select-pane -L -t %0")을
// control 채널로 그대로 보낸다. 단축키 확장용 범용 통로이며, 명령 문자열은 렌더러의
// 고정 키맵에서만 생성된다(사용자 입력 아님). 대상(-t)은 렌더러가 포함해 보낸다.
func (m *Manager) ControlCommand(sessionID, command string) error {
	handle, _, err := m.controlOf(sessionID)
	if err != nil {
		return err
	}
	// 세션 목록 즉시 재조회 신호(드롭다운 열 때). %sessions-changed 가 다른 SSH 연결에서
	// 만든 세션엔 도착 안 하는 경우가 있어, 명시적으로 SSH 보조채널로 재pull 한다.
	if strings.TrimSpace(command) == RefreshSessionsCommand {
		go m.emitSessions(handle)
		return nil
	}
	command = strings.TrimRight(command, "\r\n")
	if command == "" {
		return nil
	}
	return handle.writeStdin(command + "\n")
}

// KillPane 은 paneID(%N) 를 종료한다(마지막 pane 이면 window 가 닫힌다).
func (m *Manager) KillPane(sessionID string) error {
	handle, paneID, err := m.controlOf(sessionID)
	if err != nil {
		return err
	}
	if paneID == "" {
		return fmt.Errorf("not a tmux pane session: %s", sessionID)
	}
	return handle.writeStdin(fmt.Sprintf("kill-pane -t %s\n", paneID))
}

// KillWindow 는 windowID(@N) window 만 종료한다. control 세션·타 window 는 생존한다
// (pane 단위 kill-pane 와 달리 "이 window 닫기" 의도를 정확히 표현).
func (m *Manager) KillWindow(sessionID, windowID string) error {
	handle, _, err := m.controlOf(sessionID)
	if err != nil {
		return err
	}
	if windowID == "" {
		return fmt.Errorf("empty window id")
	}
	return handle.writeStdin(fmt.Sprintf("kill-window -t %s\n", windowID))
}

// KillSession 은 이름으로 tmux 세션 전체를 종료한다(kill-session -t <name>). 세션은
// 서버 단위라 control 채널 어느 pane 에서 보내도 동작한다. 현재 attach 중인 세션을
// 죽이면 control 채널이 끊겨 그룹이 닫힌다. 이름 escape 는 RenameWindow 와 동일.
func (m *Manager) KillSession(sessionID, sessionName string) error {
	handle, _, err := m.controlOf(sessionID)
	if err != nil {
		return err
	}
	if sessionName == "" {
		return fmt.Errorf("empty session name")
	}
	quoted := "'" + strings.ReplaceAll(sessionName, "'", `'\''`) + "'"
	return handle.writeStdin(fmt.Sprintf("kill-session -t %s\n", quoted))
}

// emitSessions 는 control 세션의 SSH client(보조 exec 채널)로 원격 tmux 세션 목록을
// 조회해 EventTmuxSessionsChanged 로 emit 한다(SSH 감지와 동일 명령/파서 재사용).
// RunWithTimeout 이 최대 3초 블로킹하므로 호출부는 goroutine 으로 돌린다.
func (m *Manager) emitSessions(handle *controlHandle) {
	stdout, _, _ := sshcmd.RunWithTimeout(handle.client, sshsession.TmuxDetectCommand, 3*time.Second)
	payload := sshsession.ParseTmuxDetect(string(stdout))
	if payload.Version == "" {
		return
	}
	m.emit(coretypes.Event{
		Type:      coretypes.EventTmuxSessionsChanged,
		SessionID: handle.id,
		Payload:   payload,
	})
}

// RenameWindow 는 windowID(@N) window 의 이름을 바꾼다(rename-window). 이름에 공백/
// 특수문자가 있을 수 있어 single-quote 로 감싸 escape 한다.
func (m *Manager) RenameWindow(sessionID, windowID, name string) error {
	handle, _, err := m.controlOf(sessionID)
	if err != nil {
		return err
	}
	if windowID == "" {
		return fmt.Errorf("empty window id")
	}
	quoted := "'" + strings.ReplaceAll(name, "'", `'\''`) + "'"
	return handle.writeStdin(
		fmt.Sprintf("rename-window -t %s %s\n", windowID, quoted),
	)
}

// Detach 는 detach-client 로 서버 tmux 세션은 살린 채 control 채널만 분리한다.
func (m *Manager) Detach(sessionID string) error {
	controlID, _, ok := parsePaneSessionID(sessionID)
	if !ok {
		controlID = sessionID
	}
	handle := m.getControl(controlID)
	if handle == nil {
		return fmt.Errorf("tmux control session not found: %s", controlID)
	}
	// detach-client 후 control mode 는 %exit 로 채널을 닫는다. 명시적으로도 정리한다.
	_ = handle.writeStdin("detach-client\n")
	m.closeSession(controlID, "detached by client", "client")
	return nil
}

func (m *Manager) Resize(sessionID string, cols, rows int) error {
	controlID, _, ok := parsePaneSessionID(sessionID)
	if !ok {
		controlID = sessionID
	}
	handle := m.getControl(controlID)
	if handle == nil {
		return fmt.Errorf("tmux control session not found: %s", controlID)
	}
	if cols <= 0 {
		cols = 120
	}
	if rows <= 0 {
		rows = 32
	}
	return handle.writeStdin(refreshClientCommand(cols, rows))
}

// refreshClientCommand 은 refresh-client -C 사이즈 명령을 만든다. 콤마 "W,H" 는 tmux
// 2.6 이전부터 모든 버전이 받는 원래 형식이고 WxH 는 2.9 에서 추가된 것일 뿐이므로,
// 콤마를 항상 쓴다 — 2.6 호환 + 기존(콤마) 동작 무회귀. 끝에 "\n" 포함.
func refreshClientCommand(cols, rows int) string {
	return fmt.Sprintf("refresh-client -C %d,%d\n", cols, rows)
}

func (m *Manager) Disconnect(sessionID string) error {
	controlID, _, ok := parsePaneSessionID(sessionID)
	if !ok {
		controlID = sessionID
	}
	m.closeSession(controlID, "client requested disconnect", "client")
	return nil
}

func (m *Manager) HasSession(sessionID string) bool {
	controlID, _, ok := parsePaneSessionID(sessionID)
	if !ok {
		controlID = sessionID
	}
	return m.getControl(controlID) != nil
}

func (m *Manager) getControl(controlID string) *controlHandle {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.controls[controlID]
}

// detachControl 은 맵에서 핸들을 제거하고 채널/세션/클라이언트를 1회 정리한다.
// 이미 제거됐으면 nil 을 반환한다(중복 종료 no-op). 이벤트는 호출부가 emit 한다.
func (m *Manager) detachControl(controlID string) *controlHandle {
	m.mu.Lock()
	handle := m.controls[controlID]
	if handle != nil {
		delete(m.controls, controlID)
	}
	m.mu.Unlock()
	if handle == nil {
		return nil
	}
	handle.closer.Do(func() {
		close(handle.closed)
		handle.closeCompletionWorker()
		if handle.stdin != nil {
			_ = handle.stdin.Close()
		}
		if handle.session != nil {
			_ = handle.session.Close()
		}
		if handle.client != nil {
			_ = handle.client.Close()
		}
	})
	return handle
}

func (m *Manager) closeSession(controlID, message, reason string) {
	// 아직 붙는 중이면 그 작업부터 끊고, 기다리던 물음도 접는다.
	//
	// 아래 detachControl 은 **핸들이 등록된 뒤에만** 뭔가를 한다. 붙는 중에는 핸들이 없어서
	// 예전에는 여기서 그냥 돌아갔고, 그동안 dial 은 계속 돌았다 — 탭을 닫아도 연결이 백그라운드에
	// 남는 그 상태다(sshsession 과 같은 이유).
	m.dialer.CancelInFlight(controlID)
	m.dialer.CancelChallenges(controlID)

	if m.detachControl(controlID) == nil {
		return
	}
	m.emit(coretypes.Event{
		Type:      coretypes.EventClosed,
		SessionID: controlID,
		Payload:   coretypes.ClosedPayload{Message: message, Reason: reason},
	})
}

// failTmuxStart 는 control 프로토콜이 시작되기 전에 채널이 닫혔을 때(=원격 tmux 부재/
// 시작 실패) 호출된다. closeSession(EventClosed) 대신 EventError 를 emit 해 renderer 가
// 탭을 제거하지 않고 에러 상태로 유지하게 한다. 메시지는 자동 재연결 분류기에서
// transient 로 잡히지 않으므로(=재연결 루프 없음) 사용자가 수동으로 다시 시도한다.
func (m *Manager) failTmuxStart(handle *controlHandle) {
	if m.detachControl(handle.id) == nil {
		return
	}
	msg := "원격 호스트에서 tmux 제어 모드를 시작하지 못했습니다. tmux 가 설치되어 있는지 확인하세요."
	if detail := strings.TrimSpace(string(handle.earlyOutput)); detail != "" {
		msg += " (" + detail + ")"
	}
	m.emit(coretypes.Event{
		Type:      coretypes.EventError,
		SessionID: handle.id,
		Payload:   coretypes.ErrorPayload{Message: msg},
	})
}

// appendEarlyOutput 은 control 프로토콜 시작 전 셸 출력 줄을 에러 메시지용으로 모은다
// (과도 누적 방지 위해 상한). stream 고루틴 단독 접근.
func (h *controlHandle) appendEarlyOutput(line string) {
	line = strings.TrimSpace(line)
	if line == "" || len(h.earlyOutput) >= 512 {
		return
	}
	if len(h.earlyOutput) > 0 {
		h.earlyOutput = append(h.earlyOutput, ' ')
	}
	h.earlyOutput = append(h.earlyOutput, line...)
}

// keepAlive 는 control 채널 위에서 주기적으로 probe 를 보내 죽은 소켓을 감지한다
// (sshsession.keepAlive 와 동일 로직, controlHandle 단위). 단발 블립으로 멀쩡한
// 세션을 죽이지 않도록 연속 실패가 임계값에 도달해야 reason="keepalive" 로 닫는다.
func (m *Manager) keepAlive(handle *controlHandle) {
	ticker := time.NewTicker(m.config.SSHKeepAliveInterval)
	defer ticker.Stop()

	consecutiveFailures := 0
	for {
		select {
		case <-handle.closed:
			return
		case <-ticker.C:
			if rtt, ok := m.sendKeepAliveProbe(handle); ok {
				consecutiveFailures = 0
				// probe round-trip 을 탭 인디게이터용 RTT 로 보고(handle.id=controlSessionId).
				// 렌더러가 controlSessionId 로 tmux 그룹을 찾아 표시한다. rtt==0 은 종료 센티넬.
				if rtt > 0 {
					m.emit(coretypes.Event{
						Type:      coretypes.EventLatency,
						SessionID: handle.id,
						Payload:   coretypes.LatencyPayload{RoundTripMs: int(rtt.Milliseconds())},
					})
				}
				continue
			}
			consecutiveFailures++
			if consecutiveFailures >= m.config.SSHKeepAliveMaxFailures {
				m.closeSession(
					handle.id,
					fmt.Sprintf("tmux keepalive failed after %d attempts", consecutiveFailures),
					"keepalive",
				)
				return
			}
		}
	}
}

// sendKeepAliveProbe 는 probe 한 번을 보내고 타임아웃 내 round-trip 성공 여부를 반환한다.
// SendRequest 를 고루틴으로 감싸 커널 TCP 타임아웃에 끌려가지 않고 간격 기반으로 감지한다.
func (m *Manager) sendKeepAliveProbe(handle *controlHandle) (time.Duration, bool) {
	start := time.Now()
	resultCh := make(chan error, 1)
	go func() {
		_, _, err := handle.client.SendRequest("keepalive@openssh.com", true, nil)
		resultCh <- err
	}()
	select {
	case err := <-resultCh:
		return time.Since(start), err == nil
	case <-time.After(m.config.SSHKeepAliveProbeTimeout):
		return 0, false
	case <-handle.closed:
		// 종료 중이면 실패로 치지 않는다(곧 keepAlive 루프가 빠져나간다). rtt=0 센티넬.
		return 0, true
	}
}

// --- sshSessionManager 인터페이스의 나머지(tmux 에서는 미지원/무의미) ---

func (m *Manager) RespondKeyboardInteractive(sessionID, challengeID string, responses []string) error {
	return fmt.Errorf("keyboard-interactive not supported for tmux control mode")
}

// CollectAutocomplete 는 control 세션의 SSH client 로 보조 exec 채널에서 history+PATH
// 스냅샷을 회수한다(sshsession 과 동일 패턴). 인터랙티브 control 채널 무영향. pane 별
// cwd 는 반영하지 않는 control 세션 단위 스냅샷이다.
func (m *Manager) CollectAutocomplete(sessionID string, revision int) (autocomplete.Result, error) {
	handle, _, err := m.controlOf(sessionID)
	if err != nil {
		return autocomplete.Unsupported(), nil
	}
	stdout, _, err := sshcmd.RunWithTimeout(
		handle.client,
		autocomplete.RemoteSnapshotCommand(),
		3*time.Second,
	)
	if err != nil {
		return autocomplete.Degraded("", "metadata-unavailable"), nil
	}
	return autocomplete.ParseSnapshot(stdout, revision), nil
}

// ReinjectShellIntegration 는 pane 안에서 서브셸(sudo su·docker exec·중첩 ssh)로 들어간 뒤
// 통합을 다시 심는다. pane 은 생성 시 1회만 주입했으므로 그 서브셸에는 훅이 없었다 — 명령 상태와
// cwd 가 그대로 굳는다.
//
// 바로 쓰지 않는다. 아직 연결·인증 중인 셸에 쓰면 입력이 망가지므로, 새 프롬프트가 안착할 때까지
// 기다렸다가(pane 별 게이트) 그때 echo 억제를 무장하고 send-keys 로 보낸다. 프롬프트가 끝내 오지
// 않으면(비대화형 프로그램 등) 아무것도 하지 않는다 — 손대지 않는 편이 안전하다.
//
// shell 은 렌더러가 실행된 명령에서 알아낸 셸 이름이다(모르면 빈 문자열).
func (m *Manager) ReinjectShellIntegration(sessionID string, shell string) error {
	handle, paneID, err := m.controlOf(sessionID)
	if err != nil {
		return err
	}
	if paneID == "" {
		return nil // pane 세션이 아니면 할 일 없음
	}
	// 셸을 모르면 프로브 한 줄로 먼저 묻는다. 예전에는 겸용 스크립트를 보냈고, 그것이 여러 줄이라
	// dash·busybox pane 에서 화면에 그대로 남았다. 기다림·판정은 다른 전송과 같은 절차다.
	shellintegration.ArmReinject(shellintegration.ReinjectTarget{
		Gate:      handle.paneReinjectGate(paneID),
		ShellHint: shell,
		Inject: func(resolved string) {
			m.writePaneShellIntegration(
				sessionID,
				handle,
				paneID,
				autocomplete.ShellIntegrationInitLines(resolved),
			)
		},
		Probe: func() { m.probePaneShellThenInject(sessionID, handle, paneID) },
	})
	return nil
}

// probePaneShellThenInject 는 pane 에 "누구냐" 한 줄을 보내고, 답이 오면 그 셸 것만 넣는다.
func (m *Manager) probePaneShellThenInject(
	sessionID string,
	handle *controlHandle,
	paneID string,
) {
	command := autocomplete.ShellProbeCommand()
	_ = shellintegration.ProbeShellThenInject(shellintegration.ProbeTarget{
		Probe:        handle.paneShellProbe(paneID),
		Handshake:    handle.ensurePaneHandshake(paneID),
		ProbeCommand: command,
		Write: func(data []byte) error {
			for _, cmd := range encodeInput(paneID, data, handle.version) {
				if err := handle.writeStdin(cmd); err != nil {
					return err
				}
			}
			return nil
		},
		Emit: func(data []byte) {
			m.emitStream(coretypes.StreamFrame{
				Type: coretypes.StreamTypeData, SessionID: sessionID,
			}, data)
		},
		OnUnsupported: func() {
			// dash·busybox 등. 넣을 것이 없다.
			// 실행 중으로 남을 명령 블록을 닫는다(CommandFinishedMarker 주석 참고).
			m.emitStream(coretypes.StreamFrame{
				Type:      coretypes.StreamTypeData,
				SessionID: sessionID,
			}, []byte(autocomplete.CommandFinishedMarker))
		},
		OnShell: func(shell string) {
			normalized := shellintegration.NormalizeRemoteShell(shell)
			if normalized == "" {
				m.emitStream(coretypes.StreamFrame{
					Type:      coretypes.StreamTypeData,
					SessionID: sessionID,
				}, []byte(autocomplete.CommandFinishedMarker))
				return
			}
			m.writePaneShellIntegration(sessionID, handle, paneID, autocomplete.ShellIntegrationInitLines(normalized))
		},
		Done:    handle.closed,
		Timeout: shellIntegrationFlushDelay,
	})
}

// writePaneShellIntegration 는 echo 억제를 무장하고 pane 에 주입 줄들을 보낸다.
//
// 로컬·SSH 재주입과 달리 여기서는 앞 프롬프트 줄을 지우지 않는다(`\r\x1b[2K`). pane 화면은
// tmux 가 자기 버퍼로 들고 있어서, 우리가 스트림에 지우기를 끼워 넣으면 렌더러 화면만 바뀌고
// tmux 가 다시 그릴 때(창 전환 등) 되살아난다 — 두 화면이 어긋나느니 프롬프트가 한 번 더 남는
// 편이 낫다.
func (m *Manager) writePaneShellIntegration(
	sessionID string,
	handle *controlHandle,
	paneID string,
	commands []string,
) {
	handle.armPaneHandshake(paneID, commands)
	for _, command := range commands {
		for _, cmd := range encodeInput(paneID, []byte(command), handle.version) {
			if err := handle.writeStdin(cmd); err != nil {
				m.flushPaneShellIntegration(sessionID, handle, paneID)
				return
			}
		}
	}
	// 마커가 끝내 안 오면(느린/비호환 셸) 붙잡고 있던 출력을 놓아준다.
	go func() {
		time.Sleep(shellIntegrationFlushDelay)
		m.flushPaneShellIntegration(sessionID, handle, paneID)
	}()
}

func (m *Manager) flushPaneShellIntegration(sessionID string, handle *controlHandle, paneID string) {
	hs := handle.paneHandshake(paneID)
	if hs == nil {
		return
	}
	if flushed := hs.Flush(); len(flushed) > 0 {
		m.emitStream(coretypes.StreamFrame{
			Type:      coretypes.StreamTypeData,
			SessionID: sessionID,
		}, flushed)
	}
}

// InstallShellIntegration 는 pane 의 셸에 OSC 133/7 통합 스크립트를 send-keys 로 주입해
// pane 안에서도 자동완성/프롬프트 인식이 동작하게 한다(control mode pane 은 가상 세션이라
// 기존엔 no-op 이었다). 주입 명령의 에코는 pane 별 핸드셰이크로 마커 전까지 숨긴다.
func (m *Manager) InstallShellIntegration(sessionID string) error {
	handle, paneID, err := m.controlOf(sessionID)
	if err != nil {
		return err
	}
	if paneID == "" {
		return nil // pane 세션이 아니면 할 일 없음
	}
	// 이미 이 pane 에 셸 통합을 주입했으면 재주입하지 않는다(윈도우 전환 시 renderer
	// remount 가 매번 호출 → 재주입 시 init 스크립트가 다시 실행되며 프롬프트가 중복 출력).
	if !handle.markIntegrated(paneID) {
		return nil
	}
	// pane 의 셸은 알 수 없다(원격 호스트의 기본 셸을 tmux 가 띄운다) — 먼저 한 줄로 묻고,
	// 답이 온 셸 것만 보낸다. 예전에는 bash·zsh 겸용을 여러 줄로 보냈고 dash pane 이 더러워졌다.
	m.probePaneShellThenInject(sessionID, handle, paneID)
	return nil
}

func (m *Manager) FlushShellIntegration(sessionID string) {
	handle, paneID, err := m.controlOf(sessionID)
	if err != nil || paneID == "" {
		return
	}
	if hs := handle.paneHandshake(paneID); hs != nil {
		if flushed := hs.Flush(); len(flushed) > 0 {
			m.emitStream(coretypes.StreamFrame{
				Type:      coretypes.StreamTypeData,
				SessionID: sessionID,
			}, flushed)
		}
	}
}

// RunCompletionCommand 는 보조 exec 채널에서 짧은 read-only 완성 명령을 실행한다.
//
// 실행 경로는 SSH 세션과 **같은 함수**다(autocomplete.RunCompletion) — 예전에는 이 파일에 같은
// 코드가 따로 있었고, 그러다 sudo 되물리기가 SSH 쪽에만 들어가 같은 세션 패널이 SSH 탭에서는
// 도커를 읽고 tmux 탭에서는 못 읽었다.
//
// 보조 채널 기본 cwd(홈) 기준이라 pane 이 cd 한 실제 경로는 반영하지 못한다(MVP 한계).
func (m *Manager) RunCompletionCommand(
	sessionID, command string,
	background, elevate bool,
) (string, bool, error) {
	handle, _, err := m.controlOf(sessionID)
	if err != nil {
		return "", false, err
	}
	return autocomplete.RunCompletion(
		autocomplete.PoolTarget(
			handle.getCompletionPool(),
			handle.client,
			// 비밀번호로 붙은 연결만 되물릴 값을 갖는다. 한 번 거절당한 뒤에는 빈 값이 온다.
			handle.takeSudoPassword,
			handle.denySudo,
		),
		command,
		background,
		elevate,
	)
}

func (h *controlHandle) getCompletionPool() *sshcmd.WorkerPool {
	h.completionPoolMu.Lock()
	defer h.completionPoolMu.Unlock()
	if h.completionPool == nil {
		h.completionPool = sshcmd.NewWorkerPool(h.client)
	}
	return h.completionPool
}

func (h *controlHandle) closeCompletionWorker() {
	h.completionPoolMu.Lock()
	pool := h.completionPool
	h.completionPool = nil
	h.completionPoolMu.Unlock()
	if pool != nil {
		_ = pool.Close()
	}
}

// hexBytes 는 send-keys -H 가 받는 공백 구분 hex 문자열로 변환한다.
func hexBytes(data []byte) string {
	if len(data) == 0 {
		return ""
	}
	parts := make([]string, len(data))
	for i, b := range data {
		parts[i] = fmt.Sprintf("%02x", b)
	}
	return strings.Join(parts, " ")
}

func (h *controlHandle) writeStdin(s string) error {
	h.stdinMu.Lock()
	defer h.stdinMu.Unlock()
	_, err := h.stdin.Write([]byte(s))
	return err
}

// flushCollectedLayouts 는 list-windows 응답(%begin~%end 사이)에서 모은 "@id <layout>"
// 라인을 layout 이벤트로 변환해 emit 한다.
func (m *Manager) flushCollectedLayouts(handle *controlHandle) {
	if !handle.collecting {
		return
	}
	handle.collecting = false
	for _, line := range handle.collected {
		win, ok := parseListWindowsLine(line)
		if !ok {
			continue
		}
		windowIndex := win.index // 포인터로 전달해 index 0 이 omitempty 로 누락되지 않게.
		m.emit(coretypes.Event{
			Type:      coretypes.EventTmuxLayoutChange,
			SessionID: handle.id,
			Payload: coretypes.TmuxLayoutChangePayload{
				ControlSessionID: handle.id,
				WindowID:         win.id,
				Layout:           win.layout,
				Index:            &windowIndex,
				Name:             win.name,
				Active:           win.active,
				SessionName:      handle.sessionName,
			},
		})
	}
	handle.collected = nil
}

type listWindowsRow struct {
	id     string
	index  int
	active bool
	name   string
	layout string
}

// parseListWindowsLine 은 "@id index active name... layout" 형식 한 줄을 파싱한다.
// name 은 공백을 포함할 수 있고 layout 은 공백이 없으므로, 앞 3토큰을 SplitN 으로 떼고
// 나머지에서 마지막 공백 뒤를 layout, 그 앞을 name 으로 본다(name 이 비어도 안전).
func parseListWindowsLine(line string) (listWindowsRow, bool) {
	parts := strings.SplitN(strings.TrimSpace(line), " ", 4)
	if len(parts) < 4 {
		return listWindowsRow{}, false
	}
	id := parts[0]
	if !strings.HasPrefix(id, "@") {
		return listWindowsRow{}, false
	}
	index, _ := strconv.Atoi(parts[1])
	active := parts[2] == "1"
	rest := parts[3]
	var name, layout string
	if sp := strings.LastIndex(rest, " "); sp >= 0 {
		name = rest[:sp]
		layout = rest[sp+1:]
	} else {
		layout = rest
	}
	if layout == "" {
		return listWindowsRow{}, false
	}
	return listWindowsRow{id: id, index: index, active: active, name: name, layout: layout}, true
}
