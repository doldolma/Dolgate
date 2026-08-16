package sshsession

import (
	"net"
	"strconv"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

// 붙는 중에 세션을 닫으면 즉시 끝나야 한다.
//
// 포워딩 쪽과 같은 이유다(forwarding.TestStopEndsAConnectThatIsStillDialing). 응답하지 않는 서버로
// 붙는 동안 탭을 닫으면 dial·핸드셰이크가 ctx 취소로 끊겨야 한다 — 사람의 답을 기다리는 구간만
// 대기표를 닫아 풀 수 있고, 기계를 기다리는 구간은 그렇지 않다.
func TestDisconnectEndsAConnectThatIsStillDialing(t *testing.T) {
	// TCP 는 받아 주지만 SSH 로는 한 마디도 하지 않는 서버.
	silent, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	defer silent.Close()
	go func() {
		for {
			conn, err := silent.Accept()
			if err != nil {
				return
			}
			defer conn.Close()
		}
	}()
	_, portText, _ := net.SplitHostPort(silent.Addr().String())
	port, _ := strconv.Atoi(portText)

	manager := NewManager(func(protocol.Event) {}, func(protocol.StreamFrame, []byte) {})
	done := make(chan error, 1)
	go func() {
		done <- manager.Connect("session-1", "req-1", protocol.ConnectPayload{
			Host:                 "127.0.0.1",
			Port:                 port,
			Username:             "ubuntu",
			AuthType:             "password",
			Password:             "pw",
			TrustedHostKeyBase64: "AAAATEST",
			Cols:                 120,
			Rows:                 32,
		})
	}()

	for attempt := 0; attempt < 200 && !manager.dialer.IsConnecting("session-1"); attempt += 1 {
		time.Sleep(5 * time.Millisecond)
	}
	if !manager.dialer.IsConnecting("session-1") {
		t.Fatal("연결이 시작되지 않았다")
	}
	if err := manager.Disconnect("session-1"); err != nil {
		t.Fatalf("Disconnect() error = %v", err)
	}

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("닫았는데 연결이 성공으로 끝났다")
		}
	case <-time.After(3 * time.Second):
		// 핸드셰이크 정지 감시(10초)보다 훨씬 빨리 끝나야 한다.
		t.Fatal("종료가 붙는 중인 연결을 끊지 못했다")
	}
}
