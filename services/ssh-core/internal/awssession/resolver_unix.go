//go:build !windows

package awssession

import "dolssh/services/ssh-core/internal/awstools"

func resolveRuntimeToolPath(command string) (string, error) {
	return awstools.ResolveExecutable(command)
}

func runtimeEnvPathCaseInsensitive() bool {
	return false
}

func resolveConPTYWrapperPath() (string, error) {
	return "", nil
}
