package tmuxsession

import (
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/sshcmd"
	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/internal/sshsession"
	"dolssh/services/ssh-core/pkg/coretypes"

	"golang.org/x/crypto/ssh"
)

// EventEmitter / StreamEmitter 는 sshsession 과 동일한 시그니처다.
// coretypes.Event 는 protocol.Event 와 동일 타입(alias)이라 runtime 의 emit 콜백을 그대로 받는다.
type EventEmitter func(coretypes.Event)
type StreamEmitter func(coretypes.StreamFrame, []byte)

const sessionPrefix = "tmux:"

// Manager 는 하나의 tmux -CC control 채널 위에 여러 pane 을 가상 sessionId 로 노출한다.
// 가상 sessionId 체계: "tmux:<controlSessionId>:<paneNumber>" (paneNumber 는 tmux pane id "%N" 의 N).
type Manager struct {
	emit       EventEmitter
	emitStream StreamEmitter

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
	// %begin~%end 블록(명령 응답) 수집 상태. list-windows 응답에서 layout을 추출한다.
	collecting bool
	collected  []string
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
	integrated   map[string]bool
	handshakesMu sync.Mutex
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
func (h *controlHandle) armPaneHandshake(paneID string) {
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
	hs.Arm()
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

// paneHandshake 는 pane 의 핸드셰이크를 반환한다(없으면 nil).
func (h *controlHandle) paneHandshake(paneID string) *autocomplete.Handshake {
	h.handshakesMu.Lock()
	defer h.handshakesMu.Unlock()
	return h.handshakes[paneID]
}

// tmux -CC는 초기/단순 상태에서 %layout-change를 보내지 않으므로(window-add + output만),
// 연결·window 추가 시 이 명령으로 각 window의 layout을 직접 쿼리해 layout 이벤트를 합성한다.
// window_name 은 공백을 포함할 수 있고 window_visible_layout 은 공백이 없으므로,
// 응답 파싱은 앞 3토큰(id/index/active)과 마지막 토큰(layout)을 고정으로 떼고
// 가운데를 name 으로 본다(parseListWindowsLine).
const listWindowsCommand = "list-windows -F \"#{window_id} #{window_index} #{window_active} #{window_name} #{window_visible_layout}\"\n"

func NewManager(emit EventEmitter, stream StreamEmitter) *Manager {
	return &Manager{
		emit:       emit,
		emitStream: stream,
		controls:   make(map[string]*controlHandle),
	}
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
	}, sshconn.Config{}, func(sshconn.InteractiveChallenge) ([]string, error) {
		return nil, fmt.Errorf("keyboard-interactive not supported for tmux control mode")
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
		command = "tmux -CC attach 2>/dev/null || tmux -CC new-session -A -s dolgate"
	}
	if err := session.Start(command); err != nil {
		session.Close()
		client.Close()
		return fmt.Errorf("tmux start failed: %w", err)
	}

	handle := &controlHandle{
		id:      sessionID,
		client:  client,
		session: session,
		stdin:   stdin,
		closed:  make(chan struct{}),
	}
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
				m.handleControlEvent(handle, ev)
			}
		}
		if err != nil {
			reason := "transport"
			if err == io.EOF {
				reason = "remote-exit"
			}
			m.closeSession(handle.id, "control channel closed", reason)
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
		m.flushCollectedLayouts(handle)
	case ControlOther:
		if handle.collecting && len(ev.Args) > 0 {
			handle.collected = append(handle.collected, ev.Args[0])
		}
	case ControlOutput:
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
	cmd := fmt.Sprintf("send-keys -t %s -H %s\n", paneID, hexBytes(data))
	return handle.writeStdin(cmd)
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

// ControlCommand 은 renderer 키맵이 만든 tmux 명령(예: "select-pane -L -t %0")을
// control 채널로 그대로 보낸다. 단축키 확장용 범용 통로이며, 명령 문자열은 렌더러의
// 고정 키맵에서만 생성된다(사용자 입력 아님). 대상(-t)은 렌더러가 포함해 보낸다.
func (m *Manager) ControlCommand(sessionID, command string) error {
	handle, _, err := m.controlOf(sessionID)
	if err != nil {
		return err
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
	cmd := fmt.Sprintf("refresh-client -C %d,%d\n", cols, rows)
	return handle.writeStdin(cmd)
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

func (m *Manager) closeSession(controlID, message, reason string) {
	m.mu.Lock()
	handle := m.controls[controlID]
	if handle != nil {
		delete(m.controls, controlID)
	}
	m.mu.Unlock()
	if handle == nil {
		return
	}
	handle.closer.Do(func() {
		close(handle.closed)
		_ = handle.stdin.Close()
		_ = handle.session.Close()
		_ = handle.client.Close()
	})
	m.emit(coretypes.Event{
		Type:      coretypes.EventClosed,
		SessionID: controlID,
		Payload:   coretypes.ClosedPayload{Message: message, Reason: reason},
	})
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
	handle.armPaneHandshake(paneID)
	initBytes := []byte(autocomplete.ShellIntegrationInitCommand())
	if err := handle.writeStdin(
		fmt.Sprintf("send-keys -t %s -H %s\n", paneID, hexBytes(initBytes)),
	); err != nil {
		return err
	}
	// 마커가 끝내 안 오면(느린/비호환 셸) 일정 시간 뒤 버퍼를 풀어 실제 출력 손실을 막는다.
	go func() {
		time.Sleep(1500 * time.Millisecond)
		if hs := handle.paneHandshake(paneID); hs != nil {
			if flushed := hs.Flush(); len(flushed) > 0 {
				m.emitStream(coretypes.StreamFrame{
					Type:      coretypes.StreamTypeData,
					SessionID: sessionID,
				}, flushed)
			}
		}
	}()
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

// RunCompletionCommand 는 보조 exec 채널에서 짧은 read-only 완성 명령을 실행한다. 보조
// 채널 기본 cwd(홈) 기준이라 pane 이 cd 한 실제 경로는 반영하지 못한다(MVP 한계).
func (m *Manager) RunCompletionCommand(sessionID, command string) (string, bool, error) {
	handle, _, err := m.controlOf(sessionID)
	if err != nil {
		return "", false, err
	}
	stdout, _, err := sshcmd.RunWithTimeout(handle.client, command, autocomplete.CompletionTimeout)
	if err != nil && len(stdout) == 0 {
		return "", false, err
	}
	out, truncated := autocomplete.CapOutput(stdout)
	return out, truncated, nil
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
