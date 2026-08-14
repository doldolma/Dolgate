package runtime

import (
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/pkg/coretypes"
)

// 이 파일은 "OTP 를 요구하는 점프 호스트 뒤의 호스트 키를 읽는" 실기기 경로를 그대로 흉내낸다.
//
// 가짜 sshd 두 대(점프·대상)를 띄우고 **진짜 Runtime** 으로 프로브를 돌려서, 이벤트가 어떻게
// 나가고 답이 어디로 돌아오는지 눈으로 확인한다. 여기까지 통과하면 코어는 결백하고, 문제는
// 데스크톱이 프로브에 무엇을 실어 보내는지에 있다.

func testHostKey(t *testing.T) ssh.Signer {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	return signer
}

type fakeSSHD struct {
	listener net.Listener
	hostKey  string
}

func (server *fakeSSHD) port() int {
	_, portText, _ := net.SplitHostPort(server.listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	return port
}

// newOtpJumpSSHD 는 password 방식을 제시하지 않고 keyboard-interactive 로 두 라운드를 묻는다
// (1 라운드 비밀번호, 2 라운드 인증 코드) — 실기기의 OTP 베스천과 같은 형태다. 인증이 끝나면
// direct-tcpip 로 대상까지 중계한다.
func newOtpJumpSSHD(t *testing.T, username, password, code string) *fakeSSHD {
	t.Helper()
	signer := testHostKey(t)
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
	config.AddHostKey(signer)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &fakeSSHD{
		listener: listener,
		hostKey:  base64.StdEncoding.EncodeToString(signer.PublicKey().Marshal()),
	}
	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			go serveJump(raw, config)
		}
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return server
}

func serveJump(raw net.Conn, config *ssh.ServerConfig) {
	conn, chans, reqs, err := ssh.NewServerConn(raw, config)
	if err != nil {
		return
	}
	defer conn.Close()
	go ssh.DiscardRequests(reqs)

	for newChannel := range chans {
		if newChannel.ChannelType() != "direct-tcpip" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}
		var extra struct {
			DestAddr   string
			DestPort   uint32
			OriginAddr string
			OriginPort uint32
		}
		if err := ssh.Unmarshal(newChannel.ExtraData(), &extra); err != nil {
			_ = newChannel.Reject(ssh.ConnectionFailed, "bad payload")
			continue
		}
		upstream, err := net.Dial(
			"tcp",
			net.JoinHostPort(extra.DestAddr, strconv.Itoa(int(extra.DestPort))),
		)
		if err != nil {
			_ = newChannel.Reject(ssh.ConnectionFailed, err.Error())
			continue
		}
		channel, requests, err := newChannel.Accept()
		if err != nil {
			_ = upstream.Close()
			continue
		}
		go ssh.DiscardRequests(requests)
		go func() {
			_, _ = io.Copy(channel, upstream)
			_ = channel.Close()
		}()
		go func() {
			_, _ = io.Copy(upstream, channel)
			_ = upstream.Close()
		}()
	}
}

// newTargetSSHD 는 키 교환까지만 하면 된다 — 프로브는 인증 전에 호스트 키만 읽는다.
func newTargetSSHD(t *testing.T) *fakeSSHD {
	t.Helper()
	signer := testHostKey(t)
	config := &ssh.ServerConfig{
		PasswordCallback: func(ssh.ConnMetadata, []byte) (*ssh.Permissions, error) {
			return nil, fmt.Errorf("authentication is not part of this test")
		},
	}
	config.AddHostKey(signer)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &fakeSSHD{
		listener: listener,
		hostKey:  base64.StdEncoding.EncodeToString(signer.PublicKey().Marshal()),
	}
	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				conn, chans, reqs, err := ssh.NewServerConn(raw, config)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				go func() {
					for newChannel := range chans {
						_ = newChannel.Reject(ssh.UnknownChannelType, "unsupported")
					}
				}()
				_ = conn.Wait()
			}()
		}
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return server
}

// eventLog 는 런타임이 올려 보낸 이벤트를 순서대로 모은다.
type eventLog struct {
	mu     sync.Mutex
	events []coretypes.Event
	ch     chan coretypes.Event
}

func newEventLog() *eventLog {
	return &eventLog{ch: make(chan coretypes.Event, 64)}
}

func (log *eventLog) emit(event coretypes.Event) {
	log.mu.Lock()
	log.events = append(log.events, event)
	log.mu.Unlock()
	select {
	case log.ch <- event:
	default:
	}
}

func (log *eventLog) await(t *testing.T, eventType coretypes.EventType, timeout time.Duration) coretypes.Event {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case event := <-log.ch:
			if event.Type == eventType {
				return event
			}
		case <-deadline:
			log.mu.Lock()
			seen := make([]string, 0, len(log.events))
			for _, event := range log.events {
				seen = append(seen, string(event.Type))
			}
			log.mu.Unlock()
			t.Fatalf("%s 이벤트를 못 받았다. 받은 것: %s", eventType, strings.Join(seen, ", "))
			return coretypes.Event{}
		}
	}
}

func probePayload(jump *fakeSSHD, target *fakeSSHD) coretypes.HostKeyProbePayload {
	return coretypes.HostKeyProbePayload{
		Host: "127.0.0.1",
		Port: target.port(),
		Jump: &coretypes.JumpTarget{
			Host:                 "127.0.0.1",
			Port:                 jump.port(),
			Username:             "ubuntu",
			AuthType:             "password",
			Password:             "jump-pw",
			TrustedHostKeyBase64: jump.hostKey,
		},
	}
}

// 상관 ID 가 있으면 프로브는 사용자에게 코드를 묻고, 답을 받아 대상 호스트 키를 읽어야 한다.
func TestProbeThroughOtpJumpAsksAndCompletes(t *testing.T) {
	jump := newOtpJumpSSHD(t, "ubuntu", "jump-pw", "123456")
	target := newTargetSSHD(t)

	log := newEventLog()
	runtime := New(Options{EmitEvent: log.emit})

	payload := probePayload(jump, target)
	payload.SessionID = "pending-session-1"

	done := make(chan error, 1)
	go func() { done <- runtime.ProbeHostKey("probe-1", payload) }()

	challenge := log.await(t, coretypes.EventKeyboardInteractiveChallenge, 20*time.Second)
	body, ok := challenge.Payload.(coretypes.KeyboardInteractiveChallengePayload)
	if !ok {
		t.Fatalf("challenge payload type = %T", challenge.Payload)
	}
	if challenge.SessionID != "pending-session-1" {
		t.Errorf("challenge sessionId = %q, want the correlation id we sent", challenge.SessionID)
	}
	// 1 라운드(비밀번호)는 저장된 값으로 자동 응답돼야 한다 — 사람에게는 코드만 묻는다.
	if len(body.Prompts) != 1 || !strings.Contains(body.Prompts[0].Label, "Verification") {
		t.Fatalf("사용자에게 물은 프롬프트 = %+v, want [Verification code:]", body.Prompts)
	}
	if body.Hop == nil || body.Hop.Host != "127.0.0.1" {
		t.Errorf("hop = %+v, want the jump host", body.Hop)
	}

	if err := runtime.RespondKeyboardInteractive(
		"pending-session-1",
		"",
		coretypes.KeyboardInteractiveRespondPayload{
			ChallengeID: body.ChallengeID,
			Responses:   []string{"123456"},
		},
	); err != nil {
		t.Fatalf("응답 전달: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("프로브 실패: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("프로브가 끝나지 않았다")
	}

	probed := log.await(t, coretypes.EventHostKeyProbed, 5*time.Second)
	result, ok := probed.Payload.(coretypes.HostKeyProbedPayload)
	if !ok {
		t.Fatalf("probed payload type = %T", probed.Payload)
	}
	if result.PublicKeyBase64 != target.hostKey {
		t.Errorf("읽은 키가 대상의 것이 아니다")
	}
}

// 상관 ID 가 없으면 물을 창구가 없다. 이때 실기기에서 본 문구가 그대로 나오는지 확인한다 —
// 원인("물을 곳이 없음")이 문구에 드러나지 않아서 인증 실패처럼 보였다.
func TestProbeThroughOtpJumpWithoutCorrelationIdFails(t *testing.T) {
	jump := newOtpJumpSSHD(t, "ubuntu", "jump-pw", "123456")
	target := newTargetSSHD(t)

	log := newEventLog()
	runtime := New(Options{EmitEvent: log.emit})

	// SessionID·EndpointID 를 비운다(실기기에서 이 상태였는지 확인하려는 조건).
	err := runtime.ProbeHostKey("probe-1", probePayload(jump, target))
	if err == nil {
		t.Fatal("창구가 없는데 프로브가 성공했다")
	}
	t.Logf("창구 없는 프로브 오류: %v", err)

	log.mu.Lock()
	defer log.mu.Unlock()
	for _, event := range log.events {
		if event.Type == coretypes.EventKeyboardInteractiveChallenge {
			t.Fatal("보여줄 곳이 없는데 챌린지를 올렸다")
		}
	}
}

// 실기기에서 본 문구를 재현한다.
//
//	ssh: unable to authenticate, attempted methods [none keyboard-interactive],
//	no supported methods remain
//
// 이 문구는 **우리가 답을 보냈고 서버가 거절**했을 때만 나온다(콜백이 에러를 내면 그 에러가 그대로
// 올라온다 — 위 테스트가 그것을 보여 준다). 즉 사람에게 묻지 않고 자동 응답한 값이 틀렸다는 뜻이다.
func TestProbeThroughOtpJumpWithWrongStoredPassword(t *testing.T) {
	jump := newOtpJumpSSHD(t, "ubuntu", "jump-pw", "123456")
	target := newTargetSSHD(t)

	log := newEventLog()
	runtime := New(Options{EmitEvent: log.emit})

	payload := probePayload(jump, target)
	payload.SessionID = "pending-session-1"
	// 저장된 비밀번호가 틀렸다(바뀐 비밀번호·다른 호스트의 비밀번호 등).
	payload.Jump.Password = "stale-pw"

	err := runtime.ProbeHostKey("probe-1", payload)
	if err == nil {
		t.Fatal("틀린 비밀번호인데 성공했다")
	}
	t.Logf("틀린 비밀번호 프로브 오류: %v", err)

	if !strings.Contains(err.Error(), "no supported methods remain") {
		t.Errorf("문구가 실기기와 다르다: %v", err)
	}

	log.mu.Lock()
	defer log.mu.Unlock()
	for _, event := range log.events {
		if event.Type == coretypes.EventKeyboardInteractiveChallenge {
			t.Log("사용자에게 물었다(카드가 떴어야 한다)")
		}
	}
}

// OTP 를 요구하는 호스트로 포트포워딩이 완주해야 한다.
//
// 실기기 증상: 포워딩을 시작하면 `starting` 에서 무한 정지하고, stop 도 무반응이었으며, 그 뒤로
// SSM·ECS 포워딩과 tailnet 조회까지 전부 타임아웃 났다. 원인은 코어가 프레임을 한 줄로 처리하면서
// 이 핸들러 안에서 사람의 답을 기다린 것이다(답은 다음 프레임으로 온다). 여기서는 런타임 계층이
// 답을 받아 실제로 리스너를 여는지까지 확인한다.
func TestPortForwardThroughOtpHostCompletes(t *testing.T) {
	otpHost := newOtpJumpSSHD(t, "ubuntu", "host-pw", "123456")

	// 포워딩이 닿을 대상: 받은 바이트를 그대로 돌려주는 리스너.
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("echo listen: %v", err)
	}
	t.Cleanup(func() { _ = echo.Close() })
	go func() {
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	_, echoPortText, _ := net.SplitHostPort(echo.Addr().String())
	echoPort, _ := strconv.Atoi(echoPortText)

	log := newEventLog()
	runtime := New(Options{EmitEvent: log.emit})

	done := make(chan error, 1)
	go func() {
		done <- runtime.StartPortForward("rule-1", "req-1", coretypes.PortForwardStartPayload{
			Host:                 "127.0.0.1",
			Port:                 otpHost.port(),
			Username:             "ubuntu",
			AuthType:             "password",
			Password:             "host-pw",
			TrustedHostKeyBase64: otpHost.hostKey,
			Mode:                 "local",
			BindAddress:          "127.0.0.1",
			BindPort:             0,
			TargetHost:           "127.0.0.1",
			TargetPort:           echoPort,
		})
	}()

	challenge := log.await(t, coretypes.EventKeyboardInteractiveChallenge, 20*time.Second)
	body, ok := challenge.Payload.(coretypes.KeyboardInteractiveChallengePayload)
	if !ok {
		t.Fatalf("challenge payload type = %T", challenge.Payload)
	}
	if challenge.EndpointID != "rule-1" {
		t.Errorf("challenge endpointId = %q, want rule-1", challenge.EndpointID)
	}
	if err := runtime.RespondKeyboardInteractive("", "rule-1", coretypes.KeyboardInteractiveRespondPayload{
		ChallengeID: body.ChallengeID,
		Responses:   []string{"123456"},
	}); err != nil {
		t.Fatalf("응답 전달: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("포워딩 시작 실패: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("포워딩이 시작되지 않았다")
	}

	started := log.await(t, coretypes.EventPortForwardStarted, 5*time.Second)
	info, ok := started.Payload.(coretypes.PortForwardStartedPayload)
	if !ok {
		t.Fatalf("started payload type = %T", started.Payload)
	}
	if info.BindPort == 0 {
		t.Fatal("리스닝 포트를 알려주지 않았다")
	}

	// 실제로 그 포트를 통해 대상까지 바이트가 오가야 한다.
	conn, err := net.DialTimeout(
		"tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(info.BindPort)), 5*time.Second,
	)
	if err != nil {
		t.Fatalf("포워딩 포트로 붙지 못했다: %v", err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buffer := make([]byte, 4)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(conn, buffer); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buffer) != "ping" {
		t.Errorf("돌아온 값 = %q, want ping", buffer)
	}
}

// 처음 보는 호스트를 OTP 점프 뒤에서 연결할 때 **대화형 인증이 한 번**이어야 한다.
//
// 실기기 증상: 프로브가 점프에 인증(OTP #1) → 신뢰 창 수락 → 실연결이 점프에 다시 인증(OTP #2).
// TOTP 는 한 번 쓰면 무효하고 30초마다 바뀌니 같은 코드로는 통과할 수 없었다. 이제 신뢰를 연결
// 안에서 물으므로 인증은 한 번뿐이다.
func TestPortForwardThroughOtpHostAsksAuthOnceForANewHostKey(t *testing.T) {
	otpHost := newOtpJumpSSHD(t, "ubuntu", "host-pw", "123456")

	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("echo listen: %v", err)
	}
	t.Cleanup(func() { _ = echo.Close() })
	go func() {
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	_, echoPortText, _ := net.SplitHostPort(echo.Addr().String())
	echoPort, _ := strconv.Atoi(echoPortText)

	log := newEventLog()
	runtime := New(Options{EmitEvent: log.emit})

	done := make(chan error, 1)
	go func() {
		// TrustedHostKeyBase64 를 비운다 — "처음 보는 호스트" 다. 예전에는 여기서 곧바로
		// "trusted host key is required" 로 끝나고, 그래서 별도 프로브가 필요했다.
		done <- runtime.StartPortForward("rule-1", "req-1", coretypes.PortForwardStartPayload{
			Host:        "127.0.0.1",
			Port:        otpHost.port(),
			Username:    "ubuntu",
			AuthType:    "password",
			Password:    "host-pw",
			Mode:        "local",
			BindAddress: "127.0.0.1",
			BindPort:    0,
			TargetHost:  "127.0.0.1",
			TargetPort:  echoPort,
		})
	}()

	// 1) 신뢰를 먼저 묻는다(호스트 키는 인증보다 앞이다).
	trustEvent := log.await(t, coretypes.EventHostKeyTrustChallenge, 20*time.Second)
	trust, ok := trustEvent.Payload.(coretypes.HostKeyTrustChallengePayload)
	if !ok {
		t.Fatalf("trust payload type = %T", trustEvent.Payload)
	}
	if trust.Mismatch {
		t.Error("처음 보는 키인데 mismatch 로 왔다")
	}
	if trust.FingerprintSHA256 == "" || trust.PublicKeyBase64 == "" {
		t.Errorf("지문·키가 비어 있다: %+v", trust)
	}
	if trustEvent.EndpointID != "rule-1" {
		t.Errorf("endpointId = %q, want rule-1", trustEvent.EndpointID)
	}
	if err := runtime.RespondHostKeyTrust(coretypes.HostKeyTrustRespondPayload{
		ChallengeID: trust.ChallengeID,
		Trust:       true,
	}); err != nil {
		t.Fatalf("신뢰 응답: %v", err)
	}

	// 2) 그 다음 대화형 인증(OTP)을 **한 번** 묻는다.
	challenge := log.await(t, coretypes.EventKeyboardInteractiveChallenge, 20*time.Second)
	body, ok := challenge.Payload.(coretypes.KeyboardInteractiveChallengePayload)
	if !ok {
		t.Fatalf("challenge payload type = %T", challenge.Payload)
	}
	if err := runtime.RespondKeyboardInteractive("", "rule-1", coretypes.KeyboardInteractiveRespondPayload{
		ChallengeID: body.ChallengeID,
		Responses:   []string{"123456"},
	}); err != nil {
		t.Fatalf("응답 전달: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("포워딩 시작 실패: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("포워딩이 시작되지 않았다")
	}

	// 인증을 두 번 묻지 않았는지 확인한다 — 이것이 이 변경의 핵심이다.
	log.mu.Lock()
	defer log.mu.Unlock()
	authAsks := 0
	trustAsks := 0
	for _, event := range log.events {
		switch event.Type {
		case coretypes.EventKeyboardInteractiveChallenge:
			authAsks += 1
		case coretypes.EventHostKeyTrustChallenge:
			trustAsks += 1
		}
	}
	if authAsks != 1 {
		t.Errorf("대화형 인증을 물은 횟수 = %d, want 1", authAsks)
	}
	if trustAsks != 1 {
		t.Errorf("신뢰를 물은 횟수 = %d, want 1", trustAsks)
	}
}

// 신뢰를 거절하면 연결이 그 자리에서 끝나야 한다(인증까지 가지 않는다).
func TestDecliningTheHostKeyEndsTheConnection(t *testing.T) {
	otpHost := newOtpJumpSSHD(t, "ubuntu", "host-pw", "123456")

	log := newEventLog()
	runtime := New(Options{EmitEvent: log.emit})

	done := make(chan error, 1)
	go func() {
		done <- runtime.StartPortForward("rule-2", "req-2", coretypes.PortForwardStartPayload{
			Host:        "127.0.0.1",
			Port:        otpHost.port(),
			Username:    "ubuntu",
			AuthType:    "password",
			Password:    "host-pw",
			Mode:        "local",
			BindAddress: "127.0.0.1",
			BindPort:    0,
			TargetHost:  "127.0.0.1",
			TargetPort:  1,
		})
	}()

	trustEvent := log.await(t, coretypes.EventHostKeyTrustChallenge, 20*time.Second)
	trust := trustEvent.Payload.(coretypes.HostKeyTrustChallengePayload)
	if err := runtime.RespondHostKeyTrust(coretypes.HostKeyTrustRespondPayload{
		ChallengeID: trust.ChallengeID,
		Trust:       false,
	}); err != nil {
		t.Fatalf("신뢰 거절 전달: %v", err)
	}

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("거절했는데 연결이 성공했다")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("거절 후에도 연결이 끝나지 않았다")
	}

	log.mu.Lock()
	defer log.mu.Unlock()
	for _, event := range log.events {
		if event.Type == coretypes.EventKeyboardInteractiveChallenge {
			t.Fatal("신뢰를 거절했는데 인증까지 물었다")
		}
	}
}
