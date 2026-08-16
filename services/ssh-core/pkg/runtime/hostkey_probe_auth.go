package runtime

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// probeChallengePrefix 는 프로브 챌린지의 ID 앞에 붙는다.
//
// 응답을 어디로 보낼지 이것으로 가른다. 프로브는 상관용으로 연결과 **같은** sessionId/endpointId 를
// 쓰기 때문에(그래야 화면이 이미 아는 오버레이에 붙는다) 그 두 값으로는 구분할 수 없다.
const probeChallengePrefix = "hostkey-"

// probeChallengeTimeout 은 프로브 챌린지의 답을 기다리는 한도다.
//
// 한도가 필요한 이유는 창구가 닫힐 수 있어서다 — 사용자가 연결 창을 닫으면 답이 오지 않고, 없으면
// 이 goroutine 이 영원히 남는다. 사람을 기다리는 구간이라 넉넉히 잡는다(핸드셰이크 승인 대기와 같다).
const probeChallengeTimeout = sshconn.HandshakeApprovalTimeout

// probeChallenge 는 답을 기다리는 프로브 챌린지 하나다.
//
// 저장된 비밀번호를 함께 들고 있는 이유: 화면은 "저장된 비밀번호 사용" 을 인덱스로만 돌려보내고
// (값은 코어 밖으로 나가지 않는다) 채우는 일은 코어가 한다. 세션 매니저가 자기 payload 의 비밀번호로
// 채우는 것과 같은 규칙이며, 프로브에서는 그 값이 점프 호스트의 것이다.
type probeChallenge struct {
	responses      chan []string
	storedPassword string
	promptCount    int
}

// probeChallenges 는 호스트 키 프로브가 낸 대화형 인증 챌린지의 대기표다.
type probeChallenges struct {
	mu      sync.Mutex
	pending map[string]*probeChallenge
	seq     int
}

func newProbeChallenges() *probeChallenges {
	return &probeChallenges{pending: make(map[string]*probeChallenge)}
}

func (p *probeChallenges) begin(
	requestID string,
	storedPassword string,
	promptCount int,
) (string, chan []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.seq += 1
	challengeID := fmt.Sprintf("%s%s-%d", probeChallengePrefix, requestID, p.seq)
	waiter := &probeChallenge{
		responses:      make(chan []string, 1),
		storedPassword: storedPassword,
		promptCount:    promptCount,
	}
	p.pending[challengeID] = waiter
	return challengeID, waiter.responses
}

func (p *probeChallenges) end(challengeID string) {
	p.mu.Lock()
	delete(p.pending, challengeID)
	p.mu.Unlock()
}

func (p *probeChallenges) respond(
	challengeID string,
	payload coretypes.KeyboardInteractiveRespondPayload,
) error {
	p.mu.Lock()
	waiter, ok := p.pending[challengeID]
	p.mu.Unlock()
	if !ok {
		return fmt.Errorf("host key probe challenge %s not found", challengeID)
	}
	responses := sshconn.ApplyStoredPassword(
		payload.Responses,
		payload.StoredPasswordIndexes,
		waiter.storedPassword,
		waiter.promptCount,
	)
	select {
	case waiter.responses <- responses:
		return nil
	default:
		return fmt.Errorf("host key probe challenge %s already answered", challengeID)
	}
}

// cancel 은 사용자가 닫은 물음을 접는다. 채널을 닫는 것이 취소 신호다.
func (p *probeChallenges) cancel(challengeID string) error {
	p.mu.Lock()
	waiter, ok := p.pending[challengeID]
	if ok {
		// 지우고 닫는 것을 같은 잠금 안에서 한다 — 뒤늦은 응답이 닫힌 채널로 가지 않게.
		delete(p.pending, challengeID)
	}
	p.mu.Unlock()
	if !ok {
		return fmt.Errorf("host key probe challenge %s not found", challengeID)
	}
	close(waiter.responses)
	return nil
}

// isProbeChallenge 는 이 응답이 프로브의 것인지다.
func isProbeChallenge(challengeID string) bool {
	return strings.HasPrefix(challengeID, probeChallengePrefix)
}

// probeInteractiveResponder 는 프로브의 점프 인증 프롬프트를 화면으로 올리고 답을 기다린다.
//
// 상관 ID(sessionID·endpointID)는 프로브 요청이 준 것을 그대로 쓴다. 그래야 챌린지가 지금 연결
// 중인 그 화면의 인증 카드로 올라간다 — 프로브만의 새 창을 만들면 사용자는 무엇에 답하는지 알 수 없다.
//
// 둘 다 비어 있으면 nil 을 돌려준다. 보여줄 곳이 없는데 기다리면 그냥 정지이고, 그때는 예전처럼
// "responder is not configured" 로 즉시 끝나는 편이 낫다(호스트 편집 화면의 지문 조회 등).
func (runtime *Runtime) probeInteractiveResponder(
	requestID string,
	payload coretypes.HostKeyProbePayload,
) sshconn.InteractiveResponder {
	if strings.TrimSpace(payload.SessionID) == "" && strings.TrimSpace(payload.EndpointID) == "" {
		return nil
	}
	return func(challenge sshconn.InteractiveChallenge) ([]string, error) {
		// 저장된 비밀번호는 **묻는 홉의** 것을 쓴다(sshconn 이 챌린지에 실어 준다).
		//
		// payload.Jump.Password 로 세우면 점프가 여러 단일 때 첫 점프의 값을 모든 홉에 쓴다 —
		// 두 번째 점프가 묻는 라운드에 엉뚱한 비밀번호가 나가고, keyboard-interactive 는 방식당
		// 한 번뿐이라 그 자리에서 프로브가 끝난다.
		challengeID, waiter := runtime.probeChallenges.begin(
			requestID,
			challenge.StoredPassword,
			len(challenge.Prompts),
		)
		defer runtime.probeChallenges.end(challengeID)

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

		runtime.emitEvent(coretypes.Event{
			Type:       coretypes.EventKeyboardInteractiveChallenge,
			RequestID:  requestID,
			SessionID:  payload.SessionID,
			EndpointID: payload.EndpointID,
			Payload: coretypes.KeyboardInteractiveChallengePayload{
				ChallengeID: challengeID,
				// 어느 홉이 묻는지. 프로브는 점프 호스트가 묻는 것이라 특히 중요하다.
				Hop:               sshconn.HopPayload(challenge.Hop),
				Attempt:           1,
				Name:              challenge.Name,
				Instruction:       challenge.Instruction,
				Prompts:           prompts,
				HasStoredPassword: hasStored,
			},
		})

		// 창구까지 갔다는 기록. 화면이 카드를 못 띄우는 경우와 코어가 아예 묻지 않은 경우가
		// 밖에서 보면 똑같아서, 이 줄이 그 둘을 가른다.
		sshconn.AuthLogf(
			"probe challenge %s sent up (sessionId=%q endpointId=%q)",
			challengeID, payload.SessionID, payload.EndpointID,
		)

		select {
		case responses, ok := <-waiter:
			// 채널이 닫혔으면 사용자가 물음을 닫은 것이다. 두 값으로 받지 않으면 그것이 nil 응답이
			// 되어, 서버에 빈 답을 보내고 그 시도로 인증이 끝난다(방식당 한 번뿐이다).
			if !ok {
				sshconn.AuthLogf("probe challenge %s was closed by the user", challengeID)
				return nil, fmt.Errorf("host key probe: challenge %s was cancelled", challengeID)
			}
			sshconn.AuthLogf("probe challenge %s answered", challengeID)
			runtime.emitEvent(coretypes.Event{
				Type:       coretypes.EventKeyboardInteractiveResolved,
				RequestID:  requestID,
				SessionID:  payload.SessionID,
				EndpointID: payload.EndpointID,
				Payload:    map[string]any{"challengeId": challengeID},
			})
			return responses, nil
		case <-time.After(probeChallengeTimeout):
			sshconn.AuthLogf(
				"probe challenge %s got no answer in %s", challengeID, probeChallengeTimeout,
			)
			return nil, fmt.Errorf("host key probe: no answer for %s", challengeID)
		}
	}
}
