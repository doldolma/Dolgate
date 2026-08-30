package autocomplete

import (
	"bytes"
	"strings"
)

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

// skipEscapeSequenceBytes 는 skipEscapeSequence 의 []byte 판이다. echo 대조(findWrappedEcho)가
// 한 바이트씩 훑으며 부르므로 문자열로 바꾸지 않는다(할당이 생긴다).
func skipEscapeSequenceBytes(data []byte, esc int) int {
	if esc+1 >= len(data) {
		return esc
	}
	switch data[esc+1] {
	case ']':
		for i := esc + 2; i < len(data); i++ {
			if data[i] == '\a' {
				return i
			}
			if data[i] == 0x1b && i+1 < len(data) && data[i+1] == '\\' {
				return i + 1
			}
		}
		return len(data) - 1
	case '[':
		for i := esc + 2; i < len(data); i++ {
			if data[i] >= 0x40 && data[i] <= 0x7e {
				return i
			}
		}
		return len(data) - 1
	default:
		return esc + 1
	}
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

// LooksLikePowerShellPrompt reports whether the output came from a Windows
// PowerShell session.
//
// **왜 필요한가:** POSIX 셸 통합 스크립트를 PowerShell 에 타이핑하면 마커가 영원히 오지 않는다.
// 그동안 handshake 필터가 출력을 전부 붙잡고 있어서, 화면이 8초 동안 멈춰 있다가 그 사이 친 것이
// 한꺼번에 쏟아진다. 호스트 정보(awsPlatform)로 미리 걸러도 되지만 그 값이 비어 있는 기록이
// 있으므로(직접 입력해 만든 호스트, 필드가 생기기 전에 만든 호스트), 출력 자체로도 알아낸다.
//
// 두 신호 중 하나면 충분하다. 배너는 세션 첫 덩어리에 오므로 설치를 시도하기도 전에 걸리고,
// 프롬프트는 배너를 끈 프로필에서도 잡힌다. 통합을 시도하는 창은 세션 시작 직후뿐이라 POSIX
// 셸에서 이 문구가 우연히 나올 여지는 없다.
func LooksLikePowerShellPrompt(value string) bool {
	stripped := StripTerminalControls(value)
	if strings.Contains(stripped, "Windows PowerShell") ||
		strings.Contains(stripped, "PowerShell 7") {
		return true
	}
	// "PS C:\...>" — PowerShell 기본 프롬프트. 드라이브 문자가 있어야 POSIX 프롬프트와 섞이지
	// 않는다.
	trimmed := strings.TrimRight(stripped, " \t\r\n")
	if !strings.HasSuffix(trimmed, ">") {
		return false
	}
	lineStart := strings.LastIndexAny(trimmed, "\r\n") + 1
	line := strings.TrimSpace(trimmed[lineStart:])
	if !strings.HasPrefix(line, "PS ") {
		return false
	}
	rest := line[len("PS "):]
	return len(rest) >= 3 && rest[1] == ':' && (rest[2] == '\\' || rest[2] == '/')
}

// PromptAlreadyIntegrated 는 이 출력 꼬리가 **이미 우리 훅을 가진 셸의 프롬프트**로 끝나는지
// 본다.
//
// 서브셸 진입 명령이 실패했을 때(`zsh` 미설치 → `command not found`) 원래 셸이 그대로 새
// 프롬프트를 그린다. 그 프롬프트에는 우리 마커(133;A)가 붙어 있다 — 새 셸의 맨 프롬프트에는
// 없다. 이걸 보면 "서브셸이 뜨지 않았다" 를 알 수 있고, 그때는 주입하지 않는다: 안 해도 통합은
// 살아 있고, 주입하면 화면에 프롬프트만 한 번 더 남는다(게다가 힌트가 fish 면 zsh 에 fish
// 문법이 들어간다).
func PromptAlreadyIntegrated(tail []byte) bool {
	return bytes.Contains(tail, []byte(PromptStartMarker))
}

// LooksLikeWindowsCommandLinePrompt 는 마지막 줄이 Windows cmd.exe 프롬프트(`C:\...>`)인지
// 본다. PowerShell 은 LooksLikePowerShellPrompt 가 banner · `PS X:\` 모양으로 잡지만,
// 커스텀 테마(PSReadLine · oh-my-posh)와 cmd.exe 는 그 모양이 아니다 — POSIX 프로브를
// 이런 줄에 쓰면 `printf` 가 인식 안 돼서 에러가 화면에 남는다. POSIX 경로( `/` )에는
// 드라이브 문자 + 백슬래시 접두가 없으므로 섞이지 않는다.
func LooksLikeWindowsCommandLinePrompt(value string) bool {
	trimmed := strings.TrimRight(StripTerminalControls(value), " \t\r\n")
	if trimmed == "" {
		return false
	}
	line := trimmed
	if i := strings.LastIndexAny(line, "\r\n"); i >= 0 {
		line = line[i+1:]
	}
	line = strings.TrimSpace(line)
	return isDriveLinePrefix(line)
}

func isDriveLinePrefix(line string) bool {
	if len(line) < 3 {
		return false
	}
	c := line[0]
	if (c < 'A' || c > 'Z') && (c < 'a' || c > 'z') {
		return false
	}
	return line[1] == ':' && (line[2] == '\\' || line[2] == '/')
}
