package ssmdatachannel

import (
	"encoding/binary"
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

// 처리하지 못하는 액션은 이름과 함께 Unsupported 로 답해야 한다. 빈 항목을 보내면 에이전트가
// 무효한 응답으로 보고 끊는데, 어느 액션이 문제였는지 아무 데도 남지 않는다.
func TestHandshakeResponseMarksUnhandledActionsUnsupported(t *testing.T) {
	c := new(SsmDataChannel)
	res := c.buildHandshakeResponse([]RequestedClientAction{
		{ActionType: SessionType},
		{ActionType: ActionType("SomethingNew")},
	})

	if len(res.ProcessedClientActions) != 2 {
		t.Fatalf("요청 하나당 응답 하나여야 한다: %d", len(res.ProcessedClientActions))
	}

	session := res.ProcessedClientActions[0]
	if session.ActionType != SessionType || session.ActionStatus != Success {
		t.Errorf("SessionType = (%q, %d), want (%q, %d)",
			session.ActionType, session.ActionStatus, SessionType, Success)
	}

	unknown := res.ProcessedClientActions[1]
	// 액션 이름을 함께 되돌려줘야 에이전트 쪽 오류에 무엇이 거부됐는지 남는다.
	if unknown.ActionType != ActionType("SomethingNew") || unknown.ActionStatus != Unsupported {
		t.Errorf("unknown action = (%q, %d), want Unsupported", unknown.ActionType, unknown.ActionStatus)
	}
}

// 데이터 키 자료가 있으면 KMS 암호화를 받아들이고 암호문 blob 을 되돌려줘야 한다. 이게 안 되면
// 세션 암호화를 켠 계정에서 SSM 셸이 아예 열리지 않는다.
func TestHandshakeResponseAcceptsKMSEncryptionWithDataKey(t *testing.T) {
	c := new(SsmDataChannel)
	c.SetSessionEncryption(SessionEncryption{
		KMSKeyID:       "arn:aws:kms:ap-northeast-2:1234:key/abc",
		CipherTextBlob: []byte("blob"),
		PlainTextKey:   make([]byte, 64),
	})

	res := c.buildHandshakeResponse([]RequestedClientAction{{
		ActionType:       KMSEncryption,
		ActionParameters: map[string]string{"KMSKeyId": "arn:aws:kms:ap-northeast-2:1234:key/abc"},
	}})

	action := res.ProcessedClientActions[0]
	if action.ActionStatus != Success {
		t.Fatalf("KMSEncryption = %d (%s), want Success", action.ActionStatus, action.Error)
	}
	// 필드 이름이 에이전트 계약과 같아야 한다. 틀리면 에이전트가 빈 값으로 읽고 kms:Decrypt 가
	// 실패해 세션이 "closed" 로만 끊긴다(우리 쪽에는 오류가 안 남는다).
	var wire map[string]any
	if err := json.Unmarshal(action.ActionResult, &wire); err != nil {
		t.Fatalf("결과 디코딩: %v", err)
	}
	if _, ok := wire["KMSCipherTextKey"]; !ok {
		t.Fatalf("KMSCipherTextKey 가 없다: %v", wire)
	}
	// 챌린지를 컨텍스트에 넣지 않은 키이므로 false 로 답해야 한다 — true 면 에이전트가 컨텍스트에
	// 챌린지를 넣어 복호화하다 실패한다.
	if wire["ChallengeAcknowledgement"] != false {
		t.Errorf("ChallengeAcknowledgement = %v, want false", wire["ChallengeAcknowledgement"])
	}

	var result KMSEncryptionResponse
	if err := json.Unmarshal(action.ActionResult, &result); err != nil {
		t.Fatalf("결과 디코딩: %v", err)
	}
	if string(result.KMSCipherTextKey) != "blob" {
		t.Errorf("key = %q, want %q", result.KMSCipherTextKey, "blob")
	}
	// 이 시점부터 스트림 payload 가 암호화된다.
	if c.sessionEncryption() == nil {
		t.Error("KMS 액션을 받아들였으면 암호화가 켜져 있어야 한다")
	}
}

// 자료가 없으면 Failed 로 답해야 한다. Success 로 거짓 답하면 에이전트는 암호화를 켜고 우리는
// 평문을 보내서, 붙은 뒤에 화면만 깨진다.
func TestHandshakeResponseFailsKMSEncryptionWithoutDataKey(t *testing.T) {
	c := new(SsmDataChannel)
	res := c.buildHandshakeResponse([]RequestedClientAction{{
		ActionType:       KMSEncryption,
		ActionParameters: map[string]string{"KMSKeyId": "key-1"},
	}})

	action := res.ProcessedClientActions[0]
	if action.ActionStatus != Failed {
		t.Fatalf("KMSEncryption = %d, want Failed", action.ActionStatus)
	}
	if action.Error == "" {
		t.Error("실패 이유가 있어야 에이전트 로그에 남는다")
	}
	if c.sessionEncryption() != nil {
		t.Error("실패했으면 암호화를 켜면 안 된다")
	}
}

// 에이전트가 요구하는 키와 다른 키로 만든 자료면 거부해야 한다. 에이전트가 우리 blob 을 복호화하지
// 못하므로, 통과시키면 "붙었는데 화면이 깨지는" 상태가 된다.
func TestHandshakeResponseRejectsMismatchedKMSKey(t *testing.T) {
	c := new(SsmDataChannel)
	c.SetSessionEncryption(SessionEncryption{
		KMSKeyID:     "key-a",
		PlainTextKey: make([]byte, 64),
	})

	res := c.buildHandshakeResponse([]RequestedClientAction{{
		ActionType:       KMSEncryption,
		ActionParameters: map[string]string{"KMSKeyId": "key-b"},
	}})

	if res.ProcessedClientActions[0].ActionStatus != Failed {
		t.Fatal("키가 다르면 Failed 여야 한다")
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

// 협상 응답은 우리 outbound 시퀀스를 따라야 한다.
//
// 셸 세션은 협상 전에 SetTerminalSize 로 0번을 이미 쓴다. 응답이 상대 시퀀스를 미러링해 0번으로
// 다시 나가면 에이전트가 "이미 처리한 메시지"로 보고 페이로드를 버려서(그 판단은 에이전트 로그에
// Debug 로만 남는다) 15초 뒤 협상이 시간 초과된다 — KMS 암호화를 켠 셸이 전부 이 경로로 죽었다.
func TestHandshakeResponseUsesOwnSequenceNumber(t *testing.T) {
	type sent struct {
		payloadType PayloadType
		seq         int64
	}
	seen := make(chan sent, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer ws.Close()
		if _, _, err := ws.ReadMessage(); err != nil { // channel-open JSON
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
			if msg.MessageType != InputStreamData {
				continue
			}
			select {
			case seen <- sent{payloadType: msg.PayloadType, seq: msg.SequenceNumber}:
			default:
			}
		}
	}))
	defer srv.Close()

	dc := new(SsmDataChannel)
	if err := dc.OpenWithSessionToken("ws"+strings.TrimPrefix(srv.URL, "http"), "test-token"); err != nil {
		t.Fatalf("OpenWithSessionToken: %v", err)
	}
	defer dc.Close()

	// 셸이 실제로 하는 순서다: 크기를 먼저 보내고 나서 협상을 받는다.
	if err := dc.SetTerminalSize(24, 80); err != nil {
		t.Fatalf("SetTerminalSize: %v", err)
	}

	reqPayload, err := json.Marshal(HandshakeRequestPayload{
		AgentVersion:           "3.3.4851.0",
		RequestedClientActions: []RequestedClientAction{{ActionType: SessionType}},
	})
	if err != nil {
		t.Fatalf("marshal handshake request: %v", err)
	}
	req := NewAgentMessage()
	req.MessageType = OutputStreamData
	req.Flags = Data
	req.PayloadType = HandshakeRequest
	req.SequenceNumber = 0
	req.Payload = reqPayload
	data, err := req.MarshalBinary()
	if err != nil {
		t.Fatalf("marshal handshake message: %v", err)
	}
	if _, err := dc.HandleMsg(data); err != nil {
		t.Fatalf("HandleMsg handshake request: %v", err)
	}

	deadline := time.After(3 * time.Second)
	for {
		select {
		case msg := <-seen:
			switch msg.payloadType {
			case Size:
				if msg.seq != 0 {
					t.Fatalf("크기 메시지 시퀀스 = %d, want 0", msg.seq)
				}
			case HandshakeResponse:
				// 0 이면 크기 메시지와 겹쳐 에이전트가 버린다.
				if msg.seq != 1 {
					t.Fatalf("협상 응답 시퀀스 = %d, want 1 (크기 메시지가 0 을 썼다)", msg.seq)
				}
				return
			}
		case <-deadline:
			t.Fatal("협상 응답이 나가지 않았다")
		}
	}
}

// StdErr 는 화면에 나와야 하고, 모르는 페이로드 종류는 세션을 끊어선 안 된다.
//
// 전에는 default 분기가 곧바로 오류였다. 우리가 광고하는 클라이언트 버전은 "출력 분리를
// 이해한다"는 선언이라 에이전트가 StdErr·ExitCode 를 보낼 수 있고, 그러면 붙어 있던 세션이
// 이유 없이 죽었다.
func TestUnknownAndSeparatedOutputPayloadsDoNotKillTheSession(t *testing.T) {
	feed := func(t *testing.T, payloadType PayloadType, body []byte) ([]byte, error) {
		t.Helper()
		dc := &SsmDataChannel{outMsgBuf: NewMessageBuffer(4)}
		dc.bufferCond = sync.NewCond(&dc.mu)
		msg := NewAgentMessage()
		msg.MessageType = OutputStreamData
		msg.Flags = Data
		msg.PayloadType = payloadType
		msg.SequenceNumber = 0
		msg.Payload = body
		return dc.processOutputStreamMessage(msg, false)
	}

	payload, err := feed(t, StdErr, []byte("permission denied\r\n"))
	if err != nil {
		t.Fatalf("StdErr: %v", err)
	}
	if string(payload) != "permission denied\r\n" {
		t.Errorf("StdErr 은 그대로 화면에 나가야 한다: %q", payload)
	}

	payload, err = feed(t, ExitCode, []byte("1"))
	if err != nil {
		t.Fatalf("ExitCode: %v", err)
	}
	if len(payload) != 0 {
		t.Errorf("종료 코드는 화면에 뿌리지 않는다: %q", payload)
	}

	payload, err = feed(t, PayloadType(99), []byte("from a newer agent"))
	if err != nil {
		t.Fatalf("모르는 종류로 세션을 끊으면 안 된다: %v", err)
	}
	if len(payload) != 0 {
		t.Errorf("모르는 종류는 흘려보내지 않는다: %q", payload)
	}
}

// 에이전트 메시지에 대한 ack 가 먼저 나가도 **첫 스트림 메시지가 Syn·0번을 가져야 한다.**
//
// ack 는 상대 시퀀스를 미러링하는 메시지라 스트림을 열 수 없다. ack 가 Syn 을 가져가 버리면
// 정작 입력이 Syn 없이 1번으로 나가고, 에이전트는 0번으로 시작하는 스트림을 기다리며 입력을
// 전부 쌓아 두기만 한다 — 출력은 멀쩡하고 오류도 없어서 "타이핑이 그냥 안 되는" 것으로 보인다.
// 실기기에서 모바일 SSM 셸이 이 경합에 계속 졌다(에이전트의 첫 메시지가 우리 첫 쓰기보다 빨랐다).
func TestAckDoesNotConsumeTheStreamOpener(t *testing.T) {
	type sent struct {
		messageType MessageType
		flags       AgentMessageFlag
		seq         int64
	}
	seen := make(chan sent, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer ws.Close()
		if _, _, err := ws.ReadMessage(); err != nil { // channel-open JSON
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
			select {
			case seen <- sent{messageType: msg.MessageType, flags: msg.Flags, seq: msg.SequenceNumber}:
			default:
			}
		}
	}))
	defer srv.Close()

	dc := new(SsmDataChannel)
	if err := dc.OpenWithSessionToken("ws"+strings.TrimPrefix(srv.URL, "http"), "test-token"); err != nil {
		t.Fatalf("OpenWithSessionToken: %v", err)
	}
	defer dc.Close()

	// 에이전트가 먼저 말한다(셸 배너). 우리는 여기에 ack 를 보낸다 — 그것이 첫 발신 메시지다.
	banner := NewAgentMessage()
	banner.MessageType = OutputStreamData
	banner.Flags = Data
	banner.PayloadType = Output
	banner.SequenceNumber = 0
	banner.Payload = []byte("PS C:\\> ")
	data, err := banner.MarshalBinary()
	if err != nil {
		t.Fatalf("marshal banner: %v", err)
	}
	if _, err := dc.HandleMsg(data); err != nil {
		t.Fatalf("HandleMsg banner: %v", err)
	}

	// 그 다음에 사용자가 타이핑한다.
	if _, err := dc.Write([]byte{0x03}); err != nil {
		t.Fatalf("Write: %v", err)
	}

	deadline := time.After(3 * time.Second)
	for {
		select {
		case msg := <-seen:
			switch msg.messageType {
			case Acknowledge:
				if msg.flags != Ack {
					t.Fatalf("ack flags=%d, want Ack(%d)", msg.flags, Ack)
				}
			case InputStreamData:
				// 공식 클라이언트와 같다: 스트림 데이터는 0번부터, 플래그는 Data 고정.
				if msg.flags != Data || msg.seq != 0 {
					t.Fatalf("첫 입력 flags=%d seq=%d, want flags=Data(%d) seq=0", msg.flags, msg.seq, Data)
				}
				return
			}
		case <-deadline:
			t.Fatal("입력이 나가지 않았다")
		}
	}
}

// 프레임이 거짓 길이를 신고해도 **패닉하지 않고 오류로 거절해야 한다.**
//
// 오프셋 계산이 전부 프레임이 신고한 headerLength·payloadLength 를 그대로 쓰므로, 검사 없이
// 슬라이싱하면 `slice bounds out of range` 로 프로세스가 죽는다. 세션 하나가 아니라 프로세스다 —
// 모바일은 앱이, 데스크톱은 코어가, sync-api 는 모든 사용자의 세션을 안고 있는 서버가 같이 죽는다.
func TestUnmarshalRejectsLyingFrameLengths(t *testing.T) {
	good := NewAgentMessage()
	good.MessageType = OutputStreamData
	good.Flags = Data
	good.PayloadType = Output
	good.Payload = []byte("hello")
	frame, err := good.MarshalBinary()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	withPatch := func(patch func(buf []byte)) []byte {
		buf := make([]byte, len(frame))
		copy(buf, frame)
		patch(buf)
		return buf
	}

	cases := map[string][]byte{
		"payloadLength 를 크게 신고": withPatch(func(buf []byte) {
			binary.BigEndian.PutUint32(buf[agentMsgHeaderLen:], 0xffff)
		}),
		"payloadLength 를 최대값으로 신고": withPatch(func(buf []byte) {
			binary.BigEndian.PutUint32(buf[agentMsgHeaderLen:], 0xffffffff)
		}),
		"headerLength 를 크게 신고": withPatch(func(buf []byte) {
			binary.BigEndian.PutUint32(buf, 0xfffffffc)
		}),
		"headerLength 를 작게 신고": withPatch(func(buf []byte) {
			binary.BigEndian.PutUint32(buf, 8)
		}),
		"헤더보다 짧은 프레임": frame[:64],
	}

	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("패닉했다: %v", r)
				}
			}()
			if err := new(AgentMessage).UnmarshalBinary(data); err == nil {
				t.Fatal("거짓 길이를 통과시켰다")
			}
		})
	}

	// 멀쩡한 프레임은 그대로 통과해야 한다.
	parsed := new(AgentMessage)
	if err := parsed.UnmarshalBinary(frame); err != nil {
		t.Fatalf("정상 프레임을 거절했다: %v", err)
	}
	if string(parsed.Payload) != "hello" {
		t.Fatalf("payload = %q, want \"hello\"", parsed.Payload)
	}
}

// 크기 전송이 실패하면 **그 크기를 기억하지 않아야 한다.**
//
// 보내기 전에 기억하면 한 번 실패한 크기는 "이미 보냈다" 로 남아 다시 시도되지 않고, 원격 PTY
// 크기가 계속 어긋난 채로 굳는다.
func TestSetTerminalSizeForgetsFailedWrites(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer ws.Close()
		for {
			if _, _, err := ws.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	dc := new(SsmDataChannel)
	if err := dc.OpenWithSessionToken("ws"+strings.TrimPrefix(srv.URL, "http"), "test-token"); err != nil {
		t.Fatalf("OpenWithSessionToken: %v", err)
	}

	// 소켓을 닫아 쓰기를 실패시킨다.
	_ = dc.Close()
	if err := dc.SetTerminalSize(24, 80); err == nil {
		t.Fatal("닫힌 채널에서 크기 전송이 성공했다고 한다")
	}
	// 같은 크기를 다시 시도하면 또 오류여야 한다. nil 이 오면 "이미 보냈다" 로 건너뛴 것이다.
	if err := dc.SetTerminalSize(24, 80); err == nil {
		t.Fatal("실패한 크기를 보냈다고 기억해서 재시도를 건너뛴다")
	}
}

// 첫 발신이 TerminateSession 이어도 **Fin 플래그가 남아야 한다.**
//
// 플래그는 비트마스크가 아니라 열거형이라, 스트림을 여는 Syn 을 얹으면 종료 통보라는 뜻이 사라진다.
func TestFirstMessageKeepsNonDataFlag(t *testing.T) {
	seen := make(chan AgentMessageFlag, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer ws.Close()
		if _, _, err := ws.ReadMessage(); err != nil { // channel-open JSON
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
			select {
			case seen <- msg.Flags:
			default:
			}
		}
	}))
	defer srv.Close()

	dc := new(SsmDataChannel)
	if err := dc.OpenWithSessionToken("ws"+strings.TrimPrefix(srv.URL, "http"), "test-token"); err != nil {
		t.Fatalf("OpenWithSessionToken: %v", err)
	}
	defer dc.Close()

	if err := dc.TerminateSession(); err != nil {
		t.Fatalf("TerminateSession: %v", err)
	}
	select {
	case flags := <-seen:
		if flags != Fin {
			t.Fatalf("첫 발신 flags = %d, want Fin(%d)", flags, Fin)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("종료 메시지가 나가지 않았다")
	}
}

// 단독 LF 은 CR 로 바꿔 보낸다 — 공식 클라이언트와 같은 규칙이다.
//
// 윈도우 인스턴스의 winpty 셸은 LF 을 "다음 줄" 로만 보고 명령을 실행하지 않는다. 이걸 맞추지
// 않으면 \n 을 보내는 붙여넣기·스크립트가 윈도우 SSM 셸에서 아무 일도 하지 않는다.
func TestWriteConvertsLoneLineFeedToCarriageReturn(t *testing.T) {
	seen := make(chan []byte, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer ws.Close()
		if _, _, err := ws.ReadMessage(); err != nil { // channel-open JSON
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
				case seen <- msg.Payload:
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
	defer dc.Close()

	if _, err := dc.Write([]byte{'\n'}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	select {
	case payload := <-seen:
		if string(payload) != "\r" {
			t.Fatalf("payload = %q, want \"\\r\"", payload)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("입력이 나가지 않았다")
	}

	// 여러 바이트 안의 LF 은 건드리지 않는다(공식 구현도 단독 한 바이트만 바꾼다).
	if _, err := dc.Write([]byte("ls\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	select {
	case payload := <-seen:
		if string(payload) != "ls\n" {
			t.Fatalf("payload = %q, want \"ls\\n\"", payload)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("두 번째 입력이 나가지 않았다")
	}
}
