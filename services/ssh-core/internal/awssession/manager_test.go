package awssession

import (
	"bytes"
	"io"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

type stubRunner struct {
	outputReader   *io.PipeReader
	outputWriter   *io.PipeWriter
	writes         [][]byte
	controlSignals []string
	resizes        [][2]int
	killed         bool
	waitResult     sessionExit
	waitErr        error
	waitCh         chan struct{}
}

func newStubRunner() *stubRunner {
	outputReader, outputWriter := io.Pipe()
	return &stubRunner{
		outputReader: outputReader,
		outputWriter: outputWriter,
		waitCh:       make(chan struct{}),
	}
}

func (r *stubRunner) Write(data []byte) error {
	chunk := make([]byte, len(data))
	copy(chunk, data)
	r.writes = append(r.writes, chunk)
	return nil
}

func (r *stubRunner) SendControlSignal(signal string) error {
	normalized, err := normalizeControlSignal(signal)
	if err != nil {
		return err
	}
	r.controlSignals = append(r.controlSignals, normalized)
	return nil
}

func (r *stubRunner) Resize(cols, rows int) error {
	r.resizes = append(r.resizes, [2]int{cols, rows})
	return nil
}

func (r *stubRunner) Kill() error {
	r.killed = true
	r.finish(sessionExit{ExitCode: 0}, nil)
	return nil
}

func (r *stubRunner) Close() error {
	_ = r.outputReader.Close()
	_ = r.outputWriter.Close()
	return nil
}

func (r *stubRunner) Streams() []io.Reader {
	return []io.Reader{r.outputReader}
}

func (r *stubRunner) Wait() (sessionExit, error) {
	<-r.waitCh
	return r.waitResult, r.waitErr
}

func (r *stubRunner) emitOutput(chunk string) {
	_, _ = r.outputWriter.Write([]byte(chunk))
}

func (r *stubRunner) finish(result sessionExit, err error) {
	select {
	case <-r.waitCh:
		return
	default:
		r.waitResult = result
		r.waitErr = err
		close(r.waitCh)
		_ = r.outputWriter.Close()
	}
}

func waitForEvent(t *testing.T, events <-chan protocol.Event, expected protocol.EventType) protocol.Event {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case event := <-events:
			if event.Type == expected {
				return event
			}
		case <-deadline:
			t.Fatalf("timed out waiting for event %s", expected)
		}
	}
}

func waitForStream(t *testing.T, streams <-chan []byte) []byte {
	t.Helper()
	select {
	case chunk := <-streams:
		return chunk
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for stream chunk")
		return nil
	}
}

func TestManagerFakeSessionFlow(t *testing.T) {
	t.Setenv("DOLSSH_E2E_FAKE_AWS_SESSION", "1")

	events := make(chan protocol.Event, 16)
	streams := make(chan []byte, 16)
	manager := NewManager(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, payload []byte) {
		streams <- payload
	})

	if err := manager.Connect("session-1", "req-1", protocol.AWSConnectPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		InstanceID:  "i-1234",
	}); err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	waitForEvent(t, events, protocol.EventConnected)
	if !manager.HasSession("session-1") {
		t.Fatal("session should exist")
	}

	if err := manager.WriteBytes("session-1", []byte("ping\r\n")); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	firstChunk := waitForStream(t, streams)
	secondChunk := waitForStream(t, streams)
	combined := append(firstChunk, secondChunk...)
	if !bytes.Contains(combined, []byte("Connected to fake AWS SSM smoke session.")) {
		t.Fatalf("missing fake session banner: %q", combined)
	}
	if !bytes.Contains(combined, []byte("ping")) {
		t.Fatalf("missing echoed write: %q", combined)
	}

	if err := manager.Resize("session-1", 180, 48); err != nil {
		t.Fatalf("resize failed: %v", err)
	}

	if err := manager.Disconnect("session-1"); err != nil {
		t.Fatalf("disconnect failed: %v", err)
	}

	closed := waitForEvent(t, events, protocol.EventClosed)
	payload, ok := closed.Payload.(protocol.ClosedPayload)
	if !ok {
		t.Fatalf("closed payload type = %T", closed.Payload)
	}
	if payload.Message != "client requested disconnect" {
		t.Fatalf("closed message = %q, want %q", payload.Message, "client requested disconnect")
	}
}

func TestManagerRoutesWriteResizeAndOutputThroughRunner(t *testing.T) {
	events := make(chan protocol.Event, 16)
	streams := make(chan []byte, 16)
	runner := newStubRunner()
	manager := NewManagerWithRunnerFactory(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, payload []byte) {
		streams <- payload
	}, func(protocol.AWSConnectPayload) (sessionRunner, error) {
		return runner, nil
	})

	if err := manager.Connect("session-2", "req-2", protocol.AWSConnectPayload{
		ProfileName: "default",
		Region:      "us-east-1",
		InstanceID:  "i-5678",
		Cols:        120,
		Rows:        32,
	}); err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	waitForEvent(t, events, protocol.EventConnected)

	if err := manager.WriteBytes("session-2", []byte("ls -al\r")); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	if err := manager.SendControlSignal("session-2", "interrupt"); err != nil {
		t.Fatalf("control signal failed: %v", err)
	}
	if err := manager.Resize("session-2", 200, 60); err != nil {
		t.Fatalf("resize failed: %v", err)
	}

	runner.emitOutput("hello\r\n")
	if got := waitForStream(t, streams); !bytes.Equal(got, []byte("hello\r\n")) {
		t.Fatalf("stream payload = %q", got)
	}

	if len(runner.writes) != 1 || !bytes.Equal(runner.writes[0], []byte("ls -al\r")) {
		t.Fatalf("writes = %#v", runner.writes)
	}
	if len(runner.controlSignals) != 1 || runner.controlSignals[0] != "interrupt" {
		t.Fatalf("controlSignals = %#v", runner.controlSignals)
	}
	if len(runner.resizes) != 1 || runner.resizes[0] != [2]int{200, 60} {
		t.Fatalf("resizes = %#v", runner.resizes)
	}

	if err := manager.Disconnect("session-2"); err != nil {
		t.Fatalf("disconnect failed: %v", err)
	}

	if !runner.killed {
		t.Fatal("runner should be killed on disconnect")
	}
	closed := waitForEvent(t, events, protocol.EventClosed)
	payload := closed.Payload.(protocol.ClosedPayload)
	if payload.Message != "client requested disconnect" {
		t.Fatalf("closed message = %q", payload.Message)
	}
}

func TestManagerEmitsErrorBeforeClosedOnAbnormalExit(t *testing.T) {
	events := make(chan protocol.Event, 16)
	runner := newStubRunner()
	manager := NewManagerWithRunnerFactory(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, _ []byte) {}, func(protocol.AWSConnectPayload) (sessionRunner, error) {
		return runner, nil
	})

	if err := manager.Connect("session-3", "req-3", protocol.AWSConnectPayload{
		ProfileName: "default",
		Region:      "us-west-2",
		InstanceID:  "i-abcd",
	}); err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	waitForEvent(t, events, protocol.EventConnected)
	runner.finish(sessionExit{ExitCode: 1}, nil)

	errorEvent := waitForEvent(t, events, protocol.EventError)
	errorPayload := errorEvent.Payload.(protocol.ErrorPayload)
	if errorPayload.Message != "AWS SSM session exited with code 1" {
		t.Fatalf("error message = %q", errorPayload.Message)
	}

	closedEvent := waitForEvent(t, events, protocol.EventClosed)
	closedPayload := closedEvent.Payload.(protocol.ClosedPayload)
	if closedPayload.Message != "AWS SSM session exited with code 1" {
		t.Fatalf("closed message = %q", closedPayload.Message)
	}
	if manager.HasSession("session-3") {
		t.Fatal("session should be removed after abnormal exit")
	}
}
