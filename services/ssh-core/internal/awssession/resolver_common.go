package awssession

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"dolssh/services/ssh-core/internal/protocol"
)

const processBackedFakeAWSFixtureEnv = "DOLSSH_E2E_FAKE_AWS_FIXTURE_PATH"

type runtimeToolResolver func(command string) (string, error)

type awsCommandRuntime struct {
	executablePath string
	args           []string
	env            []string
	wrapperPath    string
}

func resolveAWSRuntime(payload protocol.AWSConnectPayload) (awsCommandRuntime, error) {
	return resolveAWSRuntimeWithResolver(payload, resolveRuntimeToolPath)
}

func resolveAWSRuntimeWithResolver(payload protocol.AWSConnectPayload, resolver runtimeToolResolver) (awsCommandRuntime, error) {
	awsPath, err := resolver("aws")
	if err != nil {
		return awsCommandRuntime{}, fmt.Errorf("AWS CLI가 설치되어 있지 않습니다. `aws --version`이 동작해야 합니다.")
	}

	pluginPath, err := resolver("session-manager-plugin")
	if err != nil {
		return awsCommandRuntime{}, fmt.Errorf("AWS Session Manager Plugin이 설치되어 있지 않아 SSM 세션을 열 수 없습니다.")
	}

	wrapperPath, err := resolveConPTYWrapperPath()
	if err != nil {
		return awsCommandRuntime{}, err
	}
	return awsCommandRuntime{
		executablePath: awsPath,
		args:           buildAWSArgs(payload),
		env: buildAWSRuntimeEnv(
			os.Environ(),
			payload,
			runtimeEnvPathCaseInsensitive(),
			filepath.Dir(awsPath),
			filepath.Dir(pluginPath),
		),
		wrapperPath: wrapperPath,
	}, nil
}

func resolveProcessBackedFakeRuntime(payload protocol.AWSConnectPayload) (awsCommandRuntime, error) {
	fixturePath := strings.TrimSpace(os.Getenv(processBackedFakeAWSFixtureEnv))
	if fixturePath == "" {
		return awsCommandRuntime{}, fmt.Errorf("process-backed fake AWS session fixture path is not configured")
	}

	wrapperPath, err := resolveConPTYWrapperPath()
	if err != nil {
		return awsCommandRuntime{}, err
	}

	return awsCommandRuntime{
		executablePath: fixturePath,
		env:            buildAWSRuntimeEnv(os.Environ(), payload, runtimeEnvPathCaseInsensitive()),
		wrapperPath:    wrapperPath,
	}, nil
}

func buildAWSRuntimeEnv(baseEnv []string, payload protocol.AWSConnectPayload, caseInsensitive bool, preferredPathDirs ...string) []string {
	env := mergeRuntimeEnv(baseEnv, payload.UnsetEnv, payload.Env, caseInsensitive)
	pathValue := buildRuntimePathValue(
		lookupEnvValueInList(env, "PATH", caseInsensitive),
		caseInsensitive,
		preferredPathDirs...,
	)
	return mergeRuntimeEnv(env, nil, map[string]string{
		"PATH": pathValue,
	}, caseInsensitive)
}

func buildRuntimePathValue(rawPath string, caseInsensitive bool, preferredDirs ...string) string {
	entries := make([]string, 0, len(preferredDirs)+8)
	seen := make(map[string]struct{})
	appendUnique := func(entry string) {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			return
		}
		key := entry
		if caseInsensitive {
			key = strings.ToLower(entry)
		}
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		entries = append(entries, entry)
	}

	for _, preferredDir := range preferredDirs {
		appendUnique(preferredDir)
	}
	for _, entry := range filepath.SplitList(rawPath) {
		appendUnique(entry)
	}

	return strings.Join(entries, string(os.PathListSeparator))
}

func mergeRuntimeEnv(baseEnv []string, unsetKeys []string, envPatch map[string]string, caseInsensitive bool) []string {
	unset := make(map[string]struct{}, len(unsetKeys))
	for _, key := range unsetKeys {
		normalizedKey := normalizeEnvKey(key, caseInsensitive)
		if normalizedKey == "" {
			continue
		}
		unset[normalizedKey] = struct{}{}
	}

	entries := make([]string, 0, len(baseEnv)+len(envPatch))
	seen := make(map[string]int, len(baseEnv)+len(envPatch))
	for _, entry := range baseEnv {
		key, value, found := strings.Cut(entry, "=")
		if !found {
			continue
		}

		normalizedKey := normalizeEnvKey(key, caseInsensitive)
		if normalizedKey == "" {
			continue
		}
		if _, shouldUnset := unset[normalizedKey]; shouldUnset {
			continue
		}

		nextEntry := fmt.Sprintf("%s=%s", key, value)
		if index, ok := seen[normalizedKey]; ok {
			entries[index] = nextEntry
			continue
		}

		seen[normalizedKey] = len(entries)
		entries = append(entries, nextEntry)
	}

	if len(envPatch) == 0 {
		return entries
	}

	keys := make([]string, 0, len(envPatch))
	for key := range envPatch {
		if normalizeEnvKey(key, caseInsensitive) == "" {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)

	for _, key := range keys {
		normalizedKey := normalizeEnvKey(key, caseInsensitive)
		nextEntry := fmt.Sprintf("%s=%s", key, envPatch[key])
		if index, ok := seen[normalizedKey]; ok {
			entries[index] = nextEntry
			continue
		}

		seen[normalizedKey] = len(entries)
		entries = append(entries, nextEntry)
	}

	return entries
}

func lookupEnvValueInList(env []string, key string, caseInsensitive bool) string {
	normalizedTarget := normalizeEnvKey(key, caseInsensitive)
	for _, entry := range env {
		candidate, value, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		if normalizeEnvKey(candidate, caseInsensitive) == normalizedTarget {
			return value
		}
	}
	return ""
}

func normalizeEnvKey(key string, caseInsensitive bool) string {
	normalizedKey := strings.TrimSpace(key)
	if caseInsensitive {
		normalizedKey = strings.ToLower(normalizedKey)
	}
	return normalizedKey
}
