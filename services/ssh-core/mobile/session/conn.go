package session

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/shellintegration"
	"dolssh/services/ssh-core/internal/sshcmd"
	"golang.org/x/crypto/ssh"
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
// handling all come from internal/sshdial, the path the desktop engine uses too.
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

	completionMu   sync.Mutex
	completionPool *sshcmd.WorkerPool
	revision       atomic.Int64

	shellDetectOnce sync.Once
	remoteShell     string
}

// AdoptOptions describes a connection that has already been dialed.
type AdoptOptions struct {
	// ID is the handle the caller refers to this connection by.
	ID string
	// Host, Port and Username are reported back through Info. They come from the
	// request rather than the client because ssh.Client does not carry the
	// address it was asked for.
	Host     string
	Port     int
	Username string
	// OnDisconnected fires once when the transport goes away for any reason,
	// including a remote-side close or a network drop, so the app can mark the
	// session closed without polling. It runs on an internal goroutine.
	OnDisconnected func()
}

// Adopt wraps an established client.
//
// Dialing itself is not here: it belongs to internal/sshdial, the one path every
// platform opens connections through. Keeping it out of this file is what lets
// mobile receive the things that path owns — the interactive-auth waiting list,
// in-connection host key trust, banners, per-hop progress, and a cancellable
// dial — instead of a fifth copy of the assembly that gets them late or never.
func Adopt(client *ssh.Client, opts AdoptOptions) *Conn {
	conn := &Conn{
		client: client,
		info: ConnInfo{
			ID:            opts.ID,
			Host:          opts.Host,
			Port:          opts.Port,
			Username:      opts.Username,
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
	return conn
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
		c.closeCompletionPool()
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
	c.mu.Unlock()

	// Detect before opening the PTY so servers with MaxSessions=1 still have a
	// free exec channel for the query. Failure means "leave the PTY untouched",
	// which is safe for network appliances and Windows OpenSSH alike.
	c.shellDetectOnce.Do(func() {
		c.remoteShell = shellintegration.DetectRemoteShell(c.client)
	})
	opts.IntegrationShell = c.remoteShell

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

// CollectAutocomplete reads the login shell's history, PATH executables, and
// OS metadata over a short-lived exec channel. It never writes into the PTY.
func (c *Conn) CollectAutocomplete() (autocomplete.Result, error) {
	stdout, _, err := sshcmd.RunWithTimeout(c.client, autocomplete.RemoteSnapshotCommand(), 3*time.Second)
	if err != nil {
		return autocomplete.Degraded(c.remoteShell, "metadata-unavailable"), nil
	}
	revision := int(c.revision.Add(1))
	return autocomplete.ParseSnapshot(stdout, revision), nil
}

// RunCompletion runs one read-only dynamic completion query on a lazily-created
// auxiliary SSH channel. Failure is isolated from the interactive PTY.
func (c *Conn) RunCompletion(command string) (string, bool, error) {
	pool, err := c.getCompletionPool()
	if err != nil {
		return "", false, err
	}
	return autocomplete.RunCompletion(
		autocomplete.PoolTarget(pool, c.client, nil, nil),
		command,
		false,
		false,
	)
}

func (c *Conn) getCompletionPool() (*sshcmd.WorkerPool, error) {
	// Keep the connection alive until the pool is visible to Close. Otherwise a
	// concurrent Close can drain nil, after which this method creates a worker
	// that nobody owns and that still points at the closed SSH client.
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, ErrConnClosed
	}
	c.completionMu.Lock()
	defer c.completionMu.Unlock()
	if c.completionPool == nil {
		c.completionPool = sshcmd.NewWorkerPool(c.client)
	}
	return c.completionPool, nil
}

func (c *Conn) closeCompletionPool() {
	c.completionMu.Lock()
	pool := c.completionPool
	c.completionPool = nil
	c.completionMu.Unlock()
	if pool != nil {
		_ = pool.Close()
	}
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
	c.closeCompletionPool()

	if err := c.client.Close(); err != nil && !isClosedErr(err) {
		return fmt.Errorf("close connection: %w", err)
	}
	return nil
}
