//go:build windows

package hostsoverride

import (
	"fmt"
	"os"
	"path/filepath"
)

func writeManagedHostsFile(targetPath string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return fmt.Errorf("create hosts directory: %w", err)
	}

	file, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("open hosts file: %w", err)
	}

	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		return fmt.Errorf("write hosts file: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("sync hosts file: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close hosts file: %w", err)
	}
	return nil
}
