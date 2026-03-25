//go:build windows

package ssmforward

import (
	"fmt"
	"os"
	"os/exec"
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
	candidates := []string{}
	switch command {
	case "aws":
		candidates = append(candidates, `C:\Program Files\Amazon\AWSCLIV2\aws.exe`)
	case "session-manager-plugin":
		candidates = append(candidates, `C:\Program Files\Amazon\SessionManagerPlugin\bin\session-manager-plugin.exe`)
	}
	if resolved, err := exec.LookPath(command); err == nil {
		return resolved, nil
	}
	if resolved, err := exec.LookPath(command + ".exe"); err == nil {
		return resolved, nil
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%s not found", command)
}

func processPlatformIsWindows() bool {
	return true
}
