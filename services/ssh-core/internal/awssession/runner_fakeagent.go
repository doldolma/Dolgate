package awssession

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

const fakeAgentListenTimeout = 10 * time.Second

// startProcessBackedFakeAgentRunner spawns the e2e fixture — a local WebSocket
// server speaking the SSM data-channel protocol — and drives it through the same
// datachannel runner the product uses against real AWS. This keeps smoke tests
// on the production transport with no aws CLI, plugin, or PTY involved.
func startProcessBackedFakeAgentRunner(payload protocol.AWSConnectPayload) (sessionRunner, error) {
	fixturePath := strings.TrimSpace(os.Getenv("DOLSSH_E2E_FAKE_AWS_FIXTURE_PATH"))
	if fixturePath == "" {
		return nil, errors.New("DOLSSH_E2E_FAKE_AWS_FIXTURE_PATH is required for process-backed fake AWS sessions")
	}

	command := exec.Command(fixturePath)
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("capture fake agent stdout: %w", err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start fake agent fixture: %w", err)
	}

	urls := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if url, found := strings.CutPrefix(line, "LISTENING "); found {
				urls <- strings.TrimSpace(url)
				return
			}
		}
		close(urls)
	}()

	var streamURL string
	select {
	case url, ok := <-urls:
		if !ok || url == "" {
			_ = ignoreProcessDone(command.Process.Kill())
			return nil, errors.New("fake agent fixture exited before announcing its listen address")
		}
		streamURL = url
	case <-time.After(fakeAgentListenTimeout):
		_ = ignoreProcessDone(command.Process.Kill())
		return nil, errors.New("timed out waiting for the fake agent fixture to listen")
	}

	payload.StreamURL = streamURL
	payload.TokenValue = "e2e-fake-token"
	runner, err := startDataChannelRunner(payload)
	if err != nil {
		_ = ignoreProcessDone(command.Process.Kill())
		return nil, err
	}

	// Reap the fixture whenever it exits (it exits itself on TerminateSession or
	// socket close).
	go func() { _ = command.Wait() }()

	return &fakeAgentProcessRunner{sessionRunner: runner, command: command}, nil
}

// fakeAgentProcessRunner ties the fixture process lifetime to the runner.
type fakeAgentProcessRunner struct {
	sessionRunner
	command *exec.Cmd
}

func (r *fakeAgentProcessRunner) Kill() error {
	err := r.sessionRunner.Kill()
	_ = ignoreProcessDone(r.command.Process.Kill())
	return err
}

func (r *fakeAgentProcessRunner) Close() error {
	err := r.sessionRunner.Close()
	_ = ignoreProcessDone(r.command.Process.Kill())
	return err
}
