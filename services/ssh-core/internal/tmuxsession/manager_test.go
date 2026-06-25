package tmuxsession

import (
	"strings"
	"testing"
)

func TestParseListWindowsLine(t *testing.T) {
	cases := []struct {
		name    string
		line    string
		wantOK  bool
		id      string
		index   int
		active  bool
		winName string
		layout  string
	}{
		{
			name:    "normal",
			line:    "@0 0 1 zsh bb62,80x24,0,0",
			wantOK:  true,
			id:      "@0",
			index:   0,
			active:  true,
			winName: "zsh",
			layout:  "bb62,80x24,0,0",
		},
		{
			name:    "inactive higher index",
			line:    "@3 2 0 logs e1f2,120x40,0,0,1",
			wantOK:  true,
			id:      "@3",
			index:   2,
			active:  false,
			winName: "logs",
			layout:  "e1f2,120x40,0,0,1",
		},
		{
			name:    "name with spaces",
			line:    "@1 1 0 my long window bb62,80x24,0,0",
			wantOK:  true,
			id:      "@1",
			index:   1,
			active:  false,
			winName: "my long window",
			layout:  "bb62,80x24,0,0",
		},
		{
			name:    "empty name (double space)",
			line:    "@2 1 1  bb62,80x24,0,0",
			wantOK:  true,
			id:      "@2",
			index:   1,
			active:  true,
			winName: "",
			layout:  "bb62,80x24,0,0",
		},
		{
			name:   "not a window id",
			line:   "garbage line here now",
			wantOK: false,
		},
		{
			name:   "too few fields",
			line:   "@0 0 1",
			wantOK: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			row, ok := parseListWindowsLine(tc.line)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			if row.id != tc.id || row.index != tc.index || row.active != tc.active ||
				row.name != tc.winName || row.layout != tc.layout {
				t.Fatalf("got %+v, want id=%s index=%d active=%v name=%q layout=%s",
					row, tc.id, tc.index, tc.active, tc.winName, tc.layout)
			}
		})
	}
}

// 윈도우 전환 시 renderer 가 InstallShellIntegration 을 매번 재호출해도 같은 pane 에는
// 한 번만 주입돼야 한다(재주입하면 init 스크립트가 다시 실행되며 프롬프트가 중복 출력됨).
func TestMarkIntegratedIsIdempotentPerPane(t *testing.T) {
	h := &controlHandle{}
	if !h.markIntegrated("%0") {
		t.Fatal("첫 주입은 true(새로 표시)여야 한다")
	}
	if h.markIntegrated("%0") {
		t.Fatal("같은 pane 재호출은 false(이미 주입)여야 한다 — 재주입 금지")
	}
	if !h.markIntegrated("%1") {
		t.Fatal("다른 pane 은 독립적으로 true 여야 한다")
	}
	if h.markIntegrated("%1") {
		t.Fatal("두 번째 pane 재호출도 false 여야 한다")
	}
}

func TestDefaultControlCommandProbesBeforeControlModeAttach(t *testing.T) {
	if !strings.Contains(defaultControlCommand, "tmux list-sessions >/dev/null 2>&1") {
		t.Fatalf("default command must probe existing sessions outside control mode: %q", defaultControlCommand)
	}
	if strings.Contains(defaultControlCommand, "tmux -CC attach 2>/dev/null ||") {
		t.Fatalf("default command must not use a failing control-mode attach as fallback: %q", defaultControlCommand)
	}
	if !strings.Contains(defaultControlCommand, "exec tmux -CC attach") {
		t.Fatalf("default command must attach existing tmux sessions: %q", defaultControlCommand)
	}
	if !strings.Contains(defaultControlCommand, "exec tmux -CC new-session -A -s dolgate") {
		t.Fatalf("default command must create the dolgate session when none exists: %q", defaultControlCommand)
	}
}
