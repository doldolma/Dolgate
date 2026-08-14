package sshconn

import (
	"context"
	"encoding/base64"
	"fmt"
	"net"
	"testing"

	"golang.org/x/crypto/ssh"
)

// otpJumpServer 는 OTP 베스천을 흉내낸다: password 방식은 제시하지 않고, keyboard-interactive 로
// 1 라운드 비밀번호 → 2 라운드 인증 코드를 묻는다.
type otpJumpServer struct {
	*jumpTestServer
}

func newOtpJumpServer(t *testing.T, username, password, code, banner string) *otpJumpServer {
	t.Helper()

	hostSigner, _ := generateTestKeyPair(t)
	config := &ssh.ServerConfig{
		KeyboardInteractiveCallback: func(
			conn ssh.ConnMetadata,
			challenge ssh.KeyboardInteractiveChallenge,
		) (*ssh.Permissions, error) {
			if conn.User() != username {
				return nil, fmt.Errorf("unknown user")
			}
			answers, err := challenge("", "", []string{"Password:"}, []bool{false})
			if err != nil {
				return nil, err
			}
			if len(answers) != 1 || answers[0] != password {
				return nil, fmt.Errorf("bad password")
			}
			answers, err = challenge("", "", []string{"Verification code:"}, []bool{false})
			if err != nil {
				return nil, err
			}
			if len(answers) != 1 || answers[0] != code {
				return nil, fmt.Errorf("bad code")
			}
			return nil, nil
		},
	}
	config.AddHostKey(hostSigner)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &otpJumpServer{jumpTestServer: &jumpTestServer{
		listener:      listener,
		hostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
		banner:        banner,
		connClosed:    make(chan struct{}, 4),
	}}
	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			go server.handle(raw, config)
		}
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return server
}

// 호스트 키 프로브는 점프 호스트의 대화형 인증을 통과할 수 있어야 한다.
//
// 실기기에서 OTP 베스천을 점프로 지정하면 프로브가 "keyboard-interactive responder is not
// configured" 로 끝났다 — 프로브는 요청·응답 한 번짜리라 사용자에게 물을 창구가 아예 없었다.
// 그러면 그 베스천 뒤의 호스트는 신뢰(TOFU)를 시작할 수조차 없다.
func TestProbeHostKeyAsksThroughAnInteractiveJump(t *testing.T) {
	target := newJumpTestServer(t, "tuser", "tpw", "TARGET-OK")
	bastion := newOtpJumpServer(t, "buser", "bpw", "123456", "BASTION-OK")

	jumpTarget := bastion.target("buser", "")
	// 베스천에 저장된 비밀번호가 있다 — 1 라운드는 자동으로 답해야 한다.
	jumpTarget.Password = "bpw"

	asked := make([]string, 0, 1)
	config := DefaultConfig
	config.InteractiveResponder = func(challenge InteractiveChallenge) ([]string, error) {
		if len(challenge.Prompts) != 1 {
			return nil, fmt.Errorf("prompts = %d, want 1", len(challenge.Prompts))
		}
		asked = append(asked, challenge.Prompts[0].Label)
		return []string{"123456"}, nil
	}

	result, err := ProbeHostKey(
		context.Background(),
		"127.0.0.1",
		target.port(),
		&jumpTarget,
		nil,
		config,
	)
	if err != nil {
		t.Fatalf("ProbeHostKey through an interactive jump: %v", err)
	}
	if result.PublicKeyBase64 != target.hostKeyBase64 {
		t.Errorf("probed key = %q, want the target's key", result.PublicKeyBase64)
	}

	// 비밀번호는 자동으로, 인증 코드만 사용자에게 물어야 한다.
	if len(asked) != 1 || asked[0] != "Verification code:" {
		t.Errorf("사용자에게 물은 프롬프트 = %v, want [Verification code:]", asked)
	}
}

// 창구가 없으면 예전처럼 그 자리에서 실패한다 — 보여줄 곳이 없는데 기다리면 그냥 정지다.
func TestProbeHostKeyWithoutResponderFailsFast(t *testing.T) {
	target := newJumpTestServer(t, "tuser", "tpw", "TARGET-OK")
	bastion := newOtpJumpServer(t, "buser", "bpw", "123456", "BASTION-OK")

	jumpTarget := bastion.target("buser", "")
	jumpTarget.Password = "bpw"

	_, err := ProbeHostKey(
		context.Background(),
		"127.0.0.1",
		target.port(),
		&jumpTarget,
		nil,
		DefaultConfig,
	)
	if err == nil {
		t.Fatal("창구 없이도 통과했다")
	}
}
