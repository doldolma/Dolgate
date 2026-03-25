package ssmforward

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestResolveRuntimeToolsWithResolverReturnsExplicitMissingToolErrors(t *testing.T) {
	_, _, err := resolveRuntimeToolsWithResolver(func(command string) (string, error) {
		if command == "aws" {
			return "", errors.New("missing")
		}
		return filepath.Join("tools", "plugin", "session-manager-plugin"), nil
	})
	if err == nil || err.Error() != "AWS CLI가 설치되어 있지 않습니다. `aws --version`이 동작해야 합니다." {
		t.Fatalf("unexpected aws error: %v", err)
	}

	_, _, err = resolveRuntimeToolsWithResolver(func(command string) (string, error) {
		if command == "aws" {
			return filepath.Join("tools", "aws", "aws"), nil
		}
		return "", errors.New("missing")
	})
	if err == nil || err.Error() != "AWS Session Manager Plugin이 설치되어 있지 않아 SSM 포워딩을 시작할 수 없습니다." {
		t.Fatalf("unexpected plugin error: %v", err)
	}
}
