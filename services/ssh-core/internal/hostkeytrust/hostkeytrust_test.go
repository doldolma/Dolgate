package hostkeytrust

import (
	"context"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/pkg/coretypes"
)

func request() sshconn.HostKeyTrustRequest {
	return sshconn.HostKeyTrustRequest{
		Hop:               sshconn.InteractiveHop{Username: "ubuntu", Host: "192.168.200.4", Port: 2733},
		Algorithm:         "ecdsa-sha2-nistp256",
		FingerprintSHA256: "SHA256:test",
		PublicKeyBase64:   "AAAATEST",
	}
}

// 물음이 화면으로 올라가고, 답이 그 물음으로 돌아와야 한다.
func TestPromptAsksAndReceivesTheAnswer(t *testing.T) {
	registry := New()
	events := make(chan coretypes.Event, 4)
	prompt := registry.Prompt(
		context.Background(),
		func(event coretypes.Event) { events <- event },
		Correlation{RequestID: "req-1", SessionID: "session-1"},
	)

	answered := make(chan bool, 1)
	go func() {
		trust, err := prompt(request())
		if err != nil {
			t.Errorf("prompt() error = %v", err)
		}
		answered <- trust
	}()

	var challenge coretypes.HostKeyTrustChallengePayload
	select {
	case event := <-events:
		if event.Type != coretypes.EventHostKeyTrustChallenge {
			t.Fatalf("event type = %s", event.Type)
		}
		if event.SessionID != "session-1" || event.RequestID != "req-1" {
			t.Errorf("상관 ID = %q/%q, want req-1/session-1", event.RequestID, event.SessionID)
		}
		body, ok := event.Payload.(coretypes.HostKeyTrustChallengePayload)
		if !ok {
			t.Fatalf("payload type = %T", event.Payload)
		}
		challenge = body
	case <-time.After(2 * time.Second):
		t.Fatal("물음이 올라오지 않았다")
	}

	// 화면이 대화상자를 그리는 데 필요한 값이 모두 실려야 한다.
	if challenge.Hop == nil || challenge.Hop.Host != "192.168.200.4" {
		t.Errorf("hop = %+v", challenge.Hop)
	}
	if challenge.FingerprintSHA256 == "" || challenge.PublicKeyBase64 == "" || challenge.Algorithm == "" {
		t.Errorf("빈 값이 있다: %+v", challenge)
	}

	if err := registry.Respond(challenge.ChallengeID, true); err != nil {
		t.Fatalf("Respond() error = %v", err)
	}
	select {
	case trust := <-answered:
		if !trust {
			t.Fatal("수락했는데 거절로 왔다")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("답이 물음에 닿지 않았다")
	}

	if pending := registry.Pending(); pending != 0 {
		t.Fatalf("남은 물음 = %d, want 0", pending)
	}
}

// 취소(탭 닫기·정지)가 대기를 풀어야 한다. 채널만 보고 있으면 아무도 답하지 않는 연결이 남는다.
func TestPromptUnblocksOnCancel(t *testing.T) {
	registry := New()
	ctx, cancel := context.WithCancel(context.Background())
	prompt := registry.Prompt(ctx, func(coretypes.Event) {}, Correlation{})

	done := make(chan error, 1)
	go func() {
		_, err := prompt(request())
		done <- err
	}()

	for attempt := 0; attempt < 200 && registry.Pending() == 0; attempt += 1 {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("취소했는데 오류 없이 끝났다")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("취소가 대기를 풀지 못했다")
	}
}

func TestRespondToUnknownChallengeIsAnError(t *testing.T) {
	registry := New()
	if err := registry.Respond("hostkey-trust-999", true); err == nil {
		t.Fatal("없는 물음인데 성공했다")
	}
}

// 창구(emit)가 없으면 질의 함수를 만들지 않는다 — 보여줄 곳이 없는데 기다리면 그냥 정지다.
func TestPromptWithoutEmitterIsNil(t *testing.T) {
	if New().Prompt(context.Background(), nil, Correlation{}) != nil {
		t.Fatal("창구가 없는데 질의 함수를 만들었다")
	}
}
