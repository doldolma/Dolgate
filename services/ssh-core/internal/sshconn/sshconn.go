package sshconn

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"os"
	"time"

	"golang.org/x/crypto/ssh"
)

var errHostKeyProbed = errors.New("host key probed")

// Target는 SSH, SFTP, 포트 포워딩이 공통으로 쓰는 접속 대상 정보다.
type Target struct {
	Host                 string
	Port                 int
	Username             string
	AuthType             string
	Password             string
	PrivateKeyPEM        string
	PrivateKeyPath       string
	Passphrase           string
	TrustedHostKeyBase64 string
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

	hostKeyCallback, err := strictHostKeyCallback(target.TrustedHostKeyBase64)
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
	dialer := &net.Dialer{
		Timeout:   config.TCPDialTimeout,
		KeepAlive: config.TCPKeepAliveInterval,
	}
	rawConn, err := dialer.Dial("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("dial failed: %w", err)
	}

	clientConn, chans, reqs, err := ssh.NewClientConn(rawConn, addr, clientConfig)
	if err != nil {
		_ = rawConn.Close()
		return nil, fmt.Errorf("ssh handshake failed: %w", err)
	}

	return ssh.NewClient(clientConn, chans, reqs), nil
}

// ProbeHostKey는 인증 전에 서버의 실제 호스트 키만 읽어와 TOFU/UI 비교에 사용한다.
func ProbeHostKey(host string, port int, config Config) (HostKeyProbeResult, error) {
	if config.TCPDialTimeout == 0 {
		config.TCPDialTimeout = DefaultConfig.TCPDialTimeout
	}
	if config.TCPKeepAliveInterval == 0 {
		config.TCPKeepAliveInterval = DefaultConfig.TCPKeepAliveInterval
	}

	addr := fmt.Sprintf("%s:%d", host, port)
	dialer := &net.Dialer{
		Timeout:   config.TCPDialTimeout,
		KeepAlive: config.TCPKeepAliveInterval,
	}
	rawConn, err := dialer.Dial("tcp", addr)
	if err != nil {
		return HostKeyProbeResult{}, fmt.Errorf("dial failed: %w", err)
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

	_, _, _, err = ssh.NewClientConn(rawConn, addr, clientConfig)
	if result.PublicKeyBase64 != "" {
		return result, nil
	}
	if err != nil {
		return HostKeyProbeResult{}, fmt.Errorf("host key probe failed: %w", err)
	}
	return HostKeyProbeResult{}, fmt.Errorf("host key probe failed: empty result")
}

func strictHostKeyCallback(trustedHostKeyBase64 string) (ssh.HostKeyCallback, error) {
	if trustedHostKeyBase64 == "" {
		return nil, fmt.Errorf("trusted host key is required")
	}

	expected, err := base64.StdEncoding.DecodeString(trustedHostKeyBase64)
	if err != nil {
		return nil, fmt.Errorf("decode trusted host key: %w", err)
	}

	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		if !bytes.Equal(key.Marshal(), expected) {
			return fmt.Errorf("host key mismatch")
		}
		return nil
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
		var privateKey []byte
		if target.PrivateKeyPEM != "" {
			privateKey = []byte(target.PrivateKeyPEM)
		} else {
			if target.PrivateKeyPath == "" {
				return nil, fmt.Errorf("private key auth requires a privateKeyPem or privateKeyPath")
			}
			var err error
			privateKey, err = os.ReadFile(target.PrivateKeyPath)
			if err != nil {
				return nil, fmt.Errorf("read private key: %w", err)
			}
		}
		var signer ssh.Signer
		var err error
		if target.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(privateKey, []byte(target.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey(privateKey)
		}
		if err != nil {
			return nil, fmt.Errorf("parse private key: %w", err)
		}
		return []ssh.AuthMethod{
			ssh.PublicKeys(signer),
			resolveKeyboardInteractiveAuthMethod(responder),
		}, nil
	case "keyboardInteractive":
		return []ssh.AuthMethod{resolveKeyboardInteractiveAuthMethod(responder)}, nil
	default:
		return nil, fmt.Errorf("unsupported auth type: %s", target.AuthType)
	}
}
