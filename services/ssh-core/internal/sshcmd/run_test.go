package sshcmd

import (
	"os/exec"
	"runtime"
	"strings"
	"testing"
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
