package sshconn

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// 사람이 OTP 코드를 늦게 넣어도 핸드셰이크가 살아 있어야 한다.
//
// 실기기 증상: 점프 호스트가 OTP 를 물어 인증 카드가 떴고, 사용자가 핸드폰을 찾아 코드를 넣는
// 동안(수십 초) 연결이 "시간 초과" 로 죽었다. 답을 보내는 버튼은 아무 반응이 없었다 — 그때
// 코어에는 이미 그 챌린지가 없었기 때문이다.
//
// 여기서 재는 것: 응답이 HandshakeStallTimeout 보다 오래 걸릴 때 DialClient 가 버티는지.
func TestSlowInteractiveAnswerKeepsTheHandshakeAlive(t *testing.T) {
	target := newJumpTestServer(t, "tuser", "tpw", "TARGET-OK")
	// 배너는 비운다. 배너가 있으면 Extend 가 한도를 5분으로 올려서 정지 감시를 재지 못한다.
	bastion := newOtpJumpServer(t, "buser", "bpw", "123456", "")

	jumpTarget := bastion.target("buser", "")
	jumpTarget.Password = "bpw"

	sshTarget := target.target("tuser", "tpw")
	sshTarget.Jump = &jumpTarget

	config := DefaultConfig
	// 사람의 대기를 짧게 흉내내기 위해 한도를 줄인다. 비율은 실기기와 같다(대기 > 한도).
	config.HandshakeStallTimeout = 300 * time.Millisecond
	config.Banner = nil

	answered := make(chan time.Duration, 1)
	responder := func(challenge InteractiveChallenge) ([]string, error) {
		started := time.Now()
		// 핸드폰을 찾는 시간.
		time.Sleep(config.HandshakeStallTimeout * 3)
		answered <- time.Since(started)
		return []string{"123456"}, nil
	}

	client, err := DialClient(context.Background(), sshTarget, config, responder)
	if err != nil {
		t.Fatalf("느린 응답으로 연결이 죽었다: %v", err)
	}
	defer client.Close()

	if banner := execBanner(t, client); banner != "TARGET-OK" {
		t.Errorf("landed on %q, want the target", banner)
	}
	select {
	case waited := <-answered:
		if waited < config.HandshakeStallTimeout {
			t.Fatalf("대기가 %v 로 한도(%v)보다 짧다 — 이 테스트는 아무것도 재지 않았다",
				waited, config.HandshakeStallTimeout)
		}
	default:
		t.Fatal("사용자에게 묻지 않았다 — 이 테스트는 아무것도 재지 않았다")
	}
	_ = fmt.Sprint()
}
