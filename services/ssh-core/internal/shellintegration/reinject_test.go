package shellintegration

import (
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
)

// 이 규칙들은 전에 전송(ssh·tmux·aws·mobile)마다 한 벌씩 적혀 있었다. 한 곳으로 모은 뒤로는
// 여기서 잠가야 네 곳이 함께 지켜진다.

func armed(t *testing.T, target ReinjectTarget) *autocomplete.PromptSettleGate {
	t.Helper()
	gate := autocomplete.NewPromptSettleGate(5*time.Millisecond, time.Second)
	target.Gate = gate
	ArmReinject(target)
	return gate
}

func waitFor(t *testing.T, signal <-chan string, why string) string {
	t.Helper()
	select {
	case value := <-signal:
		return value
	case <-time.After(time.Second):
		t.Fatalf("%s", why)
		return ""
	}
}

func expectQuiet(t *testing.T, signal <-chan string, why string) {
	t.Helper()
	select {
	case value := <-signal:
		t.Fatalf("%s: %q", why, value)
	case <-time.After(80 * time.Millisecond):
	}
}

func TestArmReinjectRefusesShellsThatCannotTakeIt(t *testing.T) {
	// 이름을 아는데 훅을 걸 수 없는 셸이다. 프로브를 보내 봐야 화면에 오류만 남으므로
	// 기다리지도 않는다 — PowerShell 은 원격 PTY 로는 넣을 수 없고 dash 는 훅이 없다.
	for _, shell := range []string{"pwsh", "powershell", "dash", "ksh", "cmd"} {
		called := make(chan string, 2)
		gate := armed(t, ReinjectTarget{
			ShellHint: shell,
			Inject:    func(resolved string) { called <- "inject:" + resolved },
			Probe:     func() { called <- "probe" },
		})
		if gate.Armed() {
			t.Fatalf("%s: 기다릴 이유가 없는데 무장했다", shell)
		}
		gate.Observe([]byte("host$ "))
		expectQuiet(t, called, shell+": 아무것도 보내면 안 된다")
	}
}

func TestArmReinjectSendsOnlyTheNamedShellsCommand(t *testing.T) {
	called := make(chan string, 2)
	gate := armed(t, ReinjectTarget{
		ShellHint: "/usr/local/bin/zsh",
		Inject:    func(resolved string) { called <- "inject:" + resolved },
		Probe:     func() { called <- "probe" },
	})
	gate.Observe([]byte("host% "))
	// 경로째 넘겨도 셸 이름으로 정규화돼야 한다 — 주입 쪽은 이름만 안다.
	if got := waitFor(t, called, "주입이 오지 않았다"); got != "inject:zsh" {
		t.Fatalf("주입 = %q, want inject:zsh", got)
	}
}

func TestArmReinjectAsksTheShellWhenTheHintIsEmpty(t *testing.T) {
	called := make(chan string, 2)
	gate := armed(t, ReinjectTarget{
		Inject: func(resolved string) { called <- "inject:" + resolved },
		Probe:  func() { called <- "probe" },
	})
	gate.Observe([]byte("host$ "))
	if got := waitFor(t, called, "프로브가 오지 않았다"); got != "probe" {
		t.Fatalf("동작 = %q, want probe", got)
	}
}

func TestArmReinjectStaysQuietWhenTheSubshellNeverAppeared(t *testing.T) {
	// 진입 명령이 실패하면 원래 셸이 새 프롬프트를 그린다. 그 프롬프트에는 이미 우리 마커가
	// 있으므로 보내 봐야 프롬프트만 한 번 더 남는다.
	called := make(chan string, 2)
	finished := make(chan string, 1)
	gate := armed(t, ReinjectTarget{
		Finish: func() { finished <- "finish" },
		Inject: func(resolved string) { called <- "inject:" + resolved },
		Probe:  func() { called <- "probe" },
	})
	gate.Observe([]byte(autocomplete.PromptStartMarker + "host$ "))
	expectQuiet(t, called, "이미 통합된 프롬프트에 또 보냈다")
	// 붙잡아 둔 입력은 반드시 풀어 준다 — 안 그러면 사용자 키가 큐에 갇힌다.
	waitFor(t, finished, "Finish 가 불리지 않았다")
}

func TestArmReinjectDoesNotAskAShellThatAlreadySaidNo(t *testing.T) {
	called := make(chan string, 2)
	finished := make(chan string, 1)
	gate := armed(t, ReinjectTarget{
		Finish:      func() { finished <- "finish" },
		Unsupported: func() bool { return true },
		Probe:       func() { called <- "probe" },
	})
	gate.Observe([]byte("/ # "))
	expectQuiet(t, called, "이미 답을 들은 셸에 다시 물었다")
	waitFor(t, finished, "Finish 가 불리지 않았다")
}

func TestArmReinjectSkipsASessionThatWentAway(t *testing.T) {
	// 게이트는 무장하고 몇 초 뒤에 터질 수 있다. 그 사이 세션이 닫혔으면 쓸 곳이 없다.
	called := make(chan string, 2)
	finished := make(chan string, 1)
	gate := armed(t, ReinjectTarget{
		Alive:  func() bool { return false },
		Finish: func() { finished <- "finish" },
		Inject: func(resolved string) { called <- "inject:" + resolved },
		Probe:  func() { called <- "probe" },
	})
	gate.Observe([]byte("host$ "))
	expectQuiet(t, called, "닫힌 세션에 썼다")
	waitFor(t, finished, "Finish 가 불리지 않았다")
}

func TestArmReinjectReleasesHeldInputWhenNoPromptArrives(t *testing.T) {
	// 프롬프트가 창 안에 안 오면 아무것도 하지 않지만, 붙잡아 둔 입력은 놓아 줘야 한다.
	finished := make(chan string, 1)
	gate := autocomplete.NewPromptSettleGate(5*time.Millisecond, 20*time.Millisecond)
	ArmReinject(ReinjectTarget{
		Gate:   gate,
		Commit: func() {},
		Finish: func() { finished <- "finish" },
		Probe:  func() {},
	})
	waitFor(t, finished, "시간이 끝났는데 입력을 놓아 주지 않았다")
}
