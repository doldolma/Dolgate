package tmuxsession

import "testing"

func TestParseOutputDecodesOctalControlBytes(t *testing.T) {
	ev := ParseControlLine("%output %0 Z\\033[1mQ")
	if ev.Kind != ControlOutput {
		t.Fatalf("kind=%s", ev.Kind)
	}
	if ev.PaneID != "%0" {
		t.Fatalf("pane=%s", ev.PaneID)
	}
	if string(ev.Data) != "Z\x1b[1mQ" {
		t.Fatalf("data=%q", ev.Data)
	}
}

func TestParseOutputKeepsRawUTF8(t *testing.T) {
	// 한글(ED 95 9C)은 raw byte로 온다(octal escape 아님) — tmux 3.6b 실측.
	ev := ParseControlLine("%output %1 Z\xed\x95\x9cQ")
	if string(ev.Data) != "Z\xed\x95\x9cQ" {
		t.Fatalf("data=%q", ev.Data)
	}
}

func TestParseOutputDecodesEscapedBackslash(t *testing.T) {
	ev := ParseControlLine("%output %0 a\\134b") // \134 octal = '\'
	if string(ev.Data) != "a\\b" {
		t.Fatalf("data=%q", ev.Data)
	}
}

func TestParseLayoutChange(t *testing.T) {
	ev := ParseControlLine("%layout-change @0 bd5e,80x24,0,0,0 bd5e,80x24,0,0,0 *")
	if ev.Kind != ControlLayoutChange || ev.WindowID != "@0" {
		t.Fatalf("ev=%+v", ev)
	}
	if ev.Layout != "bd5e,80x24,0,0,0" {
		t.Fatalf("layout=%s", ev.Layout)
	}
}

func TestParseWindowEvents(t *testing.T) {
	if ev := ParseControlLine("%window-add @2"); ev.Kind != ControlWindowAdd || ev.WindowID != "@2" {
		t.Fatalf("window-add: %+v", ev)
	}
	if ev := ParseControlLine("%window-close @2"); ev.Kind != ControlWindowClose || ev.WindowID != "@2" {
		t.Fatalf("window-close: %+v", ev)
	}
	if ev := ParseControlLine("%window-renamed @1 my work"); ev.Kind != ControlWindowRenamed || ev.WindowID != "@1" || ev.Name != "my work" {
		t.Fatalf("window-renamed: %+v", ev)
	}
}

func TestParseSessionChanged(t *testing.T) {
	// %session-changed $<id> <name>: 세션명이 Name 에 실려야 푸터가 호스트명 대신
	// 실제 tmux 세션명을 보일 수 있다(공백 포함 세션명도 통째로 보존).
	if ev := ParseControlLine("%session-changed $0 dolgate"); ev.Kind != ControlSessionChanged || ev.WindowID != "$0" || ev.Name != "dolgate" {
		t.Fatalf("session-changed: %+v", ev)
	}
	if ev := ParseControlLine("%session-changed $2 my session"); ev.Kind != ControlSessionChanged || ev.Name != "my session" {
		t.Fatalf("session-changed with spaces: %+v", ev)
	}
}

func TestParseSessionRenamed(t *testing.T) {
	// %session-renamed: $id + 이름 / 이름만, 둘 다 Name 에 새 이름이 실려야 한다.
	if ev := ParseControlLine("%session-renamed $0 newname"); ev.Kind != ControlSessionRenamed || ev.Name != "newname" {
		t.Fatalf("session-renamed with id: %+v", ev)
	}
	if ev := ParseControlLine("%session-renamed my session"); ev.Kind != ControlSessionRenamed || ev.Name != "my session" {
		t.Fatalf("session-renamed name only: %+v", ev)
	}
}

func TestParseWindowPaneChanged(t *testing.T) {
	// %window-pane-changed @<win> %<pane>: 활성 pane 변경 → 키보드 pane 이동 포커스 동기화.
	ev := ParseControlLine("%window-pane-changed @1 %4")
	if ev.Kind != ControlWindowPaneChanged || ev.WindowID != "@1" || ev.PaneID != "%4" {
		t.Fatalf("window-pane-changed: %+v", ev)
	}
}

func TestParseExitAndLifecycle(t *testing.T) {
	if ev := ParseControlLine("%exit"); ev.Kind != ControlExit || ev.Name != "" {
		t.Fatalf("exit: %+v", ev)
	}
	if ev := ParseControlLine("%exit server exited"); ev.Kind != ControlExit || ev.Name != "server exited" {
		t.Fatalf("exit reason: %+v", ev)
	}
	if ev := ParseControlLine("%begin 1700000000 12 1"); ev.Kind != ControlBegin {
		t.Fatalf("begin: %+v", ev)
	}
	if ev := ParseControlLine("%pause %3"); ev.Kind != ControlPause || ev.PaneID != "%3" {
		t.Fatalf("pause: %+v", ev)
	}
}

func TestExtendedOutput(t *testing.T) {
	ev := ParseControlLine("%extended-output %3 5 : he\\033llo")
	if ev.Kind != ControlOutput || ev.PaneID != "%3" {
		t.Fatalf("ext: %+v", ev)
	}
	if string(ev.Data) != "he\x1bllo" {
		t.Fatalf("ext data=%q", ev.Data)
	}
}

func TestFeedBuffersPartialLines(t *testing.T) {
	var p ControlParser
	if evs := p.Feed([]byte("%output %0 hel")); len(evs) != 0 {
		t.Fatalf("expected buffering, got %d", len(evs))
	}
	evs := p.Feed([]byte("lo\n%window-add @1\n"))
	if len(evs) != 2 {
		t.Fatalf("expected 2 events, got %d", len(evs))
	}
	if evs[0].Kind != ControlOutput || string(evs[0].Data) != "hello" {
		t.Fatalf("ev0=%+v", evs[0])
	}
	if evs[1].Kind != ControlWindowAdd || evs[1].WindowID != "@1" {
		t.Fatalf("ev1=%+v", evs[1])
	}
}
