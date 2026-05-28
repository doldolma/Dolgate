//go:build !windows

package localsession

import (
	"strings"
	"testing"
)

func TestEnsureUnixTerminalEnvAddsTermAndDarwinUTF8Locale(t *testing.T) {
	env := ensureUnixTerminalEnvForTest([]string{"PATH=/bin"}, "darwin")

	assertEnvValue(t, env, "PATH", "/bin")
	assertEnvValue(t, env, "TERM", "xterm-256color")
	assertEnvValue(t, env, "LC_CTYPE", "UTF-8")
}

func TestEnsureUnixTerminalEnvUsesLinuxUTF8Fallback(t *testing.T) {
	env := ensureUnixTerminalEnvForTest([]string{"PATH=/bin"}, "linux")

	assertEnvValue(t, env, "LC_CTYPE", "C.UTF-8")
}

func TestEnsureUnixTerminalEnvDoesNotAddLocaleWhenLangIsUTF8(t *testing.T) {
	env := ensureUnixTerminalEnvForTest([]string{"TERM=xterm-256color", "LANG=ko_KR.UTF-8"}, "darwin")

	assertEnvValue(t, env, "LANG", "ko_KR.UTF-8")
	assertEnvKeyMissing(t, env, "LC_CTYPE")
	assertEnvKeyCount(t, env, "TERM", 1)
}

func TestEnsureUnixTerminalEnvKeepsExistingUTF8LcCtype(t *testing.T) {
	env := ensureUnixTerminalEnvForTest([]string{"LC_CTYPE=UTF-8"}, "darwin")

	assertEnvValue(t, env, "LC_CTYPE", "UTF-8")
	assertEnvKeyCount(t, env, "LC_CTYPE", 1)
}

func TestEnsureUnixTerminalEnvRespectsLcAll(t *testing.T) {
	env := ensureUnixTerminalEnvForTest([]string{"LC_ALL=C"}, "darwin")

	assertEnvValue(t, env, "LC_ALL", "C")
	assertEnvKeyMissing(t, env, "LC_CTYPE")
}

func TestEnsureUnixTerminalEnvReplacesEmptyTermAndLcCtype(t *testing.T) {
	env := ensureUnixTerminalEnvForTest([]string{"TERM=", "LC_CTYPE="}, "darwin")

	assertEnvValue(t, env, "TERM", "xterm-256color")
	assertEnvValue(t, env, "LC_CTYPE", "UTF-8")
	assertEnvKeyCount(t, env, "TERM", 1)
	assertEnvKeyCount(t, env, "LC_CTYPE", 1)
}

func ensureUnixTerminalEnvForTest(env []string, goos string) []string {
	nextEnv := append([]string(nil), env...)
	nextEnv = ensureEnvDefault(nextEnv, "TERM", "xterm-256color")
	return ensureUnixLocaleEnv(nextEnv, goos)
}

func assertEnvValue(t *testing.T, env []string, key, expected string) {
	t.Helper()
	value, found := envValue(env, key)
	if !found {
		t.Fatalf("expected %s to be present in %v", key, env)
	}
	if value != expected {
		t.Fatalf("expected %s=%q, got %q in %v", key, expected, value, env)
	}
}

func assertEnvKeyMissing(t *testing.T, env []string, key string) {
	t.Helper()
	if value, found := envValue(env, key); found {
		t.Fatalf("expected %s to be missing, got %q in %v", key, value, env)
	}
}

func assertEnvKeyCount(t *testing.T, env []string, key string, expected int) {
	t.Helper()
	count := 0
	for _, entry := range env {
		entryKey, _, found := strings.Cut(entry, "=")
		if found && entryKey == key {
			count++
		}
	}
	if count != expected {
		t.Fatalf("expected %s count %d, got %d in %v", key, expected, count, env)
	}
}
