package tmuxsession

import (
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"

	"golang.org/x/crypto/ssh"
)

// stubPanePrompt 는 tmux 서버 대신 정해진 pane 상태를 돌려준다.
func stubPanePrompt(state paneState) func(*ssh.Client, string) paneState {
	return func(*ssh.Client, string) paneState { return state }
}

// pane 의 셸은 연결보다 오래 산다 — 재연결은 하던 일 그대로인 옛 셸로 돌아온다. 그래서 설치
// 시점에 pane 앞에 vi 가 떠 있을 수 있고, 예전에는 거기에 프로브 한 줄을 그대로 타이핑해서
// 사용자가 편집 중인 파일에 셸 명령이 들어갔다.
func TestInstallShellIntegrationDoesNotTypeIntoAForegroundProgram(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state paneState
	}{
		{"vi 로 편집 중", paneState{command: "vi", cursorX: 17, known: true}},
		{"htop 이 떠 있음", paneState{command: "htop", alternateOn: true, cursorX: 17, known: true}},
		{"tmux copy mode", paneState{command: "bash", inMode: true, cursorX: 17, known: true}},
		{"tmux 가 답하지 않음", paneState{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, _, recorder := newReinjectHarness(t)
			m.panePrompt = stubPanePrompt(tc.state)

			if err := m.InstallShellIntegration(paneSessionID("ctl", "%0")); err != nil {
				t.Fatalf("install: %v", err)
			}
			time.Sleep(700 * time.Millisecond) // 안착 대기(400ms)보다 넉넉히
			if got := recorder.snapshot(); got != "" {
				t.Fatalf("셸이 아닌 것이 앞에 있는데 pane 에 썼다: %q", decodePaneStdin(got))
			}
		})
	}
}

// 분할·새 창 직후의 bash: 떴지만 첫 프롬프트를 아직 안 그렸다(커서 0,0). 그때 타이핑하면
// tty 가 먼저 에코하고 readline 이 프롬프트 뒤에 다시 에코해 **두 줄**이 남는다(실기기 %143).
// 프롬프트가 그려질 때까지 미루고, 그려지면 그때 심는다.
func TestInstallShellIntegrationWaitsForTheFirstPrompt(t *testing.T) {
	m, handle, recorder := newReinjectHarness(t)
	m.panePrompt = stubPanePrompt(paneState{command: "bash", cursorX: 0, cursorY: 0, known: true})

	if err := m.InstallShellIntegration(paneSessionID("ctl", "%0")); err != nil {
		t.Fatalf("install: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if got := recorder.snapshot(); got != "" {
		t.Fatalf("프롬프트도 안 그려졌는데 타이핑했다: %q", decodePaneStdin(got))
	}
	// bash 가 첫 프롬프트를 그린다.
	handle.observePaneOutput("%0", []byte("ubuntu@box:~$ "))
	if !waitForStdin(t, recorder, "dg-shell", 3*time.Second) {
		t.Fatalf("프롬프트가 그려졌는데 심지 않았다: %q", recorder.snapshot())
	}
}

// 프롬프트가 돌아오면 그때 설치한다. 미룬 것이지 포기한 것이 아니다 — vi 를 닫고 나면
// 그 pane 에서도 자동완성이 살아야 한다.
func TestInstallShellIntegrationInstallsWhenThePanePromptReturns(t *testing.T) {
	m, handle, recorder := newReinjectHarness(t)
	m.panePrompt = stubPanePrompt(paneState{command: "vi", cursorX: 17, known: true})

	if err := m.InstallShellIntegration(paneSessionID("ctl", "%0")); err != nil {
		t.Fatalf("install: %v", err)
	}
	// vi 가 그리는 화면에는 반응하지 않는다.
	handle.observePaneOutput("%0", []byte("-- INSERT --"))
	time.Sleep(200 * time.Millisecond)
	if got := recorder.snapshot(); got != "" {
		t.Fatalf("vi 화면을 프롬프트로 봤다: %q", decodePaneStdin(got))
	}

	// :q 로 빠져나와 셸 프롬프트가 안착한다.
	handle.observePaneOutput("%0", []byte("ubuntu@box:~$ "))
	if !waitForStdin(t, recorder, "dg-shell", 3*time.Second) {
		t.Fatalf("프롬프트가 돌아왔는데 설치하지 않았다: %q", recorder.snapshot())
	}
}

// 재연결의 정상 경로: pane 의 bash 는 detach 를 넘어 살아 있고 훅도 그대로다. 프롬프트에
// 우리 마커가 이미 있으면 아무것도 쓰지 않는다.
func TestInstallShellIntegrationSkipsAPaneThatStillHasTheHooks(t *testing.T) {
	m, handle, recorder := newReinjectHarness(t)
	m.panePrompt = stubPanePrompt(paneState{command: "vi", cursorX: 17, known: true})

	if err := m.InstallShellIntegration(paneSessionID("ctl", "%0")); err != nil {
		t.Fatalf("install: %v", err)
	}
	handle.observePaneOutput("%0", []byte(autocomplete.PromptStartMarker+"ubuntu@box:~$ "))
	time.Sleep(700 * time.Millisecond)
	if got := recorder.snapshot(); got != "" {
		t.Fatalf("이미 훅이 있는 프롬프트에 다시 주입했다: %q", decodePaneStdin(got))
	}
}

// 프롬프트에 있으면 pane_current_command 가 셸 이름 자체다 — 그 답을 tmux 가 이미 갖고 있으니
// "누구냐" 를 pane 에 타이핑할 이유가 없다.
func TestInstallShellIntegrationSkipsTheProbeWhenTmuxNamesTheShell(t *testing.T) {
	m, _, recorder := newReinjectHarness(t)
	m.panePrompt = stubPanePrompt(paneState{command: "bash", cursorX: 17, known: true})

	if err := m.InstallShellIntegration(paneSessionID("ctl", "%0")); err != nil {
		t.Fatalf("install: %v", err)
	}
	if !waitForStdin(t, recorder, "BASH_VERSION", 3*time.Second) {
		t.Fatalf("bash 스크립트를 보내지 않았다: %q", recorder.snapshot())
	}
	if decoded := decodePaneStdin(recorder.snapshot()); strings.Contains(decoded, "dg-shell") {
		t.Fatalf("tmux 가 셸을 알려줬는데도 프로브를 타이핑했다: %q", decoded)
	}
}

// 같은 연결에서는 한 pane 에 한 번만 설치한다(윈도우 전환마다 renderer 가 다시 부른다).
func TestInstallShellIntegrationInstallsOncePerPane(t *testing.T) {
	m, _, recorder := newReinjectHarness(t)
	m.panePrompt = stubPanePrompt(paneState{command: "bash", cursorX: 17, known: true})
	paneSession := paneSessionID("ctl", "%0")

	if err := m.InstallShellIntegration(paneSession); err != nil {
		t.Fatalf("install: %v", err)
	}
	if !waitForStdin(t, recorder, "BASH_VERSION", 3*time.Second) {
		t.Fatalf("첫 설치가 없었다: %q", recorder.snapshot())
	}
	first := decodePaneStdin(recorder.snapshot())

	if err := m.InstallShellIntegration(paneSession); err != nil {
		t.Fatalf("install 2: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if got := decodePaneStdin(recorder.snapshot()); got != first {
		t.Fatalf("같은 pane 에 두 번 주입했다:\n첫번째: %q\n이후: %q", first, got)
	}
}

// 미룬 경로는 플래그를 쓰지 않고 둔다 — 프롬프트를 못 보고 시간이 지나가도 다음 호출이
// 다시 시도할 수 있어야 한다.
func TestInstallShellIntegrationRetriesAfterADeferredAttempt(t *testing.T) {
	m, _, recorder := newReinjectHarness(t)
	m.panePrompt = stubPanePrompt(paneState{command: "vi", cursorX: 17, known: true})
	paneSession := paneSessionID("ctl", "%0")

	if err := m.InstallShellIntegration(paneSession); err != nil {
		t.Fatalf("install: %v", err)
	}
	// 이제 사용자가 vi 를 닫았고, renderer 가 윈도우 전환으로 다시 부른다.
	m.panePrompt = stubPanePrompt(paneState{command: "bash", cursorX: 17, known: true})
	if err := m.InstallShellIntegration(paneSession); err != nil {
		t.Fatalf("install 2: %v", err)
	}
	if !waitForStdin(t, recorder, "BASH_VERSION", 3*time.Second) {
		t.Fatalf("미룬 뒤의 재시도가 설치하지 않았다: %q", recorder.snapshot())
	}
}

// control 세션 자체(pane 아님)에는 할 일이 없다 — tmux 에 물어보지도 않는다.
func TestInstallShellIntegrationIgnoresNonPaneSessions(t *testing.T) {
	m, _, recorder := newReinjectHarness(t)
	asked := false
	m.panePrompt = func(*ssh.Client, string) paneState {
		asked = true
		return paneState{command: "bash", cursorX: 17, known: true}
	}
	if err := m.InstallShellIntegration("ctl"); err != nil {
		t.Fatalf("install: %v", err)
	}
	if asked {
		t.Error("pane 이 아닌 세션인데 tmux 에 물었다")
	}
	if got := recorder.snapshot(); got != "" {
		t.Fatalf("control 세션에 썼다: %q", got)
	}
}
