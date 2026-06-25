package sshcmd

import (
	"bytes"
	"errors"
	"fmt"
	"io"
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
		cmd := exec.Command("sh", "-s")
		stdin, err := cmd.StdinPipe()
		if err != nil {
			return nil, err
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			_ = stdin.Close()
			return nil, err
		}
		cmd.Stderr = io.Discard
		if err := cmd.Start(); err != nil {
			_ = stdin.Close()
			return nil, err
		}
		done := make(chan error, 1)
		go func() {
			done <- cmd.Wait()
		}()
		return &completionWorkerProcess{
			stdin:  stdin,
			stdout: stdout,
			close: func() error {
				_ = stdin.Close()
				if cmd.Process != nil {
					_ = cmd.Process.Kill()
				}
				select {
				case <-done:
				case <-time.After(time.Second):
				}
				return nil
			},
		}, nil
	})
	return worker, &starts
}
