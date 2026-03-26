//go:build !windows

package awssession

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"github.com/creack/pty"

	"dolssh/services/ssh-core/internal/protocol"
)

type unixPTYRunner struct {
	command *exec.Cmd
	ptyFile *os.File
}

func startPlatformAWSRunner(payload protocol.AWSConnectPayload, runtime awsCommandRuntime) (sessionRunner, error) {
	cols, rows := normalizedSize(payload.Cols, payload.Rows)
	command := exec.Command(runtime.executablePath, runtime.args...)
	command.Env = ensureUnixTerminalEnv(runtime.env)

	ptyFile, err := pty.StartWithSize(command, &pty.Winsize{
		Cols: uint16(cols),
		Rows: uint16(rows),
	})
	if err != nil {
		return nil, fmt.Errorf("aws ssm session pty start failed: %w", err)
	}

	return &unixPTYRunner{
		command: command,
		ptyFile: ptyFile,
	}, nil
}

func ensureUnixTerminalEnv(env []string) []string {
	nextEnv := append([]string(nil), env...)
	for index, entry := range nextEnv {
		key, value, found := strings.Cut(entry, "=")
		if !found || key != "TERM" {
			continue
		}
		if strings.TrimSpace(value) == "" {
			nextEnv[index] = "TERM=xterm-256color"
		}
		return nextEnv
	}
	return append(nextEnv, "TERM=xterm-256color")
}

func (r *unixPTYRunner) Write(data []byte) error {
	_, err := r.ptyFile.Write(data)
	return err
}

func (r *unixPTYRunner) SendControlSignal(signal string) error {
	normalized, err := normalizeControlSignal(signal)
	if err != nil {
		return err
	}
	if r.command.Process == nil {
		return nil
	}

	var unixSignal syscall.Signal
	switch normalized {
	case "interrupt":
		unixSignal = syscall.SIGINT
	case "suspend":
		unixSignal = syscall.SIGTSTP
	case "quit":
		unixSignal = syscall.SIGQUIT
	default:
		return fmt.Errorf("unsupported control signal: %s", normalized)
	}

	return ignoreProcessDone(syscall.Kill(-r.command.Process.Pid, unixSignal))
}

func (r *unixPTYRunner) Resize(cols, rows int) error {
	cols, rows = normalizedSize(cols, rows)
	return pty.Setsize(r.ptyFile, &pty.Winsize{
		Cols: uint16(cols),
		Rows: uint16(rows),
	})
}

func (r *unixPTYRunner) Kill() error {
	if r.command.Process == nil {
		return nil
	}
	return ignoreProcessDone(r.command.Process.Kill())
}

func (r *unixPTYRunner) Close() error {
	return r.ptyFile.Close()
}

func (r *unixPTYRunner) Streams() []io.Reader {
	return []io.Reader{r.ptyFile}
}

func (r *unixPTYRunner) Wait() (sessionExit, error) {
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
