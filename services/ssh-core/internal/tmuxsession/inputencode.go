package tmuxsession

import (
	"fmt"
	"strings"
)

// encodeInput 은 pane(paneID="%N")에 보낼 입력 바이트열을 control 채널용 send-keys
// 명령 줄(들)로 변환한다. 각 줄은 끝에 "\n" 을 포함한 완전한 명령이다.
//
//   - ver 이 send-keys -H 를 지원하면(>= 3.0a) 현행대로 한 줄: "send-keys -t %N -H <hex>".
//   - 그 미만(2.6 ~ 3.0)에서는 -H 가 없으므로 바이트를 토큰화한다:
//     리터럴 가능 바이트(출력가능 + ESC 포함) 연속 → send-keys -t %N -l '<리터럴>'(작은따옴표 escape),
//     명령 줄에 못 담는/제어 바이트(Enter·Tab·BSpace·C-* 등) → tmux 키이름(send-keys -t %N <KeyName>).
//     ESC 는 리터럴에 그대로 담아, 화살표(ESC '[' 'A') 같은 CSI 시퀀스가 한 -l 명령으로
//     붙어 가게 한다(분리 전송 시 ESC keytimeout 으로 화살표가 글자로 찍히는 문제 방지).
//
// 빈 입력이면 빈 슬라이스를 돌려준다(호출부가 아무것도 쓰지 않게).
func encodeInput(paneID string, data []byte, ver tmuxVersion) []string {
	if len(data) == 0 {
		return nil
	}
	if ver.supportsSendKeysHex() {
		return []string{fmt.Sprintf("send-keys -t %s -H %s\n", paneID, hexBytes(data))}
	}
	return encodeInputLegacy(paneID, data)
}

// encodeInputLegacy 는 2.6~3.0(send-keys -H 미지원) 경로다. 바이트열을 출력가능 런과
// 제어바이트로 토큰화해 순서대로 send-keys 명령을 만든다.
func encodeInputLegacy(paneID string, data []byte) []string {
	var cmds []string
	var run []byte // 현재 누적 중인 출력가능 런

	flush := func() {
		if len(run) == 0 {
			return
		}
		cmds = append(cmds, literalSendKeys(paneID, run)...)
		run = run[:0]
	}

	for _, b := range data {
		if name, ok := controlKeyName(b); ok {
			flush()
			cmds = append(cmds, fmt.Sprintf("send-keys -t %s %s\n", paneID, name))
			continue
		}
		// 출력가능 바이트(0x20-0x7e, 또는 0x80+ UTF-8 연속 바이트). 그대로 누적.
		run = append(run, b)
	}
	flush()
	return cmds
}

// literalSendKeys 는 출력가능 바이트 런을 "send-keys -t %N -l '<리터럴>'" 명령으로
// 만든다. tmux 2.6 에는 "--" end-of-options 가 없으므로, 런이 '-' 로 시작하면 플래그로
// 오인된다. 이를 피하려 선두 '-' 는 키이름으로 따로(예: send-keys -t %N -) 보내고
// 나머지를 리터럴로 보낸다(검증된 회피책: 첫 글자 분리 전송).
func literalSendKeys(paneID string, run []byte) []string {
	if len(run) == 0 {
		return nil
	}
	var cmds []string
	// 선두에 연속된 '-' 는 개별 키로 보낸다(send-keys -t %N - 는 '-' 한 글자를 보냄).
	i := 0
	for i < len(run) && run[i] == '-' {
		cmds = append(cmds, fmt.Sprintf("send-keys -t %s -\n", paneID))
		i++
	}
	rest := run[i:]
	if len(rest) == 0 {
		return cmds
	}
	cmds = append(cmds, fmt.Sprintf("send-keys -t %s -l %s\n", paneID, singleQuote(string(rest))))
	return cmds
}

// singleQuote 는 문자열을 tmux 2.6 파서가 받는 작은따옴표 리터럴로 감싼다. 작은따옴표
// 안에서는 어떤 이스케이프도 처리되지 않으므로, 내부의 ' 는 닫고-큰따옴표로-감싼-'-이어붙이기
// 방식('it'"'"'s')으로 표현한다. 이는 POSIX 셸과 tmux 2.6 파서 양쪽에서 안전하다.
func singleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

// controlKeyName 은 제어바이트(0x00-0x1f, 0x7f)를 tmux send-keys 가 받는 키이름으로
// 매핑한다. 매핑이 있으면 (이름, true). 없으면 ("", false)로, 호출부가 리터럴로 다룬다.
//
// 검증된 매핑(Phase1):
//   - 0x0d=Enter(CR), 0x09=Tab, 0x1b=Escape, 0x7f=BSpace(DEL), 0x00=C-Space.
//   - 0x01..0x1a = C-a..C-z (단 0x09/0x0d 는 위에서 Tab/Enter 로 먼저 잡힌다).
//   - 그 외(0x0a=LF 등)는 C-<글자>로 보낸다(0x0a=C-j).
func controlKeyName(b byte) (string, bool) {
	switch b {
	case 0x0d:
		return "Enter", true
	case 0x09:
		return "Tab", true
	case 0x7f:
		return "BSpace", true
	case 0x00:
		return "C-Space", true
	}
	// 0x1b(ESC)는 일부러 키이름으로 안 보낸다 — ESC 를 따로 send-keys 하면 뒤따르는 CSI
	// 본문('[A' 등)과 분리돼, 느린/지터 있는 원격에서 readline/zle 의 ESC keytimeout 이
	// ESC 를 단독 Escape 로 오인하고 '[A' 를 리터럴로 흘린다(화살표가 글자로 찍힘). 대신
	// ESC 를 리터럴 런에 그대로 담아(아래 false 반환) -l 로 한 번에 보내 한 pty write 로
	// 시퀀스가 붙어 가게 한다(-l 은 ESC 바이트도 그대로 전달).
	if b == 0x1b {
		return "", false
	}
	if b >= 0x01 && b <= 0x1a {
		// C-a..C-z. 0x01='a'(0x61). 0x09/0x0d 는 위 switch 에서 이미 처리됨.
		return fmt.Sprintf("C-%c", 'a'+(b-0x01)), true
	}
	switch b {
	case 0x1c:
		return `C-\`, true
	case 0x1d:
		return "C-]", true
	case 0x1e:
		return "C-^", true
	case 0x1f:
		return "C-_", true
	}
	// 그 외(0x20~0x7e 출력가능, 0x80+ UTF-8, 그리고 위에서 false 로 둔 0x1b)는 리터럴.
	return "", false
}
