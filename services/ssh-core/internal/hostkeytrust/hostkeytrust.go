// Package hostkeytrust 는 연결 도중 "이 서버 키를 신뢰하겠습니까" 를 사람에게 묻고 답을 기다린다.
//
// **왜 연결 도중인가:** 예전에는 키를 미리 읽어 오는 별도 연결(호스트 키 프로브)을 먼저 돌렸다. 그
// 프로브도 점프 호스트에 인증해야 하므로, OTP 를 요구하는 베스천 뒤의 호스트에 처음 붙으면 코드를
// **두 번** 넣어야 했다 — TOTP 는 한 번 쓰면 무효하고 30초마다 바뀌니 사실상 통과할 수 없다.
// 연결 하나 안에서 키를 보여 주고 그 자리에서 신뢰를 받으면 인증은 한 번으로 끝난다(OpenSSH 와 같다).
//
// **왜 한 곳에 모으는가:** 세션·SFTP·컨테이너·포워딩이 모두 같은 것을 물어야 한다. 대기표를 네 벌
// 만들면 응답을 어디로 보낼지 고르는 분기가 또 생기고, 한 곳만 고쳐지는 사고가 난다. 여기 하나만
// 두면 챌린지 ID 가 전역에서 유일해서 응답 라우팅이 필요 없다.
package hostkeytrust

import (
	"context"
	"fmt"
	"sync"

	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// Correlation 은 이 물음이 어느 작업의 것인지다. 화면이 자기 카드·창을 찾는 데 쓴다.
type Correlation struct {
	RequestID  string
	SessionID  string
	EndpointID string
}

// Registry 는 답을 기다리는 물음들의 대기표다.
type Registry struct {
	mu      sync.Mutex
	seq     int
	pending map[string]chan bool
}

func New() *Registry {
	return &Registry{pending: make(map[string]chan bool)}
}

// Prompt 는 sshconn 에 넘길 신뢰 질의 함수를 만든다.
//
// ctx 는 그 연결의 것이다 — 탭을 닫거나 정지를 누르면 여기 대기도 함께 풀려야 한다(그러지 않으면
// 창을 띄운 채 아무도 답하지 않는 연결이 남는다).
func (registry *Registry) Prompt(
	ctx context.Context,
	emit func(coretypes.Event),
	correlation Correlation,
) sshconn.HostKeyTrustFunc {
	if emit == nil {
		return nil
	}
	return func(request sshconn.HostKeyTrustRequest) (bool, error) {
		challengeID, answers := registry.begin()
		defer registry.end(challengeID)

		emit(coretypes.Event{
			Type:       coretypes.EventHostKeyTrustChallenge,
			RequestID:  correlation.RequestID,
			SessionID:  correlation.SessionID,
			EndpointID: correlation.EndpointID,
			Payload: coretypes.HostKeyTrustChallengePayload{
				ChallengeID:       challengeID,
				Hop:               sshconn.HopPayload(request.Hop),
				Algorithm:         request.Algorithm,
				FingerprintSHA256: request.FingerprintSHA256,
				PublicKeyBase64:   request.PublicKeyBase64,
				Mismatch:          request.Mismatch,
			},
		})

		// 취소(정지·종료)와 예산이 함께 걸려 있다. 답을 기다리는 채널만 보면 여기서 영원히 서
		// 있게 되고, 그동안 이 연결이 tailnet 노드의 리스를 붙잡는다.
		trust, waitErr := sshconn.WaitForHumanAnswer(ctx, answers)
		if waitErr != nil {
			return false, fmt.Errorf("host key trust prompt was cancelled: %w", waitErr)
		}
		return trust, nil
	}
}

// Respond 는 사용자의 답을 그 물음에 전달한다.
func (registry *Registry) Respond(challengeID string, trust bool) error {
	registry.mu.Lock()
	answers, ok := registry.pending[challengeID]
	registry.mu.Unlock()
	if !ok {
		return fmt.Errorf("host key trust challenge %s not found", challengeID)
	}
	select {
	case answers <- trust:
		return nil
	default:
		return fmt.Errorf("host key trust challenge %s already answered", challengeID)
	}
}

// Pending 은 지금 기다리는 물음 수다(테스트에서 누수를 확인한다).
func (registry *Registry) Pending() int {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	return len(registry.pending)
}

func (registry *Registry) begin() (string, chan bool) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.seq += 1
	challengeID := fmt.Sprintf("hostkey-trust-%d", registry.seq)
	answers := make(chan bool, 1)
	registry.pending[challengeID] = answers
	return challengeID, answers
}

func (registry *Registry) end(challengeID string) {
	registry.mu.Lock()
	delete(registry.pending, challengeID)
	registry.mu.Unlock()
}
