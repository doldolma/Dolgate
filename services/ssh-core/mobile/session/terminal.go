// Package session is the Go-native mobile shell engine: it dials through
// internal/sshconn, opens a PTY-backed shell, and parks its output in a
// ringbuf.Ring for the app to pull.
//
// Nothing here is shaped for gomobile. The bind surface lives one directory up
// and wraps these types, so this package can use maps, slices of structs and
// unsigned integers freely.
package session

import "golang.org/x/crypto/ssh"

// TerminalType is the TERM value negotiated for the PTY.
type TerminalType uint8

const (
	TerminalVanilla TerminalType = iota
	TerminalVT100
	TerminalVT102
	TerminalVT220
	TerminalANSI
	TerminalXterm
	TerminalXterm256
)

// SSHName is the string sent in the pty-req. Unknown values fall back to
// xterm-256color, which is what the app requests in practice.
func (t TerminalType) SSHName() string {
	switch t {
	case TerminalVanilla:
		return "vanilla"
	case TerminalVT100:
		return "vt100"
	case TerminalVT102:
		return "vt102"
	case TerminalVT220:
		return "vt220"
	case TerminalANSI:
		return "ansi"
	case TerminalXterm:
		return "xterm"
	case TerminalXterm256:
		return "xterm-256color"
	default:
		return "xterm-256color"
	}
}

// TerminalTypeFromName maps a TERM string to a TerminalType. The app sends the
// TERM name rather than an ordinal so the two sides cannot drift apart if this
// list grows. Anything unrecognised becomes TerminalXterm256, matching
// SSHName's fallback.
func TerminalTypeFromName(name string) TerminalType {
	switch name {
	case "vanilla":
		return TerminalVanilla
	case "vt100":
		return TerminalVT100
	case "vt102":
		return TerminalVT102
	case "vt220":
		return TerminalVT220
	case "ansi":
		return TerminalANSI
	case "xterm":
		return TerminalXterm
	default:
		return TerminalXterm256
	}
}

// PTY geometry used when the app does not supply one. The app measures the real
// terminal and passes explicit values; these only cover the gap before the
// first measurement arrives.
const (
	DefaultRows = 24
	DefaultCols = 80
)

// Baud rate advertised in the pty-req. Nothing enforces it, but some remote
// programs read it to size their output.
const DefaultBaud = 38400

// TerminalMode is one pty-req opcode/value pair (RFC 4254 section 8).
type TerminalMode struct {
	Opcode uint8
	Value  uint32
}

// DefaultTerminalModes mirrors the modes the previous Rust engine requested.
// They are deliberately not the same as the desktop session manager's, which
// asks only for ECHO at 14400 baud: mobile relies on the remote side doing
// canonical-mode line editing and CR/LF translation, because the on-screen
// keyboard has no terminal driver of its own behind it.
func DefaultTerminalModes() []TerminalMode {
	return []TerminalMode{
		{Opcode: ssh.ECHO, Value: 1},
		{Opcode: ssh.ECHOK, Value: 1},
		{Opcode: ssh.ECHOE, Value: 1},
		{Opcode: ssh.ICANON, Value: 1},
		{Opcode: ssh.ISIG, Value: 1},
		{Opcode: ssh.ICRNL, Value: 1},
		{Opcode: ssh.ONLCR, Value: 1},
		{Opcode: ssh.TTY_OP_ISPEED, Value: DefaultBaud},
		{Opcode: ssh.TTY_OP_OSPEED, Value: DefaultBaud},
	}
}

func terminalModes(modes []TerminalMode) ssh.TerminalModes {
	if len(modes) == 0 {
		modes = DefaultTerminalModes()
	}
	out := make(ssh.TerminalModes, len(modes))
	for _, mode := range modes {
		out[mode.Opcode] = mode.Value
	}
	return out
}
