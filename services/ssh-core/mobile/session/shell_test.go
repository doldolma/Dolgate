package session

import (
	"bytes"
	"encoding/base64"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/mobile/internal/sshtest"
	"dolssh/services/ssh-core/mobile/ringbuf"
)

func newTestServer(t *testing.T) *sshtest.Server {
	t.Helper()
	server, err := sshtest.NewServer()
	if err != nil {
		t.Fatalf("start fixture: %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server
}

func dialTestConn(t *testing.T, server *sshtest.Server) *Conn {
	t.Helper()
	conn, err := Dial(DialOptions{ID: "conn-1", Target: server.Target(), Config: sshconn.DefaultConfig})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// waitForRing blocks until the ring holds want bytes of output, or fails.
func waitForRing(t *testing.T, shell *Shell, want string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var got []byte
		for _, chunk := range shell.Ring().Read(ringbuf.HeadCursor(), 0).Chunks {
			got = append(got, chunk.Bytes...)
		}
		if bytes.Contains(got, []byte(want)) {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	var got []byte
	for _, chunk := range shell.Ring().Read(ringbuf.HeadCursor(), 0).Chunks {
		got = append(got, chunk.Bytes...)
	}
	t.Fatalf("timed out waiting for %q in ring; have %q", want, got)
}

func TestShellEchoRoundTripThroughRing(t *testing.T) {
	server := newTestServer(t)
	conn := dialTestConn(t, server)

	shell, err := conn.StartShell(ShellOptions{Term: TerminalXterm256})
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	if err := shell.SendData([]byte("hello world\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitForRing(t, shell, "hello world\n")
}

func TestShellRequestsMobilePtyDefaults(t *testing.T) {
	server := newTestServer(t)
	conn := dialTestConn(t, server)

	shell, err := conn.StartShell(ShellOptions{Term: TerminalXterm256})
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()
	waitForRing(t, shell, "")

	reqs := server.PtyRequests()
	if len(reqs) != 1 {
		t.Fatalf("expected 1 pty-req, got %d", len(reqs))
	}
	pty := reqs[0]
	if pty.Term != "xterm-256color" {
		t.Errorf("TERM = %q, want xterm-256color", pty.Term)
	}
	if pty.Rows != DefaultRows || pty.Cols != DefaultCols {
		t.Errorf("geometry = %dx%d, want %dx%d", pty.Rows, pty.Cols, DefaultRows, DefaultCols)
	}

	modes := pty.DecodeModes()
	for _, want := range DefaultTerminalModes() {
		got, ok := modes[want.Opcode]
		if !ok {
			t.Errorf("pty-req is missing mode opcode %d", want.Opcode)
			continue
		}
		if got != want.Value {
			t.Errorf("mode %d = %d, want %d", want.Opcode, got, want.Value)
		}
	}
}

func TestShellHonoursExplicitGeometryAndModes(t *testing.T) {
	server := newTestServer(t)
	conn := dialTestConn(t, server)

	shell, err := conn.StartShell(ShellOptions{
		Term:        TerminalVT220,
		Rows:        40,
		Cols:        132,
		PixelWidth:  1320,
		PixelHeight: 800,
		Modes:       []TerminalMode{{Opcode: ssh.ECHO, Value: 0}},
	})
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()
	waitForRing(t, shell, "")

	reqs := server.PtyRequests()
	if len(reqs) != 1 {
		t.Fatalf("expected 1 pty-req, got %d", len(reqs))
	}
	pty := reqs[0]
	if pty.Term != "vt220" {
		t.Errorf("TERM = %q, want vt220", pty.Term)
	}
	if pty.Rows != 40 || pty.Cols != 132 {
		t.Errorf("geometry = %dx%d, want 40x132", pty.Rows, pty.Cols)
	}

	modes := pty.DecodeModes()
	if got, ok := modes[ssh.ECHO]; !ok || got != 0 {
		t.Errorf("explicit modes were not used: ECHO = %d (present=%v)", got, ok)
	}
	if _, ok := modes[ssh.ICANON]; ok {
		t.Error("explicit modes should replace the defaults, not merge with them")
	}
}

func TestShellResizeSendsWindowChange(t *testing.T) {
	server := newTestServer(t)
	conn := dialTestConn(t, server)

	shell, err := conn.StartShell(ShellOptions{Term: TerminalXterm256})
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	if err := shell.Resize(50, 200); err != nil {
		t.Fatalf("resize: %v", err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if reqs := server.WindowChanges(); len(reqs) > 0 {
			if reqs[0].Rows != 50 || reqs[0].Cols != 200 {
				t.Errorf("window-change = %dx%d, want 50x200", reqs[0].Rows, reqs[0].Cols)
			}
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("server never received a window-change")
}

func TestShellSeparatesStdoutAndStderr(t *testing.T) {
	server := newTestServer(t)
	conn := dialTestConn(t, server)

	shell, err := conn.StartShell(ShellOptions{Term: TerminalXterm256})
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	if err := shell.SendData([]byte("visible\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitForRing(t, shell, "visible\n")

	if err := shell.SendData([]byte(sshtest.StderrTrigger)); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitForRing(t, shell, "on-stderr")

	var sawStdout, sawStderr bool
	for _, chunk := range shell.Ring().Read(ringbuf.HeadCursor(), 0).Chunks {
		switch chunk.Stream {
		case ringbuf.StreamStdout:
			if bytes.Contains(chunk.Bytes, []byte("visible")) {
				sawStdout = true
			}
		case ringbuf.StreamStderr:
			if bytes.Contains(chunk.Bytes, []byte("on-stderr")) {
				sawStderr = true
			}
		}
	}
	if !sawStdout {
		t.Error("stdout output was not tagged as stdout")
	}
	if !sawStderr {
		t.Error("stderr output was not tagged as stderr")
	}
}

func TestShellFollowDeliversLiveOutput(t *testing.T) {
	server := newTestServer(t)
	conn := dialTestConn(t, server)

	shell, err := conn.StartShell(ShellOptions{Term: TerminalXterm256})
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	// The handover the app performs: replay first, then follow from the cursor
	// the replay handed back.
	replay := shell.Ring().Read(ringbuf.HeadCursor(), 0)

	var (
		mu    sync.Mutex
		lines []byte
	)
	follower := ringbuf.Follow(shell.Ring(), ringbuf.SeqCursor(replay.NextSeq), 5*time.Millisecond,
		listenerFunc(func(chunk ringbuf.Chunk) {
			mu.Lock()
			lines = append(lines, chunk.Bytes...)
			mu.Unlock()
		}))
	defer follower.Stop()

	if err := shell.SendData([]byte("followed\n")); err != nil {
		t.Fatalf("send: %v", err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		got := append([]byte(nil), lines...)
		mu.Unlock()
		if bytes.Contains(got, []byte("followed\n")) {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("follower never received the echoed line")
}

func TestShellCloseFiresOnClosedOnce(t *testing.T) {
	server := newTestServer(t)
	conn := dialTestConn(t, server)

	closedCh := make(chan uint32, 4)
	shell, err := conn.StartShell(ShellOptions{
		Term: TerminalXterm256,
		OnClosed: func(channelID uint32) {
			closedCh <- channelID
		},
	})
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}

	if err := shell.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	// Idempotent.
	if err := shell.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}

	select {
	case id := <-closedCh:
		if id != shell.Info().ChannelID {
			t.Errorf("OnClosed got channel %d, want %d", id, shell.Info().ChannelID)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("OnClosed never fired")
	}

	select {
	case <-shell.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("Done was never closed")
	}

	// A second callback would mean the lifecycle ran twice.
	select {
	case <-closedCh:
		t.Error("OnClosed fired more than once")
	case <-time.After(100 * time.Millisecond):
	}

	// Writing to a dead shell reports closure rather than hanging or panicking.
	if err := shell.SendData([]byte("x\n")); err == nil {
		t.Error("expected an error writing to a closed shell")
	}

	// The connection must no longer track it.
	if _, ok := conn.Shell(shell.Info().ChannelID); ok {
		t.Error("closed shell is still registered on the connection")
	}
}

func TestShellEndsWhenRemoteClosesChannel(t *testing.T) {
	server := newTestServer(t)
	conn := dialTestConn(t, server)

	shell, err := conn.StartShell(ShellOptions{Term: TerminalXterm256})
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	// Trailing output must still be stored when the channel ends, so the app can
	// show why the session finished.
	if err := shell.SendData([]byte("last words\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitForRing(t, shell, "last words\n")

	_ = conn.Close()

	select {
	case <-shell.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("shell did not finish after the connection closed")
	}

	var got []byte
	for _, chunk := range shell.Ring().Read(ringbuf.HeadCursor(), 0).Chunks {
		got = append(got, chunk.Bytes...)
	}
	if !bytes.Contains(got, []byte("last words\n")) {
		t.Errorf("output before the close was lost; ring holds %q", got)
	}
}

func TestConnCloseEndsShellsAndIsIdempotent(t *testing.T) {
	server := newTestServer(t)
	conn, err := Dial(DialOptions{ID: "conn-1", Target: server.Target(), Config: sshconn.DefaultConfig})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	first, err := conn.StartShell(ShellOptions{Term: TerminalXterm256})
	if err != nil {
		t.Fatalf("start first shell: %v", err)
	}
	second, err := conn.StartShell(ShellOptions{Term: TerminalXterm256})
	if err != nil {
		t.Fatalf("start second shell: %v", err)
	}
	if first.Info().ChannelID == second.Info().ChannelID {
		t.Error("shells on one connection must have distinct handles")
	}

	if err := conn.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := conn.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}

	for i, shell := range []*Shell{first, second} {
		select {
		case <-shell.Done():
		case <-time.After(10 * time.Second):
			t.Fatalf("shell %d did not finish after the connection closed", i)
		}
	}

	if _, err := conn.StartShell(ShellOptions{}); err != ErrConnClosed {
		t.Errorf("StartShell after close returned %v, want ErrConnClosed", err)
	}
}

func TestDialRejectsUntrustedHostKey(t *testing.T) {
	server := newTestServer(t)
	target := server.Target()
	// A different key than the server presents; strict checking comes from
	// internal/sshconn, and the engine must not weaken it.
	target.TrustedHostKeyBase64 = base64.StdEncoding.EncodeToString([]byte("not-the-host-key"))

	conn, err := Dial(DialOptions{ID: "conn-1", Target: target, Config: sshconn.DefaultConfig})
	if err == nil {
		_ = conn.Close()
		t.Fatal("expected the dial to fail on a host key mismatch")
	}
}

func TestDialReportsHopProgress(t *testing.T) {
	server := newTestServer(t)

	var (
		mu     sync.Mutex
		stages []sshconn.ProgressStage
	)
	config := sshconn.DefaultConfig
	config.Progress = func(event sshconn.ProgressEvent) {
		mu.Lock()
		stages = append(stages, event.Stage)
		mu.Unlock()
	}

	conn, err := Dial(DialOptions{ID: "conn-1", Target: server.Target(), Config: config})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	mu.Lock()
	defer mu.Unlock()
	if len(stages) == 0 {
		t.Fatal("no hop progress was reported")
	}
	if stages[len(stages)-1] != sshconn.ProgressConnected {
		t.Errorf("last stage = %q, want %q", stages[len(stages)-1], sshconn.ProgressConnected)
	}
}

func TestConnInfoCarriesServerVersion(t *testing.T) {
	server := newTestServer(t)
	conn := dialTestConn(t, server)

	info := conn.Info()
	if info.ID != "conn-1" {
		t.Errorf("ID = %q, want conn-1", info.ID)
	}
	if info.Host != "127.0.0.1" || info.Port != server.Port() {
		t.Errorf("endpoint = %s:%d, want 127.0.0.1:%d", info.Host, info.Port, server.Port())
	}
	if info.Username != sshtest.User {
		t.Errorf("Username = %q, want %q", info.Username, sshtest.User)
	}
	if info.ServerVersion == "" {
		t.Error("ServerVersion is empty")
	}
	if info.ConnectedAtMs <= 0 {
		t.Error("ConnectedAtMs was not set")
	}
}

// listenerFunc adapts a plain function to ringbuf.Listener, ignoring drops.
type listenerFunc func(ringbuf.Chunk)

func (f listenerFunc) OnChunk(chunk ringbuf.Chunk) { f(chunk) }
func (f listenerFunc) OnDropped(uint64, uint64)    {}
