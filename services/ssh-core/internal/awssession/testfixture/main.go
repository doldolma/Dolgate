// fake-aws-session is the e2e stand-in for the AWS SSM agent. It serves the SSM
// data-channel protocol over a local WebSocket and simulates a deterministic
// remote shell (echo markers, fake top/vi TUIs, resize/signal markers), so smoke
// tests exercise the exact in-process transport the product uses — no aws CLI,
// no session-manager-plugin, no PTY.
//
// ssh-core spawns this binary, reads the "LISTENING ws://…" line from stdout,
// and opens the data channel against it.
package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/gorilla/websocket"

	"dolssh/services/ssh-core/internal/ssmdatachannel"
)

type tuiMode string

const (
	shellMode tuiMode = "shell"
	topMode   tuiMode = "top"
	viMode    tuiMode = "vi"
)

func main() {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("LISTENING ws://%s\n", listener.Addr().String())

	server := &http.Server{Handler: http.HandlerFunc(handleSession)}
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		fmt.Fprintf(os.Stderr, "serve: %v\n", err)
		os.Exit(1)
	}
}

// fakeAgentSession bridges one data-channel connection to the simulated shell.
type fakeAgentSession struct {
	mu      sync.Mutex
	ws      *websocket.Conn
	outSeq  int64
	mode    tuiMode
	cols    int
	rows    int
	tick    int
	lineBuf []byte
}

func handleSession(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	// Channel-open JSON (token handshake) arrives first; the token value is
	// irrelevant for the fixture.
	if _, _, err := ws.ReadMessage(); err != nil {
		return
	}

	session := &fakeAgentSession{ws: ws, mode: shellMode, cols: 120, rows: 32}
	session.write("READY:FAKE_AWS_SSM\r\n")
	session.write("TTY:true\r\n")
	session.printSize()
	session.printPrompt()

	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			os.Exit(0)
		}
		message := new(ssmdatachannel.AgentMessage)
		if err := message.UnmarshalBinary(data); err != nil {
			continue
		}
		switch message.MessageType {
		case ssmdatachannel.Acknowledge:
			// ignore client acks
		case ssmdatachannel.InputStreamData:
			session.ack(message)
			switch message.PayloadType {
			case ssmdatachannel.Output:
				session.handleInputBytes(message.Payload)
			case ssmdatachannel.Size:
				session.handleResize(message.Payload)
			case ssmdatachannel.Flag:
				if len(message.Payload) == 4 &&
					ssmdatachannel.PayloadTypeFlag(binary.BigEndian.Uint32(message.Payload)) == ssmdatachannel.TerminateSession {
					os.Exit(0)
				}
			}
		}
	}
}

// handleInputBytes implements a miniature line discipline: with the in-process
// data channel there is no local PTY, so echo, CR handling, and control-byte
// markers are simulated here the way a remote PTY would.
func (s *fakeAgentSession) handleInputBytes(payload []byte) {
	for _, b := range payload {
		switch b {
		case 0x03:
			s.write("SIGNAL:INT\r\n")
		case 0x1a:
			s.write("SIGNAL:TSTP\r\n")
		case 0x1c:
			s.write("SIGNAL:QUIT\r\n")
		case '\r', '\n':
			if s.currentMode() == shellMode {
				s.write("\r\n")
			}
			line := strings.TrimSpace(string(s.lineBuf))
			s.lineBuf = s.lineBuf[:0]
			if line != "" {
				s.handleLine(line)
			}
		case 0x7f, 0x08: // backspace
			if len(s.lineBuf) > 0 {
				s.lineBuf = s.lineBuf[:len(s.lineBuf)-1]
				if s.currentMode() == shellMode {
					s.write("\b \b")
				}
			}
		default:
			s.lineBuf = append(s.lineBuf, b)
			if s.currentMode() == shellMode {
				s.write(string([]byte{b}))
			}
		}
	}
}

func (s *fakeAgentSession) handleLine(line string) {
	switch s.currentMode() {
	case topMode:
		if line == "q" {
			s.exitTUI()
			return
		}
		s.renderCurrent()
	case viMode:
		if line == ":q" || line == "q" {
			s.exitTUI()
			return
		}
		s.renderCurrent()
	default:
		s.handleShellLine(line)
	}
}

func (s *fakeAgentSession) handleShellLine(line string) {
	switch line {
	case "__START_FAKE_TOP__":
		s.enterMode(topMode)
	case "__START_FAKE_VI__":
		s.enterMode(viMode)
	case "__REPORT_SIZE__":
		s.printSize()
		s.printPrompt()
	default:
		s.writef("ECHO:%s\r\n", line)
		s.printPrompt()
	}
}

func (s *fakeAgentSession) handleResize(payload []byte) {
	var dims struct {
		Cols uint32 `json:"cols"`
		Rows uint32 `json:"rows"`
	}
	if err := json.Unmarshal(payload, &dims); err != nil {
		return
	}
	s.mu.Lock()
	changed := int(dims.Cols) != s.cols || int(dims.Rows) != s.rows
	if dims.Cols > 0 {
		s.cols = maxInt(int(dims.Cols), 40)
	}
	if dims.Rows > 0 {
		s.rows = maxInt(int(dims.Rows), 12)
	}
	mode := s.mode
	s.mu.Unlock()
	if changed && mode != shellMode {
		s.renderCurrent()
	}
}

func (s *fakeAgentSession) currentMode() tuiMode {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mode
}

func (s *fakeAgentSession) enterMode(mode tuiMode) {
	s.mu.Lock()
	s.mode = mode
	s.tick = 0
	s.mu.Unlock()
	s.write("\x1b[?1049h\x1b[?25l")
	s.renderCurrent()
}

func (s *fakeAgentSession) exitTUI() {
	s.mu.Lock()
	s.mode = shellMode
	s.tick = 0
	s.mu.Unlock()
	s.write("\x1b[?25h\x1b[?1049l")
	s.printPrompt()
}

func (s *fakeAgentSession) renderCurrent() {
	s.mu.Lock()
	mode := s.mode
	cols := s.cols
	rows := s.rows
	s.tick += 1
	tick := s.tick
	s.mu.Unlock()

	switch mode {
	case topMode:
		s.write(renderTopScreen(cols, rows, tick))
	case viMode:
		s.write(renderViScreen(cols, rows))
	}
}

func (s *fakeAgentSession) printSize() {
	s.mu.Lock()
	cols := s.cols
	rows := s.rows
	s.mu.Unlock()
	s.writef("SIZE:%dx%d\r\n", cols, rows)
}

func (s *fakeAgentSession) printPrompt() {
	s.write("PROMPT> ready\r\n")
}

func (s *fakeAgentSession) ack(received *ssmdatachannel.AgentMessage) {
	payload, err := json.Marshal(map[string]any{
		"AcknowledgedMessageType":           received.MessageType,
		"AcknowledgedMessageSequenceNumber": received.SequenceNumber,
		"IsSequentialMessage":               true,
	})
	if err != nil {
		return
	}
	message := ssmdatachannel.NewAgentMessage()
	message.MessageType = ssmdatachannel.Acknowledge
	message.Flags = ssmdatachannel.Ack
	message.PayloadType = ssmdatachannel.Undefined
	message.SequenceNumber = received.SequenceNumber
	message.Payload = payload
	s.send(message)
}

func (s *fakeAgentSession) write(data string) {
	message := ssmdatachannel.NewAgentMessage()
	message.MessageType = ssmdatachannel.OutputStreamData
	message.Flags = ssmdatachannel.Data
	message.PayloadType = ssmdatachannel.Output
	message.Payload = []byte(data)
	s.mu.Lock()
	message.SequenceNumber = s.outSeq
	s.outSeq++
	s.mu.Unlock()
	s.send(message)
}

func (s *fakeAgentSession) writef(format string, args ...any) {
	s.write(fmt.Sprintf(format, args...))
}

func (s *fakeAgentSession) send(message *ssmdatachannel.AgentMessage) {
	data, err := message.MarshalBinary()
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.ws.WriteMessage(websocket.BinaryMessage, data)
}

func renderTopScreen(cols, rows, tick int) string {
	lines := []string{
		fitLine(fmt.Sprintf("top - fake session | tick %02d | %dx%d", tick, cols, rows), cols),
		fitLine("Tasks: 7 total, 1 running, 6 sleeping", cols),
		fitLine("CPU: 3.2% usr 1.1% sys 95.7% idle", cols),
		"",
		fitLine("PID   USER      COMMAND         CPU%   MEM%", cols),
		fitLine("101   root      fake-top         3.2    1.1", cols),
		fitLine("202   app       renderer         1.4    4.8", cols),
		fitLine("303   postgres  writer           0.6    2.1", cols),
	}

	for len(lines) < rows-1 {
		lines = append(lines, "")
	}
	lines = append(lines[:rows-1], fitLine("Press q to quit fake top", cols))
	return "\x1b[H\x1b[2J" + strings.Join(lines[:rows], "\r\n")
}

func renderViScreen(cols, rows int) string {
	lines := []string{
		fitLine("\"fake.txt\" [deterministic replay fixture]", cols),
		fitLine("Hello from fake vi.", cols),
		fitLine("This screen redraws when the PTY size changes.", cols),
		"",
	}

	for len(lines) < rows-1 {
		lines = append(lines, "~")
	}

	status := fitLine(fmt.Sprintf("NORMAL  fake.txt  %dx%d  :q to quit", cols, rows), cols)
	lines = append(lines[:rows-1], status)
	return "\x1b[H\x1b[2J" + strings.Join(lines[:rows], "\r\n")
}

func fitLine(line string, cols int) string {
	if cols <= 0 {
		return line
	}
	if len(line) <= cols {
		return line
	}
	if cols <= 1 {
		return line[:cols]
	}
	return line[:cols-1] + "…"
}

func maxInt(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}
