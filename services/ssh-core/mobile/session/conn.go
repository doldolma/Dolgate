package session

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/sshconn"
)

// ErrConnClosed is returned once a connection has been closed.
var ErrConnClosed = errors.New("connection is closed")

// ConnInfo identifies an established connection.
type ConnInfo struct {
	ID            string
	Host          string
	Port          int
	Username      string
	ConnectedAtMs float64
	ServerVersion string
}

// Conn is an established SSH connection that shells are opened on.
//
// Dialing, the jump chain, host key policy, auth precedence and certificate
// handling all come from internal/sshconn, which the desktop engine uses too.
// This type only adds what mobile needs on top: shell channels whose output is
// retained for cursor reads.
type Conn struct {
	client *ssh.Client
	info   ConnInfo

	mu            sync.Mutex
	shells        map[uint32]*Shell
	nextChannelID uint32
	closed        bool

	// disconnectOnce keeps OnDisconnected to a single firing whether the drop
	// was noticed by the transport watcher or caused by Close.
	disconnectOnce sync.Once
}

// DialOptions describes a connection attempt.
type DialOptions struct {
	// ID is the handle the caller refers to this connection by.
	ID     string
	Target sshconn.Target
	// Config carries timeouts, the per-hop progress callback, and the local
	// ssh-agent endpoint when the target authenticates through one.
	Config sshconn.Config
	// Responder answers keyboard-interactive and password prompts. Nil means
	// those methods are not attempted.
	Responder sshconn.InteractiveResponder
	// OnDisconnected fires once when the transport goes away for any reason,
	// including a remote-side close or a network drop, so the app can mark the
	// session closed without polling. It runs on an internal goroutine.
	OnDisconnected func()
}

// Dial establishes a connection.
func Dial(opts DialOptions) (*Conn, error) {
	client, err := sshconn.DialClient(context.Background(), opts.Target, opts.Config, opts.Responder)
	if err != nil {
		return nil, err
	}

	conn := &Conn{
		client: client,
		info: ConnInfo{
			ID:            opts.ID,
			Host:          opts.Target.Host,
			Port:          opts.Target.Port,
			Username:      opts.Target.Username,
			ConnectedAtMs: nowMs(),
			ServerVersion: string(client.ServerVersion()),
		},
		shells: make(map[uint32]*Shell),
	}

	if opts.OnDisconnected != nil {
		// Wait returns once the transport is gone, whichever side ended it. This
		// is the only signal for a dropped network: a phone that loses signal
		// never sends a disconnect, so nothing else would notice.
		go func() {
			_ = client.Wait()
			conn.notifyDisconnected(opts.OnDisconnected)
		}()
	}
	return conn, nil
}

func (c *Conn) notifyDisconnected(callback func()) {
	c.disconnectOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		shells := make([]*Shell, 0, len(c.shells))
		for _, shell := range c.shells {
			shells = append(shells, shell)
		}
		c.mu.Unlock()

		// The shells are already dead; closing them settles their rings so
		// followers exit and the app's listeners stop.
		for _, shell := range shells {
			_ = shell.Close()
		}
		callback()
	})
}

// Info returns the connection's identity.
func (c *Conn) Info() ConnInfo { return c.info }

// StartShell opens a PTY-backed shell channel.
func (c *Conn) StartShell(opts ShellOptions) (*Shell, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, ErrConnClosed
	}
	channelID := c.nextChannelID
	c.nextChannelID++
	c.mu.Unlock()

	info := ShellInfo{
		ChannelID:    channelID,
		CreatedAtMs:  nowMs(),
		Term:         opts.Term,
		ConnectionID: c.info.ID,
	}

	shell, err := startShell(c.client, info, opts, func() { c.forgetShell(channelID) })
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	if c.closed {
		// Closed while the channel was opening; do not leak the shell.
		c.mu.Unlock()
		_ = shell.Close()
		return nil, ErrConnClosed
	}
	c.shells[channelID] = shell
	c.mu.Unlock()

	return shell, nil
}

// Shell returns a live shell by handle.
func (c *Conn) Shell(channelID uint32) (*Shell, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	shell, ok := c.shells[channelID]
	return shell, ok
}

func (c *Conn) forgetShell(channelID uint32) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.shells, channelID)
}

// Close ends every shell on the connection and then the connection itself. It
// is idempotent.
//
// OnDisconnected does not fire for a Close: the callback means the transport
// went away without being asked, which is the case the app cannot otherwise
// detect. A caller that closed the connection already knows.
func (c *Conn) Close() error {
	c.disconnectOnce.Do(func() {})

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	shells := make([]*Shell, 0, len(c.shells))
	for _, shell := range c.shells {
		shells = append(shells, shell)
	}
	c.shells = make(map[uint32]*Shell)
	c.mu.Unlock()

	for _, shell := range shells {
		_ = shell.Close()
	}

	if err := c.client.Close(); err != nil && !isClosedErr(err) {
		return fmt.Errorf("close connection: %w", err)
	}
	return nil
}
