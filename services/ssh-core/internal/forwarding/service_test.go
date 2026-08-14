package forwarding

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/protocol"
)

type stubAddr string

func (a stubAddr) Network() string { return "tcp" }
func (a stubAddr) String() string  { return string(a) }

type stubListener struct {
	addr   net.Addr
	closed bool
}

func (l *stubListener) Accept() (net.Conn, error) { return nil, errors.New("not implemented") }
func (l *stubListener) Close() error {
	l.closed = true
	return nil
}
func (l *stubListener) Addr() net.Addr { return l.addr }

func TestServiceStopClosesRuntimeAndEmitsStopped(t *testing.T) {
	var emitted []protocol.Event
	service := New(func(event protocol.Event) {
		emitted = append(emitted, event)
	})
	listener := &stubListener{addr: stubAddr("127.0.0.1:9000")}
	service.runtimes["rule-1"] = &runtimeHandle{
		listener: listener,
	}

	if err := service.Stop("rule-1", "req-1"); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}

	if !listener.closed {
		t.Fatal("listener.closed = false, want true")
	}
	if _, exists := service.runtimes["rule-1"]; exists {
		t.Fatal("runtime still present after Stop()")
	}
	if len(emitted) != 1 || emitted[0].Type != protocol.EventPortForwardStopped {
		t.Fatalf("emitted = %+v, want single stopped event", emitted)
	}
}

func TestServiceFailRuntimeRemovesRuntimeAndEmitsError(t *testing.T) {
	var emitted []protocol.Event
	service := New(func(event protocol.Event) {
		emitted = append(emitted, event)
	})
	listener := &stubListener{addr: stubAddr("127.0.0.1:9001")}
	service.runtimes["rule-2"] = &runtimeHandle{
		listener: listener,
	}

	service.failRuntime("rule-2", errors.New("accept local connection: boom"))

	if !listener.closed {
		t.Fatal("listener.closed = false, want true")
	}
	if _, exists := service.runtimes["rule-2"]; exists {
		t.Fatal("runtime still present after failRuntime()")
	}
	if len(emitted) != 1 || emitted[0].Type != protocol.EventPortForwardError {
		t.Fatalf("emitted = %+v, want single error event", emitted)
	}
}

func TestParseListenerAddressFallsBackOnMalformedAddr(t *testing.T) {
	host, port := parseListenerAddress(&stubListener{addr: stubAddr("malformed-address")}, "127.0.0.1")
	if host != "127.0.0.1" || port != 0 {
		t.Fatalf("parseListenerAddress() = (%q, %d), want (%q, 0)", host, port, "127.0.0.1")
	}
}

func TestRunLocalFallsBackToSessionProxyAndKeepsUsingIt(t *testing.T) {
	var (
		emitted      []protocol.Event
		emittedMu    sync.Mutex
		dialAttempts int
	)
	service := New(func(event protocol.Event) {
		emittedMu.Lock()
		defer emittedMu.Unlock()
		emitted = append(emitted, event)
	})
	service.dialRemote = func(_ *ssh.Client, _ string) (net.Conn, error) {
		dialAttempts += 1
		return nil, errors.New("ssh: rejected: administratively prohibited (open failed)")
	}

	proxyServerConns := make(chan net.Conn, 2)
	service.openSessionProxy = func(_ *runtimeHandle, _ string, _ int) (io.ReadWriteCloser, error) {
		clientConn, serverConn := net.Pipe()
		proxyServerConns <- serverConn
		return clientConn, nil
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	handle := &runtimeHandle{
		listener:    listener,
		method:      runtimeMethodSSHNative,
		bindAddress: "127.0.0.1",
		bindPort:    listener.Addr().(*net.TCPAddr).Port,
		activeConns: make(map[net.Conn]struct{}),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go service.runLocal(ctx, "rule-fallback", handle, "172.17.0.5", 3306)
	defer handle.close()

	firstClient, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatalf("Dial(first) error = %v", err)
	}
	defer firstClient.Close()

	firstProxy := <-proxyServerConns
	defer firstProxy.Close()

	if _, err := firstProxy.Write([]byte("hello")); err != nil {
		t.Fatalf("proxy write error = %v", err)
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(firstClient, buf); err != nil {
		t.Fatalf("client read error = %v", err)
	}
	if string(buf) != "hello" {
		t.Fatalf("client received %q, want hello", string(buf))
	}

	if _, err := firstClient.Write([]byte("ping")); err != nil {
		t.Fatalf("client write error = %v", err)
	}
	buf = make([]byte, 4)
	if _, err := io.ReadFull(firstProxy, buf); err != nil {
		t.Fatalf("proxy read error = %v", err)
	}
	if string(buf) != "ping" {
		t.Fatalf("proxy received %q, want ping", string(buf))
	}

	secondClient, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatalf("Dial(second) error = %v", err)
	}
	defer secondClient.Close()
	secondProxy := <-proxyServerConns
	defer secondProxy.Close()

	if dialAttempts != 1 {
		t.Fatalf("dialAttempts = %d, want 1", dialAttempts)
	}
	if handle.currentMethod() != runtimeMethodSSHSessionProxy {
		t.Fatalf("method = %s, want %s", handle.currentMethod(), runtimeMethodSSHSessionProxy)
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		emittedMu.Lock()
		hasFallbackEvent := false
		for _, event := range emitted {
			if event.Type != protocol.EventPortForwardStarted {
				continue
			}
			payload, ok := event.Payload.(protocol.PortForwardStartedPayload)
			if ok && payload.Method == string(runtimeMethodSSHSessionProxy) {
				hasFallbackEvent = true
				break
			}
		}
		emittedMu.Unlock()
		if hasFallbackEvent {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for fallback event")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestBuildSessionProxyCommandQuotesArguments(t *testing.T) {
	command := buildSessionProxyCommand("/usr/bin/python3", "db.internal", 3306)
	if !strings.Contains(command, "'/usr/bin/python3' -u -c ") {
		t.Fatalf("command = %q, want quoted interpreter", command)
	}
	if strings.Contains(command, " -- ") {
		t.Fatalf("command = %q, must not inject '--' before host/port args", command)
	}
	if !strings.Contains(command, "'db.internal' '3306'") {
		t.Fatalf("command = %q, want quoted target host/port", command)
	}
}

// 붙는 중에 정지를 누르면 즉시 끝나야 한다.
//
// 실기기 증상: 포워딩이 `starting` 에 머무는 동안 stop 을 눌러도 아무 반응이 없었다. 프레임이
// 도달하지 못한 것이 1차 원인이었고(라우터가 해결), 도달해도 dial·핸드셰이크를 끊을 방법이 없었다 —
// 사람의 답을 기다리는 구간만 대기표를 닫아 풀 수 있었다. 여기서는 **응답하지 않는 서버**로
// 붙는 중에(=기계를 기다리는 구간) 정지가 듣는지를 본다.
func TestStopEndsAConnectThatIsStillDialing(t *testing.T) {
	// TCP 는 받아 주지만 SSH 로는 한 마디도 하지 않는 서버. 핸드셰이크가 그대로 멈춘다.
	silent, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	defer silent.Close()
	go func() {
		for {
			conn, err := silent.Accept()
			if err != nil {
				return
			}
			// 닫지도, 쓰지도 않는다.
			defer conn.Close()
		}
	}()
	_, portText, _ := net.SplitHostPort(silent.Addr().String())
	port, _ := strconv.Atoi(portText)

	service := New(func(protocol.Event) {})
	done := make(chan error, 1)
	go func() {
		done <- service.Start("rule-1", "req-1", protocol.PortForwardStartPayload{
			Host:                 "127.0.0.1",
			Port:                 port,
			Username:             "ubuntu",
			AuthType:             "password",
			Password:             "pw",
			TrustedHostKeyBase64: "AAAATEST",
			Mode:                 "local",
			BindAddress:          "127.0.0.1",
			BindPort:             0,
			TargetHost:           "127.0.0.1",
			TargetPort:           1,
		})
	}()

	// 붙는 중인 것을 확인한 뒤 정지한다.
	waitForInflight(t, service, "rule-1")
	if err := service.Stop("rule-1", "req-2"); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("정지했는데 연결이 성공으로 끝났다")
		}
	case <-time.After(3 * time.Second):
		// 핸드셰이크 정지 감시(10초)보다 훨씬 빨리 끝나야 한다 — 정지가 실제로 끊었다는 뜻이다.
		t.Fatal("정지가 붙는 중인 연결을 끊지 못했다")
	}
}

// waitForInflight 는 그 규칙의 연결이 등록될 때까지 기다린다.
func waitForInflight(t *testing.T, service *Service, ruleID string) {
	t.Helper()
	for attempt := 0; attempt < 200; attempt += 1 {
		if service.starting.Has(ruleID) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("연결이 시작되지 않았다")
}

// otpTestServer 는 keyboard-interactive 로 코드를 묻는 서버다(실기기의 OTP 호스트).
func otpTestServer(t *testing.T) (port int, hostKey string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	config := &ssh.ServerConfig{
		KeyboardInteractiveCallback: func(
			_ ssh.ConnMetadata,
			challenge ssh.KeyboardInteractiveChallenge,
		) (*ssh.Permissions, error) {
			// 코드를 묻고 답을 기다린다 — 클라이언트 쪽 responder 가 사람을 기다리게 된다.
			if _, err := challenge("", "", []string{"Verification code:"}, []bool{false}); err != nil {
				return nil, err
			}
			return nil, nil
		},
	}
	config.AddHostKey(signer)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				conn, chans, reqs, err := ssh.NewServerConn(raw, config)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				go func() {
					for newChannel := range chans {
						_ = newChannel.Reject(ssh.UnknownChannelType, "unsupported")
					}
				}()
				_ = conn.Wait()
			}()
		}
	}()
	_, portText, _ := net.SplitHostPort(listener.Addr().String())
	parsed, _ := strconv.Atoi(portText)
	return parsed, base64.StdEncoding.EncodeToString(signer.PublicKey().Marshal())
}

// 사람의 답을 기다리는 중에도 정지가 그 연결을 끊어야 한다.
//
// 실기기 증상: OTP 호스트로 포워딩을 시작하면 `starting` 에서 멈추고 stop 이 아무 반응이 없었다.
// 이때 연결은 **채널 대기**(사용자의 코드)에 서 있으므로, ctx 취소만으로는 풀리지 않는다 —
// 그 사실을 여기서 고정한다.
func TestCancelEndsAConnectWaitingForTheUser(t *testing.T) {
	port, hostKey := otpTestServer(t)

	service := New(func(protocol.Event) {})
	asked := make(chan struct{})
	// 사용자에게 물었다는 신호만 받고, 답은 하지 않는다(핸드폰을 찾는 중).
	service.onChallengeForTest = func() {
		select {
		case asked <- struct{}{}:
		default:
		}
	}

	done := make(chan error, 1)
	go func() {
		done <- service.Start("rule-1", "req-1", protocol.PortForwardStartPayload{
			Host:                 "127.0.0.1",
			Port:                 port,
			Username:             "ubuntu",
			AuthType:             "password",
			Password:             "pw",
			TrustedHostKeyBase64: hostKey,
			Mode:                 "local",
			BindAddress:          "127.0.0.1",
			BindPort:             0,
			TargetHost:           "127.0.0.1",
			TargetPort:           1,
		})
	}()

	select {
	case <-asked:
	case <-time.After(5 * time.Second):
		t.Fatal("사용자에게 묻는 단계까지 가지 않았다")
	}

	service.CancelInFlight("rule-1")

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("취소했는데 연결이 성공으로 끝났다")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("취소가 사람을 기다리는 연결을 끊지 못했다")
	}
}
