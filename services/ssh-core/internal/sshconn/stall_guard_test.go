package sshconn

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// TestDialClientFailsWhenHandshakeStalls 는 TCP 는 붙었는데 그 뒤 서버가 침묵할 때 연결이
// **영원히 매달리지 않고** 실패하는지 본다.
//
// 실제로 겪은 상태다: tailnet 릴레이 경유에서 호스트 키 확인까지 통과한 뒤 "SSH 연결" 단계에
// 5분 넘게 앉아 있고 오류도 뜨지 않았다. ssh.NewClientConn 은 이미 열린 conn 을 받으므로
// ClientConfig.Timeout 을 보지 않는다(그 값은 ssh.Dial 전용) — 그래서 데드라인이 없었다.
func TestDialClientFailsWhenHandshakeStalls(t *testing.T) {
	host, port := startSilentTestServer(t)

	hostSigner, _ := generateTestKeyPair(t)
	config := DefaultConfig
	// 테스트를 빨리 끝내기 위해 감시 한도만 줄인다. 실제 값은 HandshakeStallTimeout(10초)다.
	config.HandshakeStallTimeout = 300 * time.Millisecond

	start := time.Now()
	_, err := DialClient(context.Background(), Target{
		Host:                 host,
		Port:                 port,
		Username:             "user",
		AuthType:             "password",
		Password:             "pw",
		TrustedHostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
	}, config, nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatalf("정지한 서버에 연결이 성공했다고 보고했다")
	}
	// 한도의 몇 배 안에 끝나야 한다. 데드라인이 없으면 여기서 테스트가 타임아웃으로 죽는다.
	if elapsed > 5*time.Second {
		t.Fatalf("정지를 감지하는 데 너무 오래 걸렸다: %v", elapsed)
	}
}

// startSilentTestServer 는 TCP 는 받아 주지만 한 바이트도 보내지 않는 서버를 띄운다 — 버전
// 문자열조차 주지 않는 정지 상태다. 연결을 **닫지 않고** 붙잡아 두는 것이 요점이다: 닫으면
// 정지가 아니라 단절이 되고, 그건 이미 오류로 잡히는 다른 상황이다.
func startSilentTestServer(t *testing.T) (host string, port int) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	accepted := make(chan net.Conn, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			close(accepted)
			return
		}
		accepted <- conn
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		select {
		case conn, ok := <-accepted:
			if ok && conn != nil {
				_ = conn.Close()
			}
		default:
		}
	})

	_, portText, _ := net.SplitHostPort(listener.Addr().String())
	port, _ = strconv.Atoi(portText)
	return "127.0.0.1", port
}

// TestDialClientAllowsSlowInteractiveAnswer 는 **사람이 느리게 답해도** 감시가 끊지 않는지 본다.
//
// Warpgate 브라우저 승인·2FA 는 몇 분이 정상이다. NewClientConn 은 키 교환과 인증을 함께 하므로
// 절대 시간 제한을 걸면 그 흐름이 깨진다 — 그래서 사람을 기다리는 구간에는 시계를 멈춘다.
func TestDialClientAllowsSlowInteractiveAnswer(t *testing.T) {
	hostSigner, _ := generateTestKeyPair(t)
	clientSigner, clientPEM := generateTestKeyPair(t)

	const wantPassword = "second-factor"
	serverConfig := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if !bytes.Equal(key.Marshal(), clientSigner.PublicKey().Marshal()) {
				return nil, fmt.Errorf("unexpected public key")
			}
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
	serverConfig.AddHostKey(hostSigner)
	host, port := startAuthTestServer(t, serverConfig)

	config := DefaultConfig
	config.HandshakeStallTimeout = 300 * time.Millisecond

	client, err := DialClient(context.Background(), Target{
		Host:                 host,
		Port:                 port,
		Username:             "user",
		AuthType:             "privateKey",
		PrivateKeyPEM:        string(clientPEM),
		TrustedHostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
	}, config, func(challenge InteractiveChallenge) ([]string, error) {
		// 사람이 승인 화면을 보는 시간. 감시 한도보다 훨씬 길다.
		time.Sleep(3 * config.HandshakeStallTimeout)
		responses := make([]string, len(challenge.Prompts))
		for index := range challenge.Prompts {
			responses[index] = wantPassword
		}
		return responses, nil
	})
	if err != nil {
		t.Fatalf("느린 사람 응답을 정지로 오판했다: %v", err)
	}
	defer client.Close()
}

// 점프 뒤의 홉에는 정지 감시가 걸리지 않는다는 사실을 고정한다.
//
// x/crypto 의 SSH 채널 conn 은 데드라인을 지원하지 않는다(언제나 "deadline not supported").
// 감시자는 그 오류를 삼키므로 밖에서는 "걸린 것처럼" 보인다 — 이 테스트가 그 착각을 막는다.
// x/crypto 가 언젠가 데드라인을 지원하면 여기서 실패하고, 그때 stall_guard.go 의 문단을 지우면 된다.
func TestStallGuardDoesNotApplyToConnsWithoutDeadlines(t *testing.T) {
	guard := newStallGuard(10 * time.Millisecond)
	conn := &noDeadlineConn{}
	guard.Wrap(conn)
	guard.arm(conn)

	if conn.deadlineCalls == 0 {
		t.Fatal("감시자가 데드라인을 걸어 보지도 않았다")
	}
	if !conn.refused {
		t.Fatal("이 테스트의 conn 은 데드라인을 거부해야 한다")
	}
}

// noDeadlineConn 은 SSH 채널 conn 처럼 데드라인을 거부한다.
type noDeadlineConn struct {
	net.Conn
	deadlineCalls int
	refused       bool
}

func (c *noDeadlineConn) SetDeadline(time.Time) error {
	c.deadlineCalls += 1
	c.refused = true
	return errors.New("ssh: tcpChan: deadline not supported")
}
