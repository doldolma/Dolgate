package autocomplete

import (
	"bytes"
	"strings"
	"testing"
)

// 로컬 PTY 는 4096 버퍼로 읽어도 한 번에 1024바이트까지만 준다. 주입 스크립트가 그보다 길면
// 청크 하나에 통째로 들어가지 않아 예전 방식(청크별 전체 일치)으로는 하나도 지워지지 않았다 —
// 스크립트가 화면에 그대로 찍혔고, 그래서 스크립트 길이에 1024바이트 천장이 있었다.
const ptyChunkLimit = 1024

func armedFilter() *HandshakeFilter {
	filter := &HandshakeFilter{}
	filter.Filter([]byte(PromptStartMarker))
	return filter
}

func feedInChunks(filter *HandshakeFilter, data []byte, size int) []byte {
	var out []byte
	for offset := 0; offset < len(data); offset += size {
		end := offset + size
		if end > len(data) {
			end = len(data)
		}
		forward, _ := filter.Filter(data[offset:end])
		out = append(out, forward...)
	}
	return out
}

// 이 테스트가 천장이 사라졌다는 증거다. 주입 스크립트의 현재 길이(952)에 기대지 않는다 —
// 지금은 한 청크에 들어가지만, 길어져도 지워져야 하는 것이 요점이다.
func TestStreamingScrubRemovesEchoLongerThanAPtyChunk(t *testing.T) {
	longEcho := "__ds_o(){ printf x; }; " + strings.Repeat("payload; ", 200)
	if len(longEcho) <= ptyChunkLimit {
		t.Fatalf("test fixture must exceed the PTY chunk limit, got %d", len(longEcho))
	}
	filter := &HandshakeFilter{echo: []byte(longEcho)}
	filter.Filter([]byte(PromptStartMarker))

	data := append([]byte("user@host:~$ "), longEcho...)
	out := feedInChunks(filter, data, ptyChunkLimit)
	out = append(out, filter.drainPendingEcho()...)

	if bytes.Contains(out, []byte("payload")) {
		t.Fatalf("echo survived a chunk split: %q", out)
	}
	if string(out) != "user@host:~$ " {
		t.Fatalf("prompt text must survive untouched, got %q", out)
	}
}

// 지금 스크립트도 같은 경로로 지워진다(청크 하나에 들어가는 크기여도).
func TestStreamingScrubRemovesTheCurrentScript(t *testing.T) {
	filter := armedFilter()
	data := append([]byte("user@host:~$ "), injectedCommandEcho...)
	out := feedInChunks(filter, data, ptyChunkLimit)
	out = append(out, filter.drainPendingEcho()...)
	if bytes.Contains(out, []byte("__ds_o")) {
		t.Fatalf("part of the script leaked: %q", out)
	}
	if !bytes.Contains(out, []byte("user@host:~$ ")) {
		t.Fatalf("prompt text must survive: %q", out)
	}
}

func TestStreamingScrubHandlesEverySplitOffset(t *testing.T) {
	// 경계가 어디에 떨어져도 지워져야 한다 — 실제 청크 경계는 우리가 못 정한다.
	data := append(append([]byte("before|"), injectedCommandEcho...), []byte("|after")...)
	for size := 1; size <= len(data); size *= 3 {
		filter := armedFilter()
		out := feedInChunks(filter, data, size)
		out = append(out, filter.drainPendingEcho()...)
		if string(out) != "before||after" {
			t.Fatalf("size %d: got %q", size, out)
		}
	}
}

func TestStreamingScrubDoesNotHoldOrdinaryOutput(t *testing.T) {
	// 평소 출력은 붙들지 않는다 — 붙들면 화면이 그만큼 늦게 그려진다.
	filter := armedFilter()
	forward, _ := filter.Filter([]byte("total 36\r\ndrwxr-xr-x 2 ubuntu\r\n"))
	if string(forward) != "total 36\r\ndrwxr-xr-x 2 ubuntu\r\n" {
		t.Fatalf("ordinary output was altered or delayed: %q", forward)
	}
}

func TestStreamingScrubReleasesHeldPrefixOnNextChunk(t *testing.T) {
	// echo 의 접두사로 끝나는 출력은 잠깐 붙들리지만 다음 청크에서 그대로 나온다.
	filter := armedFilter()
	head := string(injectedCommandEcho[:4])
	first, _ := filter.Filter([]byte("x" + head))
	second, _ := filter.Filter([]byte("y"))
	if got := string(first) + string(second); got != "x"+head+"y" {
		t.Fatalf("held bytes were lost or duplicated: %q", got)
	}
}

func TestStreamingScrubStopsAfterBudget(t *testing.T) {
	// 예산을 넘기면 찾기를 접는다 — 세션 내내 찾으면 사용자 출력까지 지운다.
	filter := armedFilter()
	filter.Filter(bytes.Repeat([]byte("a"), maxEchoScrubBytes+1))
	forward, _ := filter.Filter(injectedCommandEcho)
	if !bytes.Contains(forward, injectedCommandEcho) {
		t.Fatal("expected pass-through once the budget is spent")
	}
}

func TestStreamingScrubStopsAfterTheFirstRemoval(t *testing.T) {
	// 재출력은 한 번뿐이다. 그 뒤에 같은 글자가 나오면 사용자 것이므로 지우지 않는다.
	filter := armedFilter()
	filter.Filter(injectedCommandEcho)
	forward, _ := filter.Filter([]byte("echo '" + strings.TrimSpace(string(injectedCommandEcho)) + "'"))
	if !bytes.Contains(forward, []byte("__ds_o")) {
		t.Fatal("user output that happens to contain the script must survive")
	}
}
