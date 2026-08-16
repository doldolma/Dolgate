package sshconn

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"

	"golang.org/x/crypto/ssh"
)

var errWrongPassword = errors.New("wrong password")

// 저장된 비밀번호가 서버에서 이미 바뀐 경우, 사용자에게 물어야 한다.
//
// **회귀 시나리오.** 서버가 password 와 keyboard-interactive 를 둘 다 제시하면(PAM 을 쓰면 흔하다)
// x/crypto 는 password 를 먼저 시도한다. 저장된 값이 낡았으면 그것이 거절되고, 예전에는 이어지는
// keyboard-interactive 1 라운드에서 **같은 값을 한 번 더** 보냈다 — 남은 방식까지 소진돼 연결이
// 끝났고, 앱에 입력창이 있는데도 사용자는 아무것도 보지 못한 채 실패만 받았다.
//
// 이 테스트는 그 자리에서 사용자가 새 비밀번호를 넣어 연결이 성립하는지 본다.
func TestStalePasswordFallsBackToAskingTheUser(t *testing.T) {
	hostSigner, _ := generateTestKeyPair(t)

	const storedPassword = "old-password"
	const currentPassword = "new-password"

	config := &ssh.ServerConfig{
		// 두 방식을 모두 제시한다. 콜백이 있으면 x/crypto 서버가 그 방식을 광고한다.
		PasswordCallback: func(_ ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if string(pw) == currentPassword {
				return nil, nil
			}
			return nil, errWrongPassword
		},
		KeyboardInteractiveCallback: func(
			_ ssh.ConnMetadata,
			ask ssh.KeyboardInteractiveChallenge,
		) (*ssh.Permissions, error) {
			answers, err := ask("", "", []string{"Password:"}, []bool{false})
			if err != nil {
				return nil, err
			}
			if len(answers) != 1 || answers[0] != currentPassword {
				return nil, errWrongPassword
			}
			return nil, nil
		},
	}
	config.AddHostKey(hostSigner)
	host, port := startAuthTestServer(t, config)

	asked := 0
	client, err := DialClient(
		context.Background(),
		Target{
			Host:                 host,
			Port:                 port,
			Username:             "ubuntu",
			AuthType:             "password",
			Password:             storedPassword,
			TrustedHostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
		},
		Config{},
		func(challenge InteractiveChallenge) ([]string, error) {
			asked += 1
			// 저장된 값이 거절됐으니 여기로 와야 한다. 사용자가 새 비밀번호를 친다.
			return []string{currentPassword}, nil
		},
	)
	if err != nil {
		t.Fatalf("DialClient() error = %v", err)
	}
	defer client.Close()

	if asked != 1 {
		t.Fatalf("사용자에게 물은 횟수 = %d, want 1", asked)
	}
}

// 저장된 비밀번호가 맞으면 사용자를 붙잡지 않는다 — 이 기능이 노린 동작이 그대로 남아야 한다.
func TestCorrectStoredPasswordDoesNotAskTheUser(t *testing.T) {
	hostSigner, _ := generateTestKeyPair(t)

	const password = "s3cret"

	config := &ssh.ServerConfig{
		// keyboard-interactive 만 제시한다(PasswordCallback 없음) — 저장된 값의 첫 사용이다.
		KeyboardInteractiveCallback: func(
			_ ssh.ConnMetadata,
			ask ssh.KeyboardInteractiveChallenge,
		) (*ssh.Permissions, error) {
			answers, err := ask("", "", []string{"Password:"}, []bool{false})
			if err != nil {
				return nil, err
			}
			if len(answers) != 1 || answers[0] != password {
				return nil, errWrongPassword
			}
			return nil, nil
		},
	}
	config.AddHostKey(hostSigner)
	host, port := startAuthTestServer(t, config)

	client, err := DialClient(
		context.Background(),
		Target{
			Host:                 host,
			Port:                 port,
			Username:             "ubuntu",
			AuthType:             "password",
			Password:             password,
			TrustedHostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
		},
		Config{},
		func(InteractiveChallenge) ([]string, error) {
			t.Error("저장된 비밀번호가 맞는데 사용자에게 물었다")
			return nil, errWrongPassword
		},
	)
	if err != nil {
		t.Fatalf("DialClient() error = %v", err)
	}
	defer client.Close()
}
