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

	// runSem 은 채널 하나를 한 번에 한 명령만 쓰게 하는 자리다. Mutex 가 아닌 이유: 순서를
	// 기다리는 데에도 **기한이 있어야** 한다. Lock() 은 무한정 기다리므로 앞선 명령이 오래
	// 걸리면 뒤에 선 질의는 자기 예산을 한 번도 못 써 보고 호출자(데스크톱)의 요청 타임아웃에
	// 먼저 걸렸다 — 코어는 아무 답도 못 보내고 "Timed out waiting for SSH core response" 만
	// 남았다. 이제 기다리는 시간도 예산 안에서 잰다.
	runSem  chan struct{}
	stateMu sync.Mutex
	process *completionWorkerProcess
	closed  bool
}

// ErrCompletionLaneBusy 는 예산 안에 보조 채널 차례가 오지 않았다는 뜻이다. 명령을 시작조차
// 하지 않았으므로 원격에는 아무 일도 없었다 — 호출자는 그냥 다음 주기에 다시 물으면 된다.
var ErrCompletionLaneBusy = errors.New("completion lane busy")

type completionWorkerStarter func() (*completionWorkerProcess, error)

type completionWorkerProcess struct {
	stdin  io.WriteCloser
	stdout io.Reader
	close  func() error
}

func NewCompletionWorker(client *ssh.Client) *CompletionWorker {
	return newCompletionWorkerForTest(sshCompletionWorkerStarter(client))
}

func newCompletionWorkerForTest(start completionWorkerStarter) *CompletionWorker {
	return &CompletionWorker{start: start, runSem: make(chan struct{}, 1)}
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

// Run 은 명령을 돌리고 stdout 을 돌려준다.
//
// timeout 은 **왕복 전체**의 예산이다 — 채널 차례를 기다리는 시간까지 포함한다. 실행에만 걸면
// 앞선 명령이 예산을 다 쓰는 동안 뒤의 질의는 시계도 못 켜고, 그 합이 호출자의 요청 타임아웃을
// 넘겨 코어가 답 자체를 못 보내게 된다. 여기서 끝을 정해 두면 늦어도 "늦었다" 는 답은 간다.
func (worker *CompletionWorker) Run(command string, timeout time.Duration, maxBytes int) ([]byte, bool, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()

	select {
	case worker.runSem <- struct{}{}:
		defer func() { <-worker.runSem }()
	case <-deadline.C:
		return nil, false, fmt.Errorf("%w: waited %s for the aux channel", ErrCompletionLaneBusy, timeout)
	}

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

	// 남은 예산으로 기다린다(위에서 이미 쓴 만큼은 빠져 있다) — deadline 은 Run 시작에 걸었다.
	select {
	case result := <-resultCh:
		if result.err != nil {
			worker.resetStarted()
		}
		return result.output, result.truncated, result.err
	case <-deadline.C:
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
