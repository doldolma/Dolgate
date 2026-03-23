package auth

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"dolssh/services/sync-api/internal/store"
)

func newTestService(t *testing.T) (*Service, store.Store) {
	t.Helper()

	backingStore, err := store.OpenSQLite(filepath.Join(t.TempDir(), "auth-test.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}

	return NewService(backingStore, "test-secret", 15*time.Minute, 14*24*time.Hour), backingStore
}

func TestSignupLoginRefreshAndLogoutLifecycle(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService(t)

	user, signupSession, err := service.Signup(ctx, "user@example.com", "hunter2")
	if err != nil {
		t.Fatalf("Signup() error = %v", err)
	}
	if user.Email != "user@example.com" || signupSession.User.ID == "" {
		t.Fatalf("signup result = %+v / %+v", user, signupSession)
	}

	loginUser, loginSession, err := service.Login(ctx, "user@example.com", "hunter2")
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}
	if loginUser.ID != user.ID {
		t.Fatalf("login user id = %q, want %q", loginUser.ID, user.ID)
	}

	claims, err := service.ParseAccessToken(loginSession.Tokens.AccessToken)
	if err != nil {
		t.Fatalf("ParseAccessToken() error = %v", err)
	}
	if claims.UserID != user.ID || claims.Email != user.Email {
		t.Fatalf("claims = %+v, want user %q", claims, user.ID)
	}

	refreshed, err := service.Refresh(ctx, loginSession.Tokens.RefreshToken)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if refreshed.Tokens.RefreshToken == loginSession.Tokens.RefreshToken {
		t.Fatal("Refresh() did not rotate the refresh token")
	}

	if _, err := service.Refresh(ctx, loginSession.Tokens.RefreshToken); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Refresh(old token) error = %v, want %v", err, ErrInvalidCredentials)
	}

	if err := service.Logout(ctx, refreshed.Tokens.RefreshToken); err != nil {
		t.Fatalf("Logout() error = %v", err)
	}
	if _, err := service.Refresh(ctx, refreshed.Tokens.RefreshToken); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Refresh(logged out token) error = %v, want %v", err, ErrInvalidCredentials)
	}
}

func TestLoginRejectsInvalidCredentials(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService(t)

	if _, _, err := service.Signup(ctx, "user@example.com", "hunter2"); err != nil {
		t.Fatalf("Signup() error = %v", err)
	}

	if _, _, err := service.Login(ctx, "user@example.com", "wrong-password"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Login(wrong password) error = %v, want %v", err, ErrInvalidCredentials)
	}

	if _, _, err := service.Login(ctx, "missing@example.com", "hunter2"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Login(missing user) error = %v, want %v", err, ErrInvalidCredentials)
	}
}

func TestExchangeCodeIsSingleUse(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService(t)

	user, _, err := service.Signup(ctx, "exchange@example.com", "hunter2")
	if err != nil {
		t.Fatalf("Signup() error = %v", err)
	}

	code, err := service.IssueExchangeCode(ctx, user)
	if err != nil {
		t.Fatalf("IssueExchangeCode() error = %v", err)
	}

	session, err := service.ExchangeCode(ctx, code)
	if err != nil {
		t.Fatalf("ExchangeCode() error = %v", err)
	}
	if session.User.ID != user.ID {
		t.Fatalf("ExchangeCode().User.ID = %q, want %q", session.User.ID, user.ID)
	}

	if _, err := service.ExchangeCode(ctx, code); !errors.Is(err, ErrInvalidExchangeCode) {
		t.Fatalf("ExchangeCode(second use) error = %v, want %v", err, ErrInvalidExchangeCode)
	}
}

func TestBrowserLoginStateRoundTrip(t *testing.T) {
	service, _ := newTestService(t)

	token, err := service.NewBrowserLoginState("desktop", "dolssh://auth/callback", "state-123")
	if err != nil {
		t.Fatalf("NewBrowserLoginState() error = %v", err)
	}

	state, err := service.ParseBrowserLoginState(token)
	if err != nil {
		t.Fatalf("ParseBrowserLoginState() error = %v", err)
	}
	if state.Client != "desktop" || state.RedirectURI != "dolssh://auth/callback" || state.State != "state-123" {
		t.Fatalf("state = %+v", state)
	}
}
