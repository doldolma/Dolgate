//go:build !windows

package main

func defaultHostsFilePath() string {
	return "/etc/hosts"
}
