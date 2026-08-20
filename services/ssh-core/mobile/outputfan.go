package mobile

import (
	"sync"
	"time"

	"dolssh/services/ssh-core/mobile/ringbuf"
)

// outputFan 은 링 버퍼 하나에 붙은 구독자들을 관리한다.
//
// SSH 셸과 SSM 셸이 **같은 방식으로** 출력을 흘려보내야 해서 따로 뺐다. 앱의 터미널 화면은
// 커서 모드·꼬리 바이트·합치기(coalesce) 규칙에 맞춰 그리는데, 두 경로가 각자 구현하면 그 규칙이
// 조용히 갈린다 — 한쪽에서 스크롤 복원이 되고 다른 쪽은 안 되는 식으로.
type outputFan struct {
	ring *ringbuf.Ring

	mu             sync.Mutex
	followers      map[int64]*ringbuf.Follower
	nextListenerID int64
}

func newOutputFan(ring *ringbuf.Ring) *outputFan {
	return &outputFan{ring: ring, followers: make(map[int64]*ringbuf.Follower)}
}

func (f *outputFan) currentSeq() int64 { return toInt64(f.ring.CurrentSeq()) }

func (f *outputFan) readBuffer(
	cursorMode int,
	seq int64,
	tailBytes int64,
	timeMs float64,
	maxBytes int,
) *ReadResult {
	return newReadResult(f.ring.Read(buildCursor(cursorMode, seq, tailBytes, timeMs), maxBytes))
}

func (f *outputFan) addListener(
	listener Listener,
	cursorMode int,
	seq int64,
	tailBytes int64,
	timeMs float64,
	coalesceMs int,
) int64 {
	if listener == nil {
		return 0
	}
	follower := ringbuf.Follow(
		f.ring,
		buildCursor(cursorMode, seq, tailBytes, timeMs),
		time.Duration(coalesceMs)*time.Millisecond,
		&listenerBridge{listener: listener},
	)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextListenerID++
	id := f.nextListenerID
	f.followers[id] = follower
	return id
}

func (f *outputFan) removeListener(id int64) {
	f.mu.Lock()
	follower := f.followers[id]
	delete(f.followers, id)
	f.mu.Unlock()
	if follower != nil {
		follower.Stop()
	}
}

// stopFollowers 는 세션이 끝날 때 구독을 모두 끊는다. 남겨 두면 죽은 세션의 콜백이 계속 앱으로
// 올라간다.
func (f *outputFan) stopFollowers() {
	f.mu.Lock()
	followers := make([]*ringbuf.Follower, 0, len(f.followers))
	for id, follower := range f.followers {
		followers = append(followers, follower)
		delete(f.followers, id)
	}
	f.mu.Unlock()
	for _, follower := range followers {
		follower.Stop()
	}
}
