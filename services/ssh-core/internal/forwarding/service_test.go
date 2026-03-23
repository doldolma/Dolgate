package forwarding

import (
	"errors"
	"net"
	"testing"

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
