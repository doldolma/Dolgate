package tmuxsession

import (
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/pkg/coretypes"

	"golang.org/x/crypto/ssh"
)

// stubPanePrompt 는 tmux 서버 대신 정해진 pane 상태를 돌려준다.
func stubPanePrompt(state paneState) func(*ssh.Client, string) paneState {
	return func(*ssh.Client, string) paneState { return state }
}

// mutablePaneState 는 테스트 중에 바뀌는 pane 상태다 — 셸이 뜨고, 프롬프트가 그려지고, vi 가 닫힌다.
type mutablePaneState struct {
	mu    sync.Mutex
	state paneState
}

func newMutablePaneState(initial paneState) *mutablePaneState {
	return &mutablePaneState{state: initial}
}

func (p *mutablePaneState) set(state paneState) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.state = state
}

func (p *mutablePaneState) query(*ssh.Client, string) paneState {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.state
}

func TestInstallShellIntegrationRestoresAutocompleteBeforeInput(t *testing.T) {
	for _, shell := range []string{"bash", "zsh", "fish"} {
		t.Run(shell, func(t *testing.T) {
			m, _, recorder := newReinjectHarness(t)
			m.panePrompt = stubPanePrompt(paneState{
				command: shell, integrated: true, known: true, cursorX: 17, cwd: "/srv/my project",
			})
			var events []coretypes.Event
			m.emit = func(event coretypes.Event) { events = append(events, event) }
			m.emitStream = func(coretypes.StreamFrame, []byte) {
				t.Error("복원 확인은 화면에 프롬프트를 합성하면 안 된다")
			}
			sessionID := paneSessionID("ctl", "%0")
			// 재연결과 같은 연결의 renderer 재마운트 모두 첫 입력 전에 준비돼야 한다.
			for i := 0; i < 2; i++ {
				if err := m.InstallShellIntegration(sessionID); err != nil {
					t.Fatal(err)
				}
				if len(events) != i+1 {
					t.Fatalf("사용자 입력 전에 준비 상태가 와야 한다: %+v", events)
				}
				event := events[i]
				want := coretypes.TerminalAutocompleteShellStatePayload{
					Kind: "integrationRestored", Shell: shell, Cwd: "/srv/my project",
				}
				if event.Type != coretypes.EventTerminalAutocompleteShellState || event.SessionID != sessionID || event.Payload != want {
					t.Fatalf("잘못된 준비 이벤트: %+v", event)
				}
			}
			if got := recorder.snapshot(); got != "" {
				t.Fatalf("복원 중 pane 에 입력했다: %q", got)
			}
		})
	}
}

func TestInstallShellIntegrationDoesNotRestoreAutocompleteOutsideConfirmedShellPrompt(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state paneState
	}{
		{"vi", paneState{command: "vi", integrated: true, known: true, cursorX: 17}},
		{"실행 중", paneState{command: "sleep", integrated: true, known: true, cursorX: 17}},
		{"대체화면", paneState{command: "bash", integrated: true, known: true, cursorX: 17, alternateOn: true}},
		{"copy mode", paneState{command: "bash", integrated: true, known: true, cursorX: 17, inMode: true}},
		{"조회 실패", paneState{integrated: true}},
		{"프롬프트 전", paneState{command: "bash", integrated: true, known: true}},
		{"설치 확인 전", paneState{command: "bash", known: true, cursorX: 17}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, handle, recorder := newReinjectHarness(t)
			m.panePrompt = stubPanePrompt(tc.state)
			// 메모리의 주입 시도 플래그만으로 확인이 끝났다고 판단하면 안 된다.
			handle.markIntegrated("%0")
			m.emit = func(event coretypes.Event) { t.Errorf("준비로 오인했다: %+v", event) }
			if err := m.InstallShellIntegration(paneSessionID("ctl", "%0")); err != nil {
				t.Fatal(err)
			}
			if got := recorder.snapshot(); got != "" {
				t.Fatalf("pane 에 입력했다: %q", got)
			}
		})
	}
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
	pane := newMutablePaneState(paneState{command: "bash", cursorX: 0, cursorY: 0, known: true})
	m.panePrompt = pane.query

	if err := m.InstallShellIntegration(paneSessionID("ctl", "%0")); err != nil {
		t.Fatalf("install: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if got := recorder.snapshot(); got != "" {
		t.Fatalf("프롬프트도 안 그려졌는데 타이핑했다: %q", decodePaneStdin(got))
	}
	// bash 가 첫 프롬프트를 그린다 — tmux 는 이제 커서가 프롬프트 뒤에 있다고 답한다.
	pane.set(paneState{command: "bash", cursorX: 17, cursorY: 0, known: true})
	handle.observePaneOutput("%0", []byte("ubuntu@box:~$ "))
	// 프롬프트에 있으면 tmux 가 셸 이름을 알려 주므로 프로브 없이 그 셸 것을 바로 심는다.
	if !waitForStdin(t, recorder, "BASH_VERSION", 3*time.Second) {
		t.Fatalf("프롬프트가 그려졌는데 심지 않았다: %q", recorder.snapshot())
	}
}

// 프롬프트를 **모양으로 알아보지 않는다.** zsh 의 RPROMPT 는 프롬프트 뒤에 시각·git 브랜치를 그려서
// 출력 꼬리가 `$ # % >` 로 끝나지 않는다 — 그 모양만 보던 때는 새 창·분할 pane 에 영영 심지 못했다
// (첫 pane 은 이미 그려진 뒤라 무사해서 "첫 pane 만 된다" 로 보였다). tmux 가 말해 주는 pane 상태가
// 정답이다.
func TestInstallShellIntegrationDoesNotJudgeThePromptByItsShape(t *testing.T) {
	for _, tc := range []struct {
		name string
		tail string
	}{
		{"zsh RPROMPT(시각)", "user@host ~ % [14:08]"},
		{"λ 로 끝나는 프롬프트", "~ λ "},
		{"두 줄 프롬프트, 둘째 줄이 화살표", "~/src (main)\r\n→ "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, handle, recorder := newReinjectHarness(t)
			pane := newMutablePaneState(paneState{command: "zsh", cursorX: 0, cursorY: 0, known: true})
			m.panePrompt = pane.query
			if err := m.InstallShellIntegration(paneSessionID("ctl", "%0")); err != nil {
				t.Fatalf("install: %v", err)
			}
			pane.set(paneState{command: "zsh", cursorX: 24, cursorY: 0, known: true})
			handle.observePaneOutput("%0", []byte(tc.tail))
			if !waitForStdin(t, recorder, "__ds_o", 3*time.Second) {
				t.Fatalf("프롬프트가 그려졌는데(커서 24열) 꼬리 모양 때문에 심지 않았다: %q", recorder.snapshot())
			}
		})
	}
}

// 잠잠해졌다고 곧 프롬프트인 것은 아니다 — vi 도 다 그리고 나면 조용하다. 그때는 심지 않고 다음에
// 잠잠해질 때 다시 묻는다. 미룬 것이지 포기한 것이 아니다.
func TestInstallShellIntegrationKeepsAskingWhileTheScreenIsNotAPrompt(t *testing.T) {
	m, handle, recorder := newReinjectHarness(t)
	pane := newMutablePaneState(paneState{command: "vi", alternateOn: true, cursorX: 5, known: true})
	m.panePrompt = pane.query
	if err := m.InstallShellIntegration(paneSessionID("ctl", "%0")); err != nil {
		t.Fatalf("install: %v", err)
	}
	for i := 0; i < 3; i++ {
		handle.observePaneOutput("%0", []byte("-- INSERT --"))
		time.Sleep(600 * time.Millisecond)
	}
	if got := recorder.snapshot(); got != "" {
		t.Fatalf("vi 가 조용해졌다고 타이핑했다: %q", decodePaneStdin(got))
	}
	// :q 로 나와 프롬프트가 그려진다.
	pane.set(paneState{command: "bash", cursorX: 17, known: true})
	handle.observePaneOutput("%0", []byte("ubuntu@box:~$ "))
	if !waitForStdin(t, recorder, "BASH_VERSION", 3*time.Second) {
		t.Fatalf("프롬프트가 돌아왔는데 다시 묻지 않았다(첫 정착에서 포기했다): %q", recorder.snapshot())
	}
}

// 프롬프트가 그려진 뒤 출력이 더 없으면 잠잠해질 기회가 없다. 상한에 닿았을 때 마지막으로 한 번 본다.
func TestInstallShellIntegrationTakesALastLookWhenTheWaitRunsOut(t *testing.T) {
	m, handle, recorder := newReinjectHarness(t)
	pane := newMutablePaneState(paneState{command: "bash", cursorX: 0, known: true})
	m.panePrompt = pane.query
	// 이 테스트는 상한을 짧게 둔 게이트로 pane 을 미리 채운다(기본 20초는 단위 테스트에 길다).
	handle.handshakesMu.Lock()
	if handle.reinjectGates == nil {
		handle.reinjectGates = map[string]*autocomplete.PromptSettleGate{}
	}
	handle.reinjectGates["%0"] = autocomplete.NewPromptSettleGate(50*time.Millisecond, 400*time.Millisecond)
	handle.handshakesMu.Unlock()

	if err := m.InstallShellIntegration(paneSessionID("ctl", "%0")); err != nil {
		t.Fatalf("install: %v", err)
	}
	// 프롬프트는 그려졌지만(커서 17열) 그 뒤로 pane 출력은 한 바이트도 오지 않는다.
	pane.set(paneState{command: "bash", cursorX: 17, known: true})
	if !waitForStdin(t, recorder, "BASH_VERSION", 3*time.Second) {
		t.Fatalf("상한에 닿았는데 마지막으로 보지 않았다: %q", recorder.snapshot())
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

	// :q 로 빠져나와 셸 프롬프트가 안착한다 — tmux 가 이제 bash 가 프롬프트에 있다고 답한다.
	m.panePrompt = stubPanePrompt(paneState{command: "bash", cursorX: 17, known: true})
	handle.observePaneOutput("%0", []byte("ubuntu@box:~$ "))
	if !waitForStdin(t, recorder, "BASH_VERSION", 3*time.Second) {
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
	// vi 를 닫고 돌아온 프롬프트에는 우리 마커가 있고, tmux 서버의 표식도 그대로다.
	m.panePrompt = stubPanePrompt(paneState{command: "bash", cursorX: 17, integrated: true, known: true})
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
