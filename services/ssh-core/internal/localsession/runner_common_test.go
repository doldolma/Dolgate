package localsession

import (
	"strings"
	"testing"
)

func TestBuildRuntimeEnvRemovesUnsetKeysBeforeApplyingOverrides(t *testing.T) {
	env := buildRuntimeEnv(
		[]string{
			"AWS_PROFILE=ambient",
			"AWS_DEFAULT_PROFILE=ambient-default",
			"PATH=/bin",
		},
		[]string{"AWS_PROFILE", "AWS_DEFAULT_PROFILE", "IGNORED"},
		map[string]string{
			"AWS_CONFIG_FILE":             "/app/aws/config",
			"AWS_SHARED_CREDENTIALS_FILE": "/app/aws/credentials",
		},
	)

	assertRuntimeEnvMissing(t, env, "AWS_PROFILE")
	assertRuntimeEnvMissing(t, env, "AWS_DEFAULT_PROFILE")
	assertRuntimeEnvValue(t, env, "PATH", "/bin")
	assertRuntimeEnvValue(t, env, "AWS_CONFIG_FILE", "/app/aws/config")
	assertRuntimeEnvValue(t, env, "AWS_SHARED_CREDENTIALS_FILE", "/app/aws/credentials")
}

func TestBuildRuntimeEnvAllowsOverridesAfterUnset(t *testing.T) {
	env := buildRuntimeEnv(
		[]string{"AWS_PROFILE=ambient"},
		[]string{"AWS_PROFILE"},
		map[string]string{"AWS_PROFILE": "managed"},
	)

	assertRuntimeEnvValue(t, env, "AWS_PROFILE", "managed")
}

func TestBuildRuntimeEnvKeepsBaseWhenNoUnsetOrOverrides(t *testing.T) {
	base := []string{"PATH=/bin", "TERM=xterm-256color"}
	env := buildRuntimeEnv(base, nil, nil)

	if strings.Join(env, "\n") != strings.Join(base, "\n") {
		t.Fatalf("env = %#v, want %#v", env, base)
	}
}

func assertRuntimeEnvValue(t *testing.T, env []string, key string, expected string) {
	t.Helper()
	for _, entry := range env {
		entryKey, value, found := strings.Cut(entry, "=")
		if found && entryKey == key {
			if value != expected {
				t.Fatalf("%s = %q, want %q in %#v", key, value, expected, env)
			}
			return
		}
	}
	t.Fatalf("expected %s to be present in %#v", key, env)
}

func assertRuntimeEnvMissing(t *testing.T, env []string, key string) {
	t.Helper()
	for _, entry := range env {
		entryKey, value, found := strings.Cut(entry, "=")
		if found && entryKey == key {
			t.Fatalf("expected %s to be missing, got %q in %#v", key, value, env)
		}
	}
}
