//go:build !windows

package sshsession

import (
	"fmt"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

func forwardAgentToEndpoint(client *ssh.Client, kind string, endpoint string) error {
	if kind != "unix" {
		return fmt.Errorf("%w: %s", errAgentForwardingUnsupported, kind)
	}
	return agent.ForwardToRemote(client, endpoint)
}
