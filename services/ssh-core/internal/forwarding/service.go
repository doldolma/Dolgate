package forwarding

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshconn"
)

type EventEmitter func(protocol.Event)

type runtimeMethod string

const (
	runtimeMethodSSHNative       runtimeMethod = "ssh-native"
	runtimeMethodSSHSessionProxy runtimeMethod = "ssh-session-proxy"
)

const sessionProxyPythonScript = "import os,socket,sys,threading\nhost=sys.argv[1]\nport=int(sys.argv[2])\nsock=socket.create_connection((host,port))\ntry:\n sock.setsockopt(socket.IPPROTO_TCP,socket.TCP_NODELAY,1)\nexcept Exception:\n pass\ndef pump_stdin():\n try:\n  while True:\n   data=os.read(0,65536)\n   if not data:\n    break\n   sock.sendall(data)\n except Exception:\n  pass\n try:\n  sock.shutdown(socket.SHUT_WR)\n except Exception:\n  pass\nthreading.Thread(target=pump_stdin,daemon=True).start()\ntry:\n while True:\n  data=sock.recv(65536)\n  if not data:\n   break\n  os.write(1,data)\nfinally:\n try:\n  sock.close()\n except Exception:\n  pass\n"

type runtimeHandle struct {
	client           *ssh.Client
	listener         net.Listener
	cancel           context.CancelFunc
	closer           sync.Once
	mu               sync.RWMutex
	method           runtimeMethod
	bindAddress      string
	bindPort         int
	proxyInterpreter string
	activeConns      map[net.Conn]struct{}
}

type pendingChallenge struct {
	endpointID string
	responses  chan []string
}

type Service struct {
	mu                sync.RWMutex
	runtimes          map[string]*runtimeHandle
	pendingChallenges map[string]*pendingChallenge
	emit              EventEmitter
	dialRemote        func(client *ssh.Client, address string) (net.Conn, error)
	openSessionProxy  func(handle *runtimeHandle, targetHost string, targetPort int) (io.ReadWriteCloser, error)
}

func New(emit EventEmitter) *Service {
	return &Service{
		runtimes:          make(map[string]*runtimeHandle),
		pendingChallenges: make(map[string]*pendingChallenge),
		emit:              emit,
		dialRemote: func(client *ssh.Client, address string) (net.Conn, error) {
			return client.Dial("tcp", address)
		},
	}
}

func (s *Service) Shutdown() {
	s.mu.Lock()
	runtimes := make([]*runtimeHandle, 0, len(s.runtimes))
	for _, handle := range s.runtimes {
		runtimes = append(runtimes, handle)
	}
	s.runtimes = make(map[string]*runtimeHandle)

	challenges := make([]*pendingChallenge, 0, len(s.pendingChallenges))
	for _, challenge := range s.pendingChallenges {
		challenges = append(challenges, challenge)
	}
	s.pendingChallenges = make(map[string]*pendingChallenge)
	s.mu.Unlock()

	for _, handle := range runtimes {
		handle.close()
	}
	for _, challenge := range challenges {
		close(challenge.responses)
	}
}

func (s *Service) RespondKeyboardInteractive(endpointID, challengeID string, responses []string) error {
	s.mu.Lock()
	challenge, ok := s.pendingChallenges[challengeID]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("keyboard-interactive challenge %s not found for endpoint %s", challengeID, endpointID)
	}
	if challenge.endpointID != endpointID {
		return fmt.Errorf("keyboard-interactive challenge %s does not belong to endpoint %s", challengeID, endpointID)
	}

	select {
	case challenge.responses <- responses:
		return nil
	default:
		return fmt.Errorf("keyboard-interactive challenge %s already has a pending response", challengeID)
	}
}

func (s *Service) Start(ruleID, requestID string, payload protocol.PortForwardStartPayload) error {
	client, err := s.dialTarget(ruleID, requestID, sshconn.Target{
		Host:                  payload.Host,
		Port:                  payload.Port,
		Username:              payload.Username,
		AuthType:              payload.AuthType,
		Password:              payload.Password,
		PrivateKeyPEM:         payload.PrivateKeyPEM,
		CertificateText:       payload.CertificateText,
		Passphrase:            payload.Passphrase,
		TrustedHostKeyBase64:  payload.TrustedHostKeyBase64,
		TrustedHostKeysBase64: payload.TrustedHostKeysBase64,
	})
	if err != nil {
		return err
	}
	return s.startWithClient(ruleID, requestID, payload, client)
}

func (s *Service) StartWithClient(
	ruleID, requestID string,
	payload protocol.PortForwardStartPayload,
	client *ssh.Client,
) error {
	if client == nil {
		return fmt.Errorf("ssh client is required")
	}
	return s.startWithClient(ruleID, requestID, payload, client)
}

func (s *Service) startWithClient(
	ruleID, requestID string,
	payload protocol.PortForwardStartPayload,
	client *ssh.Client,
) error {
	if ruleID == "" {
		return fmt.Errorf("forward runtime id is required")
	}

	s.mu.RLock()
	_, exists := s.runtimes[ruleID]
	s.mu.RUnlock()
	if exists {
		return fmt.Errorf("port forward %s is already running", ruleID)
	}

	ctx, cancel := context.WithCancel(context.Background())
	handle := &runtimeHandle{
		client:      client,
		cancel:      cancel,
		method:      runtimeMethodSSHNative,
		activeConns: make(map[net.Conn]struct{}),
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
	handle.bindAddress = actualBindAddress
	handle.bindPort = actualBindPort
	s.emit(protocol.Event{
		Type:       protocol.EventPortForwardStarted,
		RequestID:  requestID,
		EndpointID: ruleID,
		Payload: protocol.PortForwardStartedPayload{
			Transport:   "ssh",
			Status:      "running",
			Mode:        payload.Mode,
			Method:      string(runtimeMethodSSHNative),
			BindAddress: actualBindAddress,
			BindPort:    actualBindPort,
		},
	})

	switch payload.Mode {
	case "local":
		go s.runLocal(ctx, ruleID, handle, payload.TargetHost, payload.TargetPort)
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
	for _, challenge := range s.removePendingChallengesForEndpoint(ruleID) {
		close(challenge.responses)
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

func (s *Service) dialTarget(endpointID, requestID string, target sshconn.Target) (*ssh.Client, error) {
	attempt := 0
	return sshconn.DialClient(target, sshconn.DefaultConfig, func(challenge sshconn.InteractiveChallenge) ([]string, error) {
		attempt += 1
		challengeID := fmt.Sprintf("%s-%d", endpointID, attempt)
		responseCh := make(chan []string, 1)

		s.mu.Lock()
		s.pendingChallenges[challengeID] = &pendingChallenge{
			endpointID: endpointID,
			responses:  responseCh,
		}
		s.mu.Unlock()
		defer func() {
			s.mu.Lock()
			delete(s.pendingChallenges, challengeID)
			s.mu.Unlock()
		}()

		prompts := make([]protocol.KeyboardInteractivePrompt, 0, len(challenge.Prompts))
		for _, prompt := range challenge.Prompts {
			prompts = append(prompts, protocol.KeyboardInteractivePrompt{
				Label: prompt.Label,
				Echo:  prompt.Echo,
			})
		}

		s.emit(protocol.Event{
			Type:       protocol.EventKeyboardInteractiveChallenge,
			RequestID:  requestID,
			EndpointID: endpointID,
			Payload: protocol.KeyboardInteractiveChallengePayload{
				ChallengeID: challengeID,
				Attempt:     attempt,
				Name:        challenge.Name,
				Instruction: challenge.Instruction,
				Prompts:     prompts,
			},
		})

		responses, ok := <-responseCh
		if !ok {
			return nil, fmt.Errorf("keyboard-interactive challenge was cancelled")
		}

		s.emit(protocol.Event{
			Type:       protocol.EventKeyboardInteractiveResolved,
			RequestID:  requestID,
			EndpointID: endpointID,
			Payload: map[string]any{
				"challengeId": challengeID,
			},
		})
		return responses, nil
	})
}

func (s *Service) runLocal(ctx context.Context, ruleID string, handle *runtimeHandle, targetHost string, targetPort int) {
	listener := handle.listener
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

		trackedLocalConn := newTrackedConn(conn, func() {
			handle.untrackConn(conn)
		})
		handle.trackConn(conn)
		go func(localConn net.Conn) {
			if handle.currentMethod() == runtimeMethodSSHSessionProxy {
				if err := s.proxyLocalConnection(handle, localConn, targetHost, targetPort); err != nil {
					_ = localConn.Close()
				}
				return
			}

			remoteConn, dialErr := s.dialRemote(handle.client, targetAddress)
			if dialErr == nil {
				pipeBidirectional(localConn, remoteConn)
				return
			}
			if !isForwardDeniedError(dialErr) {
				_ = localConn.Close()
				return
			}

			if promoted := handle.promoteMethod(runtimeMethodSSHSessionProxy); promoted {
				s.emit(protocol.Event{
					Type:       protocol.EventPortForwardStarted,
					EndpointID: ruleID,
					Payload: protocol.PortForwardStartedPayload{
						Transport:   "ssh",
						Status:      "running",
						Mode:        "local",
						Method:      string(runtimeMethodSSHSessionProxy),
						BindAddress: handle.bindAddress,
						BindPort:    handle.bindPort,
						Message:     "SSH fallback active",
					},
				})
			}

			if err := s.proxyLocalConnection(handle, localConn, targetHost, targetPort); err != nil {
				_ = localConn.Close()
			}
		}(trackedLocalConn)
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

func (s *Service) removePendingChallengesForEndpoint(endpointID string) []*pendingChallenge {
	s.mu.Lock()
	defer s.mu.Unlock()
	var matches []*pendingChallenge
	for challengeID, challenge := range s.pendingChallenges {
		if challenge.endpointID != endpointID {
			continue
		}
		matches = append(matches, challenge)
		delete(s.pendingChallenges, challengeID)
	}
	return matches
}

func (h *runtimeHandle) close() {
	h.closer.Do(func() {
		if h.cancel != nil {
			h.cancel()
		}
		h.mu.Lock()
		activeConns := make([]net.Conn, 0, len(h.activeConns))
		for conn := range h.activeConns {
			activeConns = append(activeConns, conn)
		}
		h.activeConns = make(map[net.Conn]struct{})
		h.mu.Unlock()
		for _, conn := range activeConns {
			_ = conn.Close()
		}
		if h.listener != nil {
			_ = h.listener.Close()
		}
		if h.client != nil {
			_ = h.client.Close()
		}
	})
}

func (h *runtimeHandle) currentMethod() runtimeMethod {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.method
}

func (h *runtimeHandle) promoteMethod(next runtimeMethod) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.method == next {
		return false
	}
	h.method = next
	return true
}

func (h *runtimeHandle) trackConn(conn net.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.activeConns == nil {
		h.activeConns = make(map[net.Conn]struct{})
	}
	h.activeConns[conn] = struct{}{}
}

func (h *runtimeHandle) untrackConn(conn net.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.activeConns, conn)
}

func (h *runtimeHandle) proxyInterpreterPath() string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.proxyInterpreter
}

func (h *runtimeHandle) setProxyInterpreterPath(value string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.proxyInterpreter = value
}

type readWriteCloser interface {
	io.Reader
	io.Writer
	io.Closer
}

type trackedConn struct {
	net.Conn
	onClose func()
	once    sync.Once
}

func newTrackedConn(conn net.Conn, onClose func()) net.Conn {
	return &trackedConn{
		Conn:    conn,
		onClose: onClose,
	}
}

func (c *trackedConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() {
		if c.onClose != nil {
			c.onClose()
		}
	})
	return err
}

func pipeBidirectional(left readWriteCloser, right readWriteCloser) {
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

func isForwardDeniedError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "administratively prohibited") ||
		strings.Contains(text, "open failed")
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

func (s *Service) proxyLocalConnection(
	handle *runtimeHandle,
	localConn net.Conn,
	targetHost string,
	targetPort int,
) error {
	opener := s.openSessionProxy
	if opener == nil {
		opener = s.openSessionProxyDefault
	}
	remoteStream, err := opener(handle, targetHost, targetPort)
	if err != nil {
		return err
	}
	pipeBidirectional(localConn, remoteStream)
	return nil
}

func (s *Service) openSessionProxyDefault(
	handle *runtimeHandle,
	targetHost string,
	targetPort int,
) (io.ReadWriteCloser, error) {
	interpreterPath, err := s.resolveProxyInterpreter(handle)
	if err != nil {
		return nil, err
	}

	session, err := handle.client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("open proxy session: %w", err)
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		return nil, fmt.Errorf("open proxy stdin: %w", err)
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		_ = session.Close()
		return nil, fmt.Errorf("open proxy stdout: %w", err)
	}
	var stderr bytes.Buffer
	session.Stderr = &stderr

	command := buildSessionProxyCommand(interpreterPath, targetHost, targetPort)
	if err := session.Start(command); err != nil {
		_ = stdin.Close()
		_ = session.Close()
		return nil, fmt.Errorf("start proxy session: %w", err)
	}

	return &sessionProxyStream{
		session: session,
		stdin:   stdin,
		stdout:  stdout,
		stderr:  &stderr,
	}, nil
}

func (s *Service) resolveProxyInterpreter(handle *runtimeHandle) (string, error) {
	if cached := handle.proxyInterpreterPath(); cached != "" {
		return cached, nil
	}

	session, err := handle.client.NewSession()
	if err != nil {
		return "", fmt.Errorf("open python probe session: %w", err)
	}
	defer func() {
		_ = session.Close()
	}()

	output, err := session.CombinedOutput("command -v python3 || command -v python")
	if err != nil {
		return "", fmt.Errorf("python runtime probe failed: %w", err)
	}
	interpreterPath := strings.TrimSpace(string(output))
	if interpreterPath == "" {
		return "", fmt.Errorf("python3 또는 python runtime을 찾지 못했습니다.")
	}

	handle.setProxyInterpreterPath(interpreterPath)
	return interpreterPath, nil
}

func buildSessionProxyCommand(interpreterPath, targetHost string, targetPort int) string {
	return fmt.Sprintf(
		"%s -u -c %s %s %s",
		shellQuote(interpreterPath),
		shellQuote(sessionProxyPythonScript),
		shellQuote(targetHost),
		shellQuote(strconv.Itoa(targetPort)),
	)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

type sessionProxyStream struct {
	session *ssh.Session
	stdin   io.WriteCloser
	stdout  io.Reader
	stderr  *bytes.Buffer
	closer  sync.Once
}

func (s *sessionProxyStream) Read(p []byte) (int, error) {
	return s.stdout.Read(p)
}

func (s *sessionProxyStream) Write(p []byte) (int, error) {
	return s.stdin.Write(p)
}

func (s *sessionProxyStream) Close() error {
	var closeErr error
	s.closer.Do(func() {
		if s.stdin != nil {
			if err := s.stdin.Close(); err != nil && closeErr == nil {
				closeErr = err
			}
		}
		if s.session != nil {
			if err := s.session.Close(); err != nil && closeErr == nil {
				closeErr = err
			}
		}
	})
	return closeErr
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
