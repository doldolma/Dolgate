package mobile

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/mobile/ringbuf"
	"dolssh/services/ssh-core/mobile/session"
	"dolssh/services/ssh-core/mobile/vaultkdf"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// This file is the whole surface gomobile binds, and its shape is dictated by
// what gomobile can carry rather than by what would read best in Go:
//
//   - Unsigned 64- and 32-bit integers are not supported, so sequence numbers
//     cross as int64 and are converted at the boundary.
//   - Slices of structs are not supported, so a replay crosses as one
//     concatenated []byte behind a result object instead of a chunk list. The
//     app only ever concatenated them anyway.
//   - Sum types are not supported, so a listener gets two distinct callbacks
//     rather than one tagged event.
//   - Recursive structs are not supported, and a jump chain is recursive, so
//     connect and shell options arrive as JSON.
//   - A method may return at most two values and the second must be error, so
//     multi-field results are returned as objects with accessors.
//
// Connect options deliberately reuse coretypes.ConnectPayload, the same wire
// format the desktop app sends over the stdio protocol, so there is one
// vocabulary for a connection request rather than one per platform.

// Version identifies this engine build in app-side diagnostics. It exists so a
// dark launch can confirm which engine actually served a session.
func Version() string { return "go-engine/1" }

// Cursor modes accepted by ReadBuffer and AddListener.
const (
	CursorHead      = 0
	CursorTailBytes = 1
	CursorSeq       = 2
	CursorTimeMs    = 3
	CursorLive      = 4
)

// Stream identifiers reported to a Listener.
const (
	StreamStdout = 0
	StreamStderr = 1
)

// Listener receives terminal output. The host implements it.
//
// Calls are serialized per listener, and live chunks are merged over a
// coalescing window before each call, which is what keeps a noisy session from
// flooding the bridge.
type Listener interface {
	OnChunk(seq int64, tMs float64, stream int, data []byte)
	OnDropped(fromSeq int64, toSeq int64)
}

// InteractiveResponder answers keyboard-interactive and password prompts.
//
// Respond receives a challenge as JSON ({"name","instruction","prompts":
// [{"label","echo"}]}) and must return a JSON array of answer strings, one per
// prompt.
type InteractiveResponder interface {
	Respond(challengeJSON string) (string, error)
}

// ShellClosedCallback fires once after a shell channel has ended and all of its
// output has been stored.
type ShellClosedCallback interface {
	OnShellClosed(channelID int64)
}

// Engine is the entry point the app holds for the lifetime of the process.
type Engine struct {
	tailnetMu      sync.Mutex
	tailnetRuntime *mobileTailnetRuntime
}

// NewEngine returns an engine.
func NewEngine() *Engine { return &Engine{} }

// connectRequest is the wire form of a connection request: the desktop connect
// payload, plus the handle the app wants to refer to it by and the timeouts.
type connectRequest struct {
	ID string `json:"id"`
	coretypes.ConnectPayload
	DialTimeoutMs       int `json:"dialTimeoutMs,omitempty"`
	KeepAliveIntervalMs int `json:"keepAliveIntervalMs,omitempty"`
}

// DisconnectedCallback fires once if a connection's transport goes away without
// being closed by the app.
type DisconnectedCallback interface {
	OnDisconnected(connectionID string)
}

// ProbeHostKey fetches the host key a target presents, without completing
// authentication. requestJSON is the same connect payload Connect takes; only
// the addressing and jump fields are read.
//
// The app needs this because host key trust is decided interactively, while the
// dialer checks strictly against keys it was given up front. So an unknown host
// is probed, the answer is shown to the user, and the accepted key is passed
// back in as trustedHostKeyBase64 on the real connect. When a host is already
// trusted the probe can be skipped: the connect itself enforces the same check.
//
// Returns JSON: {"algorithm","publicKeyBase64","fingerprintSha256"}.
func (e *Engine) ProbeHostKey(requestJSON string) (string, error) {
	var request connectRequest
	if err := json.Unmarshal([]byte(requestJSON), &request); err != nil {
		return "", fmt.Errorf("parse probe request: %w", err)
	}

	payload := request.ConnectPayload
	config, err := e.dialConfig(request)
	if err != nil {
		return "", err
	}
	result, err := sshconn.ProbeHostKey(
		context.Background(),
		payload.Host,
		payload.Port,
		sshconn.JumpTargetFromCore(payload.Jump),
		payload.WSProxy,
		config,
	)
	if err != nil {
		return "", err
	}

	encoded, err := json.Marshal(map[string]any{
		"algorithm":         result.Algorithm,
		"publicKeyBase64":   result.PublicKeyBase64,
		"fingerprintSha256": result.FingerprintSHA256,
	})
	if err != nil {
		return "", fmt.Errorf("encode host key: %w", err)
	}
	return string(encoded), nil
}

// InspectPrivateKey validates a private key and reports what it is, so the app
// can reject an unusable credential before opening a connection.
//
// Returns JSON: {"algorithm","publicKey","fingerprintSha256"}.
func (e *Engine) InspectPrivateKey(privateKeyPEM, passphrase string) (string, error) {
	result, err := sshconn.InspectPrivateKey(privateKeyPEM, passphrase)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(map[string]any{
		"algorithm":         result.Algorithm,
		"publicKey":         result.PublicKey,
		"fingerprintSha256": result.FingerprintSHA256,
	})
	if err != nil {
		return "", fmt.Errorf("encode private key inspection: %w", err)
	}
	return string(encoded), nil
}

// InspectCertificate reports a certificate's validity window and principals.
//
// Returns JSON: {"status","validAfter","validBefore","principals","keyId","serial"}.
// The timestamps are RFC 3339 or absent.
func (e *Engine) InspectCertificate(certificateText string) (string, error) {
	result := sshconn.InspectCertificate(certificateText, time.Now())

	fields := map[string]any{
		"status":     result.Status,
		"principals": result.Principals,
		"keyId":      result.KeyID,
		"serial":     toInt64(result.Serial),
	}
	if result.ValidAfter != nil {
		fields["validAfter"] = result.ValidAfter.Format(time.RFC3339)
	}
	if result.ValidBefore != nil {
		fields["validBefore"] = result.ValidBefore.Format(time.RFC3339)
	}

	encoded, err := json.Marshal(fields)
	if err != nil {
		return "", fmt.Errorf("encode certificate inspection: %w", err)
	}
	return string(encoded), nil
}

// dialConfig builds the dialer config shared by Connect and ProbeHostKey.
func (e *Engine) dialConfig(request connectRequest) (sshconn.Config, error) {
	config := sshconn.DefaultConfig
	if request.DialTimeoutMs > 0 {
		config.TCPDialTimeout = time.Duration(request.DialTimeoutMs) * time.Millisecond
	}
	if request.KeepAliveIntervalMs > 0 {
		config.TCPKeepAliveInterval = time.Duration(request.KeepAliveIntervalMs) * time.Millisecond
	}
	config.AuthAgentEndpointKind = request.AuthAgentEndpointKind
	config.AuthAgentEndpoint = request.AuthAgentEndpoint

	dial, err := e.resolveTailnetDial(request.TailnetID, request.TailnetName)
	if err != nil {
		return sshconn.Config{}, err
	}
	config.Dial = dial
	return config, nil
}

// Connect establishes an SSH connection. responder and onDisconnected may each
// be nil.
func (e *Engine) Connect(
	requestJSON string,
	responder InteractiveResponder,
	onDisconnected DisconnectedCallback,
) (*Conn, error) {
	var request connectRequest
	if err := json.Unmarshal([]byte(requestJSON), &request); err != nil {
		return nil, fmt.Errorf("parse connect request: %w", err)
	}

	payload := request.ConnectPayload
	config, err := e.dialConfig(request)
	if err != nil {
		return nil, err
	}
	target := sshconn.Target{
		Host:                  payload.Host,
		Port:                  payload.Port,
		Username:              payload.Username,
		AuthType:              payload.AuthType,
		Password:              payload.Password,
		PrivateKeyPEM:         payload.PrivateKeyPEM,
		CertificateText:       payload.CertificateText,
		Passphrase:            payload.Passphrase,
		TrustedHostKeyBase64:  payload.TrustedHostKeyBase64,
		TrustedHostKeysBase64: payload.TrustedHostKeysBase64,
		Jump:                  sshconn.JumpTargetFromCore(payload.Jump),
		WSProxy:               payload.WSProxy,
	}

	opts := session.DialOptions{
		ID:        request.ID,
		Target:    target,
		Config:    config,
		Responder: bridgeResponder(responder),
	}
	if onDisconnected != nil {
		connectionID := request.ID
		opts.OnDisconnected = func() { onDisconnected.OnDisconnected(connectionID) }
	}

	conn, err := session.Dial(opts)
	if err != nil {
		return nil, err
	}

	return &Conn{
		conn:        conn,
		defaultRows: payload.Rows,
		defaultCols: payload.Cols,
	}, nil
}

// bridgeResponder adapts the host's JSON-based responder to the dialer's
// callback, or returns nil so the dialer skips interactive auth entirely.
func bridgeResponder(responder InteractiveResponder) sshconn.InteractiveResponder {
	if responder == nil {
		return nil
	}
	return func(challenge sshconn.InteractiveChallenge) ([]string, error) {
		encoded, err := json.Marshal(challengeWire{
			Name:        challenge.Name,
			Instruction: challenge.Instruction,
			Prompts:     promptsWire(challenge.Prompts),
		})
		if err != nil {
			return nil, fmt.Errorf("encode challenge: %w", err)
		}

		answersJSON, err := responder.Respond(string(encoded))
		if err != nil {
			return nil, err
		}

		var answers []string
		if err := json.Unmarshal([]byte(answersJSON), &answers); err != nil {
			return nil, fmt.Errorf("parse challenge answers: %w", err)
		}
		return answers, nil
	}
}

type challengeWire struct {
	Name        string       `json:"name"`
	Instruction string       `json:"instruction"`
	Prompts     []promptWire `json:"prompts"`
}

type promptWire struct {
	Label string `json:"label"`
	Echo  bool   `json:"echo"`
}

func promptsWire(prompts []sshconn.InteractivePrompt) []promptWire {
	out := make([]promptWire, 0, len(prompts))
	for _, prompt := range prompts {
		out = append(out, promptWire{Label: prompt.Label, Echo: prompt.Echo})
	}
	return out
}

// Conn is a handle to an established connection.
type Conn struct {
	conn *session.Conn
	// Geometry from the connect payload, used when shell options omit it.
	defaultRows int
	defaultCols int
}

// InfoJSON describes the connection.
func (c *Conn) InfoJSON() (string, error) {
	info := c.conn.Info()
	encoded, err := json.Marshal(map[string]any{
		"id":            info.ID,
		"host":          info.Host,
		"port":          info.Port,
		"username":      info.Username,
		"connectedAtMs": info.ConnectedAtMs,
		"serverVersion": info.ServerVersion,
	})
	if err != nil {
		return "", fmt.Errorf("encode connection info: %w", err)
	}
	return string(encoded), nil
}

// shellOptionsWire is the wire form of shell options.
type shellOptionsWire struct {
	// Term is the TERM name ("xterm-256color", "vt220", ...).
	Term              string             `json:"term,omitempty"`
	Rows              int                `json:"rows,omitempty"`
	Cols              int                `json:"cols,omitempty"`
	PixelWidth        int                `json:"pixelWidth,omitempty"`
	PixelHeight       int                `json:"pixelHeight,omitempty"`
	Modes             []terminalModeWire `json:"modes,omitempty"`
	RingCapacityBytes int                `json:"ringCapacityBytes,omitempty"`
	MaxChunkBytes     int                `json:"maxChunkBytes,omitempty"`
}

type terminalModeWire struct {
	Opcode int `json:"opcode"`
	Value  int `json:"value"`
}

// StartShell opens a PTY-backed shell. optionsJSON may be empty for defaults;
// onClosed may be nil.
func (c *Conn) StartShell(optionsJSON string, onClosed ShellClosedCallback) (*Shell, error) {
	var wire shellOptionsWire
	if optionsJSON != "" {
		if err := json.Unmarshal([]byte(optionsJSON), &wire); err != nil {
			return nil, fmt.Errorf("parse shell options: %w", err)
		}
	}

	rows := wire.Rows
	if rows <= 0 {
		rows = c.defaultRows
	}
	cols := wire.Cols
	if cols <= 0 {
		cols = c.defaultCols
	}

	opts := session.ShellOptions{
		Term:              session.TerminalTypeFromName(wire.Term),
		Rows:              clampUint32(rows),
		Cols:              clampUint32(cols),
		PixelWidth:        clampUint32(wire.PixelWidth),
		PixelHeight:       clampUint32(wire.PixelHeight),
		RingCapacityBytes: wire.RingCapacityBytes,
		MaxChunkBytes:     wire.MaxChunkBytes,
	}
	for _, mode := range wire.Modes {
		if mode.Opcode < 0 || mode.Opcode > math.MaxUint8 {
			return nil, fmt.Errorf("terminal mode opcode %d is out of range", mode.Opcode)
		}
		opts.Modes = append(opts.Modes, session.TerminalMode{
			Opcode: uint8(mode.Opcode),
			Value:  clampUint32(mode.Value),
		})
	}
	if onClosed != nil {
		opts.OnClosed = func(channelID uint32) { onClosed.OnShellClosed(int64(channelID)) }
	}

	shell, err := c.conn.StartShell(opts)
	if err != nil {
		return nil, err
	}
	return &Shell{shell: shell, followers: make(map[int64]*ringbuf.Follower)}, nil
}

// StartSFTP opens a file-transfer session on the connection. A shell and an
// SFTP session can be open at the same time; they share one transport.
func (c *Conn) StartSFTP() (*SFTPSession, error) {
	sftp, err := c.conn.StartSFTP()
	if err != nil {
		return nil, err
	}
	return &SFTPSession{sftp: sftp}, nil
}

// Close ends every shell on the connection and then the connection.
func (c *Conn) Close() error { return c.conn.Close() }

// SFTPSession is a handle to a file-transfer session.
type SFTPSession struct {
	sftp *session.SFTP
}

// ListJSON returns a directory listing as
// {"path","entries":[{"name","path","isDirectory","size","mtime","kind",...}]},
// the same records the desktop engine sends, so the file browser renders both
// platforms identically.
func (s *SFTPSession) ListJSON(dir string) (string, error) {
	listing, err := s.sftp.List(dir)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(listing)
	if err != nil {
		return "", fmt.Errorf("encode listing: %w", err)
	}
	return string(encoded), nil
}

// ReadChunk reads up to length bytes at offset.
func (s *SFTPSession) ReadChunk(remotePath string, offset int64, length int) (*ChunkResult, error) {
	data, eof, err := s.sftp.ReadChunk(remotePath, offset, length)
	if err != nil {
		return nil, err
	}
	return &ChunkResult{data: data, eof: eof}, nil
}

// WriteChunk writes data at offset, creating the file if needed. Successive
// chunks of one upload seek rather than truncate.
func (s *SFTPSession) WriteChunk(remotePath string, offset int64, data []byte) error {
	return s.sftp.WriteChunk(remotePath, offset, data)
}

// ReadTextFileJSON loads a file for the built-in editor as
// {"content","size","mtime","mode"}. The identity fields come back so a later
// save can tell the remote changed underneath the editor.
//
// gomobile only crosses a narrow set of types, so this follows ListJSON and
// hands the payload over as JSON rather than a bound struct.
func (s *SFTPSession) ReadTextFileJSON(remotePath string) (string, error) {
	loaded, err := s.sftp.ReadTextFile(remotePath)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(loaded)
	if err != nil {
		return "", fmt.Errorf("encode file: %w", err)
	}
	return string(encoded), nil
}

// WriteTextFile saves editor content. The request arrives as JSON matching
// session.WriteTextFileRequest — expectedSize/expectedMtime are optional and
// omitting both turns the save into an unconditional overwrite.
//
// A conflict comes back as an error carrying the "sftp-conflict:" prefix so the
// app can offer reload-or-overwrite instead of a generic failure.
func (s *SFTPSession) WriteTextFile(requestJSON string) error {
	var request struct {
		Path          string `json:"path"`
		Content       string `json:"content"`
		ExpectedSize  *int64 `json:"expectedSize"`
		ExpectedMtime string `json:"expectedMtime"`
		Mode          int    `json:"mode"`
		PreserveMtime bool   `json:"preserveMtime"`
		Force         bool   `json:"force"`
	}
	if err := json.Unmarshal([]byte(requestJSON), &request); err != nil {
		return fmt.Errorf("decode write request: %w", err)
	}
	return s.sftp.WriteTextFile(session.WriteTextFileRequest{
		Path:          request.Path,
		Content:       request.Content,
		ExpectedSize:  request.ExpectedSize,
		ExpectedMtime: request.ExpectedMtime,
		Mode:          request.Mode,
		PreserveMtime: request.PreserveMtime,
		Force:         request.Force,
	})
}

// Mkdir creates a directory.
func (s *SFTPSession) Mkdir(dir string) error { return s.sftp.Mkdir(dir) }

// Rename moves a file or directory.
func (s *SFTPSession) Rename(sourcePath, targetPath string) error {
	return s.sftp.Rename(sourcePath, targetPath)
}

// Chmod changes permission bits.
func (s *SFTPSession) Chmod(remotePath string, mode int) error {
	if mode < 0 || uint64(mode) > math.MaxUint32 {
		return fmt.Errorf("permission bits %d are out of range", mode)
	}
	return s.sftp.Chmod(remotePath, uint32(mode))
}

// Remove deletes a file, or an empty directory. Recursive deletion stays with
// the caller, which walks the tree to report progress.
func (s *SFTPSession) Remove(remotePath string) error { return s.sftp.Remove(remotePath) }

// StatJSON describes one entry, for confirming a transfer landed.
func (s *SFTPSession) StatJSON(remotePath string) (string, error) {
	entry, err := s.sftp.Stat(remotePath)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(entry)
	if err != nil {
		return "", fmt.Errorf("encode entry: %w", err)
	}
	return string(encoded), nil
}

// Close ends the SFTP session.
func (s *SFTPSession) Close() error { return s.sftp.Close() }

// ChunkResult carries a read's bytes and whether it reached the end of the
// file. It is an object because gomobile allows only (value, error).
type ChunkResult struct {
	data []byte
	eof  bool
}

// Data is the bytes read.
func (r *ChunkResult) Data() []byte { return r.data }

// EOF reports that the read reached the end of the file, which is how a
// transfer loop knows to stop without a separate stat.
func (r *ChunkResult) EOF() bool { return r.eof }

// DeriveArgon2idKey derives the sync vault's key-encryption key.
//
// This runs natively because a memory-hard KDF is impractically slow in
// Hermes. The result must match the other implementations byte for byte —
// an existing vault becomes undecryptable otherwise — which is checked against
// the vectors shared with TypeScript and Rust.
//
// The passphrase must already be NFC-normalised by the caller; normalisation
// belongs with the text handling, not here.
func (e *Engine) DeriveArgon2idKey(
	passphrase []byte,
	salt []byte,
	memoryKiB int,
	timeCost int,
	parallelism int,
	outputLength int,
) ([]byte, error) {
	return vaultkdf.Derive(passphrase, salt, memoryKiB, timeCost, parallelism, outputLength)
}

// Shell is a handle to a live shell channel.
type Shell struct {
	shell *session.Shell

	mu             sync.Mutex
	followers      map[int64]*ringbuf.Follower
	nextListenerID int64
}

// InfoJSON describes the shell.
func (s *Shell) InfoJSON() (string, error) {
	info := s.shell.Info()
	encoded, err := json.Marshal(map[string]any{
		"channelId":     int64(info.ChannelID),
		"createdAtMs":   info.CreatedAtMs,
		"connectedAtMs": info.ConnectedAtMs,
		"term":          info.Term.SSHName(),
		"connectionId":  info.ConnectionID,
	})
	if err != nil {
		return "", fmt.Errorf("encode shell info: %w", err)
	}
	return string(encoded), nil
}

// SendData writes bytes to the shell's stdin.
func (s *Shell) SendData(data []byte) error { return s.shell.SendData(data) }

// Resize reports new terminal geometry to the remote side.
func (s *Shell) Resize(rows, cols int) error {
	return s.shell.Resize(clampUint32(rows), clampUint32(cols))
}

// CurrentSeq is the sequence number the next chunk of output will carry.
func (s *Shell) CurrentSeq() int64 { return toInt64(s.shell.Ring().CurrentSeq()) }

// StatsJSON reports ring occupancy, for diagnostics.
func (s *Shell) StatsJSON() (string, error) {
	stats := s.shell.Ring().Stats()
	encoded, err := json.Marshal(map[string]any{
		"ringBytesCount":    toInt64(stats.RingBytesCount),
		"usedBytes":         toInt64(stats.UsedBytes),
		"chunksCount":       toInt64(stats.ChunksCount),
		"headSeq":           toInt64(stats.HeadSeq),
		"tailSeq":           toInt64(stats.TailSeq),
		"droppedBytesTotal": toInt64(stats.DroppedBytesTotal),
	})
	if err != nil {
		return "", fmt.Errorf("encode buffer stats: %w", err)
	}
	return string(encoded), nil
}

// ReadBuffer returns stored output from a cursor as one buffer.
//
// Only the argument belonging to cursorMode is read: seq for CursorSeq,
// tailBytes for CursorTailBytes, timeMs for CursorTimeMs. A non-positive
// maxBytes takes the default cap.
func (s *Shell) ReadBuffer(cursorMode int, seq int64, tailBytes int64, timeMs float64, maxBytes int) *ReadResult {
	result := s.shell.Ring().Read(buildCursor(cursorMode, seq, tailBytes, timeMs), maxBytes)
	return newReadResult(result)
}

// AddListener replays from a cursor and then follows live output, merging
// chunks within coalesceMs (non-positive takes the default). The returned id is
// passed to RemoveListener.
func (s *Shell) AddListener(listener Listener, cursorMode int, seq int64, tailBytes int64, timeMs float64, coalesceMs int) int64 {
	if listener == nil {
		return 0
	}

	window := time.Duration(coalesceMs) * time.Millisecond
	follower := ringbuf.Follow(
		s.shell.Ring(),
		buildCursor(cursorMode, seq, tailBytes, timeMs),
		window,
		&listenerBridge{listener: listener},
	)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextListenerID++
	id := s.nextListenerID
	s.followers[id] = follower
	return id
}

// RemoveListener stops a listener. It returns once no further callback can
// arrive, and is safe to call with an unknown id.
func (s *Shell) RemoveListener(id int64) {
	s.mu.Lock()
	follower, ok := s.followers[id]
	delete(s.followers, id)
	s.mu.Unlock()

	if ok {
		follower.Stop()
	}
}

// Close ends the shell and stops its listeners.
func (s *Shell) Close() error {
	err := s.shell.Close()

	s.mu.Lock()
	followers := make([]*ringbuf.Follower, 0, len(s.followers))
	for id, follower := range s.followers {
		followers = append(followers, follower)
		delete(s.followers, id)
	}
	s.mu.Unlock()

	for _, follower := range followers {
		follower.Stop()
	}
	return err
}

// listenerBridge converts ring callbacks into the host's int64-based ones.
type listenerBridge struct {
	listener Listener
}

func (b *listenerBridge) OnChunk(chunk ringbuf.Chunk) {
	stream := StreamStdout
	if chunk.Stream == ringbuf.StreamStderr {
		stream = StreamStderr
	}
	b.listener.OnChunk(toInt64(chunk.Seq), chunk.TMs, stream, chunk.Bytes)
}

func (b *listenerBridge) OnDropped(fromSeq, toSeq uint64) {
	b.listener.OnDropped(toInt64(fromSeq), toInt64(toSeq))
}

// ReadResult carries the outcome of ReadBuffer. It is an object rather than a
// multi-value return because gomobile allows only (value, error).
type ReadResult struct {
	data        []byte
	nextSeq     int64
	dropped     bool
	droppedFrom int64
	droppedTo   int64
}

func newReadResult(result ringbuf.ReadResult) *ReadResult {
	total := 0
	for _, chunk := range result.Chunks {
		total += len(chunk.Bytes)
	}
	data := make([]byte, 0, total)
	for _, chunk := range result.Chunks {
		data = append(data, chunk.Bytes...)
	}

	out := &ReadResult{data: data, nextSeq: toInt64(result.NextSeq)}
	if result.Dropped != nil {
		out.dropped = true
		out.droppedFrom = toInt64(result.Dropped.FromSeq)
		out.droppedTo = toInt64(result.Dropped.ToSeq)
	}
	return out
}

// Data is the stored output, concatenated in sequence order. stdout and stderr
// are interleaved as they arrived, which is how a terminal renders them.
func (r *ReadResult) Data() []byte { return r.data }

// NextSeq is the cursor to resume from, whether by another read or by
// AddListener. Handing it straight back is what makes the replay-then-follow
// handover exact.
func (r *ReadResult) NextSeq() int64 { return r.nextSeq }

// HasDropped reports whether part of the requested range had already been
// evicted.
func (r *ReadResult) HasDropped() bool { return r.dropped }

// DroppedFromSeq is the first sequence number that was unavailable.
func (r *ReadResult) DroppedFromSeq() int64 { return r.droppedFrom }

// DroppedToSeq is the last sequence number that was unavailable, inclusive.
func (r *ReadResult) DroppedToSeq() int64 { return r.droppedTo }

func buildCursor(cursorMode int, seq int64, tailBytes int64, timeMs float64) ringbuf.Cursor {
	switch cursorMode {
	case CursorTailBytes:
		return ringbuf.Cursor{Mode: ringbuf.CursorTailBytes, Bytes: toUint64(tailBytes)}
	case CursorSeq:
		return ringbuf.Cursor{Mode: ringbuf.CursorSeq, Seq: toUint64(seq)}
	case CursorTimeMs:
		return ringbuf.Cursor{Mode: ringbuf.CursorTimeMs, TMs: timeMs}
	case CursorLive:
		return ringbuf.Cursor{Mode: ringbuf.CursorLive}
	default:
		return ringbuf.Cursor{Mode: ringbuf.CursorHead}
	}
}

func toInt64(value uint64) int64 {
	if value > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(value)
}

func toUint64(value int64) uint64 {
	if value < 0 {
		return 0
	}
	return uint64(value)
}

func clampUint32(value int) uint32 {
	if value < 0 {
		return 0
	}
	// Widening before the comparison keeps this compiling on 32-bit targets,
	// where int is too narrow to hold math.MaxUint32 as a constant.
	if uint64(value) > math.MaxUint32 {
		return math.MaxUint32
	}
	return uint32(value)
}
