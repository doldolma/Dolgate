package awssession

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

// 한 프레임 그리고 멎는 TUI 의 **마지막 글자**가 화면에 닿는가.
//
// 스트리밍 echo 제거기는 갈린 주입 echo 를 잡으려고 꼬리를 붙드는데, 프로브 명령이 `printf` 로
// 시작해서 화면 끝의 `p` 한 글자가 그대로 걸렸다. 다음 출력이 오면 풀리지만 top·vi 처럼 그리고
// 멎는 화면에서는 올 다음 출력이 없어 영영 닿지 않았다(실측: "…fake top" 이 "…fake to" 로 남고
// 창을 리사이즈해 새 출력을 만들어야 나왔다). 그래서 이 테스트는 **새 출력을 전혀 만들지 않고**
// 기다린다 — 유휴 방출이 없으면 여기서 실패한다.
func TestFakeTopTailReachesManagerEmit(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping fixture build in -short mode")
	}
	fixturePath := filepath.Join(t.TempDir(), "fake-aws-session")
	if runtime.GOOS == "windows" {
		fixturePath += ".exe"
	}
	build := exec.Command("go", "build", "-o", fixturePath, "./testfixture")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		t.Fatalf("build fixture: %v", err)
	}
	t.Setenv("DOLSSH_E2E_FAKE_AWS_SESSION", "process")
	t.Setenv("DOLSSH_E2E_FAKE_AWS_FIXTURE_PATH", fixturePath)

	var mu sync.Mutex
	var emitted strings.Builder
	m := NewManager(
		func(protocol.Event) {},
		func(_ protocol.StreamFrame, data []byte) {
			mu.Lock()
			emitted.Write(data)
			mu.Unlock()
		},
	)
	if err := m.Connect("s1", "r1", protocol.AWSConnectPayload{
		ProfileName: "default", Region: "ap-northeast-2", InstanceID: "i-fake",
		Cols: 120, Rows: 32,
	}); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer m.Disconnect("s1")

	seen := func() string { mu.Lock(); defer mu.Unlock(); return emitted.String() }
	waitFor := func(needle string, limit time.Duration) bool {
		deadline := time.Now().Add(limit)
		for time.Now().Before(deadline) {
			if strings.Contains(seen(), needle) {
				return true
			}
			time.Sleep(50 * time.Millisecond)
		}
		return strings.Contains(seen(), needle)
	}

	if !waitFor("PROMPT> ready", 10*time.Second) {
		t.Fatalf("프롬프트가 오지 않았다: %q", seen())
	}
	if err := m.WriteBytes("s1", []byte("__START_FAKE_TOP__\r")); err != nil {
		t.Fatalf("write: %v", err)
	}
	const footer = "Press q to quit fake top"
	if !waitFor("top - fake session", 10*time.Second) {
		t.Fatalf("헤더가 오지 않았다")
	}
	// 새 출력을 **전혀 만들지 않고** 기다린다. 붙든 꼬리가 유휴 방출로 풀려야 한다.
	if !waitFor(footer, 3*time.Second) {
		s := seen()
		tail := s
		if len(tail) > 60 {
			tail = tail[len(tail)-60:]
		}
		t.Fatalf("마지막 바이트가 화면에 닿지 않았다 — 꼬리=%q", tail)
	}
	t.Logf("OK — 새 출력 없이도 푸터 전체가 도착했다")
}
