package ssmdatachannel

import (
	"container/list"
	"errors"
	"sync"
)

var ErrBufferFull = errors.New("buffer full")

type MessageBuffer interface {
	Len() int
	Add(msg *AgentMessage) error
	Remove(seqNum int64)
	Get(seqNum int64) *AgentMessage
	Oldest() *AgentMessage
	Next() *AgentMessage
}

type messageBuffer struct {
	mu     sync.RWMutex
	size   int
	buf    *list.List
	seqMap map[int64]*list.Element
	cursor *list.Element
}

func (m *messageBuffer) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()

	return m.buf.Len()
}

func (m *messageBuffer) Add(msg *AgentMessage) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if existing := m.seqMap[msg.SequenceNumber]; existing != nil {
		existing.Value = msg
		return nil
	}
	if m.buf.Len() == m.size {
		return ErrBufferFull
	}

	// **시퀀스 순서를 유지한다.** Oldest() 는 목록의 front 를 돌려주고, 재전송은 그것을 "가장 낮은
	// 미확인 번호" 로 믿는다. 그런데 발신 쪽은 번호를 먼저 매기고 버퍼 자리가 없으면 기다리므로,
	// 대기하던 writer 가 추월당하면 큰 번호가 먼저 들어올 수 있다. 그 상태로 두면 에이전트가
	// 기다리는 번호가 아닌 것만 계속 재전송하다가 시도 한계에 걸려 채널이 닫힌다.
	//
	// 뒤에서부터 넣을 자리를 찾는다 — 정상 경로는 비교 한 번으로 끝난다(번호가 늘 커진다).
	el := m.insertOrderedLocked(msg)
	m.seqMap[msg.SequenceNumber] = el

	return nil
}

func (m *messageBuffer) insertOrderedLocked(msg *AgentMessage) *list.Element {
	for el := m.buf.Back(); el != nil; el = el.Prev() {
		if el.Value.(*AgentMessage).SequenceNumber <= msg.SequenceNumber {
			return m.buf.InsertAfter(msg, el)
		}
	}
	return m.buf.PushFront(msg)
}

func (m *messageBuffer) Remove(seqNum int64) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if v, ok := m.seqMap[seqNum]; ok {
		if v != nil {
			if v == m.cursor {
				m.cursor = v.Prev()
			}
			m.buf.Remove(v)
		}
		delete(m.seqMap, seqNum)
	}
}

func (m *messageBuffer) Get(seqNum int64) *AgentMessage {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if v, ok := m.seqMap[seqNum]; ok {
		if v != nil {
			return v.Value.(*AgentMessage)
		}
	}
	return nil
}

func (m *messageBuffer) Oldest() *AgentMessage {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if el := m.buf.Front(); el != nil {
		return el.Value.(*AgentMessage)
	}
	return nil
}

func (m *messageBuffer) Next() *AgentMessage {
	m.mu.Lock()
	defer m.mu.Unlock()

	var el *list.Element
	if m.cursor == nil {
		el = m.buf.Front()
	} else {
		el = m.cursor.Next()
	}
	m.cursor = el

	if el != nil {
		return el.Value.(*AgentMessage)
	}
	return nil
}

func NewMessageBuffer(size int) *messageBuffer {
	mb := new(messageBuffer)
	mb.size = size
	mb.buf = list.New()
	mb.seqMap = make(map[int64]*list.Element)

	return mb
}
