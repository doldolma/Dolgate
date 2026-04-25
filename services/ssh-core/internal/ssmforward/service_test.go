package ssmforward

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

type fakeRunner struct {
	message string
	killed  bool
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
	r.killed = true
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

func TestBuildStartArgsForInstancePort(t *testing.T) {
	args, err := buildStartArgs(protocol.SSMPortForwardStartPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		TargetType:  "instance",
		TargetID:    "i-123",
		BindPort:    15432,
		TargetKind:  "instance-port",
		TargetPort:  5432,
	})
	if err != nil {
		t.Fatalf("buildStartArgs() error = %v", err)
	}

	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "AWS-StartPortForwardingSession") {
		t.Fatalf("args = %v, want AWS-StartPortForwardingSession", args)
	}
	if strings.Contains(joined, "AWS-StartPortForwardingSessionToRemoteHost") {
		t.Fatalf("args = %v, unexpected remote-host document", args)
	}
}

func TestBuildStartArgsForRemoteHost(t *testing.T) {
	args, err := buildStartArgs(protocol.SSMPortForwardStartPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		TargetType:  "instance",
		TargetID:    "i-123",
		BindPort:    13306,
		TargetKind:  "remote-host",
		TargetPort:  3306,
		RemoteHost:  "db.internal",
	})
	if err != nil {
		t.Fatalf("buildStartArgs() error = %v", err)
	}

	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "AWS-StartPortForwardingSessionToRemoteHost") {
		t.Fatalf("args = %v, want AWS-StartPortForwardingSessionToRemoteHost", args)
	}
	if !strings.Contains(joined, "db.internal") {
		t.Fatalf("args = %v, want remote host parameter", args)
	}
}

func TestBuildStartArgsForEcsTaskRemoteHost(t *testing.T) {
	args, err := buildStartArgs(protocol.SSMPortForwardStartPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		TargetType:  "ecs-task",
		TargetID:    "ecs:demo-cluster_task-123_runtime-456",
		BindPort:    18080,
		TargetKind:  "remote-host",
		TargetPort:  8080,
		RemoteHost:  "127.0.0.1",
	})
	if err != nil {
		t.Fatalf("buildStartArgs() error = %v", err)
	}

	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "ecs:demo-cluster_task-123_runtime-456") {
		t.Fatalf("args = %v, want ecs task target", args)
	}
	if !strings.Contains(joined, "AWS-StartPortForwardingSessionToRemoteHost") {
		t.Fatalf("args = %v, want remote-host document", args)
	}
}

func TestMergeChildEnvAppliesOverridesAndUnsetKeys(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "old")
	t.Setenv("AWS_PROFILE", "server-profile")
	t.Setenv("DOLSSH_KEEP", "yes")

	env := mergeChildEnv("/tmp/dolssh-bin", map[string]string{
		"AWS_ACCESS_KEY_ID":     "new",
		"AWS_SECRET_ACCESS_KEY": "secret",
	}, []string{"AWS_PROFILE"})

	lookup := map[string]string{}
	for _, entry := range env {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			lookup[key] = value
		}
	}
	if lookup["AWS_ACCESS_KEY_ID"] != "new" {
		t.Fatalf("AWS_ACCESS_KEY_ID = %q, want new", lookup["AWS_ACCESS_KEY_ID"])
	}
	if lookup["AWS_SECRET_ACCESS_KEY"] != "secret" {
		t.Fatalf("AWS_SECRET_ACCESS_KEY = %q, want secret", lookup["AWS_SECRET_ACCESS_KEY"])
	}
	if _, ok := lookup["AWS_PROFILE"]; ok {
		t.Fatalf("AWS_PROFILE should be unset, env contains %q", lookup["AWS_PROFILE"])
	}
	if lookup["DOLSSH_KEEP"] != "yes" {
		t.Fatalf("DOLSSH_KEEP = %q, want yes", lookup["DOLSSH_KEEP"])
	}
	if lookup["PATH"] == "" && lookup["Path"] == "" && lookup["path"] == "" && os.Getenv("PATH") != "" {
		t.Fatalf("PATH was not preserved or replaced")
	}
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
	for !runner.killed && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !runner.killed {
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

func TestParseStartedBindPort(t *testing.T) {
	if got := parseStartedBindPort("Port 40123 opened for sessionId abc123."); got != 40123 {
		t.Fatalf("parseStartedBindPort() = %d, want 40123", got)
	}
	if got := parseStartedBindPort("Waiting for connections..."); got != 0 {
		t.Fatalf("parseStartedBindPort() = %d, want 0", got)
	}
}
