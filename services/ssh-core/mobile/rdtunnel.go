package mobile

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// Remote Desktop loopback tunnel.
//
// The Rust VNC/RDP core dials a plain TCP host:port. When the target is reached
// through a transport that is not direct TCP (Tailscale userspace netstack, SSH
// port forwarding), this bridge opens a 127.0.0.1 ephemeral listener and copies
// bytes bidirectionally between the accepted connection and the transport's
// net.Conn.
//
// Direct connections skip the listener entirely: the host and port are returned
// as-is to the JS layer, and the Rust core dials them itself.

// maxTunnelConns limits how many simultaneous local connections a single tunnel
// will accept. A VNC/RDP viewer opens one, sometimes two (clipboard channel);
// anything beyond that is a resource leak from a broken client.
const maxTunnelConns = 4

const (
	rdTunnelAuthTokenBytes = 32
	rdTunnelAuthPrefix     = "DOLGATE-RD-TUNNEL/1 "
	rdTunnelAuthTimeout    = 2 * time.Second
)

var errRDTunnelIDExists = errors.New("rdtunnel: tunnel id already exists")

// RDTunnelTransport is the type of transport.
type RDTunnelTransport int

const (
	RDTunnelDirect    RDTunnelTransport = 0
	RDTunnelTailscale RDTunnelTransport = 1
	RDTunnelSSH       RDTunnelTransport = 2
	RDTunnelSSM       RDTunnelTransport = 3
)

// RDTunnel is a handle to an open loopback tunnel. Direct tunnels carry no
// listener and just record the endpoint for the JS layer to read.
type RDTunnel struct {
	id        string
	transport RDTunnelTransport
	host      string
	port      int32
	authToken string

	// Non-nil only for non-direct transports.
	listener net.Listener
	cancel   context.CancelFunc
	readyMu  sync.Mutex
	// readyConn is the first target connection, opened before this tunnel is
	// returned. Besides removing one round trip from protocol startup, this is
	// what lets OpenRemoteDesktopTunnel return the real Tailnet/SSH/SSM dial
	// error instead of making the Rust core discover only an EOF.
	readyConn net.Conn

	connCount atomic.Int32
	closeOnce sync.Once
	closed    atomic.Bool
	wg        sync.WaitGroup
}

// ID returns the tunnel handle.
func (t *RDTunnel) ID() string { return t.id }

// Host returns 127.0.0.1 for tunnelled transports, or the original host for
// direct.
func (t *RDTunnel) Host() string { return t.host }

// Port returns the local listener port (tunnelled) or the original port
// (direct).
func (t *RDTunnel) Port() int32 { return t.port }

// AuthToken returns the secret preface required by loopback tunnels. Direct
// descriptors return an empty string.
func (t *RDTunnel) AuthToken() string { return t.authToken }

// Transport returns the transport type.
func (t *RDTunnel) Transport() int { return int(t.transport) }

// Close shuts down the tunnel idempotently. Blocks until all bridge goroutines
// have finished.
func (t *RDTunnel) Close() error {
	var listenerErr error
	t.closeOnce.Do(func() {
		t.closed.Store(true)
		if t.cancel != nil {
			t.cancel()
		}
		if t.listener != nil {
			listenerErr = t.listener.Close()
		}
		t.readyMu.Lock()
		readyConn := t.readyConn
		t.readyConn = nil
		t.readyMu.Unlock()
		if readyConn != nil {
			if err := readyConn.Close(); listenerErr == nil {
				listenerErr = err
			}
		}
	})
	t.wg.Wait()
	return listenerErr
}

// RDTunnelDialer produces a net.Conn to the target endpoint over a specific
// transport. The tunnel calls it once per accepted local connection.
type RDTunnelDialer interface {
	DialTarget(ctx context.Context) (net.Conn, error)
}

// rdTunnelRegistry tracks active tunnels so teardown can sweep them.
type rdTunnelRegistry struct {
	mu      sync.Mutex
	tunnels map[string]*RDTunnel
}

func newRDTunnelRegistry() *rdTunnelRegistry {
	return &rdTunnelRegistry{tunnels: make(map[string]*RDTunnel)}
}

func (r *rdTunnelRegistry) register(t *RDTunnel) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.tunnels[t.id]; exists {
		return errRDTunnelIDExists
	}
	r.tunnels[t.id] = t
	return nil
}

func (r *rdTunnelRegistry) remove(id string) *RDTunnel {
	r.mu.Lock()
	t := r.tunnels[id]
	delete(r.tunnels, id)
	r.mu.Unlock()
	return t
}

func (r *rdTunnelRegistry) closeAll() {
	r.mu.Lock()
	all := make([]*RDTunnel, 0, len(r.tunnels))
	for _, t := range r.tunnels {
		all = append(all, t)
	}
	r.tunnels = make(map[string]*RDTunnel)
	r.mu.Unlock()

	for _, t := range all {
		_ = t.Close()
	}
}

// OpenRDTunnelDirect creates a direct (no-listener) tunnel descriptor.
func (e *Engine) OpenRDTunnelDirect(id string, host string, port int) (*RDTunnel, error) {
	e.rdTunnelGate.RLock()
	defer e.rdTunnelGate.RUnlock()

	t := &RDTunnel{
		id:        id,
		transport: RDTunnelDirect,
		host:      host,
		port:      int32(port),
	}
	if err := e.rdTunnels.register(t); err != nil {
		return nil, err
	}
	return t, nil
}

func newRDTunnelAuthToken() (string, error) {
	bytes := make([]byte, rdTunnelAuthTokenBytes)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("rdtunnel: generate auth token: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}

// OpenRDTunnel creates a loopback listener that bridges accepted connections to
// the given dialer. Returns immediately with the tunnel descriptor; the accept
// loop runs in the background.
func (e *Engine) OpenRDTunnel(id string, transport RDTunnelTransport, dialer RDTunnelDialer) (*RDTunnel, error) {
	e.rdTunnelGate.RLock()
	defer e.rdTunnelGate.RUnlock()

	if dialer == nil {
		return nil, errors.New("rdtunnel: dialer is required")
	}
	authToken, err := newRDTunnelAuthToken()
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	// Establish the first transport connection synchronously. Previously the
	// listener was returned first and bridge() dialled in a goroutine; any SSH
	// authentication or direct-tcpip target failure therefore just closed the
	// local socket and surfaced as an unrelated RFB/TLS EOF.
	readyConn, err := dialer.DialTarget(ctx)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("rdtunnel: connect target: %w", err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		cancel()
		_ = readyConn.Close()
		return nil, fmt.Errorf("rdtunnel: listen: %w", err)
	}

	addr := listener.Addr().(*net.TCPAddr)

	t := &RDTunnel{
		id:        id,
		transport: transport,
		host:      "127.0.0.1",
		port:      int32(addr.Port),
		authToken: authToken,
		listener:  listener,
		cancel:    cancel,
		readyConn: readyConn,
	}

	if err := e.rdTunnels.register(t); err != nil {
		_ = t.Close()
		return nil, err
	}

	t.wg.Add(1)
	go t.acceptLoop(ctx, dialer)
	return t, nil
}

// CloseRDTunnel closes and deregisters a tunnel by ID.
func (e *Engine) CloseRDTunnel(id string) error {
	e.rdTunnelGate.RLock()
	defer e.rdTunnelGate.RUnlock()

	t := e.rdTunnels.remove(id)
	if t == nil {
		return nil
	}
	return t.Close()
}

// CloseAllRDTunnels tears down every active tunnel. Opening holds the read side
// of the gate from allocation through registration, so a concurrent sweep can
// neither miss a listener nor race the registry's first initialization.
func (e *Engine) CloseAllRDTunnels() {
	e.rdTunnelGate.Lock()
	defer e.rdTunnelGate.Unlock()
	e.rdTunnels.closeAll()
}

func (t *RDTunnel) acceptLoop(ctx context.Context, dialer RDTunnelDialer) {
	defer t.wg.Done()
	for {
		conn, err := t.listener.Accept()
		if err != nil {
			if t.closed.Load() || ctx.Err() != nil {
				return
			}
			continue
		}
		if int(t.connCount.Add(1)) > maxTunnelConns {
			t.connCount.Add(-1)
			_ = conn.Close()
			continue
		}
		t.wg.Add(1)
		go func() {
			defer t.wg.Done()
			defer t.connCount.Add(-1)
			t.bridge(ctx, conn, dialer)
		}()
	}
}

func (t *RDTunnel) authenticate(local net.Conn) bool {
	expected := []byte(rdTunnelAuthPrefix + t.authToken + "\n")
	received := make([]byte, len(expected))
	if err := local.SetReadDeadline(time.Now().Add(rdTunnelAuthTimeout)); err != nil {
		return false
	}
	if _, err := io.ReadFull(local, received); err != nil {
		return false
	}
	if subtle.ConstantTimeCompare(received, expected) != 1 {
		return false
	}
	return local.SetReadDeadline(time.Time{}) == nil
}

func (t *RDTunnel) takeReadyConn() net.Conn {
	t.readyMu.Lock()
	defer t.readyMu.Unlock()
	readyConn := t.readyConn
	t.readyConn = nil
	return readyConn
}

func (t *RDTunnel) bridge(ctx context.Context, local net.Conn, dialer RDTunnelDialer) {
	defer local.Close()
	if !t.authenticate(local) {
		return
	}

	remote := t.takeReadyConn()
	if remote == nil {
		var err error
		remote, err = dialer.DialTarget(ctx)
		if err != nil {
			return
		}
	}
	defer remote.Close()

	// When context is cancelled (tunnel closed), forcefully close both
	// connections so that io.Copy unblocks. A naturally completed bridge also
	// stops this watcher instead of retaining one goroutine until tunnel teardown.
	connectionDone := make(chan struct{})
	defer close(connectionDone)
	go func() {
		select {
		case <-ctx.Done():
			_ = local.Close()
			_ = remote.Close()
		case <-connectionDone:
		}
	}()

	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(local, remote)
		// Half-close: signal the local side that the remote is done writing.
		if tc, ok := local.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
		close(done)
	}()
	_, _ = io.Copy(remote, local)
	// Half-close the remote side.
	if tc, ok := remote.(*net.TCPConn); ok {
		_ = tc.CloseWrite()
	}
	<-done
}
