//go:build windows

package awssession

import (
	"os"
	"path/filepath"
	"testing"
)

func setTestConPTYWrapperPath(t *testing.T) {
	t.Helper()

	wrapperPath := filepath.Join(t.TempDir(), conPTYWrapperBinaryName)
	if err := os.WriteFile(wrapperPath, []byte("test wrapper"), 0o600); err != nil {
		t.Fatalf("write wrapper fixture: %v", err)
	}
	t.Setenv(conPTYWrapperPathEnv, wrapperPath)
}
