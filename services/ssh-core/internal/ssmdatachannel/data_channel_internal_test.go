package ssmdatachannel

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

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
