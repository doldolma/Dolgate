package ringbuf

import "time"

// Default window over which live chunks are merged before being handed to a
// listener. At 16ms a listener sees at most ~62 callbacks per second no matter
// how much output the remote side produces, which is what keeps a chatty
// command from saturating the React Native bridge.
const DefaultCoalesceMs = 16

// Listener receives terminal output for one consumer.
//
// Calls are serialized: a Follower never invokes a listener concurrently with
// itself, so implementations do not need their own locking.
type Listener interface {
	// OnChunk delivers terminal bytes. During replay these are the stored
	// chunks; afterwards they are merges of everything that arrived within one
	// coalescing window, carrying the sequence number and timestamp of the last
	// chunk merged in.
	OnChunk(chunk Chunk)
	// OnDropped reports an inclusive range of sequence numbers the listener
	// will never receive, because they were evicted before it reached them or
	// discarded while it was behind.
	OnDropped(fromSeq, toSeq uint64)
}

// Follower replays history to a listener and then follows live output.
type Follower struct {
	sub  *Subscription
	done chan struct{}
}

// Follow replays from cursor and then follows live output on a goroutine,
// merging chunks within window before each callback. A non-positive window
// uses DefaultCoalesceMs.
//
// Replay chunks are delivered as stored rather than merged, so a caller that
// reconstructs a terminal from them sees the same boundaries the ring recorded.
func Follow(r *Ring, cursor Cursor, window time.Duration, listener Listener) *Follower {
	if window <= 0 {
		window = DefaultCoalesceMs * time.Millisecond
	}

	replay, sub := r.Subscribe(cursor, 0)
	f := &Follower{sub: sub, done: make(chan struct{})}

	go f.run(replay, window, listener)
	return f
}

// Stop ends the follow and waits for the listener goroutine to finish, so no
// callback can arrive after it returns. It is idempotent.
func (f *Follower) Stop() {
	f.sub.Close()
	<-f.done
}

func (f *Follower) run(replay ReadResult, window time.Duration, listener Listener) {
	defer close(f.done)

	if replay.Dropped != nil {
		listener.OnDropped(replay.Dropped.FromSeq, replay.Dropped.ToSeq)
	}
	for _, chunk := range replay.Chunks {
		listener.OnChunk(chunk)
	}

	// Tracking the next sequence number we expect, rather than the last one we
	// saw, keeps the very first live chunk from underflowing when the replay was
	// empty (NextSeq is 0 on a fresh session).
	expectedSeq := replay.NextSeq

	feed := f.sub.Chunks()
	timer := time.NewTimer(window)
	defer timer.Stop()
	// Go 1.23 made timer channels unbuffered, so Reset cannot leave a stale
	// value behind and needs no drain.
	timer.Stop()

	for {
		first, ok := <-feed
		if !ok {
			return
		}

		var deliver bool
		expectedSeq, deliver = admit(listener, expectedSeq, first)
		if !deliver {
			continue
		}

		batch := newBatch(first)
		timer.Reset(window)

		// Merge until the window closes, the stream switches, or the feed ends.
	merge:
		for {
			select {
			case <-timer.C:
				break merge

			case next, ok := <-feed:
				if !ok {
					timer.Stop()
					batch.flush(listener)
					return
				}

				expectedSeq, deliver = admit(listener, expectedSeq, next)
				if !deliver {
					continue
				}

				if next.Stream != batch.stream {
					// stdout and stderr must stay distinguishable, so a switch
					// forces a flush and restarts the window.
					batch.flush(listener)
					batch = newBatch(next)
					timer.Reset(window)
					continue
				}
				batch.add(next)
			}
		}

		timer.Stop()
		batch.flush(listener)
	}
}

// admit decides whether a chunk should be delivered, reporting any gap ahead of
// it, and returns the next expected sequence number.
//
// Detecting a gap from the sequence numbers themselves, rather than from a
// "you fell behind" flag, puts the report at the right point in the stream: a
// queue overflow drops the newest chunks while the listener is still draining
// older ones, so the flag is set well before the hole is reached.
//
// A chunk at or below what has already been delivered must be dropped, not just
// left out of the cursor: delivering it again duplicates bytes on screen, which
// shows up as every character appearing twice.
func admit(listener Listener, expectedSeq uint64, chunk Chunk) (nextSeq uint64, deliver bool) {
	if chunk.Seq < expectedSeq {
		return expectedSeq, false
	}
	if chunk.Seq > expectedSeq {
		listener.OnDropped(expectedSeq, chunk.Seq-1)
	}
	return chunk.Seq + 1, true
}

// batch accumulates same-stream chunks for one coalescing window.
type batch struct {
	stream  StreamKind
	bytes   []byte
	lastSeq uint64
	lastTMs float64
}

func newBatch(first Chunk) *batch {
	b := &batch{stream: first.Stream}
	b.add(first)
	return b
}

func (b *batch) add(chunk Chunk) {
	b.bytes = append(b.bytes, chunk.Bytes...)
	b.lastSeq = chunk.Seq
	b.lastTMs = chunk.TMs
}

func (b *batch) flush(listener Listener) {
	if len(b.bytes) == 0 {
		return
	}
	listener.OnChunk(Chunk{
		Seq:    b.lastSeq,
		TMs:    b.lastTMs,
		Stream: b.stream,
		Bytes:  b.bytes,
	})
	b.bytes = nil
}
