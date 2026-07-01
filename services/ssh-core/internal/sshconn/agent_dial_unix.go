//go:build !windows

package sshconn

import (
	"fmt"
	"io"
	"net"

	"golang.org/x/crypto/ssh/agent"
)

// dialLocalAgent은 로컬 ssh-agent에 연결해 서명 대행용 agent 클라이언트를 만든다. unix 계열은
// SSH_AUTH_SOCK가 가리키는 유닉스 도메인 소켓(기본 agent·1Password·gpg-agent 등)을 쓴다.
// 반환한 io.Closer는 인증(핸드셰이크)이 끝난 뒤 호출부가 닫는다.
func dialLocalAgent(kind string, endpoint string) (agent.ExtendedAgent, io.Closer, error) {
	if endpoint == "" {
		return nil, nil, fmt.Errorf("ssh-agent 소켓 경로가 비어 있습니다")
	}
	if kind == "windows-openssh-pipe" {
		return nil, nil, fmt.Errorf("이 플랫폼에서 windows-openssh-pipe agent는 지원하지 않습니다")
	}
	conn, err := net.Dial("unix", endpoint)
	if err != nil {
		return nil, nil, err
	}
	return agent.NewClient(conn), conn, nil
}
