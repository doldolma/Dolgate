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

// 이 테스트가 재는 것은 하나다: **재연결한 뒤 사용자가 보는 화면이 tmux 의 pane 과 같은가.**
//
// 왜 이렇게까지 하는가. 이 문제를 두 번 고쳤다고 하고 두 번 다 실기기에서 더 망가뜨렸다.
// 원인은 늘 같았다 — Go 단위 테스트는 "우리가 만든 바이트" 만 보고 그 바이트가 터미널에서
// 무엇이 되는지는 보지 않는다. 그래서 여기서는 실제 tmux 서버에 붙어, 우리 코어가 내보낸
// 바이트를 **데스크톱과 같은 xterm.js** 에 먹여 화면을 만들고, 그 화면을 tmux 가 말하는
// pane 내용과 글자 단위로 대조한다.
//
// 실행:
//
//	TMUX_VM_HOST=<host> TMUX_VM_PASS=<pass> TMUX_VM_USER=ubuntu TMUX_BIN=/usr/bin/tmux \
//	  go test -tags integration -run TestVMReattachRestoresTheScreen -v ./internal/tmuxsession/

// fullScreenAppScript 는 htop·vim 대신 쓰는 **결정적인** 전체화면 앱이다.
//
// 실제 htop 을 쓰면 설치 여부·버전·갱신 주기(시계가 매초 바뀐다)에 따라 대조가 흔들린다.
// 이 스크립트는 htop 이 하는 것 중 우리가 신경 쓰는 것만 정확히 하고 그대로 멈춰 있다:
// 주 화면에 흔적을 남기고, 대체화면으로 들어가고, 마우스 보고를 켜고, 표식을 그린다.
//
// 대기를 `sleep` 이 아니라 `read` 내장으로 하는 이유: 신호·포그라운드 프로세스 그룹 문제로
// `sleep` 을 쓰면 bash 가 포그라운드에서 빠져 pane_current_command 가 sleep 으로 보인다.
var fullScreenAppScript = "for i in 1 2 3; do echo DG-NORMAL-$i; done; " +
	"printf '\\033[?1049h\\033[?1000h\\033[?1006h\\033[2J" +
	"\\033[2;3HDG-ALPHA-ROW2\\033[4;5HDG-BETA-ROW4\\033[6;1HDG-GAMMA-ROW6" +
	// 10행은 폭(80)을 꽉 채운다 — 우리 xterm 이 한 칸이라도 좁을 때 감기지 않는지 재는 재료.
	"\\033[10;1H" + strings.Repeat("=", 80) + "\\033[12;1HDG-BELOW-FULL-ROW\\033[8;11H'; " +
	"while :; do read -t 1 -r _ || true; done\n"

// renderedScreen 은 xterm.js 가 우리 바이트로 만든 화면이다(testdata/render-screen.cjs).
type renderedScreen struct {
	Type              string   `json:"type"`
	CursorX           int      `json:"cursorX"`
	CursorY           int      `json:"cursorY"`
	Rows              []string `json:"rows"`
	NormalRows        []string `json:"normalRows"`
	MouseTrackingMode string   `json:"mouseTrackingMode"`
}

func TestVMReattachRestoresTheScreen(t *testing.T) {
	host := os.Getenv("TMUX_VM_HOST")
	pass := os.Getenv("TMUX_VM_PASS")
	if host == "" || pass == "" {
		t.Skip("set TMUX_VM_HOST and TMUX_VM_PASS")
	}
	user := envOr("TMUX_VM_USER", "ubuntu")
	bin := envOr("TMUX_BIN", "/usr/bin/tmux")
	const cols, rows = 80, 24

	hostKey, err := sshconn.ProbeHostKey(
		context.Background(), host, 22, sshconn.JumpTargetFromCore(nil), nil, sshconn.DefaultConfig,
	)
	if err != nil {
		t.Fatalf("probe: %v", err)
	}

	var mu sync.Mutex
	streams := map[string]*strings.Builder{}
	m := NewManager(
		func(coretypes.Event) {},
		func(f coretypes.StreamFrame, d []byte) {
			mu.Lock()
			if streams[f.SessionID] == nil {
				streams[f.SessionID] = &strings.Builder{}
			}
			streams[f.SessionID].Write(d)
			mu.Unlock()
		},
	)
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
	ask := func(controlID, command string) string {
		handle := m.getControl(controlID)
		if handle == nil || handle.client == nil {
			return "(control 핸들 없음)"
		}
		stdout, stderr, err := sshcmd.RunWithTimeout(handle.client, command, 10*time.Second)
		if err != nil {
			return "err=" + err.Error() + " stderr=" + strings.TrimSpace(string(stderr))
		}
		return strings.TrimRight(string(stdout), "\n")
	}

	base := coretypes.ConnectPayload{
		Host: host, Port: 22, Username: user, AuthType: "password", Password: pass,
		TrustedHostKeyBase64: hostKey.PublicKeyBase64, Cols: cols, Rows: rows,
	}

	// ── 1) 새 세션에서 전체화면 앱을 띄운다.
	first := base
	first.Command = bin + " kill-session -t dgscreen 2>/dev/null; exec " +
		bin + " -CC new-session -s dgscreen"
	if err := m.Connect("s1", "r1", first); err != nil {
		t.Fatalf("connect1: %v", err)
	}
	time.Sleep(2 * time.Second)

	pane1 := firstPaneFor(streams, &mu, "s1")
	if pane1 == "" {
		t.Fatalf("첫 연결에서 pane 출력이 없다")
	}
	paneNum := pane1[strings.LastIndex(pane1, ":")+1:]
	if err := m.WriteBytes(pane1, []byte(fullScreenAppScript)); err != nil {
		t.Fatalf("앱 실행 입력: %v", err)
	}
	time.Sleep(2500 * time.Millisecond)

	live := read(pane1)
	for _, want := range []string{"\x1b[?1049h", "\x1b[?1000h", "DG-ALPHA-ROW2"} {
		if !strings.Contains(live, want) {
			t.Fatalf("픽스처가 %q 를 내지 않았다 — 앱이 안 떴다: %q", want, tail(live, 300))
		}
	}
	t.Logf("① 첫 연결 OK (pane=%s)", pane1)

	m.Disconnect("s1")
	time.Sleep(1 * time.Second)

	// ── 2) 재연결. 앱은 그대로 살아 있다.
	second := base
	second.Command = bin + " -CC attach -t dgscreen"
	if err := m.Connect("s2", "r2", second); err != nil {
		t.Fatalf("connect2: %v", err)
	}
	defer m.Disconnect("s2")
	defer func() { ask("s2", bin+" kill-session -t dgscreen 2>/dev/null; true") }()
	pane2 := "tmux:s2:" + paneNum
	time.Sleep(2 * time.Second)

	// attach 만으로는 tmux 가 아무것도 주지 않는다 — 이 고침이 필요한 이유다.
	if before := read(pane2); before != "" {
		t.Errorf("[전제] attach 만으로 출력이 왔다(%d 바이트) — tmux 가 화면을 재생하기 시작했다면"+
			" 복원을 다시 검토해야 한다: %q", len(before), tail(before, 200))
	}
	t.Logf("② 재연결 — attach 만으로는 스트림 0 바이트(예상대로)")

	// ── 3) 렌더러의 첫 리사이즈가 복원의 계기다.
	reset(pane2)
	if err := m.Resize(pane2, cols, rows); err != nil {
		t.Fatalf("첫 리사이즈: %v", err)
	}
	restored := ""
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); {
		if restored = read(pane2); strings.Contains(restored, "DG-ALPHA-ROW2") {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Logf("③ 복원 스트림 %d 바이트", len(restored))
	if restored == "" {
		t.Fatalf("복원이 아무것도 내보내지 않았다")
	}

	// ── 4) tmux 가 말하는 pane 과 사용자가 보게 될 화면을 대조한다.
	tmuxAlt := splitTrimmed(ask("s2", bin+" capture-pane -p -t '%"+paneNum+"'"))
	tmuxNormal := splitTrimmed(ask("s2", bin+" capture-pane -p -a -t '%"+paneNum+"'"))
	tmuxCursor := ask("s2", bin+" display-message -p -t '%"+paneNum+"' '#{cursor_x},#{cursor_y}'")

	screen := renderRestoredScreen(t, restored, cols, rows)
	t.Logf("   xterm 화면 종류=%s 커서=(%d,%d) / tmux 커서=%s",
		screen.Type, screen.CursorX, screen.CursorY, tmuxCursor)

	if screen.Type != "alternate" {
		t.Errorf("[대체화면] xterm 이 대체화면에 있지 않다(%q) — 앱 화면이 주 화면을 덮으면"+
			" 앱을 끄는 순간 사용자의 스크롤백이 사라진다", screen.Type)
	}
	compareScreens(t, "대체화면", screen.Rows, tmuxAlt)
	compareScreens(t, "주 화면", screen.NormalRows, tmuxNormal)

	if got := itoa(screen.CursorX) + "," + itoa(screen.CursorY); got != tmuxCursor {
		t.Errorf("[커서] xterm=(%s) tmux=(%s)", got, tmuxCursor)
	}
	for _, want := range []struct{ seq, what string }{
		{"\x1b[?1000h", "마우스 보고(?1000h) — 없으면 htop 클릭이 죽는다"},
		{"\x1b[?1006h", "SGR 마우스(?1006h) — 없으면 95열 넘는 클릭이 깨진다"},
	} {
		if !strings.Contains(restored, want.seq) {
			t.Errorf("[모드] %s 가 복원되지 않았다", want.what)
		}
	}
	// 바이트가 나갔다는 것과 터미널이 그 상태가 됐다는 것은 다르다 — xterm 의 실제 모드를 본다.
	if screen.MouseTrackingMode == "" || screen.MouseTrackingMode == "none" {
		t.Errorf("[모드] xterm 의 마우스 추적이 켜지지 않았다(%q)", screen.MouseTrackingMode)
	}

	// ── 5) **우리 xterm 이 pane 보다 좁을 때.** 두 폭은 서로 다른 계산에서 나와 한두 칸 어긋난다.
	// 그때 폭을 꽉 채운 줄이 감기면 두 줄을 먹고 아래가 전부 밀려 맨 위가 잘린다(실기기에서
	// 그렇게 깨존 것이 이것이다). 좁게 렌더링해도 행은 행대로, 넘치는 칸만 잘려야 한다.
	narrow := renderRestoredScreen(t, restored, cols-2, rows)
	compareScreensTruncated(t, "좁은 xterm(대체화면)", narrow.Rows, tmuxAlt, cols-2)
	if narrow.Type != "alternate" {
		t.Errorf("[좁은 xterm] 대체화면이 아니다(%q)", narrow.Type)
	}
}

// compareScreensTruncated 는 xterm 이 pane 보다 좁을 때의 기대치 — 각 행이 그 폭에서 잘린
// 것 — 와 대조한다. 행이 밀렸으면(감김) 여기서 바로 드러난다.
func compareScreensTruncated(t *testing.T, what string, got, want []string, width int) {
	t.Helper()
	cut := make([]string, len(want))
	for i, line := range want {
		runes := []rune(line)
		if len(runes) > width {
			runes = runes[:width]
		}
		cut[i] = string(runes)
	}
	compareScreens(t, what, got, cut)
}

// compareScreens 는 화면을 줄 단위로 대조하고 어긋난 곳을 그대로 보여 준다.
//
// 양쪽을 같은 기준으로 맞춘 뒤 본다. capture-pane 은 줄 끝 공백과 뒤쪽 빈 줄을 걷어내고,
// xterm 은 셀에 실제로 써진 공백은 남긴다 — 그 차이는 사용자가 보는 화면의 차이가 아니다.
func compareScreens(t *testing.T, what string, got, want []string) {
	t.Helper()
	got = normalizeScreen(got)
	want = normalizeScreen(want)
	limit := min(len(got), len(want))
	mismatches := 0
	for i := 0; i < limit; i++ {
		if got[i] != want[i] {
			mismatches++
			if mismatches <= 5 {
				t.Errorf("[%s] %d행이 다르다\n  xterm: %q\n  tmux : %q", what, i+1, got[i], want[i])
			}
		}
	}
	if len(got) != len(want) {
		t.Errorf("[%s] 줄 수가 다르다: xterm %d, tmux %d", what, len(got), len(want))
	}
	if mismatches > 5 {
		t.Errorf("[%s] 어긋난 줄 %d개(앞 5개만 표시)", what, mismatches)
	}
	if mismatches == 0 && len(got) == len(want) {
		t.Logf("   [%s] %d행 전부 일치", what, len(want))
	}
}

// renderRestoredScreen 은 복원 바이트를 xterm.js 에 먹여 화면을 받아 온다.
func renderRestoredScreen(t *testing.T, stream string, cols, rows int) renderedScreen {
	t.Helper()
	return renderRestoredScreenFrom(t, stream, cols, rows, cols, rows)
}

// renderRestoredScreenFrom 은 initCols x initRows 의 xterm 에 먼저 재생한 뒤 cols x rows 로
// 리사이즈한 화면을 받아 온다 — 렌더러가 씨앗 크기일 때 바이트가 도착하는 경로다.
func renderRestoredScreenFrom(t *testing.T, stream string, cols, rows, initCols, initRows int) renderedScreen {
	t.Helper()
	path := filepath.Join(t.TempDir(), "restore.bin")
	if err := os.WriteFile(path, []byte(stream), 0o600); err != nil {
		t.Fatalf("바이트 저장: %v", err)
	}
	script := filepath.Join("testdata", "render-screen.cjs")
	out, err := exec.Command("node", script, path, itoa(cols), itoa(rows), itoa(initCols), itoa(initRows)).Output()
	if err != nil {
		t.Fatalf("xterm 렌더 실패: %v (출력 %q)", err, string(out))
	}
	var screen renderedScreen
	if err := json.Unmarshal(out, &screen); err != nil {
		t.Fatalf("렌더 결과 파싱: %v (%q)", err, string(out))
	}
	return screen
}

// splitTrimmed 는 capture-pane 출력을 줄로 나눈다.
func splitTrimmed(text string) []string {
	return strings.Split(strings.TrimSuffix(text, "\n"), "\n")
}

// normalizeScreen 은 줄 끝 공백과 뒤쪽 빈 줄을 걷어낸다.
func normalizeScreen(lines []string) []string {
	out := make([]string, len(lines))
	for i, line := range lines {
		out[i] = strings.TrimRight(line, " \t\r")
	}
	for len(out) > 0 && out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	return out
}

// itoa 는 진단 로그용 작은 도우미다.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

// 셸 pane 재연결. 이것이 사용자 화면을 실제로 더럽혔던 경로다.
//
// 예전에는 재연결마다 셸 통합을 다시 심었다. pane 의 셸은 같은 프로세스라 훅이 이미 있는데도.
// 그 재주입의 init 이 셸에 타이핑되고 그 에코가 tmux 의 pane 버퍼에 남아, 화면 복원이 그것을
// 그대로 떠서 영구히 굳혔다 — 사용자는 프롬프트 아래에 셸 스크립트 전문이 박힌 화면을 봤다.
//
// 지금은 심을 때 tmux 서버의 pane 옵션(@dolgate_integrated)에 표식을 남기고, 재연결에서
// 그것을 보면 다시 심지 않는다.
func TestVMReattachDoesNotReinstallShellIntegration(t *testing.T) {
	host := os.Getenv("TMUX_VM_HOST")
	pass := os.Getenv("TMUX_VM_PASS")
	if host == "" || pass == "" {
		t.Skip("set TMUX_VM_HOST and TMUX_VM_PASS")
	}
	user := envOr("TMUX_VM_USER", "ubuntu")
	bin := envOr("TMUX_BIN", "/usr/bin/tmux")
	const cols, rows = 80, 24

	hostKey, err := sshconn.ProbeHostKey(
		context.Background(), host, 22, sshconn.JumpTargetFromCore(nil), nil, sshconn.DefaultConfig,
	)
	if err != nil {
		t.Fatalf("probe: %v", err)
	}

	var mu sync.Mutex
	streams := map[string]*strings.Builder{}
	m := NewManager(
		func(coretypes.Event) {},
		func(f coretypes.StreamFrame, d []byte) {
			mu.Lock()
			if streams[f.SessionID] == nil {
				streams[f.SessionID] = &strings.Builder{}
			}
			streams[f.SessionID].Write(d)
			mu.Unlock()
		},
	)
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
	ask := func(controlID, command string) string {
		handle := m.getControl(controlID)
		if handle == nil || handle.client == nil {
			return "(control 핸들 없음)"
		}
		stdout, stderr, err := sshcmd.RunWithTimeout(handle.client, command, 10*time.Second)
		if err != nil {
			return "err=" + err.Error() + " stderr=" + strings.TrimSpace(string(stderr))
		}
		return strings.TrimRight(string(stdout), "\n")
	}

	base := coretypes.ConnectPayload{
		Host: host, Port: 22, Username: user, AuthType: "password", Password: pass,
		TrustedHostKeyBase64: hostKey.PublicKeyBase64, Cols: cols, Rows: rows,
	}

	// ── 1) 새 세션. 프롬프트에 있는 셸에 통합을 심는다.
	first := base
	first.Command = bin + " kill-session -t dgshell 2>/dev/null; exec " +
		bin + " -CC new-session -s dgshell"
	if err := m.Connect("t1", "r1", first); err != nil {
		t.Fatalf("connect1: %v", err)
	}
	time.Sleep(2 * time.Second)
	pane1 := firstPaneFor(streams, &mu, "t1")
	if pane1 == "" {
		t.Fatalf("첫 연결에서 pane 출력이 없다")
	}
	paneNum := pane1[strings.LastIndex(pane1, ":")+1:]
	// 화면에 알아볼 수 있는 흔적을 남긴다(복원 대조용).
	if err := m.WriteBytes(pane1, []byte("echo DG-SHELL-MARKER\n")); err != nil {
		t.Fatalf("입력: %v", err)
	}
	time.Sleep(1500 * time.Millisecond)

	if err := m.InstallShellIntegration(pane1); err != nil {
		t.Fatalf("install: %v", err)
	}
	time.Sleep(3 * time.Second)
	marker := ask("t1", bin+" display-message -p -t '%"+paneNum+"' '[#{@dolgate_integrated}]'")
	t.Logf("① 첫 연결: 통합 심고 표식=%s", marker)
	if marker != "["+paneIntegratedMarker+"]" {
		t.Fatalf("tmux 서버에 표식이 남지 않았다(%s, 기대 [%s]) — 재연결이 다시 심게 된다", marker, paneIntegratedMarker)
	}

	// **주입이 실제로 동작했는가.** 이것을 보지 않으면 "아무것도 심지 않기" 로도 아래의
	// 오염 검사를 통과할 수 있다. 통합이 깔렸으면 셸이 OSC 133 마커를 흘린다.
	reset(pane1)
	if err := m.WriteBytes(pane1, []byte("echo DG-AFTER-INSTALL\n")); err != nil {
		t.Fatalf("입력: %v", err)
	}
	time.Sleep(2 * time.Second)
	if after := read(pane1); !strings.Contains(after, "\x1b]133;") {
		t.Fatalf("통합이 깔리지 않았다 — OSC 133 마커가 오지 않는다: %q", tail(after, 300))
	}
	t.Logf("   통합 동작 확인: OSC 133 마커 도착")

	// **주입이 화면에 에러를 남기지 않아야 한다.** 훅이 깔렸는지만 보면 이것을 놓친다 —
	// init 명령은 타이핑용이라 줄 끝이 CR 인데, 그대로 파일에 쓰면 마지막 문장만 깨져서
	// 훅은 깔리고 화면에는 "command not found" 가 남는다(실측으로 확인한 실패 방식이다).
	installed := ask("t1", bin+" capture-pane -p -t '%"+paneNum+"'")
	for _, forbidden := range []string{"not found", "did you mean"} {
		if strings.Contains(installed, forbidden) {
			t.Errorf("[주입] 화면에 %q 가 남았다 — 주입 명령이 셸에서 깨졌다:\n%s",
				forbidden, installed)
		}
	}
	// **타이핑한 흔적 자체가 남으면 안 된다.** 사용자는 `eval "$(tmux show-buffer …)"` 한 줄도
	// "이상한 게 입력됐다" 로 본다. 스크립트가 자기 에코를 지우므로(echoEraseSequence) tmux 의
	// pane 버퍼에는 옛 프롬프트 줄과 새 프롬프트 줄만 남아야 한다 — Enter 한 번 친 모양.
	for _, trace := range []string{"eval ", "show-buffer", "delete-buffer", "dolgate-init"} {
		if strings.Contains(installed, trace) {
			t.Errorf("[흔적] 설치 뒤 tmux 버퍼에 타이핑 흔적 %q 이 남았다:\n%s", trace, installed)
		}
	}
	if n := strings.Count(installed, "ubuntu@ubuntu:~$"); n < 2 {
		t.Errorf("[흔적] 옛 프롬프트 + 새 프롬프트 두 줄이어야 하는데 프롬프트가 %d개다:\n%s", n, installed)
	}

	// 재연결이 이 내용을 **바꾸지 않아야** 한다. 스냅샷을 떠 두고 뒤에서 대조한다.
	beforeCapture := normalizeScreen(
		splitTrimmed(ask("t1", bin+" capture-pane -p -t '%"+paneNum+"'")))

	m.Disconnect("t1")
	time.Sleep(1 * time.Second)

	// ── 2) 재연결 후 렌더러가 하는 그대로: 복원(첫 리사이즈) + 셸 통합 설치 요청.
	second := base
	second.Command = bin + " -CC attach -t dgshell"
	if err := m.Connect("t2", "r2", second); err != nil {
		t.Fatalf("connect2: %v", err)
	}
	defer m.Disconnect("t2")
	defer func() { ask("t2", bin+" kill-session -t dgshell 2>/dev/null; true") }()
	pane2 := "tmux:t2:" + paneNum
	time.Sleep(2 * time.Second)

	reset(pane2)
	if err := m.Resize(pane2, cols, rows); err != nil {
		t.Fatalf("첫 리사이즈: %v", err)
	}
	if err := m.InstallShellIntegration(pane2); err != nil {
		t.Fatalf("install 2: %v", err)
	}
	restored := ""
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); {
		if restored = read(pane2); strings.Contains(restored, "DG-SHELL-MARKER") {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	// 재주입이 있었다면 그 에코가 도착할 시간을 준다(없어야 정상).
	time.Sleep(3 * time.Second)
	restored = read(pane2)
	t.Logf("② 재연결 복원 %d 바이트", len(restored))

	screen := renderRestoredScreen(t, restored, cols, rows)
	if screen.Type != "normal" {
		t.Errorf("[화면] 셸 pane 인데 대체화면에 있다(%q)", screen.Type)
	}
	// 사용자가 봤던 오염: 프롬프트 아래에 셸 통합 스크립트 전문이 박힌다.
	joined := strings.Join(screen.Rows, "\n")
	for _, forbidden := range []struct{ needle, what string }{
		{"__ds_", "셸 통합 init 스크립트"},
		{"PROMPT_COMMAND", "PROMPT_COMMAND 설정 줄"},
		{"dg-shell", "셸 프로브"},
		// 이 앱은 원격에 파일을 쓰지 않는다. 화면에 경로가 보이면 그 원칙이 깨진 것이다.
		{"/tmp/", "원격 파일 경로"},
	} {
		if strings.Contains(joined, forbidden.needle) {
			t.Errorf("[오염] 화면에 %s 가 박혔다 — 재연결에서 통합을 다시 심었다는 뜻이다:\n%s",
				forbidden.what, joined)
		}
	}
	afterCapture := ask("t2", bin+" capture-pane -p -t '%"+paneNum+"'")
	compareScreens(t, "셸 화면", screen.Rows, splitTrimmed(afterCapture))
	if !strings.Contains(joined, "DG-SHELL-MARKER") {
		t.Errorf("[화면] 복원했는데 원래 내용이 없다:\n%s", joined)
	}
	// 버퍼 우회로 흔적이 한 줄이 됐어도, 재연결마다 다시 심으면 그 한 줄이 쌓인다.
	// 재연결은 pane 내용을 **전혀 바꾸지 않아야** 한다.
	compareScreens(t, "재연결 전후 pane", normalizeScreen(splitTrimmed(afterCapture)), beforeCapture)

	// **자동완성의 전제가 재연결을 넘어 살아 있는가.** 렌더러는 OSC 133;A 를 보고서야 자동완성을
	// 켠다(useTerminalAutocomplete: setIntegrationReady). 재연결에서 설치를 건너뛰었으니 훅은
	// 셸에 그대로 있어야 하고, 명령을 치면 마커가 와야 한다. 실기기에서 이것이 죽어 있었다 —
	// 옛 표식이 깨진 설치에도 남아 재연결마다 건너뛰었기 때문이다.
	reset(pane2)
	if err := m.WriteBytes(pane2, []byte("echo DG-AFTER-REATTACH\n")); err != nil {
		t.Fatalf("입력: %v", err)
	}
	time.Sleep(2 * time.Second)
	if after := read(pane2); !strings.Contains(after, "\x1b]133;A") {
		t.Errorf("[자동완성] 재연결 뒤 명령을 쳤는데 OSC 133;A 가 오지 않는다 — 훅이 없다: %q", tail(after, 300))
	} else {
		t.Logf("   재연결 뒤 OSC 133;A 도착 — 자동완성 전제 유지")
	}
	marker2 := ask("t2", bin+" display-message -p -t '%"+paneNum+"' '[#{@dolgate_integrated}]'")
	if marker2 != "["+paneIntegratedMarker+"]" {
		t.Errorf("[표식] 재연결 뒤 표식이 %s 다(기대 [%s])", marker2, paneIntegratedMarker)
	}
}

// 옛 코드가 확인 없이 남긴 표식(1)을 든 pane. 그 설치는 깨져 있을 수 있으므로 한 번 다시 심고,
// 이번에는 마커를 확인한 뒤에야 새 표식(2)을 남겨야 한다. 실기기의 bash pane 두 개가 이 상태였고
// 그래서 자동완성이 영영 안 됐다.
func TestVMReattachHealsPanesWithStaleMarker(t *testing.T) {
	host := os.Getenv("TMUX_VM_HOST")
	pass := os.Getenv("TMUX_VM_PASS")
	if host == "" || pass == "" {
		t.Skip("set TMUX_VM_HOST and TMUX_VM_PASS")
	}
	user := envOr("TMUX_VM_USER", "ubuntu")
	bin := envOr("TMUX_BIN", "/usr/bin/tmux")

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
	ask := func(controlID, command string) string {
		handle := m.getControl(controlID)
		if handle == nil || handle.client == nil {
			return "(control 핸들 없음)"
		}
		stdout, _, _ := sshcmd.RunWithTimeout(handle.client, command, 10*time.Second)
		return strings.TrimRight(string(stdout), "\n")
	}
	base := coretypes.ConnectPayload{
		Host: host, Port: 22, Username: user, AuthType: "password", Password: pass,
		TrustedHostKeyBase64: hostKey.PublicKeyBase64, Cols: 80, Rows: 24,
	}
	first := base
	first.Command = bin + " kill-session -t dgstale 2>/dev/null; exec " + bin + " -CC new-session -s dgstale"
	if err := m.Connect("v1", "r1", first); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer m.Disconnect("v1")
	defer func() { ask("v1", bin+" kill-session -t dgstale 2>/dev/null; true") }()
	time.Sleep(2 * time.Second)
	pane := firstPaneFor(streams, &mu, "v1")
	if pane == "" {
		t.Fatalf("pane 출력이 없다")
	}
	paneNum := pane[strings.LastIndex(pane, ":")+1:]
	// 옛 코드가 남긴 상태를 만든다: 훅은 없는데 표식은 1.
	ask("v1", bin+" set-option -p -t '%"+paneNum+"' @dolgate_integrated 1")

	if err := m.InstallShellIntegration(pane); err != nil {
		t.Fatalf("install: %v", err)
	}
	time.Sleep(3 * time.Second)
	streamsMu := &mu
	_ = streamsMu
	if err := m.WriteBytes(pane, []byte("echo DG-HEALED\n")); err != nil {
		t.Fatalf("입력: %v", err)
	}
	time.Sleep(2 * time.Second)
	if out := read(pane); !strings.Contains(out, "\x1b]133;A") {
		t.Errorf("[치유] 옛 표식 1 인 pane 에 다시 심지 않았다 — 마커가 없다: %q", tail(out, 300))
	}
	if marker := ask("v1", bin+" display-message -p -t '%"+paneNum+"' '[#{@dolgate_integrated}]'"); marker != "["+paneIntegratedMarker+"]" {
		t.Errorf("[치유] 다시 심은 뒤 표식이 %s 다(기대 [%s])", marker, paneIntegratedMarker)
	}
}

// 실제 vi. 사용자가 본 어긋남(첫 줄이 중간에, 상태줄이 두 줄로)을 그대로 재현하려면 결정적
// 픽스처만으로는 부족하다 — vi 는 상태줄을 폭에 꽉 채우고 `~` 로 화면을 메우는 등 진짜 앱의
// 특성이 있다. 정폭 / 좁은 xterm / 씨앗 크기(120x32)에 재생 뒤 실제 크기로 리사이즈, 셋을 본다.
func TestVMReattachRestoresRealVi(t *testing.T) {
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
	ask := func(controlID, command string) string {
		handle := m.getControl(controlID)
		if handle == nil || handle.client == nil {
			return "(control 핸들 없음)"
		}
		stdout, _, _ := sshcmd.RunWithTimeout(handle.client, command, 10*time.Second)
		return strings.TrimRight(string(stdout), "\n")
	}
	base := coretypes.ConnectPayload{
		Host: host, Port: 22, Username: user, AuthType: "password", Password: pass,
		TrustedHostKeyBase64: hostKey.PublicKeyBase64, Cols: cols, Rows: rows,
	}
	first := base
	first.Command = bin + " kill-session -t dgvi 2>/dev/null; exec " + bin + " -CC new-session -s dgvi"
	if err := m.Connect("w1", "r1", first); err != nil {
		t.Fatalf("connect: %v", err)
	}
	time.Sleep(2 * time.Second)
	pane1 := firstPaneFor(streams, &mu, "w1")
	if pane1 == "" {
		t.Fatalf("pane 출력이 없다")
	}
	paneNum := pane1[strings.LastIndex(pane1, ":")+1:]
	// vi 를 파일 없이 열고 INSERT 모드로 글자를 넣은 채 둔다(사용자와 같은 상태). 파일은 안 만든다.
	if err := m.WriteBytes(pane1, []byte("vi\n")); err != nil {
		t.Fatalf("vi: %v", err)
	}
	time.Sleep(1500 * time.Millisecond)
	if err := m.WriteBytes(pane1, []byte("iasdasd")); err != nil {
		t.Fatalf("insert: %v", err)
	}
	time.Sleep(1500 * time.Millisecond)
	if st := ask("w1", bin+" display-message -p -t '%"+paneNum+"' '#{pane_current_command} #{alternate_on}'"); !strings.HasPrefix(st, "vi") {
		t.Fatalf("vi 가 뜨지 않았다: %q", st)
	}
	m.Disconnect("w1")
	time.Sleep(1 * time.Second)

	second := base
	second.Command = bin + " -CC attach -t dgvi"
	if err := m.Connect("w2", "r2", second); err != nil {
		t.Fatalf("connect2: %v", err)
	}
	defer m.Disconnect("w2")
	defer func() {
		// vi 를 끝내고(:q!) 세션을 지운다.
		_ = m.WriteBytes("tmux:w2:"+paneNum, []byte("\x1b:q!\n"))
		time.Sleep(500 * time.Millisecond)
		ask("w2", bin+" kill-session -t dgvi 2>/dev/null; true")
	}()
	pane2 := "tmux:w2:" + paneNum
	time.Sleep(2 * time.Second)
	reset(pane2)
	if err := m.Resize(pane2, cols, rows); err != nil {
		t.Fatalf("리사이즈: %v", err)
	}
	restored := ""
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); {
		if restored = read(pane2); strings.Contains(restored, "asdasd") {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if restored == "" {
		t.Fatalf("복원이 아무것도 내보내지 않았다")
	}
	tmuxAlt := splitTrimmed(ask("w2", bin+" capture-pane -p -t '%"+paneNum+"'"))
	tmuxCursor := ask("w2", bin+" display-message -p -t '%"+paneNum+"' '#{cursor_x},#{cursor_y}'")
	t.Logf("tmux 가 보는 vi: 1행=%q 마지막행=%q 커서=%s", tmuxAlt[0], tmuxAlt[len(tmuxAlt)-1], tmuxCursor)

	// **pane 의 실제 폭**(렌더러가 xterm 을 고정하는 값)으로 렌더링해 tmux 와 대조한다. 사용자가
	// 본 어긋남(첫 줄이 중간에, 상태줄이 두 줄로)이 있으면 여기서 바로 드러난다. 좁은 폭 검증은
	// 결정적 픽스처(TestVMReattachRestoresTheScreen)가 맡는다 — 실제 vi 는 재연결 뒤 자기 화면을
	// 다시 그려(SIGWINCH) 그 라이브 출력이 캡처에 섞이므로 좁은 폭 대조가 흔들린다.
	exact := renderRestoredScreen(t, restored, cols, rows)
	compareScreens(t, "vi 정폭", exact.Rows, tmuxAlt)
	if got := itoa(exact.CursorX) + "," + itoa(exact.CursorY); got != tmuxCursor {
		t.Errorf("[vi 커서] xterm=(%s) tmux=(%s)", got, tmuxCursor)
	}
}

// 좌우 분할된 창. 사용자가 실제로 쓰던 모양이다(vi | htop).
//
// 분할하면 pane 폭이 클라이언트 폭과 달라진다(80 → 40/39). 예전에 화면을 절대 좌표로 그렸을
// 때 이 어긋남이 htop 왼쪽 끝에 3~4자 조각을 남겼다. 지금은 텍스트 스트림으로 재생하므로
// **각 pane 을 자기 폭으로 렌더링하면 tmux 와 일치해야 한다.**
func TestVMReattachRestoresSplitPanes(t *testing.T) {
	host := os.Getenv("TMUX_VM_HOST")
	pass := os.Getenv("TMUX_VM_PASS")
	if host == "" || pass == "" {
		t.Skip("set TMUX_VM_HOST and TMUX_VM_PASS")
	}
	user := envOr("TMUX_VM_USER", "ubuntu")
	bin := envOr("TMUX_BIN", "/usr/bin/tmux")
	const cols, rows = 80, 24

	hostKey, err := sshconn.ProbeHostKey(
		context.Background(), host, 22, sshconn.JumpTargetFromCore(nil), nil, sshconn.DefaultConfig,
	)
	if err != nil {
		t.Fatalf("probe: %v", err)
	}

	var mu sync.Mutex
	streams := map[string]*strings.Builder{}
	m := NewManager(
		func(coretypes.Event) {},
		func(f coretypes.StreamFrame, d []byte) {
			mu.Lock()
			if streams[f.SessionID] == nil {
				streams[f.SessionID] = &strings.Builder{}
			}
			streams[f.SessionID].Write(d)
			mu.Unlock()
		},
	)
	read := func(key string) string {
		mu.Lock()
		defer mu.Unlock()
		if streams[key] == nil {
			return ""
		}
		return streams[key].String()
	}
	ask := func(controlID, command string) string {
		handle := m.getControl(controlID)
		if handle == nil || handle.client == nil {
			return "(control 핸들 없음)"
		}
		stdout, stderr, err := sshcmd.RunWithTimeout(handle.client, command, 10*time.Second)
		if err != nil {
			return "err=" + err.Error() + " stderr=" + strings.TrimSpace(string(stderr))
		}
		return strings.TrimRight(string(stdout), "\n")
	}

	base := coretypes.ConnectPayload{
		Host: host, Port: 22, Username: user, AuthType: "password", Password: pass,
		TrustedHostKeyBase64: hostKey.PublicKeyBase64, Cols: cols, Rows: rows,
	}

	// ── 1) 좌우 분할: 왼쪽은 전체화면 앱, 오른쪽은 프롬프트.
	first := base
	first.Command = bin + " kill-session -t dgsplit 2>/dev/null; exec " +
		bin + " -CC new-session -s dgsplit"
	if err := m.Connect("u1", "r1", first); err != nil {
		t.Fatalf("connect1: %v", err)
	}
	time.Sleep(2 * time.Second)
	left := firstPaneFor(streams, &mu, "u1")
	if left == "" {
		t.Fatalf("첫 pane 출력이 없다")
	}
	leftNum := left[strings.LastIndex(left, ":")+1:]
	if err := m.WriteBytes(left, []byte(fullScreenAppScript)); err != nil {
		t.Fatalf("앱 실행: %v", err)
	}
	time.Sleep(2500 * time.Millisecond)
	// 오른쪽은 **첫 프롬프트가 2초 늦는 bash** 로 연다. `read` 는 내장이라 그 동안 포그라운드는
	// 계속 bash 인데 화면은 빈 채(커서 0,0)다 — 실기기 %143 의 "분할 직후" 상태를 결정적으로 만든다.
	ask("u1", bin+" split-window -h -t '%"+leftNum+"' \"bash -c 'read -t 2 _; exec bash'\"")
	time.Sleep(300 * time.Millisecond)

	panes := strings.Fields(ask("u1", bin+" list-panes -s -t dgsplit -F '#{pane_id}'"))
	if len(panes) != 2 {
		t.Fatalf("pane 이 2개가 아니다: %v", panes)
	}
	rightNum := strings.TrimPrefix(panes[1], "%")
	if rightNum == leftNum {
		rightNum = strings.TrimPrefix(panes[0], "%")
	}
	// 분할 **직후**(프롬프트 전) 설치를 요청한다 — 실기기에서 렌더러가 하는 그대로. 지금 타이핑하면
	// tty 에코가 빈 화면 첫 줄에 찍히고, 잠시 뒤 뜬 readline 이 프롬프트 뒤에 다시 에코해 두 줄이 남는다.
	// 옳은 동작: 프롬프트가 그려질 때까지 기다렸다가 심고, 에코는 지운다.
	if st := ask("u1", bin+" display-message -p -t '%"+rightNum+"' '#{pane_current_command} #{cursor_x},#{cursor_y}'"); !strings.HasPrefix(st, "bash 0,0") {
		t.Fatalf("픽스처가 '프롬프트 전 bash' 상태가 아니다: %q", st)
	}
	if err := m.InstallShellIntegration("tmux:u1:" + rightNum); err != nil {
		t.Fatalf("오른쪽 설치: %v", err)
	}
	time.Sleep(6 * time.Second) // read 2초 + 프롬프트 + 안착(400ms) + 설치 + 마커
	rightAfterInstall := ask("u1", bin+" capture-pane -p -t '%"+rightNum+"'")
	for _, trace := range []string{"eval ", "show-buffer", "dolgate-init", "not found"} {
		if strings.Contains(rightAfterInstall, trace) {
			t.Errorf("[분할 직후 설치] 오른쪽 pane 에 흔적 %q:\n%s", trace, rightAfterInstall)
		}
	}
	if err := m.WriteBytes("tmux:u1:"+rightNum, []byte("echo DG-RIGHT-PANE\n")); err != nil {
		t.Fatalf("오른쪽 입력: %v", err)
	}
	time.Sleep(1500 * time.Millisecond)
	t.Logf("① 분할 완료: %s / 크기=%s", panes,
		ask("u1", bin+" list-panes -s -t dgsplit -F '#{pane_id}:#{pane_width}x#{pane_height}'"))

	m.Disconnect("u1")
	time.Sleep(1 * time.Second)

	// ── 2) 재연결 + 복원.
	second := base
	second.Command = bin + " -CC attach -t dgsplit"
	if err := m.Connect("u2", "r2", second); err != nil {
		t.Fatalf("connect2: %v", err)
	}
	defer m.Disconnect("u2")
	defer func() { ask("u2", bin+" kill-session -t dgsplit 2>/dev/null; true") }()
	time.Sleep(2 * time.Second)
	// 렌더러처럼 pane 마다 Resize 를 보낸다 — 복원은 모든 pane 의 크기가 도착하기를 기다린다.
	// (Resize 는 tmux 클라이언트 크기를 바꾸므로 여기서는 창 크기를 그대로 준다. 복원이 쓰는
	// 것은 행 수이고 그것은 두 pane 이 같다.)
	for _, num := range []string{leftNum, rightNum} {
		if err := m.Resize("tmux:u2:"+num, cols, rows); err != nil {
			t.Fatalf("리사이즈 %s: %v", num, err)
		}
	}

	leftKey, rightKey := "tmux:u2:"+leftNum, "tmux:u2:"+rightNum
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); {
		if read(leftKey) != "" && read(rightKey) != "" {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	time.Sleep(1 * time.Second)

	// ── 3) 각 pane 을 **자기 폭**으로 렌더링해 tmux 와 대조한다.
	for _, pane := range []struct {
		what, num, key string
	}{
		{"왼쪽(앱)", leftNum, leftKey},
		{"오른쪽(셸)", rightNum, rightKey},
	} {
		size := strings.Split(
			ask("u2", bin+" display-message -p -t '%"+pane.num+"' '#{pane_width}x#{pane_height}'"), "x")
		if len(size) != 2 {
			t.Fatalf("%s 크기를 읽지 못했다: %v", pane.what, size)
		}
		paneCols, paneRows := paneFlagInt(size[0]), paneFlagInt(size[1])
		stream := read(pane.key)
		if stream == "" {
			t.Errorf("%s: 복원이 아무것도 내보내지 않았다", pane.what)
			continue
		}
		t.Logf("   %s: %dx%d, 복원 %d 바이트", pane.what, paneCols, paneRows, len(stream))
		screen := renderRestoredScreen(t, stream, paneCols, paneRows)
		compareScreens(t, pane.what+" 화면", screen.Rows,
			splitTrimmed(ask("u2", bin+" capture-pane -p -t '%"+pane.num+"'")))
	}
}
