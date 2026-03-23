package protocol

import (
	"bytes"
	"testing"
)

func TestControlFrameRoundTrip(t *testing.T) {
	buffer := new(bytes.Buffer)
	expected := Event{
		Type:      EventConnected,
		RequestID: "req-1",
		SessionID: "session-1",
		Payload: StatusPayload{
			Status: "ready",
		},
	}

	if err := WriteControlFrame(buffer, expected); err != nil {
		t.Fatalf("WriteControlFrame() error = %v", err)
	}

	frame, err := ReadFrame(buffer)
	if err != nil {
		t.Fatalf("ReadFrame() error = %v", err)
	}
	if frame.Kind != FrameKindControl {
		t.Fatalf("frame.Kind = %v, want %v", frame.Kind, FrameKindControl)
	}

	var decoded Event
	if err := DecodeControlFrame(frame, &decoded); err != nil {
		t.Fatalf("DecodeControlFrame() error = %v", err)
	}

	if decoded.Type != expected.Type || decoded.RequestID != expected.RequestID || decoded.SessionID != expected.SessionID {
		t.Fatalf("decoded = %+v, want %+v", decoded, expected)
	}
}

func TestStreamFrameRoundTrip(t *testing.T) {
	buffer := new(bytes.Buffer)
	expectedMetadata := StreamFrame{
		Type:      StreamTypeData,
		SessionID: "session-2",
		RequestID: "req-2",
	}
	expectedPayload := []byte("hello\r\n")

	if err := WriteStreamFrame(buffer, expectedMetadata, expectedPayload); err != nil {
		t.Fatalf("WriteStreamFrame() error = %v", err)
	}

	frame, err := ReadFrame(buffer)
	if err != nil {
		t.Fatalf("ReadFrame() error = %v", err)
	}
	if frame.Kind != FrameKindStream {
		t.Fatalf("frame.Kind = %v, want %v", frame.Kind, FrameKindStream)
	}

	var decodedMetadata StreamFrame
	if err := DecodeStreamFrame(frame, &decodedMetadata); err != nil {
		t.Fatalf("DecodeStreamFrame() error = %v", err)
	}

	if decodedMetadata != expectedMetadata {
		t.Fatalf("decoded metadata = %+v, want %+v", decodedMetadata, expectedMetadata)
	}
	if !bytes.Equal(frame.Payload, expectedPayload) {
		t.Fatalf("frame payload = %q, want %q", frame.Payload, expectedPayload)
	}
}

func TestDecodeFrameRejectsWrongKind(t *testing.T) {
	frame := Frame{
		Kind:     FrameKindControl,
		Metadata: []byte(`{"type":"status"}`),
	}

	var stream StreamFrame
	if err := DecodeStreamFrame(frame, &stream); err == nil {
		t.Fatal("DecodeStreamFrame() error = nil, want non-nil")
	}
}
