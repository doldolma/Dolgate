package mobile

import (
	"bytes"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/mobile/internal/sshtest"
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

// connectJSON builds the request the app will send: the desktop connect payload
// plus an id.
func connectJSON(t *testing.T, server *sshtest.Server, rows, cols int) string {
	t.Helper()
	payload := server.ConnectPayload()
	payload.Rows = rows
	payload.Cols = cols

	// Marshal the payload, then splice in the id, so the test exercises the same
	// flat shape the app produces rather than a nested one.
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	fields["id"] = "conn-1"

	out, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	return string(out)
}

func connectTest(t *testing.T, server *sshtest.Server, rows, cols int) *Conn {
	t.Helper()
	conn, err := NewEngine().Connect(connectJSON(t, server, rows, cols), nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// recordingListener implements the bound Listener interface the host would.
type recordingListener struct {
	mu      sync.Mutex
	data    []byte
	calls   int
	dropped [][2]int64
}

func (l *recordingListener) OnChunk(seq int64, tMs float64, stream int, data []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.data = append(l.data, data...)
	l.calls++
}

func (l *recordingListener) OnDropped(fromSeq, toSeq int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.dropped = append(l.dropped, [2]int64{fromSeq, toSeq})
}

func (l *recordingListener) snapshot() ([]byte, int, [][2]int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]byte(nil), l.data...), l.calls, append([][2]int64(nil), l.dropped...)
}

func (l *recordingListener) waitFor(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		got, _, _ := l.snapshot()
		if bytes.Contains(got, []byte(want)) {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	got, _, _ := l.snapshot()
	t.Fatalf("timed out waiting for %q; listener has %q", want, got)
}

// waitForRead polls ReadBuffer until the output shows up.
func waitForRead(t *testing.T, shell *Shell, want string) *ReadResult {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		result := shell.ReadBuffer(CursorHead, 0, 0, 0, 0)
		if bytes.Contains(result.Data(), []byte(want)) {
			return result
		}
		time.Sleep(2 * time.Millisecond)
	}
	result := shell.ReadBuffer(CursorHead, 0, 0, 0, 0)
	t.Fatalf("timed out waiting for %q; buffer holds %q", want, result.Data())
	return nil
}

func TestConnectAndShellRoundTrip(t *testing.T) {
	server := newTestServer(t)
	conn := connectTest(t, server, 30, 100)

	shell, err := conn.StartShell(`{"term":"xterm-256color"}`, nil)
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	if err := shell.SendData([]byte("through-bind\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitForRead(t, shell, "through-bind\n")
}

func TestConnectInfoAndShellInfoJSON(t *testing.T) {
	server := newTestServer(t)
	conn := connectTest(t, server, 30, 100)

	infoJSON, err := conn.InfoJSON()
	if err != nil {
		t.Fatalf("connection info: %v", err)
	}
	var info struct {
		ID            string  `json:"id"`
		Host          string  `json:"host"`
		Port          int     `json:"port"`
		Username      string  `json:"username"`
		ServerVersion string  `json:"serverVersion"`
		ConnectedAtMs float64 `json:"connectedAtMs"`
	}
	if err := json.Unmarshal([]byte(infoJSON), &info); err != nil {
		t.Fatalf("decode connection info: %v", err)
	}
	if info.ID != "conn-1" || info.Host != "127.0.0.1" || info.Port != server.Port() {
		t.Errorf("connection info = %+v", info)
	}
	if info.Username != sshtest.User {
		t.Errorf("username = %q, want %q", info.Username, sshtest.User)
	}
	if info.ServerVersion == "" || info.ConnectedAtMs <= 0 {
		t.Errorf("connection info is incomplete: %+v", info)
	}

	shell, err := conn.StartShell(`{"term":"vt220"}`, nil)
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	shellJSON, err := shell.InfoJSON()
	if err != nil {
		t.Fatalf("shell info: %v", err)
	}
	var shellInfo struct {
		ChannelID    int64   `json:"channelId"`
		Term         string  `json:"term"`
		ConnectionID string  `json:"connectionId"`
		CreatedAtMs  float64 `json:"createdAtMs"`
	}
	if err := json.Unmarshal([]byte(shellJSON), &shellInfo); err != nil {
		t.Fatalf("decode shell info: %v", err)
	}
	if shellInfo.Term != "vt220" {
		t.Errorf("term = %q, want vt220", shellInfo.Term)
	}
	if shellInfo.ConnectionID != "conn-1" {
		t.Errorf("connectionId = %q, want conn-1", shellInfo.ConnectionID)
	}
	if shellInfo.CreatedAtMs <= 0 {
		t.Error("createdAtMs was not set")
	}
}

// Shell options may omit geometry, in which case the connect payload's rows and
// cols apply — the app sends them there today.
func TestShellGeometryFallsBackToConnectPayload(t *testing.T) {
	server := newTestServer(t)
	conn := connectTest(t, server, 33, 111)

	shell, err := conn.StartShell(`{"term":"xterm-256color"}`, nil)
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()
	waitForRead(t, shell, "")

	reqs := server.PtyRequests()
	if len(reqs) != 1 {
		t.Fatalf("expected 1 pty-req, got %d", len(reqs))
	}
	if reqs[0].Rows != 33 || reqs[0].Cols != 111 {
		t.Errorf("geometry = %dx%d, want 33x111", reqs[0].Rows, reqs[0].Cols)
	}
}

func TestShellOptionsOverrideGeometryAndModes(t *testing.T) {
	server := newTestServer(t)
	conn := connectTest(t, server, 33, 111)

	options := `{"term":"xterm","rows":44,"cols":180,"modes":[{"opcode":53,"value":0}]}`
	shell, err := conn.StartShell(options, nil)
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()
	waitForRead(t, shell, "")

	reqs := server.PtyRequests()
	if len(reqs) != 1 {
		t.Fatalf("expected 1 pty-req, got %d", len(reqs))
	}
	if reqs[0].Term != "xterm" {
		t.Errorf("TERM = %q, want xterm", reqs[0].Term)
	}
	if reqs[0].Rows != 44 || reqs[0].Cols != 180 {
		t.Errorf("geometry = %dx%d, want 44x180", reqs[0].Rows, reqs[0].Cols)
	}
	if got, ok := reqs[0].DecodeModes()[ssh.ECHO]; !ok || got != 0 {
		t.Errorf("explicit mode was not applied: ECHO = %d (present=%v)", got, ok)
	}
}

// The handover the app performs across the bridge: one ReadBuffer for replay,
// then AddListener from the cursor it returned.
func TestReadBufferThenAddListenerHandover(t *testing.T) {
	server := newTestServer(t)
	conn := connectTest(t, server, 30, 100)

	shell, err := conn.StartShell(`{"term":"xterm-256color"}`, nil)
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	if err := shell.SendData([]byte("first\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	replay := waitForRead(t, shell, "first\n")
	if replay.HasDropped() {
		t.Errorf("unexpected drop in replay: %d..%d", replay.DroppedFromSeq(), replay.DroppedToSeq())
	}

	listener := &recordingListener{}
	id := shell.AddListener(listener, CursorSeq, replay.NextSeq(), 0, 0, 5)
	if id == 0 {
		t.Fatal("AddListener returned 0")
	}
	defer shell.RemoveListener(id)

	if err := shell.SendData([]byte("second\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	listener.waitFor(t, "second\n")

	got, _, dropped := listener.snapshot()
	if len(dropped) != 0 {
		t.Errorf("unexpected drops: %v", dropped)
	}
	// The replay is not repeated on the live feed.
	if bytes.Contains(got, []byte("first")) {
		t.Errorf("listener replayed already-read output: %q", got)
	}
}

func TestAddListenerFromHeadReplaysStoredOutput(t *testing.T) {
	server := newTestServer(t)
	conn := connectTest(t, server, 30, 100)

	shell, err := conn.StartShell(`{"term":"xterm-256color"}`, nil)
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	if err := shell.SendData([]byte("stored\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitForRead(t, shell, "stored\n")

	listener := &recordingListener{}
	id := shell.AddListener(listener, CursorHead, 0, 0, 0, 5)
	defer shell.RemoveListener(id)

	listener.waitFor(t, "stored\n")
}

func TestAddListenerRejectsNil(t *testing.T) {
	server := newTestServer(t)
	conn := connectTest(t, server, 30, 100)

	shell, err := conn.StartShell("", nil)
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	if id := shell.AddListener(nil, CursorHead, 0, 0, 0, 5); id != 0 {
		t.Errorf("AddListener(nil) = %d, want 0", id)
	}
}

func TestRemoveListenerStopsCallbacksAndToleratesUnknownID(t *testing.T) {
	server := newTestServer(t)
	conn := connectTest(t, server, 30, 100)

	shell, err := conn.StartShell(`{"term":"xterm-256color"}`, nil)
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	listener := &recordingListener{}
	id := shell.AddListener(listener, CursorLive, 0, 0, 0, 5)

	if err := shell.SendData([]byte("before\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	listener.waitFor(t, "before\n")

	shell.RemoveListener(id)
	before, _, _ := listener.snapshot()

	if err := shell.SendData([]byte("after\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	// Give the removed listener every chance to misbehave.
	time.Sleep(50 * time.Millisecond)
	after, _, _ := listener.snapshot()
	if !bytes.Equal(before, after) {
		t.Errorf("callback arrived after RemoveListener: %q then %q", before, after)
	}

	// Removing twice, or an id that never existed, must not panic.
	shell.RemoveListener(id)
	shell.RemoveListener(9999)
}

func TestReadBufferCursorModes(t *testing.T) {
	server := newTestServer(t)
	conn := connectTest(t, server, 30, 100)

	shell, err := conn.StartShell(`{"term":"xterm-256color","maxChunkBytes":8}`, nil)
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	if err := shell.SendData([]byte("alpha\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	head := waitForRead(t, shell, "alpha\n")

	// Live skips everything stored.
	if live := shell.ReadBuffer(CursorLive, 0, 0, 0, 0); len(live.Data()) != 0 {
		t.Errorf("live cursor returned %q, want empty", live.Data())
	}
	// Resuming at the cursor the head read returned yields nothing new yet.
	if next := shell.ReadBuffer(CursorSeq, head.NextSeq(), 0, 0, 0); len(next.Data()) != 0 {
		t.Errorf("resume cursor returned %q, want empty", next.Data())
	}
	// A generous tail-bytes request covers the whole buffer.
	if tail := shell.ReadBuffer(CursorTailBytes, 0, 4096, 0, 0); !bytes.Contains(tail.Data(), []byte("alpha")) {
		t.Errorf("tail cursor returned %q", tail.Data())
	}
	// An unknown mode falls back to head rather than failing.
	if fallback := shell.ReadBuffer(999, 0, 0, 0, 0); !bytes.Contains(fallback.Data(), []byte("alpha")) {
		t.Errorf("unknown cursor mode returned %q, want the head read", fallback.Data())
	}
}

// A cursor pointing at evicted output must be reported as a drop, so the app can
// tell the terminal its scrollback has a hole rather than silently splicing.
func TestReadBufferReportsEvictedCursor(t *testing.T) {
	server := newTestServer(t)
	conn := connectTest(t, server, 30, 100)

	// A tiny ring so a few lines of echo force eviction.
	shell, err := conn.StartShell(`{"term":"xterm-256color","ringCapacityBytes":16,"maxChunkBytes":8}`, nil)
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	for _, line := range []string{"aaaaaaa\n", "bbbbbbb\n", "ccccccc\n", "ddddddd\n"} {
		if err := shell.SendData([]byte(line)); err != nil {
			t.Fatalf("send: %v", err)
		}
	}
	waitForRead(t, shell, "ddddddd\n")

	result := shell.ReadBuffer(CursorSeq, 0, 0, 0, 0)
	if !result.HasDropped() {
		t.Fatal("expected a drop report for a cursor into evicted output")
	}
	if result.DroppedFromSeq() != 0 || result.DroppedToSeq() < result.DroppedFromSeq() {
		t.Errorf("dropped range = %d..%d", result.DroppedFromSeq(), result.DroppedToSeq())
	}
}

func TestStatsAndCurrentSeqTrackOutput(t *testing.T) {
	server := newTestServer(t)
	conn := connectTest(t, server, 30, 100)

	shell, err := conn.StartShell(`{"term":"xterm-256color"}`, nil)
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}
	defer shell.Close()

	if shell.CurrentSeq() != 0 {
		t.Errorf("CurrentSeq on a fresh shell = %d, want 0", shell.CurrentSeq())
	}

	if err := shell.SendData([]byte("counted\n")); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitForRead(t, shell, "counted\n")

	if shell.CurrentSeq() == 0 {
		t.Error("CurrentSeq did not advance after output")
	}

	statsJSON, err := shell.StatsJSON()
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	var stats struct {
		RingBytesCount int64 `json:"ringBytesCount"`
		UsedBytes      int64 `json:"usedBytes"`
		ChunksCount    int64 `json:"chunksCount"`
		TailSeq        int64 `json:"tailSeq"`
	}
	if err := json.Unmarshal([]byte(statsJSON), &stats); err != nil {
		t.Fatalf("decode stats: %v", err)
	}
	if stats.RingBytesCount <= 0 || stats.UsedBytes <= 0 || stats.ChunksCount <= 0 {
		t.Errorf("stats look empty: %+v", stats)
	}
}

func TestShellClosedCallbackCrossesBridge(t *testing.T) {
	server := newTestServer(t)
	conn := connectTest(t, server, 30, 100)

	closed := make(chan int64, 4)
	shell, err := conn.StartShell(`{"term":"xterm-256color"}`, closedCallbackFunc(func(channelID int64) {
		closed <- channelID
	}))
	if err != nil {
		t.Fatalf("start shell: %v", err)
	}

	if err := shell.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("OnShellClosed never fired")
	}
}

type closedCallbackFunc func(channelID int64)

func (f closedCallbackFunc) OnShellClosed(channelID int64) { f(channelID) }

func TestConnectRejectsMalformedRequest(t *testing.T) {
	if _, err := NewEngine().Connect("{not json", nil); err == nil {
		t.Error("expected an error for malformed JSON")
	}
}

func TestStartShellRejectsMalformedOptionsAndBadOpcode(t *testing.T) {
	server := newTestServer(t)
	conn := connectTest(t, server, 30, 100)

	if _, err := conn.StartShell("{not json", nil); err == nil {
		t.Error("expected an error for malformed shell options")
	}
	if _, err := conn.StartShell(`{"modes":[{"opcode":300,"value":1}]}`, nil); err == nil {
		t.Error("expected an error for an out-of-range terminal mode opcode")
	}
}

func TestConnectRejectsUntrustedHostKey(t *testing.T) {
	server := newTestServer(t)
	payload := server.ConnectPayload()
	payload.TrustedHostKeyBase64 = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode payload: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	fields["id"] = "conn-1"
	request, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}

	conn, err := NewEngine().Connect(string(request), nil)
	if err == nil {
		_ = conn.Close()
		t.Fatal("expected the connect to fail on a host key mismatch")
	}
}

func TestVersionIsReported(t *testing.T) {
	if Version() == "" {
		t.Error("Version must identify the engine build")
	}
}
