//go:build windows

package awssession

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
