//go:build integration

package tmuxsession

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/sshcmd"
	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// 코어의 복원 바이트가 **어느 크기의 xterm 에 떨어지느냐**가 화면을 결정한다는 것을 실측으로 못
// 박는다. 실제 vi 를 좌우 분할에 띄우고 재연결한 뒤, 같은 바이트를 세 방식으로 xterm.js 에 먹인다:
//
//	(A) 처음부터 pane 크기            — 코어가 옳다면 tmux 와 글자 단위로 같아야 한다(단정)
//	(B) xterm.js 기본 80x24 뒤 리사이즈 — 렌더러가 레이아웃 전에 xterm 을 만들었을 때. 대체화면은
//	    스크롤백이 없어 24행을 넘은 줄이 영영 사라진다 → 1행이 `~` 가 된다(사용자가 본 화면)
//	(C) 씨앗 120x32 뒤 리사이즈         — 같은 이유로 깨진다
//
// (B)(C)는 **렌더러 버그의 모양을 기록**하는 것이고 코어 실패가 아니다. 렌더러는 tmux pane 의
// xterm 을 레이아웃 칸 수를 알기 전엔 만들지 않아야 하며, 그 규칙은 useTerminalSessionViewController
// 의 테스트("레이아웃이 마운트보다 늦어도 …")가 지킨다. 여기서는 (A)만 단정하고 (B)(C)는 로그로
// 남겨, 언젠가 (B)가 "일치"로 바뀌면(xterm.js 가 리사이즈 시 대체화면을 되살리게 되면) 알아챈다.
func TestVMReattachRestoreBytesAreSizeSensitive(t *testing.T) {
	host, pass := os.Getenv("TMUX_VM_HOST"), os.Getenv("TMUX_VM_PASS")
	if host == "" || pass == "" {
		t.Skip("no creds")
	}
	user := envOr("TMUX_VM_USER", "ubuntu")
	bin := envOr("TMUX_BIN", "/usr/bin/tmux")

	hk, err := sshconn.ProbeHostKey(context.Background(), host, 22, sshconn.JumpTargetFromCore(nil), nil, sshconn.DefaultConfig)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	streams := map[string]*strings.Builder{}
	m := NewManager(func(coretypes.Event) {}, func(f coretypes.StreamFrame, d []byte) {
		mu.Lock()
		if streams[f.SessionID] == nil {
			streams[f.SessionID] = &strings.Builder{}
		}
		streams[f.SessionID].Write(d)
		mu.Unlock()
	})
	read := func(k string) string {
		mu.Lock()
		defer mu.Unlock()
		if streams[k] == nil {
			return ""
		}
		return streams[k].String()
	}
	reset := func(k string) { mu.Lock(); defer mu.Unlock(); streams[k] = &strings.Builder{} }
	base := coretypes.ConnectPayload{Host: host, Port: 22, Username: user, AuthType: "password", Password: pass, TrustedHostKeyBase64: hk.PublicKeyBase64, Cols: 200, Rows: 50}
	ask := func(id, c string) string {
		h := m.getControl(id)
		if h == nil || h.client == nil {
			return "(no handle)"
		}
		o, _, _ := sshcmd.RunWithTimeout(h.client, c, 10*time.Second)
		return strings.TrimRight(string(o), "\n")
	}

	first := base
	first.Command = bin + " kill-session -t dgvit 2>/dev/null; exec " + bin + " -CC new-session -x 200 -y 50 -s dgvit"
	if err := m.Connect("a1", "r1", first); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Second)
	left := firstPaneFor(streams, &mu, "a1")
	leftNum := left[strings.LastIndex(left, ":")+1:]
	// 좌우 분할: 왼쪽 vi(INSERT+글자), 오른쪽 bash.
	m.WriteBytes(left, []byte("vi\n"))
	time.Sleep(1200 * time.Millisecond)
	m.WriteBytes(left, []byte("iHELLO-VI-LINE1\rSECOND-LINE"))
	time.Sleep(1000 * time.Millisecond)
	ask("a1", bin+" split-window -h -t '%"+leftNum+"'")
	time.Sleep(1500 * time.Millisecond)
	panes := strings.Fields(ask("a1", bin+" list-panes -s -t dgvit -F '#{pane_id}'"))
	if len(panes) != 2 {
		t.Fatalf("panes=%v", panes)
	}
	m.Disconnect("a1")
	time.Sleep(1 * time.Second)

	second := base
	second.Command = bin + " -CC attach -t dgvit"
	if err := m.Connect("a2", "r2", second); err != nil {
		t.Fatal(err)
	}
	defer m.Disconnect("a2")
	defer func() { ask("a2", bin+" kill-session -t dgvit 2>/dev/null; true") }()
	time.Sleep(2 * time.Second)
	pane2 := "tmux:a2:" + leftNum
	reset(pane2)
	// 렌더러처럼 pane 마다 Resize.
	for _, p := range panes {
		m.Resize("tmux:a2:"+strings.TrimPrefix(p, "%"), 200, 50)
	}
	restored := ""
	for dl := time.Now().Add(15 * time.Second); time.Now().Before(dl); {
		if restored = read(pane2); strings.Contains(restored, "HELLO-VI-LINE1") {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if restored == "" {
		t.Fatal("복원 없음")
	}

	pw := paneFlagInt(ask("a2", bin+" display-message -p -t '%"+leftNum+"' '#{pane_width}'"))
	ph := paneFlagInt(ask("a2", bin+" display-message -p -t '%"+leftNum+"' '#{pane_height}'"))
	tmuxAlt := strings.Split(strings.TrimSuffix(ask("a2", bin+" capture-pane -p -t '%"+leftNum+"'"), "\n"), "\n")
	for i := range tmuxAlt {
		tmuxAlt[i] = strings.TrimRight(tmuxAlt[i], " \t\r")
	}
	for len(tmuxAlt) > 0 && tmuxAlt[len(tmuxAlt)-1] == "" {
		tmuxAlt = tmuxAlt[:len(tmuxAlt)-1]
	}
	t.Logf("vi pane 크기=%dx%d, tmux 1행=%q 마지막=%q", pw, ph, tmuxAlt[0], tmuxAlt[len(tmuxAlt)-1])

	render := func(ic, ir int) []string {
		dir := t.TempDir()
		f := filepath.Join(dir, "b.bin")
		os.WriteFile(f, []byte(restored), 0o600)
		out2, err := exec.Command("node", filepath.Join("testdata", "render-screen.cjs"), f, itoa(pw), itoa(ph), itoa(ic), itoa(ir)).Output()
		if err != nil {
			t.Fatalf("render: %v %s", err, out2)
		}
		var s struct {
			Rows []string `json:"rows"`
		}
		json.Unmarshal(out2, &s)
		for len(s.Rows) > 0 && strings.TrimSpace(s.Rows[len(s.Rows)-1]) == "" {
			s.Rows = s.Rows[:len(s.Rows)-1]
		}
		return s.Rows
	}
	// 양쪽을 같은 기준으로 맞춘다 — vi 는 줄 끝을 공백으로 채우기도(그러면 xterm 셀에 공백이
	// 써져 translateToString 이 남긴다), 지우기(EL)로 비우기도 한다. 둘은 사용자 화면의 차이가
	// 아니다. compareScreens 와 같은 정규화다.
	eq := func(a []string) string {
		a = normalizeScreen(a)
		if strings.Join(a, "\n") == strings.Join(tmuxAlt, "\n") {
			return "일치"
		}
		mism := 0
		n := len(a)
		if len(tmuxAlt) < n {
			n = len(tmuxAlt)
		}
		for i := 0; i < n; i++ {
			if a[i] != tmuxAlt[i] {
				mism++
			}
		}
		return "불일치(" + itoa(mism) + "행" + ", xterm " + itoa(len(a)) + "행/tmux " + itoa(len(tmuxAlt)) + "행) 1행=" + quoteShort(firstNon(a))
	}
	if verdict := eq(render(pw, ph)); verdict != "일치" {
		t.Errorf("[코어] pane 크기 그대로 렌더링했는데 tmux 와 다르다: %s", verdict)
	} else {
		t.Logf("(A) 처음부터 %dx%d → 일치", pw, ph)
	}
	t.Logf("(B) 80x24 뒤 리사이즈  → %s  ← 렌더러가 레이아웃 전에 만들면 이렇게 깨진다", eq(render(80, 24)))
	t.Logf("(C) 120x32 뒤 리사이즈 → %s", eq(render(120, 32)))
}

func quoteShort(s string) string {
	if len(s) > 50 {
		s = s[:50]
	}
	return "\"" + s + "\""
}
func firstNon(rows []string) string {
	for _, r := range rows {
		if strings.TrimSpace(r) != "" {
			return strings.TrimRight(r, " ")
		}
	}
	return ""
}
