package tmuxsession

import (
	"strings"
	"testing"
)

func TestEncodeInputEmpty(t *testing.T) {
	if cmds := encodeInput("%0", nil, parseTmuxVersion("2.6")); cmds != nil {
		t.Errorf("empty input should yield nil, got %v", cmds)
	}
	if cmds := encodeInput("%0", []byte{}, parseTmuxVersion("3.4")); cmds != nil {
		t.Errorf("empty input should yield nil, got %v", cmds)
	}
}

func TestEncodeInputNewVersionUsesHex(t *testing.T) {
	// 신버전(>=3.1)은 기존과 동일한 send-keys -H 한 줄(회귀 금지).
	cmds := encodeInput("%0", []byte("echo hi\r"), parseTmuxVersion("3.4"))
	if len(cmds) != 1 {
		t.Fatalf("expected 1 cmd, got %d: %v", len(cmds), cmds)
	}
	want := "send-keys -t %0 -H " + hexBytes([]byte("echo hi\r")) + "\n"
	if cmds[0] != want {
		t.Errorf("hex cmd = %q, want %q", cmds[0], want)
	}
	// 미상도 -H 경로.
	if cmds := encodeInput("%0", []byte("x"), parseTmuxVersion("")); len(cmds) != 1 || !strings.Contains(cmds[0], "-H ") {
		t.Errorf("unknown version should use -H, got %v", cmds)
	}
}

func TestEncodeInputLegacyEchoEnter(t *testing.T) {
	// 2.6 경로: "echo hi\r" → 리터럴 'echo hi' + Enter.
	cmds := encodeInput("%0", []byte("echo hi\r"), parseTmuxVersion("2.6"))
	want := []string{
		"send-keys -t %0 -l 'echo hi'\n",
		"send-keys -t %0 Enter\n",
	}
	assertCmds(t, cmds, want)
}

func TestEncodeInputLegacyArrowKey(t *testing.T) {
	// 화살표 위 = ESC '[' 'A'. ESC keytimeout 경합을 피하려 ESC 를 리터럴에 그대로 담아
	// CSI 시퀀스 전체를 한 -l 명령으로 보낸다(분리 전송 금지).
	cmds := encodeInput("%0", []byte{0x1b, '[', 'A'}, parseTmuxVersion("2.6"))
	want := []string{
		"send-keys -t %0 -l '\x1b[A'\n",
	}
	assertCmds(t, cmds, want)
}

func TestEncodeInputLegacyEscapeAlone(t *testing.T) {
	// 단독 ESC 도 리터럴로 보낸다(키이름 Escape 아님).
	cmds := encodeInput("%0", []byte{0x1b}, parseTmuxVersion("2.6"))
	assertCmds(t, cmds, []string{"send-keys -t %0 -l '\x1b'\n"})
}

func TestEncodeInputLegacyCtrlC(t *testing.T) {
	cmds := encodeInput("%0", []byte{0x03}, parseTmuxVersion("2.6"))
	assertCmds(t, cmds, []string{"send-keys -t %0 C-c\n"})
}

func TestEncodeInputLegacyCtrlD(t *testing.T) {
	cmds := encodeInput("%0", []byte{0x04}, parseTmuxVersion("2.6"))
	assertCmds(t, cmds, []string{"send-keys -t %0 C-d\n"})
}

func TestEncodeInputLegacyBSpace(t *testing.T) {
	// 0x7f = BSpace(DEL), NOT 0x08.
	cmds := encodeInput("%0", []byte{0x7f}, parseTmuxVersion("2.6"))
	assertCmds(t, cmds, []string{"send-keys -t %0 BSpace\n"})
}

func TestEncodeInputLegacyTabEscape(t *testing.T) {
	cmds := encodeInput("%0", []byte{0x09}, parseTmuxVersion("2.6"))
	assertCmds(t, cmds, []string{"send-keys -t %0 Tab\n"})
}

func TestEncodeInputLegacySingleQuoteEscape(t *testing.T) {
	// 작은따옴표 포함 리터럴은 닫고-"'"-이어붙이기. it's → 'it'"'"'s'.
	cmds := encodeInput("%0", []byte("it's"), parseTmuxVersion("2.6"))
	want := []string{`send-keys -t %0 -l 'it'"'"'s'` + "\n"}
	assertCmds(t, cmds, want)
}

func TestEncodeInputLegacyLeadingDash(t *testing.T) {
	// '-' 로 시작하는 리터럴은 첫 '-' 를 개별 키로, 나머지를 리터럴로 보낸다(플래그 오인 방지).
	cmds := encodeInput("%0", []byte("-foo"), parseTmuxVersion("2.6"))
	want := []string{
		"send-keys -t %0 -\n",
		"send-keys -t %0 -l 'foo'\n",
	}
	assertCmds(t, cmds, want)
}

func TestEncodeInputLegacyUTF8(t *testing.T) {
	// 멀티바이트 UTF-8 은 리터럴로 그대로 통과(변환 없음).
	cmds := encodeInput("%0", []byte("한글"), parseTmuxVersion("2.6"))
	want := []string{"send-keys -t %0 -l '한글'\n"}
	assertCmds(t, cmds, want)
}

func TestEncodeInputLegacyOrderPreserved(t *testing.T) {
	// "ab\rcd" → 'ab' / Enter / 'cd' 순서 보존.
	cmds := encodeInput("%0", []byte("ab\rcd"), parseTmuxVersion("2.6"))
	want := []string{
		"send-keys -t %0 -l 'ab'\n",
		"send-keys -t %0 Enter\n",
		"send-keys -t %0 -l 'cd'\n",
	}
	assertCmds(t, cmds, want)
}

func assertCmds(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("cmd count = %d, want %d\n got=%q\nwant=%q", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("cmd[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}
