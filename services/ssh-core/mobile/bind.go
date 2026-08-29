package mobile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/hostkeytrust"
	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/internal/sshdial"
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

// ConnectionEventListener receives the events a connection raises while it is
// being opened: per-hop progress, the server banner, the keyboard-interactive
// challenges (OTP), and the host key trust question.
//
// It carries the same JSON events as the desktop stdio protocol, for the reason
// TailnetEventListener does — one event vocabulary means the connection screen
// is decided once and both apps render the same thing.
//
// **Why a listener rather than a blocking callback.** A prompt has to reach a
// screen and wait for a person, and the app's UI runs on its own thread; a Go
// call that blocks inside the bridge waiting for that would hold the connection
// on the bridge's thread. So the question goes up as an event, and the answer
// comes back through RespondKeyboardInteractive / RespondHostKeyTrust. The
// waiting itself happens in internal/sshdial, where the desktop's does.
type ConnectionEventListener interface {
	OnConnectionEvent(eventJSON string)
}

// The prompts a connection raises are answered through this listener, not
// through a responder object handed to Connect. The previous shape — a blocking
// Respond(challengeJSON) the host implemented — is gone because nothing could
// implement it: both native bridges passed nil, so an OTP host could not be
// connected to at all from mobile.

// ShellClosedCallback fires once after a shell channel has ended and all of its
// output has been stored.
type ShellClosedCallback interface {
	OnShellClosed(channelID int64)
}

// Engine is the entry point the app holds for the lifetime of the process.
type Engine struct {
	tailnetMu      sync.Mutex
	tailnetRuntime *mobileTailnetRuntime

	// dialer is the one path connections are opened through, shared with the
	// desktop engine. It owns the interactive-auth waiting list, so the answers
	// arriving from the app find their challenge without this file keeping a
	// second registry that could disagree with it.
	dialer    *sshdial.Dialer
	hostTrust *hostkeytrust.Registry

	connectionListenerMu sync.RWMutex
	connectionListener   ConnectionEventListener

	// Remote Desktop loopback tunnels (rdtunnel.go). The gate makes opening and
	// sweeping atomic with respect to each other, including the first use.
	rdTunnelGate sync.RWMutex
	rdTunnels    *rdTunnelRegistry
}

// NewEngine returns an engine.
func NewEngine() *Engine {
	engine := &Engine{
		hostTrust: hostkeytrust.New(),
		rdTunnels: newRDTunnelRegistry(),
	}
	engine.dialer = sshdial.New(engine.emitConnectionEvent)
	// The tailnet runtime is created later, when the app configures it, so the
	// resolver is a method that looks it up at dial time rather than a value.
	engine.dialer.SetTailnetDial(engine.resolveTailnetDial)
	engine.dialer.SetHostKeyTrustPrompt(func(
		ctx context.Context,
		correlation hostkeytrust.Correlation,
	) sshconn.HostKeyTrustFunc {
		return engine.hostTrust.Prompt(ctx, engine.emitConnectionEvent, correlation)
	})
	return engine
}

// SetConnectionEventListener registers where connection events go. Passing nil
// drops them, which is what a probe or a background reconnect wants.
func (e *Engine) SetConnectionEventListener(listener ConnectionEventListener) {
	e.connectionListenerMu.Lock()
	e.connectionListener = listener
	e.connectionListenerMu.Unlock()
}

func (e *Engine) hasConnectionListener() bool {
	e.connectionListenerMu.RLock()
	defer e.connectionListenerMu.RUnlock()
	return e.connectionListener != nil
}

func (e *Engine) emitConnectionEvent(event coretypes.Event) {
	e.connectionListenerMu.RLock()
	listener := e.connectionListener
	e.connectionListenerMu.RUnlock()
	if listener == nil {
		return
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		return
	}
	listener.OnConnectionEvent(string(encoded))
}

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
// Connecting does not need this: an unknown key raises a trust question inside
// the connection it appeared in (see ConnectionEventListener), which is what
// keeps an OTP host from asking for a code twice — once for the probe and once
// for the real connect, with a code that changes every 30 seconds in between.
//
// No app screen calls it today. It stays because reading a key without
// authenticating is a distinct capability — the desktop uses its own equivalent
// for host editing — and because it is the only way to answer "what key does this
// host present" without opening a session.
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

// dialConfig builds the config for ProbeHostKey.
//
// Connect does not come here — internal/sshdial assembles its config, which is
// the point of routing through it. A probe deliberately gets less: no trust
// question, no banner, no progress. There is no screen behind a probe, and
// waiting for an answer nobody can give is just a stall.
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

// Connect establishes an SSH connection. onDisconnected may be nil.
//
// While it runs, the connection raises events to the listener set by
// SetConnectionEventListener: per-hop progress, the server banner, OTP
// challenges, and the host key trust question. Answers come back through
// RespondKeyboardInteractive and RespondHostKeyTrust, so this call stays blocked
// until the person answers, the connection fails, or CancelConnect cuts it.
func (e *Engine) Connect(
	requestJSON string,
	onDisconnected DisconnectedCallback,
) (*Conn, error) {
	var request connectRequest
	if err := json.Unmarshal([]byte(requestJSON), &request); err != nil {
		return nil, fmt.Errorf("parse connect request: %w", err)
	}
	payload := request.ConnectPayload

	// Registering before the dial is what makes CancelConnect able to reach it.
	ctx, finish := e.dialer.Begin(request.ID)
	defer finish()

	// Questions are asked only when there is somewhere to show them. With no
	// listener the events go nowhere, and waiting for an answer nobody can see is
	// not caution — it is a connect that hangs for its whole budget. Passing an
	// empty correlation id is how internal/sshdial is told that (see its
	// Request.SessionID); the dial itself stays cancellable either way, because
	// Begin was given the real handle.
	correlationID := ""
	if e.hasConnectionListener() {
		correlationID = request.ID
	}

	client, _, err := e.dialer.Dial(ctx, sshdial.Request{
		// One id for both: mobile has a single handle per connection, and the app
		// keys its screen by that handle.
		SessionID:            correlationID,
		RequestID:            correlationID,
		Payload:              payload,
		TCPDialTimeout:       millis(request.DialTimeoutMs),
		TCPKeepAliveInterval: millis(request.KeepAliveIntervalMs),
	})
	if err != nil {
		return nil, err
	}

	opts := session.AdoptOptions{
		ID:       request.ID,
		Host:     payload.Host,
		Port:     payload.Port,
		Username: payload.Username,
	}
	if onDisconnected != nil {
		connectionID := request.ID
		opts.OnDisconnected = func() { onDisconnected.OnDisconnected(connectionID) }
	}

	return &Conn{
		conn:        session.Adopt(client, opts),
		defaultRows: payload.Rows,
		defaultCols: payload.Cols,
	}, nil
}

// RespondKeyboardInteractive hands the person's answers to the challenge that
// asked for them. payloadJSON is coretypes.KeyboardInteractiveRespondPayload:
// {"challengeId","responses":[…],"storedPasswordIndexes":[…],"cancelled":bool}.
//
// storedPasswordIndexes names the prompts to fill with the saved password. The
// password itself never leaves the engine, so the app returns positions instead
// of reading a secret out and back in.
//
// cancelled means the person closed the sheet, and it comes through this same
// call for the reason the desktop's does: a dismissed prompt has to be told, or
// the connection waits out its budget with nothing coming — holding a tailnet
// node's lease while it waits. Routing it here keeps one path for "the sheet
// closed", so the two platforms cannot drift on which one they answer through.
func (e *Engine) RespondKeyboardInteractive(payloadJSON string) error {
	var payload coretypes.KeyboardInteractiveRespondPayload
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return fmt.Errorf("parse keyboard-interactive response: %w", err)
	}
	if payload.Cancelled {
		return e.dialer.CancelChallenge(payload.ChallengeID)
	}
	return e.dialer.RespondKeyboardInteractive(payload)
}

// RespondHostKeyTrust answers the trust question raised mid-connection.
func (e *Engine) RespondHostKeyTrust(challengeID string, trust bool) error {
	return e.hostTrust.Respond(challengeID, trust)
}

// CancelConnect cuts a connection that is still being opened.
//
// Both halves are needed. Cancelling the context unblocks the machine-side waits
// (dial, handshake), and closing the challenges unblocks a wait for a person —
// neither one releases the other.
func (e *Engine) CancelConnect(connectionID string) {
	e.dialer.CancelInFlight(connectionID)
	e.dialer.CancelChallenges(connectionID)
}

func millis(value int) time.Duration {
	if value <= 0 {
		return 0
	}
	return time.Duration(value) * time.Millisecond
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
	return &Shell{shell: shell, conn: c.conn, fan: newOutputFan(shell.Ring())}, nil
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
	// SSH 셸이면 채워진다. SSM 셸(rdpecam 아닌 AWS SSM 세션)에서는 nil 이다.
	shell *session.Shell
	// conn owns the auxiliary completion channel for an SSH shell. Direct SSM
	// has no SSH connection and leaves this nil.
	conn *session.Conn
	// SSM 셸이면 채워진다.
	ssm *ssmShell
	// 출력 구독. 두 경우가 **같은 헬퍼**를 쓴다(outputfan.go 주석 참고).
	fan *outputFan
}

// InfoJSON describes the shell.
func (s *Shell) InfoJSON() (string, error) {
	if s.ssm != nil {
		// SSM 세션에는 SSH 채널이 없다. 앱은 이 값들을 표시에만 쓰므로 0 과 세션 손잡이로 채운다.
		encoded, err := json.Marshal(map[string]any{
			"channelId":     int64(0),
			"createdAtMs":   s.ssm.createdAtMs,
			"connectedAtMs": s.ssm.createdAtMs,
			"term":          "xterm-256color",
			"connectionId":  s.ssm.sessionID,
		})
		if err != nil {
			return "", fmt.Errorf("encode shell info: %w", err)
		}
		return string(encoded), nil
	}
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
func (s *Shell) SendData(data []byte) error {
	if s.ssm != nil {
		return s.ssm.sendData(data)
	}
	return s.shell.SendData(data)
}

// PrepareAutocompleteJSON returns the capability and metadata snapshot used by
// both mobile and desktop completion controllers.
func (s *Shell) PrepareAutocompleteJSON() (string, error) {
	var (
		result autocomplete.Result
		err    error
	)
	if s.ssm != nil {
		revision := int(s.ssm.autocompleteRevision.Add(1))
		result, err = s.ssm.manager.CollectAutocomplete(s.ssm.sessionID, revision)
	} else if s.conn != nil {
		result, err = s.conn.CollectAutocomplete()
	} else {
		result = autocomplete.Unsupported()
	}
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(map[string]any{
		"capability": result.Capability,
		"snapshot":   result.Snapshot,
	})
	if err != nil {
		return "", fmt.Errorf("encode autocomplete result: %w", err)
	}
	return string(encoded), nil
}

// RunCompletionJSON executes a short dynamic completion command on the SSH
// connection's lazy auxiliary channel.
func (s *Shell) RunCompletionJSON(command string) (string, error) {
	if s.conn == nil {
		return "", errors.New("dynamic completion is unavailable for direct SSM")
	}
	stdout, truncated, err := s.conn.RunCompletion(command)
	if err != nil && stdout == "" {
		return "", err
	}
	encoded, encodeErr := json.Marshal(map[string]any{
		"stdout":    stdout,
		"truncated": truncated,
	})
	if encodeErr != nil {
		return "", fmt.Errorf("encode completion result: %w", encodeErr)
	}
	return string(encoded), nil
}

// ReinjectShellIntegration restores OSC hooks after entering a nested shell.
func (s *Shell) ReinjectShellIntegration(shellHint string) error {
	if s.ssm != nil {
		return s.ssm.manager.ReinjectShellIntegration(s.ssm.sessionID, shellHint)
	}
	if s.shell == nil {
		return errors.New("shell is closed")
	}
	s.shell.ReinjectShellIntegration(shellHint)
	return nil
}

// Resize reports new terminal geometry to the remote side.
func (s *Shell) Resize(rows, cols int) error {
	if s.ssm != nil {
		return s.ssm.resize(rows, cols)
	}
	return s.shell.Resize(clampUint32(rows), clampUint32(cols))
}

// CurrentSeq is the sequence number the next chunk of output will carry.
func (s *Shell) CurrentSeq() int64 { return s.fan.currentSeq() }

// StatsJSON reports ring occupancy, for diagnostics.
func (s *Shell) StatsJSON() (string, error) {
	stats := s.fan.ring.Stats()
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
	return s.fan.readBuffer(cursorMode, seq, tailBytes, timeMs, maxBytes)
}

// AddListener replays from a cursor and then follows live output, merging
// chunks within coalesceMs (non-positive takes the default). The returned id is
// passed to RemoveListener.
func (s *Shell) AddListener(listener Listener, cursorMode int, seq int64, tailBytes int64, timeMs float64, coalesceMs int) int64 {
	return s.fan.addListener(listener, cursorMode, seq, tailBytes, timeMs, coalesceMs)
}

// RemoveListener stops a listener. It returns once no further callback can
// arrive, and is safe to call with an unknown id.
func (s *Shell) RemoveListener(id int64) { s.fan.removeListener(id) }

// Close ends the shell and stops its listeners.
func (s *Shell) Close() error {
	var err error
	if s.ssm != nil {
		err = s.ssm.close()
	} else {
		err = s.shell.Close()
	}
	s.fan.stopFollowers()
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
