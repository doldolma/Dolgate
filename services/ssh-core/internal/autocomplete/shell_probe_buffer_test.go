package autocomplete

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// 프로브 답은 **도착한 순간 읽어야 한다.**
//
// Observe 는 버퍼에 상한(4KB)을 두는데, 그 상한을 답보다 먼저 적용하면 이미 도착한 답의 앞부분이
// 잘려 나간다. 그러면 그 답은 영원히 오지 않는다 — 접두사가 다음 청크에 다시 실려 오지 않으므로.
//
// 서브셸에 들어가는 순간이 정확히 이 조건이다. 프로브를 무장한 직후 그 셸의 배너·MOTD 가 한꺼번에
// 쏟아지고, 그 양이 4KB 를 넘는 호스트가 드물지 않다.
func TestShellProbeReadsTheReplyBeforeTrimmingTheBuffer(t *testing.T) {
	var probe ShellProbe
	var got atomic.Value
	probe.Arm(func(shell string) { got.Store(shell) })

	// 한 청크에 답이 먼저 오고 그 뒤로 상한을 넘는 출력이 붙는다.
	chunk := ShellProbeReplyPrefix + "bash;5.2.15\a" + strings.Repeat("x", shellProbeBufferLimit+512)
	probe.Observe([]byte(chunk))

	// 콜백은 읽기 루프를 붙들지 않으려고 고루틴에서 돈다.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if got.Load() != nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if shell := got.Load(); shell != "bash" {
		t.Fatalf("답을 읽지 못했다: %v", shell)
	}
}

// 답이 없는 출력이 계속 쏟아져도 버퍼는 상한 안에 머물러야 한다 — 상한을 나중에 적용하도록
// 바꾸면서 그것이 사라지지 않았는지 함께 잠근다.
func TestShellProbeKeepsTheBufferBounded(t *testing.T) {
	var probe ShellProbe
	probe.Arm(func(string) {})

	for range 8 {
		probe.Observe([]byte(strings.Repeat("y", shellProbeBufferLimit)))
	}

	probe.mu.Lock()
	size := len(probe.buffer)
	probe.mu.Unlock()
	// 한 청크만큼은 넘칠 수 있다(자르기가 붙인 뒤에 온다). 그 이상 쌓이면 상한이 없는 것이다.
	if size > shellProbeBufferLimit*2 {
		t.Fatalf("버퍼가 상한을 넘었다: %d", size)
	}
}
