//go:build !windows

package hostsoverrideipc

import (
	"context"
	"fmt"
	"net"
	"os"
	"runtime"
)

type cleanupListener struct {
	net.Listener
	endpoint string
}

const darwinUnixSocketPathMaxLength = 103

func (l *cleanupListener) Close() error {
	err := l.Listener.Close()
	_ = os.Remove(l.endpoint)
	return err
}

func Listen(endpoint string) (net.Listener, error) {
	if runtime.GOOS == "darwin" && len(endpoint) > darwinUnixSocketPathMaxLength {
		return nil, fmt.Errorf(
			"unix socket path too long for darwin (%d > %d): %s",
			len(endpoint),
			darwinUnixSocketPathMaxLength,
			endpoint,
		)
	}
	_ = os.Remove(endpoint)
	listener, err := net.Listen("unix", endpoint)
	if err != nil {
		return nil, fmt.Errorf("listen unix %s: %w", endpoint, err)
	}
	_ = os.Chmod(endpoint, socketFileMode(runtime.GOOS))
	return &cleanupListener{Listener: listener, endpoint: endpoint}, nil
}

func SendRequest(_ context.Context, endpoint string, request Request) (Response, error) {
	return sendRequestWithDialer(func() (net.Conn, error) {
		return net.Dial("unix", endpoint)
	}, request)
}
