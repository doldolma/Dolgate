package sshconn

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"dolssh/services/ssh-core/pkg/coretypes"
)

func wsURLFromHTTP(httpURL string) string {
	return "ws" + strings.TrimPrefix(httpURL, "http")
}

// wsProxyEchoServer mirrors what sync-api's relay does after the SSM tunnel is up:
// read the opaque start frame, send the ready frame, then echo binary frames. The
// captured start/auth are delivered over buffered channels so the test reads them
// race-free once dialWSProxyConn (which only returns after "ready") has completed.
func wsProxyEchoServer(t *testing.T, ready wsProxyControlFrame, echo bool) (*httptest.Server, <-chan []byte, <-chan string) {
	t.Helper()
	upgrader := websocket.Upgrader{}
	startCh := make(chan []byte, 1)
	authCh := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_, start, err := conn.ReadMessage()
		if err != nil {
			return
		}
		startCh <- append([]byte(nil), start...)
		authCh <- r.Header.Get("Authorization")

		payload, _ := json.Marshal(ready)
		if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
			return
		}
		if !echo {
			return
		}
		for {
			mt, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if err := conn.WriteMessage(mt, data); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv, startCh, authCh
}

func TestDialWSProxyConnHandshakeAndEcho(t *testing.T) {
	srv, startCh, authCh := wsProxyEchoServer(t, wsProxyControlFrame{Type: "ready"}, true)

	target := &coretypes.WSProxyTarget{
		URL:          wsURLFromHTTP(srv.URL),
		AuthToken:    "tok-123",
		StartMessage: json.RawMessage(`{"instanceId":"i-abc"}`),
	}
	conn, err := dialWSProxyConn(target, 5*time.Second)
	if err != nil {
		t.Fatalf("dialWSProxyConn: %v", err)
	}
	defer conn.Close()

	select {
	case start := <-startCh:
		if string(start) != `{"instanceId":"i-abc"}` {
			t.Fatalf("start message = %q, want the instance blob", start)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server never received the start frame")
	}
	if auth := <-authCh; auth != "Bearer tok-123" {
		t.Fatalf("Authorization = %q, want Bearer tok-123", auth)
	}

	// The returned net.Conn must be a plain byte stream: write then read the echo.
	msg := []byte("hello over the tunnel")
	if _, err := conn.Write(msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := make([]byte, len(msg))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, msg) {
		t.Fatalf("echo = %q, want %q", got, msg)
	}
}

func TestDialWSProxyConnRejectsNotReady(t *testing.T) {
	srv, _, _ := wsProxyEchoServer(t, wsProxyControlFrame{Type: "error", Message: "eic push denied"}, false)

	_, err := dialWSProxyConn(&coretypes.WSProxyTarget{URL: wsURLFromHTTP(srv.URL)}, 5*time.Second)
	if err == nil {
		t.Fatal("expected error when server does not send ready")
	}
	if !strings.Contains(err.Error(), "eic push denied") {
		t.Fatalf("error = %v, want it to carry the server message", err)
	}
}

// A single large write must be readable in small chunks — the adapter buffers the
// leftover of one WebSocket message across successive Read calls.
func TestWSProxyConnChunkedReads(t *testing.T) {
	srv, _, _ := wsProxyEchoServer(t, wsProxyControlFrame{Type: "ready"}, true)

	conn, err := dialWSProxyConn(&coretypes.WSProxyTarget{URL: wsURLFromHTTP(srv.URL)}, 5*time.Second)
	if err != nil {
		t.Fatalf("dialWSProxyConn: %v", err)
	}
	defer conn.Close()

	payload := bytes.Repeat([]byte("abcdefghij"), 1024) // 10 KiB in one frame
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := make([]byte, 0, len(payload))
	buf := make([]byte, 1000) // read in sub-frame chunks
	for len(got) < len(payload) {
		n, err := conn.Read(buf)
		if err != nil {
			t.Fatalf("read after %d bytes: %v", len(got), err)
		}
		got = append(got, buf[:n]...)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("reassembled bytes do not match the original payload")
	}
}

func TestDialWSProxyConnEmptyURL(t *testing.T) {
	if _, err := dialWSProxyConn(&coretypes.WSProxyTarget{}, time.Second); err == nil {
		t.Fatal("expected error for empty proxy URL")
	}
}
