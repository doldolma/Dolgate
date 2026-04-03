//go:build !windows

package hostsoverrideipc

import (
	"context"
	"net"
	"os"
)

type cleanupListener struct {
	net.Listener
	endpoint string
}

func (l *cleanupListener) Close() error {
	err := l.Listener.Close()
	_ = os.Remove(l.endpoint)
	return err
}

func Listen(endpoint string) (net.Listener, error) {
	_ = os.Remove(endpoint)
	listener, err := net.Listen("unix", endpoint)
	if err != nil {
		return nil, err
	}
	_ = os.Chmod(endpoint, 0o600)
	return &cleanupListener{Listener: listener, endpoint: endpoint}, nil
}

func SendRequest(_ context.Context, endpoint string, request Request) (Response, error) {
	return sendRequestWithDialer(func() (net.Conn, error) {
		return net.Dial("unix", endpoint)
	}, request)
}
