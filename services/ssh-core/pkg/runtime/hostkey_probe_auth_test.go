package runtime

import (
	"reflect"
	"testing"

	"dolssh/services/ssh-core/pkg/coretypes"
)

// 프로브가 낸 챌린지의 답은 프로브에게 가야 한다.
//
// 실기기 증상: OTP 점프 호스트 뒤의 호스트에 연결하면 인증 카드가 떴는데, 코드를 넣고 "응답 보내기"
// 를 눌러도 아무 반응이 없었다. 답이 세션 매니저로 갔다가 "challenge not found" 로 버려졌고, 그
// 오류는 아직 등록되지 않은 세션 ID 를 달고 있어 화면까지 오지도 못했다.
func TestProbeChallengeAnswerReachesTheProbe(t *testing.T) {
	runtime := &Runtime{probeChallenges: newProbeChallenges()}
	challengeID, waiter := runtime.probeChallenges.begin("req-1", "", 1)

	if err := runtime.RespondKeyboardInteractive(
		// 프로브는 연결과 같은 상관 ID 를 쓴다 — 이 시점의 세션은 아직 코어에 없다.
		"pending-session-1",
		"",
		coretypes.KeyboardInteractiveRespondPayload{
			ChallengeID: challengeID,
			Responses:   []string{"196399"},
		},
	); err != nil {
		t.Fatalf("프로브 챌린지 응답: %v", err)
	}

	select {
	case answers := <-waiter:
		if !reflect.DeepEqual(answers, []string{"196399"}) {
			t.Errorf("프로브가 받은 답 = %v, want [196399]", answers)
		}
	default:
		t.Fatal("답이 프로브에 닿지 않았다")
	}
}

// 저장된 비밀번호는 인덱스로만 돌아온다 — 채우는 일은 코어가 한다. 프로브에서는 그 값이 점프
// 호스트의 것이며, 세션 경로와 같은 규칙(sshconn.ApplyStoredPassword)을 써야 한다.
func TestProbeChallengeFillsTheStoredPassword(t *testing.T) {
	runtime := &Runtime{probeChallenges: newProbeChallenges()}
	challengeID, waiter := runtime.probeChallenges.begin("req-1", "bastion-pw", 2)

	if err := runtime.RespondKeyboardInteractive(
		"pending-session-1",
		"",
		coretypes.KeyboardInteractiveRespondPayload{
			ChallengeID:           challengeID,
			Responses:             []string{"", "196399"},
			StoredPasswordIndexes: []int{0},
		},
	); err != nil {
		t.Fatalf("프로브 챌린지 응답: %v", err)
	}

	answers := <-waiter
	if !reflect.DeepEqual(answers, []string{"bastion-pw", "196399"}) {
		t.Errorf("프로브가 받은 답 = %v, want [bastion-pw 196399]", answers)
	}
}

// 이미 끝난(또는 없는) 프로브 챌린지는 오류다. 조용히 성공으로 처리하면 화면은 답이 전달된 줄 안다.
func TestUnknownProbeChallengeIsAnError(t *testing.T) {
	runtime := &Runtime{probeChallenges: newProbeChallenges()}

	err := runtime.RespondKeyboardInteractive(
		"pending-session-1",
		"",
		coretypes.KeyboardInteractiveRespondPayload{
			ChallengeID: probeChallengePrefix + "gone-1",
			Responses:   []string{"196399"},
		},
	)
	if err == nil {
		t.Fatal("없는 챌린지인데 성공했다")
	}

	challengeID, _ := runtime.probeChallenges.begin("req-1", "", 1)
	payload := coretypes.KeyboardInteractiveRespondPayload{
		ChallengeID: challengeID,
		Responses:   []string{"196399"},
	}
	if err := runtime.RespondKeyboardInteractive("pending-session-1", "", payload); err != nil {
		t.Fatalf("첫 응답: %v", err)
	}
	// 두 번 누른 경우. 대기표가 이미 찼으므로 두 번째는 오류로 돌려준다.
	if err := runtime.RespondKeyboardInteractive("pending-session-1", "", payload); err == nil {
		t.Fatal("두 번째 응답도 성공으로 처리됐다")
	}
}
