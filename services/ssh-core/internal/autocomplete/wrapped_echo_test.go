package autocomplete

import (
	"strings"
	"testing"
)

// 화면 폭에서 접힌 echo 도 걷어내야 한다.
//
// tty 는 한 줄이 폭을 넘으면 그 자리에 공백과 CR 을 끼워 넣는다. 우리가 보낸 글자와 화면에 찍힌
// 글자가 바이트로 달라지므로, 그대로 대조하면 **하나도 지워지지 않는다** — 실기기에서 주입
// 스크립트가 화면에 그대로 남은 원인이 이것이었다. 주입 명령은 어떤 셸에서도 한 줄 폭(보통 80~200
// 칸)보다 길므로 접힘은 예외가 아니라 기본이다.
func TestHandshakeScrubsAnEchoFoldedByTheTerminalWidth(t *testing.T) {
	lines := ShellIntegrationInitLines("")
	var handshake Handshake
	handshake.ArmForCommand(true, lines...)

	var out strings.Builder
	// tty 가 폭마다 " \r" 을 끼워 넣은 echo 를 흉내낸다.
	wrapped := func(s string) string {
		visible := strings.TrimSuffix(strings.TrimPrefix(s, " "), "\r")
		var b strings.Builder
		for i, r := range visible {
			if i > 0 && i%120 == 0 {
				b.WriteString(" \r")
			}
			b.WriteRune(r)
		}
		return b.String()
	}
	for _, chunk := range []string{
		wrapped(lines[0]) + "\r\n",
		"> " + wrapped(lines[1]) + "\r\n",
		"> " + wrapped(lines[2]) + "\r\n",
		PromptStartMarker + "inner$ ",
	} {
		out.Write(handshake.Filter([]byte(chunk)))
	}
	got := out.String()
	if strings.Contains(got, "__ds_o") {
		t.Errorf("접힌 echo 가 화면으로 나갔다: %q", got)
	}
	// 마커부터는 그대로 흘러야 한다 — 통합된 프롬프트가 화면에 남아야 한다.
	if !strings.Contains(got, PromptStartMarker) || !strings.Contains(got, "inner$ ") {
		t.Errorf("마커 뒤 프롬프트까지 지웠다: %q", got)
	}
}

// 개행은 건너뛰지 않는다 — 그것까지 건너뛰면 서로 다른 줄에 흩어진 글자가 우연히 이어져 엉뚱한
// 곳을 지운다.
func TestWrappedEchoSearchDoesNotJumpAcrossLines(t *testing.T) {
	if _, _, ok := findWrappedEcho([]byte("ab\r\nc"), []byte("abc")); ok {
		t.Error("줄을 건너뛰어 찾았다")
	}
	if _, _, ok := findWrappedEcho([]byte("ab \rc"), []byte("abc")); !ok {
		t.Error("접힌 자리를 못 찾았다")
	}
}

// PSReadLine 은 입력줄을 **구문 색으로 다시 그린다** — 우리가 보낸 글자 사이사이에 SGR 이스케이프가
// 끼어든다. 그대로 대조하면 한 글자도 못 지워서 주입 스크립트가 화면에 통째로 남는다(AWS SSM
// 윈도우에서 실제로 그랬다).
func TestFindWrappedEchoSkipsSyntaxColoringEscapes(t *testing.T) {
	echo := []byte("if (-not (Get-Variable -Name __ds)) { $x = 1 }")
	// PSReadLine 스타일: 키워드마다 SGR 을 끼워 넣고 줄 끝에서 접힌다.
	colored := "\x1b[93mif\x1b[0m (\x1b[97m-not\x1b[0m (\x1b[93mGet-Variable\x1b[0m " +
		"\x1b[97m-Name\x1b[0m __ds)) { \x1b[96m$x\x1b[0m \x1b[97m=\x1b[0m \x1b[95m1\x1b[0m }"
	data := []byte("PS C:\\> " + colored + "\r\nnext line")

	start, end, ok := findWrappedEcho(data, echo)
	if !ok {
		t.Fatalf("색이 끼어든 echo 를 찾지 못했다:\n%q", data)
	}
	rest := string(data[:start]) + string(data[end:])
	if strings.Contains(rest, "Get-Variable") {
		t.Fatalf("지운 뒤에도 스크립트가 남았다:\n%q", rest)
	}
	if !strings.Contains(rest, "PS C:\\> ") || !strings.Contains(rest, "next line") {
		t.Fatalf("주변 출력까지 지웠다:\n%q", rest)
	}
}

// 색이 끼어든 echo 가 **청크 경계에서 갈려도** 지워야 한다. SSM 은 데이터 채널이 잘게 오므로
// 스크립트 한 줄이 한 청크에 다 들어오지 않는다 — 꼬리를 붙들지 못하면 화면에 그대로 남는다.
func TestHandshakeStripsColoredEchoSplitAcrossChunks(t *testing.T) {
	command := " if (-not (Get-Variable -Name __ds)) { $x = 1 }\r"
	colored := "\x1b[93mif\x1b[0m (\x1b[97m-not\x1b[0m (\x1b[93mGet-Variable\x1b[0m " +
		"\x1b[97m-Name\x1b[0m __ds)) { \x1b[96m$x\x1b[0m \x1b[97m=\x1b[0m \x1b[95m1\x1b[0m }"

	handshake := &Handshake{}
	handshake.ArmForCommand(false, command)

	var forwarded []byte
	// 마커가 먼저 와서 필터가 "마커 뒤 재출력 지우기" 모드로 넘어간다.
	forwarded = append(forwarded, handshake.Filter([]byte(PromptStartMarker+"PS C:\\> "))...)
	// 그 뒤 색 입은 echo 가 세 조각으로 나뉘어 온다.
	for _, part := range []string{colored[:30], colored[30:70], colored[70:]} {
		forwarded = append(forwarded, handshake.Filter([]byte(part))...)
	}
	forwarded = append(forwarded, handshake.Filter([]byte("\r\nPS C:\\> "))...)

	if strings.Contains(string(forwarded), "Get-Variable") {
		t.Fatalf("갈려서 온 echo 를 지우지 못했다:\n%q", string(forwarded))
	}
	if !strings.Contains(string(forwarded), "PS C:\\> ") {
		t.Fatalf("프롬프트까지 지웠다:\n%q", string(forwarded))
	}
}
