package tailnetservice

import (
	"context"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// 이 포워드는 tailnet 으로 가는 문이다. 바인딩 주소를 틀리면 같은 네트워크의 다른 기기가
// 인증 없이 그 문으로 들어온다 — 그래서 주소 자체를 테스트로 잠근다.

// fakeTailnet 은 tsnet 대신 미리 만들어 둔 서버로 잇는다.
type fakeTailnet struct {
	mu       sync.Mutex
	dialed   []string
	backend  net.Listener
	failWith error
}

func (f *fakeTailnet) dial(_ context.Context, network, address string) (net.Conn, error) {
	f.mu.Lock()
	f.dialed = append(f.dialed, network+":"+address)
	failure := f.failWith
	f.mu.Unlock()
	if failure != nil {
		return nil, failure
	}
	return net.Dial("tcp", f.backend.Addr().String())
}

func (f *fakeTailnet) targets() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.dialed...)
}

// echoBackend 는 받은 바이트를 그대로 돌려준다. 포워드가 양방향으로 흐르는지 보는 데 쓴다.
func echoBackend(t *testing.T) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return listener
}

// openTestForward 는 Service 를 거치지 않고 forwarder 만 세운다. tsnet 없이 포워드 자체를 본다.
func openTestForward(t *testing.T, fake *fakeTailnet) *forwarder {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	entry := &forwarder{listener: listener, cancel: cancel, conns: make(map[net.Conn]struct{})}
	go entry.serve(ctx, fake.dial, "winbox.example.ts.net:3389")
	t.Cleanup(entry.close)
	return entry
}

func TestForwardBindsToLoopbackOnly(t *testing.T) {
	fake := &fakeTailnet{backend: echoBackend(t)}
	entry := openTestForward(t, fake)

	host, _, err := net.SplitHostPort(entry.listener.Addr().String())
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		t.Fatalf("forward must bind loopback only, got %q", host)
	}
}

func TestForwardPipesBothWays(t *testing.T) {
	fake := &fakeTailnet{backend: echoBackend(t)}
	entry := openTestForward(t, fake)

	conn, err := net.Dial("tcp", entry.listener.Addr().String())
	if err != nil {
		t.Fatalf("dial forward: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf) != "hello" {
		t.Fatalf("expected echo, got %q", buf)
	}

	// tailnet 쪽으로는 논리 대상이 그대로 가야 한다. 로컬 주소가 새어 나가면 엉뚱한 곳으로 붙는다.
	targets := fake.targets()
	if len(targets) != 1 || targets[0] != "tcp:winbox.example.ts.net:3389" {
		t.Fatalf("unexpected dial targets: %v", targets)
	}
}

func TestForwardDropsTheConnectionWhenTailnetDialFails(t *testing.T) {
	// tailnet 이 내려갔거나 노드가 만료된 경우다. 붙는 쪽이 연결 실패로 보고 재연결이 판단한다.
	fake := &fakeTailnet{backend: echoBackend(t), failWith: io.ErrUnexpectedEOF}
	entry := openTestForward(t, fake)

	conn, err := net.Dial("tcp", entry.listener.Addr().String())
	if err != nil {
		t.Fatalf("dial forward: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	if _, err := io.ReadAll(conn); err != nil && !strings.Contains(err.Error(), "closed") {
		// 읽기는 EOF 로 끝나야 한다(연결이 끊긴다). 타임아웃이면 실패다.
		if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
			t.Fatalf("forward kept the connection open after a failed tailnet dial")
		}
	}
}

func TestClosingAForwardStopsAccepting(t *testing.T) {
	// 리스너가 남으면 세션이 끝난 뒤에도 tailnet 으로 가는 문이 열려 있다.
	fake := &fakeTailnet{backend: echoBackend(t)}
	entry := openTestForward(t, fake)
	address := entry.listener.Addr().String()

	entry.close()

	if conn, err := net.Dial("tcp", address); err == nil {
		_ = conn.Close()
		t.Fatal("forward still accepts connections after close")
	}
}

func TestClosingAForwardCutsLiveConnections(t *testing.T) {
	// 리스너만 닫으면 이미 붙어 있는 연결은 계속 tailnet 을 쓴다.
	fake := &fakeTailnet{backend: echoBackend(t)}
	entry := openTestForward(t, fake)

	conn, err := net.Dial("tcp", entry.listener.Addr().String())
	if err != nil {
		t.Fatalf("dial forward: %v", err)
	}
	defer conn.Close()
	// 파이프가 세워지도록 왕복을 한 번 한다.
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte("x")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 1)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read: %v", err)
	}

	entry.close()

	if _, err := io.ReadAll(conn); err == nil {
		// 끊겼으면 EOF(err == nil, 빈 바이트)거나 오류다. 계속 열려 있으면 실패다.
		if _, err := conn.Write([]byte("y")); err == nil {
			if _, err := io.ReadFull(conn, buf); err == nil {
				t.Fatal("live connection survived the forward close")
			}
		}
	}
}

func TestOpenForwardRefusesAnEmptyRoute(t *testing.T) {
	// 경로가 없으면 일반 네트워크로 나간다. 호출부는 tailnet 을 쓰는 줄 알고 붙으므로 거절해야 한다.
	service := &Service{}
	if _, err := service.OpenForward("s1", ForwardTarget{Host: "winbox", Port: 3389}); err == nil {
		t.Fatal("expected an error for an empty tailnet route")
	}
}

func TestOpenForwardValidatesTheTarget(t *testing.T) {
	service := &Service{}
	if _, err := service.OpenForward("s1", ForwardTarget{Host: "  ", Port: 3389}); err == nil {
		t.Fatal("expected an error for a blank host")
	}
	if _, err := service.OpenForward("s1", ForwardTarget{Host: "winbox", Port: 0}); err == nil {
		t.Fatal("expected an error for an invalid port")
	}
}
