package hostsoverrideipc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"

	"dolssh/services/ssh-core/internal/hostsoverride"
)

type ServeConfig struct {
	AuthToken     string
	HostsFilePath string
}

func Serve(ctx context.Context, cancel context.CancelFunc, listener net.Listener, config ServeConfig) error {
	var (
		wg sync.WaitGroup
		mu sync.Mutex
	)

	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				break
			}
			return fmt.Errorf("accept helper connection: %w", err)
		}

		wg.Add(1)
		go func(conn net.Conn) {
			defer wg.Done()
			defer conn.Close()
			serveConn(conn, config, cancel, &mu)
		}(conn)
	}

	wg.Wait()
	return nil
}

func serveConn(conn net.Conn, config ServeConfig, cancel context.CancelFunc, mu *sync.Mutex) {
	reader := bufio.NewReader(conn)
	decoder := json.NewDecoder(reader)
	encoder := json.NewEncoder(conn)

	for {
		var request Request
		if err := decoder.Decode(&request); err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			_ = encoder.Encode(Response{OK: false, Error: fmt.Sprintf("decode request: %v", err)})
			return
		}

		response, shouldShutdown := handleRequest(request, config, mu)
		if err := encoder.Encode(response); err != nil {
			return
		}
		if shouldShutdown {
			cancel()
			return
		}
	}
}

func handleRequest(request Request, config ServeConfig, mu *sync.Mutex) (Response, bool) {
	if request.AuthToken != config.AuthToken {
		return Response{OK: false, Error: "unauthorized"}, false
	}

	resolvePath := func() string {
		if request.HostsFilePath != "" {
			return request.HostsFilePath
		}
		return config.HostsFilePath
	}

	switch request.Command {
	case CommandPing:
		return Response{OK: true}, false
	case CommandRewriteBlock:
		hostsFilePath := resolvePath()
		if hostsFilePath == "" {
			return Response{OK: false, Error: "hostsFilePath is required"}, false
		}
		mu.Lock()
		err := hostsoverride.RewriteManagedHostsFile(hostsFilePath, request.Entries)
		mu.Unlock()
		if err != nil {
			return Response{OK: false, Error: err.Error()}, false
		}
		return Response{OK: true}, false
	case CommandClearBlock:
		hostsFilePath := resolvePath()
		if hostsFilePath == "" {
			return Response{OK: false, Error: "hostsFilePath is required"}, false
		}
		mu.Lock()
		err := hostsoverride.ClearManagedHostsFile(hostsFilePath)
		mu.Unlock()
		if err != nil {
			return Response{OK: false, Error: err.Error()}, false
		}
		return Response{OK: true}, false
	case CommandReadHosts:
		hostsFilePath := resolvePath()
		if hostsFilePath == "" {
			return Response{OK: false, Error: "hostsFilePath is required"}, false
		}
		mu.Lock()
		content, err := hostsoverride.ReadHostsFile(hostsFilePath)
		mu.Unlock()
		if err != nil {
			return Response{OK: false, Error: err.Error()}, false
		}
		return Response{OK: true, HostsFileContent: content}, false
	case CommandShutdown:
		return Response{OK: true}, true
	default:
		return Response{OK: false, Error: fmt.Sprintf("unsupported command: %s", request.Command)}, false
	}
}
