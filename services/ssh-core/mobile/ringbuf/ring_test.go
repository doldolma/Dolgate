package ringbuf

import (
	"bytes"
	"fmt"
	"sync"
	"testing"
)

// newTestRing returns a ring with a deterministic clock so time-based cursors
// can be asserted exactly. Each appended chunk advances the clock by 1ms.
func newTestRing(capacityBytes, maxChunkBytes int) *Ring {
	r := New(capacityBytes, maxChunkBytes)
	tick := 0.0
	r.nowMs = func() float64 {
		tick++
		return tick
	}
	return r
}

func collect(chunks []Chunk) []byte {
	var out []byte
	for _, chunk := range chunks {
		out = append(out, chunk.Bytes...)
	}
	return out
}

func TestAppendSplitsAtMaxChunk(t *testing.T) {
	r := newTestRing(1024, 4)
	r.Append(StreamStdout, []byte("abcdefghij"))

	got := r.Read(HeadCursor(), 0)
	if len(got.Chunks) != 3 {
		t.Fatalf("expected 3 chunks of at most 4 bytes, got %d", len(got.Chunks))
	}
	for i, chunk := range got.Chunks {
		if len(chunk.Bytes) > 4 {
			t.Errorf("chunk %d is %d bytes, over the 4 byte maximum", i, len(chunk.Bytes))
		}
		if chunk.Seq != uint64(i) {
			t.Errorf("chunk %d has seq %d, want %d", i, chunk.Seq, i)
		}
	}
	if string(collect(got.Chunks)) != "abcdefghij" {
		t.Errorf("reassembled %q, want %q", collect(got.Chunks), "abcdefghij")
	}
	if got.NextSeq != 3 {
		t.Errorf("NextSeq = %d, want 3", got.NextSeq)
	}
}

func TestAppendCopiesCallerBuffer(t *testing.T) {
	r := newTestRing(1024, 16)
	buf := []byte("first")
	r.Append(StreamStdout, buf)
	// A shell reader reuses its read buffer for the next read.
	copy(buf, []byte("XXXXX"))

	got := r.Read(HeadCursor(), 0)
	if string(collect(got.Chunks)) != "first" {
		t.Errorf("stored bytes aliased the caller buffer: got %q", collect(got.Chunks))
	}
}

func TestEvictionKeepsByteBudgetAndTracksHead(t *testing.T) {
	// Capacity 10 with 5-byte chunks holds exactly two chunks.
	r := newTestRing(10, 5)
	r.Append(StreamStdout, []byte("aaaaa"))
	r.Append(StreamStdout, []byte("bbbbb"))

	if stats := r.Stats(); stats.UsedBytes != 10 || stats.HeadSeq != 0 || stats.DroppedBytesTotal != 0 {
		t.Fatalf("before eviction: %+v", stats)
	}

	r.Append(StreamStdout, []byte("ccccc"))

	stats := r.Stats()
	if stats.UsedBytes != 10 {
		t.Errorf("UsedBytes = %d, want 10 (budget)", stats.UsedBytes)
	}
	if stats.ChunksCount != 2 {
		t.Errorf("ChunksCount = %d, want 2", stats.ChunksCount)
	}
	if stats.HeadSeq != 1 {
		t.Errorf("HeadSeq = %d, want 1 (chunk 0 evicted)", stats.HeadSeq)
	}
	if stats.TailSeq != 2 {
		t.Errorf("TailSeq = %d, want 2", stats.TailSeq)
	}
	if stats.DroppedBytesTotal != 5 {
		t.Errorf("DroppedBytesTotal = %d, want 5", stats.DroppedBytesTotal)
	}
	if got := string(collect(r.Read(HeadCursor(), 0).Chunks)); got != "bbbbbccccc" {
		t.Errorf("retained %q, want %q", got, "bbbbbccccc")
	}
}

func TestSeqCursorReportsEvictedRange(t *testing.T) {
	r := newTestRing(10, 5)
	for _, s := range []string{"aaaaa", "bbbbb", "ccccc", "ddddd"} {
		r.Append(StreamStdout, []byte(s))
	}
	// Chunks 0 and 1 are gone; head is now 2.

	got := r.Read(SeqCursor(0), 0)
	if got.Dropped == nil {
		t.Fatal("expected a dropped range for an evicted cursor")
	}
	if got.Dropped.FromSeq != 0 || got.Dropped.ToSeq != 1 {
		t.Errorf("Dropped = %+v, want {0 1}", *got.Dropped)
	}
	if s := string(collect(got.Chunks)); s != "cccccddddd" {
		t.Errorf("chunks = %q, want %q", s, "cccccddddd")
	}
	if got.NextSeq != 4 {
		t.Errorf("NextSeq = %d, want 4", got.NextSeq)
	}
}

func TestSeqCursorAtAndBeyondTail(t *testing.T) {
	r := newTestRing(1024, 5)
	r.Append(StreamStdout, []byte("aaaaa"))
	r.Append(StreamStdout, []byte("bbbbb"))

	// Exactly caught up: nothing to hand out, resume where we are.
	got := r.Read(SeqCursor(2), 0)
	if len(got.Chunks) != 0 {
		t.Errorf("expected no chunks at tail, got %d", len(got.Chunks))
	}
	if got.NextSeq != 2 {
		t.Errorf("NextSeq = %d, want 2", got.NextSeq)
	}
	if got.Dropped != nil {
		t.Errorf("unexpected drop at tail: %+v", *got.Dropped)
	}

	// Past the tail should clamp rather than index out of range.
	if got := r.Read(SeqCursor(99), 0); len(got.Chunks) != 0 || got.NextSeq != 2 {
		t.Errorf("beyond tail: chunks=%d NextSeq=%d, want 0 and 2", len(got.Chunks), got.NextSeq)
	}
}

func TestSeqCursorMidRing(t *testing.T) {
	r := newTestRing(1024, 5)
	for _, s := range []string{"aaaaa", "bbbbb", "ccccc"} {
		r.Append(StreamStdout, []byte(s))
	}

	got := r.Read(SeqCursor(1), 0)
	if s := string(collect(got.Chunks)); s != "bbbbbccccc" {
		t.Errorf("chunks = %q, want %q", s, "bbbbbccccc")
	}
	if got.Dropped != nil {
		t.Errorf("unexpected drop: %+v", *got.Dropped)
	}
}

func TestReadOnEmptyRing(t *testing.T) {
	r := newTestRing(1024, 16)

	for name, cursor := range map[string]Cursor{
		"head":      HeadCursor(),
		"live":      LiveCursor(),
		"seq":       SeqCursor(0),
		"tailBytes": {Mode: CursorTailBytes, Bytes: 100},
		"timeMs":    {Mode: CursorTimeMs, TMs: 0},
	} {
		got := r.Read(cursor, 0)
		if len(got.Chunks) != 0 {
			t.Errorf("%s: expected no chunks, got %d", name, len(got.Chunks))
		}
		if got.NextSeq != 0 {
			t.Errorf("%s: NextSeq = %d, want 0", name, got.NextSeq)
		}
		if got.Dropped != nil {
			t.Errorf("%s: unexpected drop %+v", name, *got.Dropped)
		}
	}
}

func TestLiveCursorSkipsHistory(t *testing.T) {
	r := newTestRing(1024, 5)
	r.Append(StreamStdout, []byte("aaaaa"))

	got := r.Read(LiveCursor(), 0)
	if len(got.Chunks) != 0 {
		t.Errorf("live cursor returned %d chunks, want 0", len(got.Chunks))
	}
	if got.NextSeq != 1 {
		t.Errorf("NextSeq = %d, want 1", got.NextSeq)
	}
}

func TestTailBytesCursor(t *testing.T) {
	r := newTestRing(1024, 5)
	for _, s := range []string{"aaaaa", "bbbbb", "ccccc"} {
		r.Append(StreamStdout, []byte(s))
	}

	// Asking for 5 trailing bytes lands on a chunk boundary.
	if s := string(collect(r.Read(Cursor{Mode: CursorTailBytes, Bytes: 5}, 0).Chunks)); s != "ccccc" {
		t.Errorf("5 trailing bytes = %q, want %q", s, "ccccc")
	}
	// A request that falls mid-chunk includes the whole chunk it lands in.
	if s := string(collect(r.Read(Cursor{Mode: CursorTailBytes, Bytes: 6}, 0).Chunks)); s != "bbbbbccccc" {
		t.Errorf("6 trailing bytes = %q, want %q", s, "bbbbbccccc")
	}
	// Zero trailing bytes is the live position.
	if got := r.Read(Cursor{Mode: CursorTailBytes, Bytes: 0}, 0); len(got.Chunks) != 0 {
		t.Errorf("0 trailing bytes returned %d chunks, want 0", len(got.Chunks))
	}
	// More than is stored is the whole ring.
	if s := string(collect(r.Read(Cursor{Mode: CursorTailBytes, Bytes: 9999}, 0).Chunks)); s != "aaaaabbbbbccccc" {
		t.Errorf("oversized request = %q, want the whole ring", s)
	}
}

func TestTimeMsCursor(t *testing.T) {
	// The test clock hands out 1, 2, 3 for the three chunks.
	r := newTestRing(1024, 5)
	for _, s := range []string{"aaaaa", "bbbbb", "ccccc"} {
		r.Append(StreamStdout, []byte(s))
	}

	if s := string(collect(r.Read(Cursor{Mode: CursorTimeMs, TMs: 2}, 0).Chunks)); s != "bbbbbccccc" {
		t.Errorf("from t=2 got %q, want %q", s, "bbbbbccccc")
	}
	// Nothing is that recent, so nothing replays.
	if got := r.Read(Cursor{Mode: CursorTimeMs, TMs: 99}, 0); len(got.Chunks) != 0 {
		t.Errorf("from a future timestamp got %d chunks, want 0", len(got.Chunks))
	}
}

func TestReadTruncatesAtMaxBytes(t *testing.T) {
	r := newTestRing(1024, 5)
	for _, s := range []string{"aaaaa", "bbbbb", "ccccc"} {
		r.Append(StreamStdout, []byte(s))
	}

	got := r.Read(HeadCursor(), 12)
	if s := string(collect(got.Chunks)); s != "aaaaabbbbb" {
		t.Errorf("chunks = %q, want %q (a third chunk would exceed 12 bytes)", s, "aaaaabbbbb")
	}
	// The resume cursor must reflect what was actually handed out, so the rest
	// is picked up by the next read rather than skipped.
	if got.NextSeq != 2 {
		t.Fatalf("NextSeq = %d, want 2", got.NextSeq)
	}
	if s := string(collect(r.Read(SeqCursor(got.NextSeq), 0).Chunks)); s != "ccccc" {
		t.Errorf("continuation = %q, want %q", s, "ccccc")
	}
}

func TestStreamKindPreserved(t *testing.T) {
	r := newTestRing(1024, 16)
	r.Append(StreamStdout, []byte("out"))
	r.Append(StreamStderr, []byte("err"))

	got := r.Read(HeadCursor(), 0).Chunks
	if len(got) != 2 {
		t.Fatalf("expected 2 chunks, got %d", len(got))
	}
	if got[0].Stream != StreamStdout || got[1].Stream != StreamStderr {
		t.Errorf("streams = %v, %v; want stdout, stderr", got[0].Stream, got[1].Stream)
	}
}

// Sequence numbers must stay contiguous across eviction, since cursor
// resolution maps a sequence number to a slice index by subtracting headSeq.
func TestSeqStaysContiguousAcrossEviction(t *testing.T) {
	r := newTestRing(50, 5)
	for i := 0; i < 40; i++ {
		r.Append(StreamStdout, []byte(fmt.Sprintf("%05d", i)))
	}

	got := r.Read(HeadCursor(), 0)
	stats := r.Stats()
	if uint64(len(got.Chunks)) != stats.ChunksCount {
		t.Fatalf("read %d chunks but stats say %d", len(got.Chunks), stats.ChunksCount)
	}
	if got.Chunks[0].Seq != stats.HeadSeq {
		t.Errorf("first chunk seq %d != HeadSeq %d", got.Chunks[0].Seq, stats.HeadSeq)
	}
	for i := 1; i < len(got.Chunks); i++ {
		if got.Chunks[i].Seq != got.Chunks[i-1].Seq+1 {
			t.Fatalf("seq gap at %d: %d then %d", i, got.Chunks[i-1].Seq, got.Chunks[i].Seq)
		}
	}
	if last := got.Chunks[len(got.Chunks)-1].Seq; last != stats.TailSeq {
		t.Errorf("last chunk seq %d != TailSeq %d", last, stats.TailSeq)
	}
}

// Reading by cursor while output keeps arriving must reconstruct the exact byte
// stream: every byte once, in order. This is the property the terminal depends
// on, and the reason chunked reads carry a resume cursor at all.
func TestSequentialCursorReadsLoseNothing(t *testing.T) {
	r := newTestRing(DefaultCapacityBytes, 8)

	var (
		want []byte
		got  []byte
	)
	cursor := uint64(0)
	for round := 0; round < 200; round++ {
		payload := []byte(fmt.Sprintf("round-%03d;", round))
		want = append(want, payload...)
		r.Append(StreamStdout, payload)

		result := r.Read(SeqCursor(cursor), 0)
		if result.Dropped != nil {
			t.Fatalf("round %d: unexpected drop %+v (capacity should be ample)", round, *result.Dropped)
		}
		got = append(got, collect(result.Chunks)...)
		cursor = result.NextSeq
	}

	if !bytes.Equal(got, want) {
		t.Errorf("reassembled stream differs from what was written\n got %d bytes\nwant %d bytes", len(got), len(want))
	}
}

func TestConcurrentAppendAndRead(t *testing.T) {
	r := newTestRing(64*1024, 64)
	// The deterministic test clock is not safe under concurrency.
	r.nowMs = nowMs

	var wg sync.WaitGroup
	wg.Add(3)

	go func() {
		defer wg.Done()
		for i := 0; i < 500; i++ {
			r.Append(StreamStdout, []byte(fmt.Sprintf("payload-%04d", i)))
		}
	}()
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			cursor := uint64(0)
			for j := 0; j < 500; j++ {
				result := r.Read(SeqCursor(cursor), 0)
				cursor = result.NextSeq
				r.Stats()
				r.CurrentSeq()
			}
		}()
	}

	wg.Wait()
}
