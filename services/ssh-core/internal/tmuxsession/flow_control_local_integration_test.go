//go:build integration

package tmuxsession

// 실제 tmux(이 기계, control mode)에 붙여 창 흐름 제어가 끝까지 도는지 본다.
//
//	쏟아지는 창 → 우리 셈이 상한을 넘으면 pause → tmux 가 그 창 출력을 멈춘다
//	→ 처리했다고 알리면 continue → tmux 가 다시 보낸다
//	→ 출력이 멎어 잠잠해지면 지금 화면을 다시 그린다(쏟아지는 동안에는 그리지 않는다).
//
// SSH 없이 tmux -C 를 직접 띄운다(다른 tmux 서버와 섞이지 않게 소켓을 따로 쓴다).
// 실행: go test -tags integration -run TestLocalTmuxPaneFlowControl -v ./internal/tmuxsession/

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/flowcontrol"
	"dolssh/services/ssh-core/pkg/coretypes"
)

func TestLocalTmuxPaneFlowControl(t *testing.T) {
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux 가 없다")
	}
	versionOut, err := exec.Command(tmuxPath, "-V").Output()
	if err != nil {
		t.Skip("tmux -V 실패")
	}
	version := parseTmuxVersion(string(versionOut))
	if !version.supportsPaneFlowControl() {
		t.Skipf("%s: 창 흐름 제어는 3.2 이상", bytes.TrimSpace(versionOut))
	}

	socket := fmt.Sprintf("dolgate-flow-test-%d", os.Getpid())
	// stop 파일이 생길 때까지 쏟아내고, 그 뒤엔 조용히 남는다(Ctrl+C 뒤 프롬프트에서 기다리는 셸처럼).
	stop := filepath.Join(t.TempDir(), "stop")
	cmd := exec.Command(tmuxPath, "-L", socket, "-C", "new-session", "-x", "120", "-y", "30",
		"sh", "-c", `i=0; while [ ! -e "$0" ]; do i=$((i+1)); echo $i; done; echo DONE; exec sleep 3600`, stop)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// kill-server 는 제어 클라이언트가 출력을 다 받아 갈 때까지 기다려서, 읽는 쪽이 멈추면 끝나지
		// 않는다(재 봤다). 테스트가 끝날 땐 읽는 쪽을 장담할 수 없으니 서버 pid 를 물어 직접 끝낸다.
		if out, err := exec.Command(tmuxPath, "-L", socket, "display-message", "-p", "#{pid}").Output(); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(out))); err == nil {
				_ = syscall.Kill(pid, syscall.SIGTERM)
			}
		}
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})

	const pane = "tmux:ctl:0"
	const high = 64 << 10
	flow := flowcontrol.NewWithLimits(high, 16<<10, time.Minute)
	var received atomic.Int64
	var redrawn atomic.Bool
	m := NewManager(func(coretypes.Event) {}, func(frame coretypes.StreamFrame, data []byte) {
		// 런타임의 출력 통로가 하는 일(pkg/runtime): 내보낸 양을 센다.
		flow.Sent(frame.SessionID, len(data))
		if frame.SessionID == pane {
			received.Add(int64(len(data)))
			if bytes.Contains(data, []byte("REDRAWN")) {
				redrawn.Store(true)
			}
		}
	})
	// 다시 그리기는 SSH exec 로 tmux 에 묻는데 여기엔 SSH 가 없다 — 그렸다는 표시만 남긴다.
	m.paneRestoreStates = func(*controlHandle) []paneRestoreState {
		return []paneRestoreState{{paneID: "%0", alternate: flagOff, width: 120, height: 30}}
	}
	m.paneScreens = func(*controlHandle, paneRestoreState) paneRestoreScreens {
		return paneRestoreScreens{current: []string{"REDRAWN"}}
	}
	handle := &controlHandle{id: "ctl", stdin: stdin, closed: make(chan struct{}), version: version}
	m.mu.Lock()
	m.controls["ctl"] = handle
	m.mu.Unlock()
	// 세션 목록 알림은 SSH exec 로 다시 조회하게 하는데 여기엔 SSH 가 없다 — 그 줄만 걸러 넘긴다.
	feed, feedWriter := io.Pipe()
	go func() {
		lines := bufio.NewReader(stdout)
		for {
			line, err := lines.ReadBytes('\n')
			if len(line) > 0 && !bytes.HasPrefix(line, []byte("%sessions-changed")) &&
				!bytes.HasPrefix(line, []byte("%session-renamed")) {
				if _, writeErr := feedWriter.Write(line); writeErr != nil {
					return
				}
			}
			if err != nil {
				_ = feedWriter.CloseWithError(err)
				return
			}
		}
	}()
	go m.stream(handle, feed)

	pause, resume, ok := m.PaneFlowControls(pane)
	if !ok {
		t.Fatal("PaneFlowControls 를 쓸 수 없다")
	}
	flow.StartObserved(pane, pause, resume)

	// 아무것도 처리했다고 알리지 않으면 상한 근처에서 멈춘다(멈추라고 한 뒤 이미 오던 것은 더 온다).
	paused := settleBytes(t, &received, 300*time.Millisecond, 5*time.Second)
	if paused < high || paused > 4*high {
		t.Fatalf("멈췄을 때 받은 양 = %d, 상한(%d) 근처여야 한다", paused, high)
	}

	// 처리했다고 알리면 다시 흐른다. 아직 쏟아지는 중이라 곧 다시 멈추고, 그동안 다시 그리지 않는다.
	acked := received.Load()
	flow.Ack(pane, acked)
	resumed := settleBytes(t, &received, 300*time.Millisecond, 5*time.Second)
	if resumed <= paused+high {
		t.Fatalf("처리했다고 알렸는데 더 흐르지 않았다(%d → %d)", paused, resumed)
	}
	if redrawn.Load() {
		t.Fatal("쏟아지는 중에 다시 그렸다")
	}

	// 출력을 멈추게 하고 받는 대로 처리했다고 알린다. 잠잠해지면 멈춘 동안 건너뛴 출력 대신 지금 화면을 그린다.
	if err := os.WriteFile(stop, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !redrawn.Load() {
		if now := received.Load(); now > acked {
			flow.Ack(pane, now-acked)
			acked = now
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !redrawn.Load() {
		t.Fatal("출력이 멎었는데 화면을 다시 그리지 않았다")
	}
}

func settleBytes(t *testing.T, value *atomic.Int64, quiet, limit time.Duration) int64 {
	t.Helper()
	deadline := time.Now().Add(limit)
	last := value.Load()
	lastChange := time.Now()
	for time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
		if current := value.Load(); current != last {
			last = current
			lastChange = time.Now()
			continue
		}
		if last > 0 && time.Since(lastChange) >= quiet {
			return last
		}
	}
	t.Fatalf("값이 %v 안에 멈추지 않았다(마지막 %d)", limit, last)
	return 0
}
