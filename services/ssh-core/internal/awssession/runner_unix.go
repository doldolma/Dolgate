//go:build !windows

package awssession

import (
	"errors"
	"fmt"
	"io"
	"os/exec"
	"syscall"

	"dolssh/services/ssh-core/internal/protocol"
)

type unixProcessRunner struct {
	command *exec.Cmd
	stdin   io.WriteCloser
	stdout  io.ReadCloser
	stderr  io.ReadCloser
}

func startPlatformAWSRunner(_ protocol.AWSConnectPayload, runtime awsCommandRuntime) (sessionRunner, error) {
	command := exec.Command(runtime.executablePath, runtime.args...)
	command.Env = runtime.env

	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe failed: %w", err)
	}

	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe failed: %w", err)
	}

	stderr, err := command.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("stderr pipe failed: %w", err)
	}

	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("aws ssm session start failed: %w", err)
	}

	return &unixProcessRunner{
		command: command,
		stdin:   stdin,
		stdout:  stdout,
		stderr:  stderr,
	}, nil
}

func (r *unixProcessRunner) Write(data []byte) error {
	_, err := r.stdin.Write(data)
	return err
}

func (r *unixProcessRunner) Resize(cols, rows int) error {
	_, _ = normalizedSize(cols, rows)
	return nil
}

func (r *unixProcessRunner) Kill() error {
	if r.command.Process == nil {
		return nil
	}
	return ignoreProcessDone(r.command.Process.Kill())
}

func (r *unixProcessRunner) Close() error {
	_ = r.stdin.Close()
	_ = r.stdout.Close()
	_ = r.stderr.Close()
	return nil
}

func (r *unixProcessRunner) Streams() []io.Reader {
	return []io.Reader{r.stdout, r.stderr}
}

func (r *unixProcessRunner) Wait() (sessionExit, error) {
	err := r.command.Wait()
	if err == nil {
		return sessionExit{ExitCode: 0}, nil
	}

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		exit := sessionExit{
			ExitCode: exitErr.ExitCode(),
		}
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			exit.Signal = status.Signal().String()
		}
		return exit, nil
	}

	return sessionExit{}, err
}
