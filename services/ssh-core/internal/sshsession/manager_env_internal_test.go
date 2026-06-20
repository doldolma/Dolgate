package sshsession

import (
	"testing"

	"dolssh/services/ssh-core/internal/protocol"
)

func TestBuildEnvExportFallback(t *testing.T) {
	got := buildEnvExportFallback([]protocol.EnvVar{
		{Key: "FOO", Value: "bar"},
		{Key: "TOKEN", Value: "a b'c"},
		{Key: "", Value: "skip-empty-key"},
	})
	// 값에 공백/작은따옴표가 있어도 QuotePosix로 안전하게 감싸야 한다.
	want := "export FOO='bar'\r" + `export TOKEN='a b'"'"'c'` + "\r"
	if got != want {
		t.Fatalf("unexpected fallback:\n got: %q\nwant: %q", got, want)
	}

	if buildEnvExportFallback(nil) != "" {
		t.Fatalf("nil env should produce empty string")
	}
}
