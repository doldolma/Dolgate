package runtime

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	containersvc "dolssh/services/ssh-core/internal/containers"
	"dolssh/services/ssh-core/internal/forwarding"
	"dolssh/services/ssh-core/internal/hostkeytrust"
	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/internal/sshdial"
	"dolssh/services/ssh-core/internal/sshsession"
	"dolssh/services/ssh-core/internal/tmuxsession"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// 이 파일은 **터미널 세션 연결**을 시나리오별로 끝까지 돌린다.
//
// 1.9.1 에서 연결 조립이 sshdial 한 곳으로 모였다(세션·mosh·tmux·원격 키 설치). 그 경로에는
// tailnet dial, 다단 점프, 연결 중 호스트 키 신뢰, 서버 배너, 대화형 인증이 **함께** 얹혀 있고,
// 실기기에서 문제가 났던 것은 언제나 그 조합이었다 — 하나씩은 되는데 겹치면 안 되는 상태.
//
// 그래서 여기서는 조각을 따로 보지 않고, 조합해서 EventConnected 까지 가는지를 본다.

// ── 가짜 sshd ───────────────────────────────────────────────────────────────

// scenarioSSHD 는 시나리오마다 다르게 조립하는 sshd 다. 점프·대상 양쪽으로 쓴다.
type scenarioSSHD struct {
	listener net.Listener
	hostKey  string

	mu sync.Mutex
	// askedRounds 는 이 서버가 물어본 라운드의 라벨들이다. "누구에게 무엇을 물었나" 를 확인한다.
	askedRounds []string
	// answers 는 각 라운드에 받은 답이다. 홉이 서로의 코드를 받지 않았는지 본다.
	answers []string
}

type sshdOptions struct {
	// username 은 이 서버가 받아 주는 사용자다.
	username string
	// password 가 있으면 password 방식을 제시한다.
	password string
	// otpCode 가 있으면 keyboard-interactive 를 제시한다(1 라운드 비밀번호, 2 라운드 코드).
	otpCode string
	// otpPassword 는 OTP 서버의 1 라운드 답이다. 비면 password 와 같다.
	otpPassword string
	// banner 가 있으면 인증 단계에서 그것을 보낸다.
	banner string
	// relay 가 true 면 direct-tcpip 를 중계한다(점프 호스트).
	relay bool
	// session 이 true 면 session 채널(pty+shell+exec)을 받아 준다(최종 대상).
	session bool
	// execStdout 은 exec 요청에 돌려줄 stdout 이다. 명령마다 다르게 주고 싶으면 함수로 받는다.
	// nil 이면 빈 출력에 성공(exit 0)으로 답한다 — "붙기는 했다" 를 확인하는 시나리오용이다.
	execStdout func(command string) string
}

func (server *scenarioSSHD) port() int {
	_, portText, _ := net.SplitHostPort(server.listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	return port
}

func (server *scenarioSSHD) rounds() []string {
	server.mu.Lock()
	defer server.mu.Unlock()
	return append([]string(nil), server.askedRounds...)
}

func (server *scenarioSSHD) received() []string {
	server.mu.Lock()
	defer server.mu.Unlock()
	return append([]string(nil), server.answers...)
}

func newScenarioSSHD(t *testing.T, options sshdOptions) *scenarioSSHD {
	t.Helper()
	signer := testHostKey(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &scenarioSSHD{
		listener: listener,
		hostKey:  base64.StdEncoding.EncodeToString(signer.PublicKey().Marshal()),
	}

	config := &ssh.ServerConfig{}
	config.AddHostKey(signer)
	if options.banner != "" {
		config.BannerCallback = func(ssh.ConnMetadata) string { return options.banner }
	}
	if options.password != "" {
		config.PasswordCallback = func(conn ssh.ConnMetadata, given []byte) (*ssh.Permissions, error) {
			if conn.User() == options.username && string(given) == options.password {
				return nil, nil
			}
			return nil, fmt.Errorf("password rejected")
		}
	}
	if options.otpCode != "" {
		firstRound := options.otpPassword
		if firstRound == "" {
			firstRound = options.password
		}
		config.KeyboardInteractiveCallback = func(
			conn ssh.ConnMetadata,
			ask ssh.KeyboardInteractiveChallenge,
		) (*ssh.Permissions, error) {
			// 실기기의 OTP 베스천과 같은 모양이다 — 비밀번호와 코드를 **다른 라운드**로 묻는다.
			// 한 라운드로 묶으면 "저장된 비밀번호 자동 응답" 이 코드 칸까지 채우는지 확인할 수 없다.
			record := func(label string, given []string) {
				server.mu.Lock()
				server.askedRounds = append(server.askedRounds, label)
				server.answers = append(server.answers, given...)
				server.mu.Unlock()
			}
			given, err := ask("", "", []string{"Password:"}, []bool{false})
			if err != nil {
				return nil, err
			}
			record("Password:", given)
			if len(given) != 1 || given[0] != firstRound {
				return nil, fmt.Errorf("password rejected")
			}
			given, err = ask("", "", []string{"Verification code:"}, []bool{false})
			if err != nil {
				return nil, err
			}
			record("Verification code:", given)
			if len(given) != 1 || given[0] != options.otpCode {
				return nil, fmt.Errorf("code rejected")
			}
			return nil, nil
		}
	}

	go func() {
		for {
			raw, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go serveScenarioConn(raw, config, options)
		}
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return server
}

func serveScenarioConn(raw net.Conn, config *ssh.ServerConfig, options sshdOptions) {
	conn, chans, reqs, err := ssh.NewServerConn(raw, config)
	if err != nil {
		_ = raw.Close()
		return
	}
	defer conn.Close()
	go ssh.DiscardRequests(reqs)

	for newChannel := range chans {
		switch {
		case newChannel.ChannelType() == "direct-tcpip" && options.relay:
			go relayDirectTCPIP(newChannel)
		case newChannel.ChannelType() == "session" && options.session:
			go serveSessionChannel(newChannel, options)
		default:
			_ = newChannel.Reject(ssh.UnknownChannelType, "unsupported")
		}
	}
}

func relayDirectTCPIP(newChannel ssh.NewChannel) {
	var extra struct {
		DestAddr   string
		DestPort   uint32
		OriginAddr string
		OriginPort uint32
	}
	if err := ssh.Unmarshal(newChannel.ExtraData(), &extra); err != nil {
		_ = newChannel.Reject(ssh.ConnectionFailed, "bad payload")
		return
	}
	upstream, err := net.Dial("tcp", net.JoinHostPort(extra.DestAddr, strconv.Itoa(int(extra.DestPort))))
	if err != nil {
		_ = newChannel.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	channel, requests, err := newChannel.Accept()
	if err != nil {
		_ = upstream.Close()
		return
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

// serveSessionChannel 은 pty-req·shell·exec 에 성공으로 답한다.
//
// 세션은 shell, tmux 는 exec(control 명령), 공개 키 설치·컨테이너 탐지는 exec 로 온다 — 네 경로가
// 이 하나를 공유한다.
func serveSessionChannel(newChannel ssh.NewChannel, options sshdOptions) {
	channel, requests, err := newChannel.Accept()
	if err != nil {
		return
	}
	defer channel.Close()
	for request := range requests {
		switch request.Type {
		case "pty-req", "shell", "env", "window-change", "subsystem":
			if request.WantReply {
				_ = request.Reply(true, nil)
			}
		case "exec":
			if request.WantReply {
				_ = request.Reply(true, nil)
			}
			// execStdout 이 없으면 채널을 계속 쓰는 명령이다(tmux control). 닫지도 읽지도 않고
			// 흐르게 둔다 — 여기서 끝내면 control 채널이 그 자리에서 죽는다.
			if options.execStdout == nil {
				continue
			}
			var payload struct{ Command string }
			_ = ssh.Unmarshal(request.Payload, &payload)

			// **클라이언트의 stdin 을 끝까지 읽고 나서** 답한다. 진짜 sshd 가 하는 일이고,
			// 안 읽고 닫으면 아직 쓰는 중이던 쪽이 EOF 로 실패한다 — 원격 키 설치가 공개 키를
			// stdin 으로 보내므로 정확히 그 경합에 걸렸다(실패가 실행마다 달라 플레이키였다).
			// x/crypto 는 stdin 이 없어도 빈 복사 뒤 CloseWrite 를 하므로 여기서 멈추지 않는다.
			_, _ = io.Copy(io.Discard, channel)

			_, _ = io.WriteString(channel, options.execStdout(payload.Command))
			_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
			// **채널을 닫아야** 클라이언트의 Wait 가 끝난다. x/crypto 의 Session.Wait 은 요청
			// 스트림이 닫힐 때까지 도는데, exit-status 만 보내고 열어 두면 서로를 기다린다.
			_ = channel.Close()
			return
		default:
			if request.WantReply {
				_ = request.Reply(false, nil)
			}
		}
	}
}

// ── 시나리오 하네스 ─────────────────────────────────────────────────────────

// scenarioRig 는 실제 세션 매니저를 공유 dialer 위에 올린 것이다.
//
// 런타임 전체가 아니라 이 조합을 쓰는 이유: 연결 조립·신뢰 질의·대화형 인증이 전부 여기 모여
// 있고, 런타임의 응답 라우팅은 이미 단위 테스트가 덮는다.
type scenarioRig struct {
	manager *sshsession.Manager
	dialer  *sshdial.Dialer
	trust   *hostkeytrust.Registry
	events  *eventLog
	// tailnetDials 는 tailnet dialer 가 실제로 열어 준 주소다. 비어 있으면 일반 네트워크로 나갔다는 뜻.
	tailnetDials *[]string
	// emit 은 물음에 답하는 것까지 포함한 이벤트 싱크다. 서비스에는 **이것을** 줘야 한다 —
	// events.emit 을 그대로 주면 물음이 기록만 되고 아무도 답하지 않는다.
	emit func(coretypes.Event)

	mu        sync.Mutex
	answerFor func(hop *coretypes.KeyboardInteractiveHop, label string) string
	trustAll  bool
	asked     []string
	// respond 는 답을 어느 대기표로 보낼지다. 기본은 공유 dialer(세션·tmux·키 설치)이고,
	// SFTP·컨테이너·포워딩은 자기 대기표를 쓰므로 시나리오가 갈아 끼운다.
	respond func(challengeID string, responses []string)
}

// respondVia 는 답을 보낼 곳을 바꾼다(엔드포인트 서비스용).
func (rig *scenarioRig) respondVia(send func(challengeID string, responses []string)) {
	rig.mu.Lock()
	rig.respond = send
	rig.mu.Unlock()
}

// answerWith 는 이 시나리오가 물음에 어떻게 답할지 정한다. Connect 전에 부른다.
//
// 답을 미리 순서대로 넣어 두지 않고 **누가 무엇을 물었는지 보고 고르게** 한 이유는, 홉이 뒤바뀌어도
// 테스트가 통과해 버리는 것을 막기 위해서다.
func (rig *scenarioRig) answerWith(
	answerFor func(hop *coretypes.KeyboardInteractiveHop, label string) string,
	trustAll bool,
) {
	rig.mu.Lock()
	rig.answerFor = answerFor
	rig.trustAll = trustAll
	rig.mu.Unlock()
}

// askedLabels 는 **사용자에게** 물은 라벨들이다(코어가 자동으로 답한 라운드는 여기 없다).
func (rig *scenarioRig) askedLabels() []string {
	rig.mu.Lock()
	defer rig.mu.Unlock()
	return append([]string(nil), rig.asked...)
}

// handle 은 화면이 하는 일을 대신한다.
//
// 이벤트 콜백 안에서 곧바로 답한다. 별도 고루틴으로 채널을 소비하면 테스트의 await 와 같은
// 이벤트를 두고 경쟁해서, 실제로는 성공한 연결을 "이벤트를 못 받았다" 로 잘못 잡는다.
// 두 응답 모두 논블로킹 전송이라 여기서 처리해도 막히지 않는다.
func (rig *scenarioRig) handle(event coretypes.Event) {
	switch event.Type {
	case coretypes.EventKeyboardInteractiveChallenge:
		payload, ok := event.Payload.(coretypes.KeyboardInteractiveChallengePayload)
		if !ok {
			return
		}
		rig.mu.Lock()
		answerFor := rig.answerFor
		for _, prompt := range payload.Prompts {
			rig.asked = append(rig.asked, prompt.Label)
		}
		rig.mu.Unlock()
		if answerFor == nil {
			return
		}
		responses := make([]string, 0, len(payload.Prompts))
		for _, prompt := range payload.Prompts {
			responses = append(responses, answerFor(payload.Hop, prompt.Label))
		}
		rig.mu.Lock()
		send := rig.respond
		rig.mu.Unlock()
		if send == nil {
			send = func(challengeID string, values []string) {
				_ = rig.dialer.RespondKeyboardInteractive(
					coretypes.KeyboardInteractiveRespondPayload{
						ChallengeID: challengeID,
						Responses:   values,
					},
				)
			}
		}
		send(payload.ChallengeID, responses)
	case coretypes.EventHostKeyTrustChallenge:
		payload, ok := event.Payload.(coretypes.HostKeyTrustChallengePayload)
		if !ok {
			return
		}
		rig.mu.Lock()
		trustAll := rig.trustAll
		rig.mu.Unlock()
		_ = rig.trust.Respond(payload.ChallengeID, trustAll)
	}
}

func newScenarioRig(t *testing.T) *scenarioRig {
	t.Helper()
	events := newEventLog()
	rig := &scenarioRig{events: events, trust: hostkeytrust.New()}

	emit := func(event coretypes.Event) {
		events.emit(event)
		rig.handle(event)
	}
	rig.emit = emit
	dialer := sshdial.New(emit)
	rig.dialer = dialer
	dialer.SetHostKeyTrustPrompt(func(
		ctx context.Context,
		correlation hostkeytrust.Correlation,
	) sshconn.HostKeyTrustFunc {
		return rig.trust.Prompt(ctx, emit, correlation)
	})

	dials := make([]string, 0)
	var dialsMu sync.Mutex
	dialer.SetTailnetDial(func(tailnetID, expectedName string) (sshconn.DialFunc, error) {
		return func(ctx context.Context, network, address string) (net.Conn, error) {
			dialsMu.Lock()
			dials = append(dials, address)
			dialsMu.Unlock()
			// 진짜 tailnet 대신 그대로 로컬로 나간다 — 확인하려는 것은 "그 경로를 탔는가" 다.
			var netDialer net.Dialer
			return netDialer.DialContext(ctx, network, address)
		}, nil
	})
	rig.tailnetDials = &dials

	rig.manager = sshsession.NewManagerWithConfig(
		emit,
		func(coretypes.StreamFrame, []byte) {},
		sshsession.ManagerConfig{Dialer: dialer},
	)
	return rig
}

func connectPayload(target *scenarioSSHD, username, password string) coretypes.ConnectPayload {
	return coretypes.ConnectPayload{
		Host:                 "127.0.0.1",
		Port:                 target.port(),
		Username:             username,
		AuthType:             "password",
		Password:             password,
		TrustedHostKeyBase64: target.hostKey,
		Cols:                 120,
		Rows:                 32,
	}
}

func jumpTarget(server *scenarioSSHD, username, password string, trusted bool) *coretypes.JumpTarget {
	jump := &coretypes.JumpTarget{
		Host:     "127.0.0.1",
		Port:     server.port(),
		Username: username,
		AuthType: "password",
		Password: password,
	}
	if trusted {
		jump.TrustedHostKeyBase64 = server.hostKey
	}
	return jump
}

// ── 시나리오 ───────────────────────────────────────────────────────────────

// 1) tailnet 경유. 세션이 그 노드로 나가야 한다.
//
// 조립이 sshdial 로 옮겨지면서 tailnet 해석도 거기로 갔다. 빠뜨리면 실패가 아니라 **일반
// 네트워크로 조용히 나가서**, tailnet 안에만 있는 호스트에는 닿지 않는다.
func TestSessionOverTailnetConnects(t *testing.T) {
	target := newScenarioSSHD(t, sshdOptions{
		username: "ubuntu", password: "pw", session: true,
	})
	rig := newScenarioRig(t)

	payload := connectPayload(target, "ubuntu", "pw")
	payload.TailnetID = "net-1"
	payload.TailnetName = "example.ts.net"

	if err := rig.manager.Connect("session-1", "req-1", payload); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	rig.events.await(t, coretypes.EventConnected, 10*time.Second)

	if len(*rig.tailnetDials) == 0 {
		t.Fatal("tailnet dialer 를 쓰지 않고 일반 네트워크로 나갔다")
	}
}

// 2) 다단 점프(2 단). 각 홉을 순서대로 지나 최종 대상에 붙어야 한다.
func TestSessionThroughTwoJumpHopsConnects(t *testing.T) {
	outer := newScenarioSSHD(t, sshdOptions{
		username: "outer", password: "outer-pw", relay: true,
	})
	inner := newScenarioSSHD(t, sshdOptions{
		username: "inner", password: "inner-pw", relay: true,
	})
	target := newScenarioSSHD(t, sshdOptions{
		username: "ubuntu", password: "pw", session: true,
	})
	rig := newScenarioRig(t)

	payload := connectPayload(target, "ubuntu", "pw")
	// 체인은 바깥(먼저 붙는 것)부터 안쪽으로 중첩한다.
	payload.Jump = jumpTarget(inner, "inner", "inner-pw", true)
	payload.Jump.Jump = jumpTarget(outer, "outer", "outer-pw", true)

	if err := rig.manager.Connect("session-1", "req-1", payload); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	rig.events.await(t, coretypes.EventConnected, 15*time.Second)
}

// 3) TOFU 가 안 된 호스트. 연결 **안에서** 묻고, 수락하면 그대로 이어져야 한다.
//
// 예전에는 연결 전에 별도 연결(프로브)로 키를 읽었다. 그래서 인증이 두 번 필요했고, OTP 호스트는
// 통과할 수 없었다. 지금은 같은 연결에서 묻는다 — 그것을 여기서 확인한다.
func TestSessionAsksToTrustAnUnknownHostKeyAndContinues(t *testing.T) {
	target := newScenarioSSHD(t, sshdOptions{
		username: "ubuntu", password: "pw", session: true,
	})
	rig := newScenarioRig(t)

	rig.answerWith(nil, true)

	payload := connectPayload(target, "ubuntu", "pw")
	// 신뢰된 키가 없다 — 코어가 물어야 한다.
	payload.TrustedHostKeyBase64 = ""

	if err := rig.manager.Connect("session-1", "req-1", payload); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	rig.events.await(t, coretypes.EventConnected, 10*time.Second)
}

// 신뢰를 거절하면 그 자리에서 끝나야 한다. 수락 경로만 보면 "거절해도 붙는" 회귀를 놓친다.
func TestSessionStopsWhenTheHostKeyIsDeclined(t *testing.T) {
	target := newScenarioSSHD(t, sshdOptions{
		username: "ubuntu", password: "pw", session: true,
	})
	rig := newScenarioRig(t)

	rig.answerWith(nil, false)

	payload := connectPayload(target, "ubuntu", "pw")
	payload.TrustedHostKeyBase64 = ""

	err := rig.manager.Connect("session-1", "req-1", payload)
	if err == nil {
		t.Fatal("신뢰를 거절했는데 연결이 성공했다")
	}
	if !strings.Contains(err.Error(), "not trusted") {
		t.Errorf("거절 이유가 문구에 없다: %v", err)
	}
}

// 4) 배너에 승인 링크가 있는 경우. 배너가 화면으로 올라와야 한다.
//
// x/crypto 는 BannerCallback 이 없으면 배너를 조용히 버린다. 그러면 "이 주소에서 승인하라" 는
// 안내가 사라지고, 사용자에게는 이유 없이 멈춘 연결만 남는다.
func TestSessionSurfacesTheServerBanner(t *testing.T) {
	const approval = "Approve this login at https://login.example.com/a/abc123"
	target := newScenarioSSHD(t, sshdOptions{
		username: "ubuntu", password: "pw", session: true, banner: approval,
	})
	rig := newScenarioRig(t)

	if err := rig.manager.Connect("session-1", "req-1", connectPayload(target, "ubuntu", "pw")); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}

	event := rig.events.await(t, coretypes.EventSSHBanner, 10*time.Second)
	payload, ok := event.Payload.(coretypes.SSHBannerPayload)
	if !ok {
		t.Fatalf("배너 페이로드가 아니다: %#v", event.Payload)
	}
	if !strings.Contains(payload.Text, "https://login.example.com/a/abc123") {
		t.Errorf("승인 링크가 배너에서 사라졌다: %q", payload.Text)
	}
	rig.events.await(t, coretypes.EventConnected, 10*time.Second)
}

// 5) OTP 를 요구하는 호스트. 비밀번호는 저장된 값으로 자동 응답하고 코드만 물어야 한다.
func TestSessionWithOtpAsksOnlyForTheCode(t *testing.T) {
	target := newScenarioSSHD(t, sshdOptions{
		username: "ubuntu", otpPassword: "pw", otpCode: "424242", session: true,
	})
	rig := newScenarioRig(t)

	rig.answerWith(func(*coretypes.KeyboardInteractiveHop, string) string {
		return "424242"
	}, true)

	if err := rig.manager.Connect("session-1", "req-1", connectPayload(target, "ubuntu", "pw")); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	rig.events.await(t, coretypes.EventConnected, 10*time.Second)

	// 저장된 비밀번호가 있는 1 라운드까지 물으면 이미 아는 값을 위해 창을 한 번 더 상대해야 한다.
	asked := rig.askedLabels()
	if len(asked) != 1 || !strings.Contains(asked[0], "Verification code") {
		t.Errorf("사용자에게 물은 것 = %v, want [Verification code:]", asked)
	}
}

// 6) **전부 동시에**: tailnet + 2 단 점프 + 홉마다 OTP + 최종 대상은 처음 보는 키.
//
// 실기기에서 깨진 것은 언제나 이 조합이었다. 특히 홉마다 코드가 다를 때, 저장된 비밀번호와 코드가
// 엉뚱한 홉으로 가면 그 시도로 인증이 끝난다(keyboard-interactive 는 방식당 한 번뿐이다).
func TestSessionWithTailnetJumpsOtpAndTrustAllAtOnce(t *testing.T) {
	outer := newScenarioSSHD(t, sshdOptions{
		username: "outer", otpPassword: "outer-pw", otpCode: "111111", relay: true,
	})
	inner := newScenarioSSHD(t, sshdOptions{
		username: "inner", otpPassword: "inner-pw", otpCode: "222222", relay: true,
	})
	target := newScenarioSSHD(t, sshdOptions{
		username: "ubuntu", otpPassword: "target-pw", otpCode: "333333", session: true,
	})
	rig := newScenarioRig(t)

	// 홉마다 다른 코드를 준다. 라벨이 아니라 **누가 물었는지**로 고른다 — 홉 정보가 비면 여기서 걸린다.
	codeByPort := map[int]string{
		outer.port():  "111111",
		inner.port():  "222222",
		target.port(): "333333",
	}
	rig.answerWith(func(hop *coretypes.KeyboardInteractiveHop, label string) string {
		if hop == nil {
			t.Errorf("누가 물었는지 모른 채 %q 가 올라왔다", label)
			return ""
		}
		code, ok := codeByPort[hop.Port]
		if !ok {
			t.Errorf("모르는 홉이 물었다: %+v", hop)
		}
		return code
	}, true)

	payload := connectPayload(target, "ubuntu", "target-pw")
	// 최종 대상은 처음 보는 호스트다 — 연결 안에서 신뢰를 묻는다.
	payload.TrustedHostKeyBase64 = ""
	payload.TailnetID = "net-1"
	payload.TailnetName = "example.ts.net"
	payload.Jump = jumpTarget(inner, "inner", "inner-pw", true)
	payload.Jump.Jump = jumpTarget(outer, "outer", "outer-pw", true)

	if err := rig.manager.Connect("session-1", "req-1", payload); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	rig.events.await(t, coretypes.EventConnected, 20*time.Second)

	// 각 홉이 **자기** 코드를 받았는지 확인한다. 하나라도 뒤바뀌면 그 서버가 거절했을 것이다.
	for name, server := range map[string]*scenarioSSHD{
		"outer": outer, "inner": inner, "target": target,
	} {
		received := server.received()
		if len(received) != 2 {
			t.Errorf("%s 가 받은 답 = %v, want 2 개(비밀번호·코드)", name, received)
			continue
		}
		if received[1] != codeByPort[server.port()] {
			t.Errorf("%s 가 남의 코드를 받았다: %q", name, received[1])
		}
	}

	// tailnet 을 타는 것은 **첫 홉뿐**이다. 그 뒤는 점프 연결 위로 간다.
	if len(*rig.tailnetDials) != 1 {
		t.Errorf("tailnet dial 횟수 = %d, want 1 (첫 홉만)", len(*rig.tailnetDials))
	}
}

// ── 세션 밖의 경로들 ────────────────────────────────────────────────────────
//
// tmux·컨테이너·포워딩·원격 키 설치도 같은 sshdial 을 쓴다. 아래는 그 넷이 **가장 어려운 조합**
// (tailnet + 2 단 점프 + 홉마다 OTP + 처음 보는 최종 호스트 키)에서 끝까지 가는지 본다.
// 하나라도 배선이 빠지면 그 경로만 조용히 다르게 동작하기 때문이다.

// hardScenario 는 위 조합을 만들어 준다. 반환값은 (최종 대상, 연결 페이로드) 다.
func hardScenario(t *testing.T, rig *scenarioRig, targetOptions sshdOptions) (*scenarioSSHD, coretypes.ConnectPayload) {
	t.Helper()
	outer := newScenarioSSHD(t, sshdOptions{
		username: "outer", otpPassword: "outer-pw", otpCode: "111111", relay: true,
	})
	inner := newScenarioSSHD(t, sshdOptions{
		username: "inner", otpPassword: "inner-pw", otpCode: "222222", relay: true,
	})
	targetOptions.username = "ubuntu"
	targetOptions.otpPassword = "target-pw"
	targetOptions.otpCode = "333333"
	targetOptions.session = true
	target := newScenarioSSHD(t, targetOptions)

	codeByPort := map[int]string{
		outer.port():  "111111",
		inner.port():  "222222",
		target.port(): "333333",
	}
	rig.answerWith(func(hop *coretypes.KeyboardInteractiveHop, label string) string {
		if hop == nil {
			t.Errorf("누가 물었는지 모른 채 %q 가 올라왔다", label)
			return ""
		}
		code, ok := codeByPort[hop.Port]
		if !ok {
			t.Errorf("모르는 홉이 물었다: %+v", hop)
		}
		return code
	}, true)

	payload := connectPayload(target, "ubuntu", "target-pw")
	payload.TrustedHostKeyBase64 = "" // 처음 보는 호스트 — 연결 안에서 묻는다.
	payload.TailnetID = "net-1"
	payload.TailnetName = "example.ts.net"
	payload.Jump = jumpTarget(inner, "inner", "inner-pw", true)
	payload.Jump.Jump = jumpTarget(outer, "outer", "outer-pw", true)
	return target, payload
}

// tmux control mode 도 같은 조합을 통과해야 한다.
//
// 1.9.1 이전의 tmux 는 대화형 인증을 그 자리에서 거절했고(“not supported”), 신뢰 질의도 배너도
// 받지 못했다 — 이 조합에서는 붙을 방법 자체가 없었다.
func TestTmuxThroughTailnetJumpsOtpAndTrust(t *testing.T) {
	rig := newScenarioRig(t)
	_, payload := hardScenario(t, rig, sshdOptions{})
	// 버전을 알려 주면 tmux -V 보조 조회를 건너뛴다(이 테스트의 관심사가 아니다).
	payload.TmuxVersion = "3.4"

	manager := tmuxsession.NewManagerWithConfig(
		rig.emit,
		func(coretypes.StreamFrame, []byte) {},
		sshsession.ManagerConfig{Dialer: rig.dialer},
	)
	if err := manager.Connect("tmux-1", "req-1", payload); err != nil {
		t.Fatalf("tmux Connect() error = %v", err)
	}
	rig.events.await(t, coretypes.EventConnected, 20*time.Second)
}

// 컨테이너 연결도 같은 조합을 통과해야 한다.
//
// 런타임(도커)이 없는 서버로 두고 "연결됐다" 이벤트만 본다 — 여기서 확인하려는 것은 dial 경로이지
// 도커 탐지가 아니다.
func TestContainersThroughTailnetJumpsOtpAndTrust(t *testing.T) {
	rig := newScenarioRig(t)
	_, payload := hardScenario(t, rig, sshdOptions{
		execStdout: func(string) string { return "" },
	})

	service := containersvc.New(rig.emit)
	service.SetTailnetDial(func(tailnetID, expectedName string) (sshconn.DialFunc, error) {
		return func(ctx context.Context, network, address string) (net.Conn, error) {
			var netDialer net.Dialer
			return netDialer.DialContext(ctx, network, address)
		}, nil
	})
	service.SetHostKeyTrustPrompt(func(
		ctx context.Context,
		correlation hostkeytrust.Correlation,
	) sshconn.HostKeyTrustFunc {
		return rig.trust.Prompt(ctx, rig.emit, correlation)
	})
	// 컨테이너는 자기 대기표를 쓴다 — 응답을 그쪽으로 보내야 한다.
	rig.respondVia(func(challengeID string, responses []string) {
		_ = service.RespondKeyboardInteractive("containers:host-1", challengeID, responses)
	})

	go func() {
		_ = service.Connect("containers:host-1", "req-1", coretypes.ContainersConnectPayload{
			Host:                 payload.Host,
			Port:                 payload.Port,
			Username:             payload.Username,
			AuthType:             payload.AuthType,
			Password:             payload.Password,
			TrustedHostKeyBase64: payload.TrustedHostKeyBase64,
			Jump:                 payload.Jump,
			TailnetID:            payload.TailnetID,
			TailnetName:          payload.TailnetName,
		})
	}()
	rig.events.await(t, coretypes.EventContainersConnected, 20*time.Second)
}

// 포트 포워딩도 같은 조합을 통과해야 한다.
func TestPortForwardThroughTailnetJumpsOtpAndTrust(t *testing.T) {
	rig := newScenarioRig(t)
	_, payload := hardScenario(t, rig, sshdOptions{})

	service := forwarding.New(rig.emit)
	service.SetTailnetDial(func(tailnetID, expectedName string) (sshconn.DialFunc, error) {
		return func(ctx context.Context, network, address string) (net.Conn, error) {
			var netDialer net.Dialer
			return netDialer.DialContext(ctx, network, address)
		}, nil
	})
	service.SetHostKeyTrustPrompt(func(
		ctx context.Context,
		correlation hostkeytrust.Correlation,
	) sshconn.HostKeyTrustFunc {
		return rig.trust.Prompt(ctx, rig.emit, correlation)
	})
	rig.respondVia(func(challengeID string, responses []string) {
		_ = service.RespondKeyboardInteractive("rule-1", challengeID, responses)
	})

	go func() {
		_ = service.Start("rule-1", "req-1", coretypes.PortForwardStartPayload{
			Host:                 payload.Host,
			Port:                 payload.Port,
			Username:             payload.Username,
			AuthType:             payload.AuthType,
			Password:             payload.Password,
			TrustedHostKeyBase64: payload.TrustedHostKeyBase64,
			Jump:                 payload.Jump,
			TailnetID:            payload.TailnetID,
			TailnetName:          payload.TailnetName,
			Mode:                 "local",
			BindAddress:          "127.0.0.1",
			BindPort:             0,
			TargetHost:           "127.0.0.1",
			TargetPort:           9,
		})
	}()
	rig.events.await(t, coretypes.EventPortForwardStarted, 20*time.Second)
}

// 원격 공개 키 설치도 같은 조합을 통과해야 한다.
//
// 1.9.1 이전에는 tailnet dial 조차 없어서 tailnet 호스트에는 설치가 닿지 않았고, 대화형 인증을
// 물을 창구도 없었다. 지금은 상관 ID 를 달고 같은 경로로 간다.
func TestInstallAuthorizedKeyThroughTailnetJumpsOtpAndTrust(t *testing.T) {
	rig := newScenarioRig(t)
	_, payload := hardScenario(t, rig, sshdOptions{
		execStdout: func(string) string { return "installed\n" },
	})

	instance := newRuntimeWithDeps(
		rig.emit,
		func(coretypes.StreamFrame, []byte) {},
		&stubSSHManager{}, &stubMoshManager{}, &stubAWSManager{},
		&stubLocalManager{}, &stubSerialManager{},
		&stubSFTPService{}, &stubContainersService{}, &stubForwardingService{},
		&stubSSMForwardingService{}, nil, nil,
	)
	// 설치는 런타임의 dialer 를 쓴다 — 시나리오 하네스의 것으로 바꿔 끼운다.
	instance.dialer = rig.dialer

	installErr := make(chan error, 1)
	go func() {
		installErr <- instance.InstallAuthorizedKey("req-1", "keyinstall:host-1", coretypes.AuthorizedKeyInstallPayload{
			ConnectPayload: payload,
			PublicKey:      "ssh-ed25519 AAAATEST installer",
		})
	}()
	go func() {
		if err := <-installErr; err != nil {
			t.Errorf("InstallAuthorizedKey() error = %v", err)
		}
	}()
	rig.events.await(t, coretypes.EventAuthorizedKeyInstalled, 20*time.Second)
}

// tailnet 이 **점프 호스트에만** 걸린 구성.
//
// 실기기에서 막혔던 모양이다: 베스천은 tailnet 안에만 있고 최종 대상은 그 망에서 보이는 사내 LAN
// 주소다. 데스크톱이 tailnet 을 **대상**에서 읽던 시절에는 설정이 비어 dialer 가 nil 이 되고,
// 베스천을 일반 네트워크로 찾다 실패했다. 이제 첫 홉의 설정을 싣는다.
//
// 코어 입장에서 확인할 것은 하나다 — 페이로드에 tailnet 이 실려 오면 **첫 홉만** 그 경로로 나가고
// 최종 대상은 점프 연결 위로 간다는 것. 그것이 이 구성이 성립하는 근거다.
func TestTailnetAppliesToTheEntryHopOnly(t *testing.T) {
	jump := newScenarioSSHD(t, sshdOptions{
		username: "bastion", password: "bastion-pw", relay: true,
	})
	target := newScenarioSSHD(t, sshdOptions{
		username: "ubuntu", password: "pw", session: true,
	})
	rig := newScenarioRig(t)

	payload := connectPayload(target, "ubuntu", "pw")
	payload.Jump = jumpTarget(jump, "bastion", "bastion-pw", true)
	// 데스크톱이 첫 홉의 설정을 실어 보낸 상태다.
	payload.TailnetID = "net-1"
	payload.TailnetName = "example.ts.net"

	if err := rig.manager.Connect("session-1", "req-1", payload); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	rig.events.await(t, coretypes.EventConnected, 15*time.Second)

	// tailnet 을 탄 것은 첫 홉 하나뿐이어야 한다. 최종 대상까지 그 경로로 가면, 사내 LAN 주소를
	// 넷맵에서 찾다 실패한다.
	dials := *rig.tailnetDials
	if len(dials) != 1 {
		t.Fatalf("tailnet dial 횟수 = %d(%v), want 1 (첫 홉만)", len(dials), dials)
	}
	if !strings.HasSuffix(dials[0], strconv.Itoa(jump.port())) {
		t.Errorf("tailnet 으로 나간 곳 = %q, want 점프 호스트(:%d)", dials[0], jump.port())
	}
}
