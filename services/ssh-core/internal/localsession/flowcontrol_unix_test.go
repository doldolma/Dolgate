//go:build !windows

package localsession

// 화면이 처리하지 못한 출력이 상한을 넘으면 PTY 를 읽지 않아, 출력하던 프로그램(`yes`)이 기다리는지.
// 처리했다고 알리면 다시 흘러야 한다.

import (
	"os/exec"
	"sync/atomic"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/flowcontrol"
	"dolssh/services/ssh-core/internal/protocol"
)

func TestFlowControlPausesTheProgramUntilAcked(t *testing.T) {
	yesPath, err := exec.LookPath("yes")
	if err != nil {
		t.Skip("yes 가 없다")
	}

	const high = 64 << 10
	flow := flowcontrol.NewWithLimits(high, 16<<10, time.Minute)
	var received atomic.Int64
	manager := NewManager(
		func(protocol.Event) {},
		func(frame protocol.StreamFrame, data []byte) {
			// 런타임의 출력 통로가 하는 일(pkg/runtime): 내보낸 양을 센다.
			flow.Sent(frame.SessionID, len(data))
			received.Add(int64(len(data)))
		},
	)
	manager.SetFlowControl(flow)
	flow.Start("s1")
	if err := manager.Connect("s1", "r1", protocol.LocalConnectPayload{
		Cols: 120, Rows: 32,
		Executable: yesPath,
		Args:       []string{"0123456789"},
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Disconnect("s1") })

	paused := settleAt(t, &received, 300*time.Millisecond, 5*time.Second)
	// 읽기 한 번(최대 4KB)만큼은 넘을 수 있다.
	if paused < high || paused > high+8<<10 {
		t.Fatalf("멈췄을 때 받은 양 = %d, 상한(%d) 근처여야 한다", paused, high)
	}

	flow.Ack("s1", paused)
	if !waitFor(t, 5*time.Second, func() bool { return received.Load() >= paused+high }) {
		t.Fatalf("처리했다고 알렸는데 더 흐르지 않았다(%d → %d)", paused, received.Load())
	}
}

// settleAt 은 값이 quiet 동안 더 늘지 않을 때까지 기다려 그 값을 준다.
func settleAt(t *testing.T, value *atomic.Int64, quiet, limit time.Duration) int64 {
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
		if time.Since(lastChange) >= quiet {
			return last
		}
	}
	t.Fatalf("값이 %v 안에 멈추지 않았다(마지막 %d)", limit, last)
	return 0
}
