package ringbuf

import "sync"

// Subscription is a live feed of chunks appended after the replay snapshot it
// was handed out with.
//
// Delivery never blocks the shell reader. When a consumer falls far enough
// behind to fill its queue, further chunks are discarded and the subscription
// is flagged as lagged, so the consumer can report a gap instead of silently
// rendering torn output.
type Subscription struct {
	ring *Ring
	id   uint64
	ch   chan Chunk

	mu     sync.Mutex
	lagged bool
	closed bool
}

// Subscribe takes a replay snapshot at cursor and registers a live feed for
// everything after it, as one atomic step.
//
// Doing both under the ring lock is what makes the handover exact: a chunk
// appended concurrently either lands in the returned snapshot or is delivered
// on the returned channel, never both and never neither. Snapshotting and
// subscribing as two separate steps would leave a window where a chunk falls
// between them and is lost.
//
// A non-positive queue uses DefaultSubscriberQueue.
func (r *Ring) Subscribe(cursor Cursor, queue int) (ReadResult, *Subscription) {
	if queue <= 0 {
		queue = DefaultSubscriberQueue
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	replay := r.readLocked(cursor, 0)

	sub := &Subscription{
		ring: r,
		id:   r.nextSubID,
		ch:   make(chan Chunk, queue),
	}
	r.nextSubID++

	if r.closed {
		// Nothing further will arrive; hand back a closed feed so the consumer
		// drains the replay and stops rather than waiting forever.
		sub.closed = true
		close(sub.ch)
		return replay, sub
	}

	r.subs[sub.id] = sub
	return replay, sub
}

// Chunks is the live feed. It is closed when the subscription or the ring is
// closed.
func (s *Subscription) Chunks() <-chan Chunk { return s.ch }

// TakeLagged reports whether chunks were discarded since the last call, and
// clears the flag.
func (s *Subscription) TakeLagged() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	lagged := s.lagged
	s.lagged = false
	return lagged
}

// Close unregisters the subscription and closes its feed. It is idempotent.
func (s *Subscription) Close() {
	s.ring.mu.Lock()
	delete(s.ring.subs, s.id)
	s.ring.mu.Unlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	close(s.ch)
}

// deliver hands a chunk to the consumer, or flags a gap if it cannot keep up.
func (s *Subscription) deliver(chunk Chunk) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	select {
	case s.ch <- chunk:
	default:
		s.lagged = true
	}
}

// Close shuts the ring down and closes every subscription, so consumers
// blocked on their feeds exit. Appends after this are ignored. It is
// idempotent.
func (r *Ring) Close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	subs := make([]*Subscription, 0, len(r.subs))
	for id, sub := range r.subs {
		subs = append(subs, sub)
		delete(r.subs, id)
	}
	r.mu.Unlock()

	for _, sub := range subs {
		sub.mu.Lock()
		if !sub.closed {
			sub.closed = true
			close(sub.ch)
		}
		sub.mu.Unlock()
	}
}
