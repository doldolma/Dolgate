//go:build !windows

package sshconn

import (
	"crypto/rand"
	"crypto/rsa"
	"net"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/ssh/agent"
)

// agent 인증 테스트는 유닉스 도메인 소켓 전송에 의존한다(Windows dialLocalAgent는 named pipe라
// 이 소켓 셋업으로는 연결되지 않는다). 따라서 POSIX에서만 빌드·실행한다.

func TestResolveAuthMethodsAgent(t *testing.T) {
	// 인메모리 keyring agent를 unix 소켓에 띄우고, "agent" 인증이 그 키로 인증 메서드를 만드는지 검증.
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	sockPath := filepath.Join(t.TempDir(), "agent.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	keyring := agent.NewKeyring()
	if err := keyring.Add(agent.AddedKey{PrivateKey: priv}); err != nil {
		t.Fatalf("keyring add: %v", err)
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				_ = agent.ServeAgent(keyring, conn)
				_ = conn.Close()
			}()
		}
	}()

	methods, cleanup, err := resolveAuthMethods(
		Target{AuthType: "agent"},
		Config{AuthAgentEndpointKind: "unix", AuthAgentEndpoint: sockPath},
		nil,
	)
	if err != nil {
		t.Fatalf("resolveAuthMethods(agent) error = %v", err)
	}
	defer cleanup()
	// publickey(agent) + password 프롬프트 + keyboard-interactive = 3
	if len(methods) != 3 {
		t.Fatalf("len(agent methods) = %d, want 3", len(methods))
	}
}

func TestResolveAuthMethodsAgentErrors(t *testing.T) {
	// 소켓 경로가 비면 에러.
	if _, _, err := resolveAuthMethods(Target{AuthType: "agent"}, Config{}, nil); err == nil {
		t.Fatal("resolveAuthMethods(agent without endpoint) error = nil, want non-nil")
	}
	// 존재하지 않는 소켓이면 연결 실패 에러.
	if _, _, err := resolveAuthMethods(
		Target{AuthType: "agent"},
		Config{AuthAgentEndpointKind: "unix", AuthAgentEndpoint: filepath.Join(t.TempDir(), "nope.sock")},
		nil,
	); err == nil {
		t.Fatal("resolveAuthMethods(agent with dead socket) error = nil, want non-nil")
	}
}
