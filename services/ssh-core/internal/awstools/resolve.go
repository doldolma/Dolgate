package awstools

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type lookPathFunc func(string) (string, error)
type pathExistsFunc func(string) bool

func ResolveExecutable(command string) (string, error) {
	return ResolveExecutableWith(
		command,
		os.Getenv("PATH"),
		runtime.GOOS,
		exec.LookPath,
		unixExecutableExists,
		os.Stderr,
	)
}

func ResolveExecutableWith(
	command string,
	pathValue string,
	goos string,
	lookPath lookPathFunc,
	pathExists pathExistsFunc,
	diagnostics io.Writer,
) (string, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return "", exec.ErrNotFound
	}

	if lookPath == nil {
		lookPath = func(string) (string, error) {
			return "", exec.ErrNotFound
		}
	}
	if pathExists == nil {
		pathExists = unixExecutableExists
	}
	if diagnostics == nil {
		diagnostics = io.Discard
	}

	if resolvedPath, err := lookPath(command); err == nil && pathExists(resolvedPath) {
		return resolvedPath, nil
	}

	candidates := ExecutableCandidates(command, pathValue, goos)
	for _, candidate := range candidates {
		if pathExists(candidate) {
			return candidate, nil
		}
	}

	_, _ = fmt.Fprintf(
		diagnostics,
		"dolssh ssh-core aws tool resolver failed: command=%s PATH=%q candidates=%s\n",
		command,
		pathValue,
		strings.Join(candidates, ", "),
	)

	return "", exec.ErrNotFound
}

func ExecutableCandidates(command string, pathValue string, goos string) []string {
	candidates := make([]string, 0, 16)
	seen := make(map[string]struct{})
	appendUnique := func(candidate string) {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			return
		}
		if _, ok := seen[candidate]; ok {
			return
		}
		seen[candidate] = struct{}{}
		candidates = append(candidates, candidate)
	}

	for _, entry := range filepath.SplitList(pathValue) {
		appendUnique(filepath.Join(entry, command))
	}
	for _, candidate := range fallbackCandidates(command, goos) {
		appendUnique(candidate)
	}

	return candidates
}

func fallbackCandidates(command string, goos string) []string {
	candidates := []string{}

	if goos == "darwin" {
		switch command {
		case "aws":
			candidates = append(candidates,
				"/opt/homebrew/bin/aws",
				"/usr/local/bin/aws",
				"/usr/bin/aws",
				"/bin/aws",
			)
		case "session-manager-plugin":
			candidates = append(candidates,
				"/usr/local/bin/session-manager-plugin",
				"/usr/local/sessionmanagerplugin/bin/session-manager-plugin",
				"/opt/homebrew/bin/session-manager-plugin",
				"/usr/bin/session-manager-plugin",
				"/bin/session-manager-plugin",
			)
		default:
			candidates = append(candidates,
				"/opt/homebrew/bin/"+command,
				"/usr/local/bin/"+command,
				"/usr/bin/"+command,
				"/bin/"+command,
			)
		}
		return candidates
	}

	return append(candidates,
		"/usr/local/bin/"+command,
		"/usr/bin/"+command,
		"/bin/"+command,
	)
}

func unixExecutableExists(candidate string) bool {
	info, err := os.Stat(candidate)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode()&0o111 != 0
}
