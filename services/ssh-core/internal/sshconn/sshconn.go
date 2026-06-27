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

type Config struct {
	TCPDialTimeout       time.Duration
	TCPKeepAliveInterval time.Duration
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

func DialClient(target Target, config Config, responder InteractiveResponder) (*ssh.Client, error) {
	if config.TCPDialTimeout == 0 {
		config.TCPDialTimeout = DefaultConfig.TCPDialTimeout
	}
	if config.TCPKeepAliveInterval == 0 {
		config.TCPKeepAliveInterval = DefaultConfig.TCPKeepAliveInterval
	}

	authMethods, err := resolveAuthMethods(target, responder)
	if err != nil {
		return nil, err
	}

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

	// Establish the raw TCP connection to the target — either directly, or, when a
	// jump host is configured, tunneled through the jump client's connection
	// (ProxyJump). The target SSH handshake below then runs end-to-end over it.
	var (
		rawConn    net.Conn
		jumpClient *ssh.Client
	)
	if target.Jump != nil {
		jumpClient, err = DialClient(*target.Jump, config, responder)
		if err != nil {
			return nil, fmt.Errorf("jump host: %w", err)
		}
		rawConn, err = jumpClient.Dial("tcp", addr)
		if err != nil {
			_ = jumpClient.Close()
			return nil, fmt.Errorf("dial through jump host: %w", err)
		}
	} else {
		dialer := &net.Dialer{
			Timeout:   config.TCPDialTimeout,
			KeepAlive: config.TCPKeepAliveInterval,
		}
		rawConn, err = dialer.Dial("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("dial failed: %w", err)
		}
	}

	clientConn, chans, reqs, err := ssh.NewClientConn(rawConn, addr, clientConfig)
	if err != nil {
		_ = rawConn.Close()
		if jumpClient != nil {
			_ = jumpClient.Close()
		}
		return nil, fmt.Errorf("ssh handshake failed: %w", err)
	}

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
func ProbeHostKey(host string, port int, jump *Target, config Config) (HostKeyProbeResult, error) {
	if config.TCPDialTimeout == 0 {
		config.TCPDialTimeout = DefaultConfig.TCPDialTimeout
	}
	if config.TCPKeepAliveInterval == 0 {
		config.TCPKeepAliveInterval = DefaultConfig.TCPKeepAliveInterval
	}

	addr := fmt.Sprintf("%s:%d", host, port)

	var rawConn net.Conn
	if jump != nil {
		jumpClient, err := DialClient(*jump, config, nil)
		if err != nil {
			return HostKeyProbeResult{}, fmt.Errorf("jump host: %w", err)
		}
		defer jumpClient.Close()
		rawConn, err = jumpClient.Dial("tcp", addr)
		if err != nil {
			return HostKeyProbeResult{}, fmt.Errorf("dial through jump host: %w", err)
		}
	} else {
		dialer := &net.Dialer{
			Timeout:   config.TCPDialTimeout,
			KeepAlive: config.TCPKeepAliveInterval,
		}
		var err error
		rawConn, err = dialer.Dial("tcp", addr)
		if err != nil {
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
		return result, nil
	}
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

func resolveAuthMethods(target Target, responder InteractiveResponder) ([]ssh.AuthMethod, error) {
	switch target.AuthType {
	case "password":
		if target.Password == "" {
			return nil, fmt.Errorf("password auth requires a password")
		}
		return []ssh.AuthMethod{
			ssh.Password(target.Password),
			resolveKeyboardInteractiveAuthMethod(responder),
		}, nil
	case "privateKey":
		signer, err := resolvePrivateKeySigner(target)
		if err != nil {
			return nil, err
		}
		return []ssh.AuthMethod{
			ssh.PublicKeys(signer),
			resolveKeyboardInteractiveAuthMethod(responder),
		}, nil
	case "certificate":
		signer, err := resolvePrivateKeySigner(target)
		if err != nil {
			return nil, err
		}
		cert, err := resolveCertificate(target)
		if err != nil {
			return nil, err
		}
		certSigner, err := ssh.NewCertSigner(cert, signer)
		if err != nil {
			return nil, fmt.Errorf("create cert signer: %w", err)
		}
		return []ssh.AuthMethod{
			ssh.PublicKeys(certSigner),
			resolveKeyboardInteractiveAuthMethod(responder),
		}, nil
	case "keyboardInteractive":
		return []ssh.AuthMethod{resolveKeyboardInteractiveAuthMethod(responder)}, nil
	default:
		return nil, fmt.Errorf("unsupported auth type: %s", target.AuthType)
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
