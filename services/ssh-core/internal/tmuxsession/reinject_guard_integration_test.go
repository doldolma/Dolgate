//go:build integration

package tmuxsession

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/autocomplete"
	"dolssh/services/ssh-core/internal/sshcmd"
	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// 서브셸 재주입의 위험 그대로. 렌더러가 서브셸 명령을 감지해 재주입을 무장했는데, 게이트가 "프롬프트"
// 로 본 꼬리가 실은 셸의 것이 아니다.
//
// 게이트는 꼬리 글자 모양(`$ # % >` 로 끝남)만 본다. 그래서 (A) vi 안에서 사용자가 친 글자가 그렇게
// 끝나거나, (B) 사용자가 tmux copy-mode 로 스크롤백을 보는 동안 진짜 프롬프트가 도착하면 게이트는
// 터진다 — 예전에는 그 자리에 프로브를 타이핑했다(vi 버퍼에 `printf '\033]1337;…'` 가 들어가거나,
// copy-mode 가 키를 먹었다). 타이핑 직전에 pane 화면(대체화면·copy-mode)을 보고 포기해야 한다.
//
// 대조군으로, 프롬프트에 있는 bash 에는 그대로 들어가야 한다 — 가드가 과잉 방어면 재주입이 죽는다.
func TestVMReinjectGivesUpWhenTheScreenIsNotAtAPrompt(t *testing.T) {
	host := os.Getenv("TMUX_VM_HOST")
	pass := os.Getenv("TMUX_VM_PASS")
	if host == "" || pass == "" {
		t.Skip("set TMUX_VM_HOST and TMUX_VM_PASS")
	}
	user := envOr("TMUX_VM_USER", "ubuntu")
	bin := envOr("TMUX_BIN", "/usr/bin/tmux")
	const cols, rows = 100, 40

	hostKey, err := sshconn.ProbeHostKey(
		context.Background(), host, 22, sshconn.JumpTargetFromCore(nil), nil, sshconn.DefaultConfig,
	)
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
	read := func(key string) string {
		mu.Lock()
		defer mu.Unlock()
		if streams[key] == nil {
			return ""
		}
		return streams[key].String()
	}
	reset := func(key string) {
		mu.Lock()
		defer mu.Unlock()
		streams[key] = &strings.Builder{}
	}
	ask := func(command string) string {
		handle := m.getControl("g1")
		if handle == nil || handle.client == nil {
			return "(control 핸들 없음)"
		}
		stdout, _, _ := sshcmd.RunWithTimeout(handle.client, command, 10*time.Second)
		return strings.TrimRight(string(stdout), "\n")
	}
	waitFor := func(key, needle string, limit time.Duration) bool {
		deadline := time.Now().Add(limit)
		for time.Now().Before(deadline) {
			if strings.Contains(read(key), needle) {
				return true
			}
			time.Sleep(100 * time.Millisecond)
		}
		return strings.Contains(read(key), needle)
	}
	// 프로브·스크립트가 타이핑됐다면 pane 버퍼에 남는 글자들.
	forbidden := []string{"dg-shell", "1337", "printf", "__ds_o", "BASH_VERSION"}

	payload := coretypes.ConnectPayload{
		Host: host, Port: 22, Username: user, AuthType: "password", Password: pass,
		TrustedHostKeyBase64: hostKey.PublicKeyBase64, Cols: cols, Rows: rows,
		Command: bin + " kill-session -t dgreinj 2>/dev/null; exec " + bin + " -CC new-session -s dgreinj",
	}
	if err := m.Connect("g1", "r1", payload); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer m.Disconnect("g1")
	time.Sleep(2 * time.Second)
	pane := firstPaneFor(streams, &mu, "g1")
	if pane == "" {
		t.Fatalf("pane 출력이 없다")
	}
	paneNum := pane[strings.LastIndex(pane, ":")+1:]
	target := "'%" + paneNum + "'"
	state := func() string {
		return ask(bin + " display-message -p -t " + target + " '#{pane_current_command} #{alternate_on} #{pane_in_mode}'")
	}
	defer func() {
		ask(bin + " send-keys -t " + target + " -X cancel 2>/dev/null; true")
		_ = m.WriteBytes(pane, []byte("\x1b:q!\n"))
		time.Sleep(500 * time.Millisecond)
		ask(bin + " kill-session -t dgreinj 2>/dev/null; true")
	}()

	// ── (A) 대체화면. 재주입을 무장한 뒤 떠오른 것은 vi 이고, 사용자가 곧바로 편집을 시작한다.
	t.Run("A 대체화면(vi)", func(t *testing.T) {
		reset(pane)
		if err := m.ReinjectShellIntegration(pane, ""); err != nil {
			t.Fatalf("reinject: %v", err)
		}
		// `-u NONE`: 배포판 defaults.vim 이 켜는 ruler 가 글자를 칠 때마다 "1,13" 을 화면 끝에 다시
		// 그려 꼬리를 덮는다 — 그러면 게이트가 프롬프트로 볼 꼬리가 만들어지지 않아 가드에 닿지 못한다.
		if err := m.WriteBytes(pane, []byte("vi -u NONE\n")); err != nil {
			t.Fatalf("vi: %v", err)
		}
		time.Sleep(1500 * time.Millisecond)
		if st := state(); !strings.HasPrefix(st, "vi 1 ") {
			t.Fatalf("vi 가 대체화면에 떠 있어야 하는데: %q", st)
		}
		// INSERT 로 들어가 vi 가 인트로를 지우고 다시 그리기를 끝낸 뒤, 마침 프롬프트처럼 끝나는 글자를
		// 친다 — 그 에코가 출력의 꼬리가 되고, 게이트는 그것을 프롬프트로 본다.
		if err := m.WriteBytes(pane, []byte("i")); err != nil {
			t.Fatalf("insert mode: %v", err)
		}
		time.Sleep(1 * time.Second)
		if err := m.WriteBytes(pane, []byte("root@box:/# ")); err != nil {
			t.Fatalf("insert: %v", err)
		}
		if !waitFor(pane, autocomplete.CommandFinishedMarker, 10*time.Second) {
			t.Fatalf("정착 뒤 포기 마커가 오지 않았다: %q", tail(read(pane), 300))
		}
		time.Sleep(1500 * time.Millisecond) // 프로브가 늦게 나갔다면 지금쯤 화면에 있다
		screen := ask(bin + " capture-pane -p -t " + target)
		if !strings.Contains(screen, "root@box:/#") {
			t.Fatalf("하네스가 친 글자가 vi 에 없다 — 테스트 자체가 vi 에 닿지 않았다:\n%s", screen)
		}
		for _, word := range forbidden {
			if strings.Contains(screen, word) {
				t.Fatalf("vi 에 재주입 프로브/스크립트가 타이핑됐다(%q):\n%s", word, screen)
			}
		}
		t.Logf("vi 가 앞에 있을 때: 타이핑 없음, 실행 중 블록 닫힘")
	})
	if err := m.WriteBytes(pane, []byte("\x1b:q!\n")); err != nil {
		t.Fatalf("quit vi: %v", err)
	}
	time.Sleep(1500 * time.Millisecond)
	if st := state(); !strings.HasPrefix(st, "bash 0 0") {
		t.Fatalf("bash 프롬프트로 돌아와야 하는데: %q", st)
	}

	// ── (B) copy-mode. tmux(3.0a 실측)는 copy-mode 인 pane 의 출력을 control 클라이언트에 보내지
	// 않으므로, 이미 copy-mode 인 pane 에서는 게이트가 정착할 수 없다(타임아웃으로 조용히 끝남). 위험한
	// 것은 **경합**이다: 프롬프트가 도착해 정착 타이머(400ms)가 도는 사이 사용자가 prefix-[ 를 누른다 —
	// 정착은 터지고, 가드가 없으면 프로브가 copy-mode 로 들어간다. 그 창 안에서 copy-mode 에 들어간다.
	t.Run("B copy-mode 경합", func(t *testing.T) {
		reset(pane)
		if err := m.ReinjectShellIntegration(pane, ""); err != nil {
			t.Fatalf("reinject: %v", err)
		}
		if err := m.WriteBytes(pane, []byte("\n")); err != nil {
			t.Fatalf("enter: %v", err)
		}
		var promptSeen time.Time
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
			if strings.Contains(read(pane), "$ ") {
				promptSeen = time.Now()
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		if promptSeen.IsZero() {
			t.Fatalf("프롬프트가 오지 않았다: %q", tail(read(pane), 200))
		}
		ask(bin + " copy-mode -t " + target)
		entered := time.Since(promptSeen)
		if st := state(); !strings.HasSuffix(st, " 1") {
			t.Fatalf("copy-mode 에 들어가야 하는데: %q", st)
		}
		if entered > 300*time.Millisecond {
			t.Skipf("copy-mode 진입이 %v 걸려 정착 창(400ms) 안에 들지 못했다 — 이 실행에서는 경합을 재현할 수 없다", entered)
		}
		if !waitFor(pane, autocomplete.CommandFinishedMarker, 5*time.Second) {
			t.Fatalf("정착 뒤 포기 마커가 오지 않았다(copy-mode 진입 %v): %q", entered, tail(read(pane), 300))
		}
		time.Sleep(1500 * time.Millisecond)
		// 키가 copy-mode 로 갔다면 모드가 풀리거나 선택이 생긴다. 여전히 copy-mode 여야 한다.
		if st := state(); !strings.HasSuffix(st, " 1") {
			t.Fatalf("copy-mode 가 풀렸다 — 키가 copy-mode 로 들어갔다: %q", st)
		}
		ask(bin + " send-keys -t " + target + " -X cancel")
		time.Sleep(500 * time.Millisecond)
		screen := ask(bin + " capture-pane -p -t " + target)
		for _, word := range forbidden {
			if strings.Contains(screen, word) {
				t.Fatalf("copy-mode 인 pane 에 타이핑됐다(%q):\n%s", word, screen)
			}
		}
		t.Logf("copy-mode 경합(진입 %v): 타이핑 없음, 실행 중 블록 닫힘", entered)
	})
	ask(bin + " send-keys -t " + target + " -X cancel 2>/dev/null; true")
	time.Sleep(500 * time.Millisecond)
	if st := state(); !strings.HasPrefix(st, "bash 0 0") {
		t.Fatalf("copy-mode 를 빠져나와야 하는데: %q", st)
	}

	// ── (C) 대조군. 프롬프트에 있는 bash 에는 그대로 심어진다.
	t.Run("C bash 프롬프트에는 심는다", func(t *testing.T) {
		reset(pane)
		if err := m.ReinjectShellIntegration(pane, ""); err != nil {
			t.Fatalf("reinject: %v", err)
		}
		if err := m.WriteBytes(pane, []byte("\n")); err != nil {
			t.Fatalf("enter: %v", err)
		}
		time.Sleep(5 * time.Second)
		if strings.Contains(read(pane), autocomplete.CommandFinishedMarker) {
			t.Fatalf("프롬프트에 있는 bash 인데 가드가 포기했다(과잉 방어): %q", tail(read(pane), 300))
		}
		reset(pane)
		if err := m.WriteBytes(pane, []byte("echo DG-REINJ\n")); err != nil {
			t.Fatalf("echo: %v", err)
		}
		if !waitFor(pane, "\x1b]133;", 5*time.Second) {
			t.Fatalf("프롬프트의 bash 에 재주입이 되지 않았다 — OSC 133 마커가 없다: %q", tail(read(pane), 300))
		}
		t.Logf("bash 프롬프트일 때: 재주입되어 OSC 133 마커 도착")
	})
}
