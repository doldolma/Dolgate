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

// 새 창·분할 pane 에는 렌더러가 **탭이 생기는 즉시** 설치를 요청한다 — 셸이 프롬프트를 그리기 전이다.
// 그때 코어는 프롬프트가 나타나길 기다리는데, 예전에는 "출력 꼬리가 `$ # % >` 로 끝나는가" 로 프롬프트를
// 알아봤다. zsh 의 RPROMPT(시각·git 브랜치)나 `λ` 같은 글자로 끝나는 프롬프트는 거기에 걸리지 않아
// 새 pane 은 영영 통합이 깔리지 않았다(첫 pane 은 프롬프트가 이미 그려진 뒤라 무사했다 — 그래서
// "첫 pane 만 된다" 로 보였다). tmux 에는 화면 상태라는 정답이 있으므로 모양을 맞히지 않고 그것을 묻는다.
//
// 원격에 파일을 쓰지 않고 프롬프트 모양을 바꾸기 위해 새 창에서 `PS1='\w λ ' bash --norc` 를 띄운다.
func TestVMNewPaneGetsShellIntegrationRegardlessOfPromptShape(t *testing.T) {
	host, pass := os.Getenv("TMUX_VM_HOST"), os.Getenv("TMUX_VM_PASS")
	if host == "" || pass == "" {
		t.Skip("set TMUX_VM_HOST and TMUX_VM_PASS")
	}
	user := envOr("TMUX_VM_USER", "ubuntu")
	bin := envOr("TMUX_BIN", "/usr/bin/tmux")
	hostKey, err := sshconn.ProbeHostKey(context.Background(), host, 22, sshconn.JumpTargetFromCore(nil), nil, sshconn.DefaultConfig)
	if err != nil {
		t.Fatalf("probe: %v", err)
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
	reset := func(k string) { mu.Lock(); streams[k] = &strings.Builder{}; mu.Unlock() }
	ask := func(cmd string) string {
		h := m.getControl("np1")
		if h == nil || h.client == nil {
			return "(no handle)"
		}
		out, _, _ := sshcmd.RunWithTimeout(h.client, cmd, 10*time.Second)
		return strings.TrimRight(string(out), "\n")
	}
	waitFor := func(k, needle string, limit time.Duration) bool {
		dl := time.Now().Add(limit)
		for time.Now().Before(dl) {
			if strings.Contains(read(k), needle) {
				return true
			}
			time.Sleep(100 * time.Millisecond)
		}
		return strings.Contains(read(k), needle)
	}
	if err := m.Connect("np1", "r1", coretypes.ConnectPayload{
		Host: host, Port: 22, Username: user, AuthType: "password", Password: pass,
		TrustedHostKeyBase64: hostKey.PublicKeyBase64, Cols: 100, Rows: 40,
		Command: bin + " kill-session -t dgnewpane 2>/dev/null; exec " + bin + " -CC new-session -s dgnewpane",
	}); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer m.Disconnect("np1")
	defer func() { ask(bin + " kill-session -t dgnewpane 2>/dev/null; true") }()
	time.Sleep(2500 * time.Millisecond)
	if firstPaneFor(streams, &mu, "np1") == "" {
		t.Fatalf("첫 pane 출력이 없다")
	}

	// 새 창의 셸: 휴리스틱 밖 글자(λ)로 끝나는 프롬프트. 렌더러처럼 **즉시** 설치를 요청한다.
	// `sleep 1` 은 실제 셸이 rc 를 읽는 시간의 대역이다 — 요청 시점에 프롬프트가 아직 없어야
	// (cx=0) 기다리는 경로를 탄다. 이것이 없으면 bash --norc 가 너무 빨라 직접 경로로 가 버린다.
	id := ask(bin + ` new-window -t dgnewpane -P -F '#{pane_id}' "sleep 1; PS1='\\w λ ' exec bash --norc"`)
	pane := "tmux:np1:" + strings.TrimPrefix(strings.TrimSpace(id), "%")
	num := strings.TrimPrefix(strings.TrimSpace(id), "%")
	if num == "" {
		t.Fatalf("새 창을 못 만들었다: %q", id)
	}
	reset(pane)
	before := ask(bin + " display-message -p -t '%" + num + "' '#{pane_current_command} cx=#{cursor_x}'")
	if err := m.InstallShellIntegration(pane); err != nil {
		t.Fatalf("install: %v", err)
	}
	if strings.Contains(before, "bash") && !strings.Contains(before, "cx=0") {
		t.Fatalf("전제 실패: 요청 시점에 이미 프롬프트가 있었다(%s) — 기다리는 경로를 재현하지 못한다", before)
	}
	t.Logf("설치 요청 시점 pane 상태: %s (프롬프트 전)", before)
	// 프롬프트가 그려지고(λ), 코어가 화면 상태를 확인해 심는다.
	time.Sleep(4 * time.Second)
	state := ask(bin + " display-message -p -t '%" + num + "' '#{pane_current_command} cx=#{cursor_x} alt=#{alternate_on} mode=#{pane_in_mode}'")
	screen := ask(bin + " capture-pane -p -t '%" + num + "'")
	if !strings.Contains(screen, "λ") {
		t.Fatalf("λ 프롬프트가 그려지지 않았다(상태 %s):\n%s", state, screen)
	}
	reset(pane)
	if err := m.WriteBytes(pane, []byte("echo DG-NEWPANE\n")); err != nil {
		t.Fatalf("echo: %v", err)
	}
	if !waitFor(pane, "\x1b]133;", 5*time.Second) {
		t.Fatalf("새 pane(λ 프롬프트)에 셸 통합이 깔리지 않았다 — OSC 133 마커가 없다(상태 %s)\n스트림: %q\n화면:\n%s",
			state, tail(read(pane), 300), ask(bin+" capture-pane -p -t '%"+num+"'"))
	}
	t.Logf("λ 프롬프트 새 pane: 통합 설치됨(상태 %s)", state)
}
