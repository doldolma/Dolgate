//go:build windows

package awssession

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	conPTYWrapperBinaryName = "aws-conpty-wrapper.exe"
	conPTYWrapperPathEnv    = "DOLSSH_AWS_CONPTY_WRAPPER_PATH"
)

func resolveRuntimeToolPath(command string) (string, error) {
	if resolvedPath, err := exec.LookPath(command); err == nil && isWindowsExecutablePath(resolvedPath) {
		return resolvedPath, nil
	}

	for _, candidate := range runtimeToolCandidates(command) {
		if runtimeToolExists(candidate) {
			return candidate, nil
		}
	}

	return "", exec.ErrNotFound
}

func runtimeEnvPathCaseInsensitive() bool {
	return true
}

func runtimeToolCandidates(command string) []string {
	candidates := make([]string, 0, 16)
	seen := make(map[string]struct{})
	appendUnique := func(candidate string) {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			return
		}
		key := strings.ToLower(candidate)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		candidates = append(candidates, candidate)
	}

	switch command {
	case "aws":
		appendUnique(`C:\Program Files\Amazon\AWSCLIV2\aws.exe`)
	case "session-manager-plugin":
		appendUnique(`C:\Program Files\Amazon\SessionManagerPlugin\bin\session-manager-plugin.exe`)
	}

	for _, entry := range filepath.SplitList(os.Getenv("PATH")) {
		appendUnique(filepath.Join(entry, command+".exe"))
	}

	return candidates
}

func runtimeToolExists(candidate string) bool {
	info, err := os.Stat(candidate)
	return err == nil && !info.IsDir() && isWindowsExecutablePath(candidate)
}

func isWindowsExecutablePath(candidate string) bool {
	return strings.EqualFold(filepath.Ext(candidate), ".exe")
}

func resolveConPTYWrapperPath() (string, error) {
	if override := strings.TrimSpace(os.Getenv(conPTYWrapperPathEnv)); override != "" {
		if runtimeToolExists(override) {
			return override, nil
		}
		return "", fmt.Errorf("aws conpty wrapper not found: %s", override)
	}

	currentExecutable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve ssh-core executable path: %w", err)
	}

	candidate := filepath.Join(filepath.Dir(currentExecutable), conPTYWrapperBinaryName)
	if runtimeToolExists(candidate) {
		return candidate, nil
	}

	return "", fmt.Errorf("aws conpty wrapper not found next to ssh-core: %s", candidate)
}
