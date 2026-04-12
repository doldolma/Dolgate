package serialsession

import (
	"bytes"
	"errors"
	"io"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

type stubTransport struct {
	readChunks [][]byte
	writeLog   bytes.Buffer
	closed     bool
}

type stubControlTransport struct {
	stubTransport
	breakDurations []time.Duration
	dtrValues      []bool
	rtsValues      []bool
}

func (t *stubTransport) Read(buffer []byte) (int, error) {
	if len(t.readChunks) == 0 {
		return 0, io.EOF
	}
	chunk := t.readChunks[0]
	t.readChunks = t.readChunks[1:]
	copy(buffer, chunk)
	return len(chunk), nil
}

func (t *stubTransport) Write(data []byte) (int, error) {
	if t.closed {
		return 0, errors.New("closed")
	}
	return t.writeLog.Write(data)
}

func (t *stubTransport) Resize(cols, rows int) error {
	return nil
}

func (t *stubTransport) Close() error {
	t.closed = true
	return nil
}

func (t *stubControlTransport) SendBreak(duration time.Duration) error {
	t.breakDurations = append(t.breakDurations, duration)
	return nil
}

func (t *stubControlTransport) SetDTR(enabled bool) error {
	t.dtrValues = append(t.dtrValues, enabled)
	return nil
}

func (t *stubControlTransport) SetRTS(enabled bool) error {
	t.rtsValues = append(t.rtsValues, enabled)
	return nil
}

func TestManagerListsSerialPorts(t *testing.T) {
	var events []protocol.Event
	manager := NewManagerWithDeps(
		func(event protocol.Event) { events = append(events, event) },
		func(protocol.StreamFrame, []byte) {},
		nil,
		func(includeBusy bool) ([]protocol.SerialPortSummary, error) {
			return []protocol.SerialPortSummary{
				{Path: "/dev/tty.usbserial-0001", DisplayName: "/dev/tty.usbserial-0001"},
			}, nil
		},
	)

	if err := manager.ListPorts("req-1", protocol.SerialListPortsPayload{}); err != nil {
		t.Fatalf("ListPorts returned error: %v", err)
	}

	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Type != protocol.EventSerialPortsListed {
		t.Fatalf("expected serialPortsListed event, got %s", events[0].Type)
	}
	payload, ok := events[0].Payload.(protocol.SerialPortsListedPayload)
	if !ok {
		t.Fatalf("expected SerialPortsListedPayload, got %T", events[0].Payload)
	}
	if len(payload.Ports) != 1 || payload.Ports[0].Path != "/dev/tty.usbserial-0001" {
		t.Fatalf("unexpected ports payload: %#v", payload.Ports)
	}
}

func TestManagerLocalEchoAndLineEditing(t *testing.T) {
	var events []protocol.Event
	var streamFrames []protocol.StreamFrame
	var streamPayloads [][]byte
	transport := &stubTransport{}
	manager := NewManagerWithDeps(
		func(event protocol.Event) { events = append(events, event) },
		func(frame protocol.StreamFrame, payload []byte) {
			streamFrames = append(streamFrames, frame)
			streamPayloads = append(streamPayloads, append([]byte(nil), payload...))
		},
		func(protocol.SerialConnectPayload) (sessionTransport, error) { return transport, nil },
		nil,
	)

	err := manager.Connect("session-1", "req-1", protocol.SerialConnectPayload{
		Transport:        "raw-tcp",
		Host:             "127.0.0.1",
		Port:             7000,
		LocalEcho:        true,
		LocalLineEditing: true,
	})
	if err != nil {
		t.Fatalf("Connect returned error: %v", err)
	}

	if err := manager.WriteBytes("session-1", []byte("abc")); err != nil {
		t.Fatalf("WriteBytes returned error: %v", err)
	}
	if transport.writeLog.Len() != 0 {
		t.Fatalf("expected line editing to buffer input, got %q", transport.writeLog.String())
	}

	if err := manager.WriteBytes("session-1", []byte{'\b'}); err != nil {
		t.Fatalf("WriteBytes(backspace) returned error: %v", err)
	}
	if err := manager.WriteBytes("session-1", []byte{'\r'}); err != nil {
		t.Fatalf("WriteBytes(newline) returned error: %v", err)
	}

	if got := transport.writeLog.String(); got != "ab\r" {
		t.Fatalf("unexpected transport write log %q", got)
	}

	if len(events) == 0 || events[0].Type != protocol.EventConnected {
		t.Fatalf("expected connected event, got %#v", events)
	}
	if len(streamFrames) < 3 {
		t.Fatalf("expected local echo stream frames, got %d", len(streamFrames))
	}
	if string(streamPayloads[0]) != "a" || string(streamPayloads[1]) != "b" {
		t.Fatalf("unexpected first echoed payloads: %q %q", streamPayloads[0], streamPayloads[1])
	}
}

func TestManagerAppliesTransmitLineEnding(t *testing.T) {
	transport := &stubTransport{}
	manager := NewManagerWithDeps(
		func(protocol.Event) {},
		func(protocol.StreamFrame, []byte) {},
		func(protocol.SerialConnectPayload) (sessionTransport, error) { return transport, nil },
		nil,
	)

	err := manager.Connect("session-1", "req-1", protocol.SerialConnectPayload{
		Transport:          "local",
		DevicePath:         "/dev/ttyUSB0",
		TransmitLineEnding: "crlf",
		LocalEcho:          false,
		LocalLineEditing:   false,
	})
	if err != nil {
		t.Fatalf("Connect returned error: %v", err)
	}

	if err := manager.WriteBytes("session-1", []byte("ping\npong\r")); err != nil {
		t.Fatalf("WriteBytes returned error: %v", err)
	}

	if got := transport.writeLog.String(); got != "ping\r\npong\r\n" {
		t.Fatalf("unexpected line ending conversion %q", got)
	}
}

func TestManagerLocalLineEditingAppliesTransmitLineEnding(t *testing.T) {
	transport := &stubTransport{}
	manager := NewManagerWithDeps(
		func(protocol.Event) {},
		func(protocol.StreamFrame, []byte) {},
		func(protocol.SerialConnectPayload) (sessionTransport, error) { return transport, nil },
		nil,
	)

	err := manager.Connect("session-1", "req-1", protocol.SerialConnectPayload{
		Transport:          "local",
		DevicePath:         "/dev/ttyUSB0",
		TransmitLineEnding: "crlf",
		LocalEcho:          false,
		LocalLineEditing:   true,
	})
	if err != nil {
		t.Fatalf("Connect returned error: %v", err)
	}

	if err := manager.WriteBytes("session-1", []byte("ok\r")); err != nil {
		t.Fatalf("WriteBytes returned error: %v", err)
	}

	if got := transport.writeLog.String(); got != "ok\r\n" {
		t.Fatalf("unexpected local line editing write %q", got)
	}
}

func TestManagerControlSignals(t *testing.T) {
	transport := &stubControlTransport{}
	manager := NewManagerWithDeps(
		func(protocol.Event) {},
		func(protocol.StreamFrame, []byte) {},
		func(protocol.SerialConnectPayload) (sessionTransport, error) { return transport, nil },
		nil,
	)

	err := manager.Connect("session-1", "req-1", protocol.SerialConnectPayload{
		Transport:  "local",
		DevicePath: "/dev/ttyUSB0",
	})
	if err != nil {
		t.Fatalf("Connect returned error: %v", err)
	}

	if err := manager.Control("session-1", "break", nil); err != nil {
		t.Fatalf("Control(break) returned error: %v", err)
	}
	if err := manager.Control("session-1", "set-dtr", boolPtr(true)); err != nil {
		t.Fatalf("Control(set-dtr) returned error: %v", err)
	}
	if err := manager.Control("session-1", "set-rts", boolPtr(false)); err != nil {
		t.Fatalf("Control(set-rts) returned error: %v", err)
	}

	if len(transport.breakDurations) != 1 || transport.breakDurations[0] != 250*time.Millisecond {
		t.Fatalf("unexpected break durations %#v", transport.breakDurations)
	}
	if len(transport.dtrValues) != 1 || !transport.dtrValues[0] {
		t.Fatalf("unexpected dtr values %#v", transport.dtrValues)
	}
	if len(transport.rtsValues) != 1 || transport.rtsValues[0] {
		t.Fatalf("unexpected rts values %#v", transport.rtsValues)
	}
}

func TestManagerControlUnsupportedForRawTCP(t *testing.T) {
	transport := &stubTransport{}
	manager := NewManagerWithDeps(
		func(protocol.Event) {},
		func(protocol.StreamFrame, []byte) {},
		func(protocol.SerialConnectPayload) (sessionTransport, error) { return transport, nil },
		nil,
	)

	err := manager.Connect("session-1", "req-1", protocol.SerialConnectPayload{
		Transport: "raw-tcp",
		Host:      "127.0.0.1",
		Port:      7000,
	})
	if err != nil {
		t.Fatalf("Connect returned error: %v", err)
	}

	if err := manager.Control("session-1", "set-rts", boolPtr(true)); err == nil {
		t.Fatalf("expected unsupported control error")
	}
}

func boolPtr(value bool) *bool {
	return &value
}
