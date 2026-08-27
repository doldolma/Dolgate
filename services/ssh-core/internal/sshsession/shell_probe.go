package sshsession

import (
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
)

// probeShellThenReinject 는 "누구냐" 한 줄을 보내고, 답이 오면 그 셸 전용 스크립트를 넣는다.
//
// 답이 bash·zsh·fish 가 아니면(dash·busybox 등) 아무것도 넣지 않고, 이 세션에서는 다시 묻지도
// 않는다 — 같은 컨테이너를 열 번 드나들어도 프로브는 한 번뿐이다.
func (m *Manager) probeShellThenReinject(sessionID string, session *sessionHandle) {
	command := autocomplete.ShellProbeCommand()
	session.shellProbe.Arm(func(shell string) {
		if shell == "" {
			session.shellIntegrationUnsupported.Store(true)
			// 통합이 없는 셸이다 — 바깥 셸의 133;D 는 여기서 빠져나올 때까지 오지 않는다.
			// 그때까지 모든 출력이 한 블록에 빨려 들어가지 않도록 지금 닫아 준다.
			m.emitStream(
				protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID},
				[]byte(autocomplete.CommandFinishedMarker),
			)
			return
		}
		m.performShellIntegrationReinject(sessionID, session, shell, nil)
	})
	// preserveMotd=false: 프롬프트가 안착한 뒤에 쓰므로 보존할 출력이 없다. 그리고 마커까지
	// **전부** 버려야 fish 처럼 줄을 다시 그리는 셸에서도 에코가 화면에 남지 않는다(fish 는
	// 문법 강조를 하며 다시 그려서, 글자 대조로는 하나도 못 지운다).
	session.handshake.ArmForShellProbe(false, command)
	// 프롬프트를 보고 쓰므로 그 줄을 지운다(주입 경로와 같은 이유 — 프롬프트가 두 번 찍히는 것을
	// 막는다).
	m.emitStream(
		protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID},
		[]byte("\r\x1b[2K"),
	)
	if _, err := session.writeStdin([]byte(command)); err != nil {
		session.shellProbe.Disarm()
		if flushed := session.handshake.Flush(); len(flushed) > 0 {
			m.emitStream(protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}, flushed)
		}
		return
	}
	// 답이 끝내 오지 않는 경우(셸이 아닌 것이 앞에 있거나 printf 가 없는 셸): 버퍼를 풀어 주고
	// 무장을 해제한다. 풀어 주지 않으면 그동안의 출력이 화면에 영영 안 나온다.
	go func() {
		timer := time.NewTimer(shellIntegrationHandshakeTimeout)
		defer timer.Stop()
		select {
		case <-session.closed:
		case <-timer.C:
			session.shellProbe.Disarm()
			m.FlushShellIntegration(sessionID)
		}
	}()
}
