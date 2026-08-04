package ringbuf

import (
	"bytes"
	"fmt"
	"regexp"
	"strconv"
	"sync"
	"testing"
	"time"
)

// recorder captures listener callbacks in order. A Follower serializes its
// callbacks, but tests read the recording from another goroutine.
type recorder struct {
	mu      sync.Mutex
	bytes   []byte
	chunks  []Chunk
	dropped []DroppedRange

	// gate, when non-nil, blocks the first OnChunk until it is closed, so a
	// test can hold the follower still and force its queue to overflow.
	gate    chan struct{}
	entered chan struct{}
	once    sync.Once
}

func (r *recorder) OnChunk(chunk Chunk) {
	if r.gate != nil {
		r.once.Do(func() {
			close(r.entered)
			<-r.gate
		})
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.bytes = append(r.bytes, chunk.Bytes...)
	r.chunks = append(r.chunks, chunk)
}

func (r *recorder) OnDropped(fromSeq, toSeq uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.dropped = append(r.dropped, DroppedRange{FromSeq: fromSeq, ToSeq: toSeq})
}

func (r *recorder) snapshot() ([]byte, []Chunk, []DroppedRange) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]byte(nil), r.bytes...),
		append([]Chunk(nil), r.chunks...),
		append([]DroppedRange(nil), r.dropped...)
}

// waitForBytes blocks until the recorder has collected want bytes, or fails.
func (r *recorder) waitForBytes(t *testing.T, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		got, _, _ := r.snapshot()
		if len(got) >= want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	got, _, _ := r.snapshot()
	t.Fatalf("timed out waiting for %d bytes, have %d", want, len(got))
}

func TestFollowReplaysThenFollowsLive(t *testing.T) {
	r := newTestRing(1<<20, 64)
	r.nowMs = nowMs
	r.Append(StreamStdout, []byte("history"))

	rec := &recorder{}
	f := Follow(r, HeadCursor(), 5*time.Millisecond, rec)
	defer f.Stop()

	rec.waitForBytes(t, len("history"))
	r.Append(StreamStdout, []byte("live"))
	rec.waitForBytes(t, len("historylive"))

	got, _, dropped := rec.snapshot()
	if string(got) != "historylive" {
		t.Errorf("received %q, want %q", got, "historylive")
	}
	if len(dropped) != 0 {
		t.Errorf("unexpected drops: %+v", dropped)
	}
}

func TestFollowCoalescesWithinWindow(t *testing.T) {
	r := newTestRing(1<<20, 64)
	r.nowMs = nowMs

	rec := &recorder{}
	// A window long enough that all three appends land inside it.
	f := Follow(r, LiveCursor(), 200*time.Millisecond, rec)
	defer f.Stop()

	r.Append(StreamStdout, []byte("a"))
	r.Append(StreamStdout, []byte("b"))
	r.Append(StreamStdout, []byte("c"))

	rec.waitForBytes(t, 3)
	got, chunks, _ := rec.snapshot()
	if string(got) != "abc" {
		t.Errorf("received %q, want %q", got, "abc")
	}
	if len(chunks) != 1 {
		t.Fatalf("expected the window to merge into 1 callback, got %d", len(chunks))
	}
	// The merged chunk reports the position of the last chunk folded in, so a
	// consumer resuming from it does not re-read what it already has.
	if chunks[0].Seq != 2 {
		t.Errorf("merged chunk Seq = %d, want 2 (the last merged)", chunks[0].Seq)
	}
}

func TestFollowFlushesOnStreamSwitch(t *testing.T) {
	r := newTestRing(1<<20, 64)
	r.nowMs = nowMs

	rec := &recorder{}
	f := Follow(r, LiveCursor(), 200*time.Millisecond, rec)
	defer f.Stop()

	r.Append(StreamStdout, []byte("out"))
	r.Append(StreamStderr, []byte("err"))

	rec.waitForBytes(t, 6)
	_, chunks, _ := rec.snapshot()
	if len(chunks) != 2 {
		t.Fatalf("expected a flush at the stream switch (2 callbacks), got %d", len(chunks))
	}
	if chunks[0].Stream != StreamStdout || string(chunks[0].Bytes) != "out" {
		t.Errorf("first callback = %v %q", chunks[0].Stream, chunks[0].Bytes)
	}
	if chunks[1].Stream != StreamStderr || string(chunks[1].Bytes) != "err" {
		t.Errorf("second callback = %v %q", chunks[1].Stream, chunks[1].Bytes)
	}
}

func TestFollowReportsEvictedHistory(t *testing.T) {
	r := newTestRing(10, 5)
	r.nowMs = nowMs
	for _, s := range []string{"aaaaa", "bbbbb", "ccccc"} {
		r.Append(StreamStdout, []byte(s))
	}
	// Chunk 0 is evicted; asking for it must be reported, not silently skipped.

	rec := &recorder{}
	f := Follow(r, SeqCursor(0), 5*time.Millisecond, rec)
	defer f.Stop()

	rec.waitForBytes(t, 10)
	_, _, dropped := rec.snapshot()
	if len(dropped) != 1 {
		t.Fatalf("expected 1 drop report, got %+v", dropped)
	}
	if dropped[0] != (DroppedRange{FromSeq: 0, ToSeq: 0}) {
		t.Errorf("dropped = %+v, want {0 0}", dropped[0])
	}
}

// The handover the app performs: read history once, then follow from the
// cursor that read handed back. Output keeps arriving throughout, which is the
// case that a non-atomic snapshot-then-subscribe would lose a chunk in.
func TestReadThenFollowHandoverIsExact(t *testing.T) {
	const total = 400

	for attempt := 0; attempt < 20; attempt++ {
		r := New(1<<20, 16)

		var (
			writeWG  sync.WaitGroup
			expected []byte
			expMu    sync.Mutex
		)
		writeWG.Add(1)
		go func() {
			defer writeWG.Done()
			for i := 0; i < total; i++ {
				payload := []byte(fmt.Sprintf("%04d;", i))
				expMu.Lock()
				expected = append(expected, payload...)
				expMu.Unlock()
				r.Append(StreamStdout, payload)
				if i%37 == 0 {
					time.Sleep(time.Microsecond)
				}
			}
		}()

		// Attach partway through the write stream.
		time.Sleep(time.Duration(attempt) * 100 * time.Microsecond)

		replay := r.Read(HeadCursor(), 0)
		rec := &recorder{}
		f := Follow(r, SeqCursor(replay.NextSeq), 2*time.Millisecond, rec)

		writeWG.Wait()
		want := func() []byte {
			expMu.Lock()
			defer expMu.Unlock()
			return append([]byte(nil), expected...)
		}()

		replayBytes := collect(replay.Chunks)
		rec.waitForBytes(t, len(want)-len(replayBytes))
		f.Stop()

		live, _, dropped := rec.snapshot()
		if len(dropped) != 0 {
			t.Fatalf("attempt %d: unexpected drops %+v", attempt, dropped)
		}

		got := append(append([]byte(nil), replayBytes...), live...)
		if !bytes.Equal(got, want) {
			t.Fatalf("attempt %d: handover lost or duplicated bytes\n got %d bytes\nwant %d bytes",
				attempt, len(got), len(want))
		}
	}
}

var payloadPattern = regexp.MustCompile(`(\d{6});`)

// A listener that cannot keep up must be told which sequence numbers it missed,
// rather than handed a stream with an invisible hole in it.
func TestFollowReportsQueueOverflow(t *testing.T) {
	// Ample capacity, so every drop here comes from the subscriber queue rather
	// than from ring eviction.
	r := New(1<<22, 64)

	rec := &recorder{
		gate:    make(chan struct{}),
		entered: make(chan struct{}),
	}
	f := Follow(r, LiveCursor(), time.Millisecond, rec)
	defer f.Stop()

	// One append gets the follower into OnChunk, where it parks on the gate.
	written := 0
	appendPayload := func() {
		r.Append(StreamStdout, []byte(fmt.Sprintf("%06d;", written)))
		written++
	}
	appendPayload()
	select {
	case <-rec.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("follower never reached OnChunk")
	}

	// Overrun the queue while the follower is parked.
	overflow := DefaultSubscriberQueue + 500
	for i := 0; i < overflow; i++ {
		appendPayload()
	}

	// 검증 대상은 여기까지 쓴 범위로 못박는다. 아래 폴링 루프가 넣는 payload 는 갭을 관측
	// 가능하게 만들기 위한 자극이고, 그 중 마지막 것들은 스냅샷 시점에 아직 큐나 코얼레싱
	// 배치에 남아 있는 것이 정상이다.
	burstWritten := written

	close(rec.gate)

	// "드롭이 보고됐다" 를 신호로 삼아 곧바로 스냅샷을 찍으면 안 된다. OnDropped 은 admit()
	// 안에서 갭을 발견한 즉시 불리는데, OnChunk 은 코얼레싱 윈도우가 닫힌 뒤 batch.flush()
	// 에서만 불린다 — 그래서 갭을 유발한 chunk 가 아직 전달되지 않은 중간 상태가 존재한다.
	// 부하가 큰 러너(CI Windows)에서 이 창이 벌어져 "전달도 드롭도 아닌 payload" 로 실패했다.
	//
	// 신호와 단정을 같은 조건으로 맞춘다 — 버스트 범위가 전부 계정되고 드롭도 최소 한 건
	// 보고될 때까지 기다린다. 계정 규칙 위반(중복 전달, 전달과 드롭 동시)은 매 회 확인한다.
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, _, dropped := rec.snapshot()
		seen, err := accountForPayloads(got, dropped)
		if err != nil {
			t.Fatal(err)
		}

		missing, incomplete := firstUnaccountedPayload(seen, burstWritten)
		if len(dropped) > 0 && !incomplete {
			return
		}
		if time.Now().After(deadline) {
			if len(dropped) == 0 {
				t.Fatal("queue overflow was never reported as a drop")
			}
			t.Fatalf("payload %d was neither delivered nor reported dropped", missing)
		}
		appendPayload()
		time.Sleep(2 * time.Millisecond)
	}
}

// accountForPayloads 는 전달된 바이트와 드롭 보고를 합쳐 payload 인덱스별 계정을 만든다.
// 같은 인덱스를 두 번 주장하면(중복 전달, 또는 전달과 드롭 동시) 에러다 — 둘 다 화면에 글자가
// 겹쳐 보이거나 사라지는 실제 증상으로 이어진다.
func accountForPayloads(
	delivered []byte,
	dropped []DroppedRange,
) (map[int]bool, error) {
	seen := map[int]bool{}
	for _, match := range payloadPattern.FindAllSubmatch(delivered, -1) {
		index, err := strconv.Atoi(string(match[1]))
		if err != nil {
			return nil, fmt.Errorf("unparseable payload %q", match[1])
		}
		if seen[index] {
			return nil, fmt.Errorf("payload %d was delivered twice", index)
		}
		seen[index] = true
	}

	// 각 payload 는 정확히 한 chunk 이므로 인덱스와 시퀀스 번호가 같다.
	for _, gap := range dropped {
		for seq := gap.FromSeq; seq <= gap.ToSeq; seq++ {
			if seen[int(seq)] {
				return nil, fmt.Errorf(
					"payload %d was both delivered and reported dropped",
					seq,
				)
			}
			seen[int(seq)] = true
		}
	}
	return seen, nil
}

// firstUnaccountedPayload 는 [0, count) 에서 아직 계정되지 않은 첫 인덱스를 돌려준다.
func firstUnaccountedPayload(seen map[int]bool, count int) (index int, found bool) {
	for i := 0; i < count; i++ {
		if !seen[i] {
			return i, true
		}
	}
	return 0, false
}

func TestFollowerStopIsIdempotentAndQuiesces(t *testing.T) {
	r := New(1<<20, 64)
	rec := &recorder{}
	f := Follow(r, LiveCursor(), 5*time.Millisecond, rec)

	r.Append(StreamStdout, []byte("before"))
	rec.waitForBytes(t, len("before"))

	f.Stop()
	f.Stop() // idempotent

	// Stop waits for the goroutine, so nothing may be recorded after it.
	before, _, _ := rec.snapshot()
	r.Append(StreamStdout, []byte("after"))
	time.Sleep(20 * time.Millisecond)
	after, _, _ := rec.snapshot()

	if !bytes.Equal(before, after) {
		t.Errorf("callback arrived after Stop: %q then %q", before, after)
	}
}

func TestRingCloseEndsFollower(t *testing.T) {
	r := New(1<<20, 64)
	rec := &recorder{}
	f := Follow(r, LiveCursor(), 5*time.Millisecond, rec)

	r.Append(StreamStdout, []byte("tail"))
	rec.waitForBytes(t, len("tail"))

	r.Close()

	// The follower goroutine must exit on its own once the ring closes.
	done := make(chan struct{})
	go func() {
		f.Stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("follower did not exit after the ring closed")
	}
}

func TestSubscribeAfterCloseYieldsClosedFeed(t *testing.T) {
	r := New(1<<20, 64)
	r.Append(StreamStdout, []byte("stored"))
	r.Close()

	rec := &recorder{}
	f := Follow(r, HeadCursor(), 5*time.Millisecond, rec)

	// Replay still arrives, then the follower finishes without blocking.
	done := make(chan struct{})
	go func() {
		f.Stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("follower blocked on a closed ring")
	}

	got, _, _ := rec.snapshot()
	if string(got) != "stored" {
		t.Errorf("replay after close = %q, want %q", got, "stored")
	}
}
