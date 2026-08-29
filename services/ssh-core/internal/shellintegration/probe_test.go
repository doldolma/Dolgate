package shellintegration

import (
	"errors"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
)

func TestProbeShellThenInjectReportsSupportedShell(t *testing.T) {
	var probe autocomplete.ShellProbe
	var handshake autocomplete.Handshake
	result := make(chan string, 1)
	command := autocomplete.ShellProbeCommand()
	err := ProbeShellThenInject(ProbeTarget{
		Probe: &probe, Handshake: &handshake, ProbeCommand: command,
		Write: func(data []byte) error {
			if string(data) != command {
				t.Fatalf("write = %q", data)
			}
			return nil
		},
		OnShell: func(shell string) { result <- shell },
		Timeout: time.Second,
	})
	if err != nil {
		t.Fatalf("ProbeShellThenInject() error = %v", err)
	}
	probe.Observe([]byte("\x1b]1337;dg-shell=5.2|||\x07"))
	select {
	case shell := <-result:
		if shell != "bash" {
			t.Fatalf("shell = %q", shell)
		}
	case <-time.After(time.Second):
		t.Fatal("supported shell was not reported")
	}
}

func TestProbeShellThenInjectFlushesWriteFailure(t *testing.T) {
	var probe autocomplete.ShellProbe
	var handshake autocomplete.Handshake
	var mu sync.Mutex
	var emitted []byte
	wantErr := errors.New("write failed")
	err := ProbeShellThenInject(ProbeTarget{
		Probe: &probe, Handshake: &handshake,
		ProbeCommand: autocomplete.ShellProbeCommand(),
		Write:        func([]byte) error { return wantErr },
		Emit:         func(data []byte) { mu.Lock(); emitted = append(emitted, data...); mu.Unlock() },
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("error = %v", err)
	}
	probe.Observe([]byte("\x1b]1337;dg-shell=5.2|||\x07"))
	mu.Lock()
	defer mu.Unlock()
	if len(emitted) != 0 {
		t.Fatalf("unexpected emitted data %q", emitted)
	}
}

func TestProbeShellThenInjectReportsUnsupportedShell(t *testing.T) {
	var probe autocomplete.ShellProbe
	var handshake autocomplete.Handshake
	unsupported := make(chan struct{}, 1)
	command := autocomplete.ShellProbeCommand()
	if err := ProbeShellThenInject(ProbeTarget{
		Probe: &probe, Handshake: &handshake, ProbeCommand: command,
		Write:         func([]byte) error { return nil },
		OnUnsupported: func() { unsupported <- struct{}{} },
		Timeout:       time.Second,
	}); err != nil {
		t.Fatal(err)
	}
	reply := []byte("\x1b]1337;dg-shell=|||\x07")
	probe.Observe(reply)
	_ = handshake.Filter(reply)
	select {
	case <-unsupported:
	case <-time.After(time.Second):
		t.Fatal("unsupported shell was not reported")
	}
}

func TestProbeShellThenInjectSkipsEmptyCommand(t *testing.T) {
	var probe autocomplete.ShellProbe
	var handshake autocomplete.Handshake
	writes := 0
	unsupported := 0
	if err := ProbeShellThenInject(ProbeTarget{
		Probe: &probe, Handshake: &handshake,
		Write:         func([]byte) error { writes++; return nil },
		OnUnsupported: func() { unsupported++ },
	}); err != nil {
		t.Fatal(err)
	}
	if writes != 0 || unsupported != 1 {
		t.Fatalf("writes = %d, unsupported = %d", writes, unsupported)
	}
}

func TestProbeShellThenInjectFlushesOnTimeout(t *testing.T) {
	var probe autocomplete.ShellProbe
	var handshake autocomplete.Handshake
	emitted := make(chan string, 1)
	if err := ProbeShellThenInject(ProbeTarget{
		Probe: &probe, Handshake: &handshake,
		ProbeCommand: autocomplete.ShellProbeCommand(),
		Write:        func([]byte) error { return nil },
		Emit:         func(data []byte) { emitted <- string(data) },
		Timeout:      20 * time.Millisecond,
	}); err != nil {
		t.Fatal(err)
	}
	if visible := handshake.Filter([]byte("held output")); len(visible) != 0 {
		t.Fatalf("output was not held: %q", visible)
	}
	select {
	case got := <-emitted:
		if got != "held output" {
			t.Fatalf("emitted = %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out output was not flushed")
	}
}

func TestOldProbeTimeoutDoesNotFlushNewHandshake(t *testing.T) {
	var probe autocomplete.ShellProbe
	var handshake autocomplete.Handshake
	var mu sync.Mutex
	var emitted []byte
	first := ProbeTarget{
		Probe: &probe, Handshake: &handshake,
		ProbeCommand: autocomplete.ShellProbeCommand(),
		Write:        func([]byte) error { return nil },
		Emit:         func(data []byte) { mu.Lock(); emitted = append(emitted, data...); mu.Unlock() },
		Timeout:      20 * time.Millisecond,
	}
	if err := ProbeShellThenInject(first); err != nil {
		t.Fatal(err)
	}
	second := first
	second.Timeout = time.Second
	if err := ProbeShellThenInject(second); err != nil {
		t.Fatal(err)
	}
	if visible := handshake.Filter([]byte("second-attempt")); len(visible) != 0 {
		t.Fatalf("new handshake did not buffer output: %q", visible)
	}
	time.Sleep(60 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(emitted) != 0 {
		t.Fatalf("old timeout flushed new handshake: %q", emitted)
	}
}
