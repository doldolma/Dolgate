package tmuxsession

import "testing"

func TestParseTmuxVersion(t *testing.T) {
	cases := []struct {
		in    string
		major int
		minor int
		patch int
		known bool
	}{
		{"3.0a", 3, 0, 1, true},
		{"2.6", 2, 6, 0, true},
		{"3.5a", 3, 5, 1, true},
		{"tmux 2.6", 2, 6, 0, true},
		{"tmux 3.4", 3, 4, 0, true},
		{"2.9", 2, 9, 0, true},
		{"3", 3, 0, 0, true},
		{"3.0", 3, 0, 0, true},
		{"3.1", 3, 1, 0, true},
		{"3.2b", 3, 2, 2, true},
		{"", 0, 0, 0, false},
		{"next-3.4", 0, 0, 0, false}, // 선두 숫자 아님 → 미상
		{"  2.8  ", 2, 8, 0, true},
	}
	for _, c := range cases {
		v := parseTmuxVersion(c.in)
		if v.known != c.known || (c.known && (v.major != c.major || v.minor != c.minor || v.patch != c.patch)) {
			t.Errorf("parseTmuxVersion(%q) = %+v, want major=%d minor=%d patch=%d known=%v",
				c.in, v, c.major, c.minor, c.patch, c.known)
		}
	}
}

func TestAtLeast(t *testing.T) {
	if !parseTmuxVersion("2.6").atLeast(2, 6) {
		t.Error("2.6 atLeast 2.6 should be true")
	}
	if parseTmuxVersion("2.6").atLeast(2, 9) {
		t.Error("2.6 atLeast 2.9 should be false")
	}
	if !parseTmuxVersion("3.0a").atLeast(2, 9) {
		t.Error("3.0a atLeast 2.9 should be true")
	}
	if parseTmuxVersion("2.8").atLeast(3, 0) {
		t.Error("2.8 atLeast 3.0 should be false")
	}
	if !parseTmuxVersion("3.4").atLeast(3, 1) {
		t.Error("3.4 atLeast 3.1 should be true")
	}
	// 버전 미상 → 최신 가정(항상 true).
	if !parseTmuxVersion("").atLeast(3, 1) {
		t.Error("unknown version atLeast should be true (latest assumption)")
	}
}

func TestSupportsSendKeysHex(t *testing.T) {
	// -H 는 정확히 3.0a 도입 — patch suffix 로 3.0a(켬)와 평이한 3.0(끔)을 구분한다.
	if parseTmuxVersion("2.6").supportsSendKeysHex() {
		t.Error("2.6 should NOT support send-keys -H")
	}
	if parseTmuxVersion("3.0").supportsSendKeysHex() {
		t.Error("3.0 (plain) should NOT support send-keys -H")
	}
	if !parseTmuxVersion("3.0a").supportsSendKeysHex() {
		t.Error("3.0a SHOULD support send-keys -H (실제 도입 버전)")
	}
	if !parseTmuxVersion("3.1").supportsSendKeysHex() {
		t.Error("3.1 should support send-keys -H")
	}
	if !parseTmuxVersion("3.5a").supportsSendKeysHex() {
		t.Error("3.5a should support send-keys -H")
	}
	if !parseTmuxVersion("").supportsSendKeysHex() {
		t.Error("unknown version should support send-keys -H (latest assumption)")
	}
}

func TestRefreshClientCommand(t *testing.T) {
	// 콤마 "W,H" 는 모든 버전(2.6 포함)이 받는 원래 형식 → 항상 콤마.
	for _, in := range []string{"2.6", "2.8", "2.9", "3.4", ""} {
		if got := refreshClientCommand(80, 24); got != "refresh-client -C 80,24\n" {
			t.Errorf("refresh(%q) = %q, want comma", in, got)
		}
	}
	if got := refreshClientCommand(100, 40); got != "refresh-client -C 100,40\n" {
		t.Errorf("refresh = %q, want comma", got)
	}
}
