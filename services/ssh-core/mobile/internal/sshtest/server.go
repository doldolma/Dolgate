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
	"net"
	"strconv"
	"sync"

	sftppkg "github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// Credentials the fixture accepts.
const (
	User     = "tester"
	Password = "s3cret"
)

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
	listener      net.Listener
	hostKeyBase64 string

	mu       sync.Mutex
	ptyReqs  []PtyRequest
	winReqs  []WindowChange
	accepted []net.Conn
}

// NewServer starts a fixture on a loopback port.
func NewServer() (*Server, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate host key: %w", err)
	}
	hostSigner, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, fmt.Errorf("build host signer: %w", err)
	}

	config := &ssh.ServerConfig{
		PasswordCallback: func(conn ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if conn.User() == User && string(pw) == Password {
				return nil, nil
			}
			return nil, fmt.Errorf("authentication failed")
		},
	}
	config.AddHostKey(hostSigner)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen: %w", err)
	}

	server := &Server{
		listener:      listener,
		hostKeyBase64: base64.StdEncoding.EncodeToString(hostSigner.PublicKey().Marshal()),
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
			go runEchoShell(channel)

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
