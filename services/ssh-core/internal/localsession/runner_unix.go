//go:build !windows

package localsession

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

func startPlatformLocalRunner(payload protocol.LocalConnectPayload, runtime localCommandRuntime) (sessionRunner, error) {
	cols, rows := normalizedSize(payload.Cols, payload.Rows)
	command := exec.Command(runtime.executablePath, runtime.args...)
	command.Env = ensureUnixTerminalEnv(runtime.env)
	if runtime.workingDirectory != "" {
		command.Dir = runtime.workingDirectory
	}

	ptyFile, err := pty.StartWithSize(command, &pty.Winsize{
		Cols: uint16(cols),
		Rows: uint16(rows),
	})
	if err != nil {
		return nil, fmt.Errorf("local shell pty start failed: %w", err)
	}

	return &unixPTYRunner{
		command: command,
		ptyFile: ptyFile,
	}, nil
}

func resolveLocalRuntime() (localCommandRuntime, error) {
	executablePath, err := resolveUnixShellExecutable()
	if err != nil {
		return localCommandRuntime{}, err
	}

	workingDirectory := resolveUserHomeDirectory()
	return localCommandRuntime{
		shellKind:        "shell",
		executablePath:   executablePath,
		args:             nil,
		env:              os.Environ(),
		workingDirectory: workingDirectory,
	}, nil
}

func resolveUnixShellExecutable() (string, error) {
	return resolveUnixShellExecutableWithLookup(os.Getenv("SHELL"), isUnixShellUsable)
}

func resolveUnixShellExecutableWithLookup(shellValue string, canUse func(string) bool) (string, error) {
	if candidate := strings.TrimSpace(shellValue); candidate != "" && canUse(candidate) {
		return candidate, nil
	}
	for _, candidate := range []string{"/bin/bash", "/bin/sh"} {
		if canUse(candidate) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not resolve a usable local shell")
}

func isUnixShellUsable(candidate string) bool {
	if candidate == "" {
		return false
	}
	if strings.Contains(candidate, "/") {
		info, err := os.Stat(candidate)
		return err == nil && !info.IsDir()
	}
	_, err := exec.LookPath(candidate)
	return err == nil
}

func resolveUserHomeDirectory() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
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

func (r *unixPTYRunner) ShellKind() string {
	return "shell"
}
