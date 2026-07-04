package ssmforward

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/xtaci/smux"

	"dolssh/services/ssh-core/internal/ssmdatachannel"
)

const (
	localPortForwardingType        = "LocalPortForwarding"
	tcpMultiplexingAgentVersion    = "3.0.196.0"
	disableSmuxKeepAliveVersion    = "3.1.1511.0"
	muxDataChannelStreamChunkSize  = 1024
	muxDataChannelStreamWriteDelay = time.Millisecond
)

type portSessionProperties struct {
	Type string `json:"type"`
}

type datachannelMuxForwardRunner struct {
	dc       *ssmdatachannel.SsmDataChannel
	listener net.Listener
	bindPort int

	cancel     context.CancelFunc
	done       chan struct{}
	finishOnce sync.Once

	mgsConn    net.Conn
	muxConn    net.Conn
	muxSession *smux.Session

	mu          sync.Mutex
	exit        sessionExit
	waitErr     error
	lastMessage string
	killed      bool
}

func shouldUseDataChannelMux(dc *ssmdatachannel.SsmDataChannel) bool {
	if dc.SessionType() != "Port" {
		return false
	}
	if !agentVersionGreaterThan(dc.AgentVersion(), tcpMultiplexingAgentVersion) {
		return false
	}

	var props portSessionProperties
	raw := dc.SessionProperties()
	if len(raw) == 0 || json.Unmarshal(raw, &props) != nil {
		return false
	}
	return props.Type == localPortForwardingType
}

func newDataChannelMuxForwardRunner(dc *ssmdatachannel.SsmDataChannel, listener net.Listener, bindPort int) (*datachannelMuxForwardRunner, error) {
	mgsConn, muxConn := net.Pipe()
	cfg := smux.DefaultConfig()
	if agentVersionGreaterThan(dc.AgentVersion(), disableSmuxKeepAliveVersion) {
		cfg.KeepAliveDisabled = true
	}

	muxSession, err := smux.Client(muxConn, cfg)
	if err != nil {
		_ = mgsConn.Close()
		_ = muxConn.Close()
		return nil, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	runner := &datachannelMuxForwardRunner{
		dc:         dc,
		listener:   listener,
		bindPort:   bindPort,
		cancel:     cancel,
		done:       make(chan struct{}),
		mgsConn:    mgsConn,
		muxConn:    muxConn,
		muxSession: muxSession,
	}

	go runner.readLoop()
	go runner.transferLoop()
	go runner.acceptLoop(ctx)
	return runner, nil
}

// readLoop moves agent output-stream payloads into smux. In mux mode those
// payloads are smux frames, not raw destination TCP bytes.
func (r *datachannelMuxForwardRunner) readLoop() {
	for {
		msg, err := r.dc.ReadFrame()
		if len(msg) > 0 {
			payload, handleErr := r.dc.HandleMsg(msg)
			if len(payload) > 0 {
				if writeErr := writeAll(r.mgsConn, payload); writeErr != nil {
					r.finishWith(writeErr)
					return
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

// transferLoop reads smux frames produced by local client streams and publishes
// them as SSM input-stream payloads. The chunk size and pacing match the
// official session-manager-plugin path that feeds datachannel.
func (r *datachannelMuxForwardRunner) transferLoop() {
	buf := make([]byte, muxDataChannelStreamChunkSize)
	for {
		n, err := r.mgsConn.Read(buf)
		if n > 0 {
			if _, writeErr := r.dc.Write(buf[:n]); writeErr != nil {
				r.finishWith(writeErr)
				return
			}
			time.Sleep(muxDataChannelStreamWriteDelay)
		}
		if err != nil {
			if !isBenignForwardClose(err) {
				r.finishWith(err)
			}
			return
		}
	}
}

func (r *datachannelMuxForwardRunner) acceptLoop(ctx context.Context) {
	for {
		conn, err := r.listener.Accept()
		if err != nil {
			return
		}

		select {
		case <-ctx.Done():
			_ = conn.Close()
			return
		default:
		}

		stream, err := r.muxSession.OpenStream()
		if err != nil {
			_ = conn.Close()
			if !isBenignForwardClose(err) {
				r.finishWith(err)
			}
			return
		}
		go r.handleClientConnection(conn, stream)
	}
}

func (r *datachannelMuxForwardRunner) handleClientConnection(conn net.Conn, stream *smux.Stream) {
	closeBoth := func() {
		_ = stream.Close()
		_ = conn.Close()
	}

	go func() {
		_, err := io.Copy(stream, conn)
		if err != nil && !isBenignForwardClose(err) {
			r.setMessage(err.Error())
		}
		closeBoth()
	}()

	go func() {
		_, err := io.Copy(conn, stream)
		if err != nil && !isBenignForwardClose(err) {
			r.setMessage(err.Error())
		}
		closeBoth()
	}()
}

func (r *datachannelMuxForwardRunner) finishWith(cause error) {
	r.finishOnce.Do(func() {
		r.mu.Lock()
		if cause != nil && !isBenignForwardClose(cause) && !r.killed {
			r.exit = sessionExit{ExitCode: 1}
			r.waitErr = cause
			if r.lastMessage == "" {
				r.lastMessage = cause.Error()
			}
		}
		r.mu.Unlock()

		r.cancel()
		_ = r.listener.Close()
		if r.muxSession != nil {
			_ = r.muxSession.Close()
		}
		if r.muxConn != nil {
			_ = r.muxConn.Close()
		}
		if r.mgsConn != nil {
			_ = r.mgsConn.Close()
		}
		_ = r.dc.Close()
		close(r.done)
	})
}

func (r *datachannelMuxForwardRunner) setMessage(message string) {
	r.mu.Lock()
	r.lastMessage = message
	r.mu.Unlock()
}

func (r *datachannelMuxForwardRunner) Wait() (sessionExit, error) {
	<-r.done
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.exit, r.waitErr
}

func (r *datachannelMuxForwardRunner) Kill() error {
	r.mu.Lock()
	r.killed = true
	r.mu.Unlock()
	_ = r.dc.TerminateSession()
	r.finishWith(nil)
	return nil
}

func (r *datachannelMuxForwardRunner) Close() error {
	r.finishWith(nil)
	return nil
}

func (r *datachannelMuxForwardRunner) ErrorMessage() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lastMessage
}

func (r *datachannelMuxForwardRunner) ActualBindPort() int {
	return r.bindPort
}

func (r *datachannelMuxForwardRunner) SetBindPortResolvedCallback(callback func(int)) {
	if callback != nil && r.bindPort > 0 {
		callback(r.bindPort)
	}
}

func isBenignForwardClose(err error) bool {
	if err == nil {
		return true
	}
	return errors.Is(err, io.EOF) ||
		errors.Is(err, net.ErrClosed) ||
		errors.Is(err, io.ErrClosedPipe) ||
		strings.Contains(err.Error(), "use of closed network connection") ||
		strings.Contains(err.Error(), "closed pipe")
}

func agentVersionGreaterThan(agentVersion, supportedVersion string) bool {
	agentParts, ok := parseAgentVersion(agentVersion)
	if !ok {
		return false
	}
	supportedParts, ok := parseAgentVersion(supportedVersion)
	if !ok || len(agentParts) != len(supportedParts) {
		return false
	}
	for i := range supportedParts {
		if agentParts[i] > supportedParts[i] {
			return true
		}
		if agentParts[i] < supportedParts[i] {
			return false
		}
	}
	return false
}

func parseAgentVersion(version string) ([]int, bool) {
	if version == "" {
		return nil, false
	}
	parts := strings.Split(version, ".")
	out := make([]int, len(parts))
	for i, part := range parts {
		value, err := strconv.Atoi(part)
		if err != nil {
			return nil, false
		}
		out[i] = value
	}
	return out, true
}
