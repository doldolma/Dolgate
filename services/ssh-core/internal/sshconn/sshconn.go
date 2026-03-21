package sshconn

import (
	"fmt"
	"net"
	"os"
	"time"

	"golang.org/x/crypto/ssh"
)

// Target는 SSH와 SFTP가 공통으로 쓰는 접속 대상 정보다.
type Target struct {
	Host           string
	Port           int
	Username       string
	AuthType       string
	Password       string
	PrivateKeyPath string
	Passphrase     string
}

type Config struct {
	TCPDialTimeout       time.Duration
	TCPKeepAliveInterval time.Duration
}

var DefaultConfig = Config{
	TCPDialTimeout:       10 * time.Second,
	TCPKeepAliveInterval: 30 * time.Second,
}

func DialClient(target Target, config Config) (*ssh.Client, error) {
	if config.TCPDialTimeout == 0 {
		config.TCPDialTimeout = DefaultConfig.TCPDialTimeout
	}
	if config.TCPKeepAliveInterval == 0 {
		config.TCPKeepAliveInterval = DefaultConfig.TCPKeepAliveInterval
	}

	authMethod, err := resolveAuthMethod(target)
	if err != nil {
		return nil, err
	}

	clientConfig := &ssh.ClientConfig{
		User: target.Username,
		Auth: []ssh.AuthMethod{authMethod},
		// MVP 단계에서는 known_hosts 검증을 아직 붙이지 않았다.
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
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

func resolveAuthMethod(target Target) (ssh.AuthMethod, error) {
	switch target.AuthType {
	case "password":
		if target.Password == "" {
			return nil, fmt.Errorf("password auth requires a password")
		}
		return ssh.Password(target.Password), nil
	case "privateKey":
		if target.PrivateKeyPath == "" {
			return nil, fmt.Errorf("private key auth requires a privateKeyPath")
		}
		privateKey, err := os.ReadFile(target.PrivateKeyPath)
		if err != nil {
			return nil, fmt.Errorf("read private key: %w", err)
		}
		var signer ssh.Signer
		if target.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(privateKey, []byte(target.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey(privateKey)
		}
		if err != nil {
			return nil, fmt.Errorf("parse private key: %w", err)
		}
		return ssh.PublicKeys(signer), nil
	default:
		return nil, fmt.Errorf("unsupported auth type: %s", target.AuthType)
	}
}
