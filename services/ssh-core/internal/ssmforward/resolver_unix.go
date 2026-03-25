//go:build !windows

package ssmforward

import (
	"fmt"

	"dolssh/services/ssh-core/internal/awstools"
)

func resolveRuntimeTools() (string, string, error) {
	return resolveRuntimeToolsWithResolver(resolveExecutable)
}

func resolveRuntimeToolsWithResolver(resolver func(string) (string, error)) (string, string, error) {
	awsPath, err := resolver("aws")
	if err != nil {
		return "", "", fmt.Errorf("AWS CLI가 설치되어 있지 않습니다. `aws --version`이 동작해야 합니다.")
	}
	pluginPath, err := resolver("session-manager-plugin")
	if err != nil {
		return "", "", fmt.Errorf("AWS Session Manager Plugin이 설치되어 있지 않아 SSM 포워딩을 시작할 수 없습니다.")
	}
	return awsPath, pluginPath, nil
}

func resolveExecutable(command string) (string, error) {
	return awstools.ResolveExecutable(command)
}

func processPlatformIsWindows() bool {
	return false
}
