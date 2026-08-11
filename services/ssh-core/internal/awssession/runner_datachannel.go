package awssession

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/ssmdatachannel"
)

// datachannelRunner drives an AWS SSM session over the in-process data channel
// instead of spawning aws + session-manager-plugin. The remote PTY lives on the
// SSM agent, so there is no local PTY/ConPTY: input, output, resize, and control
// signals are all just protocol messages.
type datachannelRunner struct {
	dc     *ssmdatachannel.SsmDataChannel
	reader *io.PipeReader
	writer *io.PipeWriter
	output chan []byte

	done chan struct{}

	mu     sync.Mutex
	killed bool
	exit   sessionExit
	waitEr error
	// pendingSize 는 아직 원격에 전달하지 못한 터미널 크기다(0 이면 없음).
	//
	// 협상이 끝나기 전에 보낸 크기는 에이전트가 조용히 버린다. 그래서 첫 출력이 올 때까지
	// 들고 있다가 그때 보낸다(자세한 이유는 sendPendingSize 주석).
	pendingRows uint32
	pendingCols uint32

	finishOnce sync.Once
	closeCh    chan struct{}
}

func startDataChannelRunner(payload protocol.AWSConnectPayload) (sessionRunner, error) {
	dc := new(ssmdatachannel.SsmDataChannel)
	// 세션을 열기 전에 넣어야 한다 — 에이전트는 handshake 에서 곧바로 KMS 암호화를 요구하고,
	// 그 시점에 자료가 없으면 세션이 취소된다.
	if err := applySessionEncryption(dc, payload); err != nil {
		return nil, err
	}
	if err := dc.OpenWithSessionToken(payload.StreamURL, payload.TokenValue); err != nil {
		return nil, fmt.Errorf("opening SSM data channel: %w", err)
	}

	cols, rows := normalizedSize(payload.Cols, payload.Rows)

	reader, writer := io.Pipe()
	runner := &datachannelRunner{
		dc:     dc,
		reader: reader,
		writer: writer,
		// 크기는 여기서 보내지 않는다 — 첫 출력을 받은 뒤에 보낸다(sendPendingSize 주석).
		pendingRows: uint32(rows),
		pendingCols: uint32(cols),
		output:      make(chan []byte, 1024),
		done:        make(chan struct{}),
		closeCh:     make(chan struct{}),
	}
	go runner.pump()
	go runner.drainOutput()
	return runner, nil
}

// pump moves decoded output payloads from the data channel into the pipe the
// manager reads via Streams(). It owns the runner's exit state.
func (r *datachannelRunner) pump() {
	defer close(r.done)
	defer close(r.output)

	for {
		msg, err := r.dc.ReadFrame()
		if err != nil {
			r.finish(err)
			return
		}

		payload, err := r.dc.HandleMsg(msg)
		if len(payload) > 0 {
			// 출력이 오기 시작했다는 것은 원격 셸이 떴다는 뜻이다 — 이제 크기를 받아 준다.
			r.sendPendingSize()
			copied := append([]byte(nil), payload...)
			select {
			case r.output <- copied:
			case <-r.closeCh:
				r.finish(nil)
				return
			}
		}
		if err != nil {
			r.finish(err)
			return
		}
	}
}

func (r *datachannelRunner) drainOutput() {
	defer r.writer.Close()
	for payload := range r.output {
		if len(payload) == 0 {
			continue
		}
		if _, err := r.writer.Write(payload); err != nil {
			r.finish(err)
			return
		}
	}
}

// errSessionEncryptionRejected 는 KMS 암호화 세션이 협상 중에 취소됐을 때의 문구다.
//
// 클라이언트가 kms:GenerateDataKey 로 만든 암호문 키를 에이전트가 **인스턴스 역할로**
// kms:Decrypt 해야 하는데, 그 절반이 빠져 있는 경우가 압도적으로 많다(권한을 양쪽에 나눠 줘야
// 하는 것이 문서에도 잘 안 드러난다). 인스턴스 쪽 에이전트 로그에는 "Fetching data key failed"
// 로 남는다.
var errSessionEncryptionRejected = errors.New(
	"SSM agent cancelled the KMS-encrypted session during the handshake: " +
		"the instance role usually needs kms:Decrypt on the session encryption key " +
		"(see the agent log for the exact reason)",
)

func (r *datachannelRunner) finish(cause error) {
	r.finishOnce.Do(func() {
		close(r.closeCh)

		r.mu.Lock()
		killed := r.killed
		if !killed && r.dc.EncryptionEnabled() && !r.dc.HandshakeCompleted() {
			// 에이전트가 협상 도중 세션을 취소했다. 원격 셸은 아예 시작되지 않았으므로 정상
			// 종료로 볼 수 없다.
			//
			// **이유는 이 채널로 올 수 없다.** 에이전트는 handshake 를 시작할 때 이미 암호화를
			// 켠 것으로 두고, 데이터 키 복호화가 실패하면 그 오류 문구조차 초기화되지 않은
			// cipher 로 암호화하려 한다(amazon-ssm-agent datachannel.go). 그래서 우리에게는
			// 이유 없는 종료로만 도착한다 — 실제 원인의 대부분인 인스턴스 쪽 권한을 문구에
			// 직접 담는다.
			r.exit = sessionExit{ExitCode: 1}
			r.waitEr = errSessionEncryptionRejected
		} else if cause == nil || errors.Is(cause, io.EOF) || killed {
			// Remote shell exit (ChannelClosed) or client-requested disconnect.
			r.exit = sessionExit{}
			r.waitEr = nil
		} else {
			r.exit = sessionExit{ExitCode: 1}
			r.waitEr = cause
		}
		r.mu.Unlock()

		_ = r.writer.Close()
		_ = r.dc.Close()
	})
}

// SetLatencyHandler forwards the data channel's ping→pong round-trip time so the
// manager can report it as a tab latency indicator (mirrors SSH keepalive RTT).
func (r *datachannelRunner) SetLatencyHandler(fn func(time.Duration)) {
	r.dc.SetRTTHandler(fn)
}

func (r *datachannelRunner) Write(data []byte) error {
	_, err := r.dc.Write(data)
	return err
}

func (r *datachannelRunner) SendControlSignal(signal string) error {
	normalized, err := normalizeControlSignal(signal)
	if err != nil {
		return err
	}

	// The remote PTY interprets the control byte; there is no local process to
	// signal. 0x03=ETX (Ctrl-C), 0x1a=SUB (Ctrl-Z), 0x1c=FS (Ctrl-\).
	var control byte
	switch normalized {
	case "interrupt":
		control = 0x03
	case "suspend":
		control = 0x1a
	case "quit":
		control = 0x1c
	}
	_, err = r.dc.Write([]byte{control})
	return err
}

func (r *datachannelRunner) Resize(cols, rows int) error {
	r.mu.Lock()
	pending := r.pendingRows != 0 || r.pendingCols != 0
	if pending {
		// 아직 첫 출력을 못 받았다. 지금 보내도 버려지므로 최신 크기만 갈아 두고 기다린다 —
		// 접속 시 크기 대신 이 값이 나가야 한다(그 사이 창이 바뀌었다는 뜻이므로).
		r.pendingRows = uint32(rows)
		r.pendingCols = uint32(cols)
	}
	r.mu.Unlock()
	if pending {
		return nil
	}
	return r.dc.SetTerminalSize(uint32(rows), uint32(cols))
}

// sendPendingSize 는 들고 있던 터미널 크기를 한 번 보낸다.
//
// **협상 전에는 보낼 수 없다.** 에이전트는 협상이 끝나기 전에 도착한 스트림 데이터를 ack 만 하고
// 버리고(amazon-ssm-agent datachannel.go processStreamDataMessage), 협상 직후에도 플러그인이
// 핸들러를 등록하기까지 200ms 남짓의 틈이 있어 그때 도착한 것은 ack 조차 받지 못한다. 첫 출력이
// 왔다면 그 두 관문을 모두 지난 것이 확실하다.
//
// 이걸 안 지키면 접속 시 크기가 조용히 사라져, 사용자가 창을 한 번 건드릴 때까지 원격이 기본
// 크기로 남는다(줄바꿈이 어긋난다).
func (r *datachannelRunner) sendPendingSize() {
	r.mu.Lock()
	rows, cols := r.pendingRows, r.pendingCols
	r.pendingRows, r.pendingCols = 0, 0
	r.mu.Unlock()
	if rows == 0 && cols == 0 {
		return
	}
	if err := r.dc.SetTerminalSize(rows, cols); err != nil {
		log.Printf("SSM 터미널 크기 전달 실패: %v", err)
	}
}

func (r *datachannelRunner) Kill() error {
	r.mu.Lock()
	r.killed = true
	r.mu.Unlock()

	// Ask the service to end the session, then drop the socket; the pump exits
	// via its read error and reports a clean disconnect because killed is set.
	_ = r.dc.TerminateSession()
	err := r.dc.Close()
	// A pump stalled on pipe backpressure only unblocks when the pipe closes;
	// readers drain what was consumed and then see EOF.
	_ = r.writer.Close()
	return err
}

func (r *datachannelRunner) Close() error {
	err := r.dc.Close()
	_ = r.writer.Close()
	_ = r.reader.Close()
	return err
}

func (r *datachannelRunner) Streams() []io.Reader {
	return []io.Reader{r.reader}
}

func (r *datachannelRunner) Wait() (sessionExit, error) {
	<-r.done
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.exit, r.waitEr
}

// applySessionEncryption 은 호출부가 준 KMS 데이터 키 자료를 데이터 채널에 넣는다.
//
// 자료가 없으면 아무 일도 하지 않는다 — 세션 암호화를 쓰지 않는 계정이 대부분이고, 그 경우
// 에이전트는 KMS 액션을 아예 요청하지 않는다.
func applySessionEncryption(dc *ssmdatachannel.SsmDataChannel, payload protocol.AWSConnectPayload) error {
	if payload.KmsPlainTextKeyB64 == "" {
		return nil
	}
	plainTextKey, err := base64.StdEncoding.DecodeString(payload.KmsPlainTextKeyB64)
	if err != nil {
		return fmt.Errorf("decoding SSM session data key: %w", err)
	}
	cipherTextBlob, err := base64.StdEncoding.DecodeString(payload.KmsCipherTextBlobB64)
	if err != nil {
		return fmt.Errorf("decoding SSM session data key blob: %w", err)
	}
	dc.SetSessionEncryption(ssmdatachannel.SessionEncryption{
		KMSKeyID:       payload.KmsKeyID,
		CipherTextBlob: cipherTextBlob,
		PlainTextKey:   plainTextKey,
	})
	return nil
}
