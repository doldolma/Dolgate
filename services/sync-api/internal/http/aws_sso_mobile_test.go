package http

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAwsSsoMobileManagerStartAndHandoff(t *testing.T) {
	t.Parallel()

	awsPath := writeFakeAWSCLI(t)
	manager := NewAwsSsoMobileManager(AwsSsmRuntime{
		AWSPath: awsPath,
	})
	request := awsSsoMobileLoginStartRequest{
		TargetProfileName:        "target-role",
		SourceProfileName:        "source-sso",
		SourceProfileFingerprint: "fingerprint-1",
		SsoStartURL:              "https://gridwiz.awsapps.com/start",
		SsoRegion:                "ap-northeast-2",
		SsoAccountID:             "123456789012",
		SsoRoleName:              "AdministratorAccess",
		RedirectURI:              "http://127.0.0.1:43111/oauth/callback",
	}

	startResponse, err := manager.Start(context.Background(), "user-1", request)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if startResponse.Status != "pending" {
		t.Fatalf("Start().Status = %q, want pending", startResponse.Status)
	}
	if startResponse.LoginID == "" {
		t.Fatal("Start().LoginID should not be empty")
	}
	if startResponse.BrowserURL == "" || !strings.Contains(startResponse.BrowserURL, "https://oidc.ap-northeast-2.amazonaws.com/authorize?") {
		t.Fatalf("Start().BrowserURL = %q", startResponse.BrowserURL)
	}
	if !strings.Contains(startResponse.BrowserURL, "redirect_uri=http%3A%2F%2F127.0.0.1%3A43111%2Foauth%2Fcallback") {
		t.Fatalf("Start().BrowserURL missing redirect URI: %q", startResponse.BrowserURL)
	}
	pending := manager.pendingByID[startResponse.LoginID]
	if pending == nil {
		t.Fatal("pending login should be stored")
	}

	handoffResponse, err := manager.Complete(context.Background(), "user-1", startResponse.LoginID, awsSsoMobileLoginHandoffRequest{
		Code:  "auth-code-1",
		State: pending.State,
	})
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if handoffResponse.Status != "ready" {
		t.Fatalf("Complete().Status = %q, want ready", handoffResponse.Status)
	}
	if handoffResponse.Credential == nil || handoffResponse.Credential.AccessKeyID != "AKIASSO" {
		t.Fatalf("Complete().Credential = %#v", handoffResponse.Credential)
	}

	cachedResponse, err := manager.Start(context.Background(), "user-1", request)
	if err != nil {
		t.Fatalf("cached Start() error = %v", err)
	}
	if cachedResponse.Status != "ready" {
		t.Fatalf("cached Start().Status = %q, want ready", cachedResponse.Status)
	}
	if cachedResponse.Credential == nil || cachedResponse.Credential.SessionToken != "sso-token" {
		t.Fatalf("cached Start().Credential = %#v", cachedResponse.Credential)
	}
}

func TestAwsSsoMobileManagerCancel(t *testing.T) {
	t.Parallel()

	awsPath := writeFakeAWSCLI(t)
	manager := NewAwsSsoMobileManager(AwsSsmRuntime{
		AWSPath: awsPath,
	})
	request := awsSsoMobileLoginStartRequest{
		TargetProfileName:        "target-role",
		SourceProfileName:        "source-sso",
		SourceProfileFingerprint: "fingerprint-1",
		SsoStartURL:              "https://gridwiz.awsapps.com/start",
		SsoRegion:                "ap-northeast-2",
		SsoAccountID:             "123456789012",
		SsoRoleName:              "AdministratorAccess",
		RedirectURI:              "http://127.0.0.1:43111/oauth/callback",
	}

	startResponse, err := manager.Start(context.Background(), "user-1", request)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if err := manager.Cancel("user-1", startResponse.LoginID); err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}

	handoffResponse, err := manager.Status("user-1", startResponse.LoginID)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if handoffResponse.Status != "cancelled" {
		t.Fatalf("Status().Status = %q, want cancelled", handoffResponse.Status)
	}
}

func writeFakeAWSCLI(t *testing.T) string {
	t.Helper()

	dir := t.TempDir()
	path := filepath.Join(dir, "aws")
	script := `#!/bin/sh
cmd1="$1"
cmd2="$2"
if [ "$cmd1" = "sso-oidc" ] && [ "$cmd2" = "register-client" ]; then
  cat <<'JSON'
{"clientId":"client-1","clientSecret":"secret-1"}
JSON
  exit 0
fi
if [ "$cmd1" = "sso-oidc" ] && [ "$cmd2" = "create-token" ]; then
  cat <<'JSON'
{"accessToken":"access-token-1","refreshToken":"refresh-token-1","expiresIn":3600}
JSON
  exit 0
fi
if [ "$cmd1" = "sso" ] && [ "$cmd2" = "get-role-credentials" ]; then
  cat <<'JSON'
{"roleCredentials":{"accessKeyId":"AKIASSO","secretAccessKey":"sso-secret","sessionToken":"sso-token","expiration":4102444800000}}
JSON
  exit 0
fi
echo "unexpected command: $*" >&2
exit 1
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	return path
}
