//go:build !windows

package ssmforward

import (
	"fmt"
	"os/exec"
)

func resolveRuntimeTools() (string, string, error) {
	awsPath, err := resolveExecutable("aws")
	if err != nil {
		return "", "", fmt.Errorf("AWS CLI가 설치되어 있지 않습니다. `aws --version`이 동작해야 합니다.")
	}
	pluginPath, err := resolveExecutable("session-manager-plugin")
	if err != nil {
		return "", "", fmt.Errorf("AWS Session Manager Plugin이 설치되어 있지 않아 SSM 포워딩을 시작할 수 없습니다.")
	}
	return awsPath, pluginPath, nil
}

func resolveExecutable(command string) (string, error) {
	return exec.LookPath(command)
}

func processPlatformIsWindows() bool {
	return false
}
