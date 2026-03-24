package awssession

import (
	"errors"
	"fmt"
	"io"
	"os"
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
}

type sessionExit struct {
	ExitCode int
	Signal   string
}

func defaultRunnerFactory(payload protocol.AWSConnectPayload) (sessionRunner, error) {
	switch os.Getenv("DOLSSH_E2E_FAKE_AWS_SESSION") {
	case "1":
		return newFakeRunner("Connected to fake AWS SSM smoke session.\r\n"), nil
	case "process":
		runtime, err := resolveProcessBackedFakeRuntime()
		if err != nil {
			return nil, err
		}
		return startPlatformAWSRunner(payload, runtime)
	}

	runtime, err := resolveAWSRuntime(payload)
	if err != nil {
		return nil, err
	}

	return startPlatformAWSRunner(payload, runtime)
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

func buildAWSArgs(payload protocol.AWSConnectPayload) []string {
	return []string{
		"ssm",
		"start-session",
		"--target",
		payload.InstanceID,
		"--profile",
		payload.ProfileName,
		"--region",
		payload.Region,
	}
}

func describeExit(exit sessionExit, err error) string {
	if err != nil {
		return err.Error()
	}
	if exit.Signal != "" {
		return fmt.Sprintf("AWS SSM session exited with signal %s", exit.Signal)
	}
	if exit.ExitCode != 0 {
		return fmt.Sprintf("AWS SSM session exited with code %d", exit.ExitCode)
	}
	return ""
}

func mergeChildEnv(pathValue string, caseInsensitive bool) []string {
	env := os.Environ()
	if pathValue == "" {
		return env
	}

	replaced := false
	for index, entry := range env {
		key, _, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		if envKeyMatches(key, "PATH", caseInsensitive) {
			env[index] = fmt.Sprintf("%s=%s", key, pathValue)
			replaced = true
		}
	}

	if !replaced {
		env = append(env, fmt.Sprintf("PATH=%s", pathValue))
	}

	return env
}

func envKeyMatches(left, right string, caseInsensitive bool) bool {
	if caseInsensitive {
		return strings.EqualFold(left, right)
	}
	return left == right
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
