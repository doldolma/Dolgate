//go:build integration

package tmuxsession

import (
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/sshconn"
	"dolssh/services/ssh-core/pkg/coretypes"
)

// TestVMControlMode 는 실제 tmux 3.2+ 서버에 tmux -CC 로 붙어 연결·출력·입력 왕복을 검증한다.
// 실행: go test -tags integration -run TestVMControlMode -v ./internal/tmuxsession/
// 대상 VM 은 TMUX_VM_HOST 환경변수로 바꿀 수 있다(기본값은 로컬 테스트 VM).
func TestVMControlMode(t *testing.T) {
	host := os.Getenv("TMUX_VM_HOST")
	pass := os.Getenv("TMUX_VM_PASS")
	if host == "" || pass == "" {
		t.Skip("set TMUX_VM_HOST and TMUX_VM_PASS to run the VM integration test")
	}
	user := envOr("TMUX_VM_USER", "ubuntu")

	probe, err := sshconn.ProbeHostKey(host, 22, sshconn.JumpTargetFromCore(nil), nil, sshconn.DefaultConfig)
	if err != nil {
		t.Fatalf("probe host key: %v", err)
	}

	var mu sync.Mutex
	var events []coretypes.Event
	streams := map[string]*strings.Builder{}
	m := NewManager(
		func(e coretypes.Event) {
			mu.Lock()
			events = append(events, e)
			mu.Unlock()
		},
		func(f coretypes.StreamFrame, d []byte) {
			mu.Lock()
			if streams[f.SessionID] == nil {
				streams[f.SessionID] = &strings.Builder{}
			}
			streams[f.SessionID].Write(d)
			mu.Unlock()
		},
	)

	err = m.Connect("ctrl1", "req1", coretypes.ConnectPayload{
		Host:                 host,
		Port:                 22,
		Username:             user,
		AuthType:             "password",
		Password:             pass,
		TrustedHostKeyBase64: probe.PublicKeyBase64,
		Cols:                 80,
		Rows:                 24,
		// 기존 itest 세션이 남아 있으면 attach 되어 초기 pane 출력이 오지 않으므로(=control
		// mode는 attach 시 새 출력만 보냄, 초기 화면은 capture-pane 후속 과제) 매번 새로 만든다.
		Command: "/usr/local/bin/tmux kill-session -t itest 2>/dev/null; exec /usr/local/bin/tmux -CC new-session -s itest",
	})
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer m.Disconnect("ctrl1")

	time.Sleep(2 * time.Second)

	mu.Lock()
	evKinds := map[coretypes.EventType]int{}
	for _, e := range events {
		evKinds[e.Type]++
	}
	var paneSession string
	for k := range streams {
		paneSession = k
		break
	}
	mu.Unlock()

	t.Logf("event kinds: %v", evKinds)
	t.Logf("pane sessions seen: %d (sample %q)", len(streams), paneSession)

	if evKinds[coretypes.EventConnected] == 0 {
		t.Errorf("expected a connected event")
	}
	if evKinds[coretypes.EventTmuxLayoutChange] == 0 {
		t.Errorf("expected a tmuxLayoutChange event (synthesized from list-windows query)")
	}
	if paneSession == "" {
		t.Fatalf("no pane output received — control stream not parsed into pane sessions")
	}

	// 입력 왕복: send-keys 로 echo 를 보내고 그 출력이 되돌아오는지 확인.
	marker := "DOLGATE_OK_42"
	if err := m.WriteBytes(paneSession, []byte("echo "+marker+"\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	time.Sleep(1500 * time.Millisecond)

	mu.Lock()
	got := streams[paneSession].String()
	mu.Unlock()
	if !strings.Contains(got, marker) {
		t.Errorf("expected echo %q in pane output; last 200 bytes: %q", marker, tail(got, 200))
	} else {
		t.Logf("round-trip OK: marker echoed back")
	}
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func tail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

func firstPaneFor(streams map[string]*strings.Builder, mu *sync.Mutex, ctrl string) string {
	mu.Lock()
	defer mu.Unlock()
	prefix := "tmux:" + ctrl + ":"
	for k := range streams {
		if strings.HasPrefix(k, prefix) {
			return k
		}
	}
	return ""
}

// TestVMReattach 는 같은 tmux 세션에 재연결(attach)했을 때도 출력·입력 echo 가 도는지 검증한다.
// (new 일 땐 동작하지만 -A attach 시 %output 이 안 오는 회귀를 재현/검증)
func TestVMReattach(t *testing.T) {
	host := os.Getenv("TMUX_VM_HOST")
	pass := os.Getenv("TMUX_VM_PASS")
	if host == "" || pass == "" {
		t.Skip("set TMUX_VM_HOST and TMUX_VM_PASS")
	}
	user := envOr("TMUX_VM_USER", "ubuntu")
	probe, err := sshconn.ProbeHostKey(host, 22, sshconn.JumpTargetFromCore(nil), nil, sshconn.DefaultConfig)
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
	base := coretypes.ConnectPayload{
		Host: host, Port: 22, Username: user, AuthType: "password", Password: pass,
		TrustedHostKeyBase64: probe.PublicKeyBase64, Cols: 80, Rows: 24,
	}

	bin := envOr("TMUX_BIN", "/usr/local/bin/tmux")
	// 1) 첫 연결: 깨끗한 새 세션
	first := base
	first.Command = bin + " kill-session -t reattach 2>/dev/null; exec " + bin + " -CC new-session -s reattach"
	if err := m.Connect("c1", "r1", first); err != nil {
		t.Fatalf("connect1: %v", err)
	}
	time.Sleep(2 * time.Second)
	pane1 := firstPaneFor(streams, &mu, "c1")
	if pane1 == "" {
		t.Fatalf("no pane output on first connect")
	}
	paneNum := pane1[strings.LastIndex(pane1, ":")+1:]
	m.WriteBytes(pane1, []byte("echo FIRST_OK\n"))
	time.Sleep(1500 * time.Millisecond)
	mu.Lock()
	got1 := streams[pane1].String()
	mu.Unlock()
	if !strings.Contains(got1, "FIRST_OK") {
		t.Fatalf("first echo missing on %s: %q", pane1, tail(got1, 200))
	}
	t.Logf("first connect OK, pane=%s", pane1)
	m.Disconnect("c1")
	time.Sleep(1 * time.Second)

	// 2) 재연결: 같은 세션에 attach
	second := base
	second.Command = bin + " -CC new-session -A -s reattach"
	if err := m.Connect("c2", "r2", second); err != nil {
		t.Fatalf("connect2: %v", err)
	}
	time.Sleep(2 * time.Second)
	mu.Lock()
	c2Keys := []string{}
	for k := range streams {
		if strings.HasPrefix(k, "tmux:c2:") {
			c2Keys = append(c2Keys, k)
		}
	}
	mu.Unlock()
	t.Logf("reattach: stream keys seen for c2 = %v (writing to pane num %s)", c2Keys, paneNum)

	pane2 := "tmux:c2:" + paneNum
	m.WriteBytes(pane2, []byte("echo SECOND_OK\n"))
	time.Sleep(1500 * time.Millisecond)
	mu.Lock()
	var got2 string
	if streams[pane2] != nil {
		got2 = streams[pane2].String()
	}
	mu.Unlock()
	if !strings.Contains(got2, "SECOND_OK") {
		t.Errorf("reattach echo MISSING on %s: %q", pane2, tail(got2, 200))
	} else {
		t.Logf("reattach echo OK")
	}
	m.Disconnect("c2")
}
