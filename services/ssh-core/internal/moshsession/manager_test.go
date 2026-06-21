package moshsession

import (
	"strings"
	"testing"
	"time"

	"dolssh/services/ssh-core/internal/protocol"
)

func TestParseMoshConnect(t *testing.T) {
	port, key, err := parseMoshConnect([]byte("\r\nMOSH CONNECT 60001 4NeCCgvZFe2RnPgrcU1PQw\r\n"))
	if err != nil {
		t.Fatalf("parseMoshConnect() error = %v", err)
	}
	if port != 60001 {
		t.Fatalf("port = %d, want 60001", port)
	}
	if key != "4NeCCgvZFe2RnPgrcU1PQw" {
		t.Fatalf("key = %q, want 4NeCCgvZFe2RnPgrcU1PQw", key)
	}
}

func TestParseMoshConnectEmbeddedInNoise(t *testing.T) {
	// mosh-server may print banners / locale warnings around the MOSH CONNECT line.
	out := []byte("mosh-server (mosh 1.4.0)\nMOSH CONNECT 1234 abcDEF123\nMosh server now listening\n")
	port, key, err := parseMoshConnect(out)
	if err != nil || port != 1234 || key != "abcDEF123" {
		t.Fatalf("got port=%d key=%q err=%v", port, key, err)
	}
}

func TestParseMoshConnectFailure(t *testing.T) {
	if _, _, err := parseMoshConnect([]byte("bash: mosh-server: command not found\n")); err == nil {
		t.Fatal("expected error when MOSH CONNECT is absent")
	}
}

func TestMoshStateFor(t *testing.T) {
	cases := []struct {
		age  time.Duration
		want string
	}{
		{0, "connected"},
		{2 * time.Second, "connected"},
		{5 * time.Second, "reconnecting"},
		{11 * time.Second, "reconnecting"},
		{15 * time.Second, "disconnected"},
	}
	for _, tc := range cases {
		if got := moshStateFor(tc.age); got != tc.want {
			t.Fatalf("moshStateFor(%s) = %q, want %q", tc.age, got, tc.want)
		}
	}
}

func TestMoshServerCommandUsesLocaleAndFlags(t *testing.T) {
	cmd := moshServerCommand(nil)
	if !strings.Contains(cmd, "mosh-server new") {
		t.Fatalf("command missing subcommand: %q", cmd)
	}
	if !strings.Contains(cmd, "LANG=en_US.UTF-8") {
		t.Fatalf("command missing default locale: %q", cmd)
	}
}

func TestLocaleFromEnvPrefersUTF8(t *testing.T) {
	env := []protocol.EnvVar{
		{Key: "LANG", Value: "ko_KR.UTF-8"},
	}
	if got := localeFromEnv(env); got != "ko_KR.UTF-8" {
		t.Fatalf("localeFromEnv = %q, want ko_KR.UTF-8", got)
	}
	// Non-UTF-8 LANG is ignored in favor of the safe default.
	if got := localeFromEnv([]protocol.EnvVar{{Key: "LANG", Value: "C"}}); got != "en_US.UTF-8" {
		t.Fatalf("localeFromEnv(C) = %q, want en_US.UTF-8 fallback", got)
	}
}
