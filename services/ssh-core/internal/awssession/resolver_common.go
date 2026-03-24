package awssession

import (
	"fmt"
	"os"
	"path/filepath"
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

	pathValue := buildRuntimePathValue(filepath.Dir(awsPath), filepath.Dir(pluginPath))
	wrapperPath, err := resolveConPTYWrapperPath()
	if err != nil {
		return awsCommandRuntime{}, err
	}
	return awsCommandRuntime{
		executablePath: awsPath,
		args:           buildAWSArgs(payload),
		env:            mergeChildEnv(pathValue, runtimeEnvPathCaseInsensitive()),
		wrapperPath:    wrapperPath,
	}, nil
}

func resolveProcessBackedFakeRuntime() (awsCommandRuntime, error) {
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
		env:            os.Environ(),
		wrapperPath:    wrapperPath,
	}, nil
}

func buildRuntimePathValue(preferredDirs ...string) string {
	entries := make([]string, 0, len(preferredDirs)+8)
	seen := make(map[string]struct{})
	appendUnique := func(entry string) {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			return
		}
		key := entry
		if runtimeEnvPathCaseInsensitive() {
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
	for _, entry := range filepath.SplitList(os.Getenv("PATH")) {
		appendUnique(entry)
	}

	return strings.Join(entries, string(os.PathListSeparator))
}
