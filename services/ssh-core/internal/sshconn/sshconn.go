package sshconn

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"dolssh/services/ssh-core/pkg/coretypes"
	"golang.org/x/crypto/ssh"
)

var errHostKeyProbed = errors.New("host key probed")

// dialAddress 는 Dial 에 넘길 "host:port" 를 만든다.
//
// 직접 이어붙이면 안 된다 — IPv6 리터럴은 대괄호로 감싸야 하므로 "2001:db8::1" 과 22 를
// "%s:%d" 로 붙이면 "2001:db8::1:22" 가 되고, net.Dial 이 "too many colons" 로 거부한다.
// 호스트 입력은 비어 있는지만 검사하므로 사용자가 IPv6 리터럴을 그대로 넣을 수 있다.
func dialAddress(host string, port int) string {
	return net.JoinHostPort(host, strconv.Itoa(port))
}

// Target는 SSH, SFTP, 포트 포워딩이 공통으로 쓰는 접속 대상 정보다.
type Target struct {
	Host                  string
	Port                  int
	Username              string
	AuthType              string
	Password              string
	PrivateKeyPEM         string
	CertificateText       string
	Passphrase            string
	TrustedHostKeyBase64  string
	TrustedHostKeysBase64 []string
	// Jump이 설정되면 그 호스트(베스천)를 먼저 접속한 뒤, 그 위로 TCP를 포워딩해
	// 이 Target에 2차 SSH 핸드셰이크를 한다 (ProxyJump / `ssh -J`). 재귀 구조라
	// 다단 체인도 표현 가능하지만 현재 UI는 단일 홉만 사용한다.
	Jump *Target
	// WSProxy가 설정되면 직접 TCP dial 대신 sync-api로 가는 WebSocket을 raw 전송으로
	// 쓰고 그 위에 SSH 핸드셰이크를 올린다(서버 프록시/bastion, IP 제한 VPC 대응).
	// 이 경우 Jump는 무시된다 — 프록시 경로 자체가 대상까지의 통로다.
	WSProxy *coretypes.WSProxyTarget
}

// JumpTargetFromCore는 와이어 페이로드의 점프 호스트(coretypes.JumpTarget)를
// dial용 Target으로 재귀 변환한다. nil이면 nil을 돌려줘서 호출부에서 그대로
// Target.Jump에 대입할 수 있다(점프 미설정 = 직접 접속).
func JumpTargetFromCore(jump *coretypes.JumpTarget) *Target {
	if jump == nil {
		return nil
	}
	return &Target{
		Host:                  jump.Host,
		Port:                  jump.Port,
		Username:              jump.Username,
		AuthType:              jump.AuthType,
		Password:              jump.Password,
		PrivateKeyPEM:         jump.PrivateKeyPEM,
		CertificateText:       jump.CertificateText,
		Passphrase:            jump.Passphrase,
		TrustedHostKeyBase64:  jump.TrustedHostKeyBase64,
		TrustedHostKeysBase64: jump.TrustedHostKeysBase64,
		Jump:                  JumpTargetFromCore(jump.Jump),
	}
}

// ProgressStage는 한 홉(점프 또는 최종 대상)의 연결 단계다.
type ProgressStage string

const (
	ProgressConnecting ProgressStage = "connecting"
	ProgressConnected  ProgressStage = "connected"
	ProgressFailed     ProgressStage = "failed"
)

// ProgressEvent는 DialClient가 각 홉을 연결하며 보고하는 진행 상태다(다단 ProxyJump UI용).
type ProgressEvent struct {
	HopLabel string
	Stage    ProgressStage
}

type ProgressFunc func(ProgressEvent)

type Config struct {
	TCPDialTimeout time.Duration
	// HandshakeStallTimeout 은 핸드셰이크 중 한 바이트도 움직이지 않는 것을 얼마나 참을지다.
	// 0 이면 기본값(HandshakeStallTimeout)을 쓴다. stall_guard.go 참고.
	HandshakeStallTimeout time.Duration
	// HandshakeApprovalTimeout 은 서버가 배너로 사람에게 할 일을 알린 뒤 기다려 주는 시간이다.
	// Banner 가 설정돼 있을 때만 쓴다 — 보여줄 수 없는 안내를 기다리는 건 그냥 정지다.
	HandshakeApprovalTimeout time.Duration
	// HostKeyTrust 는 처음 보는 서버 키를 이 연결 **안에서** 신뢰할지 묻는다.
	//
	// 없으면 예전대로 "trusted host key is required" 로 끝난다(프로브·호스트 편집 경로). 있으면
	// 키를 미리 읽어 오는 별도 연결이 필요 없어져서, OTP 를 요구하는 점프 호스트에 인증을 두 번
	// 하지 않는다 — 실기기에서 30초마다 바뀌는 코드를 두 번 넣어야 해서 통과하지 못했다.
	//
	// 저장된 키와 **다른** 키가 온 경우는 묻지 않는다(hostkeytrust.go 참고).
	HostKeyTrust         HostKeyTrustFunc
	TCPKeepAliveInterval time.Duration
	// Banner 가 설정되면 서버가 인증 단계에 보낸 배너(RFC 4252 §5.4)를 그대로 올려 준다.
	//
	// **왜 콜백인가:** 어떤 서버는 배너로 사람에게 할 일을 말하고(예: "이 주소에서 승인하라")
	// 그것이 끝날 때까지 인증 응답을 보내지 않는다. 실패한 뒤에 문구로 알려 주면 사용자는 이미
	// 끊긴 연결을 다시 시작해야 한다. 붙어 있는 동안 화면에 보여 줘야 그 자리에서 끝난다.
	//
	// 내용을 해석하지 않는다 — 승인 링크인지 회사 경고문인지는 사용자가 읽고 판단한다.
	// 우리가 문구를 뒤져 의도를 추측하면 정책 안내 링크를 "승인하라"고 잘못 말하게 된다.
	Banner func(text string)
	// InteractiveResponder 는 호스트 키 프로브가 점프 호스트에 인증할 때 사용자에게 물을 창구다.
	//
	// DialClient 는 이것을 인자로 받지만 ProbeHostKey 는 여기서 받는다 — 프로브는 요청·응답 한
	// 번짜리라 원래 아무 창구도 없었고, 그래서 **대화형 인증을 요구하는 점프 호스트를 경유하는
	// 호스트는 프로브가 통과할 수 없었다**(OTP 베스천에서 "keyboard-interactive responder is not
	// configured" 로 끝났다). 비어 있으면 예전처럼 그 오류를 낸다.
	InteractiveResponder InteractiveResponder
	// Progress가 설정되면 DialClient가 홉마다 connecting→connected(또는 failed)를 보고한다.
	// config가 점프 체인 재귀에 전파돼 가장 깊은 점프부터 순서대로 이벤트가 도착한다.
	Progress ProgressFunc
	// AuthAgentEndpoint*이 설정되고 target.AuthType이 "agent"면, 로컬 ssh-agent(1Password 등)에
	// 연결해 서명을 위임한다. config가 점프 체인 재귀에 전파되므로 모든 홉이 같은 로컬 agent를 쓴다.
	AuthAgentEndpointKind string
	AuthAgentEndpoint     string
	// Dial 이 설정되면 직접 TCP 대신 이것으로 raw 연결을 연다(tailnet 경유).
	//
	// config 는 점프 체인 재귀에 전파되므로, 점프가 있으면 베스천까지만 이 경로로 가고
	// 대상은 베스천 연결 위로 간다 — 실제로 소켓을 여는 홉만 tailnet 을 탄다는 뜻이고,
	// 그게 맞는 동작이다.
	//
	// 반환된 conn 의 Close 가 tailnet 노드 리스를 놓는 지점이다. 그래서 호출부가 리스를
	// 따로 들고 다닐 필요가 없다 — 이미 conn/client 를 닫고 있으므로 수명이 저절로 맞는다.
	Dial DialFunc
}

// DialFunc 는 raw 전송을 여는 함수다.
type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// TailnetDialResolver 는 tailnet 경로를 raw dialer 로 바꾼다. 런타임이 레지스트리를 들고
// 있으므로 세션 계층은 이 함수만 받는다 — 반환된 dialer 가 만든 conn 이 닫힐 때 노드 리스가
// 풀리므로, 호출부는 평소처럼 client 만 닫으면 된다.
type TailnetDialResolver func(tailnetID, expectedName string) (DialFunc, error)

// ResolveTailnetDial 은 resolver 가 없거나 경로가 비었을 때 nil 을 돌려준다. 다섯 군데가 같은
// nil 검사를 반복하지 않게 하려고 여기 둔다 — 한 곳이라도 빼먹으면 그 경로만 조용히 일반
// 네트워크로 나간다.
func ResolveTailnetDial(resolve TailnetDialResolver, tailnetID, expectedName string) (DialFunc, error) {
	if resolve == nil || strings.TrimSpace(tailnetID) == "" {
		return nil, nil
	}
	return resolve(tailnetID, expectedName)
}

type HostKeyProbeResult struct {
	Algorithm         string
	PublicKeyBase64   string
	FingerprintSHA256 string
}

type CertificateInspection struct {
	Status      string
	ValidAfter  *time.Time
	ValidBefore *time.Time
	Principals  []string
	KeyID       string
	Serial      uint64
}

type PrivateKeyInspection struct {
	Algorithm         string
	PublicKey         string
	FingerprintSHA256 string
}

type PrivateKeyGenerationRequest struct {
	Algorithm        string
	Curve            string
	RSABits          int
	PrivateKeyCipher string
	KDFRounds        int
	Comment          string
	Passphrase       string
}

type PrivateKeyGeneration struct {
	Algorithm           string
	PrivateKeyPEM       string
	PublicKey           string
	FingerprintSHA256   string
	PrivateKeyEncrypted bool
	KeyCurve            string
	KeyBits             int
	PrivateKeyCipher    string
	PrivateKeyKDFRounds int
}

type InteractivePrompt struct {
	Label string
	Echo  bool
	// AllowStoredPassword 는 이 칸에 "저장된 비밀번호 사용" 을 내밀어도 되는지다.
	//
	// 인증 코드 칸에는 내밀지 않는다 — 거기에 비밀번호를 보내면 그 시도로 연결이 끝난다
	// (keyboard-interactive 는 방식당 한 번뿐이다). 그 밖에는 라벨을 몰라도 내민다: 어느 칸이
	// 비밀번호인지 단정하지 않고 사용자가 지목하게 하는 것이 그 기능의 전제다.
	AllowStoredPassword bool
	// Masked 는 입력을 가려서 보여줄지다.
	//
	// 서버의 Echo 를 그대로 쓰지 않는다: 일회용 코드도 echo 를 끄고 오는데, 그것까지 가리면
	// 사용자가 여섯 자리를 확인하지 못한 채 보내야 한다. 비밀번호는 그대로 가린다.
	Masked bool
}

type InteractiveChallenge struct {
	Name        string
	Instruction string
	Prompts     []InteractivePrompt
	// Hop 은 이 프롬프트를 낸 홉이다.
	//
	// 점프 체인에서는 이것이 없으면 사용자가 **누구의** 코드를 넣는지 알 수 없다 — 베스천과 최종
	// 대상이 각각 OTP 를 물으면 화면에는 똑같은 "Verification code:" 만 두 번 뜬다. 엉뚱한 쪽의
	// 코드를 넣으면 그 시도로 연결이 끝난다(keyboard-interactive 는 방식당 한 번뿐이다).
	Hop InteractiveHop
}

// InteractiveHop 은 프롬프트를 낸 홉의 신원이다.
type InteractiveHop struct {
	Username string
	Host     string
	Port     int
}

type InteractiveResponder func(challenge InteractiveChallenge) ([]string, error)

var DefaultConfig = Config{
	TCPDialTimeout:           10 * time.Second,
	HandshakeStallTimeout:    HandshakeStallTimeout,
	HandshakeApprovalTimeout: HandshakeApprovalTimeout,
	TCPKeepAliveInterval:     30 * time.Second,
}

// HopProgress builds a Config.Progress callback that emits EventConnectionHopProgress for
// each hop of a (possibly multi-hop ProxyJump) connection, correlated by sessionID and/or
// endpointID so the renderer attaches it to the right connection's overlay. hopCount is
// precomputed from target's jump chain; hopIndex advances on each "connecting" (deepest
// jump arrives first). Reused by EVERY DialClient caller — terminal sessions, sftp,
// containers, forwarding, mosh, tmux, and the host-key probe — so per-hop progress is
// uniform across all connection types instead of wired per-path. Returns nil if emit is nil.
func HopProgress(target Target, sessionID, endpointID string, emit func(coretypes.Event)) ProgressFunc {
	if emit == nil {
		return nil
	}
	hopCount := 1
	for jump := target.Jump; jump != nil; jump = jump.Jump {
		hopCount++
	}
	hopIndex := 0
	return func(ev ProgressEvent) {
		if ev.Stage == ProgressConnecting {
			hopIndex++
		}
		emit(coretypes.Event{
			Type:       coretypes.EventConnectionHopProgress,
			SessionID:  sessionID,
			EndpointID: endpointID,
			Payload: coretypes.ConnectionHopProgressPayload{
				SessionID:  sessionID,
				EndpointID: endpointID,
				HopLabel:   ev.HopLabel,
				HopIndex:   hopIndex,
				HopCount:   hopCount,
				Stage:      string(ev.Stage),
			},
		})
	}
}

// ErrTransportConflict 는 서버 프록시와 tailnet 을 동시에 요구했을 때다.
//
// 둘은 대상까지의 raw 전송을 각자 대신하므로 함께 쓸 수 없다. 지금은 호스트 종류로 갈려서
// (wsProxy 는 aws-ec2, tailnet 은 ssh) 동시에 설정될 일이 없지만, 조용히 한쪽이 이기게 두면
// 나중에 넓어질 때 "tailnet 을 지정했는데 서버 프록시로 나가는" 것을 아무도 모른다.
var ErrTransportConflict = errors.New(
	"sshconn: ws proxy and tailnet dialer are mutually exclusive",
)

func assertSingleTransport(target Target, config Config) error {
	if target.WSProxy != nil && config.Dial != nil {
		return ErrTransportConflict
	}
	return nil
}

func DialClient(
	ctx context.Context,
	target Target,
	config Config,
	responder InteractiveResponder,
) (*ssh.Client, error) {
	if err := assertSingleTransport(target, config); err != nil {
		return nil, err
	}
	if config.TCPDialTimeout == 0 {
		config.TCPDialTimeout = DefaultConfig.TCPDialTimeout
	}
	if config.TCPKeepAliveInterval == 0 {
		config.TCPKeepAliveInterval = DefaultConfig.TCPKeepAliveInterval
	}

	// 핸드셰이크 정지 감시. 인증 방식이 다이얼보다 먼저 만들어지므로 감시자를 여기서 만들고,
	// conn 은 다이얼 뒤에 붙인다(stall_guard.go 참고).
	if config.HandshakeStallTimeout == 0 {
		config.HandshakeStallTimeout = DefaultConfig.HandshakeStallTimeout
	}
	if config.HandshakeApprovalTimeout == 0 {
		config.HandshakeApprovalTimeout = DefaultConfig.HandshakeApprovalTimeout
	}
	guard := newStallGuard(config.HandshakeStallTimeout)
	// 사람을 기다리는 동안에는 시계를 멈춘다 — Warpgate 브라우저 승인·2FA 는 몇 분이 정상이다.
	guardedResponder := responder
	if responder != nil {
		guardedResponder = func(challenge InteractiveChallenge) ([]string, error) {
			guard.Pause()
			defer guard.Resume()
			return responder(challenge)
		}
	}

	authMethods, cleanupAuth, err := resolveAuthMethods(target, config, guardedResponder)
	if err != nil {
		return nil, err
	}
	// agent 인증은 핸드셰이크 동안 로컬 ssh-agent 연결이 필요하다. 연결 성립(NewClientConn) 후 정리.
	defer cleanupAuth()

	hostKeyCallback, err := hostKeyCallbackFor(target, config.HostKeyTrust)
	if err != nil {
		return nil, err
	}

	// 호스트 키 콜백은 키 교환 중에 불린다. 그것이 불렸는지가 곧 "전송 계층이 끝났는지" 이므로,
	// 정지가 키 교환 단계인지 인증 단계인지를 이 값으로 갈라 문구에 담는다(banner.go 참고).
	// 검사 전에 세우는 이유: 키를 받아 판정까지 했다면 전송 계층은 제 일을 한 것이다.
	var hostKeyChecked atomic.Bool
	verifiedHostKeyCallback := hostKeyCallback
	hostKeyCallback = func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		hostKeyChecked.Store(true)
		return verifiedHostKeyCallback(hostname, remote, key)
	}

	// 서버가 인증 단계에 보내는 배너. 안 받으면 x/crypto 가 조용히 버린다(banner.go 참고).
	banner := &bannerCollector{}

	clientConfig := &ssh.ClientConfig{
		User:            target.Username,
		Auth:            authMethods,
		HostKeyCallback: hostKeyCallback,
		Timeout:         config.TCPDialTimeout,
		BannerCallback: func(message string) error {
			// 실패 문구용으로도 모아 둔다 — 터미널이 없는 경로(SFTP·포워딩·컨테이너)는 문구가
			// 유일한 수단이다.
			_ = banner.callback(message)

			text := truncateBanner(sanitizeBanner(message))
			// 보여줄 수 있을 때만 더 기다린다. 보여줄 곳이 없으면 그냥 정지이므로 평소 한도로
			// 실패하고, 배너는 오류 문구에 실려 나간다.
			if text == "" || config.Banner == nil {
				return nil
			}
			config.Banner(text)
			guard.Extend(config.HandshakeApprovalTimeout)
			return nil
		},
	}

	addr := dialAddress(target.Host, target.Port)
	hopLabel := fmt.Sprintf("%s@%s:%d", target.Username, target.Host, target.Port)
	reportProgress := func(stage ProgressStage) {
		if config.Progress != nil {
			config.Progress(ProgressEvent{HopLabel: hopLabel, Stage: stage})
		}
	}

	// Establish the raw TCP connection to the target — either directly, or, when a
	// jump host is configured, tunneled through the jump client's connection
	// (ProxyJump). The target SSH handshake below then runs end-to-end over it.
	var (
		rawConn    net.Conn
		jumpClient *ssh.Client
	)
	if target.WSProxy != nil {
		// 서버 프록시(bastion): 대상까지의 raw 전송을 sync-api WebSocket으로 대신한다.
		// sync-api가 EIC·SSM 터널을 서버 IP에서 열고 instance:22로 raw TCP를 중계하므로
		// 아래 SSH 핸드셰이크는 일반 TCP 연결과 동일하게 이 conn 위에서 진행된다.
		reportProgress(ProgressConnecting)
		rawConn, err = dialWSProxyConn(target.WSProxy, config.TCPDialTimeout)
		if err != nil {
			reportProgress(ProgressFailed)
			return nil, fmt.Errorf("ws proxy: %w", err)
		}
	} else if target.Jump != nil {
		jumpClient, err = DialClient(ctx, *target.Jump, config, responder)
		if err != nil {
			return nil, fmt.Errorf("jump host: %w", err)
		}
		reportProgress(ProgressConnecting)
		rawConn, err = jumpClient.Dial("tcp", addr)
		if err != nil {
			reportProgress(ProgressFailed)
			_ = jumpClient.Close()
			return nil, fmt.Errorf("dial through jump host: %w", err)
		}
	} else if config.Dial != nil {
		// tailnet 경유. 노드가 아직 안 올라와 있으면 여기서 올라오기를 기다린다 — 최초
		// 등록이면 브라우저 로그인 시간이 이 안에 들어간다.
		reportProgress(ProgressConnecting)
		// 예산은 일반 TCP dial 과 같다 — tailnet 을 거친다고 짧게 줄 근거가 없다. 노드를 올리는
		// 것은 이미 앞 단계(관문)가 끝냈고, 여기부터는 대상까지 가는 raw 연결일 뿐이다.
		//
		// 호출자의 ctx 를 그대로 받는다. 더 이른 데드라인이나 취소가 있으면 그것이 이긴다.
		dialCtx, cancel := context.WithTimeout(ctx, config.TCPDialTimeout)
		defer cancel()
		rawConn, err = config.Dial(dialCtx, "tcp", addr)
		if err != nil {
			reportProgress(ProgressFailed)
			return nil, err
		}
	} else {
		reportProgress(ProgressConnecting)
		dialer := &net.Dialer{
			Timeout:   config.TCPDialTimeout,
			KeepAlive: config.TCPKeepAliveInterval,
		}
		rawConn, err = dialer.Dial("tcp", addr)
		if err != nil {
			reportProgress(ProgressFailed)
			return nil, fmt.Errorf("dial failed: %w", err)
		}
	}

	// 핸드셰이크 동안 취소가 먹게 한다. ssh.NewClientConn 은 ctx 를 받지 않으므로 conn 을 닫는
	// 것만이 막혀 있는 읽기를 푸는 방법이다 — 배너 승인처럼 몇 분을 기다리는 구간에서 "닫기" 가
	// 즉시 듣는 근거가 이것이다.
	//
	// defer 로 닫지 않는다: 그러면 함수가 끝날 때까지 감시가 살아 있어, 연결이 성립한 뒤 호출자가
	// 연결용 ctx 를 취소하는 순간 멀쩡한 세션의 conn 을 닫아 버린다.
	handshakeDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = rawConn.Close()
		case <-handshakeDone:
		}
	}()

	// 감시를 붙인 conn 으로 핸드셰이크한다. TCP 는 붙었는데 그 뒤가 멈추면 영원히 기다리기
	// 때문이다 — ssh.NewClientConn 은 ClientConfig.Timeout 을 보지 않는다.
	guardedConn := guard.Wrap(rawConn)
	clientConn, chans, reqs, err := ssh.NewClientConn(guardedConn, addr, clientConfig)
	close(handshakeDone)
	if err != nil {
		// 홉을 함께 남긴다 — 체인에서 어느 서버가 거절했는지가 문구만으로는 드러나지 않는다.
		AuthLogf("%s: handshake failed: %v", hopLabel, err)
		reportProgress(ProgressFailed)
		_ = rawConn.Close()
		if jumpClient != nil {
			_ = jumpClient.Close()
		}
		return nil, fmt.Errorf("ssh handshake failed: %w",
			annotateHandshakeFailure(err, banner, hostKeyChecked.Load()))
	}
	AuthLogf("%s: authenticated", hopLabel)
	// 성공했으면 감시를 끈다. 안 끄면 세션의 평소 읽기가 10초마다 끊긴다(유지는 keepalive 담당).
	guard.Release()
	reportProgress(ProgressConnected)

	client := ssh.NewClient(clientConn, chans, reqs)
	if jumpClient != nil {
		// Close the jump connection once the target session ends (target Close /
		// remote hang-up / jump drop all unblock Wait), so the bastion link isn't
		// leaked for the life of the process.
		go func() {
			_ = client.Wait()
			_ = jumpClient.Close()
		}()
	}
	return client, nil
}

// ProbeHostKey는 인증 전에 서버의 실제 호스트 키만 읽어와 TOFU/UI 비교에 사용한다.
// jump이 설정되면 그 베스천을 먼저 접속한 뒤 그 위로 타깃에 TCP를 포워딩해 키를
// 읽는다 — 베스천 뒤의(직접 닿지 않는) 타깃 키도 신뢰할 수 있게 한다. 베스천 인증은
// 비대화형(password/privateKey/certificate)만 지원하며(responder 없이 DialClient),
// keyboard-interactive 베스천을 경유하는 probe는 현재 지원하지 않는다.
func ProbeHostKey(
	ctx context.Context,
	host string,
	port int,
	jump *Target,
	wsProxy *coretypes.WSProxyTarget,
	config Config,
) (HostKeyProbeResult, error) {
	if err := assertSingleTransport(Target{WSProxy: wsProxy}, config); err != nil {
		return HostKeyProbeResult{}, err
	}
	if config.TCPDialTimeout == 0 {
		config.TCPDialTimeout = DefaultConfig.TCPDialTimeout
	}
	if config.TCPKeepAliveInterval == 0 {
		config.TCPKeepAliveInterval = DefaultConfig.TCPKeepAliveInterval
	}

	addr := dialAddress(host, port)

	// 최종 대상(점프 뒤의 타깃) 홉은 DialClient 밖에서 열리므로(점프 클라이언트의 Dial),
	// 그 홉의 connecting/connected/failed를 config.Progress로 직접 보고한다. 이래야 "점프까지는
	// 됐는데 타깃 포워딩에서 거부(open failed)"처럼 마지막 홉에서 나는 실패가 홉 UI에 보인다.
	reportTarget := func(stage ProgressStage) {
		if config.Progress != nil {
			config.Progress(ProgressEvent{HopLabel: addr, Stage: stage})
		}
	}

	var rawConn net.Conn
	if wsProxy != nil {
		// 서버 프록시(bastion): 타깃까지의 raw 전송을 sync-api WebSocket으로 대신한다.
		// sync-api가 EIC·SSM 터널을 서버 IP에서 열고 instance:port로 raw TCP를 중계하므로
		// 아래 호스트 키 read는 일반 TCP 연결과 동일하게 이 conn 위에서 진행된다.
		reportTarget(ProgressConnecting)
		var err error
		rawConn, err = dialWSProxyConn(wsProxy, config.TCPDialTimeout)
		if err != nil {
			reportTarget(ProgressFailed)
			return HostKeyProbeResult{}, fmt.Errorf("ws proxy: %w", err)
		}
	} else if jump != nil {
		// 점프 호스트가 대화형 인증(OTP 등)을 요구할 수 있다. 창구가 있으면 넘긴다 — 없으면
		// 예전처럼 그 자리에서 "responder is not configured" 로 끝난다.
		jumpClient, err := DialClient(ctx, *jump, config, config.InteractiveResponder)
		if err != nil {
			return HostKeyProbeResult{}, fmt.Errorf("jump host: %w", err)
		}
		defer jumpClient.Close()
		reportTarget(ProgressConnecting)
		rawConn, err = jumpClient.Dial("tcp", addr)
		if err != nil {
			reportTarget(ProgressFailed)
			return HostKeyProbeResult{}, fmt.Errorf("dial through jump host: %w", err)
		}
	} else if config.Dial != nil {
		// 프로브도 같은 통로로 가야 한다. 여기서 직접 TCP 로 나가면 tailnet 안에만 있는
		// 호스트의 키를 읽을 수 없고, 읽더라도 tailnet 밖의 동명 호스트 키를 읽게 된다.
		reportTarget(ProgressConnecting)
		// DialClient 와 같은 계약이다 — 예산은 일반 TCP dial 과 같고, 호출자의 ctx 가 이긴다.
		dialCtx, cancel := context.WithTimeout(ctx, config.TCPDialTimeout)
		defer cancel()
		var err error
		rawConn, err = config.Dial(dialCtx, "tcp", addr)
		if err != nil {
			reportTarget(ProgressFailed)
			return HostKeyProbeResult{}, err
		}
	} else {
		reportTarget(ProgressConnecting)
		dialer := &net.Dialer{
			Timeout:   config.TCPDialTimeout,
			KeepAlive: config.TCPKeepAliveInterval,
		}
		var err error
		rawConn, err = dialer.Dial("tcp", addr)
		if err != nil {
			reportTarget(ProgressFailed)
			return HostKeyProbeResult{}, fmt.Errorf("dial failed: %w", err)
		}
	}
	defer rawConn.Close()

	var result HostKeyProbeResult
	clientConfig := &ssh.ClientConfig{
		User: "probe",
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			result = HostKeyProbeResult{
				Algorithm:         key.Type(),
				PublicKeyBase64:   base64.StdEncoding.EncodeToString(key.Marshal()),
				FingerprintSHA256: ssh.FingerprintSHA256(key),
			}
			return errHostKeyProbed
		},
		Timeout: config.TCPDialTimeout,
	}

	_, _, _, err := ssh.NewClientConn(rawConn, addr, clientConfig)
	if result.PublicKeyBase64 != "" {
		reportTarget(ProgressConnected)
		return result, nil
	}
	reportTarget(ProgressFailed)
	if err != nil {
		return HostKeyProbeResult{}, fmt.Errorf("host key probe failed: %w", err)
	}
	return HostKeyProbeResult{}, fmt.Errorf("host key probe failed: empty result")
}

func InspectCertificate(certificateText string, now time.Time) CertificateInspection {
	cert, err := resolveCertificate(Target{CertificateText: certificateText})
	if err != nil {
		return CertificateInspection{Status: "invalid"}
	}

	result := CertificateInspection{
		Status:     "valid",
		Principals: append([]string(nil), cert.ValidPrincipals...),
		KeyID:      cert.KeyId,
		Serial:     cert.Serial,
	}

	validAfter := certificateUnixTime(cert.ValidAfter)
	result.ValidAfter = validAfter

	if cert.ValidBefore != ssh.CertTimeInfinity {
		result.ValidBefore = certificateUnixTime(cert.ValidBefore)
	}

	if validAfter != nil && now.Before(*validAfter) {
		result.Status = "not_yet_valid"
		return result
	}

	if result.ValidBefore != nil && !now.Before(*result.ValidBefore) {
		result.Status = "expired"
	}

	return result
}

func InspectPrivateKey(privateKeyPEM string, passphrase string) (PrivateKeyInspection, error) {
	signer, err := resolvePrivateKeySigner(Target{
		PrivateKeyPEM: privateKeyPEM,
		Passphrase:    passphrase,
	})
	if err != nil {
		return PrivateKeyInspection{}, err
	}

	publicKey := signer.PublicKey()
	return PrivateKeyInspection{
		Algorithm:         publicKey.Type(),
		PublicKey:         strings.TrimSpace(string(ssh.MarshalAuthorizedKey(publicKey))),
		FingerprintSHA256: ssh.FingerprintSHA256(publicKey),
	}, nil
}

func GeneratePrivateKey(request PrivateKeyGenerationRequest) (PrivateKeyGeneration, error) {
	algorithm := request.Algorithm
	if algorithm != "ecdsa" && algorithm != "rsa" {
		algorithm = "ed25519"
	}

	var (
		privateKey any
		keyCurve   string
		keyBits    int
		err        error
	)

	switch algorithm {
	case "ecdsa":
		keyCurve = request.Curve
		curve := elliptic.P521()
		if keyCurve == "nistp256" {
			curve = elliptic.P256()
		} else if keyCurve == "nistp384" {
			curve = elliptic.P384()
		} else {
			keyCurve = "nistp521"
		}
		privateKey, err = ecdsa.GenerateKey(curve, rand.Reader)
	case "rsa":
		keyBits = 4096
		if request.RSABits == 3072 {
			keyBits = 3072
		}
		privateKey, err = rsa.GenerateKey(rand.Reader, keyBits)
	default:
		_, privateKey, err = ed25519.GenerateKey(rand.Reader)
	}
	if err != nil {
		return PrivateKeyGeneration{}, err
	}

	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		return PrivateKeyGeneration{}, err
	}

	normalizedPassphrase := strings.TrimSpace(request.Passphrase)
	block, privateKeyCipher, privateKeyKDFRounds, err := marshalOpenSSHPrivateKeyWithOptions(
		privateKey,
		request.Comment,
		privateKeyEncryptionOptions{
			Passphrase: []byte(normalizedPassphrase),
			Cipher:     request.PrivateKeyCipher,
			KDFRounds:  request.KDFRounds,
		},
	)
	if err != nil {
		return PrivateKeyGeneration{}, err
	}

	publicKey := signer.PublicKey()
	return PrivateKeyGeneration{
		Algorithm:           publicKey.Type(),
		PrivateKeyPEM:       string(pem.EncodeToMemory(block)),
		PublicKey:           strings.TrimSpace(string(ssh.MarshalAuthorizedKey(publicKey))),
		FingerprintSHA256:   ssh.FingerprintSHA256(publicKey),
		PrivateKeyEncrypted: normalizedPassphrase != "",
		KeyCurve:            keyCurve,
		KeyBits:             keyBits,
		PrivateKeyCipher:    privateKeyCipher,
		PrivateKeyKDFRounds: privateKeyKDFRounds,
	}, nil
}

func certificateUnixTime(value uint64) *time.Time {
	if value == 0 {
		return nil
	}
	if value > uint64(^uint64(0)>>1) {
		return nil
	}
	timestamp := time.Unix(int64(value), 0).UTC()
	return &timestamp
}

// resolveKeyboardInteractiveAuthMethod 는 서버의 대화형 인증을 처리한다.
//
// **판정이 여기 있는 이유는 홉이다.** 점프 호스트는 같은 responder 로 재귀 호출되므로
// (DialClient 의 target.Jump 분기), 세션 계층에서 "저장된 비밀번호" 를 결정하면 어느 홉의 값인지
// 알 수 없다 — 점프 챌린지가 먼저 오기 때문에 하필 그 라운드에 최종 대상의 비밀번호를 보내게 된다.
// 여기서는 그 홉의 target 이 손에 있으므로 그 홉의 비밀번호만 쓴다. 시도 횟수도 홉마다 따로 센다.
//
// storedPassword 는 이 홉에 설정된 비밀번호다(없으면 빈 문자열). notify 는 프롬프트가 없는 알림
// 라운드의 문구를 보낼 곳이고(대개 터미널), nil 이면 버린다.
func resolveKeyboardInteractiveAuthMethod(
	responder InteractiveResponder,
	storedPassword string,
	notify func(string),
	hop InteractiveHop,
) ssh.AuthMethod {
	return ssh.KeyboardInteractive(
		newKeyboardInteractiveHandler(responder, storedPassword, notify, hop),
	)
}

// newKeyboardInteractiveHandler 는 위 인증 방식이 쓰는 콜백을 만든다.
//
// 따로 떼어 둔 이유는 검증이다 — ssh.AuthMethod 로 감싸면 콜백을 다시 꺼낼 수 없어서, 홉별
// 비밀번호와 라운드 세기를 테스트할 방법이 없다.
func newKeyboardInteractiveHandler(
	responder InteractiveResponder,
	storedPassword string,
	notify func(string),
	hop InteractiveHop,
) func(user, instruction string, questions []string, echos []bool) ([]string, error) {
	attempt := 0
	return func(user, instruction string, questions []string, echos []bool) ([]string, error) {
		attempt += 1

		// 프롬프트가 없는 라운드는 알림일 뿐이다(RFC 4256 은 num-prompts 0 을 허용한다). 규격이
		// 요구하는 것은 빈 응답을 곧바로 보내는 것이고, 여기서 사람을 기다리면 입력칸 없는 창이
		// 떠서 사용자가 확인을 눌러야 로그인이 끝난다. 문구는 버리지 않고 흘려보낸다.
		if len(questions) == 0 {
			AuthLogf("%s round %d: notice only, replied empty", describeHop(hop), attempt)
			if notify != nil {
				if text := strings.TrimSpace(instruction + "\n" + user); text != "" {
					notify(text)
				}
			}
			return []string{}, nil
		}

		prompts := make([]InteractivePrompt, 0, len(questions))
		for index, question := range questions {
			echo := false
			if index < len(echos) {
				echo = echos[index]
			}
			secondFactor := IsSecondFactorPrompt(question)
			prompts = append(prompts, InteractivePrompt{
				Label:               question,
				Echo:                echo,
				AllowStoredPassword: storedPassword != "" && !secondFactor,
				Masked:              !echo && !secondFactor,
			})
		}

		challenge := InteractiveChallenge{
			Name:        user,
			Instruction: instruction,
			Prompts:     prompts,
			Hop:         hop,
		}
		// 이 세 줄이 진단의 핵심이다: 라운드마다 무엇을 물었고, 그것을 저장된 비밀번호로 답했는지
		// 사람에게 물었는지가 남는다. 인증이 거절됐을 때 어느 쪽이 틀렸는지 이것으로 갈린다.
		where := fmt.Sprintf("%s round %d %s", describeHop(hop), attempt, describePrompts(questions))
		if answers, ok := autoPasswordResponse(attempt, challenge, storedPassword); ok {
			AuthLogf("%s: answered with the saved password", where)
			return answers, nil
		}
		if responder == nil {
			AuthLogf("%s: nowhere to ask (no responder), stored=%t", where, storedPassword != "")
			return nil, fmt.Errorf("keyboard-interactive responder is not configured")
		}
		AuthLogf("%s: asking the user, stored=%t", where, storedPassword != "")
		answers, err := responder(challenge)
		if err != nil {
			AuthLogf("%s: no answer came back: %v", where, err)
			return nil, err
		}
		AuthLogf("%s: the user answered", where)
		return answers, nil
	}
}

// autoPasswordResponse 는 물어볼 필요가 없는 프롬프트에 저장된 비밀번호로 바로 답한다.
//
// OTP 서버는 두 라운드를 준다 — 1 라운드가 비밀번호, 2 라운드가 인증 코드다. 1 라운드까지 사용자에게
// 물으면 이미 저장해 둔 값을 위해 창을 한 번 더 상대해야 한다.
//
// **조건을 좁게 잡는 이유**: 서버가 `Password:` 라고 써 놓고 실제로는 2차 요소를 묻는 경우가 있고,
// keyboard-interactive 는 방식당 한 번만 시도된다. 잘못 채우면 그 연결은 그 자리에서 끝나고 다시
// 물어볼 기회가 없다. 그래서 1 라운드 + 프롬프트가 정확히 하나 + 에코 없음 + 라벨이 비밀번호 계열일
// 때만 답한다.
func autoPasswordResponse(
	attempt int,
	challenge InteractiveChallenge,
	storedPassword string,
) ([]string, bool) {
	if attempt != 1 || storedPassword == "" || len(challenge.Prompts) != 1 {
		return nil, false
	}
	prompt := challenge.Prompts[0]
	if prompt.Echo || !looksLikePasswordPrompt(prompt.Label) {
		return nil, false
	}
	return []string{storedPassword}, true
}

// ApplyStoredPassword 는 사용자가 "저장된 비밀번호 사용" 으로 지목한 칸을 채운다.
//
// 값은 코어 밖으로 나가지 않으므로 화면은 인덱스만 돌려보낸다 — 채우는 일은 여기서 한다. 세션과
// 호스트 키 프로브가 같은 규칙을 써야 하므로 한 곳에 둔다(따로 두면 한쪽만 고쳐진다).
func ApplyStoredPassword(
	responses []string,
	indexes []int,
	storedPassword string,
	promptCount int,
) []string {
	if storedPassword == "" {
		return responses
	}
	for _, index := range indexes {
		if index < 0 || index >= promptCount {
			continue
		}
		// 버튼만 누르고 타이핑을 안 했으면 그 자리가 비어 있을 수 있다.
		for len(responses) <= index {
			responses = append(responses, "")
		}
		responses[index] = storedPassword
	}
	return responses
}

// IsSecondFactorPrompt 는 라벨이 일회용 코드 계열을 묻는 것인지다.
//
// `passcode` 처럼 두 계열의 낱말이 함께 든 라벨은 대개 일회용 코드이므로 이쪽으로 본다 — 거기에
// 비밀번호를 넣으면 그 시도로 연결이 끝난다.
func IsSecondFactorPrompt(label string) bool {
	normalized := strings.ToLower(strings.TrimSpace(label))
	for _, marker := range []string{
		"verification", "code", "token", "otp", "authenticator",
		"one-time", "onetime", "2fa", "mfa", "duo", "코드", "인증번호",
	} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

// looksLikePasswordPrompt 는 라벨이 비밀번호를 묻는 것인지다. 2차 요소 계열은 먼저 배제한다.
func looksLikePasswordPrompt(label string) bool {
	if IsSecondFactorPrompt(label) {
		return false
	}
	normalized := strings.ToLower(strings.TrimSpace(label))
	for _, accept := range []string{"password", "passwd", "비밀번호", "암호"} {
		if strings.Contains(normalized, accept) {
			return true
		}
	}
	return false
}

// resolvePasswordPromptAuthMethod는 다단계 인증에서 publickey 등으로 1차를 통과한 뒤 서버가
// password 메서드를 추가로 요구할 때(AuthenticationMethods publickey,password), 연결 시점에
// 사용자에게 비밀번호를 물어 2차 요소를 충족시킨다. keyboard-interactive와 동일한
// responder(인터랙티브 오버레이) 경로를 쓰며, 서버가 password를 요구할 때만 호출된다.
func resolvePasswordPromptAuthMethod(responder InteractiveResponder, hop InteractiveHop) ssh.AuthMethod {
	return ssh.PasswordCallback(func() (string, error) {
		if responder == nil {
			return "", fmt.Errorf("password responder is not configured")
		}
		responses, err := responder(InteractiveChallenge{
			Prompts: []InteractivePrompt{
				{Label: "Password", Echo: false},
			},
		})
		if err != nil {
			return "", err
		}
		if len(responses) == 0 {
			return "", fmt.Errorf("no password provided")
		}
		return responses[0], nil
	})
}

// hopOf 는 이 홉의 신원이다. 챌린지에 실어 화면이 "누구의 프롬프트인지" 를 말할 수 있게 한다.
func hopOf(target Target) InteractiveHop {
	return InteractiveHop{Username: target.Username, Host: target.Host, Port: target.Port}
}

func resolveAuthMethods(target Target, config Config, responder InteractiveResponder) ([]ssh.AuthMethod, func(), error) {
	noop := func() {}
	switch target.AuthType {
	case "password":
		if target.Password == "" {
			return nil, noop, fmt.Errorf("password auth requires a password")
		}
		return []ssh.AuthMethod{
			ssh.Password(target.Password),
			resolveKeyboardInteractiveAuthMethod(responder, target.Password, config.Banner, hopOf(target)),
		}, noop, nil
	case "privateKey":
		signer, err := resolvePrivateKeySigner(target)
		if err != nil {
			return nil, noop, err
		}
		// publickey 외에 password 프롬프트도 함께 제시 — 서버가 publickey 다음 password를
		// 요구하는 다단계 인증을 만족시킨다. publickey만으로 끝나는 서버에선 호출되지 않는다.
		return []ssh.AuthMethod{
			ssh.PublicKeys(signer),
			resolvePasswordPromptAuthMethod(responder, hopOf(target)),
			resolveKeyboardInteractiveAuthMethod(responder, target.Password, config.Banner, hopOf(target)),
		}, noop, nil
	case "certificate":
		signer, err := resolvePrivateKeySigner(target)
		if err != nil {
			return nil, noop, err
		}
		cert, err := resolveCertificate(target)
		if err != nil {
			return nil, noop, err
		}
		certSigner, err := ssh.NewCertSigner(cert, signer)
		if err != nil {
			return nil, noop, fmt.Errorf("create cert signer: %w", err)
		}
		return []ssh.AuthMethod{
			ssh.PublicKeys(certSigner),
			resolvePasswordPromptAuthMethod(responder, hopOf(target)),
			resolveKeyboardInteractiveAuthMethod(responder, target.Password, config.Banner, hopOf(target)),
		}, noop, nil
	case "agent":
		// 로컬 ssh-agent(1Password/gpg-agent/기본 agent)에 연결해 서명을 위임한다. agent 연결은
		// 핸드셰이크 동안 필요하므로 cleanup으로 반환해 DialClient가 연결 성립 후 닫는다.
		ag, closer, err := dialLocalAgent(config.AuthAgentEndpointKind, config.AuthAgentEndpoint)
		if err != nil {
			return nil, noop, fmt.Errorf("ssh-agent connection failed: %w", err)
		}
		signers, err := ag.Signers()
		if err != nil {
			_ = closer.Close()
			return nil, noop, fmt.Errorf("ssh-agent key listing failed: %w", err)
		}
		if len(signers) == 0 {
			_ = closer.Close()
			return nil, noop, fmt.Errorf("ssh-agent has no keys")
		}
		return []ssh.AuthMethod{
			ssh.PublicKeys(signers...),
			resolvePasswordPromptAuthMethod(responder, hopOf(target)),
			resolveKeyboardInteractiveAuthMethod(responder, target.Password, config.Banner, hopOf(target)),
		}, func() { _ = closer.Close() }, nil
	case "keyboardInteractive":
		return []ssh.AuthMethod{resolveKeyboardInteractiveAuthMethod(responder, target.Password, config.Banner, hopOf(target))}, noop, nil
	default:
		return nil, noop, fmt.Errorf("unsupported auth type: %s", target.AuthType)
	}
}

func loadPrivateKeyBytes(target Target) ([]byte, error) {
	if target.PrivateKeyPEM != "" {
		return []byte(target.PrivateKeyPEM), nil
	}
	return nil, fmt.Errorf("private key auth requires a privateKeyPem")
}

func resolvePrivateKeySigner(target Target) (ssh.Signer, error) {
	privateKey, err := loadPrivateKeyBytes(target)
	if err != nil {
		return nil, err
	}
	if target.Passphrase != "" {
		signer, err := ssh.ParsePrivateKeyWithPassphrase(privateKey, []byte(target.Passphrase))
		if err != nil {
			return nil, fmt.Errorf("parse private key: %w", err)
		}
		return signer, nil
	}
	signer, err := ssh.ParsePrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	return signer, nil
}

func resolveCertificate(target Target) (*ssh.Certificate, error) {
	var rawCertificate string
	if target.CertificateText != "" {
		rawCertificate = target.CertificateText
	} else {
		return nil, fmt.Errorf("certificate auth requires a certificateText")
	}

	raw, _, _, _, err := ssh.ParseAuthorizedKey([]byte(rawCertificate))
	if err != nil {
		return nil, fmt.Errorf("parse certificate: %w", err)
	}
	cert, ok := raw.(*ssh.Certificate)
	if !ok {
		return nil, fmt.Errorf("parse certificate: not an ssh certificate")
	}
	return cert, nil
}

// HopPayload 는 홉 신원을 와이어 페이로드로 옮긴다.
//
// 호스트가 비어 있으면 nil 이다 — 화면에 표시할 것이 없는데 빈 칸을 그리면 "누구인지 모른다" 를
// "이름 없는 홉" 으로 잘못 보여준다.
func HopPayload(hop InteractiveHop) *coretypes.KeyboardInteractiveHop {
	if strings.TrimSpace(hop.Host) == "" {
		return nil
	}
	return &coretypes.KeyboardInteractiveHop{
		Username: hop.Username,
		Host:     hop.Host,
		Port:     hop.Port,
	}
}
