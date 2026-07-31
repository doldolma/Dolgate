package tailnet

import "strings"

import "testing"

// 컨트롤 플레인은 키가 틀렸다는 오류에 키를 실어 보낸다. 그 문장이 화면·로그·스크린샷에 그대로
// 남았다 — 실기기에서 그렇게 발견됐다.
func TestRedactAuthKeyHidesTheKeyItGotBack(t *testing.T) {
	key := "tskey-auth-k66ACdUAcB11CNTRL-9xQqPmVv"

	// 서버가 키 전체를 돌려준 경우.
	whole := redactAuthKey("invalid key: API key "+key+" not valid", key)
	if strings.Contains(whole, key) {
		t.Errorf("키가 그대로 남았다: %q", whole)
	}

	// 실제로 본 형태 — 서버는 키 ID 부분만 돌려준다.
	part := redactAuthKey("invalid key: API key k66ACdUAcB11CNTRL not valid", key)
	if strings.Contains(part, "k66ACdUAcB11CNTRL") {
		t.Errorf("키 조각이 그대로 남았다: %q", part)
	}

	// 어느 키가 문제인지는 알 수 있어야 한다. 전부 가리면 tailnet 이 여러 개일 때 못 고친다.
	if !strings.Contains(part, "k66A"+secretMask) {
		t.Errorf("앞자리를 남기지 않았다: %q", part)
	}
	// 나머지 문장은 살아 있어야 한다 — 무엇이 문제인지는 그 문장이 말해 준다.
	if !strings.Contains(part, "invalid key") || !strings.Contains(part, "not valid") {
		t.Errorf("문장이 망가졌다: %q", part)
	}
}

// 문장 부호가 붙어 와도 가려야 한다. 붙은 채로 비교하면 일치가 깨져 그대로 노출된다.
func TestRedactAuthKeyHandlesTrailingPunctuation(t *testing.T) {
	key := "tskey-auth-k66ACdUAcB11CNTRL-9xQqPmVv"

	got := redactAuthKey("rejected key k66ACdUAcB11CNTRL.", key)

	if strings.Contains(got, "k66ACdUAcB11CNTRL") {
		t.Errorf("키 조각이 남았다: %q", got)
	}
	if !strings.HasSuffix(got, ".") {
		t.Errorf("문장 부호를 잃었다: %q", got)
	}
}

// 설정을 모르는 경로의 안전망. tskey- 로 시작하는 토큰은 그 자체로 키다.
func TestRedactAuthKeyHidesTailscaleKeysWithoutKnowingTheConfig(t *testing.T) {
	got := redactAuthKey("used tskey-auth-abcdefghijklmnop for this node", "")

	if strings.Contains(got, "abcdefghijklmnop") {
		t.Errorf("키가 남았다: %q", got)
	}
}

// 흔한 낱말이 키의 부분 문자열이라는 이유로 가려지면 안 된다. 오류 문장이 읽을 수 없게 된다.
func TestRedactAuthKeyKeepsOrdinaryWords(t *testing.T) {
	// "key"·"auth" 는 키 안에 들어 있는 짧은 낱말이다.
	key := "tskey-auth-k66ACdUAcB11CNTRL-9xQqPmVv"

	got := redactAuthKey("invalid key: API key not valid", key)

	if got != "invalid key: API key not valid" {
		t.Errorf("멀쩡한 문장을 고쳤다: %q", got)
	}
}

// 가리는 함수가 있어도 부르지 않으면 의미가 없다. 밖으로 나가는 두 값(LoginError·Health)이
// 실제로 가려진 채 나가는지 여기서 본다.
func TestMergeBusStateRedactsWhatLeavesTheCore(t *testing.T) {
	key := "tskey-auth-k66ACdUAcB11CNTRL-9xQqPmVv"
	reason := "invalid key: API key k66ACdUAcB11CNTRL not valid"

	merged := mergeBusState(
		Status{State: StateNeedsAuth, Health: []string{
			"You are logged out. The last login error was: " + reason,
		}},
		busState{loginError: reason, backendError: reason},
		key,
	)

	if strings.Contains(merged.LoginError, "k66ACdUAcB11CNTRL") {
		t.Errorf("LoginError 에 키가 남았다: %q", merged.LoginError)
	}
	if len(merged.Health) != 1 || strings.Contains(merged.Health[0], "k66ACdUAcB11CNTRL") {
		t.Errorf("Health 에 키가 남았다: %q", merged.Health)
	}
	// 이유 자체는 남아야 한다 — 무엇이 문제인지 알려 주는 값이다.
	if !strings.Contains(merged.LoginError, "invalid key") {
		t.Errorf("이유가 사라졌다: %q", merged.LoginError)
	}
}

// 원본 슬라이스를 제자리에서 고치면 백엔드가 들고 있는 값을 오염시킨다.
func TestMergeBusStateDoesNotTouchTheOriginalHealth(t *testing.T) {
	key := "tskey-auth-k66ACdUAcB11CNTRL-9xQqPmVv"
	original := []string{"rejected key k66ACdUAcB11CNTRL"}

	mergeBusState(Status{Health: original}, busState{}, key)

	if !strings.Contains(original[0], "k66ACdUAcB11CNTRL") {
		t.Errorf("원본을 고쳤다: %q", original)
	}
}

// 링크가 상태에 없고 버스에만 있는 경로가 있다(만료된 노드의 재인증). 합치지 않으면 화면이
// 링크를 영원히 기다린다.
func TestMergeBusStateFillsInTheAuthURLFromTheBus(t *testing.T) {
	merged := mergeBusState(Status{State: StateNeedsAuth}, busState{authURL: "https://login"}, "")
	if merged.AuthURL != "https://login" {
		t.Errorf("AuthURL = %q, want the one from the bus", merged.AuthURL)
	}

	// 상태에 이미 있으면 그것이 최신이다 — 버스에 남은 낡은 링크로 덮으면 안 된다.
	kept := mergeBusState(Status{AuthURL: "https://fresh"}, busState{authURL: "https://stale"}, "")
	if kept.AuthURL != "https://fresh" {
		t.Errorf("AuthURL = %q, want the one already in the status", kept.AuthURL)
	}
}

// 키가 없는 tailnet(브라우저 로그인)의 문장은 건드릴 것이 없다.
func TestRedactAuthKeyLeavesTextAloneWithoutAKey(t *testing.T) {
	const text = "You are logged out."

	if got := redactAuthKey(text, ""); got != text {
		t.Errorf("got %q, want %q", got, text)
	}
	if got := redactAuthKey("", "tskey-auth-abcdefgh"); got != "" {
		t.Errorf("got %q, want empty", got)
	}
}
