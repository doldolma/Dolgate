package tmuxsession

import (
	"bytes"
	"strings"
)

// ControlEventKind는 tmux control mode(tmux -CC)가 내보내는 notification 종류다.
type ControlEventKind string

const (
	ControlOutput            ControlEventKind = "output"
	ControlBegin             ControlEventKind = "begin"
	ControlEnd               ControlEventKind = "end"
	ControlError             ControlEventKind = "error"
	ControlWindowAdd         ControlEventKind = "window-add"
	ControlWindowClose       ControlEventKind = "window-close"
	ControlWindowRenamed     ControlEventKind = "window-renamed"
	ControlLayoutChange      ControlEventKind = "layout-change"
	ControlSessionChanged    ControlEventKind = "session-changed"
	ControlSessionRenamed    ControlEventKind = "session-renamed"
	ControlSessionsChanged   ControlEventKind = "sessions-changed"
	ControlWindowPaneChanged ControlEventKind = "window-pane-changed"
	ControlExit              ControlEventKind = "exit"
	ControlPause             ControlEventKind = "pause"
	ControlContinue          ControlEventKind = "continue"
	ControlOther             ControlEventKind = "other"
)

// ControlEvent는 control mode 한 줄을 파싱한 결과다.
type ControlEvent struct {
	Kind     ControlEventKind
	PaneID   string   // %output/%pause/%continue 의 pane id (예 "%0")
	WindowID string   // window-*/layout-change 의 window id (예 "@0"), session-changed 는 "$0"
	Layout   string   // layout-change 의 layout 문자열
	Name     string   // window-renamed/session-changed 의 이름, exit 의 사유
	Data     []byte   // output 의 디코딩된 바이트
	Args     []string // 그 외 토큰(begin/end/error 등)
}

// ControlParser는 tmux -CC stdout 바이트 스트림을 줄 단위로 누적해 ControlEvent로 만든다.
// control mode는 줄 기반이므로 chunk 경계에서 잘린 줄은 다음 Feed까지 버퍼링한다.
type ControlParser struct {
	buf []byte
}

// Feed는 새로 도착한 바이트를 누적하고, 완성된 줄들을 파싱해 반환한다.
func (p *ControlParser) Feed(chunk []byte) []ControlEvent {
	p.buf = append(p.buf, chunk...)
	var events []ControlEvent
	for {
		idx := bytes.IndexByte(p.buf, '\n')
		if idx < 0 {
			break
		}
		line := strings.TrimSuffix(string(p.buf[:idx]), "\r")
		p.buf = p.buf[idx+1:]
		events = append(events, ParseControlLine(line))
	}
	return events
}

// ParseControlLine은 control mode 한 줄을 ControlEvent로 파싱한다.
func ParseControlLine(line string) ControlEvent {
	if !strings.HasPrefix(line, "%") {
		return ControlEvent{Kind: ControlOther, Args: []string{line}}
	}
	cmd, rest := splitFirst(line)
	switch cmd {
	case "%output":
		// %output %<pane> <escaped-data>
		pane, data := splitFirst(rest)
		return ControlEvent{Kind: ControlOutput, PaneID: pane, Data: unescapeOutput(data)}
	case "%extended-output":
		// %extended-output %<pane> <age> : <escaped-data> (tmux 3.2+ flow control)
		pane, after := splitFirst(rest)
		data := after
		if i := strings.Index(after, " : "); i >= 0 {
			data = after[i+3:]
		}
		return ControlEvent{Kind: ControlOutput, PaneID: pane, Data: unescapeOutput(data)}
	case "%window-add":
		return ControlEvent{Kind: ControlWindowAdd, WindowID: strings.TrimSpace(rest)}
	case "%window-close", "%unlinked-window-close":
		return ControlEvent{Kind: ControlWindowClose, WindowID: strings.TrimSpace(rest)}
	case "%window-renamed", "%unlinked-window-renamed":
		id, name := splitFirst(rest)
		return ControlEvent{Kind: ControlWindowRenamed, WindowID: id, Name: name}
	case "%layout-change":
		// %layout-change @<win> <layout> <visible-layout> <flags>
		id, after := splitFirst(rest)
		layout, _ := splitFirst(after)
		return ControlEvent{Kind: ControlLayoutChange, WindowID: id, Layout: layout}
	case "%session-changed":
		id, name := splitFirst(rest)
		return ControlEvent{Kind: ControlSessionChanged, WindowID: id, Name: name}
	case "%session-renamed":
		// %session-renamed $<id> <name>: 현재 세션 이름 변경(rename-session). 일부 버전은
		// $id 없이 이름만 보내므로 둘 다 처리한다.
		first, after := splitFirst(rest)
		if strings.HasPrefix(first, "$") {
			return ControlEvent{Kind: ControlSessionRenamed, WindowID: first, Name: after}
		}
		return ControlEvent{Kind: ControlSessionRenamed, Name: rest}
	case "%sessions-changed":
		return ControlEvent{Kind: ControlSessionsChanged}
	case "%window-pane-changed":
		// %window-pane-changed @<win> %<pane> : 윈도우의 활성 pane 이 바뀜
		win, pane := splitFirst(rest)
		return ControlEvent{Kind: ControlWindowPaneChanged, WindowID: win, PaneID: strings.TrimSpace(pane)}
	case "%begin":
		return ControlEvent{Kind: ControlBegin, Args: strings.Fields(rest)}
	case "%end":
		return ControlEvent{Kind: ControlEnd, Args: strings.Fields(rest)}
	case "%error":
		return ControlEvent{Kind: ControlError, Args: strings.Fields(rest)}
	case "%exit":
		return ControlEvent{Kind: ControlExit, Name: strings.TrimSpace(rest)}
	case "%pause":
		return ControlEvent{Kind: ControlPause, PaneID: strings.TrimSpace(rest)}
	case "%continue":
		return ControlEvent{Kind: ControlContinue, PaneID: strings.TrimSpace(rest)}
	default:
		return ControlEvent{Kind: ControlOther, Args: []string{line}}
	}
}

// splitFirst는 첫 공백을 기준으로 (앞, 뒤)로 나눈다. 공백이 없으면 (s, "").
func splitFirst(s string) (string, string) {
	i := strings.IndexByte(s, ' ')
	if i < 0 {
		return s, ""
	}
	return s[:i], s[i+1:]
}

// unescapeOutput은 tmux output escaping을 디코딩한다.
// tmux는 제어 바이트(< 0x20)와 백슬래시를 `\ooo`(3자리 octal)로 보내고, 그 외
// 바이트(UTF-8 멀티바이트 포함)는 raw로 보낸다. (tmux 3.6b -CC 실측으로 확인)
func unescapeOutput(s string) []byte {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); {
		if s[i] == '\\' && i+3 < len(s) &&
			isOctalDigit(s[i+1]) && isOctalDigit(s[i+2]) && isOctalDigit(s[i+3]) {
			v := (int(s[i+1]-'0') << 6) | (int(s[i+2]-'0') << 3) | int(s[i+3]-'0')
			out = append(out, byte(v))
			i += 4
			continue
		}
		out = append(out, s[i])
		i++
	}
	return out
}

func isOctalDigit(b byte) bool {
	return b >= '0' && b <= '7'
}
