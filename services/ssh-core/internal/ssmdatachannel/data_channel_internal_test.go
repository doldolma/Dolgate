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
