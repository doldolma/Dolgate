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

// datachannelForwardRunner runs an SSM port-forwarding session over the in-process
// data channel instead of spawning aws + session-manager-plugin.
//
// It implements the plugin's "basic" (non-multiplexed) port forwarding: one active
// downstream TCP connection at a time. That is exactly right for SSH/SFTP-over-SSM
// (a single connection) and for single-connection tunnels. Multiplexed forwarding
// (concurrent connections over one session, via smux) is a deliberate follow-up;
// until then a second concurrent connection is refused while one is active.
type datachannelForwardRunner struct {
	dc       *ssmdatachannel.SsmDataChannel
	listener net.Listener
	bindPort int

	cancel     context.CancelFunc
	done       chan struct{}
	finishOnce sync.Once

	connMu sync.Mutex
	conn   net.Conn // currently active downstream connection, nil when idle

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
	// bytes flow; this also flips the channel into unbuffered streaming mode.
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

	ctx, cancel := context.WithCancel(context.Background())
	runner := &datachannelForwardRunner{
		dc:       dc,
		listener: listener,
		bindPort: listener.Addr().(*net.TCPAddr).Port,
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
	buffer := make([]byte, 32*1024)
	for {
		n, err := r.dc.Read(buffer)
		if n > 0 {
			payload, handleErr := r.dc.HandleMsg(buffer[:n])
			if len(payload) > 0 {
				r.connMu.Lock()
				conn := r.conn
				r.connMu.Unlock()
				if conn != nil {
					_, _ = conn.Write(payload)
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
		if !busy {
			r.conn = conn
		}
		r.connMu.Unlock()
		if busy {
			// Single active stream: refuse extra concurrent connections rather
			// than interleave them onto one unmuxed channel.
			_ = conn.Close()
			continue
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
