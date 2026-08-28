package localsession

import (
	"strings"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
)

// probeShellThenReinject 는 "누구냐" 한 줄을 보내고, 답이 오면 그 셸 전용 스크립트를 넣는다.
//
// sshsession 의 같은 이름과 하는 일이 같다 — 로컬 터미널에서도 `sudo su`·`docker exec` 로
// 서브셸에 들어가면 셸을 모르는 채로 재주입을 시도하게 되기 때문이다.
func (m *Manager) probeShellThenReinject(sessionID string, session *sessionHandle, promptTail []byte) {
	// 직접 셸 힌트가 없는 명령(ssh·wsl·docker)은 안착한 프롬프트를 먼저 본다. 최초 러너만 보면
	// PowerShell에서 Git Bash/WSL로 들어간 뒤에도 PowerShell 문법을 보내 응답을 영원히 못 받는다.
	command, ok := probeCommandFor(session.runner.ShellKind(), promptTail)
	if !ok {
		// cmd 처럼 물어볼 방법도 넣을 것도 없는 셸이다.
		session.shellIntegrationUnsupported.Store(true)
		return
	}
	session.shellProbe.Arm(func(shell string) {
		if shell == "" {
			// dash·busybox 등. 넣을 것이 없고, 이 세션에서는 다시 묻지도 않는다.
			session.shellIntegrationUnsupported.Store(true)
			m.FlushShellIntegration(sessionID)
			// 실행 중으로 남을 명령 블록을 닫는다(CommandFinishedMarker 주석 참고).
			m.emitStream(
				protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID},
				[]byte(autocomplete.CommandFinishedMarker),
			)
			return
		}
		m.performShellIntegrationReinject(sessionID, session, shell, nil)
	})
	session.handshake.ArmForShellProbe(false, command)
	m.emitStream(
		protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID},
		[]byte("\r\x1b[2K"),
	)
	if err := session.runner.Write([]byte(command)); err != nil {
		session.shellProbe.Disarm()
		if flushed := session.handshake.Flush(); len(flushed) > 0 {
			m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
		}
		return
	}
	// 답이 끝내 오지 않으면(셸이 아닌 것이 앞에 있거나 printf 가 없는 셸) 버퍼를 풀어 준다.
	// 주입 경로와 같은 방식이다(time.AfterFunc).
	time.AfterFunc(shellIntegrationHandshakeTimeout, func() {
		session.shellProbe.Disarm()
		m.FlushShellIntegration(sessionID)
	})
}

// probeCommandFor 는 이 세션의 셸에 맞는 프로브를 고른다.
//
// PowerShell 에 POSIX 판(`printf …`)을 보내면 "인식할 수 없는 명령" 오류가 화면에 남는다.
// `cmd` 에는 둘 다 소용없다 — 통합을 넣을 방법 자체가 없다.
func probeCommandFor(shellKind string, promptTail []byte) (string, bool) {
	if autocomplete.LooksLikePowerShellPrompt(string(promptTail)) {
		return autocomplete.PowerShellProbeCommand(), true
	}
	if looksLikePOSIXPrompt(promptTail) {
		return autocomplete.ShellProbeCommand(), true
	}
	switch autocomplete.NormalizeShellIntegrationShell(shellKind) {
	case "pwsh", "powershell":
		return autocomplete.PowerShellProbeCommand(), true
	default:
		if strings.EqualFold(strings.TrimSpace(shellKind), "cmd") {
			return "", false
		}
		return autocomplete.ShellProbeCommand(), true
	}
}

// looksLikePOSIXPrompt 는 프로브 문법을 안전하게 고를 수 있는 POSIX 프롬프트 종결자만 본다.
// `>`는 PowerShell과 POSIX 테마가 함께 쓰므로 제외하고, 모호하면 최초 러너 종류로 물러난다.
func looksLikePOSIXPrompt(value []byte) bool {
	trimmed := strings.TrimRight(autocomplete.StripTerminalControls(string(value)), " \t\r\n")
	for _, suffix := range []string{"$", "#", "%", "❯", "➜"} {
		if strings.HasSuffix(trimmed, suffix) {
			return true
		}
	}
	return false
}
