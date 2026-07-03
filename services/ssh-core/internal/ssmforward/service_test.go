package ssmforward

import (
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

type fakeRunner struct {
	message string
	// killed is polled by the test goroutine while Stop() sets it from another,
	// so it must be atomic.
	killed  atomic.Bool
	closed  bool
	killErr error
	waitFn  func() (sessionExit, error)
}

type bindPortAwareFakeRunner struct {
	fakeRunner
	actualBindPort int
	callback       func(int)
}

func (r *fakeRunner) Wait() (sessionExit, error) {
	if r.waitFn != nil {
		return r.waitFn()
	}
	return sessionExit{}, nil
}

func (r *fakeRunner) Kill() error {
	r.killed.Store(true)
	return r.killErr
}

func (r *fakeRunner) Close() error {
	r.closed = true
	return nil
}

func (r *fakeRunner) ErrorMessage() string {
	return r.message
}

func (r *bindPortAwareFakeRunner) ActualBindPort() int {
	return r.actualBindPort
}

func (r *bindPortAwareFakeRunner) SetBindPortResolvedCallback(callback func(int)) {
	r.callback = callback
}

func TestServiceStopKillsRuntimeAndEmitsStopped(t *testing.T) {
	var emitted []protocol.Event
	waitCh := make(chan struct{})
	service := NewWithRunnerFactory(func(event protocol.Event) {
		emitted = append(emitted, event)
	}, func(protocol.SSMPortForwardStartPayload) (runtimeRunner, error) {
		return &fakeRunner{
			waitFn: func() (sessionExit, error) {
				<-waitCh
				return sessionExit{ExitCode: 1}, errors.New("exit status 1")
			},
		}, nil
	})

	if err := service.Start("rule-1", "req-1", protocol.SSMPortForwardStartPayload{
		TargetType: "instance",
		TargetID:   "i-123",
		BindPort:   0,
		TargetKind: "instance-port",
		TargetPort: 5432,
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	handle, err := service.getRuntime("rule-1")
	if err != nil {
		t.Fatalf("getRuntime() error = %v", err)
	}
	runner := handle.runner.(*fakeRunner)

	stopDone := make(chan error, 1)
	go func() {
		stopDone <- service.Stop("rule-1", "req-stop-1")
	}()

	deadline := time.Now().Add(50 * time.Millisecond)
	for !runner.killed.Load() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !runner.killed.Load() {
		t.Fatal("runner.killed = false, want true")
	}
	if len(emitted) != 1 || emitted[0].Type != protocol.EventPortForwardStarted {
		t.Fatalf("emitted = %+v, want only started event before runtime exits", emitted)
	}
	select {
	case err := <-stopDone:
		t.Fatalf("Stop() returned early: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(waitCh)
	if err := <-stopDone; err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if !runner.closed {
		t.Fatal("runner.closed = false, want true")
	}
	if len(emitted) < 2 || emitted[len(emitted)-1].Type != protocol.EventPortForwardStopped {
		t.Fatalf("emitted = %+v, want stopped event after runtime exits", emitted)
	}
}

func TestServiceStopReturnsKillErrorWithoutStoppedEvent(t *testing.T) {
	var emitted []protocol.Event
	service := NewWithRunnerFactory(func(event protocol.Event) {
		emitted = append(emitted, event)
	}, func(protocol.SSMPortForwardStartPayload) (runtimeRunner, error) {
		return &fakeRunner{
			killErr: errors.New("kill failed"),
			waitFn: func() (sessionExit, error) {
				select {}
			},
		}, nil
	})

	if err := service.Start("rule-kill", "req-kill", protocol.SSMPortForwardStartPayload{
		TargetType: "instance",
		TargetID:   "i-123",
		BindPort:   0,
		TargetKind: "instance-port",
		TargetPort: 5432,
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	err := service.Stop("rule-kill", "req-kill-stop")
	if err == nil || !strings.Contains(err.Error(), "kill failed") {
		t.Fatalf("Stop() error = %v, want kill failed", err)
	}
	if len(emitted) != 1 || emitted[0].Type != protocol.EventPortForwardStarted {
		t.Fatalf("emitted = %+v, want only started event", emitted)
	}
}

func TestServiceStopTimesOutWhileWaitingForRuntimeExit(t *testing.T) {
	previousStopWaitTimeout := stopRequestWaitTimeout
	previousPortReleaseTimeout := stopPortReleaseTimeout
	stopRequestWaitTimeout = 25 * time.Millisecond
	stopPortReleaseTimeout = 10 * time.Millisecond
	t.Cleanup(func() {
		stopRequestWaitTimeout = previousStopWaitTimeout
		stopPortReleaseTimeout = previousPortReleaseTimeout
	})

	var emitted []protocol.Event
	service := NewWithRunnerFactory(func(event protocol.Event) {
		emitted = append(emitted, event)
	}, func(protocol.SSMPortForwardStartPayload) (runtimeRunner, error) {
		return &fakeRunner{
			waitFn: func() (sessionExit, error) {
				select {}
			},
		}, nil
	})

	if err := service.Start("rule-timeout", "req-timeout", protocol.SSMPortForwardStartPayload{
		TargetType: "instance",
		TargetID:   "i-123",
		BindPort:   0,
		TargetKind: "instance-port",
		TargetPort: 5432,
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	err := service.Stop("rule-timeout", "req-timeout-stop")
	if err == nil || !strings.Contains(err.Error(), "timed out waiting") {
		t.Fatalf("Stop() error = %v, want timeout", err)
	}
	if len(emitted) != 1 || emitted[0].Type != protocol.EventPortForwardStarted {
		t.Fatalf("emitted = %+v, want only started event", emitted)
	}
}

func TestServiceFailRuntimeEmitsError(t *testing.T) {
	var emitted []protocol.Event
	service := NewWithRunnerFactory(func(event protocol.Event) {
		emitted = append(emitted, event)
	}, func(protocol.SSMPortForwardStartPayload) (runtimeRunner, error) {
		return &fakeRunner{
			message: "port already in use",
			waitFn: func() (sessionExit, error) {
				return sessionExit{ExitCode: 1}, errors.New("exit status 1")
			},
		}, nil
	})

	if err := service.Start("rule-2", "req-2", protocol.SSMPortForwardStartPayload{
		TargetType: "instance",
		TargetID:   "i-123",
		BindPort:   5432,
		TargetKind: "instance-port",
		TargetPort: 5432,
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	service.waitForRuntime("rule-2")

	if len(emitted) < 2 || emitted[len(emitted)-1].Type != protocol.EventPortForwardError {
		t.Fatalf("emitted = %+v, want error event", emitted)
	}
}

func TestServiceStartUsesResolvedBindPortWhenAvailable(t *testing.T) {
	var emitted []protocol.Event
	service := NewWithRunnerFactory(func(event protocol.Event) {
		emitted = append(emitted, event)
	}, func(protocol.SSMPortForwardStartPayload) (runtimeRunner, error) {
		return &bindPortAwareFakeRunner{
			actualBindPort: 48123,
			fakeRunner: fakeRunner{
				waitFn: func() (sessionExit, error) {
					select {}
				},
			},
		}, nil
	})

	if err := service.Start("rule-3", "req-3", protocol.SSMPortForwardStartPayload{
		TargetType: "ecs-task",
		TargetID:   "ecs:demo-cluster_task-123_runtime-456",
		BindPort:   0,
		TargetKind: "remote-host",
		TargetPort: 8080,
		RemoteHost: "127.0.0.1",
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	startedPayload, ok := emitted[0].Payload.(protocol.PortForwardStartedPayload)
	if !ok {
		t.Fatalf("payload = %#v, want PortForwardStartedPayload", emitted[0].Payload)
	}
	if startedPayload.BindPort != 48123 {
		t.Fatalf("BindPort = %d, want 48123", startedPayload.BindPort)
	}

	_ = service.Stop("rule-3", "req-3")
}

func TestServiceEmitsUpdatedBindPortWhenResolvedLater(t *testing.T) {
	var emitted []protocol.Event
	runner := &bindPortAwareFakeRunner{
		fakeRunner: fakeRunner{
			waitFn: func() (sessionExit, error) {
				select {}
			},
		},
	}
	service := NewWithRunnerFactory(func(event protocol.Event) {
		emitted = append(emitted, event)
	}, func(protocol.SSMPortForwardStartPayload) (runtimeRunner, error) {
		return runner, nil
	})

	if err := service.Start("rule-4", "req-4", protocol.SSMPortForwardStartPayload{
		TargetType: "ecs-task",
		TargetID:   "ecs:demo-cluster_task-123_runtime-456",
		BindPort:   0,
		TargetKind: "remote-host",
		TargetPort: 8080,
		RemoteHost: "127.0.0.1",
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	if len(emitted) == 0 {
		t.Fatalf("emitted = %v, want initial started event", emitted)
	}
	initialPayload := emitted[0].Payload.(protocol.PortForwardStartedPayload)
	if initialPayload.BindPort != 0 {
		t.Fatalf("initial BindPort = %d, want 0", initialPayload.BindPort)
	}

	if runner.callback == nil {
		t.Fatal("runner.callback = nil, want callback")
	}
	runner.callback(49222)

	if len(emitted) < 2 {
		t.Fatalf("emitted = %+v, want updated started event", emitted)
	}
	updatedPayload := emitted[len(emitted)-1].Payload.(protocol.PortForwardStartedPayload)
	if updatedPayload.BindPort != 49222 {
		t.Fatalf("updated BindPort = %d, want 49222", updatedPayload.BindPort)
	}

	_ = service.Stop("rule-4", "req-4")
}

