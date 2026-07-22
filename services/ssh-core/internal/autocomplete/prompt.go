package autocomplete

import "strings"

// promptSuffixes are the trailing glyphs that mark the end of an interactive
// shell prompt across bash/zsh/fish and common themes (oh-my-zsh, starship).
// A password prompt ("Password:") or a pager status line does not end with
// these, which keeps prompt-settle detection from firing mid-authentication.
var promptSuffixes = []string{"$", "#", "%", ">", "❯", "➜"}

// LooksLikeShellPrompt reports whether the tail of terminal output looks like a
// settled interactive shell prompt. It strips terminal control sequences first
// so OSC/CSI noise around the prompt does not defeat the suffix check. Used to
// decide when a freshly entered (sub)shell is ready to receive an injected
// shell-integration init command.
func LooksLikeShellPrompt(value string) bool {
	trimmed := strings.TrimRight(StripTerminalControls(value), " \t\r\n")
	if trimmed == "" {
		return false
	}
	for _, suffix := range promptSuffixes {
		if strings.HasSuffix(trimmed, suffix) {
			return true
		}
	}
	return false
}

// StripTerminalControls removes ANSI escape sequences (CSI/OSC) and other
// C0 control bytes from value, preserving printable text plus CR/LF/TAB. It is
// used before prompt heuristics so cursor moves and color codes do not hide the
// prompt's trailing glyph.
func StripTerminalControls(value string) string {
	var out strings.Builder
	out.Grow(len(value))
	for i := 0; i < len(value); i++ {
		ch := value[i]
		if ch == 0x1b {
			i = skipEscapeSequence(value, i)
			continue
		}
		if ch < 0x20 && ch != '\r' && ch != '\n' && ch != '\t' {
			continue
		}
		out.WriteByte(ch)
	}
	return out.String()
}

// skipEscapeSequence returns the index of the last byte of the escape sequence
// beginning at esc (an ESC byte). OSC sequences terminate on BEL or ST; CSI on
// a final byte in 0x40-0x7e; anything else is treated as a 2-byte sequence.
func skipEscapeSequence(value string, esc int) int {
	if esc+1 >= len(value) {
		return esc
	}
	switch value[esc+1] {
	case ']':
		for i := esc + 2; i < len(value); i++ {
			if value[i] == '\a' {
				return i
			}
			if value[i] == 0x1b && i+1 < len(value) && value[i+1] == '\\' {
				return i + 1
			}
		}
		return len(value) - 1
	case '[':
		for i := esc + 2; i < len(value); i++ {
			if value[i] >= 0x40 && value[i] <= 0x7e {
				return i
			}
		}
		return len(value) - 1
	default:
		return esc + 1
	}
}
