package awssession

import (
	"errors"
	"fmt"
	"io"
	"os"

	"dolssh/services/ssh-core/internal/protocol"
)

const (
	defaultCols = 120
	defaultRows = 32
)

type sessionRunner interface {
	Write(data []byte) error
	SendControlSignal(signal string) error
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
		return startProcessBackedFakeAgentRunner(payload)
	}

	if payload.StreamURL == "" || payload.TokenValue == "" {
		return nil, errors.New("AWS SSM 세션 토큰이 없습니다. 앱을 다시 시작한 뒤 다시 시도해 주세요.")
	}
	return startDataChannelRunner(payload)
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

func normalizeControlSignal(signal string) (string, error) {
	switch signal {
	case "interrupt", "suspend", "quit":
		return signal, nil
	default:
		return "", fmt.Errorf("unsupported control signal: %s", signal)
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

func ignoreProcessDone(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}
