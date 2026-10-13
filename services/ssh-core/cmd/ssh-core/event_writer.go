package main

import (
	"bufio"
	"io"
	"os"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

// eventWriter 는 코어가 데스크톱으로 보내는 프레임(제어 이벤트와 터미널 출력)을 stdout 에 쓴다.
//
// 출력은 PTY·SSH 채널에서 읽은 조각마다 프레임이 됐다. macOS PTY 는 한 번에 1KB 까지만 주므로 쏟아지면
// 초당 수만 개 프레임이 나갔고, 메인과 렌더러가 조각마다 일을 했다(IPC, 녹화, ZMODEM 확인). 그래서 같은
// 세션의 출력이 연달아 오면 한 프레임으로 합친다.
//
//   - 한동안 조용하다가 온 출력은 바로 보낸다. 타이핑 에코가 늦어지지 않는다.
//   - 직전에 보낸 지 coalesceWindow 안이면(쏟아지는 중) 그 창이 끝나거나 한 프레임이 coalesceMaxBytes 가
//     될 때까지 모은다.
//   - 제어 이벤트와의 순서는 그대로다. 제어 이벤트 뒤의 출력은 그 앞의 프레임에 붙지 않고, 제어 이벤트가
//     있으면 기다리지 않고 바로 보낸다.
//   - 모인 프레임은 버퍼에 담아 한 번에 쓴다(예전에는 프레임마다 헤더·메타데이터·데이터를 세 번 썼다).
//
// 메인이 stdout 을 늦게 읽어 쌓인 출력이 queueLimitBytes 를 넘으면 출력을 내는 쪽(세션 읽기 루프)이
// 기다린다. 예전에는 쓰기 자체가 막혀 같은 일이 일어났다 — 흐름 제어 밖 세션에는 이것이 유일한 역압이다.
type eventWriter struct {
	out *bufio.Writer

	mu sync.Mutex
	// space 는 쌓인 출력이 줄었다는 신호다(queueLimitBytes 에 걸린 쪽이 기다린다).
	space       *sync.Cond
	queue       []queuedFrame
	queuedBytes int
	// lastData 는 같은 대상(세션·요청)의 출력이 아직 붙을 수 있는 프레임의 자리다. 제어 이벤트가 들어오면
	// 비운다 — 그 뒤의 출력이 앞 프레임에 붙으면 제어 이벤트와 순서가 바뀐다.
	lastData map[protocol.StreamFrame]int
	// urgent 면 모으지 않고 바로 쓴다(제어 이벤트가 있거나 한 프레임이 가득 찼다).
	urgent    bool
	lastFlush time.Time
	closing   bool

	// wake 는 쓸 것이 생겼다는 신호, kick 은 모으던 것을 지금 쓰라는 신호다(둘 다 버퍼 1).
	wake chan struct{}
	kick chan struct{}
	done chan struct{}
}

type queuedFrame struct {
	control  *protocol.Event
	metadata protocol.StreamFrame
	payload  []byte
}

const (
	coalesceWindow   = time.Millisecond
	coalesceMaxBytes = 32 * 1024
	queueLimitBytes  = 4 * 1024 * 1024
)

func newEventWriter() *eventWriter {
	return newEventWriterTo(os.Stdout)
}

func newEventWriterTo(out io.Writer) *eventWriter {
	writer := &eventWriter{
		out:      bufio.NewWriterSize(out, 64*1024),
		lastData: make(map[protocol.StreamFrame]int),
		wake:     make(chan struct{}, 1),
		kick:     make(chan struct{}, 1),
		done:     make(chan struct{}),
	}
	writer.space = sync.NewCond(&writer.mu)
	go writer.run()
	return writer
}

func (writer *eventWriter) emit(event protocol.Event) {
	writer.mu.Lock()
	writer.queue = append(writer.queue, queuedFrame{control: &event})
	clear(writer.lastData)
	writer.urgent = true
	writer.mu.Unlock()
	nudge(writer.wake)
	nudge(writer.kick)
}

func (writer *eventWriter) emitStream(metadata protocol.StreamFrame, payload []byte) {
	writer.mu.Lock()
	for writer.queuedBytes >= queueLimitBytes && !writer.closing {
		writer.space.Wait()
	}
	index, ok := writer.lastData[metadata]
	if ok && len(writer.queue[index].payload)+len(payload) <= coalesceMaxBytes {
		writer.queue[index].payload = append(writer.queue[index].payload, payload...)
	} else {
		// 부른 쪽은 돌아간 뒤 버퍼를 다시 쓸 수 있다. 쓰기는 나중이므로 복사해 둔다.
		writer.queue = append(writer.queue, queuedFrame{metadata: metadata, payload: append([]byte(nil), payload...)})
		index = len(writer.queue) - 1
		writer.lastData[metadata] = index
	}
	writer.queuedBytes += len(payload)
	full := len(writer.queue[index].payload) >= coalesceMaxBytes
	if full {
		writer.urgent = true
	}
	writer.mu.Unlock()
	nudge(writer.wake)
	if full {
		nudge(writer.kick)
	}
}

// close 는 남은 프레임을 내보내고 쓰기 고루틴을 끝낸다. stdout 이 막혀 있으면 오래 기다리지 않는다.
func (writer *eventWriter) close() {
	writer.mu.Lock()
	writer.closing = true
	writer.space.Broadcast()
	writer.mu.Unlock()
	nudge(writer.wake)
	nudge(writer.kick)
	select {
	case <-writer.done:
	case <-time.After(time.Second):
	}
}

func (writer *eventWriter) run() {
	defer close(writer.done)
	lingered := false
	for {
		writer.mu.Lock()
		if len(writer.queue) == 0 {
			closing := writer.closing
			writer.mu.Unlock()
			if closing {
				return
			}
			<-writer.wake
			continue
		}
		// 쏟아지는 중이면 창이 끝날 때까지 모은다. 급한 것이 생기면 kick 으로 바로 깬다.
		if !writer.urgent && !writer.closing && !lingered {
			if wait := coalesceWindow - time.Since(writer.lastFlush); wait > 0 {
				writer.mu.Unlock()
				timer := time.NewTimer(wait)
				select {
				case <-timer.C:
				case <-writer.kick:
				}
				timer.Stop()
				lingered = true
				continue
			}
		}
		lingered = false
		frames := writer.queue
		writer.queue = nil
		writer.queuedBytes = 0
		clear(writer.lastData)
		writer.urgent = false
		writer.space.Broadcast()
		writer.mu.Unlock()

		for _, frame := range frames {
			if frame.control != nil {
				_ = protocol.WriteControlFrame(writer.out, *frame.control)
				continue
			}
			_ = protocol.WriteStreamFrame(writer.out, frame.metadata, frame.payload)
		}
		_ = writer.out.Flush()

		writer.mu.Lock()
		writer.lastFlush = time.Now()
		writer.mu.Unlock()
	}
}

// nudge 는 버퍼 1인 채널에 신호를 남긴다. 이미 남아 있으면 그대로 둔다.
func nudge(channel chan struct{}) {
	select {
	case channel <- struct{}{}:
	default:
	}
}
