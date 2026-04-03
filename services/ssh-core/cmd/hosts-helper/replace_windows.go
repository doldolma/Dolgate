//go:build windows

package main

import "golang.org/x/sys/windows"

func replaceFile(fromPath, toPath string) error {
	from, err := windows.UTF16PtrFromString(fromPath)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(toPath)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
