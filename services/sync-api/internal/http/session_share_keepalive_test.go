package http

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// 세션 공유가 조용하면 끊기던 일 — 서버 앞 프록시(ALB·nginx)는 60초 동안 아무것도 안 오가면 연결을 끊는다.
// 터미널이 조용하면 공유의 두 연결(데스크톱 owner·브라우저 viewer)도 조용해서, 공유가 60초 만에 끝나 버렸다.
// 서버가 두 연결에 ping 을 보내 터미널이 조용해도 연결이 살아 있게 한다.

func newShareTestServer(t *testing.T, hub *SessionShareHub) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		parts := strings.Split(strings.Trim(request.URL.Path, "/"), "/")
		if len(parts) != 3 {
			http.NotFound(writer, request)
			return
		}
		switch parts[0] {
		case "owner":
			_ = hub.HandleOwnerWebSocket(writer, request, parts[1], parts[2])
		case "viewer":
			_ = hub.HandleViewerWebSocket(writer, request, parts[1], parts[2])
		default:
			http.NotFound(writer, request)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

// openTestShare 는 공유 하나를 만들고 owner·viewer 가 붙을 경로를 돌려준다.
func openTestShare(hub *SessionShareHub, addr string) (ownerPath, viewerPath string) {
	share := hub.Create("owner-user", createSessionShareRequest{
		SessionID: "session-1",
		Title:     "web-1",
		Transport: sessionShareTransportSSH,
		Cols:      80,
		Rows:      24,
	}, "http://"+addr)
	viewerToken := share.ViewerURL[strings.LastIndex(share.ViewerURL, "/")+1:]
	return "/owner/" + share.ShareID + "/" + share.OwnerToken, "/viewer/" + share.ShareID + "/" + viewerToken
}

type shareTestClient struct {
	conn     *websocket.Conn
	pings    atomic.Int32
	messages chan string
	closed   chan struct{}
}

// dialShareTestClient 는 addr(서버, 또는 그 앞의 중계)로 붙고 읽기를 계속 돌린다 — gorilla 는 읽는 동안에만 ping 을 처리한다.
// ping 에는 브라우저·데스크톱처럼 pong 으로 답한다.
func dialShareTestClient(t *testing.T, addr, path string) *shareTestClient {
	t.Helper()
	header := http.Header{}
	header.Set("Origin", "http://"+addr) // viewer 는 Host 와 같은 origin 만 받는다.
	conn, _, err := websocket.DefaultDialer.Dial("ws://"+addr+path, header)
	if err != nil {
		t.Fatalf("dial %s: %v", path, err)
	}
	client := &shareTestClient{conn: conn, messages: make(chan string, 64), closed: make(chan struct{})}
	conn.SetPingHandler(func(data string) error {
		client.pings.Add(1)
		return conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(time.Second))
	})
	go func() {
		defer close(client.closed)
		for {
			_, payload, err := conn.ReadMessage()
			if err != nil {
				return
			}
			select {
			case client.messages <- string(payload):
			default:
			}
		}
	}()
	t.Cleanup(func() { _ = conn.Close() })
	return client
}

// waitForShareMessage 는 needle 을 담은 메시지가 timeout 안에 오면 true 다. 연결이 닫혀도 이미 받은 것은 본다.
func waitForShareMessage(client *shareTestClient, needle string, timeout time.Duration) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case message := <-client.messages:
			if strings.Contains(message, needle) {
				return true
			}
		case <-client.closed:
			for {
				select {
				case message := <-client.messages:
					if strings.Contains(message, needle) {
						return true
					}
				default:
					return false
				}
			}
		case <-timer.C:
			return false
		}
	}
}

// startIdleProxy 는 서버 앞 프록시(ALB·nginx)처럼, 어느 쪽으로도 idle 동안 아무것도 안 오가면 두 연결을 끊는 TCP 중계다.
func startIdleProxy(t *testing.T, upstream string, idle time.Duration) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			go relayUntilIdle(client, upstream, idle)
		}
	}()
	return listener.Addr().String()
}

func relayUntilIdle(client net.Conn, upstream string, idle time.Duration) {
	server, err := net.Dial("tcp", upstream)
	if err != nil {
		_ = client.Close()
		return
	}
	var lastTraffic atomic.Int64
	lastTraffic.Store(time.Now().UnixNano())
	done := make(chan struct{})
	var once sync.Once
	closeBoth := func() {
		once.Do(func() {
			close(done)
			_ = client.Close()
			_ = server.Close()
		})
	}
	pipe := func(dst, src net.Conn) {
		buffer := make([]byte, 32*1024)
		for {
			n, err := src.Read(buffer)
			if n > 0 {
				lastTraffic.Store(time.Now().UnixNano())
				if _, writeErr := dst.Write(buffer[:n]); writeErr != nil {
					closeBoth()
					return
				}
			}
			if err != nil {
				closeBoth()
				return
			}
		}
	}
	go pipe(server, client)
	go pipe(client, server)
	ticker := time.NewTicker(idle / 10)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			if time.Since(time.Unix(0, lastTraffic.Load())) >= idle {
				closeBoth()
				return
			}
		}
	}
}

func TestSessionSharePingIntervalStaysWellUnderProxyIdleTimeout(t *testing.T) {
	// ALB·nginx 의 기본 유휴 한도는 60초다. 그 절반 밑이어야 한 번 늦어도 끊기지 않는다.
	hub := NewSessionShareHub("")
	if hub.pingInterval <= 0 || hub.pingInterval > 30*time.Second {
		t.Fatalf("ping interval = %s, want > 0 and <= 30s", hub.pingInterval)
	}
}

func TestSessionShareSendsPingsToOwnerAndViewer(t *testing.T) {
	hub := NewSessionShareHub("")
	hub.pingInterval = 20 * time.Millisecond
	server := newShareTestServer(t, hub)
	addr := server.Listener.Addr().String()
	ownerPath, viewerPath := openTestShare(hub, addr)
	owner := dialShareTestClient(t, addr, ownerPath)
	viewer := dialShareTestClient(t, addr, viewerPath)

	deadline := time.Now().Add(2 * time.Second)
	for owner.pings.Load() < 3 || viewer.pings.Load() < 3 {
		if time.Now().After(deadline) {
			t.Fatalf("pings: owner=%d viewer=%d, want >= 3 each", owner.pings.Load(), viewer.pings.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSessionShareSurvivesAnIdleProxyOnlyWithPings(t *testing.T) {
	const proxyIdle = 400 * time.Millisecond
	cases := []struct {
		name      string
		interval  time.Duration
		wantAlive bool
	}{
		{name: "pings keep both connections through a quiet terminal", interval: 50 * time.Millisecond, wantAlive: true},
		// 대조 — 시험이 헛돌지 않게, ping 이 없으면 이 중계가 실제로 두 연결을 끊는 것을 본다.
		{name: "without pings the proxy cuts the share", interval: time.Hour, wantAlive: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hub := NewSessionShareHub("")
			hub.pingInterval = tc.interval
			server := newShareTestServer(t, hub)
			proxyAddr := startIdleProxy(t, server.Listener.Addr().String(), proxyIdle)
			ownerPath, viewerPath := openTestShare(hub, proxyAddr)
			owner := dialShareTestClient(t, proxyAddr, ownerPath)
			viewer := dialShareTestClient(t, proxyAddr, viewerPath)

			// 터미널이 조용한 시간 — 중계의 유휴 한도를 훨씬 넘긴다.
			time.Sleep(3 * proxyIdle)

			// 그 뒤 터미널에 출력이 생기면 시청자에게 닿아야 한다(공유가 살아 있다는 뜻).
			const output = "c3RpbGwgaGVyZQ==" // "still here"
			if err := owner.conn.WriteJSON(map[string]string{"type": "output", "data": output}); err != nil && tc.wantAlive {
				t.Fatalf("owner write after silence: %v", err)
			}
			alive := waitForShareMessage(viewer, output, time.Second)
			if alive != tc.wantAlive {
				t.Fatalf("viewer got the output after %s of silence = %v, want %v (pings: owner=%d viewer=%d)",
					3*proxyIdle, alive, tc.wantAlive, owner.pings.Load(), viewer.pings.Load())
			}
		})
	}
}
