package tmuxsession

import (
	"io"
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/pkg/coretypes"
)

// runStreamUntilEvent 는 stream 에 feed 를 흘려보낸 뒤 EOF 를 주고, 첫 emit 이벤트를 받는다.
func runStreamUntilEvent(t *testing.T, feed string) coretypes.Event {
	t.Helper()
	events := make(chan coretypes.Event, 8)
	m := NewManager(
		func(e coretypes.Event) { events <- e },
		func(coretypes.StreamFrame, []byte) {},
	)
	handle := &controlHandle{id: "ctl", closed: make(chan struct{})}
	m.mu.Lock()
	m.controls["ctl"] = handle
	m.mu.Unlock()

	pr, pw := io.Pipe()
	go m.stream(handle, pr)
	go func() {
		_, _ = io.WriteString(pw, feed)
		_ = pw.Close() // EOF
	}()

	select {
	case ev := <-events:
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("no event emitted")
		return coretypes.Event{}
	}
}

// 원격에 tmux 가 없으면 셸이 "command not found" 를 내고 채널이 닫힌다. control 프로토콜
// (% notification)이 한 번도 시작되지 않았으므로 탭을 조용히 닫는 대신 EventError 로
// 표면화돼야 한다(원인을 사용자에게 알림).
func TestStreamReportsErrorWhenTmuxNeverStarts(t *testing.T) {
	ev := runStreamUntilEvent(t, "bash: tmux: command not found\n")
	if ev.Type != coretypes.EventError {
		t.Fatalf("want EventError, got %s", ev.Type)
	}
	payload, ok := ev.Payload.(coretypes.ErrorPayload)
	if !ok {
		t.Fatalf("want ErrorPayload, got %T", ev.Payload)
	}
	if !strings.Contains(payload.Message, "tmux") {
		t.Fatalf("message missing tmux hint: %q", payload.Message)
	}
	// 캡처한 셸 출력이 메시지에 포함돼야 진단이 쉽다.
	if !strings.Contains(payload.Message, "command not found") {
		t.Fatalf("message should include captured shell output: %q", payload.Message)
	}
}

// control 프로토콜이 시작된 뒤(=% 라인을 봤음) 채널이 끊기면 비정상 단절로 보고
// EventClosed(transport) — 자동 재연결 대상이다. tmux 부재로 오탐하면 안 된다.
func TestStreamClosesAsTransportAfterControlStarted(t *testing.T) {
	// %begin 은 sawControl 을 세우지만 자체 emit 은 없어, 첫 이벤트가 EOF 종료가 된다.
	ev := runStreamUntilEvent(t, "%begin 1 0\n")
	if ev.Type != coretypes.EventClosed {
		t.Fatalf("want EventClosed, got %s", ev.Type)
	}
	payload, ok := ev.Payload.(coretypes.ClosedPayload)
	if !ok {
		t.Fatalf("want ClosedPayload, got %T", ev.Payload)
	}
	if payload.Reason != "transport" {
		t.Fatalf("want reason transport, got %q", payload.Reason)
	}
}
