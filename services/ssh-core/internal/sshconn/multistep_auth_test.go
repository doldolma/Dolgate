package sshconn

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net"
	"strconv"
	"testing"

	"golang.org/x/crypto/ssh"
)

// startAuthTestServer는 주어진 ServerConfig로 in-process SSH 서버를 띄우고 접속 주소를 돌려준다.
// 인증 핸드셰이크만 검증하므로 채널은 모두 거절한다.
func startAuthTestServer(t *testing.T, config *ssh.ServerConfig) (host string, port int) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	go func() {
		raw, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		conn, chans, reqs, serverErr := ssh.NewServerConn(raw, config)
		if serverErr != nil {
			_ = raw.Close()
			return
		}
		defer conn.Close()
		go ssh.DiscardRequests(reqs)
		for newChannel := range chans {
			_ = newChannel.Reject(ssh.UnknownChannelType, "no channels needed for auth test")
		}
	}()

	_, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ = strconv.Atoi(portText)
	return "127.0.0.1", port
}

// TestDialClientMultiStepPublicKeyThenPassword는 `AuthenticationMethods publickey,password`처럼
// publickey 다음 password를 요구하는 다단계 인증에서, privateKey 호스트가 인터랙티브 비밀번호
// 프롬프트로 2차 요소를 충족해 연결되는지 검증한다.
func TestDialClientMultiStepPublicKeyThenPassword(t *testing.T) {
	hostSigner, _ := generateTestKeyPair(t)
	clientSigner, clientPEM := generateTestKeyPair(t)

	const wantPassword = "second-factor"

	config := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if !bytes.Equal(key.Marshal(), clientSigner.PublicKey().Marshal()) {
				return nil, fmt.Errorf("unexpected public key")
			}
			// 1차(publickey) 통과 — 이어서 password 메서드를 요구한다(부분 성공).
			return nil, &ssh.PartialSuccessError{
				Next: ssh.ServerAuthCallbacks{
					PasswordCallback: func(_ ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
						if string(pw) != wantPassword {
							return nil, fmt.Errorf("bad password")
						}
						return nil, nil
					},
				},
			}
		},
	}
	config.AddHostKey(hostSigner)
	host, port := startAuthTestServer(t, config)

	passwordPrompted := false
	client, err := DialClient(Target{
		Host:                 host,
		Port:                 port,
		Username:             "user",
		AuthType:             "privateKey",
		PrivateKeyPEM:        string(clientPEM),
		TrustedHostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
	}, DefaultConfig, func(challenge InteractiveChallenge) ([]string, error) {
		passwordPrompted = true
		responses := make([]string, len(challenge.Prompts))
		for index := range challenge.Prompts {
			responses[index] = wantPassword
		}
		return responses, nil
	})
	if err != nil {
		t.Fatalf("DialClient(publickey,password) failed: %v", err)
	}
	defer client.Close()

	if !passwordPrompted {
		t.Fatalf("expected the second-factor password prompt to be requested")
	}
}

// TestDialClientMultiStepPublicKeyThenKeyboardInteractive는 OTP/2FA형 MFA
// (`AuthenticationMethods publickey,keyboard-interactive`)에서, publickey 통과 뒤 서버가 보낸
// 실제 질문(예: "Verification code:")이 인터랙티브 프롬프트로 전달돼 응답으로 연결되는지 검증한다.
func TestDialClientMultiStepPublicKeyThenKeyboardInteractive(t *testing.T) {
	hostSigner, _ := generateTestKeyPair(t)
	clientSigner, clientPEM := generateTestKeyPair(t)

	const (
		wantCode = "123456"
		question = "Verification code: "
	)

	config := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if !bytes.Equal(key.Marshal(), clientSigner.PublicKey().Marshal()) {
				return nil, fmt.Errorf("unexpected public key")
			}
			return nil, &ssh.PartialSuccessError{
				Next: ssh.ServerAuthCallbacks{
					KeyboardInteractiveCallback: func(_ ssh.ConnMetadata, ask ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
						answers, err := ask("", "Two-factor authentication", []string{question}, []bool{false})
						if err != nil {
							return nil, err
						}
						if len(answers) != 1 || answers[0] != wantCode {
							return nil, fmt.Errorf("bad verification code")
						}
						return nil, nil
					},
				},
			}
		},
	}
	config.AddHostKey(hostSigner)
	host, port := startAuthTestServer(t, config)

	var askedQuestion string
	client, err := DialClient(Target{
		Host:                 host,
		Port:                 port,
		Username:             "user",
		AuthType:             "privateKey",
		PrivateKeyPEM:        string(clientPEM),
		TrustedHostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
	}, DefaultConfig, func(challenge InteractiveChallenge) ([]string, error) {
		responses := make([]string, len(challenge.Prompts))
		for index, prompt := range challenge.Prompts {
			askedQuestion = prompt.Label
			responses[index] = wantCode
		}
		return responses, nil
	})
	if err != nil {
		t.Fatalf("DialClient(publickey,keyboard-interactive) failed: %v", err)
	}
	defer client.Close()

	if askedQuestion != question {
		t.Fatalf("expected server question %q to reach the interactive prompt, got %q", question, askedQuestion)
	}
}
