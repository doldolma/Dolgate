//go:build !windows

package main

import "os"

func replaceFile(fromPath, toPath string) error {
	return os.Rename(fromPath, toPath)
}
