package sshdial

import (
	"context"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// 대기표가 하나라는 것이 이 패키지의 핵심이다.
//
// 예전에는 세션·mosh 가 각자 들고 있어서 런타임이 "ssh 에 먼저 넣어 보고 실패하면 mosh" 로
// 골랐다. 실패를 신호로 쓰는 방식이라 경로가 하나 늘 때마다(tmux) 줄이 붙어야 했고, 그 줄을
// 빠뜨리면 답이 조용히 버려진다 — 사용자에게는 "응답 보내기를 눌러도 아무 일도 없음" 이다.
func TestAnswerReachesTheWaiterWithoutChoosingAManager(t *testing.T) {
	dialer := New(func(coretypes.Event) {})

	answers := dialer.beginChallenge("session-1-1")
	defer dialer.endChallenge("session-1-1")

	err := dialer.RespondKeyboardInteractive(coretypes.KeyboardInteractiveRespondPayload{
		ChallengeID:           "session-1-1",
		Responses:             []string{"123456"},
		StoredPasswordIndexes: []int{0},
	})
	if err != nil {
		t.Fatalf("RespondKeyboardInteractive() error = %v", err)
	}

	select {
	case answer := <-answers:
		if len(answer.Responses) != 1 || answer.Responses[0] != "123456" {
			t.Errorf("responses = %v", answer.Responses)
		}
		// 지목한 칸이 함께 와야 한다 — 이것이 빠지면 코어가 채울 자리를 몰라서 그 칸이 빈
		// 비밀번호로 서버에 나간다.
		if len(answer.StoredPasswordIndexes) != 1 || answer.StoredPasswordIndexes[0] != 0 {
			t.Errorf("storedPasswordIndexes = %v", answer.StoredPasswordIndexes)
		}
	default:
		t.Fatal("답이 대기표에 도착하지 않았다")
	}
}

// 사용자가 카드를 닫으면 기다리던 쪽이 즉시 풀려야 한다.
//
// 이것이 없으면 예산(5분)이 다 될 때까지 연결이 서 있는다 — 화면에는 "연결 중…" 이 남고, tailnet 을
// 경유하면 그 노드의 리스까지 잡은 채다. 닫힌 채널이 취소 신호다.
func TestCancellingAChallengeReleasesTheWaiter(t *testing.T) {
	dialer := New(func(coretypes.Event) {})
	answers := dialer.beginChallenge("session-1-1")

	if err := dialer.CancelChallenge("session-1-1"); err != nil {
		t.Fatalf("CancelChallenge() error = %v", err)
	}

	// WaitForHumanAnswer 는 닫힌 채널을 취소로 읽는다.
	if _, err := sshconn.WaitForHumanAnswer(context.Background(), answers); err == nil {
		t.Fatal("취소했는데 기다리던 쪽이 답을 받은 것으로 끝났다")
	}
	if got := dialer.PendingChallenges(); got != 0 {
		t.Errorf("대기표가 남았다: %d", got)
	}
}

// 취소한 뒤 뒤늦게 답이 와도 죽으면 안 된다(닫힌 채널에 보내면 panic 이다).
func TestAnsweringAfterCancelIsRejectedNotFatal(t *testing.T) {
	dialer := New(func(coretypes.Event) {})
	dialer.beginChallenge("session-1-1")

	if err := dialer.CancelChallenge("session-1-1"); err != nil {
		t.Fatalf("CancelChallenge() error = %v", err)
	}
	if err := dialer.RespondKeyboardInteractive(coretypes.KeyboardInteractiveRespondPayload{
		ChallengeID: "session-1-1",
		Responses:   []string{"123456"},
	}); err == nil {
		t.Fatal("이미 접힌 물음에 답했는데 성공했다")
	}
}

// 없는 물음에 답하면 오류다. 조용히 삼키면 화면은 보낸 줄 알고 기다린다.
func TestRespondingToAnUnknownChallengeFails(t *testing.T) {
	dialer := New(func(coretypes.Event) {})
	if err := dialer.RespondKeyboardInteractive(coretypes.KeyboardInteractiveRespondPayload{
		ChallengeID: "nope-1",
	}); err == nil {
		t.Fatal("없는 물음에 답했는데 성공했다")
	}
}

// 세션이 닫히면 그 세션의 물음만 접는다.
//
// 전부 접으면 다른 탭이 기다리던 인증 카드가 함께 죽는다(앱 시작 시 세션 여러 개를 복원하면
// 실제로 겹친다). 채널을 닫는 것이 취소 신호다.
func TestClosingASessionCancelsOnlyItsOwnChallenges(t *testing.T) {
	dialer := New(func(coretypes.Event) {})

	mine := dialer.beginChallenge("session-1-1")
	other := dialer.beginChallenge("session-2-1")

	dialer.CancelChallenges("session-1")

	select {
	case _, ok := <-mine:
		if ok {
			t.Error("취소인데 값이 왔다")
		}
	default:
		t.Error("내 물음이 접히지 않았다")
	}

	select {
	case <-other:
		t.Error("다른 세션의 물음까지 접었다")
	default:
	}

	if got := dialer.PendingChallenges(); got != 1 {
		t.Errorf("남은 물음 = %d, want 1", got)
	}
}

// 세션 ID 앞자리가 겹쳐도 남의 물음을 접으면 안 된다("s-1" 이 "s-10" 을 지우는 사고).
func TestCancelChallengesMatchesTheWholeSessionID(t *testing.T) {
	dialer := New(func(coretypes.Event) {})
	dialer.beginChallenge("s-1-1")
	neighbour := dialer.beginChallenge("s-10-1")

	dialer.CancelChallenges("s-1")

	select {
	case <-neighbour:
		t.Error("앞자리만 같은 다른 세션의 물음을 접었다")
	default:
	}
}

// 물어볼 자리가 없으면 아무것도 묻지 않는다.
//
// 원격 키 설치처럼 sessionId 가 없는 작업은 화면에 카드를 띄울 곳이 없다. 그때 사람을 기다리면
// 아무도 답할 수 없는 정지가 된다 — 차라리 평소의 인증 실패로 끝나는 편이 낫다.
func TestNoPromptsWithoutSomewhereToShowThem(t *testing.T) {
	events := make([]coretypes.Event, 0)
	dialer := New(func(event coretypes.Event) { events = append(events, event) })

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	// 아무 데도 붙지 않는 주소 — dial 은 실패하지만, 그 전에 responder 를 만들었는지가 관심사다.
	_, _, err := dialer.Dial(ctx, Request{
		RequestID: "req-1",
		Payload: coretypes.ConnectPayload{
			Host:                 "127.0.0.1",
			Port:                 1,
			Username:             "ubuntu",
			AuthType:             "password",
			Password:             "pw",
			TrustedHostKeyBase64: "AAAATEST",
		},
	})
	if err == nil {
		t.Fatal("붙을 수 없는 주소인데 성공했다")
	}
	if got := dialer.PendingChallenges(); got != 0 {
		t.Errorf("물음이 만들어졌다: %d", got)
	}
}
