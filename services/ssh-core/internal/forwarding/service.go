package forwarding

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshconn"
)

type EventEmitter func(protocol.Event)

type runtimeHandle struct {
	client   *ssh.Client
	listener net.Listener
	cancel   context.CancelFunc
	closer   sync.Once
}

type Service struct {
	mu       sync.RWMutex
	runtimes map[string]*runtimeHandle
	emit     EventEmitter
}

func New(emit EventEmitter) *Service {
	return &Service{
		runtimes: make(map[string]*runtimeHandle),
		emit:     emit,
	}
}

func (s *Service) Shutdown() {
	s.mu.Lock()
	runtimes := make([]*runtimeHandle, 0, len(s.runtimes))
	for _, handle := range s.runtimes {
		runtimes = append(runtimes, handle)
	}
	s.runtimes = make(map[string]*runtimeHandle)
	s.mu.Unlock()

	for _, handle := range runtimes {
		handle.close()
	}
}

func (s *Service) Start(ruleID, requestID string, payload protocol.PortForwardStartPayload) error {
	if ruleID == "" {
		return fmt.Errorf("forward runtime id is required")
	}

	s.mu.RLock()
	_, exists := s.runtimes[ruleID]
	s.mu.RUnlock()
	if exists {
		return fmt.Errorf("port forward %s is already running", ruleID)
	}

	client, err := sshconn.DialClient(sshconn.Target{
		Host:                 payload.Host,
		Port:                 payload.Port,
		Username:             payload.Username,
		AuthType:             payload.AuthType,
		Password:             payload.Password,
		PrivateKeyPEM:        payload.PrivateKeyPEM,
		PrivateKeyPath:       payload.PrivateKeyPath,
		Passphrase:           payload.Passphrase,
		TrustedHostKeyBase64: payload.TrustedHostKeyBase64,
	}, sshconn.DefaultConfig, nil)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	handle := &runtimeHandle{
		client: client,
		cancel: cancel,
	}

	bindAddress := payload.BindAddress
	if bindAddress == "" {
		bindAddress = "127.0.0.1"
	}

	switch payload.Mode {
	case "local", "dynamic":
		listener, listenErr := net.Listen("tcp", fmt.Sprintf("%s:%d", bindAddress, payload.BindPort))
		if listenErr != nil {
			cancel()
			_ = client.Close()
			return fmt.Errorf("open local listener: %w", listenErr)
		}
		handle.listener = listener
	case "remote":
		listener, listenErr := client.Listen("tcp", fmt.Sprintf("%s:%d", bindAddress, payload.BindPort))
		if listenErr != nil {
			cancel()
			_ = client.Close()
			return fmt.Errorf("open remote listener: %w", listenErr)
		}
		handle.listener = listener
	default:
		cancel()
		_ = client.Close()
		return fmt.Errorf("unsupported forwarding mode: %s", payload.Mode)
	}

	s.mu.Lock()
	s.runtimes[ruleID] = handle
	s.mu.Unlock()

	actualBindAddress, actualBindPort := parseListenerAddress(handle.listener, bindAddress)
	s.emit(protocol.Event{
		Type:       protocol.EventPortForwardStarted,
		RequestID:  requestID,
		EndpointID: ruleID,
		Payload: protocol.PortForwardStartedPayload{
			Status:      "running",
			Mode:        payload.Mode,
			BindAddress: actualBindAddress,
			BindPort:    actualBindPort,
		},
	})

	switch payload.Mode {
	case "local":
		go s.runLocal(ctx, ruleID, handle.listener, client, payload.TargetHost, payload.TargetPort)
	case "remote":
		go s.runRemote(ctx, ruleID, handle.listener, payload.TargetHost, payload.TargetPort)
	case "dynamic":
		go s.runDynamic(ctx, ruleID, handle.listener, client)
	}

	return nil
}

func (s *Service) Stop(ruleID, requestID string) error {
	handle := s.removeRuntime(ruleID)
	if handle != nil {
		handle.close()
	}

	s.emit(protocol.Event{
		Type:       protocol.EventPortForwardStopped,
		RequestID:  requestID,
		EndpointID: ruleID,
		Payload: protocol.AckPayload{
			Message: "port forward stopped",
		},
	})
	return nil
}

func (s *Service) runLocal(ctx context.Context, ruleID string, listener net.Listener, client *ssh.Client, targetHost string, targetPort int) {
	targetAddress := net.JoinHostPort(targetHost, strconv.Itoa(targetPort))
	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			s.failRuntime(ruleID, fmt.Errorf("accept local connection: %w", err))
			return
		}

		go func(localConn net.Conn) {
			remoteConn, dialErr := client.Dial("tcp", targetAddress)
			if dialErr != nil {
				_ = localConn.Close()
				return
			}
			pipeBidirectional(localConn, remoteConn)
		}(conn)
	}
}

func (s *Service) runRemote(ctx context.Context, ruleID string, listener net.Listener, targetHost string, targetPort int) {
	targetAddress := net.JoinHostPort(targetHost, strconv.Itoa(targetPort))
	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			s.failRuntime(ruleID, fmt.Errorf("accept remote connection: %w", err))
			return
		}

		go func(remoteConn net.Conn) {
			localConn, dialErr := net.Dial("tcp", targetAddress)
			if dialErr != nil {
				_ = remoteConn.Close()
				return
			}
			pipeBidirectional(remoteConn, localConn)
		}(conn)
	}
}

func (s *Service) runDynamic(ctx context.Context, ruleID string, listener net.Listener, client *ssh.Client) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			s.failRuntime(ruleID, fmt.Errorf("accept dynamic connection: %w", err))
			return
		}

		go func(localConn net.Conn) {
			if err := handleSOCKS5(localConn, client); err != nil {
				_ = localConn.Close()
			}
		}(conn)
	}
}

func (s *Service) failRuntime(ruleID string, err error) {
	handle := s.removeRuntime(ruleID)
	if handle != nil {
		handle.close()
	}
	s.emit(protocol.Event{
		Type:       protocol.EventPortForwardError,
		EndpointID: ruleID,
		Payload: protocol.ErrorPayload{
			Message: err.Error(),
		},
	})
}

func (s *Service) removeRuntime(ruleID string) *runtimeHandle {
	s.mu.Lock()
	defer s.mu.Unlock()
	handle := s.runtimes[ruleID]
	delete(s.runtimes, ruleID)
	return handle
}

func (h *runtimeHandle) close() {
	h.closer.Do(func() {
		if h.cancel != nil {
			h.cancel()
		}
		if h.listener != nil {
			_ = h.listener.Close()
		}
		if h.client != nil {
			_ = h.client.Close()
		}
	})
}

func pipeBidirectional(left net.Conn, right net.Conn) {
	var once sync.Once
	closeBoth := func() {
		_ = left.Close()
		_ = right.Close()
	}

	go func() {
		_, _ = io.Copy(left, right)
		once.Do(closeBoth)
	}()

	go func() {
		_, _ = io.Copy(right, left)
		once.Do(closeBoth)
	}()
}

func parseListenerAddress(listener net.Listener, fallbackHost string) (string, int) {
	host, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		return fallbackHost, 0
	}
	port, convErr := strconv.Atoi(portText)
	if convErr != nil {
		return host, 0
	}
	if host == "" {
		host = fallbackHost
	}
	return host, port
}

func handleSOCKS5(localConn net.Conn, client *ssh.Client) error {
	header := make([]byte, 2)
	if _, err := io.ReadFull(localConn, header); err != nil {
		return err
	}
	if header[0] != 0x05 {
		return fmt.Errorf("unsupported socks version: %d", header[0])
	}

	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(localConn, methods); err != nil {
		return err
	}
	if _, err := localConn.Write([]byte{0x05, 0x00}); err != nil {
		return err
	}

	requestHeader := make([]byte, 4)
	if _, err := io.ReadFull(localConn, requestHeader); err != nil {
		return err
	}
	if requestHeader[0] != 0x05 || requestHeader[1] != 0x01 {
		_, _ = localConn.Write([]byte{0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return fmt.Errorf("unsupported socks command")
	}

	address, err := readSOCKSAddress(localConn, requestHeader[3])
	if err != nil {
		_, _ = localConn.Write([]byte{0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return err
	}

	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(localConn, portBytes); err != nil {
		return err
	}
	targetAddress := net.JoinHostPort(address, strconv.Itoa(int(binary.BigEndian.Uint16(portBytes))))

	remoteConn, err := client.Dial("tcp", targetAddress)
	if err != nil {
		_, _ = localConn.Write([]byte{0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return err
	}

	if _, err := localConn.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0}); err != nil {
		_ = remoteConn.Close()
		return err
	}

	pipeBidirectional(localConn, remoteConn)
	return nil
}

func readSOCKSAddress(r io.Reader, atyp byte) (string, error) {
	switch atyp {
	case 0x01:
		address := make([]byte, 4)
		if _, err := io.ReadFull(r, address); err != nil {
			return "", err
		}
		return net.IP(address).String(), nil
	case 0x03:
		length := make([]byte, 1)
		if _, err := io.ReadFull(r, length); err != nil {
			return "", err
		}
		address := make([]byte, int(length[0]))
		if _, err := io.ReadFull(r, address); err != nil {
			return "", err
		}
		return string(address), nil
	case 0x04:
		address := make([]byte, 16)
		if _, err := io.ReadFull(r, address); err != nil {
			return "", err
		}
		return net.IP(address).String(), nil
	default:
		return "", fmt.Errorf("unsupported socks address type: %d", atyp)
	}
}
