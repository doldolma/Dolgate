package localsession

import (
	"io"
	"runtime"
	"strings"
	"testing"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
)

type fakeRunner struct {
	done      chan struct{}
	shellKind string
	writes    [][]byte
}

func (r *fakeRunner) Write(data []byte) error {
	r.writes = append(r.writes, append([]byte(nil), data...))
	return nil
}
func (r *fakeRunner) Resize(int, int) error      { return nil }
func (r *fakeRunner) Kill() error                { return nil }
func (r *fakeRunner) Close() error               { return nil }
func (r *fakeRunner) Streams() []io.Reader       { return nil }
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
		{name: "bash", shellKind: "bash", want: autocomplete.ShellIntegrationInitCommand(), wantWrite: true},
		{name: "zsh", shellKind: "zsh", want: autocomplete.ShellIntegrationInitCommand(), wantWrite: true},
		{name: "fish", shellKind: "fish", want: autocomplete.FishShellIntegrationInitCommand(), wantWrite: true},
		{name: "fish path", shellKind: "/usr/bin/fish", want: autocomplete.FishShellIntegrationInitCommand(), wantWrite: true},
		{name: "pwsh", shellKind: "pwsh", want: autocomplete.PowerShellIntegrationInitCommand(), wantWrite: true},
		{name: "powershell", shellKind: "powershell", want: autocomplete.PowerShellIntegrationInitCommand(), wantWrite: true},
		{name: "powershell exe", shellKind: "powershell.exe", want: autocomplete.PowerShellIntegrationInitCommand(), wantWrite: true},
		{name: "cmd", shellKind: "cmd", wantWrite: false},
		{name: "unknown", shellKind: "ksh", wantWrite: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runner := &fakeRunner{done: make(chan struct{}), shellKind: tc.shellKind}
			defer close(runner.done)
			m := newTestManager(runner)
			if err := m.Connect("s1", "r1", protocol.LocalConnectPayload{}); err != nil {
				t.Fatalf("Connect() error = %v", err)
			}
			if err := m.InstallShellIntegration("s1"); err != nil {
				t.Fatalf("InstallShellIntegration() error = %v", err)
			}
			if !tc.wantWrite {
				if len(runner.writes) != 0 {
					t.Fatalf("expected no writes, got %q", runner.writes)
				}
				return
			}
			if len(runner.writes) != 1 {
				t.Fatalf("expected one write, got %d", len(runner.writes))
			}
			if got := string(runner.writes[0]); got != tc.want {
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
