package localsession

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
)

// shellIntegrationHandshakeTimeout bounds how long the echo-suppression
// handshake waits for the first OSC 133;A marker after a re-injection before
// releasing buffered output (non-bash/zsh subshell).
const shellIntegrationHandshakeTimeout = 8 * time.Second

// 접속 직후 통합 주입을 미루는 창. 서브셸 재주입보다 짧다 — 로컬 PTY 출력은 즉시 오므로
// 프롬프트 뒤 조용해지는 것을 오래 볼 필요가 없고, 이 기다림은 그대로 기능(cwd·마커·자동완성)이
// 켜지는 지연이 된다.
const (
	installPromptSettleQuiet = 150 * time.Millisecond
	installPromptMaxWait     = 3 * time.Second
)

type EventEmitter func(protocol.Event)
type StreamEmitter func(protocol.StreamFrame, []byte)

type runnerFactory func(protocol.LocalConnectPayload) (sessionRunner, error)

type sessionHandle struct {
	runner              sessionRunner
	streams             sync.WaitGroup
	disconnectRequested bool
	errorNotified       bool
	handshake           autocomplete.Handshake
	// reinjectGate re-installs OSC 133/7 hooks after the user enters a subshell
	// (sudo su, docker exec, ssh from a local shell). Created in Connect; a no-op
	// until Armed by ReinjectShellIntegration.
	reinjectGate *autocomplete.PromptSettleGate
	// installGate 는 접속 직후 통합 주입을 **첫 프롬프트가 뜬 뒤로** 미룬다. 재주입과 따로
	// 두는 이유는 두 가지다: 둘이 겹칠 수 있고, 기다리는 시간이 다르다(로컬 출력은 즉시 오므로
	// 조용해지는 창이 짧아도 된다).
	installGate *autocomplete.PromptSettleGate
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

	handle := &sessionHandle{
		runner:       runner,
		reinjectGate: autocomplete.NewPromptSettleGate(0, 0),
		installGate: autocomplete.NewPromptSettleGate(
			installPromptSettleQuiet,
			installPromptMaxWait,
		),
	}
	m.mu.Lock()
	m.sessions[sessionID] = handle
	m.mu.Unlock()

	m.emit(protocol.Event{
		Type:      protocol.EventConnected,
		RequestID: requestID,
		SessionID: sessionID,
		Payload: protocol.StatusPayload{
			Status:    "connected",
			ShellKind: runner.ShellKind(),
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

func (m *Manager) CollectAutocomplete(sessionID string, revision int) (autocomplete.Result, error) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return autocomplete.Result{}, err
	}
	return autocomplete.CollectLocal(session.runner.ShellKind(), revision), nil
}

// RunCompletionCommand runs a short read-only command for dynamic completion in
// a one-off subprocess (separate from the interactive PTY). The renderer
// resolves directories to absolute paths (via OSC 7 cwd), so the subprocess cwd
// is not relied upon. Bounded by CompletionTimeout and CapOutput.
func (m *Manager) RunCompletionCommand(sessionID, command string) (string, bool, error) {
	if _, err := m.getSession(sessionID); err != nil {
		return "", false, err
	}
	// Completion commands are POSIX shell (`ls -1Ap`, `git branch`, …) run via
	// /bin/sh. A local Windows shell isn't POSIX, so dynamic completion isn't
	// supported there — degrade to nothing instead of failing on a missing
	// /bin/sh. (Remote SSH sessions still complete on the remote Unix host.)
	if runtime.GOOS == "windows" {
		return "", false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), autocomplete.CompletionTimeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, "/bin/sh", "-c", command).Output()
	if err != nil && len(output) == 0 {
		return "", false, err
	}
	out, truncated := autocomplete.CapOutput(output)
	return out, truncated, nil
}

// InstallShellIntegration arms the OSC 133 handshake filter and writes the
// integration init command into the interactive shell. The filter hides the
// command's echo until the first prompt marker is seen.
//
// **첫 프롬프트가 뜬 뒤에 쓴다.** 접속 직후는 셸이 아직 준비되지 않았다 — rc 파일(oh-my-zsh
// 등)이 도는 동안 tty 는 줄 편집기 없이 canonical 모드로 있고, 그 모드의 한 줄 입력 상한
// (MAX_CANON, 1024바이트)이 우리 스크립트보다 작아서 뒷부분과 끝의 CR 이 **버려진다**. 그래서
// 명령이 실행되지 않고(마커도 오지 않고) 원문이 두 번 화면에 남았다 — 한 번은 tty echo 로,
// 한 번은 프롬프트가 뜬 뒤 줄 편집기의 재출력으로. 재출력은 tty 가 폭마다 CR 을 끼워 넣어
// echo 걷어내기와도 글자가 맞지 않는다(실기기 로컬 터미널에서 그대로 재현된다).
//
// 프롬프트가 뜨면 줄 편집기가 raw 모드로 읽으므로 그 상한이 없다 — SSH 세션이 멀쩡했던 이유가
// 그것이다(원격 셸은 이미 프롬프트에 있다).
func (m *Manager) InstallShellIntegration(sessionID string) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	// 기동 인자로 이미 넣었으면 여기서 하지 않는다. stdin 으로 다시 쓰면 셸이 그 줄을 echo 하고,
	// 그것을 화면에서 걷어내는 과정에서 줄바꿈까지 사라져 conhost 와 화면의 커서가 어긋난다.
	if preinstalled, ok := session.runner.(shellIntegrationPreinstaller); ok &&
		preinstalled.ShellIntegrationPreinstalled() {
		return nil
	}
	// 로컬은 셸을 안다(실행 파일 이름) — 그 셸 것 하나만 보낸다.
	commands := autocomplete.ShellIntegrationInitLines(session.runner.ShellKind())
	if len(commands) == 0 {
		return nil
	}
	// 프롬프트를 못 알아본 경우에도 쓴다(테마에 따라 끝 글자가 목록에 없을 수 있다). 그때는
	// 이미 rc 가 끝나 줄 편집기가 올라와 있을 시간이라, 예전처럼 잘려 나갈 위험이 낮다 — 반대로
	// 쓰지 않으면 cwd·마커·자동완성이 조용히 전부 꺼진다.
	session.installGate.Arm(
		func([]byte) { m.writeShellIntegration(sessionID, commands, true) },
		func() { m.writeShellIntegration(sessionID, commands, false) },
	)
	return nil
}

// writeShellIntegration 은 echo 억제를 무장하고 init 명령을 쓴다. 게이트 콜백에서 불린다.
// atPrompt 는 프롬프트를 보고 쓰는 것인지다(그 경우에만 프롬프트 줄을 지운다).
func (m *Manager) writeShellIntegration(sessionID string, commands []string, atPrompt bool) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return
	}
	// 걷어낼 echo 는 **지금 주입하는** 명령들이다. 기본값(bash·zsh)에 맡기면 로컬 PowerShell
	// 에서 마커 뒤 프롬프트 재출력이 그대로 남아 첫 줄에 프롬프트가 두 번 찍혔다.
	session.handshake.ArmForCommand(false, commands...)
	// 프롬프트를 보고 쓰는 대가로, 그 프롬프트가 이미 화면에 있다. 명령을 태우면 셸이 새
	// 프롬프트를 그리는데 echo 를 걷어내면서 그 사이 줄바꿈까지 사라져 한 줄에 프롬프트가 두 번
	// 남는다. 커서를 줄 앞으로 보내고 그 줄을 지워, 새 프롬프트가 같은 자리에 오게 한다.
	//
	// 프롬프트를 못 본 채로 쓰는 경우(기다림이 끝난 뒤)에는 지우지 않는다 — 그 줄에 무엇이 있는지
	// 모르는데 지우면 셸이 방금 찍은 글을 우리가 없애는 셈이다.
	if atPrompt {
		m.emitStream(
			protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID},
			[]byte("\r\x1b[2K"),
		)
	}
	for _, command := range commands {
		if err := session.runner.Write([]byte(command)); err != nil {
			// 쓰지 못했으면 붙잡고 있을 이유가 없다 — 그대로 두면 화면이 빈 채로 멈춘다.
			if flushed := session.handshake.Flush(); len(flushed) > 0 {
				m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
			}
			return
		}
	}
}

// ReinjectShellIntegration re-installs the OSC 133/7 hooks into the foreground
// shell after the user enters a subshell (sudo su, docker exec, ssh from the
// local shell), where the connect-time hooks are absent. It waits for the
// subshell prompt to settle before writing so it never corrupts input, then
// arms the echo-suppression handshake around the injected command. A non-bash/
// zsh subshell emits no marker and the handshake flush restores its output.
func (m *Manager) ReinjectShellIntegration(sessionID string, shell string) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	// 보낼 것이 있을 때만 무장한다 — 플랫폼이 아니라 셸이 기준이다(shouldArmSubshellReinject).
	if !shouldArmSubshellReinject(shell) {
		return nil
	}
	session.reinjectGate.Arm(
		func(tail []byte) { m.performShellIntegrationReinject(sessionID, session, shell, tail) },
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
	// 서브셸이 뜨지 않았다면(진입 명령이 실패해 원래 셸이 새 프롬프트를 그렸다면) 그 프롬프트에는
	// 우리 마커가 이미 붙어 있다. 그때는 보내지 않는다 — 통합은 살아 있고, 보내 봐야 프롬프트가
	// 한 번 더 남을 뿐이다.
	if autocomplete.PromptAlreadyIntegrated(tail) {
		return
	}
	// 렌더러가 실행된 명령에서 셸을 알아냈으면 그 셸 것 한 줄로 끝난다. 모르면 겸용을 여러 줄로
	// 보낸다. 이름은 알지만 지원하지 않는 셸(dash·ksh 등)이면 아무것도 보내지 않는다 — 훅을 걸
	// 방법이 없는 셸에 타이핑해 봐야 화면만 더럽힌다.
	commands := autocomplete.ShellIntegrationInitLines(shell)
	if len(commands) == 0 {
		return
	}
	session.handshake.ArmForCommand(true, commands...)
	// 프롬프트를 보고 쓰므로 그 프롬프트가 이미 화면에 있다. 접속 경로와 같은 이유로 그 줄을
	// 지운다 — 지우지 않으면 셸이 그리는 새 프롬프트가 같은 줄에 이어 붙어 두 번 찍힌다(bash 가
	// 그렇다. zsh 는 zle 가 스스로 지우고 다시 그려서 티가 안 났다).
	m.emitStream(
		protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID},
		[]byte("\r\x1b[2K"),
	)
	for _, command := range commands {
		if err := session.runner.Write([]byte(command)); err != nil {
			if flushed := session.handshake.Flush(); len(flushed) > 0 {
				m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
			}
			return
		}
	}
	time.AfterFunc(shellIntegrationHandshakeTimeout, func() {
		m.FlushShellIntegration(sessionID)
	})
}

// FlushShellIntegration releases any output the handshake filter is holding,
// used when the prompt marker never arrives within the handshake timeout so the
// user still sees whatever the shell produced.
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
			// 주입 대기 중이면 raw 출력으로 프롬프트 안착을 감지한다(필터 전 관찰). 접속 직후
			// 설치와 서브셸 재주입이 각자의 문을 쓴다 — 무장하지 않은 쪽은 no-op 이다.
			handle.installGate.Observe(chunk)
			handle.reinjectGate.Observe(chunk)
			chunk = handle.handshake.Filter(chunk)
			if len(chunk) > 0 {
				m.emitStream(protocol.StreamFrame{
					Type:      protocol.StreamTypeData,
					SessionID: sessionID,
				}, chunk)
			}
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

	// 기다리던 주입은 여기서 접는다. 세션이 사라졌으니 쓸 곳이 없고, 남겨 두면 타이머가 최대
	// 몇 초 더 살아 있다.
	session.installGate.Disarm()
	session.reinjectGate.Disarm()

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
