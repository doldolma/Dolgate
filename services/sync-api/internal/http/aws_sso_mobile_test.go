package http

import (
	"context"
	"strings"
	"testing"
	"time"
)

// fakeAwsSsoAPI mirrors the canned responses of the old fake aws CLI fixture
// so the manager's flow logic is tested without any AWS traffic.
type fakeAwsSsoAPI struct{}

func (fakeAwsSsoAPI) RegisterClient(context.Context, awsSsoMobileLoginStartRequest) (*awsSsoRegisterClientResponse, error) {
	return &awsSsoRegisterClientResponse{ClientID: "client-1", ClientSecret: "secret-1"}, nil
}

func (fakeAwsSsoAPI) CreateAuthorizationCodeToken(context.Context, string, string, string, string, string, string) (*awsSsoCreateTokenResponse, error) {
	return &awsSsoCreateTokenResponse{
		AccessToken:  "access-token-1",
		RefreshToken: "refresh-token-1",
		ExpiresIn:    3600,
	}, nil
}

func (fakeAwsSsoAPI) CreateRefreshToken(context.Context, string, string, string, string) (*awsSsoCreateTokenResponse, error) {
	return &awsSsoCreateTokenResponse{
		AccessToken:  "access-token-2",
		RefreshToken: "refresh-token-2",
		ExpiresIn:    3600,
	}, nil
}

func (fakeAwsSsoAPI) GetRoleCredential(context.Context, string, string, string, string) (*awsTemporaryCredentialPayload, error) {
	return &awsTemporaryCredentialPayload{
		AccessKeyID:     "AKIASSO",
		SecretAccessKey: "sso-secret",
		SessionToken:    "sso-token",
		ExpiresAt:       time.UnixMilli(4102444800000).UTC().Format(time.RFC3339),
	}, nil
}

func TestAwsSsoMobileManagerStartAndHandoff(t *testing.T) {
	t.Parallel()

	manager := newAwsSsoMobileManagerWithAPI(fakeAwsSsoAPI{})
	request := awsSsoMobileLoginStartRequest{
		TargetProfileName:        "target-role",
		SourceProfileName:        "source-sso",
		SourceProfileFingerprint: "fingerprint-1",
		SsoStartURL:              "https://acme-corp.awsapps.com/start",
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

	manager := newAwsSsoMobileManagerWithAPI(fakeAwsSsoAPI{})
	request := awsSsoMobileLoginStartRequest{
		TargetProfileName:        "target-role",
		SourceProfileName:        "source-sso",
		SourceProfileFingerprint: "fingerprint-1",
		SsoStartURL:              "https://acme-corp.awsapps.com/start",
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
