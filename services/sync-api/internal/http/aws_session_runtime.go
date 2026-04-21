package http

import (
	"os/exec"
)

type AwsSsmRuntime struct {
	Enabled                  bool
	AWSPath                  string
	SessionManagerPluginPath string
	MissingTools             []string
}

func DetectAwsSsmRuntime() AwsSsmRuntime {
	result := AwsSsmRuntime{
		AWSPath:                  resolveExecutablePath("aws"),
		SessionManagerPluginPath: resolveExecutablePath("session-manager-plugin"),
	}

	if result.AWSPath == "" {
		result.MissingTools = append(result.MissingTools, "aws")
	}
	if result.SessionManagerPluginPath == "" {
		result.MissingTools = append(result.MissingTools, "session-manager-plugin")
	}
	result.Enabled = len(result.MissingTools) == 0
	return result
}

func resolveExecutablePath(command string) string {
	path, err := exec.LookPath(command)
	if err != nil {
		return ""
	}
	return path
}
