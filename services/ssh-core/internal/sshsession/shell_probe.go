package sshsession

import (
	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/shellintegration"
)

// probeShellThenReinject 는 "누구냐" 한 줄을 보내고, 답이 오면 그 셸 전용 스크립트를 넣는다.
//
// 답이 bash·zsh·fish 가 아니면(dash·busybox 등) 아무것도 넣지 않고, 이 세션에서는 다시 묻지도
// 않는다 — 같은 컨테이너를 열 번 드나들어도 프로브는 한 번뿐이다.
func (m *Manager) probeShellThenReinject(sessionID string, session *sessionHandle) {
	command := autocomplete.ShellProbeCommand()
	_ = shellintegration.ProbeShellThenInject(shellintegration.ProbeTarget{
		Probe:        &session.shellProbe,
		Handshake:    &session.handshake,
		ProbeCommand: command,
		Write: func(data []byte) error {
			_, err := session.writeStdin(data)
			return err
		},
		BeforeWrite: func() {
			m.emitStream(
				protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID},
				[]byte("\r\x1b[2K"),
			)
		},
		Emit: func(data []byte) {
			m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, data)
		},
		OnUnsupported: func() {
			session.shellIntegrationUnsupported.Store(true)
			// 통합이 없는 셸이다 — 바깥 셸의 133;D 는 여기서 빠져나올 때까지 오지 않는다.
			// 그때까지 모든 출력이 한 블록에 빨려 들어가지 않도록 지금 닫아 준다.
			m.emitStream(
				protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID},
				[]byte(autocomplete.CommandFinishedMarker),
			)
		},
		OnShell: func(shell string) {
			normalized := shellintegration.NormalizeRemoteShell(shell)
			if normalized == "" {
				session.shellIntegrationUnsupported.Store(true)
				m.emitStream(
					protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID},
					[]byte(autocomplete.CommandFinishedMarker),
				)
				return
			}
			m.performShellIntegrationReinject(sessionID, session, normalized)
		},
		Done:    session.closed,
		Timeout: shellIntegrationHandshakeTimeout,
	})
}
