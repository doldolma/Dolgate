package autocomplete

import (
	"strings"
	"sync"
	"testing"
	"time"
)

// 스트리밍 echo 제거기는 갈린 주입 echo 를 잡으려고 꼬리를 붙든다. 그런데 프로브 명령이
// `printf` 로 시작해서, 화면 끝 글자가 `p` 이면 그 한 글자가 걸린다. 다음 출력이 오면 풀리지만
// 한 프레임 그리고 멎는 TUI(top·vi)에서는 올 다음 출력이 없어 영영 화면에 닿지 않았다.
// 실측: fake top 의 "Press q to quit fake top" 이 "…fake to" 로 남았다.
func TestHandshakeFlushesHeldEchoTailWhenOutputGoesIdle(t *testing.T) {
	var mu sync.Mutex
	var flushed strings.Builder
	h := &Handshake{}
	h.SetIdleFlush(func(data []byte) {
		mu.Lock()
		flushed.Write(data)
		mu.Unlock()
	})
	h.ArmForShellProbe(false, ShellProbeCommand())

	// 마커가 온 뒤(핸드셰이크 완료) 화면이 `p` 로 끝나는 출력이 오면 그 글자가 붙들린다.
	h.Filter([]byte(PromptStartMarker))
	forwarded := h.Filter([]byte("Press q to quit fake top"))
	if strings.HasSuffix(string(forwarded), "top") {
		t.Skip("이 환경에서는 꼬리를 붙들지 않는다 — 이 테스트가 지키려는 상황이 아니다")
	}
	if !strings.HasSuffix(string(forwarded), "fake to") {
		t.Fatalf("전제 확인 실패, 통과분=%q", string(forwarded))
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		got := flushed.String()
		mu.Unlock()
		if got == "p" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	got := flushed.String()
	mu.Unlock()
	t.Fatalf("출력이 멎었는데 붙든 꼬리가 나오지 않았다 — 화면에서 마지막 글자가 사라진다(방출=%q)", got)
}

// 유휴 방출로 꼬리를 내보낸 **뒤** 출력이 이어지면, 그 꼬리가 두 번 나가면 안 된다.
// (방출할 때 비우지 않고 복사만 하면 다음 청크에 다시 얹혀 글자가 겹쳐 찍힌다.)
func TestHandshakeDoesNotReemitTailAfterIdleFlush(t *testing.T) {
	var mu sync.Mutex
	var flushed strings.Builder
	h := &Handshake{}
	h.SetIdleFlush(func(data []byte) {
		mu.Lock()
		flushed.Write(data)
		mu.Unlock()
	})
	h.ArmForShellProbe(false, ShellProbeCommand())
	h.Filter([]byte(PromptStartMarker))

	first := string(h.Filter([]byte("Press q to quit fake top")))
	if !strings.HasSuffix(first, "fake to") {
		t.Skip("이 환경에서는 꼬리를 붙들지 않는다 — 이 테스트가 지키려는 상황이 아니다")
	}

	// 유휴 방출이 일어날 때까지 기다린다.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		done := flushed.String() == "p"
		mu.Unlock()
		if done {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	idle := flushed.String()
	mu.Unlock()
	if idle != "p" {
		t.Fatalf("유휴 방출이 꼬리를 내보내지 않았다: %q", idle)
	}

	// 이제 출력이 이어진다. 이미 내보낸 꼬리가 다시 얹히면 안 된다.
	next := string(h.Filter([]byte("X\r\n")))
	if strings.HasPrefix(next, "p") {
		t.Fatalf("이미 방출한 꼬리가 다음 청크에 다시 얹혔다: %q", next)
	}
	total := first + idle + next
	if want := strings.Count("Press q to quit fake topX", "p"); strings.Count(total, "p") != want {
		t.Fatalf("p 개수가 %d 여야 하는데 %d — 꼬리가 겹쳐 나갔다(전체=%q)", want, strings.Count(total, "p"), total)
	}
}
