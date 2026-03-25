package awstools

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestExecutableCandidatesIncludesDarwinFallbacks(t *testing.T) {
	candidates := ExecutableCandidates(
		"session-manager-plugin",
		strings.Join([]string{"/custom/bin", "/usr/bin"}, string(os.PathListSeparator)),
		"darwin",
	)

	expected := []string{
		"/custom/bin/session-manager-plugin",
		"/usr/bin/session-manager-plugin",
		"/usr/local/bin/session-manager-plugin",
		"/usr/local/sessionmanagerplugin/bin/session-manager-plugin",
		"/opt/homebrew/bin/session-manager-plugin",
		"/bin/session-manager-plugin",
	}

	for _, candidate := range expected {
		if !contains(candidates, candidate) {
			t.Fatalf("candidates = %#v, want %q", candidates, candidate)
		}
	}
}

func TestResolveExecutableWithFallsBackToKnownDarwinPaths(t *testing.T) {
	resolved, err := ResolveExecutableWith(
		"aws",
		"/usr/bin:/bin",
		"darwin",
		func(string) (string, error) {
			return "", exec.ErrNotFound
		},
		func(candidate string) bool {
			return candidate == "/opt/homebrew/bin/aws"
		},
		nil,
	)
	if err != nil {
		t.Fatalf("ResolveExecutableWith() error = %v", err)
	}
	if resolved != "/opt/homebrew/bin/aws" {
		t.Fatalf("resolved = %q", resolved)
	}
}

func TestResolveExecutableWithLogsDiagnosticDetailsWhenMissing(t *testing.T) {
	var diagnostics bytes.Buffer

	_, err := ResolveExecutableWith(
		"session-manager-plugin",
		"/usr/bin:/bin",
		"darwin",
		func(string) (string, error) {
			return "", errors.New("missing")
		},
		func(string) bool { return false },
		&diagnostics,
	)
	if !errors.Is(err, exec.ErrNotFound) {
		t.Fatalf("error = %v, want exec.ErrNotFound", err)
	}

	output := diagnostics.String()
	if !strings.Contains(output, "command=session-manager-plugin") {
		t.Fatalf("diagnostics = %q", output)
	}
	if !strings.Contains(output, `PATH="/usr/bin:/bin"`) {
		t.Fatalf("diagnostics = %q", output)
	}
	if !strings.Contains(output, "/usr/local/sessionmanagerplugin/bin/session-manager-plugin") {
		t.Fatalf("diagnostics = %q", output)
	}
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
