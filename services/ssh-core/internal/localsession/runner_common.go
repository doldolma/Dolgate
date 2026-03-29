package localsession

import (
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"

	"dolssh/services/ssh-core/internal/protocol"
)

const (
	defaultCols = 120
	defaultRows = 32
)

type sessionRunner interface {
	Write(data []byte) error
	Resize(cols, rows int) error
	Kill() error
	Close() error
	Streams() []io.Reader
	Wait() (sessionExit, error)
	ShellKind() string
}

type sessionExit struct {
	ExitCode int
	Signal   string
}

type localCommandRuntime struct {
	shellKind        string
	executablePath   string
	args             []string
	env              []string
	wrapperPath      string
	workingDirectory string
}

func defaultRunnerFactory(payload protocol.LocalConnectPayload) (sessionRunner, error) {
	runtime, err := resolveLocalRuntime(payload)
	if err != nil {
		return nil, err
	}
	return startPlatformLocalRunner(payload, runtime)
}

func buildRuntimeEnv(base []string, overrides map[string]string) []string {
	if len(overrides) == 0 {
		return append([]string(nil), base...)
	}
	envMap := make(map[string]string, len(base)+len(overrides))
	for _, entry := range base {
		key, value, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		envMap[key] = value
	}
	for key, value := range overrides {
		if key == "" {
			continue
		}
		envMap[key] = value
	}
	nextEnv := make([]string, 0, len(envMap))
	for key, value := range envMap {
		nextEnv = append(nextEnv, fmt.Sprintf("%s=%s", key, value))
	}
	slices.Sort(nextEnv)
	return nextEnv
}

func normalizedSize(cols, rows int) (int, int) {
	if cols <= 0 {
		cols = defaultCols
	}
	if rows <= 0 {
		rows = defaultRows
	}
	return cols, rows
}

func describeExit(exit sessionExit, err error) string {
	if err != nil {
		return err.Error()
	}
	if exit.Signal != "" {
		return fmt.Sprintf("Local shell exited with signal %s", exit.Signal)
	}
	if exit.ExitCode != 0 {
		return fmt.Sprintf("Local shell exited with code %d", exit.ExitCode)
	}
	return ""
}

func ignoreProcessDone(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}
