//go:build !windows

package localsession

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"

	"github.com/creack/pty"

	"dolssh/services/ssh-core/internal/protocol"
)

type unixPTYRunner struct {
	shellKind string
	command   *exec.Cmd
	ptyFile   *os.File
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
		shellKind: runtime.shellKind,
		command:   command,
		ptyFile:   ptyFile,
	}, nil
}

func resolveLocalRuntime(payload protocol.LocalConnectPayload) (localCommandRuntime, error) {
	if executablePath := strings.TrimSpace(payload.Executable); executablePath != "" {
		args := append([]string(nil), payload.Args...)
		workingDirectory := strings.TrimSpace(payload.WorkingDirectory)
		if workingDirectory == "" {
			workingDirectory = resolveUserHomeDirectory()
		}
		shellKind := strings.TrimSpace(payload.ShellKind)
		if shellKind == "" {
			shellKind = "shell"
		}
		return localCommandRuntime{
			shellKind:        shellKind,
			executablePath:   executablePath,
			args:             args,
			env:              buildRuntimeEnv(os.Environ(), payload.Env),
			workingDirectory: workingDirectory,
		}, nil
	}

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
	nextEnv = ensureEnvDefault(nextEnv, "TERM", "xterm-256color")
	return ensureUnixLocaleEnv(nextEnv, runtime.GOOS)
}

func ensureEnvDefault(env []string, key, fallbackValue string) []string {
	for index, entry := range env {
		entryKey, value, found := strings.Cut(entry, "=")
		if !found || entryKey != key {
			continue
		}
		if strings.TrimSpace(value) == "" {
			env[index] = key + "=" + fallbackValue
		}
		return env
	}
	return append(env, key+"="+fallbackValue)
}

func ensureUnixLocaleEnv(env []string, goos string) []string {
	if envHasNonEmptyValue(env, "LC_ALL") || envHasUTF8Locale(env) {
		return env
	}
	if lcCtype, found := envValue(env, "LC_CTYPE"); found && strings.TrimSpace(lcCtype) != "" {
		return env
	}

	fallbackValue := "C.UTF-8"
	if goos == "darwin" {
		fallbackValue = "UTF-8"
	}
	return ensureEnvDefault(env, "LC_CTYPE", fallbackValue)
}

func envValue(env []string, key string) (string, bool) {
	for _, entry := range env {
		entryKey, value, found := strings.Cut(entry, "=")
		if found && entryKey == key {
			return value, true
		}
	}
	return "", false
}

func envHasNonEmptyValue(env []string, key string) bool {
	value, found := envValue(env, key)
	return found && strings.TrimSpace(value) != ""
}

func envHasUTF8Locale(env []string) bool {
	for _, key := range []string{"LANG", "LC_CTYPE"} {
		value, found := envValue(env, key)
		if found && isUTF8LocaleValue(value) {
			return true
		}
	}
	return false
}

func isUTF8LocaleValue(value string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), "-", ""))
	return strings.Contains(normalized, "utf8")
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
	return r.shellKind
}
