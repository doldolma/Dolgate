package awssession

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dolssh/services/ssh-core/internal/protocol"
)

func TestResolveAWSRuntimeWithResolverBuildsRuntimeArgsAndEnv(t *testing.T) {
	setTestConPTYWrapperPath(t)

	t.Setenv("PATH", strings.Join([]string{
		filepath.Join("existing", "bin"),
		filepath.Join("second", "bin"),
	}, string(os.PathListSeparator)))

	runtime, err := resolveAWSRuntimeWithResolver(protocol.AWSConnectPayload{
		ProfileName: "default",
		Region:      "ap-northeast-2",
		InstanceID:  "i-1234567890",
	}, func(command string) (string, error) {
		switch command {
		case "aws":
			return filepath.Join("tools", "aws", "aws"), nil
		case "session-manager-plugin":
			return filepath.Join("tools", "plugin", "session-manager-plugin"), nil
		default:
			return "", errors.New("unexpected command")
		}
	})
	if err != nil {
		t.Fatalf("resolve runtime failed: %v", err)
	}

	if runtime.executablePath != filepath.Join("tools", "aws", "aws") {
		t.Fatalf("executablePath = %q", runtime.executablePath)
	}

	expectedArgs := []string{
		"ssm",
		"start-session",
		"--target",
		"i-1234567890",
		"--profile",
		"default",
		"--region",
		"ap-northeast-2",
	}
	if strings.Join(runtime.args, "\x00") != strings.Join(expectedArgs, "\x00") {
		t.Fatalf("args = %#v", runtime.args)
	}

	pathValue := lookupEnvValue(runtime.env, "PATH")
	if pathValue == "" {
		t.Fatal("PATH was not propagated into child env")
	}

	entries := strings.Split(pathValue, string(os.PathListSeparator))
	if len(entries) < 4 {
		t.Fatalf("PATH entries = %#v", entries)
	}
	if entries[0] != filepath.Join("tools", "aws") {
		t.Fatalf("first PATH entry = %q", entries[0])
	}
	if entries[1] != filepath.Join("tools", "plugin") {
		t.Fatalf("second PATH entry = %q", entries[1])
	}
}

func TestResolveAWSRuntimeWithResolverReturnsExplicitMissingToolErrors(t *testing.T) {
	setTestConPTYWrapperPath(t)

	payload := protocol.AWSConnectPayload{
		ProfileName: "default",
		Region:      "us-east-1",
		InstanceID:  "i-test",
	}

	_, err := resolveAWSRuntimeWithResolver(payload, func(command string) (string, error) {
		if command == "aws" {
			return "", errors.New("missing")
		}
		return filepath.Join("tools", "plugin", "session-manager-plugin"), nil
	})
	if err == nil || err.Error() != "AWS CLI가 설치되어 있지 않습니다. `aws --version`이 동작해야 합니다." {
		t.Fatalf("unexpected aws error: %v", err)
	}

	_, err = resolveAWSRuntimeWithResolver(payload, func(command string) (string, error) {
		if command == "aws" {
			return filepath.Join("tools", "aws", "aws"), nil
		}
		return "", errors.New("missing")
	})
	if err == nil || err.Error() != "AWS Session Manager Plugin이 설치되어 있지 않아 SSM 세션을 열 수 없습니다." {
		t.Fatalf("unexpected plugin error: %v", err)
	}
}

func lookupEnvValue(env []string, key string) string {
	for _, entry := range env {
		parts := strings.SplitN(entry, "=", 2)
		if len(parts) != 2 {
			continue
		}
		if envKeyMatches(parts[0], key, runtimeEnvPathCaseInsensitive()) {
			return parts[1]
		}
	}
	return ""
}
