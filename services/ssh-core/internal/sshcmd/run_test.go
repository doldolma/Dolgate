package sshcmd

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestQuotePosixRoundTripSeeds(t *testing.T) {
	for _, value := range quotePosixSeedValues() {
		t.Run(value, func(t *testing.T) {
			assertQuotePosixRoundTrip(t, value)
		})
	}
}

func FuzzQuotePosixRoundTrip(f *testing.F) {
	for _, value := range quotePosixSeedValues() {
		f.Add(value)
	}
	f.Fuzz(func(t *testing.T, value string) {
		if len(value) > 4096 || strings.ContainsRune(value, 0) {
			t.Skip()
		}
		assertQuotePosixRoundTrip(t, value)
	})
}

func quotePosixSeedValues() []string {
	return []string{
		"",
		"plain",
		"two words",
		"quote's here",
		"semi;colon",
		"$(touch /tmp/nope)",
		"`touch /tmp/nope`",
		"line\nbreak",
		"glob*.txt",
		"-rf.txt",
		"[붙임2] 전력시장운영규칙전문(260318)_PDF.pdf",
		" leading and trailing ",
	}
}

func assertQuotePosixRoundTrip(t *testing.T, value string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell quoting requires sh")
	}
	command := "printf '%s' " + QuotePosix(value)
	output, err := exec.Command("sh", "-c", command).Output()
	if err != nil {
		t.Fatalf("quoted value did not execute cleanly: %v", err)
	}
	if string(output) != value {
		t.Fatalf("quoted value round-tripped to %q, want %q", string(output), value)
	}
}

func TestCompletionWorkerReusesShell(t *testing.T) {
	worker, starts := newLocalCompletionWorker(t)
	defer worker.Close()

	first, truncated, err := worker.Run("printf 'one\\n'", time.Second, 1024)
	if err != nil || truncated || string(first) != "one\n" {
		t.Fatalf("first Run() = %q truncated=%v err=%v", first, truncated, err)
	}
	second, truncated, err := worker.Run("printf 'two\\n'", time.Second, 1024)
	if err != nil || truncated || string(second) != "two\n" {
		t.Fatalf("second Run() = %q truncated=%v err=%v", second, truncated, err)
	}
	if got := atomic.LoadInt32(starts); got != 1 {
		t.Fatalf("expected one helper shell start, got %d", got)
	}
}

func TestCompletionWorkerReturnsStdoutFromNonZeroCommand(t *testing.T) {
	worker, _ := newLocalCompletionWorker(t)
	defer worker.Close()

	output, truncated, err := worker.Run("printf 'partial\\n'; false", time.Second, 1024)
	if err != nil || truncated || string(output) != "partial\n" {
		t.Fatalf("Run() = %q truncated=%v err=%v", output, truncated, err)
	}
}

func TestCompletionWorkerTimeoutRestartsShell(t *testing.T) {
	worker, starts := newLocalCompletionWorker(t)
	defer worker.Close()

	if _, _, err := worker.Run("sleep 1", 50*time.Millisecond, 1024); err == nil {
		t.Fatal("expected timeout")
	}
	output, truncated, err := worker.Run("printf ok", time.Second, 1024)
	if err != nil || truncated || string(output) != "ok" {
		t.Fatalf("retry Run() = %q truncated=%v err=%v", output, truncated, err)
	}
	if got := atomic.LoadInt32(starts); got < 2 {
		t.Fatalf("expected helper shell restart after timeout, got %d starts", got)
	}
}

func TestCompletionWorkerReportsUnavailableStartupFailure(t *testing.T) {
	worker := newCompletionWorkerForTest(func() (*completionWorkerProcess, error) {
		return nil, fmt.Errorf("%w: helper shell refused", ErrCompletionWorkerUnavailable)
	})

	if _, _, err := worker.Run("printf nope", time.Second, 1024); !errors.Is(err, ErrCompletionWorkerUnavailable) {
		t.Fatalf("expected ErrCompletionWorkerUnavailable, got %v", err)
	}
}

func TestCompletionWorkerTruncatesAndDrainsToMarker(t *testing.T) {
	worker, _ := newLocalCompletionWorker(t)
	defer worker.Close()

	output, truncated, err := worker.Run(
		"i=0; while [ $i -lt 2048 ]; do printf x; i=$((i+1)); done",
		time.Second,
		32,
	)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if !truncated || len(output) != 32 || !bytes.Equal(output, bytes.Repeat([]byte("x"), 32)) {
		t.Fatalf("unexpected truncated output len=%d truncated=%v output=%q", len(output), truncated, output)
	}
	next, truncated, err := worker.Run("printf ok", time.Second, 1024)
	if err != nil || truncated || string(next) != "ok" {
		t.Fatalf("next Run() = %q truncated=%v err=%v", next, truncated, err)
	}
}

func TestReadCompletionFrameDropsStartupNoise(t *testing.T) {
	output, truncated, err := readCompletionFrame(
		strings.NewReader("login noise\nSTART\nreal output\nEND\n"),
		[]byte("START"),
		[]byte("END"),
		1024,
	)
	if err != nil || truncated || string(output) != "real output\n" {
		t.Fatalf("readCompletionFrame() = %q truncated=%v err=%v", output, truncated, err)
	}
}

func newLocalCompletionWorker(t *testing.T) (*CompletionWorker, *int32) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX completion worker requires sh")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh not available")
	}
	var starts int32
	worker := newCompletionWorkerForTest(func() (*completionWorkerProcess, error) {
		atomic.AddInt32(&starts, 1)
		return startLocalShell()
	})
	return worker, &starts
}

// 채널 차례를 기다리는 시간도 예산 안이어야 한다.
//
// 예전에는 Lock() 으로 무한정 기다렸다. 앞선 명령이 오래 걸리면(도커 `stats --no-stream` 은
// 컨테이너가 많은 호스트에서 수십 초다) 뒤에 선 질의는 자기 시계를 켜 보지도 못했고, 그 합이
// 데스크톱의 요청 타임아웃을 넘겨 코어가 답 자체를 못 보냈다 — 화면에는 원인을 알 수 없는
// "Timed out waiting for SSH core response" 만 쌓였다.
func TestCompletionWorkerBoundsTheWaitForItsTurn(t *testing.T) {
	worker, starts := newLocalCompletionWorker(t)
	defer worker.Close()

	blocked := make(chan struct{})
	go func() {
		defer close(blocked)
		_, _, _ = worker.Run("sleep 3", 10*time.Second, 1024)
	}()
	// 앞 명령이 채널을 잡을 때까지 기다린다(그래야 "물려 있는 동안" 을 만든다).
	deadline := time.Now().Add(3 * time.Second)
	for atomic.LoadInt32(starts) < 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	startedAt := time.Now()
	_, _, err := worker.Run("printf ok", 300*time.Millisecond, 1024)
	elapsed := time.Since(startedAt)
	if !errors.Is(err, ErrCompletionLaneBusy) {
		t.Fatalf("expected ErrCompletionLaneBusy, got %v", err)
	}
	// 예산이 300ms 였는데 앞 명령(3초)이 끝나기를 기다렸다면 이 한계를 넘는다.
	if elapsed > 2*time.Second {
		t.Fatalf("waited %s for its turn; the 300ms budget must cover the wait", elapsed)
	}
	// 차례를 못 얻었으면 채널을 새로 열지도 않는다(원격에는 아무 일도 없었다).
	if got := atomic.LoadInt32(starts); got != 1 {
		t.Fatalf("opened %d channels, want 1", got)
	}
	<-blocked
}
