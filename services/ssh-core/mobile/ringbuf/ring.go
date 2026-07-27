// Package ringbuf holds terminal output for a mobile shell session in a
// byte-budgeted history ring that the app reads by cursor.
//
// The desktop app receives terminal bytes as they arrive, pushed over the stdio
// protocol. Mobile cannot afford that: every push would be a React Native
// bridge crossing. So output lands here instead, and the app pulls a replay
// snapshot once and then follows a coalesced live stream, which keeps crossings
// bounded no matter how loud the remote side is.
//
// Sequence numbers are assigned per chunk and never reused. Because chunks are
// appended in order and evicted only from the front, the sequence numbers of
// retained chunks are always contiguous, which is what lets a cursor be
// resolved to a slice index by subtraction rather than a search.
package ringbuf

import (
	"sync"
	"time"
)

// Byte budget for the replay history. Once stored chunks exceed this, the
// oldest are evicted. A larger budget buys a longer scrollback at the cost of
// resident memory on a phone.
const DefaultCapacityBytes = 2 * 1024 * 1024

// Upper bound on a single stored chunk. Incoming reads are split at this size:
// smaller chunks lower latency and shrink the blast radius of a drop, larger
// ones cut per-chunk overhead.
const DefaultMaxChunkBytes = 16 * 1024

// Default ceiling on how many bytes one Read returns.
const DefaultReadMaxBytes = 512 * 1024

// How many live chunks a subscriber may fall behind before it is considered
// lagged and the gap is reported to it as a drop rather than silently skipped.
const DefaultSubscriberQueue = 1024

// StreamKind distinguishes the two shell output streams.
type StreamKind uint8

const (
	StreamStdout StreamKind = iota
	StreamStderr
)

// Chunk is a stored run of terminal bytes.
type Chunk struct {
	Seq    uint64
	TMs    float64
	Stream StreamKind
	Bytes  []byte
}

// DroppedRange reports sequence numbers a reader will never see because they
// were evicted before it got to them.
type DroppedRange struct {
	FromSeq uint64
	ToSeq   uint64
}

// Stats is a snapshot of ring occupancy, used for diagnostics in the app.
type Stats struct {
	RingBytesCount    uint64
	UsedBytes         uint64
	ChunksCount       uint64
	HeadSeq           uint64
	TailSeq           uint64
	DroppedBytesTotal uint64
}

// ReadResult is the outcome of a cursor read. NextSeq is the cursor to resume
// from, so a caller can hand it straight to the next Read or to Subscribe
// without recomputing anything.
type ReadResult struct {
	Chunks  []Chunk
	NextSeq uint64
	Dropped *DroppedRange
}

// CursorMode selects how a Cursor resolves to a starting position.
type CursorMode uint8

const (
	// CursorHead starts at the oldest retained chunk.
	CursorHead CursorMode = iota
	// CursorTailBytes starts far enough back to cover roughly Bytes trailing bytes.
	CursorTailBytes
	// CursorSeq starts at Seq, reporting a drop if it has already been evicted.
	CursorSeq
	// CursorTimeMs starts at the first chunk stored at or after TMs.
	CursorTimeMs
	// CursorLive skips history entirely and starts at the next chunk to arrive.
	CursorLive
)

// Cursor addresses a position in the ring. Only the field belonging to Mode is
// read; the rest are ignored.
type Cursor struct {
	Mode  CursorMode
	Bytes uint64
	Seq   uint64
	TMs   float64
}

// HeadCursor returns a cursor over the whole retained history.
func HeadCursor() Cursor { return Cursor{Mode: CursorHead} }

// SeqCursor returns a cursor resuming at seq.
func SeqCursor(seq uint64) Cursor { return Cursor{Mode: CursorSeq, Seq: seq} }

// LiveCursor returns a cursor that skips history.
func LiveCursor() Cursor { return Cursor{Mode: CursorLive} }

// Ring stores recent terminal output and fans new output out to subscribers.
// All exported methods are safe for concurrent use.
type Ring struct {
	nowMs func() float64

	mu                sync.Mutex
	chunks            []Chunk
	capacityBytes     int
	maxChunkBytes     int
	usedBytes         int
	droppedBytesTotal uint64
	headSeq           uint64
	tailSeq           uint64
	nextSeq           uint64
	subs              map[uint64]*Subscription
	nextSubID         uint64
	closed            bool
}

// New returns an empty ring. Non-positive sizes fall back to the defaults.
func New(capacityBytes, maxChunkBytes int) *Ring {
	if capacityBytes <= 0 {
		capacityBytes = DefaultCapacityBytes
	}
	if maxChunkBytes <= 0 {
		maxChunkBytes = DefaultMaxChunkBytes
	}
	return &Ring{
		nowMs:         nowMs,
		capacityBytes: capacityBytes,
		maxChunkBytes: maxChunkBytes,
		subs:          make(map[uint64]*Subscription),
	}
}

func nowMs() float64 {
	return float64(time.Now().UnixNano()) / float64(time.Millisecond)
}

// Append stores data, splitting it into chunks no larger than the configured
// maximum, evicting from the front to stay inside the byte budget, and handing
// each chunk to every live subscriber.
func (r *Ring) Append(stream StreamKind, data []byte) {
	for offset := 0; offset < len(data); {
		end := offset + r.maxChunkBytes
		if end > len(data) {
			end = len(data)
		}
		// The caller may reuse its read buffer, so the chunk owns a copy.
		payload := make([]byte, end-offset)
		copy(payload, data[offset:end])
		r.appendChunk(stream, payload)
		offset = end
	}
}

func (r *Ring) appendChunk(stream StreamKind, payload []byte) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}

	chunk := Chunk{
		Seq:    r.nextSeq,
		TMs:    r.nowMs(),
		Stream: stream,
		Bytes:  payload,
	}
	r.nextSeq++
	r.tailSeq = chunk.Seq
	if len(r.chunks) == 0 {
		r.headSeq = chunk.Seq
	}
	r.chunks = append(r.chunks, chunk)
	r.usedBytes += len(payload)
	r.evictLocked()

	// Snapshot subscribers so delivery happens without holding the ring lock;
	// a listener that is slow to drain must not stall the reader goroutine.
	targets := make([]*Subscription, 0, len(r.subs))
	for _, sub := range r.subs {
		targets = append(targets, sub)
	}
	r.mu.Unlock()

	for _, sub := range targets {
		sub.deliver(chunk)
	}
}

// evictLocked drops the oldest chunks until the ring fits its byte budget.
// headSeq tracks the oldest surviving sequence number so cursors that point
// into the evicted range can be told what they missed.
func (r *Ring) evictLocked() {
	for r.usedBytes > r.capacityBytes && len(r.chunks) > 0 {
		front := r.chunks[0]
		r.usedBytes -= len(front.Bytes)
		r.droppedBytesTotal += uint64(len(front.Bytes))
		r.headSeq = front.Seq + 1
		// Release the payload; re-slicing alone would keep it reachable
		// through the backing array until the next reallocation.
		r.chunks[0] = Chunk{}
		r.chunks = r.chunks[1:]
	}
}

// Stats returns an occupancy snapshot.
func (r *Ring) Stats() Stats {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Stats{
		RingBytesCount:    uint64(r.capacityBytes),
		UsedBytes:         uint64(r.usedBytes),
		ChunksCount:       uint64(len(r.chunks)),
		HeadSeq:           r.headSeq,
		TailSeq:           r.tailSeq,
		DroppedBytesTotal: r.droppedBytesTotal,
	}
}

// CurrentSeq returns the sequence number the next appended chunk will carry.
func (r *Ring) CurrentSeq() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.nextSeq
}

// Read returns stored chunks from cursor onward, capped at maxBytes (a
// non-positive maxBytes uses DefaultReadMaxBytes).
func (r *Ring) Read(cursor Cursor, maxBytes int) ReadResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.readLocked(cursor, maxBytes)
}

func (r *Ring) readLocked(cursor Cursor, maxBytes int) ReadResult {
	if maxBytes <= 0 {
		maxBytes = DefaultReadMaxBytes
	}

	startIdx, dropped := r.resolveCursorLocked(cursor)

	var (
		out   []Chunk
		total int
	)
	for _, chunk := range r.chunks[startIdx:] {
		if total+len(chunk.Bytes) > maxBytes {
			break
		}
		out = append(out, chunk)
		total += len(chunk.Bytes)
	}

	// Resuming after the last chunk handed out keeps a follow-up read or
	// subscription gap-free; with nothing to hand out, the caller resumes at
	// whatever arrives next.
	nextSeq := r.nextSeq
	if len(out) > 0 {
		nextSeq = out[len(out)-1].Seq + 1
	}

	return ReadResult{Chunks: out, NextSeq: nextSeq, Dropped: dropped}
}

// resolveCursorLocked maps a cursor to an index into r.chunks, plus the range
// of sequence numbers the caller asked for but can no longer be served.
func (r *Ring) resolveCursorLocked(cursor Cursor) (int, *DroppedRange) {
	switch cursor.Mode {
	case CursorHead:
		return 0, nil

	case CursorSeq:
		seq := cursor.Seq
		var dropped *DroppedRange
		if len(r.chunks) > 0 && seq < r.headSeq {
			dropped = &DroppedRange{FromSeq: seq, ToSeq: r.headSeq - 1}
			seq = r.headSeq
		}
		if seq < r.headSeq {
			// Ring is empty, so there is no history to skip past.
			return 0, dropped
		}
		idx := int(seq - r.headSeq)
		if idx > len(r.chunks) {
			idx = len(r.chunks)
		}
		return idx, dropped

	case CursorTimeMs:
		for i, chunk := range r.chunks {
			if chunk.TMs >= cursor.TMs {
				return i, nil
			}
		}
		// Nothing is that recent, so there is nothing to replay. (The Rust
		// implementation this was ported from fell through to index 0 here and
		// replayed the entire ring instead; the app never used this cursor.)
		return len(r.chunks), nil

	case CursorTailBytes:
		idx := len(r.chunks)
		bytes := uint64(0)
		for i := len(r.chunks) - 1; i >= 0; i-- {
			if bytes >= cursor.Bytes {
				idx = i + 1
				break
			}
			bytes += uint64(len(r.chunks[i].Bytes))
			idx = i
		}
		return idx, nil

	case CursorLive:
		return len(r.chunks), nil

	default:
		return len(r.chunks), nil
	}
}
