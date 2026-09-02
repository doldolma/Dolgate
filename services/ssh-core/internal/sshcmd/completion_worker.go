package sshcmd

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

var ErrCompletionWorkerUnavailable = errors.New("completion worker unavailable")

// ExitCodeUnknown 은 원격 명령의 종료 코드를 알아내지 못했다는 뜻이다(프레임이 끊겼거나,
// 출력이 상한에 걸려 꼬리가 잘렸거나, 애초에 상태를 싣지 않는 경로다).
//
// **"모른다" 를 "성공" 으로 접지 않는다.** 호출자가 실패로 단정하지 않게 하려는 값이지,
// 성공했다는 말이 아니다.
const ExitCodeUnknown = -1

// CompletionOutput 은 보조 채널 한 번의 결과다.
//
// 예전에는 stdout 과 truncated 만 돌려줬다. 그래서 **명령이 실패한 것과 정말 아무것도 없는
// 것이 같은 값**(빈 문자열)으로 도착했고, 세션 패널이 실패를 "없습니다" 로 그렸다 — 19.03
// 호스트의 컨테이너 탭이 오류 한 줄 없이 비어 있던 것이 그 결과다. 종료 코드와 stderr 를
// 함께 실어 그 둘을 가른다.
type CompletionOutput struct {
	Stdout []byte
	// Stderr 는 이 명령이 낸 오류 문장이다(앞부분 몇 KB). **분류하지 않는다** — 화면은 원문을
	// 그대로 보여 준다. 문구로 의도를 추측하면 오안내가 된다.
	Stderr []byte
	// ExitCode 는 원격 명령의 종료 코드. 알아내지 못했으면 ExitCodeUnknown.
	ExitCode int
	// Truncated 는 stdout 이 상한에 걸려 잘렸다는 뜻이다.
	Truncated bool
}

// Failed 는 이 왕복이 "명령이 제대로 돌지 않았다" 로 읽혀야 하는가다.
//
// 모르는 것은 실패가 아니다 — 상태를 못 받은 경로(로컬 폴백·잘린 출력)에서 멀쩡한 답을
// 실패로 뒤집으면 고치려던 결함의 거울상이 된다.
func (output CompletionOutput) Failed() bool {
	return output.ExitCode > 0
}

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
	// stderr 는 이 워커 셸의 오류 스트림을 담는 자리다. exec 채널은 stdout 과 stderr 가 별도
	// 스트림이라 섞이지 않는다 — 예전에는 io.Discard 로 버려서, 명령이 왜 실패했는지 아무도
	// 알 수 없었다(그래서 화면이 "없습니다" 라고만 말했다).
	stderr *BoundedBuffer
	close  func() error
}

// CompletionStderrLimit 은 한 명령의 오류 문장에서 남길 앞부분이다. 화면은 첫 줄만 보여 주고,
// 사람이 원문을 알아보는 데에는 이 정도면 넘친다 — 장수 워커가 메모리를 무한정 물지 않게 한다.
//
// **로컬 세션도 같은 상한을 쓴다.** 같은 것을 담는데 한쪽만 무제한이면 그쪽이 사고 자리가 된다.
const CompletionStderrLimit = 4 * 1024

// BoundedBuffer 는 앞에서부터 limit 바이트만 담는 io.Writer 다. 넘치는 뒤쪽은 버린다 — 오류의
// 사연은 첫 줄에 있지 마지막 줄에 있지 않다.
type BoundedBuffer struct {
	mu    sync.Mutex
	limit int
	data  []byte
}

// NewBoundedBuffer 는 상한이 걸린 버퍼를 만든다. limit 이 0 이하면 아무것도 담지 않는다(그래도
// 쓰기는 받아 준다 — 짧게 답하면 io.Copy 가 스트림을 끊는다).
func NewBoundedBuffer(limit int) *BoundedBuffer {
	return &BoundedBuffer{limit: limit}
}

func (buffer *BoundedBuffer) Write(chunk []byte) (int, error) {
	// **받은 길이를 먼저 붙잡는다.** 아래에서 chunk 를 잘라 쓰므로, 자른 뒤의 길이를 돌려주면
	// 상한을 넘는 그 한 번이 짧은 쓰기가 된다 — io.Copy 는 그것을 ErrShortWrite 로 보고 복사를
	// 멈추고, 그러면 이 워커의 stderr 는 영영 비워지지 않는다(채널 창이 차면 원격이 stderr 를
	// 쓰다 멈춰 명령까지 걸린다).
	written := len(chunk)
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	if remaining := buffer.limit - len(buffer.data); remaining > 0 {
		if len(chunk) > remaining {
			chunk = chunk[:remaining]
		}
		buffer.data = append(buffer.data, chunk...)
	}
	// 담지 못한 바이트도 **쓴 것으로 답한다.** 오류 문장 몇 줄 때문에 워커를 잃을 일이 아니다.
	return written, nil
}

// Take 는 담긴 것을 돌려주고 버퍼를 비운다. 워커는 한 번에 한 명령만 돌리므로(runSem) 프레임
// 앞뒤로 비우고 읽으면 그 명령의 것이다.
func (buffer *BoundedBuffer) Take() []byte {
	// 워커 프로세스를 다른 방식으로 띄우는 경로(테스트 픽스처 등)는 이 자리를 비워 둘 수 있다.
	if buffer == nil {
		return nil
	}
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	data := buffer.data
	buffer.data = nil
	return data
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
		stderr := NewBoundedBuffer(CompletionStderrLimit)
		session.Stderr = stderr
		if err := session.Start("sh -s"); err != nil {
			_ = stdin.Close()
			_ = session.Close()
			return nil, fmt.Errorf("%w: %v", ErrCompletionWorkerUnavailable, err)
		}
		return &completionWorkerProcess{
			stdin:  stdin,
			stdout: stdout,
			stderr: stderr,
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
func (worker *CompletionWorker) Run(
	command string,
	timeout time.Duration,
	maxBytes int,
) (CompletionOutput, error) {
	unknown := CompletionOutput{ExitCode: ExitCodeUnknown}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()

	select {
	case worker.runSem <- struct{}{}:
		defer func() { <-worker.runSem }()
	case <-deadline.C:
		return unknown, fmt.Errorf("%w: waited %s for the aux channel", ErrCompletionLaneBusy, timeout)
	}

	process, err := worker.ensureStarted()
	if err != nil {
		return unknown, err
	}

	markers, err := completionMarkers()
	if err != nil {
		worker.resetStarted()
		return unknown, err
	}

	// 앞선 명령의 늦은 오류 문장이 이 명령의 것으로 딸려 오지 않게 프레임을 열기 전에 비운다.
	_ = process.stderr.Take()

	resultCh := make(chan completionReadResult, 1)
	go func() {
		output, truncated, err := readCompletionFrame(
			process.stdout,
			[]byte(markers.start),
			[]byte(markers.end),
			maxBytes,
		)
		resultCh <- completionReadResult{output: output, truncated: truncated, err: err}
	}()

	if _, err := io.WriteString(process.stdin, buildCompletionWorkerScript(command, markers)); err != nil {
		worker.resetStarted()
		return unknown, err
	}

	// 남은 예산으로 기다린다(위에서 이미 쓴 만큼은 빠져 있다) — deadline 은 Run 시작에 걸었다.
	select {
	case result := <-resultCh:
		if result.err != nil {
			worker.resetStarted()
		}
		stdout, exitCode := splitCompletionStatus(result.output, markers.status)
		return CompletionOutput{
			Stdout:    stdout,
			Stderr:    process.stderr.Take(),
			ExitCode:  exitCode,
			Truncated: result.truncated,
		}, result.err
	case <-deadline.C:
		worker.resetStarted()
		return unknown, fmt.Errorf("completion command timed out after %s", timeout)
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

type completionFrameMarkers struct {
	start  string
	status string
	end    string
}

func completionMarkers() (completionFrameMarkers, error) {
	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		return completionFrameMarkers{}, err
	}
	nonce := hex.EncodeToString(random)
	return completionFrameMarkers{
		start:  "__DOLGATE_COMPLETION_START_" + nonce + "__",
		status: "__DOLGATE_COMPLETION_RC_" + nonce + "__",
		end:    "__DOLGATE_COMPLETION_END_" + nonce + "__",
	}, nil
}

// buildCompletionWorkerScript 는 한 명령을 프레임으로 감싼다.
//
// **끝 마커 앞에 종료 코드를 싣는다.** 그것이 "명령이 실패했다" 와 "찍을 것이 없었다" 를 가르는
// 유일한 근거다 — 둘 다 빈 stdout 으로 오기 때문이다. 왕복은 늘지 않는다(바이트 몇 개다).
//
// 앞에 붙이는 줄바꿈은 명령이 개행 없이 끝나도 마커가 제 줄에서 시작하게 한다. 읽는 쪽이 그
// 한 줄을 되돌린다(splitCompletionStatus).
//
// 상태를 **마커 앞**에 두는 이유: 읽는 쪽은 끝 마커를 보는 순간 프레임을 닫는다. 뒤에 두면
// 그 값을 영영 읽지 못한다.
func buildCompletionWorkerScript(command string, markers completionFrameMarkers) string {
	return "\nprintf '%s\\n' " + QuotePosix(markers.start) + "\n" +
		"(\n" + command + "\n) </dev/null\n" +
		"__dolgate_rc=$?\n" +
		"printf '\\n%s%d\\n' " + QuotePosix(markers.status) + " \"$__dolgate_rc\"\n" +
		"printf '%s\\n' " + QuotePosix(markers.end) + "\n"
}

// splitCompletionStatus 는 프레임 꼬리의 상태 줄을 떼어낸다.
//
// 마커는 nonce 라 명령 출력과 부딪히지 않는다. 꼬리가 없으면(출력이 상한에 걸려 잘렸다)
// 모른다고 답한다 — 잘릴 만큼 찍었다는 것은 명령이 돌았다는 뜻이라 실패로 볼 이유가 없다.
func splitCompletionStatus(frame []byte, marker string) ([]byte, int) {
	index := bytes.LastIndex(frame, []byte(marker))
	if index < 0 {
		return frame, ExitCodeUnknown
	}
	code := ExitCodeUnknown
	if parsed, err := strconv.Atoi(string(bytes.TrimSpace(frame[index+len(marker):]))); err == nil {
		code = parsed
	}
	stdout := frame[:index]
	// 마커 앞에 우리가 넣은 줄바꿈 하나를 되돌린다 — 명령의 출력만 남긴다.
	if len(stdout) > 0 && stdout[len(stdout)-1] == '\n' {
		stdout = stdout[:len(stdout)-1]
	}
	return stdout, code
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
