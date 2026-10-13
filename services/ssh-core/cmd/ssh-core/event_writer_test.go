package main

import (
	"bytes"
	"io"
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

// readFrames 는 출력기가 쓴 프레임을 차례로 넘긴다.
func readFrames(t *testing.T, r io.Reader) <-chan protocol.Frame {
	t.Helper()
	frames := make(chan protocol.Frame, 1024)
	go func() {
		defer close(frames)
		for {
			frame, err := protocol.ReadFrame(r)
			if err != nil {
				return
			}
			frames <- frame
		}
	}()
	return frames
}

func nextFrame(t *testing.T, frames <-chan protocol.Frame) protocol.Frame {
	t.Helper()
	select {
	case frame, ok := <-frames:
		if !ok {
			t.Fatal("프레임이 끊겼다")
		}
		return frame
	case <-time.After(3 * time.Second):
		t.Fatal("프레임이 오지 않았다")
	}
	return protocol.Frame{}
}

func streamOf(t *testing.T, frame protocol.Frame) protocol.StreamFrame {
	t.Helper()
	var metadata protocol.StreamFrame
	if err := protocol.DecodeStreamFrame(frame, &metadata); err != nil {
		t.Fatalf("출력 프레임이 아니다: %v", err)
	}
	return metadata
}

func data(sessionID string) protocol.StreamFrame {
	return protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: sessionID}
}

// 타이핑 에코처럼 조용하다가 온 출력은 모으지 않고 바로 보낸다.
func TestEventWriterSendsAQuietChunkRightAway(t *testing.T) {
	reader, pipe := io.Pipe()
	writer := newEventWriterTo(pipe)
	frames := readFrames(t, reader)

	started := time.Now()
	writer.emitStream(data("s1"), []byte("x"))
	frame := nextFrame(t, frames)
	if elapsed := time.Since(started); elapsed > 200*time.Millisecond {
		t.Fatalf("조용할 때의 출력이 %v 뒤에 나갔다", elapsed)
	}
	if string(frame.Payload) != "x" {
		t.Fatalf("payload = %q", frame.Payload)
	}
}

// 쏟아지는 출력은 조각마다 프레임이 되지 않고 합쳐져야 한다(한 프레임은 32KB 까지). 순서와 내용은 그대로다.
func TestEventWriterMergesABurstFromOneSession(t *testing.T) {
	reader, pipe := io.Pipe()
	writer := newEventWriterTo(pipe)
	frames := readFrames(t, reader)

	var sent bytes.Buffer
	for index := 0; index < 200; index++ {
		chunk := []byte(strings.Repeat(string(rune('a'+index%26)), 1024))
		sent.Write(chunk)
		writer.emitStream(data("s1"), chunk)
	}

	var received bytes.Buffer
	count := 0
	for received.Len() < sent.Len() {
		frame := nextFrame(t, frames)
		if len(frame.Payload) > coalesceMaxBytes {
			t.Fatalf("프레임이 %d 바이트다(최대 %d)", len(frame.Payload), coalesceMaxBytes)
		}
		received.Write(frame.Payload)
		count++
	}
	if !bytes.Equal(received.Bytes(), sent.Bytes()) {
		t.Fatal("합친 출력의 순서나 내용이 바뀌었다")
	}
	if count > 50 {
		t.Fatalf("조각 200개가 프레임 %d개로 나갔다 — 합쳐지지 않았다", count)
	}
}

// 제어 이벤트 뒤의 출력은 그 앞 프레임에 붙으면 안 된다(종료 이벤트 뒤에 출력이 오는 식으로 순서가 뒤집힌다).
func TestEventWriterKeepsOrderAroundControlEvents(t *testing.T) {
	reader, pipe := io.Pipe()
	writer := newEventWriterTo(pipe)
	frames := readFrames(t, reader)

	writer.emitStream(data("s1"), []byte("before"))
	writer.emit(protocol.Event{Type: protocol.EventClosed, SessionID: "s1"})
	writer.emitStream(data("s1"), []byte("after"))

	var got []string
	for len(got) < 3 {
		frame := nextFrame(t, frames)
		if frame.Kind == protocol.FrameKindControl {
			got = append(got, "control")
			continue
		}
		got = append(got, string(frame.Payload))
	}
	if strings.Join(got, ",") != "before,control,after" {
		t.Fatalf("순서 = %v", got)
	}
}

// 세션이 섞여 와도 세션마다의 순서는 그대로여야 한다. 대상(세션·요청)이 다르면 합치지 않는다.
func TestEventWriterKeepsPerSessionOrder(t *testing.T) {
	reader, pipe := io.Pipe()
	writer := newEventWriterTo(pipe)
	frames := readFrames(t, reader)

	request := protocol.StreamFrame{Type: protocol.StreamTypeData, SessionID: "s1", RequestID: "r1"}
	writer.emitStream(data("s1"), []byte("a1"))
	writer.emitStream(data("s2"), []byte("b1"))
	writer.emitStream(request, []byte("r1"))
	writer.emitStream(data("s1"), []byte("a2"))
	writer.emitStream(data("s2"), []byte("b2"))

	bySession := map[protocol.StreamFrame]string{}
	total := 0
	for total < len("a1b1r1a2b2") {
		frame := nextFrame(t, frames)
		bySession[streamOf(t, frame)] += string(frame.Payload)
		total += len(frame.Payload)
	}
	if bySession[data("s1")] != "a1a2" || bySession[data("s2")] != "b1b2" || bySession[request] != "r1" {
		t.Fatalf("세션별 출력 = %v", bySession)
	}
}

// 메인이 stdout 을 읽지 않으면 쌓이는 양에 한도가 있어야 한다. 넘으면 출력을 내는 쪽이 기다리고(예전처럼
// 쓰기가 막힌 것과 같다), 다시 읽기 시작하면 풀려야 한다.
//
// 막히기 전까지 받아 두는 양은 쓰는 중인 묶음(한도만큼)과 대기열(한도만큼)을 합친 것이라, 그보다 넉넉히
// 넣어야 막히는지가 드러난다.
func TestEventWriterBlocksProducersWhileStdoutIsStalled(t *testing.T) {
	reader, pipe := io.Pipe()
	writer := newEventWriterTo(pipe)

	done := make(chan struct{})
	go func() {
		defer close(done)
		chunk := bytes.Repeat([]byte("y"), 64*1024)
		for written := 0; written < queueLimitBytes*4; written += len(chunk) {
			writer.emitStream(data("s1"), chunk)
		}
	}()
	select {
	case <-done:
		t.Fatal("stdout 이 막혔는데 출력을 내는 쪽이 한도 없이 계속 넣었다")
	case <-time.After(300 * time.Millisecond):
	}

	go func() { _, _ = io.Copy(io.Discard, reader) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("stdout 을 다시 읽었는데 풀리지 않았다")
	}
}

func TestEventWriterCloseFlushesPendingFrames(t *testing.T) {
	reader, pipe := io.Pipe()
	writer := newEventWriterTo(pipe)
	frames := readFrames(t, reader)

	writer.emitStream(data("s1"), []byte("first"))
	writer.emitStream(data("s1"), []byte("-last"))
	writer.close()

	var received string
	for received != "first-last" {
		received += string(nextFrame(t, frames).Payload)
	}
}
