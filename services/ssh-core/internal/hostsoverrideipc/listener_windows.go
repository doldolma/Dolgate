//go:build windows

package hostsoverrideipc

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

const helperPipeSecurityDescriptor = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)"

func Listen(endpoint string) (net.Listener, error) {
	return winio.ListenPipe(endpoint, &winio.PipeConfig{
		SecurityDescriptor: helperPipeSecurityDescriptor,
	})
}

func SendRequest(ctx context.Context, endpoint string, request Request) (Response, error) {
	return sendRequestWithDialer(func() (net.Conn, error) {
		return winio.DialPipeContext(ctx, endpoint)
	}, request)
}
