package sshconn

import (
	"context"
	"errors"
	"time"
)

// HumanAnswerBudget 는 사람의 답을 기다려 주는 최대 시간이다.
//
// **왜 한도가 필요한가.** 사람을 기다리는 동안 이 연결은 이미 자원을 잡고 있다 — tailnet 을 경유하면
// 그 노드의 리스까지 들고 있어서, 답이 오지 않으면 노드가 유예에 들어가지 못하고 사용자가 설정에서
// 누르는 "연결 종료" 가 영원히 거절된다("이 Tailnet 을 사용하는 연결이 있습니다"). 실기기에서
// 그 상태가 됐다.
//
// 답이 안 오는 경우는 흔하다: 카드를 닫았거나, 화면이 그 질문을 놓쳤거나, 그냥 자리를 떠났거나.
// 데스크톱은 자기 요청 예산이 지나면 오류를 보이고 손을 떼지만 **코어에는 아무것도 보내지 않는다** —
// 그래서 코어 쪽에 스스로 끝낼 근거가 있어야 한다. 핸드셰이크 정지 감시(stall guard)는 이 구간에서
// 일부러 멈춰 있으므로(사람을 기다리는 것은 정지가 아니다) 그쪽이 대신 끊어 주지도 않는다.
//
// 5 분인 이유: 데스크톱의 요청 예산(6 분)보다 짧아야 코어가 먼저 끝나고, 그러면 화면에는
// "시간 초과" 대신 진짜 이유가 뜬다. 그리고 OTP 는 30 초마다 바뀌므로 5 분 지난 프롬프트는 어차피
// 쓸 수 없다.
var HumanAnswerBudget = 5 * time.Minute

// ErrHumanAnswerTimeout 은 예산 안에 답이 오지 않았을 때다.
var ErrHumanAnswerTimeout = errors.New("no answer came back in time")

// WaitForHumanAnswer 는 답·취소·예산 소진 중 먼저 오는 것을 고른다.
//
// 세 갈래를 한곳에 모아 둔다 — 다섯 군데(세션·SFTP·컨테이너·포워딩·호스트 키)가 각자 select 를
// 쓰면 한 곳이 예산을 빠뜨려도 드러나지 않고, 그 한 곳이 노드를 붙잡는다.
//
// 채널이 닫힌 경우도 취소로 본다(대기표를 접는 방식이다).
func WaitForHumanAnswer[T any](ctx context.Context, answers <-chan T) (T, error) {
	var zero T
	timer := time.NewTimer(HumanAnswerBudget)
	defer timer.Stop()

	select {
	case answer, ok := <-answers:
		if !ok {
			return zero, context.Canceled
		}
		return answer, nil
	case <-ctx.Done():
		return zero, ctx.Err()
	case <-timer.C:
		return zero, ErrHumanAnswerTimeout
	}
}
