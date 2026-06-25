package sshcmd

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

var ErrCompletionWorkerUnavailable = errors.New("completion worker unavailable")

type CompletionWorker struct {
	start completionWorkerStarter

	runMu   sync.Mutex
	stateMu sync.Mutex
	process *completionWorkerProcess
	closed  bool
}

type completionWorkerStarter func() (*completionWorkerProcess, error)

type completionWorkerProcess struct {
	stdin  io.WriteCloser
	stdout io.Reader
	close  func() error
}

func NewCompletionWorker(client *ssh.Client) *CompletionWorker {
	return &CompletionWorker{start: sshCompletionWorkerStarter(client)}
}

func newCompletionWorkerForTest(start completionWorkerStarter) *CompletionWorker {
	return &CompletionWorker{start: start}
}

func sshCompletionWorkerStarter(client *ssh.Client) completionWorkerStarter {
	return func() (*completionWorkerProcess, error) {
		if client == nil {
			return nil, fmt.Errorf("%w: nil SSH client", ErrCompletionWorkerUnavailable)
		}
		session, err := client.NewSession()
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrCompletionWorkerUnavailable, err)
		}
		stdin, err := session.StdinPipe()
		if err != nil {
			_ = session.Close()
			return nil, fmt.Errorf("%w: %v", ErrCompletionWorkerUnavailable, err)
		}
		stdout, err := session.StdoutPipe()
		if err != nil {
			_ = stdin.Close()
			_ = session.Close()
			return nil, fmt.Errorf("%w: %v", ErrCompletionWorkerUnavailable, err)
		}
		session.Stderr = io.Discard
		if err := session.Start("sh -s"); err != nil {
			_ = stdin.Close()
			_ = session.Close()
			return nil, fmt.Errorf("%w: %v", ErrCompletionWorkerUnavailable, err)
		}
		return &completionWorkerProcess{
			stdin:  stdin,
			stdout: stdout,
			close: func() error {
				_ = stdin.Close()
				return session.Close()
			},
		}, nil
	}
}

func (worker *CompletionWorker) Run(command string, timeout time.Duration, maxBytes int) ([]byte, bool, error) {
	worker.runMu.Lock()
	defer worker.runMu.Unlock()

	process, err := worker.ensureStarted()
	if err != nil {
		return nil, false, err
	}

	startMarker, endMarker, err := completionMarkers()
	if err != nil {
		worker.resetStarted()
		return nil, false, err
	}

	resultCh := make(chan completionReadResult, 1)
	go func() {
		output, truncated, err := readCompletionFrame(
			process.stdout,
			[]byte(startMarker),
			[]byte(endMarker),
			maxBytes,
		)
		resultCh <- completionReadResult{output: output, truncated: truncated, err: err}
	}()

	if _, err := io.WriteString(process.stdin, buildCompletionWorkerScript(command, startMarker, endMarker)); err != nil {
		worker.resetStarted()
		return nil, false, err
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case result := <-resultCh:
		if result.err != nil {
			worker.resetStarted()
		}
		return result.output, result.truncated, result.err
	case <-timer.C:
		worker.resetStarted()
		return nil, false, fmt.Errorf("completion command timed out after %s", timeout)
	}
}

func (worker *CompletionWorker) Close() error {
	worker.stateMu.Lock()
	defer worker.stateMu.Unlock()
	worker.closed = true
	return worker.closeStartedLocked()
}

func (worker *CompletionWorker) ensureStarted() (*completionWorkerProcess, error) {
	worker.stateMu.Lock()
	defer worker.stateMu.Unlock()
	if worker.closed {
		return nil, errors.New("completion worker closed")
	}
	if worker.process != nil {
		return worker.process, nil
	}
	process, err := worker.start()
	if err != nil {
		return nil, err
	}
	worker.process = process
	return process, nil
}

func (worker *CompletionWorker) resetStarted() {
	worker.stateMu.Lock()
	defer worker.stateMu.Unlock()
	_ = worker.closeStartedLocked()
}

func (worker *CompletionWorker) closeStartedLocked() error {
	if worker.process == nil {
		return nil
	}
	process := worker.process
	worker.process = nil
	if process.close != nil {
		return process.close()
	}
	return nil
}

type completionReadResult struct {
	output    []byte
	truncated bool
	err       error
}

func completionMarkers() (string, string, error) {
	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		return "", "", err
	}
	nonce := hex.EncodeToString(random)
	return "__DOLGATE_COMPLETION_START_" + nonce + "__",
		"__DOLGATE_COMPLETION_END_" + nonce + "__",
		nil
}

func buildCompletionWorkerScript(command, startMarker, endMarker string) string {
	return "\nprintf '%s\\n' " + QuotePosix(startMarker) + "\n" +
		"(\n" + command + "\n) </dev/null\n" +
		"printf '%s\\n' " + QuotePosix(endMarker) + "\n"
}

func readCompletionFrame(reader io.Reader, startMarker, endMarker []byte, maxBytes int) ([]byte, bool, error) {
	buffer := make([]byte, 4096)
	pending := make([]byte, 0, 4096)
	output := make([]byte, 0, minPositive(maxBytes, 4096))
	foundStart := false
	skipStartLineBreak := false
	truncated := false

	appendOutput := func(data []byte) {
		if len(data) == 0 {
			return
		}
		if maxBytes <= 0 {
			truncated = true
			return
		}
		remaining := maxBytes - len(output)
		if remaining <= 0 {
			truncated = true
			return
		}
		if len(data) > remaining {
			output = append(output, data[:remaining]...)
			truncated = true
			return
		}
		output = append(output, data...)
	}

	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			pending = append(pending, buffer[:n]...)
			for {
				if !foundStart {
					idx := bytes.Index(pending, startMarker)
					if idx < 0 {
						pending = keepTail(pending, len(startMarker)-1)
						break
					}
					pending = append([]byte(nil), pending[idx+len(startMarker):]...)
					foundStart = true
					skipStartLineBreak = true
				}
				if skipStartLineBreak {
					next, done := trimOneLineBreak(pending)
					if !done {
						break
					}
					pending = next
					skipStartLineBreak = false
				}
				idx := bytes.Index(pending, endMarker)
				if idx >= 0 {
					appendOutput(pending[:idx])
					return output, truncated, nil
				}
				keep := len(endMarker) - 1
				if len(pending) > keep {
					appendOutput(pending[:len(pending)-keep])
					pending = keepTail(pending, keep)
				}
				break
			}
		}
		if err != nil {
			return output, truncated, err
		}
	}
}

func keepTail(value []byte, limit int) []byte {
	if limit <= 0 || len(value) == 0 {
		return nil
	}
	if len(value) <= limit {
		return value
	}
	return append([]byte(nil), value[len(value)-limit:]...)
}

func trimOneLineBreak(value []byte) ([]byte, bool) {
	if len(value) == 0 {
		return value, false
	}
	if value[0] == '\n' {
		return value[1:], true
	}
	if value[0] != '\r' {
		return value, true
	}
	if len(value) == 1 {
		return value, false
	}
	if value[1] == '\n' {
		return value[2:], true
	}
	return value[1:], true
}

func minPositive(left, right int) int {
	if left <= 0 || right <= 0 {
		return 0
	}
	if left < right {
		return left
	}
	return right
}
