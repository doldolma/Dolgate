// Package sshdial 은 SSH 연결을 여는 하나의 경로다.
//
// **왜 한 곳으로 모으는가.** 예전에는 터미널 세션·mosh·tmux·원격 키 설치가 각자 sshconn.Config 를
// 조립했다. 같은 모양이 네 벌 있으니 새로 붙는 기능이 한쪽에만 도착했고, 실제로 그렇게 갈렸다:
//
//   - mosh·tmux 는 연결 중 호스트 키 신뢰 질의를 받지 못했다 → 처음 보는 호스트에 붙을 방법 자체가
//     없었다(코어는 "trusted host key is required" 로 끊고, 물어볼 창구가 없다).
//   - mosh·tmux 는 서버 배너를 올리지 않았다 → 승인이 필요한 서버(Tailscale SSH check 모드)에서
//     이유 없이 멈춘 것처럼 보였다.
//   - mosh·tmux 는 context.Background() 로 붙었다 → 붙는 도중 탭을 닫아도 dial 이 끝날 때까지
//     아무 일도 일어나지 않았다.
//   - tmux 는 대화형 인증을 아예 거절했다 → OTP 를 요구하는 호스트에는 tmux 로 붙을 수 없었다.
//   - 원격 키 설치는 tailnet dial 이 빠져 있었다 → tailnet 호스트에는 키를 설치할 수 없었다.
//
// 한 벌만 두면 다음 기능은 네 경로에 동시에 도착한다.
//
// **대기표도 여기 하나뿐이다.** 세션·mosh·tmux 가 각자 pendingChallenges 를 들면 응답이 왔을 때
// 어느 매니저의 것인지 고르는 분기가 생기고(예전에는 "ssh 에 먼저 넣어 보고 실패하면 mosh"였다),
// 한 곳만 고쳐지는 사고가 난다. 챌린지 ID 가 세션 ID 로 시작해 전역에서 유일하므로 한 곳이면 된다.
package sshdial

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/hostkeytrust"
	"dolssh/services/ssh-core/internal/inflight"
	"dolssh/services/ssh-core/pkg/coretypes"

	"dolssh/services/ssh-core/internal/sshconn"
)

// 기본 시간값. 세 세션 계열이 같은 값을 쓰고 있었으므로 여기 한 벌만 둔다.
const (
	DefaultTCPDialTimeout       = 10 * time.Second
	DefaultTCPKeepAliveInterval = 30 * time.Second
)

// Answer 는 화면이 보낸 대화형 인증 응답이다.
//
// 값과 "저장된 비밀번호로 채울 칸" 이 함께 온다 — 비밀번호 자체는 코어 밖으로 나가지 않으므로
// 화면은 칸 번호만 돌려보내고 채우는 일은 여기서 한다.
type Answer struct {
	Responses             []string
	StoredPasswordIndexes []int
}

// Request 는 이 연결 한 번의 것들이다.
type Request struct {
	// SessionID 는 상관 ID 이자 대기표의 열쇠다.
	//
	// **비어 있으면 사람에게 아무것도 묻지 않는다.** 화면은 세션·엔드포인트 ID 로 카드를 띄울
	// 자리를 찾으므로, 그것이 없는 요청(원격 키 설치)은 물어봤자 보여줄 곳이 없다 — 그때 기다리는
	// 것은 그냥 정지다. 호스트 키 프로브가 쓰는 규칙과 같다.
	SessionID string
	// RequestID 는 화면이 이 이벤트를 어느 요청의 것으로 볼지다.
	RequestID string
	Payload   coretypes.ConnectPayload
}

// Dialer 는 세션 계열과 원격 키 설치가 공유하는 연결 경로다.
type Dialer struct {
	emit func(coretypes.Event)

	mu                   sync.RWMutex
	tailnetDial          sshconn.TailnetDialResolver
	hostKeyTrustPrompt   func(context.Context, hostkeytrust.Correlation) sshconn.HostKeyTrustFunc
	tcpDialTimeout       time.Duration
	tcpKeepAliveInterval time.Duration
	// challenges 는 답을 기다리는 대화형 인증 물음들이다.
	challenges map[string]chan Answer

	// connecting 은 아직 붙는 중인 연결을 세션별로 들고 있다 — 탭을 닫거나 종료를 누르면 그
	// 작업을 끊을 수 있게 한다. 사람의 답을 기다리는 구간은 대기표를 닫아 풀지만, dial·핸드셰이크처럼
	// 기계를 기다리는 구간은 ctx 취소만이 끊는다.
	connecting *inflight.Registry
}

func New(emit func(coretypes.Event)) *Dialer {
	return &Dialer{
		emit:                 emit,
		tcpDialTimeout:       DefaultTCPDialTimeout,
		tcpKeepAliveInterval: DefaultTCPKeepAliveInterval,
		challenges:           make(map[string]chan Answer),
		connecting:           inflight.New(),
	}
}

// SetTailnetDial 은 tailnet 경로를 raw dialer 로 바꾸는 함수를 주입한다.
//
// 생성자에서 받지 않는 이유는 tailnet 서비스가 이것보다 나중에 만들어지기 때문이다.
func (d *Dialer) SetTailnetDial(resolve sshconn.TailnetDialResolver) {
	d.mu.Lock()
	d.tailnetDial = resolve
	d.mu.Unlock()
}

// SetHostKeyTrustPrompt 는 연결 중 신뢰 질의 창구를 주입한다(대기표가 런타임 소유라 나중에 온다).
func (d *Dialer) SetHostKeyTrustPrompt(
	prompt func(context.Context, hostkeytrust.Correlation) sshconn.HostKeyTrustFunc,
) {
	d.mu.Lock()
	d.hostKeyTrustPrompt = prompt
	d.mu.Unlock()
}

// SetTimeouts 는 0 이 아닌 값만 바꾼다(매니저 설정이 기본값을 덮어쓸 때 쓴다).
func (d *Dialer) SetTimeouts(dialTimeout, keepAliveInterval time.Duration) {
	d.mu.Lock()
	if dialTimeout > 0 {
		d.tcpDialTimeout = dialTimeout
	}
	if keepAliveInterval > 0 {
		d.tcpKeepAliveInterval = keepAliveInterval
	}
	d.mu.Unlock()
}

// Begin 은 이 세션의 연결 작업을 등록하고 ctx 와 정리 함수를 돌려준다.
//
// 정리 함수는 연결이 성립한 뒤에 불러도 안전하다 — DialClient 는 핸드셰이크가 끝나면 ctx 감시를
// 끄기 때문에 멀쩡한 세션의 conn 이 닫히지 않는다.
func (d *Dialer) Begin(sessionID string) (context.Context, func()) {
	return d.connecting.Begin(sessionID)
}

// CancelInFlight 는 아직 붙는 중인 연결을 끊는다.
//
// 종료 명령은 자기가 끊어야 할 작업과 같은 대상이라 그 뒤에 줄을 선다. 앞의 작업이 오래 기다리는
// 중이면 종료는 자기 차례를 못 받으므로, 프레임 라우터가 배차하기 전에 이것을 부른다.
func (d *Dialer) CancelInFlight(sessionID string) {
	d.connecting.Cancel(sessionID)
}

// IsConnecting 은 이 세션이 아직 붙는 중인지다(테스트가 "붙는 중" 을 정확히 붙잡을 때 쓴다).
func (d *Dialer) IsConnecting(sessionID string) bool {
	return d.connecting.Has(sessionID)
}

// Dial 은 연결을 연다.
//
// raw dialer 를 함께 돌려주는 이유는 mosh 다 — mosh 는 부트스트랩 SSH 와 **같은 경로로** UDP 세션을
// 열어야 하는데, 여기서 이미 해석한 것을 다시 해석하면 tailnet 노드를 두 번 잡게 된다.
func (d *Dialer) Dial(
	ctx context.Context,
	req Request,
) (*ssh.Client, sshconn.DialFunc, error) {
	payload := req.Payload
	target := targetOf(payload)

	d.mu.RLock()
	resolveTailnet := d.tailnetDial
	trustPrompt := d.hostKeyTrustPrompt
	dialTimeout := d.tcpDialTimeout
	keepAlive := d.tcpKeepAliveInterval
	d.mu.RUnlock()

	// tailnet 경유면 raw 전송을 그 노드로 바꾼다. 경로가 없으면 nil 이라 평소대로 나간다.
	dial, dialErr := sshconn.ResolveTailnetDial(resolveTailnet, payload.TailnetID, payload.TailnetName)
	if dialErr != nil {
		return nil, nil, dialErr
	}

	config := sshconn.Config{
		Dial:                  dial,
		TCPDialTimeout:        dialTimeout,
		TCPKeepAliveInterval:  keepAlive,
		AuthAgentEndpointKind: payload.AuthAgentEndpointKind,
		AuthAgentEndpoint:     payload.AuthAgentEndpoint,
	}

	var responder sshconn.InteractiveResponder
	// 화면에 자리가 있을 때만 올리고 묻는다(Request.SessionID 주석 참고).
	//
	// 진행 보고도 같은 규칙이다 — 상관 ID 가 없는 이벤트는 렌더러가 어느 탭의 것인지 몰라 그냥
	// 버린다. 홉마다 IPC 를 태울 이유가 없다.
	if req.SessionID != "" {
		// 다단 ProxyJump 연결 단계 UI: 홉마다 connecting→connected 를 보고한다.
		config.Progress = sshconn.HopProgress(target, req.SessionID, "", d.emit)
		if trustPrompt != nil {
			// 처음 보는 서버 키는 이 연결 안에서 묻는다(별도 프로브 연결 없음 → OTP 한 번).
			config.HostKeyTrust = trustPrompt(ctx, hostkeytrust.Correlation{
				RequestID: req.RequestID,
				SessionID: req.SessionID,
			})
		}
		// 서버가 인증 단계에 보낸 배너를 그대로 올린다. 화면은 이것을 터미널에 찍는다 — OpenSSH 가
		// 하는 것과 같고, 승인 링크인지 경고문인지는 사용자가 읽고 판단한다.
		//
		// 이 콜백이 있으면 DialClient 가 배너 뒤의 침묵을 정지로 보지 않고 기다린다.
		config.Banner = func(text string) {
			d.emit(coretypes.Event{
				Type:      coretypes.EventSSHBanner,
				RequestID: req.RequestID,
				SessionID: req.SessionID,
				Payload:   coretypes.SSHBannerPayload{Text: text},
			})
		}
		responder = d.responder(ctx, req)
	}

	client, err := sshconn.DialClient(ctx, target, config, responder)
	if err != nil {
		return nil, nil, err
	}
	return client, dial, nil
}

// responder 는 대화형 인증 프롬프트를 화면으로 올리고 답을 기다린다.
func (d *Dialer) responder(ctx context.Context, req Request) sshconn.InteractiveResponder {
	attempt := 0
	return func(challenge sshconn.InteractiveChallenge) ([]string, error) {
		attempt += 1
		// 자동 응답(저장된 비밀번호)과 프롬프트 0 개 라운드는 sshconn 이 처리한다 — 홉마다 자기
		// 비밀번호를 써야 하므로 판정이 거기 있어야 한다. 여기 오는 것은 사람에게 물을 것뿐이다.
		challengeID := fmt.Sprintf("%s-%d", req.SessionID, attempt)
		answers := d.beginChallenge(challengeID)
		defer d.endChallenge(challengeID)

		prompts := make([]coretypes.KeyboardInteractivePrompt, 0, len(challenge.Prompts))
		hasStored := false
		for _, prompt := range challenge.Prompts {
			if prompt.AllowStoredPassword {
				hasStored = true
			}
			prompts = append(prompts, coretypes.KeyboardInteractivePrompt{
				Label: prompt.Label,
				Echo:  prompt.Echo,
				// 판정은 sshconn 이 홉마다 내린다 — 화면은 그대로 그린다.
				AllowStoredPassword: prompt.AllowStoredPassword,
				Masked:              prompt.Masked,
			})
		}

		d.emit(coretypes.Event{
			Type:      coretypes.EventKeyboardInteractiveChallenge,
			RequestID: req.RequestID,
			SessionID: req.SessionID,
			Payload: coretypes.KeyboardInteractiveChallengePayload{
				ChallengeID: challengeID,
				// 어느 홉이 묻는지. 점프 체인에서 이것이 없으면 사용자가 누구의 코드인지 모른다.
				Hop:         sshconn.HopPayload(challenge.Hop),
				Attempt:     attempt,
				Name:        challenge.Name,
				Instruction: challenge.Instruction,
				Prompts:     prompts,
				// 화면이 "저장된 비밀번호 사용" 을 내밀 수 있는지만 알려 준다. 값은 안 나간다.
				HasStoredPassword: hasStored,
			},
		})

		// 창구까지 갔다는 기록. 화면이 카드를 못 띄우는 경우와 코어가 아예 묻지 않은 경우가 밖에서
		// 보면 똑같아서, 이 줄이 그 둘을 가른다.
		sshconn.AuthLogf("session challenge %s sent up (sessionId=%q)", challengeID, req.SessionID)

		// 답을 기다린다. 취소(탭 닫기·종료)와 **예산**이 함께 걸려 있다.
		//
		// ctx 취소는 conn 을 닫아 핸드셰이크를 풀지만 이 채널 대기는 그것과 무관하게 서 있다.
		// 예산이 없으면 아무도 답하지 않는 프롬프트가 이 연결을 영원히 붙잡는다 — tailnet 을
		// 경유하면 그 노드의 리스까지 잡은 채라서 "연결 종료" 가 계속 거절된다.
		answer, waitErr := sshconn.WaitForHumanAnswer(ctx, answers)
		if waitErr != nil {
			sshconn.AuthLogf("session challenge %s ended without an answer: %v", challengeID, waitErr)
			return nil, fmt.Errorf("keyboard-interactive challenge was cancelled: %w", waitErr)
		}
		sshconn.AuthLogf("session challenge %s answered", challengeID)

		// 사용자가 지목한 칸을 **이 홉의** 비밀번호로 채운다(값은 챌린지가 들고 온다).
		responses := sshconn.ApplyStoredPassword(
			answer.Responses,
			answer.StoredPasswordIndexes,
			challenge.StoredPassword,
			len(challenge.Prompts),
		)

		d.emit(coretypes.Event{
			Type:      coretypes.EventKeyboardInteractiveResolved,
			RequestID: req.RequestID,
			SessionID: req.SessionID,
			Payload: map[string]any{
				"challengeId": challengeID,
			},
		})
		return responses, nil
	}
}

// RespondKeyboardInteractive 는 사용자의 답을 그 물음에 전달한다.
//
// 어느 세션 계열의 것인지 고르지 않는다 — 대기표가 하나라 챌린지 ID 로 바로 찾는다.
func (d *Dialer) RespondKeyboardInteractive(payload coretypes.KeyboardInteractiveRespondPayload) error {
	d.mu.RLock()
	answers, ok := d.challenges[payload.ChallengeID]
	d.mu.RUnlock()
	if !ok {
		return fmt.Errorf("keyboard-interactive challenge %s not found", payload.ChallengeID)
	}

	select {
	case answers <- Answer{
		Responses:             payload.Responses,
		StoredPasswordIndexes: payload.StoredPasswordIndexes,
	}:
		return nil
	default:
		return fmt.Errorf("keyboard-interactive challenge %s already has a pending response", payload.ChallengeID)
	}
}

// CancelChallenge 는 사용자가 닫은 물음 하나를 접는다.
//
// 답이 오지 않는 것과 "안 하겠다" 는 다르다. 닫았는데 아무것도 보내지 않으면 코어는 예산(5분)이
// 다 될 때까지 기다리고, 그동안 화면은 "연결 중…" 에 앉아 있는다.
func (d *Dialer) CancelChallenge(challengeID string) error {
	d.mu.Lock()
	answers, ok := d.challenges[challengeID]
	if ok {
		// 지우고 닫는 것을 같은 잠금 안에서 한다 — 그래야 뒤늦은 응답이 닫힌 채널로 가지 않는다.
		delete(d.challenges, challengeID)
	}
	d.mu.Unlock()
	if !ok {
		return fmt.Errorf("keyboard-interactive challenge %s not found", challengeID)
	}
	close(answers)
	return nil
}

// CancelChallenges 는 이 세션이 기다리던 물음을 모두 접는다(세션 종료 시).
//
// 채널을 닫으면 기다리던 쪽이 취소로 본다(WaitForHumanAnswer 가 그렇게 해석한다).
func (d *Dialer) CancelChallenges(sessionID string) {
	prefix := sessionID + "-"
	d.mu.Lock()
	pending := make([]chan Answer, 0)
	for challengeID, answers := range d.challenges {
		if strings.HasPrefix(challengeID, prefix) {
			pending = append(pending, answers)
			delete(d.challenges, challengeID)
		}
	}
	d.mu.Unlock()

	for _, answers := range pending {
		close(answers)
	}
}

// PendingChallenges 는 지금 기다리는 물음 수다(테스트에서 누수를 확인한다).
func (d *Dialer) PendingChallenges() int {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return len(d.challenges)
}

func (d *Dialer) beginChallenge(challengeID string) chan Answer {
	answers := make(chan Answer, 1)
	d.mu.Lock()
	d.challenges[challengeID] = answers
	d.mu.Unlock()
	return answers
}

func (d *Dialer) endChallenge(challengeID string) {
	d.mu.Lock()
	delete(d.challenges, challengeID)
	d.mu.Unlock()
}

// targetOf 는 연결 페이로드를 sshconn 의 대상으로 옮긴다.
//
// 네 경로가 같은 것을 각자 조립하고 있었다. 한쪽에만 필드가 빠지면(실제로 mosh 에 WSProxy 가
// 없었다) 그 경로만 조용히 다르게 동작한다.
func targetOf(payload coretypes.ConnectPayload) sshconn.Target {
	return sshconn.Target{
		Host:                  payload.Host,
		Port:                  payload.Port,
		Username:              payload.Username,
		AuthType:              payload.AuthType,
		Password:              payload.Password,
		PrivateKeyPEM:         payload.PrivateKeyPEM,
		CertificateText:       payload.CertificateText,
		Passphrase:            payload.Passphrase,
		TrustedHostKeyBase64:  payload.TrustedHostKeyBase64,
		TrustedHostKeysBase64: payload.TrustedHostKeysBase64,
		Jump:                  sshconn.JumpTargetFromCore(payload.Jump),
		WSProxy:               payload.WSProxy,
	}
}
