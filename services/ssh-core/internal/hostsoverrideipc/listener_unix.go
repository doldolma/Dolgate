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

func socketFileMode(goos string) os.FileMode {
	if goos == "darwin" {
		// macOS에서는 권한 상승된 helper(root)가 socket을 만들고,
		// 원래 앱 프로세스(user)가 다시 연결해야 한다.
		// socket 자체는 auth token으로 보호되고, 상위 temp dir은 user-private(0700)라서
		// darwin에서는 재연결 가능한 mode를 사용한다.
		return 0o666
	}
	return 0o600
}

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
