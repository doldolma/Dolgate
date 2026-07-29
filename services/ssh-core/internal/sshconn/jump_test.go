package sshconn

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// jumpTestServer is a minimal in-process SSH server used to exercise the
// ProxyJump dial path. As a target it answers `exec` with a fixed banner so the
// test can confirm which host it landed on; as a bastion it forwards
// `direct-tcpip` channels to the requested address, which is exactly what
// x/crypto/ssh's Client.Dial opens when DialClient tunnels through a jump host.
type jumpTestServer struct {
	listener      net.Listener
	hostKeyBase64 string
	banner        string
	connClosed    chan struct{}
}

func newJumpTestServer(t *testing.T, username, password, banner string) *jumpTestServer {
	t.Helper()

	hostSigner, _ := generateTestKeyPair(t)
	config := &ssh.ServerConfig{
		PasswordCallback: func(conn ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if conn.User() == username && string(pw) == password {
				return nil, nil
			}
			return nil, fmt.Errorf("authentication failed")
		},
	}
	config.AddHostKey(hostSigner)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	server := &jumpTestServer{
		listener:      listener,
		hostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
		banner:        banner,
		connClosed:    make(chan struct{}, 4),
	}

	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			go server.handle(raw, config)
		}
	}()

	t.Cleanup(func() { _ = listener.Close() })
	return server
}

func (s *jumpTestServer) port() int {
	_, portText, _ := net.SplitHostPort(s.listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	return port
}

func (s *jumpTestServer) target(username, password string) Target {
	return Target{
		Host:                 "127.0.0.1",
		Port:                 s.port(),
		Username:             username,
		AuthType:             "password",
		Password:             password,
		TrustedHostKeyBase64: s.hostKeyBase64,
	}
}

func (s *jumpTestServer) handle(raw net.Conn, config *ssh.ServerConfig) {
	conn, chans, reqs, err := ssh.NewServerConn(raw, config)
	if err != nil {
		return
	}
	defer func() {
		_ = conn.Close()
		select {
		case s.connClosed <- struct{}{}:
		default:
		}
	}()

	go ssh.DiscardRequests(reqs)

	for newChannel := range chans {
		switch newChannel.ChannelType() {
		case "session":
			go s.handleSession(newChannel)
		case "direct-tcpip":
			go s.handleDirectTCPIP(newChannel)
		default:
			_ = newChannel.Reject(ssh.UnknownChannelType, "unsupported channel type")
		}
	}
}

func (s *jumpTestServer) handleSession(newChannel ssh.NewChannel) {
	channel, requests, err := newChannel.Accept()
	if err != nil {
		return
	}
	defer channel.Close()

	for req := range requests {
		switch req.Type {
		case "exec", "shell":
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
			_, _ = channel.Write([]byte(s.banner))
			_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{0}))
			return
		default:
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
		}
	}
}

func (s *jumpTestServer) handleDirectTCPIP(newChannel ssh.NewChannel) {
	var extra struct {
		DestAddr   string
		DestPort   uint32
		OriginAddr string
		OriginPort uint32
	}
	if err := ssh.Unmarshal(newChannel.ExtraData(), &extra); err != nil {
		_ = newChannel.Reject(ssh.ConnectionFailed, "invalid direct-tcpip payload")
		return
	}

	upstream, err := net.Dial("tcp", net.JoinHostPort(extra.DestAddr, strconv.Itoa(int(extra.DestPort))))
	if err != nil {
		_ = newChannel.Reject(ssh.ConnectionFailed, err.Error())
		return
	}

	channel, requests, err := newChannel.Accept()
	if err != nil {
		_ = upstream.Close()
		return
	}
	go ssh.DiscardRequests(requests)

	go func() {
		_, _ = io.Copy(channel, upstream)
		_ = channel.Close()
	}()
	go func() {
		_, _ = io.Copy(upstream, channel)
		_ = upstream.Close()
	}()
}

// execBanner runs a no-op exec and returns the server banner, identifying which
// host the client actually landed on.
func execBanner(t *testing.T, client *ssh.Client) string {
	t.Helper()
	session, err := client.NewSession()
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	defer session.Close()
	out, err := session.Output("probe")
	if err != nil {
		t.Fatalf("session.Output: %v", err)
	}
	return string(out)
}

func TestDialClientDirectNoJump(t *testing.T) {
	target := newJumpTestServer(t, "user", "pw", "DIRECT-OK")

	client, err := DialClient(context.Background(), target.target("user", "pw"), DefaultConfig, nil)
	if err != nil {
		t.Fatalf("DialClient direct: %v", err)
	}
	defer client.Close()

	if got := execBanner(t, client); got != "DIRECT-OK" {
		t.Fatalf("banner = %q, want DIRECT-OK", got)
	}
}

func TestDialClientThroughJumpHost(t *testing.T) {
	target := newJumpTestServer(t, "tuser", "tpw", "TARGET-OK")
	bastion := newJumpTestServer(t, "buser", "bpw", "BASTION-OK")

	targetTarget := target.target("tuser", "tpw")
	jump := bastion.target("buser", "bpw")
	targetTarget.Jump = &jump

	client, err := DialClient(context.Background(), targetTarget, DefaultConfig, nil)
	if err != nil {
		t.Fatalf("DialClient through jump: %v", err)
	}
	defer client.Close()

	// Landing on TARGET-OK (not BASTION-OK) proves the second handshake ran
	// end-to-end over the tunnel rather than terminating at the bastion.
	if got := execBanner(t, client); got != "TARGET-OK" {
		t.Fatalf("banner = %q, want TARGET-OK (did the dial stop at the bastion?)", got)
	}
}

// 다단 ProxyJump(`ssh -J jump1,jump2 target`): 클라이언트→jump1(직접)→jump2→target.
// 중첩 Target.Jump.Jump가 끝까지 터널링돼 TARGET에 착지하는지 검증한다.
func TestDialClientThroughTwoJumpHops(t *testing.T) {
	target := newJumpTestServer(t, "tuser", "tpw", "TARGET-OK")
	jump2 := newJumpTestServer(t, "j2user", "j2pw", "JUMP2-OK")
	jump1 := newJumpTestServer(t, "j1user", "j1pw", "JUMP1-OK")

	// 중첩: target.Jump = jump2, jump2.Jump = jump1. DialClient은 가장 깊은 .jump(jump1)부터
	// 직접 연결한 뒤 위로 타고 올라간다.
	targetTarget := target.target("tuser", "tpw")
	jump2Target := jump2.target("j2user", "j2pw")
	jump1Target := jump1.target("j1user", "j1pw")
	jump2Target.Jump = &jump1Target
	targetTarget.Jump = &jump2Target

	client, err := DialClient(context.Background(), targetTarget, DefaultConfig, nil)
	if err != nil {
		t.Fatalf("DialClient through two jump hops: %v", err)
	}
	defer client.Close()

	if got := execBanner(t, client); got != "TARGET-OK" {
		t.Fatalf("banner = %q, want TARGET-OK (2-hop tunnel landed on the wrong host)", got)
	}
}

func TestDialClientJumpHostKeyMismatch(t *testing.T) {
	target := newJumpTestServer(t, "tuser", "tpw", "TARGET-OK")
	bastion := newJumpTestServer(t, "buser", "bpw", "BASTION-OK")

	otherSigner, _ := generateTestKeyPair(t)
	wrongKey := base64.StdEncoding.EncodeToString(otherSigner.PublicKey().Marshal())

	targetTarget := target.target("tuser", "tpw")
	jump := bastion.target("buser", "bpw")
	jump.TrustedHostKeyBase64 = wrongKey // bastion's real key won't match
	targetTarget.Jump = &jump

	if _, err := DialClient(context.Background(), targetTarget, DefaultConfig, nil); err == nil {
		t.Fatal("DialClient = nil error, want jump host key mismatch")
	}
}

func TestDialClientThroughJumpTargetKeyMismatch(t *testing.T) {
	target := newJumpTestServer(t, "tuser", "tpw", "TARGET-OK")
	bastion := newJumpTestServer(t, "buser", "bpw", "BASTION-OK")

	otherSigner, _ := generateTestKeyPair(t)

	targetTarget := target.target("tuser", "tpw")
	targetTarget.TrustedHostKeyBase64 = base64.StdEncoding.EncodeToString(otherSigner.PublicKey().Marshal())
	jump := bastion.target("buser", "bpw")
	targetTarget.Jump = &jump

	// The bastion is trusted, so the tunnel opens, but the target's host key is
	// wrong — the failure must surface from the second (tunneled) handshake.
	if _, err := DialClient(context.Background(), targetTarget, DefaultConfig, nil); err == nil {
		t.Fatal("DialClient = nil error, want target host key mismatch through jump")
	}
}

func TestProbeHostKeyDirect(t *testing.T) {
	target := newJumpTestServer(t, "u", "pw", "TARGET-OK")

	result, err := ProbeHostKey(context.Background(), "127.0.0.1", target.port(), nil, nil, DefaultConfig)
	if err != nil {
		t.Fatalf("ProbeHostKey direct: %v", err)
	}
	if result.PublicKeyBase64 != target.hostKeyBase64 {
		t.Fatalf("probed key = %q, want %q", result.PublicKeyBase64, target.hostKeyBase64)
	}
}

func TestProbeHostKeyThroughJumpHost(t *testing.T) {
	target := newJumpTestServer(t, "tuser", "tpw", "TARGET-OK")
	bastion := newJumpTestServer(t, "buser", "bpw", "BASTION-OK")

	jump := bastion.target("buser", "bpw")
	result, err := ProbeHostKey(context.Background(), "127.0.0.1", target.port(), &jump, nil, DefaultConfig)
	if err != nil {
		t.Fatalf("ProbeHostKey through jump: %v", err)
	}
	// Reading the target's key (not the bastion's) over the tunnel is exactly what
	// lets the user trust a host that is only reachable via the bastion.
	if result.PublicKeyBase64 != target.hostKeyBase64 {
		t.Fatalf("probed key = %q, want target key %q (did the probe read the bastion instead?)", result.PublicKeyBase64, target.hostKeyBase64)
	}
	if result.PublicKeyBase64 == bastion.hostKeyBase64 {
		t.Fatal("probe returned the bastion key, not the target key")
	}
}

func TestDialClientClosesJumpWhenTargetCloses(t *testing.T) {
	target := newJumpTestServer(t, "tuser", "tpw", "TARGET-OK")
	bastion := newJumpTestServer(t, "buser", "bpw", "BASTION-OK")

	targetTarget := target.target("tuser", "tpw")
	jump := bastion.target("buser", "bpw")
	targetTarget.Jump = &jump

	client, err := DialClient(context.Background(), targetTarget, DefaultConfig, nil)
	if err != nil {
		t.Fatalf("DialClient through jump: %v", err)
	}

	// Closing the target client must trip the cleanup goroutine, which closes
	// the bastion connection so it isn't leaked for the life of the process.
	if err := client.Close(); err != nil {
		t.Fatalf("client.Close: %v", err)
	}

	select {
	case <-bastion.connClosed:
	case <-time.After(3 * time.Second):
		t.Fatal("bastion connection not closed after target client closed")
	}
}
