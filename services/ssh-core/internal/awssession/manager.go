package awssession

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/shellintegration"
)

type EventEmitter func(protocol.Event)
type StreamEmitter func(protocol.StreamFrame, []byte)

type runnerFactory func(protocol.AWSConnectPayload) (sessionRunner, error)

type sessionHandle struct {
	runner              sessionRunner
	streams             sync.WaitGroup
	disconnectRequested bool
	errorNotified       bool
	done                chan struct{}
	probeMu             sync.Mutex
	probe               *autocompleteProbe
	probePrompt         *autocompleteProbePrompt
	handshake           autocomplete.Handshake

	shellIntegrationMu             sync.Mutex
	shellIntegrationState          shellIntegrationState
	shellIntegrationFlushScheduled bool
	shellIntegrationInstallOnce    sync.Once
	shellIntegrationQuietTimer     *time.Timer
	shellIntegrationMaxTimer       *time.Timer
	shellIntegrationTail           string
	shellIntegrationReady          chan struct{}
	shellIntegrationReadyOnce      sync.Once
	// 원격 셸에 통합 스크립트를 타이핑할 수 있는지. 못 하는 종류면 arm 조차 하지 않는다.
	shellIntegrationTypable bool
	// 데스크톱이 알려 준 셸 종류(Windows 면 powershell). 알면 그 셸 것만 보낸다 — 빈 값이면
	// Linux/POSIX 로 보고 bash·zsh 겸용을 보낸다(SSM 세션 문서가 정하는 셸이라 물어볼 데가 없다).
	shellKind string
	// 셸을 모를 때 "누구냐" 를 묻고 답을 기다리는 곳.
	shellProbe autocomplete.ShellProbe
	// reinjectGate is separate from the connect-time state machine. A nested
	// shell can be entered many times during one SSM session.
	reinjectGate *autocomplete.PromptSettleGate
}

type autocompleteProbe struct {
	nonce    string
	revision int
	buffer   []byte
	result   chan autocompleteProbeResult
}

type autocompleteProbeResult struct {
	result autocomplete.Result
	err    error
}

type autocompleteProbePrompt struct {
	buffer   []byte
	response autocompleteProbeResult
	result   chan autocompleteProbeResult
}

type shellIntegrationState int

const (
	shellIntegrationUnknown shellIntegrationState = iota
	shellIntegrationArmed
	shellIntegrationInstalling
	shellIntegrationInstalled
	// shellIntegrationUnsupported: 이 셸에는 통합을 넣을 수 없다고 판정했다(PowerShell).
	// 되돌리지 않는 상태다 — 세션 도중 셸이 바뀌지는 않는다.
	shellIntegrationUnsupported
)

type Manager struct {
	mu           sync.RWMutex
	sessions     map[string]*sessionHandle
	emit         EventEmitter
	emitStream   StreamEmitter
	createRunner runnerFactory
}

const shutdownDrainTimeout = 2 * time.Second

// autocompleteProbeTimeout is the total budget for AWS in-band autocomplete
// prepare: waiting for the first integrated prompt plus collecting the snapshot.
// Keep it below the desktop-side AWS prepare timeout so queued input is released
// only after ssh-core has either completed or abandoned the in-band probe.
const autocompleteProbeTimeout = 9 * time.Second

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

func (m *Manager) Connect(sessionID, requestID string, payload protocol.AWSConnectPayload) error {
	runner, err := m.createRunner(payload)
	if err != nil {
		return err
	}

	handle := &sessionHandle{
		runner:                  runner,
		done:                    make(chan struct{}),
		shellIntegrationReady:   make(chan struct{}),
		shellIntegrationTypable: shellIntegrationTypable(payload.ShellKind),
		shellKind:               strings.TrimSpace(payload.ShellKind),
		reinjectGate:            autocomplete.NewPromptSettleGate(0, 0),
	}
	m.mu.Lock()
	m.sessions[sessionID] = handle
	m.mu.Unlock()

	// Report the data channel's keepalive round-trip as a tab latency indicator,
	// the same EventLatency the renderer already shows for SSH keepalive RTT.
	if lr, ok := runner.(interface{ SetLatencyHandler(func(time.Duration)) }); ok {
		lr.SetLatencyHandler(func(rtt time.Duration) {
			m.emit(protocol.Event{
				Type:      protocol.EventLatency,
				SessionID: sessionID,
				Payload:   protocol.LatencyPayload{RoundTripMs: int(rtt.Milliseconds())},
			})
		})
	}

	if handle.beginShellIntegration() {
		m.scheduleShellIntegrationInstall(sessionID, handle)
	}

	for _, reader := range runner.Streams() {
		handle.streams.Add(1)
		go m.stream(sessionID, handle, reader)
	}

	m.emit(protocol.Event{
		Type:      protocol.EventConnected,
		RequestID: requestID,
		SessionID: sessionID,
		Payload: protocol.StatusPayload{
			Status: "connected",
		},
	})

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

// ReinjectShellIntegration restores OSC hooks after a command entered a nested
// shell. SSM has no auxiliary exec channel, so an unknown shell is identified
// with the same short in-band probe used by SSH/local reinjection.
func (m *Manager) ReinjectShellIntegration(sessionID, shellHint string) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	session.reinjectGate.Arm(func(tail []byte) {
		if autocomplete.PromptAlreadyIntegrated(tail) {
			return
		}
		if shell := autocomplete.NormalizeShellIntegrationShell(shellHint); shell != "" {
			_ = m.injectSubshellIntegration(sessionID, session, shell)
			return
		}
		_ = shellintegration.ProbeShellThenInject(shellintegration.ProbeTarget{
			Probe:        &session.shellProbe,
			Handshake:    &session.handshake,
			ProbeCommand: autocomplete.ShellProbeCommand(),
			Write:        session.runner.Write,
			BeforeWrite: func() {
				m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, []byte("\r\x1b[2K"))
			},
			Emit: func(data []byte) {
				m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, data)
			},
			OnUnsupported: func() {
				m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, []byte(autocomplete.CommandFinishedMarker))
			},
			OnShell: func(shell string) {
				_ = m.injectSubshellIntegration(sessionID, session, shell)
			},
			Done: session.done,
		})
	}, func() {})
	return nil
}

func (m *Manager) injectSubshellIntegration(sessionID string, session *sessionHandle, shell string) error {
	commands := autocomplete.ShellIntegrationInitLines(shell)
	if len(commands) == 0 {
		return nil
	}
	generation := session.handshake.ArmForCommand(false, commands...)
	m.emitStream(
		protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID},
		[]byte(autocomplete.CommandFinishedMarker+"\r\x1b[2K"),
	)
	for _, command := range commands {
		if err := session.runner.Write([]byte(command)); err != nil {
			if flushed := session.handshake.FlushAttempt(generation); len(flushed) > 0 {
				m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
			}
			return err
		}
	}
	go func() {
		timer := time.NewTimer(shellintegration.DefaultHandshakeTimeout)
		defer timer.Stop()
		select {
		case <-session.done:
		case <-timer.C:
			if flushed := session.handshake.FlushAttempt(generation); len(flushed) > 0 && m.HasSession(sessionID) {
				m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
			}
		}
	}()
	return nil
}

func (m *Manager) CollectAutocomplete(sessionID string, revision int) (autocomplete.Result, error) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return autocomplete.Result{}, err
	}
	if session.shellIntegrationUnsupportedNow() {
		// 통합이 없는 셸이다(PowerShell 등). 기다려도 준비되지 않으므로 바로 물러난다 — 여기서
		// 기다리면 키를 누를 때마다 9초씩 멈춘다.
		return autocomplete.Unsupported(), nil
	}
	if err := m.InstallShellIntegration(sessionID); err != nil {
		return autocomplete.Result{}, err
	}
	deadline := time.Now().Add(autocompleteProbeTimeout)
	if !session.waitForShellIntegrationReady(time.Until(deadline)) {
		return autocomplete.Degraded("", "probe-timeout"), nil
	}
	probeBudget := time.Until(deadline)
	if probeBudget <= 0 {
		return autocomplete.Degraded("", "probe-timeout"), nil
	}

	nonceBytes := make([]byte, 12)
	if _, err := rand.Read(nonceBytes); err != nil {
		return autocomplete.Result{}, err
	}
	probe := &autocompleteProbe{
		nonce:    hex.EncodeToString(nonceBytes),
		revision: revision,
		result:   make(chan autocompleteProbeResult, 1),
	}
	session.probeMu.Lock()
	if session.probe != nil {
		session.probeMu.Unlock()
		return autocomplete.Degraded("", "metadata-unavailable"), nil
	}
	session.probe = probe
	session.probeMu.Unlock()

	if err := session.runner.Write([]byte(autocomplete.InBandProbeCommand(probe.nonce))); err != nil {
		m.clearAutocompleteProbe(session, probe)
		return autocomplete.Result{}, err
	}

	select {
	case response := <-probe.result:
		return response.result, response.err
	case <-time.After(probeBudget):
		m.clearAutocompleteProbe(session, probe)
		return autocomplete.Degraded("", "probe-timeout"), nil
	}
}

func (m *Manager) StopAutocomplete(sessionID string) {
	session, err := m.getSession(sessionID)
	if err != nil {
		return
	}
	session.probeMu.Lock()
	session.probe = nil
	session.probePrompt = nil
	session.probeMu.Unlock()
}

// InstallShellIntegration arms the OSC 133 handshake filter. AWS SSM can type
// its own shell profile/run-as command after the data channel opens, so the
// actual init command is written by the startup gate after that first prompt
// settles, not immediately on connect.
func (m *Manager) InstallShellIntegration(sessionID string) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	if !session.beginShellIntegration() {
		return nil
	}
	m.scheduleShellIntegrationInstall(sessionID, session)
	return nil
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

func (m *Manager) SendControlSignal(sessionID, signal string) error {
	session, err := m.getSession(sessionID)
	if err != nil {
		return err
	}
	return session.runner.SendControlSignal(signal)
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

func (m *Manager) Shutdown() {
	sessions := m.snapshotSessionsForShutdown()
	if len(sessions) == 0 {
		return
	}

	for _, session := range sessions {
		_ = session.runner.Kill()
	}

	deadline := time.NewTimer(shutdownDrainTimeout)
	defer deadline.Stop()

	for _, session := range sessions {
		select {
		case <-session.done:
		case <-deadline.C:
			return
		}
	}
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
			m.observeShellIntegrationOutput(sessionID, handle, chunk)
			handle.reinjectGate.Observe(chunk)
			// 셸을 모른 채 접속하는 리눅스 SSM 세션은 먼저 "누구냐" 를 묻는다. 그 답도 핸드셰이크
			// 필터 전에 봐야 한다 — 필터는 이 답을 앵커로 삼아 버퍼를 버린다.
			handle.shellProbe.Observe(chunk)
			// Suppress the integration command echo until the first prompt
			// marker, then let the 6973 snapshot probe parsing run on what
			// remains (the marker is injected before the probe, so it arrives
			// first and the probe response is never swallowed).
			var handshakeDone bool
			chunk, handshakeDone = handle.handshake.FilterWithStatus(chunk)
			if handshakeDone {
				handle.markShellIntegrationReady()
			}
			if len(chunk) > 0 {
				chunk = m.consumeAutocompleteProbe(handle, chunk)
			}
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

const (
	// shellIntegrationHandshakeTimeout bounds how long the echo-suppression
	// handshake waits for the first OSC 133;A prompt marker before releasing any
	// buffered output. AWS SSM can take a few seconds to exec into the target
	// login shell, so keep this aligned with the runtime/SSH manager budget.
	shellIntegrationHandshakeTimeout = 8 * time.Second
	shellIntegrationInstallQuiet     = 500 * time.Millisecond
	shellIntegrationInstallMaxWait   = 2500 * time.Millisecond
	shellIntegrationTailLimit        = 2048
)

// shellIntegrationTypable 은 이 셸에 통합을 타이핑할 수 있는지다.
//
// **PowerShell 에는 타이핑하지 않는다.** 한 번 뒤집었다가 되돌린 판단이라 근거를 남긴다.
//
// 뒤집은 이유는 "커서가 밀리던 것은 걷어낼 echo 를 bash 로 가정한 탓이고, 실제로 보내는 명령으로
// 무장하면(ArmForCommand) 해결된다" 였다. 실기기에서 아니었다. Windows SSM 세션에 pwsh 전용
// 스크립트를 타이핑하면:
//
//   - 줄이 실행되지 않는다. 마커가 하나도 오지 않아 cwd·명령 블록·자동완성이 전부 없다 —
//     타이핑하지 않을 때와 결과가 같으면서 화면만 더 나빠진다.
//   - 화면이 깨진다. PSReadLine 이 입력줄을 구문 색으로, 그리고 도착하는 대로 **처음부터 다시**
//     그려서 화면에는 그리다 만 사본이 여러 벌 남는다. 전체 일치로는 완성본 하나만 지워지고,
//     부분 일치로 지우면 토큰 중간이 잘리고 줄바꿈까지 사라져 배너가 겹쳐 찍힌다
//     (stripInjectedEcho 주석 참고 — 둘 다 해 봤다).
//
// 예전 주석이 이미 정확했다: "typing it drifts the cursor (that is why local pwsh sessions get it
// via -EncodedCommand instead), and an SSM session takes no launch arguments." 로컬은 기동
// 인자가 있어서 살았고, SSM 은 그것이 없다. 그래서 SSM PowerShell 은 통합 없이 간다 — 맨 SSM
// 세션이 주는 그대로다.
//
// 타이핑 아닌 통로를 찾아봤고, 쓸 수 있는 것이 없다. 조사 결과를 남겨 둔다 — 다시 뒤집기 전에
// 이만큼은 이미 확인됐다는 뜻이다.
//
//   - `shellProfile.windows`(Standard_Stream 의 세션 시작 명령). 이름은 기동 훅처럼 보이지만
//     에이전트가 **stdin 으로 타이핑한다**(agent/session/shell/shell_windows.go 의 runShellProfile
//     이 `strings.Split(…, "\n")` 후 줄마다 stdin.Write). 지금과 같은 통로다.
//   - `sessionType: InteractiveCommands`. 이쪽은 진짜 기동 인자다 — 같은 파일에서
//     `fullCmdToPty := winptyCmd + " " + cmdStr` 로 `powershell.exe <commands>` 를 만들어
//     winpty.Start 에 넘긴다. 로컬의 -EncodedCommand 와 같은 모양이 된다.
//
// 그런데 둘 다 **SSM 문서**(계정·리전에 저장되는 AWS 리소스)를 만들거나 고쳐야 한다. 사용자
// 계정의 세션 설정을 우리가 건드리는 일이고, 문서를 바꿔 끼우면 기본 문서에 걸린 세션 녹화·
// 암호화가 따라오는지도 AWS 문서에 없다(조용히 로그가 끊길 수 있다). 그래서 하지 않기로 했다.
//
// 남는 길은 (a) 인스턴스의 PowerShell 프로필에 심기 — 남의 서버를 영구히 바꾸므로 명시적
// opt-in 이 아니면 안 되고, (b) 짧은 여러 줄로 쪼개 타이핑 — AWS 가 shellProfile 을 넣는 방식이
// 그것이라 가능성은 있지만 검증되지 않았다. 둘 다 지금은 하지 않는다.
//
// 이름을 알지만 지원하지 않는 셸(ksh·cmd)이면 보낼 것이 없다. 빈 값은 Linux/POSIX 로 본다.
func shellIntegrationTypable(shellKind string) bool {
	switch autocomplete.NormalizeShellIntegrationShell(shellKind) {
	case "pwsh", "powershell":
		return false
	default:
		// 빈 값(리눅스 SSM)은 먼저 프로브로 셸을 확인한다 — 겸용 스크립트를 던지던 길은
		// 없앴다(dash·busybox 화면에 스크립트가 그대로 남았다).
		if strings.TrimSpace(shellKind) == "" {
			return true
		}
		return len(autocomplete.ShellIntegrationInitLines(shellKind)) > 0
	}
}

func (h *sessionHandle) beginShellIntegration() bool {
	h.shellIntegrationMu.Lock()
	defer h.shellIntegrationMu.Unlock()
	if !h.shellIntegrationTypable {
		return false
	}
	switch h.shellIntegrationState {
	case shellIntegrationArmed, shellIntegrationInstalling, shellIntegrationInstalled,
		// 판정이 끝난 셸은 다시 무장하지 않는다 — 무장은 곧 출력을 붙잡는다는 뜻이다.
		shellIntegrationUnsupported:
		return false
	}
	h.shellIntegrationState = shellIntegrationArmed
	// 걷어낼 echo 는 실제로 보낼 명령이다 — 기본값(bash·zsh)에 맡기면 PowerShell 세션에서 마커 뒤
	// 프롬프트 재출력이 화면에 남는다(그것이 "커서가 밀린다" 던 증상이다).
	h.handshake.ArmForCommand(false, h.shellIntegrationCommands()...)
	return true
}

// Windows 면 데스크톱이 셸 종류를 실어 보낸다 — 그 셸 것 한 줄이면 된다. Linux 는 세션 문서가
// 정하는 셸(계정마다 sh·bash 가 다르다)이라 물어볼 채널이 없어 bash·zsh 겸용을 여러 줄로 보낸다.
func (h *sessionHandle) shellIntegrationCommands() []string {
	if strings.TrimSpace(h.shellKind) == "" {
		// 아직 누구인지 모른다. 이번에 나가는 것은 프로브 한 줄이고, 답을 받으면 shellKind 가
		// 채워져 다음 호출에서 그 셸 전용 한 줄이 나간다.
		return []string{autocomplete.ShellProbeCommand()}
	}
	return autocomplete.ShellIntegrationInitLines(h.shellKind)
}

func (m *Manager) writeShellIntegrationCommands(session *sessionHandle) error {
	for _, command := range session.shellIntegrationCommands() {
		if err := session.runner.Write([]byte(command)); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) writeShellIntegrationCommand(sessionID string, session *sessionHandle) (bool, error) {
	session.shellIntegrationMu.Lock()
	// 셸을 모르면 이번에 나가는 것은 프로브 한 줄이다. 답이 오면 shellKind 를 채우고 다시 부른다.
	probing := strings.TrimSpace(session.shellKind) == ""
	switch session.shellIntegrationState {
	case shellIntegrationInstalling, shellIntegrationInstalled, shellIntegrationUnsupported:
		session.shellIntegrationMu.Unlock()
		return false, nil
	case shellIntegrationUnknown:
		session.shellIntegrationState = shellIntegrationInstalling
		if probing {
			session.handshake.ArmForShellProbe(false, autocomplete.ShellProbeCommand())
		} else {
			session.handshake.ArmForCommand(false, session.shellIntegrationCommands()...)
		}
	default:
		session.shellIntegrationState = shellIntegrationInstalling
		if probing {
			session.handshake.ArmForShellProbe(false, autocomplete.ShellProbeCommand())
		}
	}
	if probing {
		session.shellProbe.Arm(func(shell string) {
			session.shellIntegrationMu.Lock()
			if shell == "" {
				// dash·busybox 등. 이 셸에는 넣을 것이 없다 — 다시 묻지도 않는다.
				session.shellIntegrationState = shellIntegrationUnsupported
				session.shellIntegrationMu.Unlock()
				m.FlushShellIntegration(sessionID)
				return
			}
			session.shellKind = shell
			session.shellIntegrationState = shellIntegrationUnknown
			session.shellIntegrationMu.Unlock()
			_, _ = m.writeShellIntegrationCommand(sessionID, session)
		})
	}
	session.stopShellIntegrationInstallTimersLocked()
	session.shellIntegrationMu.Unlock()

	if err := m.writeShellIntegrationCommands(session); err != nil {
		flushed := session.handshake.Flush()
		session.shellIntegrationMu.Lock()
		session.shellIntegrationState = shellIntegrationUnknown
		session.shellIntegrationMu.Unlock()
		if len(flushed) > 0 {
			m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
		}
		return false, err
	}

	if probing {
		// 프로브만 나갔다. 상태는 답을 받은 콜백이 옮긴다.
		return true, nil
	}
	session.shellIntegrationMu.Lock()
	session.shellIntegrationState = shellIntegrationInstalled
	shouldScheduleFlush := !session.shellIntegrationFlushScheduled
	session.shellIntegrationFlushScheduled = true
	session.shellIntegrationMu.Unlock()

	if shouldScheduleFlush {
		m.scheduleShellIntegrationFlush(sessionID, session)
	}
	return true, nil
}

func (m *Manager) scheduleShellIntegrationInstall(sessionID string, session *sessionHandle) {
	session.shellIntegrationMu.Lock()
	defer session.shellIntegrationMu.Unlock()
	if session.shellIntegrationState != shellIntegrationArmed || session.shellIntegrationMaxTimer != nil {
		return
	}
	session.shellIntegrationMaxTimer = time.AfterFunc(shellIntegrationHandshakeTimeout, func() {
		m.abandonShellIntegrationInstall(sessionID, session)
	})
}

func (m *Manager) observeShellIntegrationOutput(sessionID string, session *sessionHandle, chunk []byte) {
	if len(chunk) == 0 {
		return
	}

	session.shellIntegrationMu.Lock()
	defer session.shellIntegrationMu.Unlock()
	if session.shellIntegrationState != shellIntegrationArmed {
		return
	}

	session.shellIntegrationTail += string(chunk)
	if len(session.shellIntegrationTail) > shellIntegrationTailLimit {
		session.shellIntegrationTail = session.shellIntegrationTail[len(session.shellIntegrationTail)-shellIntegrationTailLimit:]
	}

	// 화면으로 PowerShell 임을 알아냈는데 **우리가 그것을 몰랐다면** 넣을 것이 없다. 붙잡고 있던
	// 출력을 즉시 놓아준다 — 안 그러면 마커를 8초 기다리다 한꺼번에 쏟아진다.
	//
	// 데스크톱이 셸 종류를 알려 준 경우(Windows 인스턴스)는 여기서 멈추지 않는다. 그 셸에 맞는
	// pwsh 스크립트를 보낼 수 있으므로 아래 프롬프트 안착 경로로 그대로 간다.
	//
	// 아래 프롬프트 판정보다 **먼저** 봐야 한다. "PS C:\...>" 는 그쪽 검사도 통과한다(접미사가
	// ">" 다).
	if autocomplete.NormalizeShellIntegrationShell(session.shellKind) == "" &&
		autocomplete.LooksLikePowerShellPrompt(session.shellIntegrationTail) {
		session.stopShellIntegrationInstallTimersLocked()
		session.shellIntegrationState = shellIntegrationUnsupported
		session.shellIntegrationMu.Unlock()
		// 이 함수는 필터보다 먼저 호출되므로(스트림 펌프 참고), 여기서 내보내면 지금 덩어리보다
		// 앞선다 — 순서가 뒤집히지 않는다.
		if flushed := session.handshake.Flush(); len(flushed) > 0 && m.HasSession(sessionID) {
			m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
		}
		session.shellIntegrationMu.Lock()
		return
	}

	if autocomplete.LooksLikeShellPrompt(session.shellIntegrationTail) {
		if session.shellIntegrationMaxTimer != nil {
			session.shellIntegrationMaxTimer.Stop()
			session.shellIntegrationMaxTimer = nil
		}
		if session.shellIntegrationQuietTimer == nil {
			session.shellIntegrationQuietTimer = time.AfterFunc(shellIntegrationInstallQuiet, func() {
				m.triggerShellIntegrationInstall(sessionID, session)
			})
		} else {
			session.shellIntegrationQuietTimer.Reset(shellIntegrationInstallQuiet)
		}
		return
	}
	if session.shellIntegrationQuietTimer != nil {
		session.shellIntegrationQuietTimer.Stop()
	}
}

func (m *Manager) abandonShellIntegrationInstall(sessionID string, session *sessionHandle) {
	session.shellIntegrationMu.Lock()
	if session.shellIntegrationState != shellIntegrationArmed {
		session.shellIntegrationMu.Unlock()
		return
	}
	session.stopShellIntegrationInstallTimersLocked()
	session.shellIntegrationState = shellIntegrationUnknown
	session.shellIntegrationMu.Unlock()

	if flushed := session.handshake.Flush(); len(flushed) > 0 && m.HasSession(sessionID) {
		m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
	}
}

func (m *Manager) triggerShellIntegrationInstall(sessionID string, session *sessionHandle) {
	if !m.HasSession(sessionID) {
		return
	}
	session.shellIntegrationInstallOnce.Do(func() {
		go func() {
			_, _ = m.writeShellIntegrationCommand(sessionID, session)
		}()
	})
}

func (h *sessionHandle) stopShellIntegrationInstallTimersLocked() {
	if h.shellIntegrationQuietTimer != nil {
		h.shellIntegrationQuietTimer.Stop()
		h.shellIntegrationQuietTimer = nil
	}
	if h.shellIntegrationMaxTimer != nil {
		h.shellIntegrationMaxTimer.Stop()
		h.shellIntegrationMaxTimer = nil
	}
	h.shellIntegrationTail = ""
}

func (m *Manager) scheduleShellIntegrationFlush(sessionID string, session *sessionHandle) {
	go func() {
		timer := time.NewTimer(shellIntegrationHandshakeTimeout)
		defer timer.Stop()
		select {
		case <-session.done:
		case <-session.shellIntegrationReady:
		case <-timer.C:
			m.FlushShellIntegration(sessionID)
		}
	}()
}

func (h *sessionHandle) markShellIntegrationReady() {
	h.shellIntegrationReadyOnce.Do(func() {
		close(h.shellIntegrationReady)
	})
}

// shellIntegrationUnsupportedNow 는 이 세션에 셸 통합을 넣을 수 없다고 판정됐는지 알려준다.
func (h *sessionHandle) shellIntegrationUnsupportedNow() bool {
	h.shellIntegrationMu.Lock()
	defer h.shellIntegrationMu.Unlock()
	return !h.shellIntegrationTypable || h.shellIntegrationState == shellIntegrationUnsupported
}

func (h *sessionHandle) waitForShellIntegrationReady(timeout time.Duration) bool {
	if timeout <= 0 {
		return false
	}
	select {
	case <-h.shellIntegrationReady:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (m *Manager) clearAutocompleteProbe(handle *sessionHandle, expected *autocompleteProbe) {
	handle.probeMu.Lock()
	if handle.probe == expected {
		handle.probe = nil
	}
	if handle.probePrompt != nil && handle.probePrompt.result == expected.result {
		handle.probePrompt = nil
	}
	handle.probeMu.Unlock()
}

func (m *Manager) consumeAutocompleteProbe(handle *sessionHandle, chunk []byte) []byte {
	handle.probeMu.Lock()
	if handle.probePrompt != nil {
		prompt := handle.probePrompt
		prompt.buffer = append(prompt.buffer, chunk...)
		remainder, done := consumeProbePromptRedraw(prompt.buffer)
		if !done && len(prompt.buffer) <= autocomplete.MaxMetadataBytes {
			handle.probeMu.Unlock()
			return nil
		}
		handle.probePrompt = nil
		handle.probeMu.Unlock()
		select {
		case prompt.result <- prompt.response:
		default:
		}
		return remainder
	}
	probe := handle.probe
	if probe == nil {
		handle.probeMu.Unlock()
		return chunk
	}
	probe.buffer = append(probe.buffer, chunk...)
	if len(probe.buffer) > autocomplete.MaxMetadataBytes*2 {
		handle.probe = nil
		handle.probeMu.Unlock()
		select {
		case probe.result <- autocompleteProbeResult{err: fmt.Errorf("autocomplete probe response exceeded limit")}:
		default:
		}
		return nil
	}
	prefix := []byte("\x1b]6973;" + probe.nonce + ";snapshot;")
	start := bytes.Index(probe.buffer, prefix)
	if start < 0 {
		if len(probe.buffer) > autocomplete.MaxMetadataBytes {
			handle.probe = nil
			select {
			case probe.result <- autocompleteProbeResult{err: fmt.Errorf("autocomplete probe response exceeded limit")}:
			default:
			}
		}
		handle.probeMu.Unlock()
		return nil
	}
	endOffset := bytes.IndexByte(probe.buffer[start+len(prefix):], '\a')
	if endOffset < 0 {
		handle.probeMu.Unlock()
		return nil
	}
	end := start + len(prefix) + endOffset
	encoded := append([]byte(nil), probe.buffer[start+len(prefix):end]...)
	remainder := append([]byte(nil), probe.buffer[end+1:]...)
	handle.probe = nil
	result, err := autocomplete.DecodeInBandSnapshot(encoded, probe.revision)
	response := autocompleteProbeResult{result: result, err: err}
	remainder, promptDone := consumeProbePromptRedraw(remainder)
	if !promptDone {
		handle.probePrompt = &autocompleteProbePrompt{
			buffer:   remainder,
			response: response,
			result:   probe.result,
		}
		handle.probeMu.Unlock()
		return nil
	}
	handle.probeMu.Unlock()
	select {
	case probe.result <- response:
	default:
	}
	return remainder
}

func consumeProbePromptRedraw(buffer []byte) ([]byte, bool) {
	marker := []byte(autocomplete.PromptInputStartMarker)
	idx := bytes.Index(buffer, marker)
	if idx < 0 {
		return buffer, false
	}
	return append([]byte(nil), buffer[idx+len(marker):]...), true
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

	session.shellIntegrationMu.Lock()
	session.stopShellIntegrationInstallTimersLocked()
	session.shellIntegrationMu.Unlock()
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
		close(session.done)
	}()
}

func (m *Manager) snapshotSessionsForShutdown() []*sessionHandle {
	m.mu.Lock()
	defer m.mu.Unlock()

	sessions := make([]*sessionHandle, 0, len(m.sessions))
	for _, session := range m.sessions {
		session.disconnectRequested = true
		sessions = append(sessions, session)
	}
	return sessions
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
		return nil, fmt.Errorf("aws session %s not found", sessionID)
	}
	return session, nil
}
