package awssession

import (
	"bytes"
	"encoding/base64"
	"io"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/protocol"
)

type stubRunner struct {
	outputReader *io.PipeReader
	outputWriter *io.PipeWriter

	// mu guards the recorded calls below: the manager invokes the runner from
	// its own goroutines while tests poll/inspect the records.
	mu             sync.Mutex
	writes         [][]byte
	controlSignals []string
	resizes        [][2]int
	killed         bool

	waitResult sessionExit
	waitErr    error
	waitCh     chan struct{}
}

func newStubRunner() *stubRunner {
	outputReader, outputWriter := io.Pipe()
	return &stubRunner{
		outputReader: outputReader,
		outputWriter: outputWriter,
		waitCh:       make(chan struct{}),
	}
}

func (r *stubRunner) Write(data []byte) error {
	chunk := make([]byte, len(data))
	copy(chunk, data)
	r.mu.Lock()
	r.writes = append(r.writes, chunk)
	r.mu.Unlock()
	return nil
}

func (r *stubRunner) SendControlSignal(signal string) error {
	normalized, err := normalizeControlSignal(signal)
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.controlSignals = append(r.controlSignals, normalized)
	r.mu.Unlock()
	return nil
}

func (r *stubRunner) Resize(cols, rows int) error {
	r.mu.Lock()
	r.resizes = append(r.resizes, [2]int{cols, rows})
	r.mu.Unlock()
	return nil
}

func (r *stubRunner) Kill() error {
	r.mu.Lock()
	r.killed = true
	r.mu.Unlock()
	r.finish(sessionExit{ExitCode: 0}, nil)
	return nil
}

func (r *stubRunner) writesSnapshot() [][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([][]byte(nil), r.writes...)
}

func (r *stubRunner) controlSignalsSnapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.controlSignals...)
}

func (r *stubRunner) Close() error {
	_ = r.outputReader.Close()
	_ = r.outputWriter.Close()
	return nil
}

func (r *stubRunner) Streams() []io.Reader {
	return []io.Reader{r.outputReader}
}

func (r *stubRunner) Wait() (sessionExit, error) {
	<-r.waitCh
	return r.waitResult, r.waitErr
}

func (r *stubRunner) emitOutput(chunk string) {
	_, _ = r.outputWriter.Write([]byte(chunk))
}

func (r *stubRunner) finish(result sessionExit, err error) {
	select {
	case <-r.waitCh:
		return
	default:
		r.waitResult = result
		r.waitErr = err
		close(r.waitCh)
		_ = r.outputWriter.Close()
	}
}

func waitForEvent(t *testing.T, events <-chan protocol.Event, expected protocol.EventType) protocol.Event {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case event := <-events:
			if event.Type == expected {
				return event
			}
		case <-deadline:
			t.Fatalf("timed out waiting for event %s", expected)
		}
	}
}

func waitForStream(t *testing.T, streams <-chan []byte) []byte {
	t.Helper()
	select {
	case chunk := <-streams:
		return chunk
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for stream chunk")
		return nil
	}
}

func waitForWriteCount(t *testing.T, runner *stubRunner, count int) [][]byte {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		writes := runner.writesSnapshot()
		if len(writes) >= count {
			return writes
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d writes, got %d", count, len(runner.writesSnapshot()))
	return nil
}

func completeShellIntegration(t *testing.T, runner *stubRunner, streams <-chan []byte) {
	t.Helper()
	runner.emitOutput("ubuntu@ip-10-0-1-59:~$ ")
	waitForWriteCount(t, runner, 1)
	runner.emitOutput(autocomplete.PromptStartMarker + "ubuntu@ip-10-0-1-59:~$ ")
	if got := waitForStream(t, streams); !bytes.Contains(got, []byte(autocomplete.PromptStartMarker)) {
		t.Fatalf("shell integration marker was not forwarded: %q", got)
	}
}

func TestManagerFakeSessionFlow(t *testing.T) {
	t.Setenv("DOLSSH_E2E_FAKE_AWS_SESSION", "1")

	events := make(chan protocol.Event, 16)
	streams := make(chan []byte, 16)
	manager := NewManager(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, payload []byte) {
		streams <- payload
	})

	if err := manager.Connect("session-1", "req-1", protocol.AWSConnectPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		InstanceID:  "i-1234",
	}); err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	waitForEvent(t, events, protocol.EventConnected)
	if !manager.HasSession("session-1") {
		t.Fatal("session should exist")
	}

	firstChunk := waitForStream(t, streams)
	if !bytes.Contains(firstChunk, []byte("Connected to fake AWS SSM smoke session.")) {
		t.Fatalf("missing fake session banner: %q", firstChunk)
	}

	if err := manager.WriteBytes("session-1", []byte("ping\r\n")); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	if got := waitForStream(t, streams); !bytes.Contains(got, []byte("ping")) {
		t.Fatalf("missing echoed write: %q", got)
	}

	if err := manager.Resize("session-1", 180, 48); err != nil {
		t.Fatalf("resize failed: %v", err)
	}

	if err := manager.Disconnect("session-1"); err != nil {
		t.Fatalf("disconnect failed: %v", err)
	}

	closed := waitForEvent(t, events, protocol.EventClosed)
	payload, ok := closed.Payload.(protocol.ClosedPayload)
	if !ok {
		t.Fatalf("closed payload type = %T", closed.Payload)
	}
	if payload.Message != "client requested disconnect" {
		t.Fatalf("closed message = %q, want %q", payload.Message, "client requested disconnect")
	}
}

func TestManagerCollectAutocompleteFiltersProbeOutput(t *testing.T) {
	events := make(chan protocol.Event, 16)
	streams := make(chan []byte, 16)
	runner := newStubRunner()
	manager := NewManagerWithRunnerFactory(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, payload []byte) {
		streams <- payload
	}, func(protocol.AWSConnectPayload) (sessionRunner, error) {
		return runner, nil
	})
	if err := manager.Connect("session-1", "request-1", protocol.AWSConnectPayload{}); err != nil {
		t.Fatalf("connect: %v", err)
	}
	waitForEvent(t, events, protocol.EventConnected)
	completeShellIntegration(t, runner, streams)
	writes := waitForWriteCount(t, runner, 1)
	if string(writes[0]) != autocomplete.ShellIntegrationInitCommand() {
		t.Fatalf("shell integration command was not written first: %q", writes[0])
	}

	resultCh := make(chan autocomplete.Result, 1)
	go func() {
		result, _ := manager.CollectAutocomplete("session-1", 7)
		resultCh <- result
	}()
	writes = waitForWriteCount(t, runner, 2)
	probeWrite := writes[len(writes)-1]
	match := regexp.MustCompile(`6973;([0-9a-f]+);snapshot`).FindSubmatch(probeWrite)
	if len(match) != 2 {
		t.Fatalf("probe nonce not found in %q", probeWrite)
	}
	payload := []byte("S\x00bash\x00H\x00git status\x00E\x00git\x00/usr/bin/git\x00")
	runner.emitOutput("probe echo\r\n\x1b]6973;" + string(match[1]) + ";snapshot;" + base64.StdEncoding.EncodeToString(payload) + "\a" +
		"\x1b]133;D;0\a" + autocomplete.PromptStartMarker + "\x1b]7;file://host/home/ubuntu\a$ " + autocomplete.PromptInputStartMarker)

	select {
	case result := <-resultCh:
		if result.Snapshot == nil || result.Snapshot.Revision != 7 || len(result.Snapshot.History) != 1 {
			t.Fatalf("unexpected result: %#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for autocomplete result")
	}
	select {
	case output := <-streams:
		t.Fatalf("probe output leaked to terminal: %q", output)
	case <-time.After(50 * time.Millisecond):
	}
	_ = manager.Disconnect("session-1")
}

func TestManagerWaitsForProbePromptRedrawBeforeCompletingAutocomplete(t *testing.T) {
	events := make(chan protocol.Event, 16)
	streams := make(chan []byte, 16)
	runner := newStubRunner()
	manager := NewManagerWithRunnerFactory(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, payload []byte) {
		streams <- payload
	}, func(protocol.AWSConnectPayload) (sessionRunner, error) {
		return runner, nil
	})
	if err := manager.Connect("session-split-probe", "request-split-probe", protocol.AWSConnectPayload{}); err != nil {
		t.Fatalf("connect: %v", err)
	}
	waitForEvent(t, events, protocol.EventConnected)
	completeShellIntegration(t, runner, streams)

	resultCh := make(chan autocomplete.Result, 1)
	go func() {
		result, _ := manager.CollectAutocomplete("session-split-probe", 8)
		resultCh <- result
	}()
	writes := waitForWriteCount(t, runner, 2)
	match := regexp.MustCompile(`6973;([0-9a-f]+);snapshot`).FindSubmatch(writes[len(writes)-1])
	if len(match) != 2 {
		t.Fatalf("probe nonce not found in %q", writes[len(writes)-1])
	}
	payload := []byte("S\x00bash\x00")
	runner.emitOutput("\x1b]6973;" + string(match[1]) + ";snapshot;" + base64.StdEncoding.EncodeToString(payload) + "\a")

	select {
	case result := <-resultCh:
		t.Fatalf("autocomplete completed before probe prompt redraw was hidden: %#v", result)
	case <-time.After(50 * time.Millisecond):
	}

	runner.emitOutput("\x1b]133;D;0\a" + autocomplete.PromptStartMarker + "$ " + autocomplete.PromptInputStartMarker)

	select {
	case result := <-resultCh:
		if result.Snapshot == nil || result.Snapshot.Revision != 8 {
			t.Fatalf("unexpected result: %#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for autocomplete result")
	}
	select {
	case output := <-streams:
		t.Fatalf("split probe prompt leaked to terminal: %q", output)
	case <-time.After(50 * time.Millisecond):
	}
	_ = manager.Disconnect("session-split-probe")
}

func TestManagerSuppressesAwsShellProfileEchoBeforeIntegrationMarker(t *testing.T) {
	events := make(chan protocol.Event, 16)
	streams := make(chan []byte, 16)
	runner := newStubRunner()
	manager := NewManagerWithRunnerFactory(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, payload []byte) {
		streams <- payload
	}, func(protocol.AWSConnectPayload) (sessionRunner, error) {
		return runner, nil
	})
	if err := manager.Connect("session-profile", "request-profile", protocol.AWSConnectPayload{}); err != nil {
		t.Fatalf("connect: %v", err)
	}
	waitForEvent(t, events, protocol.EventConnected)

	awsProfileCommand := `u=$(awk -F: '$3==1000 && $7 !~ /(nologin|false)$/ {print $1; exit}' /etc/passwd); [ -n "$u" ] && exec sudo -iu "$u"`
	runner.emitOutput(awsProfileCommand + "\r\nubuntu@ip-10-0-1-59:~$ ")
	waitForWriteCount(t, runner, 1)
	runner.emitOutput(autocomplete.PromptStartMarker + "ubuntu@ip-10-0-1-59:~$ ")

	output := string(waitForStream(t, streams))
	if strings.Contains(output, awsProfileCommand) {
		t.Fatalf("AWS shell profile command leaked to terminal: %q", output)
	}
	if strings.Count(output, "ubuntu@ip-10-0-1-59:~$") != 1 {
		t.Fatalf("expected one integrated prompt, got %q", output)
	}
	_ = manager.Disconnect("session-profile")
}

func TestManagerDoesNotInstallShellIntegrationBeforePromptOnMaxWait(t *testing.T) {
	events := make(chan protocol.Event, 16)
	streams := make(chan []byte, 16)
	runner := newStubRunner()
	manager := NewManagerWithRunnerFactory(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, payload []byte) {
		streams <- payload
	}, func(protocol.AWSConnectPayload) (sessionRunner, error) {
		return runner, nil
	})
	if err := manager.Connect("session-slow-profile", "request-slow-profile", protocol.AWSConnectPayload{}); err != nil {
		t.Fatalf("connect: %v", err)
	}
	waitForEvent(t, events, protocol.EventConnected)

	time.Sleep(shellIntegrationInstallMaxWait + 100*time.Millisecond)
	if writes := runner.writesSnapshot(); len(writes) != 0 {
		t.Fatalf("shell integration was written before a prompt boundary: %q", writes[0])
	}

	runner.emitOutput(`u=$(awk -F: '$3==1000 {print $1; exit}' /etc/passwd)` + "\r\n")
	time.Sleep(shellIntegrationInstallQuiet + 100*time.Millisecond)
	if writes := runner.writesSnapshot(); len(writes) != 0 {
		t.Fatalf("shell integration was written before prompt output: %q", writes[0])
	}

	runner.emitOutput("ubuntu@ip-10-0-1-59:~$ ")
	waitForWriteCount(t, runner, 1)
	runner.emitOutput(autocomplete.PromptStartMarker + "ubuntu@ip-10-0-1-59:~$ ")
	if got := waitForStream(t, streams); !bytes.Contains(got, []byte(autocomplete.PromptStartMarker)) {
		t.Fatalf("shell integration marker was not forwarded: %q", got)
	}
	_ = manager.Disconnect("session-slow-profile")
}

// A Windows SSM session lands in PowerShell, which cannot run the POSIX
// integration script -- typing it in prints a wall of parse errors over the
// first screen. Shell integration is simply absent on those sessions, so the
// install must not be attempted at all (not even armed, which would hold back
// output waiting for an echo that never comes).
func TestManagerSkipsShellIntegrationForPowerShellSessions(t *testing.T) {
	events := make(chan protocol.Event, 16)
	streams := make(chan []byte, 16)
	runner := newStubRunner()
	manager := NewManagerWithRunnerFactory(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, payload []byte) {
		streams <- payload
	}, func(protocol.AWSConnectPayload) (sessionRunner, error) {
		return runner, nil
	})
	if err := manager.Connect("session-windows", "request-windows", protocol.AWSConnectPayload{
		ShellKind: "powershell",
	}); err != nil {
		t.Fatalf("connect: %v", err)
	}
	waitForEvent(t, events, protocol.EventConnected)

	// A PowerShell prompt would normally trip the install gate.
	runner.emitOutput("PS C:\\Windows\\system32> ")
	time.Sleep(shellIntegrationInstallQuiet + 100*time.Millisecond)
	if writes := runner.writesSnapshot(); len(writes) != 0 {
		t.Fatalf("shell integration was typed into PowerShell: %q", writes[0])
	}

	// Output must flow straight through -- nothing is held back for an echo.
	if got := waitForStream(t, streams); !bytes.Contains(got, []byte("PS C:")) {
		t.Fatalf("session output was withheld: %q", got)
	}

	// The explicit install request is refused too (the renderer may still ask).
	if err := manager.InstallShellIntegration("session-windows"); err != nil {
		t.Fatalf("install shell integration: %v", err)
	}
	time.Sleep(shellIntegrationInstallQuiet + 100*time.Millisecond)
	if writes := runner.writesSnapshot(); len(writes) != 0 {
		t.Fatalf("explicit install typed into PowerShell: %q", writes[0])
	}

	_ = manager.Disconnect("session-windows")
}

func TestManagerRoutesWriteResizeAndOutputThroughRunner(t *testing.T) {
	events := make(chan protocol.Event, 16)
	streams := make(chan []byte, 16)
	runner := newStubRunner()
	manager := NewManagerWithRunnerFactory(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, payload []byte) {
		streams <- payload
	}, func(protocol.AWSConnectPayload) (sessionRunner, error) {
		return runner, nil
	})

	if err := manager.Connect("session-2", "req-2", protocol.AWSConnectPayload{
		ProfileName: "default",
		Region:      "us-east-1",
		InstanceID:  "i-5678",
		Cols:        120,
		Rows:        32,
	}); err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	waitForEvent(t, events, protocol.EventConnected)
	completeShellIntegration(t, runner, streams)

	if err := manager.WriteBytes("session-2", []byte("ls -al\r")); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	if err := manager.SendControlSignal("session-2", "interrupt"); err != nil {
		t.Fatalf("control signal failed: %v", err)
	}
	if err := manager.Resize("session-2", 200, 60); err != nil {
		t.Fatalf("resize failed: %v", err)
	}

	runner.emitOutput("hello\r\n")
	if got := waitForStream(t, streams); !bytes.Equal(got, []byte("hello\r\n")) {
		t.Fatalf("stream payload = %q", got)
	}

	writes := runner.writesSnapshot()
	if len(writes) != 2 ||
		string(writes[0]) != autocomplete.ShellIntegrationInitCommand() ||
		!bytes.Equal(writes[1], []byte("ls -al\r")) {
		t.Fatalf("writes = %#v", writes)
	}
	controlSignals := runner.controlSignalsSnapshot()
	if len(controlSignals) != 1 || controlSignals[0] != "interrupt" {
		t.Fatalf("controlSignals = %#v", controlSignals)
	}
	if len(runner.resizes) != 1 || runner.resizes[0] != [2]int{200, 60} {
		t.Fatalf("resizes = %#v", runner.resizes)
	}

	if err := manager.Disconnect("session-2"); err != nil {
		t.Fatalf("disconnect failed: %v", err)
	}

	if !runner.killed {
		t.Fatal("runner should be killed on disconnect")
	}
	closed := waitForEvent(t, events, protocol.EventClosed)
	payload := closed.Payload.(protocol.ClosedPayload)
	if payload.Message != "client requested disconnect" {
		t.Fatalf("closed message = %q", payload.Message)
	}
}

func TestManagerEmitsErrorBeforeClosedOnAbnormalExit(t *testing.T) {
	events := make(chan protocol.Event, 16)
	runner := newStubRunner()
	manager := NewManagerWithRunnerFactory(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, _ []byte) {}, func(protocol.AWSConnectPayload) (sessionRunner, error) {
		return runner, nil
	})

	if err := manager.Connect("session-3", "req-3", protocol.AWSConnectPayload{
		ProfileName: "default",
		Region:      "us-west-2",
		InstanceID:  "i-abcd",
	}); err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	waitForEvent(t, events, protocol.EventConnected)
	runner.finish(sessionExit{ExitCode: 1}, nil)

	errorEvent := waitForEvent(t, events, protocol.EventError)
	errorPayload := errorEvent.Payload.(protocol.ErrorPayload)
	if errorPayload.Message != "AWS SSM session exited with code 1" {
		t.Fatalf("error message = %q", errorPayload.Message)
	}

	closedEvent := waitForEvent(t, events, protocol.EventClosed)
	closedPayload := closedEvent.Payload.(protocol.ClosedPayload)
	if closedPayload.Message != "AWS SSM session exited with code 1" {
		t.Fatalf("closed message = %q", closedPayload.Message)
	}
	if manager.HasSession("session-3") {
		t.Fatal("session should be removed after abnormal exit")
	}
}

func TestManagerShutdownKillsActiveSessions(t *testing.T) {
	events := make(chan protocol.Event, 16)
	runner := newStubRunner()
	manager := NewManagerWithRunnerFactory(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, _ []byte) {}, func(protocol.AWSConnectPayload) (sessionRunner, error) {
		return runner, nil
	})

	if err := manager.Connect("session-4", "req-4", protocol.AWSConnectPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		InstanceID:  "i-shutdown",
	}); err != nil {
		t.Fatalf("connect failed: %v", err)
	}

	waitForEvent(t, events, protocol.EventConnected)

	manager.Shutdown()

	if !runner.killed {
		t.Fatal("runner should be killed on shutdown")
	}

	closed := waitForEvent(t, events, protocol.EventClosed)
	payload := closed.Payload.(protocol.ClosedPayload)
	if payload.Message != "client requested disconnect" {
		t.Fatalf("closed message = %q", payload.Message)
	}
}

// PowerShell 세션은 셸 통합을 시도해서는 안 되고, 출력을 붙잡고 있어서도 안 된다.
//
// POSIX 스크립트를 넣으면 마커가 영원히 오지 않아 handshake 필터가 8초를 붙잡는다. 그동안 화면이
// 멈춰 있고 그 사이 친 것이 한꺼번에 쏟아진다 — Windows SSM 셸이 정확히 이 상태였다.
func TestManagerDoesNotHoldOutputOnPowerShellSession(t *testing.T) {
	events := make(chan protocol.Event, 16)
	streams := make(chan []byte, 16)
	runner := newStubRunner()
	manager := NewManagerWithRunnerFactory(func(event protocol.Event) {
		events <- event
	}, func(_ protocol.StreamFrame, payload []byte) {
		streams <- payload
	}, func(protocol.AWSConnectPayload) (sessionRunner, error) {
		return runner, nil
	})

	// ShellKind 를 일부러 비워 둔다 — 호스트 기록에 플랫폼이 없는 경우가 이 시나리오다.
	if err := manager.Connect("session-ps", "req-ps", protocol.AWSConnectPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		InstanceID:  "i-windows",
		Cols:        120,
		Rows:        30,
	}); err != nil {
		t.Fatalf("connect failed: %v", err)
	}
	waitForEvent(t, events, protocol.EventConnected)

	banner := "Windows PowerShell\r\nCopyright (C) Microsoft Corporation.\r\n\r\nPS C:\\Windows\\system32> "
	runner.emitOutput(banner)

	// 붙잡히면 여기서 기다리다 실패한다(실제로는 8초 뒤에야 나왔다).
	got := waitForStream(t, streams)
	if !bytes.Contains(got, []byte("Windows PowerShell")) {
		t.Fatalf("배너가 그대로 나와야 한다: %q", got)
	}

	// 통합 스크립트를 타이핑해서도 안 된다. 화면이 PowerShell 파싱 오류로 덮인다.
	runner.emitOutput("PS C:\\Windows\\system32> ")
	time.Sleep(shellIntegrationInstallQuiet + 300*time.Millisecond)
	if writes := runner.writesSnapshot(); len(writes) != 0 {
		t.Fatalf("PowerShell 세션에 쓴 것이 있다: %q", writes)
	}

	// 자동완성은 9초를 기다리지 않고 즉시 물러나야 한다.
	start := time.Now()
	result, err := manager.CollectAutocomplete("session-ps", 1)
	if err != nil {
		t.Fatalf("CollectAutocomplete: %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("자동완성이 %v 기다렸다 — 즉시 물러나야 한다", elapsed)
	}
	if result.Capability.Status != "unsupported" {
		t.Fatalf("status = %q, want unsupported", result.Capability.Status)
	}
}
