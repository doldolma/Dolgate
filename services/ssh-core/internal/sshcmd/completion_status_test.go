package sshcmd

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// 보조 채널이 상태를 싣기 전에는 **명령이 실패한 것과 찍을 것이 없던 것이 같은 값**(빈
// stdout)으로 도착했다. 세션 패널은 그것을 "없습니다" 로 그렸고, 19.03 호스트의 컨테이너 탭이
// 오류 한 줄 없이 비어 있던 것이 그 결과다. 아래 검사들이 그 둘을 갈라 놓는다.

func TestCompletionWorkerReportsExitCode(t *testing.T) {
	worker, _ := newLocalCompletionWorker(t)
	defer worker.Close()

	ok, err := worker.Run("printf 'one\n'", time.Second, 1024)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if ok.ExitCode != 0 || string(ok.Stdout) != "one\n" || ok.Failed() {
		t.Fatalf("성공한 명령: %+v", ok)
	}

	// 찍은 것이 없어도 성공은 성공이다 — 이것이 "정말 아무것도 없다" 다.
	empty, err := worker.Run("true", time.Second, 1024)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if empty.ExitCode != 0 || len(empty.Stdout) != 0 || empty.Failed() {
		t.Fatalf("빈 출력이지만 성공: %+v", empty)
	}

	// 같은 빈 출력인데 이쪽은 실패다.
	failed, err := worker.Run("exit 3", time.Second, 1024)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if failed.ExitCode != 3 || !failed.Failed() {
		t.Fatalf("실패한 명령: %+v", failed)
	}
}

// 도커 템플릿 오류가 딱 이 모양이다 — 줄 중간까지 찍고 stderr 로 죽는다.
func TestCompletionWorkerKeepsPartialOutputAndSaysItFailed(t *testing.T) {
	worker, _ := newLocalCompletionWorker(t)
	defer worker.Close()

	out, err := worker.Run("printf 'partial\n'; echo 'boom' >&2; exit 1", time.Second, 1024)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if string(out.Stdout) != "partial\n" {
		t.Fatalf("찍은 것은 그대로 줘야 한다: %q", out.Stdout)
	}
	if out.ExitCode != 1 || !out.Failed() {
		t.Fatalf("종료 코드를 실어야 한다: %+v", out)
	}
	if !strings.Contains(string(out.Stderr), "boom") {
		t.Fatalf("오류 문장을 원문 그대로 실어야 한다: %q", out.Stderr)
	}
}

// 오류 문장이 다음 명령의 것으로 딸려 가면 엉뚱한 이유를 보여 주게 된다.
func TestCompletionWorkerDoesNotCarryStderrIntoTheNextFrame(t *testing.T) {
	worker, _ := newLocalCompletionWorker(t)
	defer worker.Close()

	if _, err := worker.Run("echo 'first-error' >&2; exit 1", time.Second, 1024); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	next, err := worker.Run("printf ok", time.Second, 1024)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if strings.Contains(string(next.Stderr), "first-error") {
		t.Fatalf("앞 명령의 오류가 딸려 왔다: %q", next.Stderr)
	}
	if next.ExitCode != 0 {
		t.Fatalf("뒤 명령은 성공이다: %+v", next)
	}
}

// 출력이 상한에 걸리면 꼬리의 상태 줄도 함께 잘린다. 그때는 **모른다**고 답한다 — 잘릴 만큼
// 찍었다는 것은 명령이 돌았다는 뜻이라, 실패로 뒤집으면 멀쩡한 답을 버리게 된다.
func TestCompletionWorkerReportsUnknownWhenTruncated(t *testing.T) {
	worker, _ := newLocalCompletionWorker(t)
	defer worker.Close()

	out, err := worker.Run("i=0; while [ $i -lt 2048 ]; do printf x; i=$((i+1)); done", time.Second, 32)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if !out.Truncated || len(out.Stdout) != 32 {
		t.Fatalf("잘린 출력: %+v", out)
	}
	if out.ExitCode != ExitCodeUnknown || out.Failed() {
		t.Fatalf("모르는 것은 실패가 아니다: %+v", out)
	}
}

// 목록 명령은 전부 `exit $rc` 로 끝난다. 그 `exit` 가 **서브셸만** 빠져나가야 한다 — 장수 워커
// 셸까지 끝내면 질의마다 SSH 채널을 새로 여는 셈이 되고, 그것은 결과가 그럴듯해서 눈에 안 띈다.
func TestCompletionWorkerSurvivesCommandThatExits(t *testing.T) {
	worker, starts := newLocalCompletionWorker(t)
	defer worker.Close()

	first, err := worker.Run("printf 'x\n'; exit 3", time.Second, 1024)
	if err != nil || first.ExitCode != 3 || string(first.Stdout) != "x\n" {
		t.Fatalf("첫 명령: %+v %v", first, err)
	}
	second, err := worker.Run("printf ok", time.Second, 1024)
	if err != nil || second.ExitCode != 0 || string(second.Stdout) != "ok" {
		t.Fatalf("뒤 명령: %+v %v", second, err)
	}
	if got := atomic.LoadInt32(starts); got != 1 {
		t.Fatalf("워커 셸이 살아 있어야 한다(시작 횟수 %d)", got)
	}
}

// stderr 를 담는 버퍼가 상한을 넘는 그 한 번에 **짧게 답하면** io.Copy 가 복사를 멈춘다 —
// 그러면 이 워커의 stderr 는 영영 비워지지 않는다.
func TestBoundedBufferNeverShortWrites(t *testing.T) {
	buffer := NewBoundedBuffer(8)
	for _, chunk := range [][]byte{[]byte("abcde"), []byte("fghij"), []byte("klmno")} {
		n, err := buffer.Write(chunk)
		if err != nil || n != len(chunk) {
			t.Fatalf("받은 만큼 썼다고 답해야 한다: n=%d len=%d err=%v", n, len(chunk), err)
		}
	}
	if got := string(buffer.Take()); got != "abcdefgh" {
		t.Fatalf("앞에서부터 상한까지만 담는다: %q", got)
	}
	if got := buffer.Take(); len(got) != 0 {
		t.Fatalf("가져가면 비워야 한다: %q", got)
	}
}

// **파이프의 마지막 명령이 상태를 삼킨다.** `docker ps … | head` 는 도커가 죽어도 0 이다.
// POSIX sh 에는 pipefail 이 없으므로, 상한을 거는 쪽(렌더러의 목록 명령)이 출력을 변수로 받고
// 원래 상태를 되돌려 줘야 한다. 그 규약을 잊지 않도록 여기 못 박아 둔다.
func TestCompletionWorkerStatusIsTheLastCommandInAPipeline(t *testing.T) {
	worker, _ := newLocalCompletionWorker(t)
	defer worker.Close()

	swallowed, err := worker.Run("exit 7 | head -n 5", time.Second, 1024)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if swallowed.ExitCode != 0 {
		t.Fatalf("파이프는 마지막 명령의 상태다(이 사실이 바뀌면 목록 명령 규약을 다시 봐야 한다): %+v", swallowed)
	}

	// 렌더러가 쓰는 회피법: 출력을 변수로 받고 상태를 되돌린다.
	kept, err := worker.Run(`out=$(printf 'a\nb\n'; exit 7); rc=$?; printf '%s\n' "$out" | head -n 5; exit $rc`,
		time.Second, 1024)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if kept.ExitCode != 7 {
		t.Fatalf("상태를 되돌려야 한다: %+v", kept)
	}
	if !strings.HasPrefix(string(kept.Stdout), "a\nb\n") {
		t.Fatalf("출력은 그대로여야 한다: %q", kept.Stdout)
	}
}
