package runtime

import (
	"os"
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
	}{
		{"shell", "../../internal/sshsession/manager.go"},
		{"tmux", "../../internal/tmuxsession/manager.go"},
		{"mosh", "../../internal/moshsession/manager.go"},
		{"sftp", "../../internal/sftp/service.go"},
		{"containers", "../../internal/containers/service.go"},
		{"forwarding", "../../internal/forwarding/service.go"},
	}

	for _, consumer := range consumers {
		source, err := os.ReadFile(consumer.path)
		if err != nil {
			t.Fatalf("read %s: %v", consumer.path, err)
		}
		body := string(source)

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
		"sshsession.NewManagerWithConfig",
		"moshsession.NewManagerWithConfig",
		"sftpService.SetTailnetDial",
		"containersService.SetTailnetDial",
		"forwardingService.SetTailnetDial",
		"instance.tmux.SetTailnetDial",
	} {
		if !strings.Contains(body, wiring) {
			t.Errorf("runtime does not wire %s — that consumer ignores the host's tailnet", wiring)
		}
	}
}
