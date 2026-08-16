package runtime

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// tailnet 배선이 빠진 경로는 조용히 일반 네트워크로 나간다 — 실패가 아니라 "왜 tailnet 을
// 지정했는데 안 되지"로 보인다. 그래서 dial 을 여는 곳마다 실제로 dialer 를 쓰는지 소스로
// 확인한다. 각 소비자의 통합 테스트로는 SSH 서버가 필요해 여기서 대신 잡는다.
func TestEverySshConsumerWiresTheTailnetDialer(t *testing.T) {
	consumers := []struct {
		name string
		path string
		// viaSshdial 이면 이 경로는 직접 조립하지 않고 공통 dialer 를 쓴다. 그때 확인할 것은
		// "sshconn.Config 에 Dial 을 넣었는가" 가 아니라 "정말 그 경로로 가는가" 다.
		viaSshdial bool
	}{
		{name: "sshdial", path: "../../internal/sshdial/sshdial.go"},
		{name: "shell", path: "../../internal/sshsession/manager.go", viaSshdial: true},
		{name: "tmux", path: "../../internal/tmuxsession/manager.go", viaSshdial: true},
		{name: "mosh", path: "../../internal/moshsession/manager.go", viaSshdial: true},
		{name: "sftp", path: "../../internal/sftp/service.go"},
		{name: "containers", path: "../../internal/containers/service.go"},
		{name: "forwarding", path: "../../internal/forwarding/service.go"},
	}

	for _, consumer := range consumers {
		source, err := os.ReadFile(consumer.path)
		if err != nil {
			t.Fatalf("read %s: %v", consumer.path, err)
		}
		body := string(source)

		if consumer.viaSshdial {
			// 공통 경로를 쓰는 소비자는 그 경로로 붙기만 하면 된다 — tailnet 해석은 sshdial 이
			// 한다(이 목록의 첫 항목이 그것을 검사한다). 직접 DialClient 를 부르면 그 조립을
			// 다시 갖게 되므로 거기서 또 빠질 수 있다.
			if !strings.Contains(body, "dialer.Dial(") {
				t.Errorf("%s does not connect through sshdial — it would need its own tailnet wiring", consumer.name)
			}
			if strings.Contains(body, "sshconn.DialClient(") {
				t.Errorf("%s still calls sshconn.DialClient directly — that path skips the shared wiring", consumer.name)
			}
		} else {
			if !strings.Contains(body, "ResolveTailnetDial") &&
				!strings.Contains(body, "tailnetDialer(") {
				t.Errorf(
					"%s never resolves a tailnet dialer — connections for a tailnet host would go out on the plain network",
					consumer.name,
				)
			}
			// 만들기만 하고 Config 에 안 넣으면 아무 효과가 없다.
			if !strings.Contains(body, "Dial:") && !strings.Contains(body, "config.Dial =") {
				t.Errorf("%s resolves a dialer but never puts it on sshconn.Config", consumer.name)
			}
		}

		// mosh 는 두 단계다. bootstrap SSH 만 태우면 그 위의 UDP 세션이 일반 네트워크로 나가서
		// tailnet 안에만 있는 호스트에는 닿지 않는다 — 사용자에게는 "tailnet 설정했는데 mosh 만
		// 안 된다"로 보인다. UDP 구간도 같은 dialer 로 열어야 한다.
		if consumer.name == "mosh" && !strings.Contains(body, `dial(ctx, "udp`) {
			t.Errorf("mosh never opens its UDP leg through the tailnet dialer — the bootstrap would go through the tailnet but the session would not")
		}
	}
}

// 런타임이 여섯 소비자 전부에 리졸버를 넘기는지. 하나라도 빠지면 그 경로만 안 된다.
func TestRuntimeInjectsTheResolverIntoEveryConsumer(t *testing.T) {
	source, err := os.ReadFile("runtime.go")
	if err != nil {
		t.Fatalf("read runtime.go: %v", err)
	}
	body := string(source)

	for _, wiring := range []string{
		// 세션 계열 셋은 공유 dialer 하나를 통해 간다. 그것에 리졸버를 안 넣으면 셋 다 빠진다.
		"sessionDialer.SetTailnetDial",
		"sshsession.NewManagerWithConfig",
		"moshsession.NewManagerWithConfig",
		"tmuxsession.NewManagerWithConfig",
		"sftpService.SetTailnetDial",
		"containersService.SetTailnetDial",
		"forwardingService.SetTailnetDial",
	} {
		if !strings.Contains(body, wiring) {
			t.Errorf("runtime does not wire %s — that consumer ignores the host's tailnet", wiring)
		}
	}
}

// 세션 계열 셋이 **같은** dialer 를 받는지, 그리고 그 dialer 가 신뢰 질의 창구를 들고 있는지.
//
// 하나라도 자기 dialer 를 들면 대기표가 갈려서 응답이 조용히 버려지고, 창구가 빠지면 처음 보는
// 호스트에 붙을 방법 자체가 없어진다 — mosh·tmux 가 정확히 그 상태였다(코어는 "trusted host key
// is required" 로 끊는데 물어볼 곳이 없다). 세 매니저의 dialer 는 비공개라 소스로 확인한다.
func TestEverySessionKindSharesOneDialer(t *testing.T) {
	source, err := os.ReadFile("runtime.go")
	if err != nil {
		t.Fatalf("read runtime.go: %v", err)
	}
	body := string(source)

	if !strings.Contains(body, "sessionDialer.SetHostKeyTrustPrompt") {
		t.Error("공유 dialer 에 신뢰 질의 창구가 없다 — 처음 보는 호스트에 붙을 방법이 없어진다")
	}
	// 셋 다 같은 변수를 받아야 한다. 개수로 보면 하나만 빠뜨린 경우가 잡힌다.
	// (gofmt 가 필드 정렬을 바꾸므로 공백 폭에 기대지 않는다.)
	injections := regexp.MustCompile(`Dialer:\s+sessionDialer`).FindAllString(body, -1)
	if len(injections) != 3 {
		t.Errorf("Dialer: sessionDialer 주입 = %d곳, want 3 (shell·mosh·tmux)", len(injections))
	}
}
