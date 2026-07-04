package sshconn

import (
	"bytes"
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
	"strings"
	"time"

	"dolssh/services/ssh-core/pkg/coretypes"
	"golang.org/x/crypto/ssh"
)

var errHostKeyProbed = errors.New("host key probed")

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
	TCPDialTimeout       time.Duration
	TCPKeepAliveInterval time.Duration
	// Progress가 설정되면 DialClient가 홉마다 connecting→connected(또는 failed)를 보고한다.
	// config가 점프 체인 재귀에 전파돼 가장 깊은 점프부터 순서대로 이벤트가 도착한다.
	Progress ProgressFunc
	// AuthAgentEndpoint*이 설정되고 target.AuthType이 "agent"면, 로컬 ssh-agent(1Password 등)에
	// 연결해 서명을 위임한다. config가 점프 체인 재귀에 전파되므로 모든 홉이 같은 로컬 agent를 쓴다.
	AuthAgentEndpointKind string
	AuthAgentEndpoint     string
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
}

type InteractiveChallenge struct {
	Name        string
	Instruction string
	Prompts     []InteractivePrompt
}

type InteractiveResponder func(challenge InteractiveChallenge) ([]string, error)

var DefaultConfig = Config{
	TCPDialTimeout:       10 * time.Second,
	TCPKeepAliveInterval: 30 * time.Second,
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

func DialClient(target Target, config Config, responder InteractiveResponder) (*ssh.Client, error) {
	if config.TCPDialTimeout == 0 {
		config.TCPDialTimeout = DefaultConfig.TCPDialTimeout
	}
	if config.TCPKeepAliveInterval == 0 {
		config.TCPKeepAliveInterval = DefaultConfig.TCPKeepAliveInterval
	}

	authMethods, cleanupAuth, err := resolveAuthMethods(target, config, responder)
	if err != nil {
		return nil, err
	}
	// agent 인증은 핸드셰이크 동안 로컬 ssh-agent 연결이 필요하다. 연결 성립(NewClientConn) 후 정리.
	defer cleanupAuth()

	hostKeyCallback, err := strictHostKeyCallback(target.TrustedHostKeyBase64, target.TrustedHostKeysBase64)
	if err != nil {
		return nil, err
	}

	clientConfig := &ssh.ClientConfig{
		User:            target.Username,
		Auth:            authMethods,
		HostKeyCallback: hostKeyCallback,
		Timeout:         config.TCPDialTimeout,
	}

	addr := fmt.Sprintf("%s:%d", target.Host, target.Port)
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
		jumpClient, err = DialClient(*target.Jump, config, responder)
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

	clientConn, chans, reqs, err := ssh.NewClientConn(rawConn, addr, clientConfig)
	if err != nil {
		reportProgress(ProgressFailed)
		_ = rawConn.Close()
		if jumpClient != nil {
			_ = jumpClient.Close()
		}
		return nil, fmt.Errorf("ssh handshake failed: %w", err)
	}
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
func ProbeHostKey(host string, port int, jump *Target, wsProxy *coretypes.WSProxyTarget, config Config) (HostKeyProbeResult, error) {
	if config.TCPDialTimeout == 0 {
		config.TCPDialTimeout = DefaultConfig.TCPDialTimeout
	}
	if config.TCPKeepAliveInterval == 0 {
		config.TCPKeepAliveInterval = DefaultConfig.TCPKeepAliveInterval
	}

	addr := fmt.Sprintf("%s:%d", host, port)

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
		jumpClient, err := DialClient(*jump, config, nil)
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

func strictHostKeyCallback(trustedHostKeyBase64 string, trustedHostKeysBase64 []string) (ssh.HostKeyCallback, error) {
	candidates := make([]string, 0, len(trustedHostKeysBase64)+1)
	for _, value := range trustedHostKeysBase64 {
		value = strings.TrimSpace(value)
		if value != "" {
			candidates = append(candidates, value)
		}
	}
	if len(candidates) == 0 && strings.TrimSpace(trustedHostKeyBase64) != "" {
		candidates = append(candidates, strings.TrimSpace(trustedHostKeyBase64))
	}
	if len(candidates) == 0 {
		return nil, fmt.Errorf("trusted host key is required")
	}

	expectedKeys := make([][]byte, 0, len(candidates))
	for _, candidate := range candidates {
		expected, err := base64.StdEncoding.DecodeString(candidate)
		if err != nil {
			return nil, fmt.Errorf("decode trusted host key: %w", err)
		}
		expectedKeys = append(expectedKeys, expected)
	}

	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		actual := key.Marshal()
		for _, expected := range expectedKeys {
			if bytes.Equal(actual, expected) {
				return nil
			}
		}
		return fmt.Errorf("host key mismatch")
	}, nil
}

func resolveKeyboardInteractiveAuthMethod(responder InteractiveResponder) ssh.AuthMethod {
	return ssh.KeyboardInteractive(func(user, instruction string, questions []string, echos []bool) ([]string, error) {
		if responder == nil {
			return nil, fmt.Errorf("keyboard-interactive responder is not configured")
		}
		prompts := make([]InteractivePrompt, 0, len(questions))
		for index, question := range questions {
			echo := false
			if index < len(echos) {
				echo = echos[index]
			}
			prompts = append(prompts, InteractivePrompt{
				Label: question,
				Echo:  echo,
			})
		}
		return responder(InteractiveChallenge{
			Name:        user,
			Instruction: instruction,
			Prompts:     prompts,
		})
	})
}

// resolvePasswordPromptAuthMethod는 다단계 인증에서 publickey 등으로 1차를 통과한 뒤 서버가
// password 메서드를 추가로 요구할 때(AuthenticationMethods publickey,password), 연결 시점에
// 사용자에게 비밀번호를 물어 2차 요소를 충족시킨다. keyboard-interactive와 동일한
// responder(인터랙티브 오버레이) 경로를 쓰며, 서버가 password를 요구할 때만 호출된다.
func resolvePasswordPromptAuthMethod(responder InteractiveResponder) ssh.AuthMethod {
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

func resolveAuthMethods(target Target, config Config, responder InteractiveResponder) ([]ssh.AuthMethod, func(), error) {
	noop := func() {}
	switch target.AuthType {
	case "password":
		if target.Password == "" {
			return nil, noop, fmt.Errorf("password auth requires a password")
		}
		return []ssh.AuthMethod{
			ssh.Password(target.Password),
			resolveKeyboardInteractiveAuthMethod(responder),
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
			resolvePasswordPromptAuthMethod(responder),
			resolveKeyboardInteractiveAuthMethod(responder),
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
			resolvePasswordPromptAuthMethod(responder),
			resolveKeyboardInteractiveAuthMethod(responder),
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
			resolvePasswordPromptAuthMethod(responder),
			resolveKeyboardInteractiveAuthMethod(responder),
		}, func() { _ = closer.Close() }, nil
	case "keyboardInteractive":
		return []ssh.AuthMethod{resolveKeyboardInteractiveAuthMethod(responder)}, noop, nil
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
