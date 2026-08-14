package sshconn

import "testing"

func passwordPrompt(label string) InteractiveChallenge {
	return InteractiveChallenge{
		Prompts: []InteractivePrompt{{Label: label, Echo: false}},
	}
}

// OTP 서버는 1 라운드에서 비밀번호를 묻는다. 저장해 둔 값이 있으면 사용자를 붙잡지 않는다 —
// 다른 클라이언트는 비밀번호를 알아서 넣고 인증 코드만 묻는다.
func TestFirstRoundPasswordPromptIsAnsweredFromStorage(t *testing.T) {
	for _, label := range []string{
		"Password:",
		"password: ",
		"PASSWORD",
		"[sudo] password for ubuntu:",
		"비밀번호:",
	} {
		answers, ok := autoPasswordResponse(1, passwordPrompt(label), "secret")
		if !ok {
			t.Errorf("label %q: 자동 응답하지 않았다", label)
			continue
		}
		if len(answers) != 1 || answers[0] != "secret" {
			t.Errorf("label %q: answers = %v, want [secret]", label, answers)
		}
	}
}

// 2 라운드부터는 절대 자동으로 답하지 않는다. 그 자리는 보통 인증 코드이고, keyboard-interactive
// 는 방식당 한 번만 시도되므로 잘못 채우면 그 연결이 끝난다.
func TestLaterRoundsAreNeverAnsweredAutomatically(t *testing.T) {
	if _, ok := autoPasswordResponse(2, passwordPrompt("Password:"), "secret"); ok {
		t.Error("2 라운드를 자동으로 답했다")
	}
}

// 인증 코드 계열 라벨에 비밀번호를 넣으면 그 시도로 연결이 끝난다.
func TestSecondFactorPromptsAreNotAnswered(t *testing.T) {
	for _, label := range []string{
		"Verification code:",
		"Two-factor code:",
		"OTP:",
		"Duo passcode:",
		"Authenticator code:",
		"One-time password:",
		"인증 코드:",
	} {
		if _, ok := autoPasswordResponse(1, passwordPrompt(label), "secret"); ok {
			t.Errorf("label %q: 2차 요소 프롬프트에 비밀번호를 넣었다", label)
		}
	}
}

// 프롬프트가 여러 개면 어느 칸이 비밀번호인지 우리가 단정하지 않는다.
func TestMultiplePromptsFallBackToTheUser(t *testing.T) {
	challenge := InteractiveChallenge{
		Prompts: []InteractivePrompt{
			{Label: "Password:", Echo: false},
			{Label: "Verification code:", Echo: false},
		},
	}
	if _, ok := autoPasswordResponse(1, challenge, "secret"); ok {
		t.Error("프롬프트가 둘인데 자동으로 답했다")
	}
}

// 에코가 켜진 칸은 비밀번호가 아니다(서버가 화면에 보이라고 한 값이다).
func TestEchoedPromptIsNotTreatedAsPassword(t *testing.T) {
	challenge := InteractiveChallenge{
		Prompts: []InteractivePrompt{{Label: "Password:", Echo: true}},
	}
	if _, ok := autoPasswordResponse(1, challenge, "secret"); ok {
		t.Error("에코되는 칸을 비밀번호로 다뤘다")
	}
}

// 저장된 비밀번호가 없으면 물어봐야 한다.
func TestNoStoredPasswordMeansAsk(t *testing.T) {
	if _, ok := autoPasswordResponse(1, passwordPrompt("Password:"), ""); ok {
		t.Error("저장된 값이 없는데 자동으로 답했다")
	}
}

// 비밀번호도 2차 요소도 아닌 라벨은 사용자에게 맡긴다.
func TestUnknownPromptsFallBackToTheUser(t *testing.T) {
	for _, label := range []string{"Answer:", "PIN:", "Response:", ""} {
		if _, ok := autoPasswordResponse(1, passwordPrompt(label), "secret"); ok {
			t.Errorf("label %q: 알 수 없는 프롬프트를 비밀번호로 다뤘다", label)
		}
	}
}

// 홉마다 자기 비밀번호로 답해야 한다.
//
// 점프 호스트는 같은 responder 로 재귀 호출되고 그 챌린지가 **먼저** 온다. 판정을 세션 계층에 두면
// 그 1 라운드에 최종 대상의 비밀번호를 보내게 되고, keyboard-interactive 는 방식당 한 번뿐이라
// 그걸로 연결이 끝난다. 그래서 저장된 비밀번호는 인증 방식을 만든 홉의 것이어야 한다.
func TestEachHopAnswersWithItsOwnPassword(t *testing.T) {
	asked := make([]string, 0, 2)
	responder := func(challenge InteractiveChallenge) ([]string, error) {
		asked = append(asked, challenge.Prompts[0].Label)
		return []string{"typed-by-user"}, nil
	}

	// 홉마다 별도의 인증 방식이 만들어진다(resolveAuthMethods 가 홉마다 불린다).
	jump := newKeyboardInteractiveHandler(responder, "jump-secret", nil, InteractiveHop{Username: "bastion", Host: "10.0.0.1", Port: 22})
	final := newKeyboardInteractiveHandler(responder, "final-secret", nil, InteractiveHop{Username: "app", Host: "10.0.0.2", Port: 22})

	jumpAnswers := answerOnce(t, jump, "Password:")
	if len(jumpAnswers) != 1 || jumpAnswers[0] != "jump-secret" {
		t.Errorf("점프 홉 answers = %v, want [jump-secret]", jumpAnswers)
	}

	finalAnswers := answerOnce(t, final, "Password:")
	if len(finalAnswers) != 1 || finalAnswers[0] != "final-secret" {
		t.Errorf("최종 홉 answers = %v, want [final-secret]", finalAnswers)
	}

	if len(asked) != 0 {
		t.Errorf("사용자에게 물어본 프롬프트 = %v, want none", asked)
	}
}

// 시도 횟수도 홉마다 따로 센다. 공유하면 두 번째 홉의 1 라운드가 2 라운드로 취급돼 자동 응답이
// 걸리지 않는다.
func TestAttemptCountIsPerHop(t *testing.T) {
	handler := newKeyboardInteractiveHandler(nil, "secret", nil, InteractiveHop{})

	if answers := answerOnce(t, handler, "Password:"); len(answers) != 1 || answers[0] != "secret" {
		t.Fatalf("1 라운드 answers = %v", answers)
	}
	// 같은 홉의 2 라운드는 자동으로 답하지 않는다 — responder 가 nil 이므로 오류가 나야 한다.
	if _, err := handler("", "", []string{"Password:"}, []bool{false}); err == nil {
		t.Error("2 라운드를 자동으로 답했다")
	}
}

// 프롬프트가 없는 라운드는 사람을 기다리지 않고 빈 응답을 보내고, 문구는 흘려보낸다.
func TestInfoOnlyRoundRepliesEmptyAndForwardsText(t *testing.T) {
	notified := make([]string, 0, 1)
	handler := newKeyboardInteractiveHandler(
		func(InteractiveChallenge) ([]string, error) {
			t.Error("알림 라운드를 사람에게 물었다")
			return nil, nil
		},
		"secret",
		func(text string) { notified = append(notified, text) },
		InteractiveHop{},
	)

	answers, err := handler("", "Access granted.", nil, nil)
	if err != nil {
		t.Fatalf("info round error = %v", err)
	}
	if len(answers) != 0 {
		t.Errorf("answers = %v, want none", answers)
	}
	if len(notified) != 1 || notified[0] != "Access granted." {
		t.Errorf("notified = %v, want [Access granted.]", notified)
	}
}

func answerOnce(t *testing.T, handler keyboardInteractiveTestHandler, label string) []string {
	t.Helper()
	answers, err := handler("", "", []string{label}, []bool{false})
	if err != nil {
		t.Fatalf("challenge error = %v", err)
	}
	return answers
}

// keyboardInteractiveTestHandler 는 newKeyboardInteractiveHandler 가 돌려주는 콜백 모양이다.
type keyboardInteractiveTestHandler = func(user, instruction string, questions []string, echos []bool) ([]string, error)

// 점프 체인에서는 누가 묻는지 화면이 말할 수 있어야 한다. 베스천과 최종 대상이 둘 다 OTP 를 물으면
// 라벨만으로는 구분되지 않고, 엉뚱한 쪽의 코드를 넣으면 그 시도로 연결이 끝난다.
func TestChallengeCarriesTheHopThatAsked(t *testing.T) {
	var seen InteractiveHop
	handler := newKeyboardInteractiveHandler(
		func(challenge InteractiveChallenge) ([]string, error) {
			seen = challenge.Hop
			return []string{"123456"}, nil
		},
		"", // 저장된 비밀번호 없음 — 사용자에게 묻는 경로로 보낸다
		nil,
		InteractiveHop{Username: "ubuntu", Host: "192.168.200.37", Port: 2222},
	)

	if _, err := handler("", "", []string{"Verification code:"}, []bool{false}); err != nil {
		t.Fatalf("challenge error = %v", err)
	}
	if seen.Username != "ubuntu" || seen.Host != "192.168.200.37" || seen.Port != 2222 {
		t.Errorf("hop = %+v, want ubuntu@192.168.200.37:2222", seen)
	}
}

// 호스트를 모르면 화면에 빈 칸을 그리지 않는다.
func TestHopPayloadIsNilWithoutAHost(t *testing.T) {
	if got := HopPayload(InteractiveHop{Username: "ubuntu"}); got != nil {
		t.Errorf("HopPayload = %+v, want nil", got)
	}
	got := HopPayload(InteractiveHop{Username: "ubuntu", Host: "10.0.0.1", Port: 22})
	if got == nil || got.Host != "10.0.0.1" || got.Username != "ubuntu" || got.Port != 22 {
		t.Errorf("HopPayload = %+v", got)
	}
}
