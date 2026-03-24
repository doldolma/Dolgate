//go:build !windows

package awssession

import "os/exec"

func resolveRuntimeToolPath(command string) (string, error) {
	return exec.LookPath(command)
}

func runtimeEnvPathCaseInsensitive() bool {
	return false
}
