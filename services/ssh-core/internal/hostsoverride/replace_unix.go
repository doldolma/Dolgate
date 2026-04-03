//go:build !windows

package hostsoverride

import "os"

func replaceFile(fromPath, toPath string) error {
	return os.Rename(fromPath, toPath)
}
