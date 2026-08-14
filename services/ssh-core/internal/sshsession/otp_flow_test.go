package sshsession_test

import (
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/sshsession"
)

// OTP 서버에 붙을 때 사용자에게 물어야 하는 것은 인증 코드 하나뿐이다.
//
// 실기기에서 세 가지가 어긋났다: 저장해 둔 비밀번호가 있는데도 비밀번호 창이 떴고, 인증 코드 칸에
// "저장된 비밀번호 사용" 버튼이 붙었고, 코드를 넣은 뒤 입력칸 없는 창이 한 번 더 떠서 확인을
// 눌러야 로그인이 끝났다(서버가 보낸 프롬프트 0 개 라운드).
func TestOtpFlowAsksOnlyForTheVerificationCode(t *testing.T) {
	serverFailures := make(chan error, 4)
	server, _, cleanup := newSSHTestServer(t,
		withOtpKeyboardInteractive("s3cret", "123456", serverFailures),
	)
	defer cleanup()

	events := make(chan protocol.Event, 32)
	manager := sshsession.NewManager(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, _ []byte) {})

	connectDone := make(chan error, 1)
	go func() {
		connectDone <- manager.Connect("session-1", "req-1", protocol.ConnectPayload{
			Host:                 "127.0.0.1",
			Port:                 server.port(),
			Username:             "tester",
			AuthType:             "password",
			Password:             "s3cret",
			TrustedHostKeyBase64: server.hostKeyBase64,
			Cols:                 80,
			Rows:                 24,
		})
	}()

	// 화면에 올라오는 챌린지는 인증 코드 하나여야 한다.
	challengeEvent := waitForEvent(t, events, protocol.EventKeyboardInteractiveChallenge)
	challenge, ok := challengeEvent.Payload.(protocol.KeyboardInteractiveChallengePayload)
	if !ok {
		t.Fatalf("payload type = %T, want KeyboardInteractiveChallengePayload", challengeEvent.Payload)
	}
	if len(challenge.Prompts) != 1 {
		t.Fatalf("prompts = %+v, want exactly the verification code", challenge.Prompts)
	}
	if challenge.Prompts[0].Label != "Verification code:" {
		t.Fatalf("label = %q — 비밀번호 라운드가 화면까지 올라왔다", challenge.Prompts[0].Label)
	}
	// 코드 칸에 비밀번호를 넣을 수단을 주면 안 된다. 그 시도로 연결이 끝난다.
	if challenge.Prompts[0].AllowStoredPassword {
		t.Error("인증 코드 칸에 저장된 비밀번호를 내밀었다")
	}
	// 일회용 코드는 가리지 않는다. 서버는 echo 를 끄고 보내지만, 그것까지 가리면 사용자가 여섯
	// 자리를 확인하지 못한 채 보내야 한다.
	if challenge.Prompts[0].Masked {
		t.Error("인증 코드 칸을 가렸다")
	}

	if err := manager.RespondKeyboardInteractive("session-1", protocol.KeyboardInteractiveRespondPayload{
		ChallengeID: challenge.ChallengeID,
		Responses:   []string{"123456"},
	}); err != nil {
		t.Fatalf("respond failed: %v", err)
	}

	select {
	case err := <-connectDone:
		if err != nil {
			t.Fatalf("connect failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("연결이 끝나지 않았다 — 프롬프트 0 개 라운드에서 사람을 기다리는 중일 수 있다")
	}

	select {
	case err := <-serverFailures:
		t.Fatalf("서버가 받은 응답이 어긋났다: %v", err)
	default:
	}

	// 프롬프트 0 개 라운드가 또 창을 띄우지 않았는지 확인한다.
	for {
		select {
		case event := <-events:
			if event.Type == protocol.EventKeyboardInteractiveChallenge {
				t.Fatal("두 번째 챌린지 창이 떴다 — 알림 라운드를 사람에게 물었다")
			}
		default:
			manager.Disconnect("session-1")
			return
		}
	}
}
