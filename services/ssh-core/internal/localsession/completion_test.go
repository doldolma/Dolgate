package localsession

import (
	"io"
	"runtime"
	"strings"
	"testing"

	"dolssh/services/ssh-core/internal/protocol"
)

type fakeRunner struct{ done chan struct{} }

func (r *fakeRunner) Write([]byte) error         { return nil }
func (r *fakeRunner) Resize(int, int) error      { return nil }
func (r *fakeRunner) Kill() error                { return nil }
func (r *fakeRunner) Close() error               { return nil }
func (r *fakeRunner) Streams() []io.Reader       { return nil }
func (r *fakeRunner) Wait() (sessionExit, error) { <-r.done; return sessionExit{}, nil }
func (r *fakeRunner) ShellKind() string          { return "bash" }

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
