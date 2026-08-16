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
		answers, ok := autoPasswordResponse(1, passwordPrompt(label), "secret", false)
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
	if _, ok := autoPasswordResponse(2, passwordPrompt("Password:"), "secret", false); ok {
		t.Error("2 라운드를 자동으로 답했다")
	}
}

// 이미 거절당한 비밀번호를 한 번 더 보내지 않는다.
//
// 서버가 password 와 keyboard-interactive 를 둘 다 제시하면(PAM 을 쓰면 흔하다) x/crypto 는
// password 를 먼저 시도한다. 서버에서 비밀번호가 바뀐 뒤라면 그것이 거절되는데, 여기서 같은 값을
// 또 보내면 남은 방식까지 소진돼 연결이 끝난다 — 앱에 물어볼 창이 있는데도 사용자는 아무것도 못
// 보고 실패만 받는다.
func TestARefusedPasswordIsNotSentAgain(t *testing.T) {
	if _, ok := autoPasswordResponse(1, passwordPrompt("Password:"), "secret", true); ok {
		t.Error("이미 거절당한 비밀번호를 다시 보냈다")
	}
}

// password 방식이 시도되지 않았으면(서버가 keyboard-interactive 만 제시) 저장된 값의 첫 사용이다.
func TestStoredPasswordStillAnswersWhenPasswordAuthWasNeverTried(t *testing.T) {
	handler := newKeyboardInteractiveHandler(
		func(InteractiveChallenge) ([]string, error) {
			t.Error("저장된 비밀번호가 있는데 사용자에게 물었다")
			return nil, nil
		},
		"secret",
		nil,
		InteractiveHop{},
		func() bool { return false },
	)

	answers := answerOnce(t, handler, "Password:")
	if len(answers) != 1 || answers[0] != "secret" {
		t.Errorf("answers = %v, want [secret]", answers)
	}
}

// 거절당한 뒤에는 사용자에게 묻는 경로로 넘어간다 — 그것이 이 수정의 요점이다.
func TestTheUserIsAskedAfterTheStoredPasswordWasRefused(t *testing.T) {
	asked := false
	handler := newKeyboardInteractiveHandler(
		func(InteractiveChallenge) ([]string, error) {
			asked = true
			return []string{"typed-by-user"}, nil
		},
		"stale-secret",
		nil,
		InteractiveHop{},
		func() bool { return true },
	)

	answers := answerOnce(t, handler, "Password:")
	if !asked {
		t.Fatal("거절당한 뒤에도 사용자에게 묻지 않았다")
	}
	if len(answers) != 1 || answers[0] != "typed-by-user" {
		t.Errorf("answers = %v, want [typed-by-user]", answers)
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
		if _, ok := autoPasswordResponse(1, passwordPrompt(label), "secret", false); ok {
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
	if _, ok := autoPasswordResponse(1, challenge, "secret", false); ok {
		t.Error("프롬프트가 둘인데 자동으로 답했다")
	}
}

// 에코가 켜진 칸은 비밀번호가 아니다(서버가 화면에 보이라고 한 값이다).
func TestEchoedPromptIsNotTreatedAsPassword(t *testing.T) {
	challenge := InteractiveChallenge{
		Prompts: []InteractivePrompt{{Label: "Password:", Echo: true}},
	}
	if _, ok := autoPasswordResponse(1, challenge, "secret", false); ok {
		t.Error("에코되는 칸을 비밀번호로 다뤘다")
	}
}

// 저장된 비밀번호가 없으면 물어봐야 한다.
func TestNoStoredPasswordMeansAsk(t *testing.T) {
	if _, ok := autoPasswordResponse(1, passwordPrompt("Password:"), "", false); ok {
		t.Error("저장된 값이 없는데 자동으로 답했다")
	}
}

// 비밀번호도 2차 요소도 아닌 라벨은 사용자에게 맡긴다.
func TestUnknownPromptsFallBackToTheUser(t *testing.T) {
	for _, label := range []string{"Answer:", "PIN:", "Response:", ""} {
		if _, ok := autoPasswordResponse(1, passwordPrompt(label), "secret", false); ok {
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
	jump := newKeyboardInteractiveHandler(responder, "jump-secret", nil, InteractiveHop{Username: "bastion", Host: "10.0.0.1", Port: 22}, nil)
	final := newKeyboardInteractiveHandler(responder, "final-secret", nil, InteractiveHop{Username: "app", Host: "10.0.0.2", Port: 22}, nil)

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
	handler := newKeyboardInteractiveHandler(nil, "secret", nil, InteractiveHop{}, nil)

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
		nil,
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
		nil,
	)

	if _, err := handler("", "", []string{"Verification code:"}, []bool{false}); err != nil {
		t.Fatalf("challenge error = %v", err)
	}
	if seen.Username != "ubuntu" || seen.Host != "192.168.200.37" || seen.Port != 2222 {
		t.Errorf("hop = %+v, want ubuntu@192.168.200.37:2222", seen)
	}
}

// 사용자가 "저장된 비밀번호 사용" 을 눌렀을 때 채울 값도 **묻는 홉의** 것이어야 한다.
//
// 자동 응답(1 라운드 비밀번호)은 핸들러가 직접 답하지만, 2 라운드나 여러 칸짜리 프롬프트는 사용자가
// 칸을 지목하고 호출부가 채운다. 그 호출부(세션 매니저·프로브)는 자기 payload 의 비밀번호밖에
// 모르는데 그것은 **최종 대상**의 값이라, 점프 호스트가 묻는 라운드에 엉뚱한 값이 나간다.
// 그래서 챌린지가 그 홉의 값을 함께 들고 간다.
func TestChallengeCarriesTheAskingHopsStoredPassword(t *testing.T) {
	seen := make(map[string]string, 2)
	responder := func(challenge InteractiveChallenge) ([]string, error) {
		seen[challenge.Hop.Host] = challenge.StoredPassword
		return []string{"typed-by-user"}, nil
	}

	// 2 라운드로 보내 자동 응답을 피한다 — 사용자에게 묻는 경로가 이 테스트의 대상이다.
	jump := newKeyboardInteractiveHandler(responder, "jump-secret", nil,
		InteractiveHop{Username: "bastion", Host: "10.0.0.1", Port: 22}, nil)
	final := newKeyboardInteractiveHandler(responder, "final-secret", nil,
		InteractiveHop{Username: "app", Host: "10.0.0.2", Port: 22}, nil)

	for _, handler := range []keyboardInteractiveTestHandler{jump, final} {
		if _, err := handler("", "", []string{"Password:"}, []bool{false}); err != nil {
			t.Fatalf("1 라운드 error = %v", err)
		}
		if _, err := handler("", "", []string{"Verification code:"}, []bool{false}); err != nil {
			t.Fatalf("2 라운드 error = %v", err)
		}
	}

	if seen["10.0.0.1"] != "jump-secret" {
		t.Errorf("점프 홉 StoredPassword = %q, want jump-secret", seen["10.0.0.1"])
	}
	if seen["10.0.0.2"] != "final-secret" {
		t.Errorf("최종 홉 StoredPassword = %q, want final-secret", seen["10.0.0.2"])
	}
}

// 우리가 만든 비밀번호 프롬프트(publickey 뒤의 2차 요소)도 가려야 한다.
//
// 서버가 낸 프롬프트가 아니라 라벨 판정을 거치지 않으므로, 여기서 직접 세우지 않으면 Masked 가
// false 로 내려가 비밀번호가 평문으로 보인다. 인증 코드 칸은 이 경로로 오지 않는다.
func TestSecondFactorPasswordPromptIsMasked(t *testing.T) {
	var seen InteractiveChallenge
	callback := newPasswordPromptCallback(
		func(challenge InteractiveChallenge) ([]string, error) {
			seen = challenge
			return []string{"typed"}, nil
		},
		InteractiveHop{Username: "ubuntu", Host: "10.0.0.9", Port: 22},
	)

	password, err := callback()
	if err != nil {
		t.Fatalf("callback error = %v", err)
	}
	if password != "typed" {
		t.Errorf("password = %q, want typed", password)
	}
	if len(seen.Prompts) != 1 {
		t.Fatalf("프롬프트 = %+v, want 1개", seen.Prompts)
	}
	if !seen.Prompts[0].Masked {
		t.Error("비밀번호 칸이 가려지지 않았다")
	}
	if seen.Hop.Host != "10.0.0.9" {
		t.Errorf("hop = %+v, want 10.0.0.9", seen.Hop)
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
