package localsession

import (
	"bytes"
	"io"
	"slices"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/flowcontrol"
	"dolssh/services/ssh-core/internal/protocol"
)

// bufferedExitRunner 는 출력을 받아 둔 채 프로그램이 끝나는 PTY 를 흉내 낸다. 받아 둔 것을 다 읽은 뒤에는
// 닫힐 때까지 읽기가 막힌다 — Windows ConPTY 처럼 끝(EOF)이 오지 않는다.
type bufferedExitRunner struct {
	mu        sync.Mutex
	data      []byte
	offset    int
	exited    chan struct{}
	exitOnce  sync.Once
	closed    chan struct{}
	closeOnce sync.Once
}

func newBufferedExitRunner(size int) *bufferedExitRunner {
	return &bufferedExitRunner{
		data:   bytes.Repeat([]byte("x"), size),
		exited: make(chan struct{}),
		closed: make(chan struct{}),
	}
}

func (r *bufferedExitRunner) Read(p []byte) (int, error) {
	r.mu.Lock()
	if r.offset < len(r.data) {
		n := copy(p, r.data[r.offset:])
		r.offset += n
		r.mu.Unlock()
		return n, nil
	}
	r.mu.Unlock()
	<-r.closed
	return 0, io.EOF
}

func (r *bufferedExitRunner) exit() { r.exitOnce.Do(func() { close(r.exited) }) }

func (r *bufferedExitRunner) Write([]byte) error         { return nil }
func (r *bufferedExitRunner) Resize(int, int) error      { return nil }
func (r *bufferedExitRunner) Kill() error                { r.exit(); return nil }
func (r *bufferedExitRunner) Streams() []io.Reader       { return []io.Reader{readerFunc(r.Read)} }
func (r *bufferedExitRunner) ShellKind() string          { return "" }
func (r *bufferedExitRunner) Wait() (sessionExit, error) { <-r.exited; return sessionExit{}, nil }
func (r *bufferedExitRunner) Close() error {
	r.closeOnce.Do(func() { close(r.closed) })
	return nil
}

type readerFunc func([]byte) (int, error)

func (f readerFunc) Read(p []byte) (int, error) { return f(p) }

// 프로그램이 끝날 때, 화면이 못 따라가 멈춰 둔 출력(PTY 가 받아 둔 것)이 closed 보다 먼저 나가야 한다.
// 녹화·공유·탭은 closed 에서 닫히므로 그 뒤에 나간 출력은 버려진다. 끝(EOF)이 오지 않는 PTY 에서도
// 탭은 닫혀야 한다.
func TestLocalSessionEmitsBufferedOutputBeforeClosed(t *testing.T) {
	const high = 16 << 10
	const total = high * 4
	runner := newBufferedExitRunner(total)
	t.Cleanup(func() { _ = runner.Close() })

	flow := flowcontrol.NewWithLimits(high, 4<<10, time.Minute)
	var mu sync.Mutex
	received := 0
	receivedAtClose := -1
	closed := make(chan struct{})
	manager := NewManagerWithRunnerFactory(func(event protocol.Event) {
		if event.Type != protocol.EventClosed {
			return
		}
		mu.Lock()
		if receivedAtClose < 0 {
			receivedAtClose = received
			close(closed)
		}
		mu.Unlock()
	}, func(frame protocol.StreamFrame, data []byte) {
		flow.Sent(frame.SessionID, len(data))
		mu.Lock()
		received += len(data)
		mu.Unlock()
	}, func(protocol.LocalConnectPayload) (sessionRunner, error) { return runner, nil })
	manager.SetFlowControl(flow)

	flow.Start("s1")
	if err := manager.Connect("s1", "r1", protocol.LocalConnectPayload{Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	// 화면이 못 따라가 읽기가 멈춘 뒤에 프로그램이 끝난다.
	if !waitFor(t, 2*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return received >= high
	}) {
		t.Fatal("읽기가 시작되지 않았다")
	}
	time.Sleep(50 * time.Millisecond)
	runner.exit()

	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("프로그램이 끝났는데 closed 가 오지 않았다 — 탭이 남는다")
	}
	// closed 뒤에 출력이 더 오는지 본다.
	time.Sleep(200 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if receivedAtClose != total || received != total {
		t.Fatalf("closed 때까지 받은 양 %d, 끝까지 받은 양 %d — 둘 다 %d 여야 한다", receivedAtClose, received, total)
	}
}

// conhostTeardown 은 의사 콘솔을 닫을 때 conhost 가 내보내는 모드 해제 시퀀스다(Windows 실측).
const conhostTeardown = "\x1b[?9001l\x1b[?1004l"

// consoleBoundRunner 는 Windows ConPTY 처럼 콘솔을 닫아야(ReleaseConsole) 출력에 끝(EOF)이 오는 러너다.
// 닫을 때 conhost 처럼 conhostTeardown 을 한 번 내보낸다.
type consoleBoundRunner struct {
	exited       chan struct{}
	exitOnce     sync.Once
	released     chan struct{}
	releaseOnce  sync.Once
	closed       chan struct{}
	closeOnce    sync.Once
	mu           sync.Mutex
	calls        []string
	teardownSent bool
}

func newConsoleBoundRunner() *consoleBoundRunner {
	return &consoleBoundRunner{
		exited:   make(chan struct{}),
		released: make(chan struct{}),
		closed:   make(chan struct{}),
	}
}

func (r *consoleBoundRunner) note(call string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, call)
}

func (r *consoleBoundRunner) ReleaseConsole() {
	r.releaseOnce.Do(func() {
		r.note("release")
		close(r.released)
	})
}

func (r *consoleBoundRunner) exit() { r.exitOnce.Do(func() { close(r.exited) }) }

func (r *consoleBoundRunner) Read(p []byte) (int, error) {
	<-r.released
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.teardownSent {
		r.teardownSent = true
		return copy(p, conhostTeardown), nil
	}
	return 0, io.EOF
}

func (r *consoleBoundRunner) Write([]byte) error         { return nil }
func (r *consoleBoundRunner) Resize(int, int) error      { return nil }
func (r *consoleBoundRunner) Kill() error                { r.exit(); return nil }
func (r *consoleBoundRunner) Streams() []io.Reader       { return []io.Reader{readerFunc(r.Read)} }
func (r *consoleBoundRunner) ShellKind() string          { return "" }
func (r *consoleBoundRunner) Wait() (sessionExit, error) { <-r.exited; return sessionExit{}, nil }
func (r *consoleBoundRunner) Close() error {
	r.closeOnce.Do(func() {
		r.note("close")
		r.ReleaseConsole()
		close(r.closed)
	})
	return nil
}

// 세션이 끝나면 콘솔을 먼저 닫아야 읽기 루프가 끝나고 핸들이 닫힌다. 읽기 루프부터 기다리면 끝(EOF)이
// 오지 않아 정리가 영영 멈춘다 — Windows 에서 닫은 탭마다 conhost 가 코어가 끝날 때까지 남았다(실측).
// 콘솔을 닫으며 나온 출력은 closed 뒤라 흘리지 않는다.
func TestLocalSessionReleasesConsoleBeforeWaitingForStreams(t *testing.T) {
	runner := newConsoleBoundRunner()
	t.Cleanup(func() { _ = runner.Close() })

	closed := make(chan struct{})
	var closedOnce sync.Once
	var streamMu sync.Mutex
	afterClosed := 0
	manager := NewManagerWithRunnerFactory(func(event protocol.Event) {
		if event.Type == protocol.EventClosed {
			closedOnce.Do(func() { close(closed) })
		}
	}, func(_ protocol.StreamFrame, data []byte) {
		select {
		case <-closed:
			streamMu.Lock()
			afterClosed += len(data)
			streamMu.Unlock()
		default:
		}
	}, func(protocol.LocalConnectPayload) (sessionRunner, error) { return runner, nil })

	if err := manager.Connect("s1", "r1", protocol.LocalConnectPayload{Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	runner.exit()

	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("프로그램이 끝났는데 closed 가 오지 않았다")
	}
	select {
	case <-runner.closed:
	case <-time.After(3 * time.Second):
		t.Fatal("세션이 닫혔는데 러너가 닫히지 않았다 — 콘솔을 먼저 닫지 않아 읽기 루프가 끝나지 않는다")
	}
	runner.mu.Lock()
	calls := slices.Clone(runner.calls)
	runner.mu.Unlock()
	if !slices.Equal(calls, []string{"release", "close"}) {
		t.Fatalf("정리 순서 = %v — 콘솔을 먼저 닫고(release) 핸들은 그다음에 닫아야(close) 한다", calls)
	}
	streamMu.Lock()
	defer streamMu.Unlock()
	if afterClosed != 0 {
		t.Fatalf("closed 뒤에 출력 %d 바이트를 흘렸다 — 받는 쪽은 이미 닫았다", afterClosed)
	}
}
