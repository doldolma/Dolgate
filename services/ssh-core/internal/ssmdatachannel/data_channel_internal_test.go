package ssmdatachannel

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestAcknowledgeUsesPayloadSequenceNumber(t *testing.T) {
	dc := &SsmDataChannel{
		outMsgBuf: NewMessageBuffer(4),
	}
	dc.bufferCond = sync.NewCond(&dc.mu)

	tracked := NewAgentMessage()
	tracked.MessageType = InputStreamData
	tracked.Flags = Data
	tracked.PayloadType = Output
	tracked.SequenceNumber = 7
	tracked.Payload = []byte("tracked")
	if err := dc.outMsgBuf.Add(tracked); err != nil {
		t.Fatalf("Add tracked message: %v", err)
	}

	ackPayload, err := json.Marshal(map[string]any{
		"AcknowledgedMessageSequenceNumber": int64(7),
	})
	if err != nil {
		t.Fatalf("marshal ack payload: %v", err)
	}
	ack := NewAgentMessage()
	ack.MessageType = Acknowledge
	ack.Flags = Ack
	ack.PayloadType = Undefined
	ack.SequenceNumber = 99
	ack.Payload = ackPayload
	data, err := ack.MarshalBinary()
	if err != nil {
		t.Fatalf("marshal ack: %v", err)
	}

	if _, err := dc.HandleMsg(data); err != nil {
		t.Fatalf("HandleMsg ack: %v", err)
	}
	if got := dc.outMsgBuf.Get(7); got != nil {
		t.Fatalf("ack did not remove payload sequence 7; got %#v", got)
	}
}

func TestWriteBackpressuresWhenOutboundBufferIsFull(t *testing.T) {
	received := make(chan int64, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer ws.Close()
		if _, _, err := ws.ReadMessage(); err != nil { // channel-open JSON
			t.Errorf("read channel-open: %v", err)
			return
		}
		for {
			_, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			msg := new(AgentMessage)
			if err := msg.UnmarshalBinary(data); err != nil {
				t.Errorf("unmarshal: %v", err)
				return
			}
			if msg.MessageType == InputStreamData && msg.PayloadType == Output {
				select {
				case received <- msg.SequenceNumber:
				default:
				}
			}
		}
	}))
	defer srv.Close()

	dc := new(SsmDataChannel)
	if err := dc.OpenWithSessionToken("ws"+strings.TrimPrefix(srv.URL, "http"), "test-token"); err != nil {
		t.Fatalf("OpenWithSessionToken: %v", err)
	}
	dc.mu.Lock()
	dc.outMsgBuf = NewMessageBuffer(2)
	dc.mu.Unlock()

	writeDone := make(chan error, 1)
	go func() {
		for index := 0; index < 3; index++ {
			if _, err := dc.Write([]byte{byte('a' + index)}); err != nil {
				writeDone <- err
				return
			}
		}
		writeDone <- nil
	}()

	for index := 0; index < 2; index++ {
		select {
		case <-received:
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for write %d to reach fake agent", index)
		}
	}

	select {
	case err := <-writeDone:
		t.Fatalf("write completed with a full unacked buffer: %v", err)
	case <-time.After(150 * time.Millisecond):
	}

	_ = dc.Close()
	select {
	case err := <-writeDone:
		if !errors.Is(err, errDataChannelClosed) {
			t.Fatalf("blocked write error = %v, want errDataChannelClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not unblock writer waiting for outbound buffer space")
	}
}

func TestCloseStopsOutboundQueue(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer ws.Close()
		if _, _, err := ws.ReadMessage(); err != nil { // channel-open JSON
			t.Errorf("read channel-open: %v", err)
			return
		}
		<-release
	}))
	defer srv.Close()
	t.Cleanup(func() { close(release) })

	dc := new(SsmDataChannel)
	if err := dc.OpenWithSessionToken("ws"+strings.TrimPrefix(srv.URL, "http"), "test-token"); err != nil {
		t.Fatalf("OpenWithSessionToken: %v", err)
	}
	done := dc.outboundDone
	if done == nil {
		t.Fatal("outboundDone was not initialized")
	}
	if err := dc.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("outbound queue did not stop after Close")
	}
}

// 처리하지 못하는 핸드셰이크 액션은 Unsupported 로 답해야 한다. 빈 항목을 보내면 에이전트가
// 무효한 응답으로 보고 끊는데, 어느 액션이 문제였는지 아무 데도 남지 않는다 — KMS 세션 암호화를
// 켜 둔 계정에서 셸·포트 포워딩이 한꺼번에 실패할 때 원인을 찾을 수 없게 된다.
func TestHandshakeResponseMarksUnhandledActionsUnsupported(t *testing.T) {
	res := buildHandshakeResponse([]RequestedClientAction{
		{ActionType: SessionType},
		{ActionType: KMSEncryption},
	})

	if len(res.ProcessedClientActions) != 2 {
		t.Fatalf("요청 하나당 응답 하나여야 한다: %d", len(res.ProcessedClientActions))
	}

	session := res.ProcessedClientActions[0]
	if session.ActionType != SessionType || session.ActionStatus != Success {
		t.Errorf("SessionType = (%q, %d), want (%q, %d)",
			session.ActionType, session.ActionStatus, SessionType, Success)
	}

	kms := res.ProcessedClientActions[1]
	// 액션 이름을 함께 되돌려줘야 에이전트 쪽 오류에 무엇이 거부됐는지 남는다.
	if kms.ActionType != KMSEncryption || kms.ActionStatus != Unsupported {
		t.Errorf("KMSEncryption = (%q, %d), want (%q, %d)",
			kms.ActionType, kms.ActionStatus, KMSEncryption, Unsupported)
	}
}

// 거부한 액션이 있으면 오류로 올려야 한다. 응답만 보내고 조용히 넘기면 에이전트가 세션을 끊고,
// 앱에는 이유 없는 종료로 도착해 탭만 사라진다 — 무엇 때문인지 어디에도 남지 않는다.
func TestUnsupportedHandshakeErrorNamesTheCause(t *testing.T) {
	err := unsupportedHandshakeError([]ProcessedClientAction{
		{ActionType: SessionType, ActionStatus: Success},
		{ActionType: KMSEncryption, ActionStatus: Unsupported},
	})
	if err == nil {
		t.Fatal("거부한 액션이 있으면 오류여야 한다")
	}
	// 사용자가 스스로 풀 수 있는 설정이므로 그 설정을 문구에 담는다.
	if !strings.Contains(err.Error(), "KMS") {
		t.Errorf("KMS 를 언급해야 한다: %v", err)
	}

	if err := unsupportedHandshakeError([]ProcessedClientAction{
		{ActionType: SessionType, ActionStatus: Success},
	}); err != nil {
		t.Errorf("전부 처리했으면 오류가 없어야 한다: %v", err)
	}
}
