// Package sshtest is an in-process SSH server for exercising the mobile engine.
//
// It grants a PTY and runs an echo shell, which is enough to drive a real
// handshake, assert the pty-req the engine sends, and produce output on both
// stdout and stderr. Both the engine package and the bind surface test against
// it, so the fixture lives here rather than being duplicated in each.
//
// It deliberately does not import "testing": the bind surface imports this
// package's siblings, and keeping the test framework out of the graph avoids
// dragging it anywhere near a gomobile build.
package sshtest

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"

	sftppkg "github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// Credentials the fixture accepts.
const (
	User     = "tester"
	Password = "s3cret"
)

// Options turns the fixture into the hosts that were impossible to connect to
// from mobile, so those paths can be driven without a real bastion.
type Options struct {
	// OTPCode makes the fixture authenticate with keyboard-interactive instead of
	// password, asking for the password and the code in **separate rounds**.
	//
	// Separate rounds is the point: it is what shows that the saved password is
	// answered automatically and only the code reaches the person. One combined
	// round would pass whether or not that works.
	OTPCode string
	// Banner is sent during authentication (RFC 4252 §5.4) when set.
	Banner string
	// CombinedPrompts asks for the password and the code in one round.
	//
	// Real servers do both, and the difference is visible to the person: a single
	// round cannot be auto-answered from the saved password (the engine will not
	// guess which field it belongs to), so it is the shape where the app has to
	// point at the field itself.
	CombinedPrompts bool
	// AllowDirectTCPIP lets integration tests exercise SSH local forwarding.
	// It is opt-in so ordinary shell/SFTP fixtures keep rejecting other channels.
	AllowDirectTCPIP bool
	// ShellIntegrationShell makes the interactive fixture behave like this
	// supported login shell. The fixture still rejects exec requests, so tests
	// exercise the mobile PTY fallback instead of DetectRemoteShell's fast path.
	ShellIntegrationShell string
}

// StderrTrigger, written to the shell's stdin, makes the fake shell emit
// StderrReply on stderr instead of echoing, so a test can tell the two output
// streams apart.
const (
	StderrTrigger = "EMIT-STDERR\n"
	StderrReply   = "on-stderr"
)

// PtyRequest is the pty-req payload, laid out per RFC 4254 section 6.2.
type PtyRequest struct {
	Term     string
	Cols     uint32
	Rows     uint32
	WidthPx  uint32
	HeightPx uint32
	Modes    string
}

// DecodeModes unpacks a pty-req terminal modes blob into opcode/value pairs.
func (p PtyRequest) DecodeModes() map[uint8]uint32 {
	out := map[uint8]uint32{}
	raw := []byte(p.Modes)
	for len(raw) >= 5 {
		opcode := raw[0]
		if opcode == 0 {
			break
		}
		out[opcode] = binary.BigEndian.Uint32(raw[1:5])
		raw = raw[5:]
	}
	return out
}

// WindowChange is the window-change payload, per RFC 4254 section 6.7.
type WindowChange struct {
	Cols     uint32
	Rows     uint32
	WidthPx  uint32
	HeightPx uint32
}

// Server is a running fixture. Close it when the test finishes.
type Server struct {
	listener              net.Listener
	hostKeyBase64         string
	allowDirectTCPIP      bool
	shellIntegrationShell string

	mu       sync.Mutex
	ptyReqs  []PtyRequest
	winReqs  []WindowChange
	accepted []net.Conn
}

// NewServer starts a fixture on a loopback port.
func NewServer() (*Server, error) { return NewServerWithOptions(Options{}) }

// NewServerWithOptions starts a fixture that authenticates as options describe.
func NewServerWithOptions(options Options) (*Server, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate host key: %w", err)
	}
	hostSigner, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, fmt.Errorf("build host signer: %w", err)
	}

	config := &ssh.ServerConfig{}
	if options.OTPCode != "" && options.CombinedPrompts {
		config.KeyboardInteractiveCallback = func(
			conn ssh.ConnMetadata,
			ask ssh.KeyboardInteractiveChallenge,
		) (*ssh.Permissions, error) {
			given, askErr := ask(
				"", "",
				[]string{"Password:", "Verification code:"},
				[]bool{false, false},
			)
			if askErr != nil {
				return nil, askErr
			}
			if conn.User() != User || len(given) != 2 {
				return nil, fmt.Errorf("authentication failed")
			}
			if given[0] != Password || given[1] != options.OTPCode {
				return nil, fmt.Errorf("authentication failed")
			}
			return nil, nil
		}
	} else if options.OTPCode != "" {
		config.KeyboardInteractiveCallback = func(
			conn ssh.ConnMetadata,
			ask ssh.KeyboardInteractiveChallenge,
		) (*ssh.Permissions, error) {
			given, askErr := ask("", "", []string{"Password:"}, []bool{false})
			if askErr != nil {
				return nil, askErr
			}
			if conn.User() != User || len(given) != 1 || given[0] != Password {
				return nil, fmt.Errorf("authentication failed")
			}
			given, askErr = ask("", "", []string{"Verification code:"}, []bool{false})
			if askErr != nil {
				return nil, askErr
			}
			if len(given) != 1 || given[0] != options.OTPCode {
				return nil, fmt.Errorf("authentication failed")
			}
			return nil, nil
		}
	} else {
		config.PasswordCallback = func(conn ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if conn.User() == User && string(pw) == Password {
				return nil, nil
			}
			return nil, fmt.Errorf("authentication failed")
		}
	}
	if options.Banner != "" {
		config.BannerCallback = func(ssh.ConnMetadata) string { return options.Banner }
	}
	config.AddHostKey(hostSigner)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen: %w", err)
	}

	server := &Server{
		listener:              listener,
		hostKeyBase64:         base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
		allowDirectTCPIP:      options.AllowDirectTCPIP,
		shellIntegrationShell: options.ShellIntegrationShell,
	}

	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			server.mu.Lock()
			server.accepted = append(server.accepted, raw)
			server.mu.Unlock()
			go server.handle(raw, config)
		}
	}()

	return server, nil
}

// Close stops accepting connections and drops any that are established.
func (s *Server) Close() error {
	err := s.listener.Close()
	s.DropConnections()
	return err
}

// DropConnections severs every established transport without a protocol
// goodbye, standing in for a phone losing its network. The client sees the
// socket die rather than a disconnect message.
func (s *Server) DropConnections() {
	s.mu.Lock()
	conns := s.accepted
	s.accepted = nil
	s.mu.Unlock()

	for _, conn := range conns {
		_ = conn.Close()
	}
}

// Port is the loopback port the fixture listens on.
func (s *Server) Port() int {
	_, portText, _ := net.SplitHostPort(s.listener.Addr().String())
	port, _ := strconv.Atoi(portText)
	return port
}

// HostKeyBase64 is the fixture's host key, for strict host key checking.
func (s *Server) HostKeyBase64() string { return s.hostKeyBase64 }

// Target addresses the fixture through the engine's dialer.
func (s *Server) Target() sshconn.Target {
	return sshconn.Target{
		Host:                 "127.0.0.1",
		Port:                 s.Port(),
		Username:             User,
		AuthType:             "password",
		Password:             Password,
		TrustedHostKeyBase64: s.hostKeyBase64,
	}
}

// ConnectPayload addresses the fixture through the wire format the app sends.
func (s *Server) ConnectPayload() coretypes.ConnectPayload {
	return coretypes.ConnectPayload{
		Host:                 "127.0.0.1",
		Port:                 s.Port(),
		Username:             User,
		AuthType:             "password",
		Password:             Password,
		TrustedHostKeyBase64: s.hostKeyBase64,
	}
}

// PtyRequests returns the pty-reqs received so far.
func (s *Server) PtyRequests() []PtyRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]PtyRequest(nil), s.ptyReqs...)
}

// WindowChanges returns the window-change requests received so far.
func (s *Server) WindowChanges() []WindowChange {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]WindowChange(nil), s.winReqs...)
}

func (s *Server) handle(raw net.Conn, config *ssh.ServerConfig) {
	conn, chans, reqs, err := ssh.NewServerConn(raw, config)
	if err != nil {
		_ = raw.Close()
		return
	}
	defer conn.Close()
	go ssh.DiscardRequests(reqs)

	for newChannel := range chans {
		if newChannel.ChannelType() == "direct-tcpip" && s.allowDirectTCPIP {
			go s.serveDirectTCPIP(newChannel)
			continue
		}
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "only session channels")
			continue
		}
		channel, requests, err := newChannel.Accept()
		if err != nil {
			return
		}
		go s.serveSession(channel, requests)
	}
}

type directTCPIPRequest struct {
	DestinationHost string
	DestinationPort uint32
	OriginHost      string
	OriginPort      uint32
}

func (s *Server) serveDirectTCPIP(newChannel ssh.NewChannel) {
	var request directTCPIPRequest
	if err := ssh.Unmarshal(newChannel.ExtraData(), &request); err != nil {
		_ = newChannel.Reject(ssh.ConnectionFailed, "invalid direct-tcpip request")
		return
	}
	target, err := net.Dial(
		"tcp",
		net.JoinHostPort(request.DestinationHost, strconv.Itoa(int(request.DestinationPort))),
	)
	if err != nil {
		_ = newChannel.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	channel, requests, err := newChannel.Accept()
	if err != nil {
		_ = target.Close()
		return
	}
	go ssh.DiscardRequests(requests)
	go func() {
		defer channel.Close()
		defer target.Close()
		remoteDone := make(chan struct{})
		go func() {
			_, _ = io.Copy(target, channel)
			if tcp, ok := target.(*net.TCPConn); ok {
				_ = tcp.CloseWrite()
			}
			close(remoteDone)
		}()
		_, _ = io.Copy(channel, target)
		_ = channel.CloseWrite()
		<-remoteDone
	}()
}

func (s *Server) serveSession(channel ssh.Channel, requests <-chan *ssh.Request) {
	for req := range requests {
		switch req.Type {
		case "pty-req":
			var pty PtyRequest
			if err := ssh.Unmarshal(req.Payload, &pty); err != nil {
				_ = req.Reply(false, nil)
				continue
			}
			s.mu.Lock()
			s.ptyReqs = append(s.ptyReqs, pty)
			s.mu.Unlock()
			_ = req.Reply(true, nil)

		case "window-change":
			var win WindowChange
			if err := ssh.Unmarshal(req.Payload, &win); err != nil {
				_ = req.Reply(false, nil)
				continue
			}
			s.mu.Lock()
			s.winReqs = append(s.winReqs, win)
			s.mu.Unlock()
			_ = req.Reply(true, nil)

		case "shell":
			_ = req.Reply(true, nil)
			if s.shellIntegrationShell != "" {
				go runShellIntegrationFixture(channel, s.shellIntegrationShell)
			} else {
				go runEchoShell(channel)
			}

		case "subsystem":
			var payload struct{ Name string }
			if err := ssh.Unmarshal(req.Payload, &payload); err != nil || payload.Name != "sftp" {
				_ = req.Reply(false, nil)
				continue
			}
			_ = req.Reply(true, nil)
			// A real SFTP server over the channel, serving the host filesystem.
			// Tests point it at a temp directory, so the engine's file operations
			// are exercised against genuine protocol responses rather than stubs.
			go func() {
				server, err := sftppkg.NewServer(channel)
				if err != nil {
					_ = channel.Close()
					return
				}
				_ = server.Serve()
				_ = server.Close()
				_ = channel.Close()
			}()

		default:
			_ = req.Reply(false, nil)
		}
	}
}

// runShellIntegrationFixture supplies a real-looking prompt and recognizes
// the two hidden commands used by mobile shell integration. It intentionally
// does not implement an exec request: that is the regression condition this
// fixture exists to preserve.
func runShellIntegrationFixture(channel ssh.Channel, shell string) {
	defer channel.Close()
	_, _ = channel.Write([]byte("fixture$ "))

	buf := make([]byte, 4096)
	pending := make([]byte, 0, 2048)
	for {
		n, err := channel.Read(buf)
		if n > 0 {
			pending = append(pending, buf[:n]...)
			for {
				idx := bytes.IndexAny(pending, "\r\n")
				if idx < 0 {
					break
				}
				line := append([]byte(nil), pending[:idx]...)
				pending = pending[idx+1:]
				if len(line) == 0 {
					continue
				}
				visible := bytes.TrimPrefix(line, []byte(" "))
				_, _ = channel.Write(append(append([]byte(nil), visible...), '\r', '\n'))
				if bytes.Contains(line, []byte("dg-shell=")) {
					_, _ = channel.Write([]byte(shellProbeReply(shell) + "fixture$ "))
					continue
				}
				_, _ = channel.Write([]byte(
					autocomplete.PromptStartMarker + "fixture$ " + autocomplete.PromptInputStartMarker,
				))
			}
		}
		if err != nil {
			return
		}
	}
}

func shellProbeReply(shell string) string {
	fields := "|||"
	switch shell {
	case "bash":
		fields = "5.2|||"
	case "zsh":
		fields = "|5.9||"
	case "fish":
		fields = "||3.6|"
	}
	return autocomplete.ShellProbeReplyPrefix + fields + "\a"
}

// runEchoShell echoes complete lines back on stdout, except for the stderr
// trigger. Working line-at-a-time keeps assertions simple.
func runEchoShell(channel ssh.Channel) {
	defer channel.Close()

	buf := make([]byte, 4096)
	pending := make([]byte, 0, 64)
	for {
		n, err := channel.Read(buf)
		if n > 0 {
			pending = append(pending, buf[:n]...)
			for {
				idx := bytes.IndexByte(pending, '\n')
				if idx < 0 {
					break
				}
				line := pending[:idx+1]
				pending = pending[idx+1:]
				if string(line) == StderrTrigger {
					_, _ = channel.Stderr().Write([]byte(StderrReply))
					continue
				}
				_, _ = channel.Write(line)
			}
		}
		if err != nil {
			return
		}
	}
}
