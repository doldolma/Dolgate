package sshconn

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"dolssh/services/ssh-core/pkg/coretypes"
)

// wsProxyReadyTimeout bounds how long we wait for sync-api to finish server-side
// setup (EIC key push + SSM port-forward establishment) and send its ready frame
// before the SSH handshake begins. Generous relative to the TCP dial timeout
// because it covers two AWS round-trips, not a single socket connect.
const wsProxyReadyTimeout = 30 * time.Second

// wsProxyControlFrame is the tiny JSON protocol spoken before the transport turns
// into a raw byte pipe: ssh-core sends the opaque StartMessage, then blocks for a
// {"type":"ready"} (or {"type":"error","message":...}) from sync-api.
type wsProxyControlFrame struct {
	Type    string `json:"type"`
	Message string `json:"message,omitempty"`
}

// dialWSProxyConn opens the sync-api WebSocket, performs the ready handshake, and
// returns a net.Conn that streams raw bytes over it. Everything above the returned
// conn (ssh.NewClientConn, auth, channels, sftp/tmux) runs exactly as it would over
// a TCP socket — only the transport is swapped.
func dialWSProxyConn(target *coretypes.WSProxyTarget, dialTimeout time.Duration) (net.Conn, error) {
	if target == nil || target.URL == "" {
		return nil, fmt.Errorf("ws proxy target url is empty")
	}
	dialer := websocket.Dialer{HandshakeTimeout: dialTimeout}
	header := http.Header{}
	if target.AuthToken != "" {
		header.Set("Authorization", "Bearer "+target.AuthToken)
	}
	ws, resp, err := dialer.Dial(target.URL, header)
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("dial: %w (http %d)", err, resp.StatusCode)
		}
		return nil, fmt.Errorf("dial: %w", err)
	}

	// Hand the server the opaque start blob (AWS creds, instanceId, EIC pubkey, ...).
	// ssh-core does not interpret it — sync-api uses it to open the SSM tunnel.
	if err := ws.WriteMessage(websocket.TextMessage, startMessageBytes(target.StartMessage)); err != nil {
		_ = ws.Close()
		return nil, fmt.Errorf("send start: %w", err)
	}

	// Wait for the server to finish EIC + tunnel setup before streaming SSH bytes.
	_ = ws.SetReadDeadline(time.Now().Add(wsProxyReadyTimeout))
	_, data, err := ws.ReadMessage()
	if err != nil {
		_ = ws.Close()
		return nil, fmt.Errorf("await ready: %w", err)
	}
	var frame wsProxyControlFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		_ = ws.Close()
		return nil, fmt.Errorf("parse ready frame: %w", err)
	}
	if frame.Type != "ready" {
		_ = ws.Close()
		if frame.Message != "" {
			return nil, fmt.Errorf("server not ready: %s", frame.Message)
		}
		return nil, fmt.Errorf("server not ready: %s", frame.Type)
	}
	// Clear the deadline; the SSH layer manages its own liveness via keepalive requests.
	_ = ws.SetReadDeadline(time.Time{})
	return newWSProxyConn(ws), nil
}

func startMessageBytes(msg json.RawMessage) []byte {
	if len(msg) == 0 {
		return []byte("{}")
	}
	return msg
}

// wsProxyConn adapts a gorilla WebSocket to net.Conn. gorilla permits one
// concurrent reader and one concurrent writer, which matches x/crypto/ssh's single
// read loop + serialized writes; the mutexes below guard the leftover read buffer
// and the extra Close/WriteControl writer.
type wsProxyConn struct {
	ws *websocket.Conn

	readMu  sync.Mutex
	readBuf []byte

	writeMu sync.Mutex

	closeOnce sync.Once
}

func newWSProxyConn(ws *websocket.Conn) *wsProxyConn {
	return &wsProxyConn{ws: ws}
}

func (c *wsProxyConn) Read(p []byte) (int, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()
	for len(c.readBuf) == 0 {
		_, data, err := c.ws.ReadMessage()
		if err != nil {
			return 0, translateWSProxyErr(err)
		}
		c.readBuf = data
	}
	n := copy(p, c.readBuf)
	c.readBuf = c.readBuf[n:]
	return n, nil
}

func (c *wsProxyConn) Write(p []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := c.ws.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, translateWSProxyErr(err)
	}
	return len(p), nil
}

func (c *wsProxyConn) Close() error {
	var closeErr error
	c.closeOnce.Do(func() {
		// Best-effort clean close handshake, then tear the socket down.
		c.writeMu.Lock()
		_ = c.ws.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
			time.Now().Add(time.Second),
		)
		c.writeMu.Unlock()
		closeErr = c.ws.Close()
	})
	return closeErr
}

func (c *wsProxyConn) LocalAddr() net.Addr  { return c.ws.LocalAddr() }
func (c *wsProxyConn) RemoteAddr() net.Addr { return c.ws.RemoteAddr() }

func (c *wsProxyConn) SetDeadline(t time.Time) error {
	if err := c.ws.SetReadDeadline(t); err != nil {
		return err
	}
	return c.ws.SetWriteDeadline(t)
}

func (c *wsProxyConn) SetReadDeadline(t time.Time) error  { return c.ws.SetReadDeadline(t) }
func (c *wsProxyConn) SetWriteDeadline(t time.Time) error { return c.ws.SetWriteDeadline(t) }

// translateWSProxyErr maps a clean WebSocket close to io.EOF so the SSH layer sees
// an ordinary end-of-stream. Abnormal closes stay as-is so the session classifies
// them as a transport failure (reconnectable) rather than a graceful hang-up.
func translateWSProxyErr(err error) error {
	if err == nil {
		return nil
	}
	if websocket.IsCloseError(
		err,
		websocket.CloseNormalClosure,
		websocket.CloseGoingAway,
		websocket.CloseNoStatusReceived,
	) {
		return io.EOF
	}
	return err
}
