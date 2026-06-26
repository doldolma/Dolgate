//go:build windows

package sshsession

import (
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/crypto/ssh"
)

func forwardAgentToEndpoint(client *ssh.Client, kind string, endpoint string) error {
	if kind != "windows-openssh-pipe" {
		return fmt.Errorf("%w: %s", errAgentForwardingUnsupported, kind)
	}

	timeout := 1500 * time.Millisecond
	probe, err := winio.DialPipe(endpoint, &timeout)
	if err != nil {
		return err
	}
	_ = probe.Close()

	channels := client.HandleChannelOpen(agentForwardingChannelType)
	if channels == nil {
		return fmt.Errorf("agent: already have handler for %s", agentForwardingChannelType)
	}

	go func() {
		for ch := range channels {
			channel, reqs, err := ch.Accept()
			if err != nil {
				continue
			}
			go ssh.DiscardRequests(reqs)
			go forwardWindowsAgentPipe(channel, endpoint)
		}
	}()

	return nil
}

func forwardWindowsAgentPipe(channel ssh.Channel, endpoint string) {
	timeout := 1500 * time.Millisecond
	conn, err := winio.DialPipe(endpoint, &timeout)
	if err != nil {
		_ = channel.Close()
		return
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		_, _ = io.Copy(conn, channel)
		_ = conn.Close()
		wg.Done()
	}()
	go func() {
		_, _ = io.Copy(channel, conn)
		_ = channel.CloseWrite()
		wg.Done()
	}()

	wg.Wait()
	_ = conn.Close()
	_ = channel.Close()
}
