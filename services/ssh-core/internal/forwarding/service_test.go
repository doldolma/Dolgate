package forwarding

import (
	"context"
	"errors"
	"io"
	"net"
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
