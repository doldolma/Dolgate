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
