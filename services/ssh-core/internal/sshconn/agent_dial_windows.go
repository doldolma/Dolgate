//go:build windows

package sshconn

import (
	"io"
	"time"

	winio "github.com/Microsoft/go-winio"
	"golang.org/x/crypto/ssh/agent"
)

// dialLocalAgent은 Windows OpenSSH Authentication Agent 네임드 파이프에 연결한다. 1Password도
// 이 파이프를 대신 서비스하므로 동일 경로로 잡힌다. 반환 io.Closer는 인증 후 호출부가 닫는다.
func dialLocalAgent(kind string, endpoint string) (agent.ExtendedAgent, io.Closer, error) {
	_ = kind
	if endpoint == "" {
		endpoint = `\\.\pipe\openssh-ssh-agent`
	}
	timeout := 3 * time.Second
	conn, err := winio.DialPipe(endpoint, &timeout)
	if err != nil {
		return nil, nil, err
	}
	return agent.NewClient(conn), conn, nil
}
