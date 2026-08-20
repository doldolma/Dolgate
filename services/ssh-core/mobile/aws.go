package mobile

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"dolssh/services/ssh-core/internal/awssession"
	"dolssh/services/ssh-core/internal/protocol"
	"dolssh/services/ssh-core/internal/ssmforward"
	"dolssh/services/ssh-core/mobile/ringbuf"
	"dolssh/services/ssh-core/pkg/coretypes"

	"golang.org/x/crypto/ssh"
)

// AWS SSM 을 기기에서 직접 붙인다.
//
// **자격증명은 코어에 오지 않는다.** 앱이 AWS SDK 로 `ssm:StartSession` 을 부르고, 받은
// `streamUrl`·`tokenValue`(세션 암호화를 켠 계정이면 KMS 자료까지)만 넘긴다. 코어는 그것으로 MGS
// 데이터채널을 열고 그 위를 말한다 — 데스크톱과 완전히 같은 분담이고, 그래서 이 저장소의 Go
// 코드에는 AWS SDK 의존성이 아예 없다.
//
// 서버(sync-api)를 거치던 기존 모바일 경로와 다른 점은 하나다: 자격증명이 기기를 떠나지 않는다.

// SSM 셸의 출력 이력. SSH 셸과 같은 값을 쓴다 — 두 경로가 스크롤 복원에서 갈리면 안 된다.
const (
	ssmRingCapacityBytes = 1 << 20
	ssmRingMaxChunkBytes = 64 << 10
)

// AwsSsmClosedCallback 은 세션이 끝났을 때 한 번 불린다. reason 이 비어 있으면 정상 종료다.
type AwsSsmClosedCallback interface {
	OnAwsSsmClosed(reason string)
}

// awsSsmRequest 는 앱이 넘기는 SSM 셸 요청이다. 데스크톱이 코어에 보내는 것과 같은 payload 에
// 세션 손잡이만 붙였다.
type awsSsmRequest struct {
	ID string `json:"id"`
	coretypes.AWSConnectPayload
}

// ssmShell 은 SSM 세션의 실체다. 앱에는 `Shell` 로만 보인다.
//
// **셸 타입을 하나로 두는 것이 요점이다.** 네이티브 모듈(Kotlin·Swift)은 셸을 id 로 등록해 두고
// 입력·크기·구독·종료를 그 id 로 처리한다. SSM 을 별도 클래스로 내보내면 그 레지스트리와 TS
// 타입이 둘로 갈라지고, 두 경로 중 하나에만 있는 버그가 생긴다.
type ssmShell struct {
	manager     *awssession.Manager
	sessionID   string
	createdAtMs float64
	ring        *ringbuf.Ring
	fan         *outputFan

	closeOnce sync.Once
	closed    atomic.Bool
}

func (s *ssmShell) sendData(data []byte) error {
	return s.manager.WriteBytes(s.sessionID, data)
}

func (s *ssmShell) resize(rows, cols int) error {
	return s.manager.Resize(s.sessionID, cols, rows)
}

func (s *ssmShell) close() error {
	err := s.manager.Disconnect(s.sessionID)
	s.markClosed("", nil)
	return err
}

func (s *ssmShell) markClosed(reason string, onClosed AwsSsmClosedCallback) {
	s.closed.Store(true)
	s.closeOnce.Do(func() {
		s.fan.stopFollowers()
		s.ring.Close()
		if onClosed != nil {
			onClosed.OnAwsSsmClosed(reason)
		}
	})
}

// StartAwsSsmShell 은 SSM 셸을 열고 **SSH 셸과 같은 `Shell`** 을 돌려준다. onClosed 는 nil 일 수 있다.
//
// requestJSON: `{"id", ...AWSConnectPayload}` — `streamUrl`·`tokenValue` 가 필수이고,
// `region`·`instanceId` 는 로그와 오류 문구에 쓰인다. `shellKind` 는 윈도우 인스턴스에서
// "powershell" 이다(셸 통합 스크립트를 넣을 수 있는지가 여기서 갈린다).
func (e *Engine) StartAwsSsmShell(
	requestJSON string,
	onClosed AwsSsmClosedCallback,
) (*Shell, error) {
	var request awsSsmRequest
	if err := json.Unmarshal([]byte(requestJSON), &request); err != nil {
		return nil, fmt.Errorf("parse ssm request: %w", err)
	}
	if request.ID == "" {
		return nil, errors.New("ssm session id is required")
	}
	// 이 두 개가 없으면 코어가 할 수 있는 일이 없다. 여기서 막지 않으면 러너가 웹소켓 주소
	// 없이 열려다 실패하고, 앱에는 원인 없는 "연결 실패" 만 남는다.
	if request.StreamURL == "" || request.TokenValue == "" {
		return nil, errors.New("ssm streamUrl and tokenValue are required")
	}

	ring := ringbuf.New(ssmRingCapacityBytes, ssmRingMaxChunkBytes)
	inner := &ssmShell{
		sessionID:   request.ID,
		createdAtMs: float64(time.Now().UnixMilli()),
		ring:        ring,
		fan:         newOutputFan(ring),
	}

	// 매니저는 데스크톱과 같은 것을 쓴다. 이벤트는 종료 판정에만 쓰고, 화면에 필요한 출력은
	// 스트림으로 온다.
	inner.manager = awssession.NewManager(
		func(event protocol.Event) {
			switch event.Type {
			case protocol.EventClosed:
				inner.markClosed("", onClosed)
			case protocol.EventError:
				inner.markClosed(errorMessageOf(event.Payload), onClosed)
			}
		},
		func(_ protocol.StreamFrame, data []byte) {
			if len(data) > 0 {
				ring.Append(ringbuf.StreamStdout, data)
			}
		},
	)

	if err := inner.manager.Connect(request.ID, request.ID, request.AWSConnectPayload); err != nil {
		ring.Close()
		return nil, err
	}
	return &Shell{ssm: inner, fan: inner.fan}, nil
}

// InstallShellIntegration 은 SSM 셸에 셸 통합 스크립트를 넣는다. 윈도우 인스턴스에서는 매니저가
// 조용히 넘긴다(넣을 수 있는 셸이 아니다). SSH 셸에서는 아무것도 하지 않는다 — 그쪽은 앱이
// 명령으로 넣는다.
func (s *Shell) InstallShellIntegration() error {
	if s.ssm == nil {
		return nil
	}
	return s.ssm.manager.InstallShellIntegration(s.ssm.sessionID)
}

// SendControlSignal 은 제어 신호를 보낸다("interrupt"·"suspend"·"quit").
func (s *Shell) SendControlSignal(signal string) error {
	if s.ssm == nil {
		return errors.New("control signals are only available on SSM sessions")
	}
	return s.ssm.manager.SendControlSignal(s.ssm.sessionID, signal)
}

// ssmForwardRequest 는 SSH over SSM 을 태울 로컬 포워드 요청이다.
type ssmForwardRequest struct {
	ID string `json:"id"`
	coretypes.SSMPortForwardStartPayload
}

// SsmForward 는 SSM 데이터채널에 붙은 로컬 리스너 하나다.
//
// **SSH over SSM 은 이것 위에서 평범한 SSH 로 붙는다.** 데스크톱도 같은 방식이다(로컬 터널을
// 열고 그 주소로 SSH). 전송로를 SSH 코드에 새로 끼우지 않는 것이 요점이다 — 그러면 점프·SFTP·
// mosh 가 전부 그대로 동작한다.
type SsmForward struct {
	service  *ssmforward.Service
	ruleID   string
	bindPort atomic.Int32

	// 리스너가 실제로 열린 포트를 기다리는 자리. 0 포트를 요청하면 커널이 정해 주므로 이벤트로
	// 되돌아온다.
	ready chan struct{}
	once  sync.Once
}

// StartSsmPortForward 는 SSM 포트포워드를 열고 실제로 묶인 로컬 포트를 알려 준다.
//
// requestJSON: `{"id", ...SSMPortForwardStartPayload}` — `streamUrl`·`tokenValue` 는 앱이
// 포트포워딩 문서로 `StartSession` 을 불러 받은 값이고, `bindPort` 를 0 으로 두면 빈 포트를
// 커널이 고른다(모바일에서는 고정 포트를 쓸 이유가 없다).
func (e *Engine) StartSsmPortForward(requestJSON string) (*SsmForward, error) {
	var request ssmForwardRequest
	if err := json.Unmarshal([]byte(requestJSON), &request); err != nil {
		return nil, fmt.Errorf("parse ssm forward request: %w", err)
	}
	if request.ID == "" {
		return nil, errors.New("ssm forward id is required")
	}
	if request.StreamURL == "" || request.TokenValue == "" {
		return nil, errors.New("ssm streamUrl and tokenValue are required")
	}
	// 기기에서는 루프백만 연다. 다른 주소로 열면 같은 네트워크의 기기가 이 터널로 들어올 수 있다.
	request.BindAddress = "127.0.0.1"

	forward := &SsmForward{ruleID: request.ID, ready: make(chan struct{})}
	forward.service = ssmforward.New(func(event protocol.Event) {
		if event.Type != protocol.EventPortForwardStarted {
			return
		}
		payload, ok := event.Payload.(protocol.PortForwardStartedPayload)
		if !ok || payload.BindPort <= 0 {
			return
		}
		forward.bindPort.Store(int32(payload.BindPort))
		forward.once.Do(func() { close(forward.ready) })
	})

	if err := forward.service.Start(request.ID, request.ID, request.SSMPortForwardStartPayload); err != nil {
		return nil, err
	}
	// Start 는 리스너를 연 뒤에 이벤트를 내므로 여기서는 이미 채워져 있다. 그래도 기다리는 것은
	// 순서를 코드로 보장하지 않기 위해서다(러너가 바뀌면 순서가 달라질 수 있다).
	<-forward.ready
	return forward, nil
}

// BindPort 는 SSH 가 붙어야 할 로컬 포트다.
func (f *SsmForward) BindPort() int32 { return f.bindPort.Load() }

// Stop 은 터널을 닫는다. 세션이 끝나면 반드시 불러야 한다 — 남겨 두면 SSM 세션이 AWS 쪽에
// 살아 있는 것으로 남는다.
func (f *SsmForward) Stop() error { return f.service.Stop(f.ruleID, f.ruleID) }

// errorMessageOf 는 오류 이벤트에서 사람이 읽을 문구만 꺼낸다.
func errorMessageOf(payload any) string {
	// protocol.ErrorPayload 는 coretypes.ErrorPayload 의 별칭이라 한 갈래로 충분하다.
	if typed, ok := payload.(coretypes.ErrorPayload); ok {
		return typed.Message
	}
	return ""
}

// GenerateEphemeralSshKey 는 SSH over SSM 에 쓸 임시 키쌍을 만든다.
//
// **왜 코어에 있는가.** EC2 Instance Connect 는 공개키를 60초 동안만 인스턴스에 밀어 넣어 주는
// 방식이라 세션마다 새 키가 필요하다. 데스크톱은 Node 의 crypto 로 만드는데 모바일에는 그것이
// 없고, 여기에는 이미 SSH 구현이 있다 — 키를 만들 자리로 여기가 가장 가깝다.
//
// ed25519 를 쓰는 이유: EIC 가 받아 주고, 키가 짧고, 생성이 즉시 끝난다(RSA 는 기기에서 수백
// 밀리초를 먹는다).
//
// 돌려주는 JSON: {"privateKeyPem","publicKey"} — publicKey 는 authorized_keys 한 줄이다.
func (e *Engine) GenerateEphemeralSshKey() (string, error) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", fmt.Errorf("generate ephemeral key: %w", err)
	}
	pemBlock, err := ssh.MarshalPrivateKey(private, "")
	if err != nil {
		return "", fmt.Errorf("encode ephemeral key: %w", err)
	}
	sshPublic, err := ssh.NewPublicKey(public)
	if err != nil {
		return "", fmt.Errorf("encode ephemeral public key: %w", err)
	}
	encoded, err := json.Marshal(map[string]string{
		"privateKeyPem": string(pem.EncodeToMemory(pemBlock)),
		// 뒤에 주석을 붙이지 않는다 — EIC 는 쓰지 않고, 값이 그대로 로그에 남을 자리가 준다.
		"publicKey": strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPublic))),
	})
	if err != nil {
		return "", fmt.Errorf("encode ephemeral key result: %w", err)
	}
	return string(encoded), nil
}
