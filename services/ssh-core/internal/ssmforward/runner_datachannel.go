package ssmforward

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/ssmdatachannel"
)

const forwardHandshakeTimeout = 15 * time.Second

// datachannelForwardRunner runs the session-manager-plugin's basic
// (non-multiplexed) SSM port-forwarding mode over the in-process data channel.
// Newer agents advertise LocalPortForwarding + smux support during the
// handshake; those sessions are handled by datachannelMuxForwardRunner instead.
type datachannelForwardRunner struct {
	dc       *ssmdatachannel.SsmDataChannel
	listener net.Listener
	bindPort int

	cancel     context.CancelFunc
	done       chan struct{}
	finishOnce sync.Once

	connMu sync.Mutex
	conn   net.Conn // currently active downstream connection, nil when idle
	// pending buffers instance→client bytes that arrive before the FIRST downstream
	// connection attaches — notably sshd's version banner, which the SSM agent
	// forwards on session start. Without this the banner is dropped and the first
	// SSH handshake fails with "overflow reading version string" (masked until now
	// by a retry that reconnects and gets a fresh banner). Buffering makes the first
	// connection succeed. Only pre-first-connection: once primed, a nil conn means a
	// closed connection and bytes are dropped as before, so a closed connection's
	// tail never leaks into the next one.
	pending []byte
	primed  bool

	mu          sync.Mutex
	exit        sessionExit
	waitErr     error
	lastMessage string
	killed      bool
}

func startDataChannelForwardRunner(payload protocol.SSMPortForwardStartPayload) (runtimeRunner, error) {
	dc := new(ssmdatachannel.SsmDataChannel)
	if err := dc.OpenWithSessionToken(payload.StreamURL, payload.TokenValue); err != nil {
		return nil, fmt.Errorf("opening SSM data channel: %w", err)
	}

	// Port forwarding requires the SessionType handshake to complete before any
	// bytes flow.
	hsCtx, hsCancel := context.WithTimeout(context.Background(), forwardHandshakeTimeout)
	err := dc.WaitForHandshakeComplete(hsCtx)
	hsCancel()
	if err != nil {
		_ = dc.Close()
		return nil, fmt.Errorf("SSM port forward handshake failed: %w", err)
	}

	bindAddress := resolvedBindAddress(payload.BindAddress)
	address := net.JoinHostPort(bindAddress, strconv.Itoa(payload.BindPort))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		_ = dc.TerminateSession()
		_ = dc.Close()
		return nil, fmt.Errorf("listen on %s: %w", address, err)
	}
	bindPort := listener.Addr().(*net.TCPAddr).Port

	if shouldUseDataChannelMux(dc) {
		runner, err := newDataChannelMuxForwardRunner(dc, listener, bindPort)
		if err != nil {
			_ = listener.Close()
			_ = dc.TerminateSession()
			_ = dc.Close()
			return nil, fmt.Errorf("start SSM mux port forward: %w", err)
		}
		return runner, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	runner := &datachannelForwardRunner{
		dc:       dc,
		listener: listener,
		bindPort: bindPort,
		cancel:   cancel,
		done:     make(chan struct{}),
	}

	go runner.readLoop()
	go runner.acceptLoop(ctx)
	return runner, nil
}

// readLoop is the single reader of the data channel: it decodes agent messages and
// writes payloads to whichever downstream connection is currently active.
func (r *datachannelForwardRunner) readLoop() {
	for {
		msg, err := r.dc.ReadFrame()
		if len(msg) > 0 {
			payload, handleErr := r.dc.HandleMsg(msg)
			if len(payload) > 0 {
				r.connMu.Lock()
				conn := r.conn
				if conn == nil && !r.primed {
					// Buffer bytes that precede the first downstream connection
					// (sshd's banner) so the first SSH handshake sees them.
					r.pending = append(r.pending, payload...)
				}
				r.connMu.Unlock()
				if conn != nil {
					_ = writeAll(conn, payload)
				}
			}
			if handleErr != nil {
				r.finishWith(handleErr)
				return
			}
		}
		if err != nil {
			r.finishWith(err)
			return
		}
	}
}

// acceptLoop serializes downstream connections (basic, non-muxed forwarding): it
// pumps the accepted connection into the channel and only accepts the next one
// after the current connection closes.
func (r *datachannelForwardRunner) acceptLoop(ctx context.Context) {
	for {
		conn, err := r.listener.Accept()
		if err != nil {
			return // listener closed (shutdown) or fatal accept error
		}

		r.connMu.Lock()
		busy := r.conn != nil
		var pending []byte
		if !busy {
			r.conn = conn
			// Hand off any bytes buffered before this first connection attached.
			pending = r.pending
			r.pending = nil
			r.primed = true
		}
		r.connMu.Unlock()
		if busy {
			// Single active stream: refuse extra concurrent connections rather
			// than interleave them onto one unmuxed channel.
			_ = conn.Close()
			continue
		}

		// Deliver the pre-connect bytes (e.g. sshd's banner) before streaming so the
		// SSH handshake doesn't miss the version string.
		if len(pending) > 0 {
			if err := writeAll(conn, pending); err != nil && !errors.Is(err, net.ErrClosed) {
				r.setMessage(err.Error())
			}
		}

		// conn -> channel; blocks until the client closes the connection.
		_, copyErr := io.Copy(r.dc, conn)
		if copyErr != nil && !errors.Is(copyErr, net.ErrClosed) {
			r.setMessage(copyErr.Error())
		}
		_ = conn.Close()

		r.connMu.Lock()
		r.conn = nil
		r.connMu.Unlock()

		select {
		case <-ctx.Done():
			return
		default:
		}
		// Tell the agent this connection is done so it can accept a new one.
		_ = r.dc.DisconnectPort()
	}
}

func (r *datachannelForwardRunner) finishWith(cause error) {
	r.finishOnce.Do(func() {
		r.mu.Lock()
		if cause != nil && !errors.Is(cause, io.EOF) && !r.killed {
			r.exit = sessionExit{ExitCode: 1}
			r.waitErr = cause
			if r.lastMessage == "" {
				r.lastMessage = cause.Error()
			}
		}
		r.mu.Unlock()

		r.cancel()
		_ = r.listener.Close()
		r.connMu.Lock()
		if r.conn != nil {
			_ = r.conn.Close()
			r.conn = nil
		}
		r.connMu.Unlock()
		_ = r.dc.Close()
		close(r.done)
	})
}

func writeAll(w io.Writer, payload []byte) error {
	for len(payload) > 0 {
		written, err := w.Write(payload)
		if written > 0 {
			payload = payload[written:]
		}
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func (r *datachannelForwardRunner) setMessage(message string) {
	r.mu.Lock()
	r.lastMessage = message
	r.mu.Unlock()
}

func (r *datachannelForwardRunner) Wait() (sessionExit, error) {
	<-r.done
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.exit, r.waitErr
}

func (r *datachannelForwardRunner) Kill() error {
	r.mu.Lock()
	r.killed = true
	r.mu.Unlock()
	_ = r.dc.TerminateSession()
	r.finishWith(nil)
	return nil
}

func (r *datachannelForwardRunner) Close() error {
	r.finishWith(nil)
	return nil
}

func (r *datachannelForwardRunner) ErrorMessage() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lastMessage
}

func (r *datachannelForwardRunner) ActualBindPort() int {
	return r.bindPort
}

func (r *datachannelForwardRunner) SetBindPortResolvedCallback(callback func(int)) {
	if callback != nil && r.bindPort > 0 {
		callback(r.bindPort)
	}
}
