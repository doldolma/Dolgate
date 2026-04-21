package http

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

type AwsSsmRuntime struct {
	Enabled                    bool
	AWSPath                    string
	SessionManagerPluginPath   string
	MissingTools               []string
	AwsSsoBrowserFlowSupported bool
	AwsSsoBrowserFlowReason    string
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
	result.AwsSsoBrowserFlowSupported, result.AwsSsoBrowserFlowReason = detectAwsSsoBrowserFlowSupport(result.AWSPath)
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

func detectAwsSsoBrowserFlowSupport(awsPath string) (bool, string) {
	if strings.TrimSpace(awsPath) == "" {
		return false, "aws executable not found"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(
		ctx,
		awsPath,
		"sso-oidc",
		"register-client",
		"--region", "us-east-1",
		"--client-name", "dolgate-runtime-probe",
		"--client-type", "public",
		"--issuer-url", "https://example.awsapps.com/start",
		"--redirect-uris", "http://127.0.0.1:43111/oauth/callback",
		"--grant-types", "authorization_code", "refresh_token",
		"--scopes", "sso:account:access",
		"--generate-cli-skeleton", "output",
	)
	cmd.Env = append(os.Environ(), "AWS_PAGER=", "AWS_CLI_AUTO_PROMPT=off")
	output, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return false, "AWS CLI mobile SSO probe timed out"
	}
	if err != nil {
		reason := strings.TrimSpace(string(output))
		if reason == "" {
			reason = err.Error()
		}
		return false, fmt.Sprintf("AWS CLI mobile SSO probe failed: %s", reason)
	}

	return true, ""
}
