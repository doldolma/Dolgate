//go:build integration

package tmuxsession

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/sshcmd"
	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// layoutGeometry 는 tmux 레이아웃 문자열 "<checksum>,<W>x<H>,<x>,<y>[,…]" 에서 창 크기 WxH 를 뗀다.
func layoutGeometry(layout string) string {
	parts := strings.Split(layout, ",")
	if len(parts) < 2 {
		return ""
	}
	return parts[1]
}

func lastLayoutFor(layouts []coretypes.TmuxLayoutChangePayload, windowID string) (coretypes.TmuxLayoutChangePayload, int) {
	var last coretypes.TmuxLayoutChangePayload
	count := 0
	for _, p := range layouts {
		if p.WindowID == windowID {
			last = p
			count++
		}
	}
	return last, count
}

// 실제 tmux 3.0a 에서: 창 둘을 만들고 창1 을 활성으로 두고 붙은 뒤 크기를 보고하면, **비활성 창0** 의
// 레이아웃이 tmux 의 실제 크기로 갱신되어 도착해야 한다(tmux 는 활성 창에만 %layout-change 를 보내므로
// 우리가 다시 묻지 않으면 창0 은 세션 생성 크기로 굳는다 — 전환한 창의 vi 가 깨진 원인). 그 갱신은
// 활성 창을 말하지 않아야 한다(Active=false).
//
//	TMUX_VM_HOST=<host> TMUX_VM_PASS=<pass> go test -tags integration -run TestVMResizeRefreshesInactiveWindowLayout -v ./internal/tmuxsession/
func TestVMResizeRefreshesInactiveWindowLayout(t *testing.T) {
	host := os.Getenv("TMUX_VM_HOST")
	pass := os.Getenv("TMUX_VM_PASS")
	if host == "" || pass == "" {
		t.Skip("set TMUX_VM_HOST and TMUX_VM_PASS")
	}
	user := envOr("TMUX_VM_USER", "ubuntu")
	bin := envOr("TMUX_BIN", "/usr/bin/tmux")
	const session = "lref"

	probe, err := sshconn.ProbeHostKey(
		context.Background(), host, 22, sshconn.JumpTargetFromCore(nil), nil, sshconn.DefaultConfig,
	)
	if err != nil {
		t.Fatalf("probe: %v", err)
	}

	var mu sync.Mutex
	var layouts []coretypes.TmuxLayoutChangePayload
	m := NewManager(
		func(ev coretypes.Event) {
			if ev.Type != coretypes.EventTmuxLayoutChange {
				return
			}
			if p, ok := ev.Payload.(coretypes.TmuxLayoutChangePayload); ok {
				mu.Lock()
				layouts = append(layouts, p)
				mu.Unlock()
			}
		},
		func(coretypes.StreamFrame, []byte) {},
	)
	payload := coretypes.ConnectPayload{
		Host: host, Port: 22, Username: user, AuthType: "password", Password: pass,
		TrustedHostKeyBase64: probe.PublicKeyBase64, Cols: 80, Rows: 24,
		// 세션 생성 크기(200x50)와 우리가 보고할 크기(162x59)를 다르게 둔다 — 같으면 굳은 값과 구분이 안 된다.
		Command: bin + " kill-session -t " + session + " 2>/dev/null; " +
			bin + " new-session -d -s " + session + " -x 200 -y 50 -n w0; " +
			bin + " new-window -t " + session + " -n w1; " +
			bin + " select-window -t " + session + ":1; " +
			"exec " + bin + " -CC attach -t " + session,
	}
	if err := m.Connect("c1", "r1", payload); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer func() {
		if h := m.getControl("c1"); h != nil && h.client != nil {
			_, _, _ = sshcmd.RunWithTimeout(h.client, bin+" kill-session -t "+session+" 2>/dev/null; true", 5*time.Second)
		}
		m.Disconnect("c1")
	}()
	time.Sleep(2 * time.Second) // attach + %window-add → 초기 list-windows 합성

	h := m.getControl("c1")
	if h == nil || h.client == nil {
		t.Fatalf("control handle 없음")
	}
	run := func(cmd string) string {
		out, stderr, err := sshcmd.RunWithTimeout(h.client, cmd, 5*time.Second)
		if err != nil {
			t.Fatalf("%s: %v (%s)", cmd, err, string(stderr))
		}
		return strings.TrimSpace(string(out))
	}
	win0 := run(bin + " display -p -t " + session + ":0 '#{window_id}'")
	if !strings.HasPrefix(win0, "@") {
		t.Fatalf("창0 id 가 이상하다: %q", win0)
	}

	mu.Lock()
	before, beforeCount := lastLayoutFor(layouts, win0)
	mu.Unlock()
	t.Logf("① attach 직후 비활성 창0(%s) 레이아웃=%q (이벤트 %d건)", win0, before.Layout, beforeCount)
	if beforeCount == 0 {
		t.Fatalf("attach 직후 창0 레이아웃이 한 번도 오지 않았다(초기 합성 실패)")
	}

	// 렌더러가 하듯 control-client 크기를 보고한다.
	if err := m.Resize("c1", 162, 59); err != nil {
		t.Fatalf("resize: %v", err)
	}
	time.Sleep(paneRestoreSettle + 2*time.Second)

	want := run(bin + " display -p -t " + session + ":0 '#{window_width}x#{window_height}'")
	mu.Lock()
	after, afterCount := lastLayoutFor(layouts, win0)
	mu.Unlock()
	t.Logf("② 리사이즈 뒤 창0 레이아웃=%q (이벤트 %d건) / tmux 실제=%s", after.Layout, afterCount, want)

	if layoutGeometry(before.Layout) == want {
		t.Fatalf("전제 깨짐: 초기 합성 격자(%s)가 이미 목표 크기라 재질의 효과를 구분할 수 없다", layoutGeometry(before.Layout))
	}
	if afterCount <= beforeCount {
		t.Fatalf("리사이즈 뒤 비활성 창0 의 레이아웃 갱신이 오지 않았다(%d→%d) — tmux 는 활성 창에만 보내므로 우리가 다시 물어야 한다", beforeCount, afterCount)
	}
	if got := layoutGeometry(after.Layout); got != want {
		t.Fatalf("비활성 창0 의 마지막 레이아웃 격자 %s 가 tmux 실제 %s 와 다르다 — 이 값으로 xterm 을 만들면 복원 화면이 어긋난다", got, want)
	}
	if after.Active {
		t.Fatalf("재질의 레이아웃이 활성 창을 말한다(Active=true) — 사용자의 창 선택을 되돌려 놓을 수 있다")
	}
}
