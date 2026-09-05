package tmuxsession

import (
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/pkg/coretypes"
)

// waitForControlCommand 는 control stdin(원문) 에 want 가 count 번 쌓일 때까지 기다린다.
// (waitForStdin 은 send-keys 의 16진 인코딩을 풀어 보는 것이라 여기엔 맞지 않는다.)
func waitForControlCommand(t *testing.T, recorder *paneStdinRecorder, want string, count int) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for strings.Count(recorder.snapshot(), want) < count {
		if time.Now().After(deadline) {
			t.Fatalf("control stdin 에 %q 가 %d번 오지 않았다: %q", want, count, recorder.snapshot())
		}
		time.Sleep(5 * time.Millisecond)
	}
	return recorder.snapshot()
}

// 실기기에서 전환한 창의 vi 만 깨진 원인. tmux 는 클라이언트 크기가 바뀌면 모든 창을 다시 재지만
// `%layout-change` 는 활성 창에만 보내서, 비활성 창의 칸 수가 attach 때 값으로 굳는다. 그래서 리사이즈가
// pane 크기에 반영된 뒤(복원과 같은 틈) 모든 창의 레이아웃을 우리가 다시 물어야 한다 — 첫 리사이즈만이
// 아니라 **매번**(앱 창을 나중에 키워도 비활성 창은 또 굳는다).
func TestResizeRefreshesAllWindowLayoutsAfterSettle(t *testing.T) {
	m := NewManager(func(coretypes.Event) {}, func(coretypes.StreamFrame, []byte) {})
	m.restoreSettle = 10 * time.Millisecond
	// 복원은 이 테스트의 관심이 아니다 — tmux 없이 빈 목록을 돌려 준다.
	m.paneRestoreStates = func(*controlHandle) []paneRestoreState { return nil }
	recorder := &paneStdinRecorder{}
	handle := &controlHandle{id: "ctl", stdin: recorder, closed: make(chan struct{})}
	m.mu.Lock()
	m.controls["ctl"] = handle
	m.mu.Unlock()

	if err := m.Resize("tmux:ctl:7", 162, 59); err != nil {
		t.Fatalf("resize: %v", err)
	}
	got := waitForControlCommand(t, recorder, listWindowsLayoutRefreshCommand, 1)
	refresh := strings.Index(got, "refresh-client -C 162,59\n")
	relist := strings.Index(got, listWindowsLayoutRefreshCommand)
	if refresh < 0 || relist < refresh {
		t.Fatalf("refresh-client 가 먼저, 레이아웃 재질의가 그 뒤여야 한다: %q", got)
	}

	// 두 번째 리사이즈에도 다시 묻는다(연결당 1회인 복원과 달리).
	if err := m.Resize("tmux:ctl:7", 120, 40); err != nil {
		t.Fatalf("resize 2: %v", err)
	}
	waitForControlCommand(t, recorder, listWindowsLayoutRefreshCommand, 2)
}

// 리사이즈 뒤 재질의는 **격자만** 갱신해야 한다. 활성 열을 tmux 값으로 보내면, 사용자가 방금 고른 창을
// tmux 가 아직 반영하기 전에 떠 온 응답이 렌더러의 활성 창을 되돌려 놓는다. 그래서 형식 문자열 자체가
// 활성 창을 말할 수 없어야 한다(0 고정). 창 추가 때의 list-windows 는 새 창을 활성으로 옮겨야 하므로
// tmux 값을 그대로 쓴다 — 두 형식은 활성 열만 다르고 나머지 열은 같은 파서를 탄다.
func TestLayoutRefreshCommandNeverReportsAnActiveWindow(t *testing.T) {
	if strings.Contains(listWindowsLayoutRefreshCommand, "#{window_active}") {
		t.Fatalf("레이아웃 재질의는 활성 창을 말하면 안 된다: %q", listWindowsLayoutRefreshCommand)
	}
	if !strings.Contains(listWindowsCommand, "#{window_active}") {
		t.Fatalf("창 추가 때의 list-windows 는 활성 창을 알려야 한다: %q", listWindowsCommand)
	}
	// tmux 가 형식을 펼친 한 줄을 흉내 낸다.
	expand := func(format string) string {
		row := strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(format), `list-windows -F "`), `"`)
		for from, to := range map[string]string{
			"#{window_id}":             "@3",
			"#{window_index}":          "1",
			"#{window_active}":         "1",
			"#{window_name}":           "vi",
			"#{window_visible_layout}": "c0de,81x59,0,0,5",
		} {
			row = strings.ReplaceAll(row, from, to)
		}
		return row
	}
	refresh, ok := parseListWindowsLine(expand(listWindowsLayoutRefreshCommand))
	if !ok {
		t.Fatalf("재질의 행이 파싱되지 않는다: %q", expand(listWindowsLayoutRefreshCommand))
	}
	if refresh.active {
		t.Fatalf("재질의 행은 활성 창이어도 active=false 여야 한다: %+v", refresh)
	}
	if refresh.id != "@3" || refresh.index != 1 || refresh.name != "vi" || refresh.layout != "c0de,81x59,0,0,5" {
		t.Fatalf("재질의 행의 나머지 열은 그대로여야 한다: %+v", refresh)
	}
	added, ok := parseListWindowsLine(expand(listWindowsCommand))
	if !ok || !added.active {
		t.Fatalf("창 추가 때의 행은 tmux 의 활성 값을 전달해야 한다: %+v ok=%v", added, ok)
	}
}

// attach 때 코어는 창 목록을 한 번에 내보낸다. 렌더러는 **첫** layout 이벤트로 그룹을 만들며 그 창을
// 활성으로 삼으므로, 비활성 창이 먼저 가면 그 찰나에 그 창이 활성이 되어 그 창의 pane 들이 낡은 칸 수로
// xterm 을 만들어 버린다(숨겨지면 리사이즈도 안 돼 그대로 굳는다 → 복원 화면이 어긋나고 vi 는 깨진 채
// 남는다). 그래서 활성 창을 먼저 내보내야 한다.
func TestFlushCollectedLayoutsEmitsTheActiveWindowFirst(t *testing.T) {
	var got []coretypes.TmuxLayoutChangePayload
	m := NewManager(func(ev coretypes.Event) {
		if p, ok := ev.Payload.(coretypes.TmuxLayoutChangePayload); ok {
			got = append(got, p)
		}
	}, func(coretypes.StreamFrame, []byte) {})
	handle := &controlHandle{id: "ctl", closed: make(chan struct{})}
	handle.collecting = true
	// tmux 가 준 순서: 비활성 @0 이 먼저, 활성 @1 이 뒤.
	handle.collected = []string{
		"@0 0 0 vi bd5e,100x50,0,0,0",
		"@1 1 1 bash bd5e,100x50,0,0,1",
		"@2 2 0 logs bd5e,100x50,0,0,2",
	}
	m.flushCollectedLayouts(handle)

	if len(got) != 3 {
		t.Fatalf("창 3개가 나와야 한다: %+v", got)
	}
	if got[0].WindowID != "@1" || !got[0].Active {
		t.Fatalf("활성 창(@1)이 먼저 나와야 한다 — 아니면 렌더러가 잠깐 엉뚱한 창을 활성으로 잡는다: %+v", got)
	}
	// 나머지는 원래 순서를 지킨다(안정 정렬) — 인덱스 순서가 뒤집히면 창 바가 흔들린다.
	if got[1].WindowID != "@0" || got[2].WindowID != "@2" {
		t.Fatalf("비활성 창들은 원래 순서를 지켜야 한다: %+v", got)
	}
	// 수집 상태는 비워져 다음 응답과 섞이지 않아야 한다.
	if handle.collecting || handle.collected != nil {
		t.Fatalf("flush 뒤 수집 상태가 남았다: collecting=%v collected=%v", handle.collecting, handle.collected)
	}
}
