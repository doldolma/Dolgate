package ssmdatachannel

import "testing"

// 번호가 거꾸로 들어와도 **Oldest() 는 가장 낮은 미확인 번호**여야 한다.
//
// 발신 쪽은 번호를 먼저 매기고 버퍼 자리를 기다리므로, 대기하던 writer 가 추월당하면 큰 번호가
// 먼저 들어온다. 삽입 순서를 그대로 쓰면 재전송이 엉뚱한 메시지를 붙들고, 에이전트가 기다리는
// 번호는 영원히 다시 나가지 않는다.
func TestOldestFollowsSequenceNotInsertionOrder(t *testing.T) {
	buf := NewMessageBuffer(4)
	for _, seq := range []int64{7, 5, 6} {
		msg := NewAgentMessage()
		msg.MessageType = InputStreamData
		msg.Flags = Data
		msg.PayloadType = Output
		msg.SequenceNumber = seq
		msg.Payload = []byte("x")
		if err := buf.Add(msg); err != nil {
			t.Fatalf("Add %d: %v", seq, err)
		}
	}

	for _, want := range []int64{5, 6, 7} {
		oldest := buf.Oldest()
		if oldest == nil {
			t.Fatalf("Oldest() = nil, want %d", want)
		}
		if oldest.SequenceNumber != want {
			t.Fatalf("Oldest() = %d, want %d", oldest.SequenceNumber, want)
		}
		buf.Remove(want)
	}
}
