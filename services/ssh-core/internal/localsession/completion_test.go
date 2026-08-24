package localsession

import (
	"io"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
)

type fakeRunner struct {
	done      chan struct{}
	shellKind string
	// output 이 있으면 Streams() 가 그것을 돌려준다 — 테스트가 셸 출력을 흘려 넣어 프롬프트
	// 안착까지 재현할 수 있다. 없으면 예전처럼 스트림이 없는 러너다.
	output io.Reader

	// 주입은 게이트 타이머(다른 goroutine)에서 쓰이므로 잠금이 필요하다.
	mu     sync.Mutex
	writes [][]byte
}

func (r *fakeRunner) Write(data []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.writes = append(r.writes, append([]byte(nil), data...))
	return nil
}

func (r *fakeRunner) writeCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.writes)
}

func (r *fakeRunner) writeAt(index int) []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.writes[index]
}

/** 최대 limit 동안 조건이 참이 되기를 기다린다. */
func waitFor(t *testing.T, limit time.Duration, check func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if check() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return check()
}

func (r *fakeRunner) Resize(int, int) error { return nil }
func (r *fakeRunner) Kill() error           { return nil }
func (r *fakeRunner) Close() error          { return nil }
func (r *fakeRunner) Streams() []io.Reader {
	if r.output == nil {
		return nil
	}
	return []io.Reader{r.output}
}
func (r *fakeRunner) Wait() (sessionExit, error) { <-r.done; return sessionExit{}, nil }
func (r *fakeRunner) ShellKind() string {
	if r.shellKind == "" {
		return "bash"
	}
	return r.shellKind
}

func newTestManager(runner sessionRunner) *Manager {
	return NewManagerWithRunnerFactory(
		func(protocol.Event) {},
		func(protocol.StreamFrame, []byte) {},
		func(protocol.LocalConnectPayload) (sessionRunner, error) { return runner, nil },
	)
}

func TestRunCompletionCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("RunCompletionCommand uses /bin/sh; local dynamic completion is unsupported on Windows")
	}
	runner := &fakeRunner{done: make(chan struct{})}
	defer close(runner.done)
	m := newTestManager(runner)
	if err := m.Connect("s1", "r1", protocol.LocalConnectPayload{}); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}

	out, truncated, err := m.RunCompletionCommand("s1", "printf 'a\\nb\\n'")
	if err != nil {
		t.Fatalf("RunCompletionCommand() error = %v", err)
	}
	if truncated {
		t.Fatal("did not expect truncation")
	}
	if strings.TrimSpace(out) != "a\nb" {
		t.Fatalf("unexpected output: %q", out)
	}

	if _, _, err := m.RunCompletionCommand("missing", "echo x"); err == nil {
		t.Fatal("expected error for unknown session")
	}
}

func TestInstallShellIntegrationUsesShellSpecificCommand(t *testing.T) {
	for _, tc := range []struct {
		name      string
		shellKind string
		want      string
		wantWrite bool
	}{
		{name: "bash", shellKind: "bash", want: autocomplete.BashShellIntegrationInitCommand(), wantWrite: true},
		{name: "zsh", shellKind: "zsh", want: autocomplete.ZshShellIntegrationInitCommand(), wantWrite: true},
		{name: "fish", shellKind: "fish", want: autocomplete.FishShellIntegrationInitCommand(), wantWrite: true},
		{name: "fish path", shellKind: "/usr/bin/fish", want: autocomplete.FishShellIntegrationInitCommand(), wantWrite: true},
		{name: "pwsh", shellKind: "pwsh", want: autocomplete.PowerShellIntegrationInitCommand(), wantWrite: true},
		{name: "powershell", shellKind: "powershell", want: autocomplete.PowerShellIntegrationInitCommand(), wantWrite: true},
		{name: "powershell exe", shellKind: "powershell.exe", want: autocomplete.PowerShellIntegrationInitCommand(), wantWrite: true},
		{name: "cmd", shellKind: "cmd", wantWrite: false},
		{name: "unknown", shellKind: "ksh", wantWrite: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// 주입은 첫 프롬프트 뒤로 미뤄진다 — 셸 출력을 흘려 넣어 그 순간을 만든다.
			reader, writer := io.Pipe()
			runner := &fakeRunner{
				done:      make(chan struct{}),
				shellKind: tc.shellKind,
				output:    reader,
			}
			defer close(runner.done)
			t.Cleanup(func() { _ = writer.Close() })
			m := newTestManager(runner)
			if err := m.Connect("s1", "r1", protocol.LocalConnectPayload{}); err != nil {
				t.Fatalf("Connect() error = %v", err)
			}
			if err := m.InstallShellIntegration("s1"); err != nil {
				t.Fatalf("InstallShellIntegration() error = %v", err)
			}
			if _, err := writer.Write([]byte("ready$ ")); err != nil {
				t.Fatalf("셸 출력 흘려 넣기 실패: %v", err)
			}
			if !tc.wantWrite {
				time.Sleep(400 * time.Millisecond)
				if runner.writeCount() != 0 {
					t.Fatalf("expected no writes, got %d", runner.writeCount())
				}
				return
			}
			if !waitFor(t, 2*time.Second, func() bool { return runner.writeCount() == 1 }) {
				t.Fatalf("expected one write, got %d", runner.writeCount())
			}
			if got := string(runner.writeAt(0)); got != tc.want {
				t.Fatalf("unexpected init command:\nwant %q\ngot  %q", tc.want, got)
			}
		})
	}
}

func TestInstallShellIntegrationMissingSession(t *testing.T) {
	runner := &fakeRunner{done: make(chan struct{})}
	defer close(runner.done)
	m := newTestManager(runner)
	if err := m.InstallShellIntegration("missing"); err == nil {
		t.Fatal("expected error for unknown session")
	}
}

// 접속 직후는 셸이 아직 준비되지 않았다 — 그 틈에 쓰면 canonical 모드의 한 줄 상한
// (MAX_CANON)에 스크립트가 잘려 실행되지 않고, 원문만 화면에 남는다. 프롬프트를 보고 쓴다.
func TestInstallShellIntegrationDoesNotWriteBeforeThePrompt(t *testing.T) {
	reader, writer := io.Pipe()
	runner := &fakeRunner{done: make(chan struct{}), output: reader}
	defer close(runner.done)
	t.Cleanup(func() { _ = writer.Close() })
	m := newTestManager(runner)
	if err := m.Connect("s1", "r1", protocol.LocalConnectPayload{}); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	if err := m.InstallShellIntegration("s1"); err != nil {
		t.Fatalf("InstallShellIntegration() error = %v", err)
	}

	// rc 파일이 도는 중이다 — 프롬프트가 아닌 출력에는 반응하지 않아야 한다.
	if _, err := writer.Write([]byte("Loading plugins...\r\n")); err != nil {
		t.Fatalf("셸 출력 흘려 넣기 실패: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	if runner.writeCount() != 0 {
		t.Fatalf("프롬프트도 오지 않았는데 주입했다: %q", runner.writeAt(0))
	}

	if _, err := writer.Write([]byte("user@host ~ % ")); err != nil {
		t.Fatalf("프롬프트 흘려 넣기 실패: %v", err)
	}
	if !waitFor(t, 2*time.Second, func() bool { return runner.writeCount() == 1 }) {
		t.Fatal("프롬프트가 떴는데도 주입하지 않았다")
	}
}

// 프롬프트를 못 알아본 경우에도 결국은 주입한다 — 쓰지 않으면 cwd·마커·자동완성이 조용히
// 전부 꺼진다. 그때는 이미 rc 가 끝나 줄 편집기가 올라와 있을 시간이다.
func TestInstallShellIntegrationWritesEvenWhenNoPromptIsRecognized(t *testing.T) {
	reader, writer := io.Pipe()
	runner := &fakeRunner{done: make(chan struct{}), output: reader}
	defer close(runner.done)
	t.Cleanup(func() { _ = writer.Close() })
	m := newTestManager(runner)
	if err := m.Connect("s1", "r1", protocol.LocalConnectPayload{}); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	if err := m.InstallShellIntegration("s1"); err != nil {
		t.Fatalf("InstallShellIntegration() error = %v", err)
	}
	// 끝 글자가 프롬프트 목록에 없는 테마.
	if _, err := writer.Write([]byte("user@host ~ ")); err != nil {
		t.Fatalf("셸 출력 흘려 넣기 실패: %v", err)
	}
	if !waitFor(t, installPromptMaxWait+2*time.Second, func() bool {
		return runner.writeCount() == 1
	}) {
		t.Fatal("기다린 뒤에도 주입하지 않았다")
	}
}
