package ssmforward

import (
	"errors"
	"strings"
	"testing"

	"dolssh/services/ssh-core/internal/protocol"
)

type fakeRunner struct {
	message string
	killed  bool
	closed  bool
	waitFn  func() (sessionExit, error)
}

func (r *fakeRunner) Wait() (sessionExit, error) {
	if r.waitFn != nil {
		return r.waitFn()
	}
	return sessionExit{}, nil
}

func (r *fakeRunner) Kill() error {
	r.killed = true
	return nil
}

func (r *fakeRunner) Close() error {
	r.closed = true
	return nil
}

func (r *fakeRunner) ErrorMessage() string {
	return r.message
}

func TestBuildStartArgsForInstancePort(t *testing.T) {
	args, err := buildStartArgs(protocol.SSMPortForwardStartPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		InstanceID:  "i-123",
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
		InstanceID:  "i-123",
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

func TestServiceStopKillsRuntimeAndEmitsStopped(t *testing.T) {
	var emitted []protocol.Event
	service := NewWithRunnerFactory(func(event protocol.Event) {
		emitted = append(emitted, event)
	}, func(protocol.SSMPortForwardStartPayload) (runtimeRunner, error) {
		return &fakeRunner{}, nil
	})

	if err := service.Start("rule-1", "req-1", protocol.SSMPortForwardStartPayload{
		InstanceID: "i-123",
		BindPort:   5432,
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

	if err := service.Stop("rule-1", "req-1"); err != nil {
		t.Fatalf("Stop() error = %v", err)
	}
	if !runner.killed {
		t.Fatal("runner.killed = false, want true")
	}
	if !runner.closed {
		t.Fatal("runner.closed = false, want true")
	}
	if len(emitted) < 2 || emitted[len(emitted)-1].Type != protocol.EventPortForwardStopped {
		t.Fatalf("emitted = %+v, want stopped event", emitted)
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
		InstanceID: "i-123",
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
