package main

import (
	"errors"
	"fmt"
	"io"
	"testing"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshconn"
)

// 점프 홉에서 난 접속 실패는 이벤트에 그 깊이를 싣는다 — 앱이 요청 창을 대상이 아니라 그 점프 호스트로 띄운다.
func TestAsyncConnectErrorCarriesTheJumpDepth(t *testing.T) {
	reader, pipe := io.Pipe()
	writer := newEventWriterTo(pipe)
	frames := readFrames(t, reader)

	// 두 홉 체인의 첫 홉(대상에서 2) 인증 실패 — 홉마다 한 번씩 감싸인 모양 그대로.
	hopErr := &sshconn.JumpHopError{Depth: 2, Err: &sshconn.JumpHopError{Depth: 1, Err: errors.New("password auth requires a password")}}
	emitAsyncError(writer, "req-1", "session-1", "", protocol.EventError, func() error {
		return fmt.Errorf("connect: %w", hopErr)
	})()

	var event struct {
		Type    string                `json:"type"`
		Payload protocol.ErrorPayload `json:"payload"`
	}
	if err := protocol.DecodeControlFrame(nextFrame(t, frames), &event); err != nil {
		t.Fatal(err)
	}
	if event.Payload.JumpDepth != 2 {
		t.Fatalf("jumpDepth = %d, want 2", event.Payload.JumpDepth)
	}
	if event.Payload.Message != "connect: jump host: jump host: password auth requires a password" {
		t.Fatalf("message = %q", event.Payload.Message)
	}
}

// 대상 자신의 실패에는 싣지 않는다(옛 앱과 같은 모양).
func TestAsyncConnectErrorLeavesTheJumpDepthOutForTheTarget(t *testing.T) {
	reader, pipe := io.Pipe()
	writer := newEventWriterTo(pipe)
	frames := readFrames(t, reader)

	emitAsyncError(writer, "req-1", "session-1", "", protocol.EventError, func() error {
		return errors.New("password auth requires a password")
	})()

	frame := nextFrame(t, frames)
	var raw struct {
		Payload map[string]any `json:"payload"`
	}
	if err := protocol.DecodeControlFrame(frame, &raw); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw.Payload["jumpDepth"]; ok {
		t.Fatalf("payload = %v, want no jumpDepth", raw.Payload)
	}
}
