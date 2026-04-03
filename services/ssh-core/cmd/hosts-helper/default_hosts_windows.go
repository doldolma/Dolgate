//go:build windows

package main

import (
	"os"
	"path/filepath"
)

func defaultHostsFilePath() string {
	systemRoot := os.Getenv("SystemRoot")
	if systemRoot == "" {
		systemRoot = `C:\Windows`
	}
	return filepath.Join(systemRoot, "System32", "drivers", "etc", "hosts")
}
