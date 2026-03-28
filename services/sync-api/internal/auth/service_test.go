package auth

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"dolssh/services/sync-api/internal/store"
)

func newTestService(t *testing.T) (*Service, store.Store) {
	t.Helper()

	tempDir := t.TempDir()
	backingStore, err := store.OpenSQLite(filepath.Join(tempDir, "auth-test.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	t.Cleanup(func() {
		if err := backingStore.Close(); err != nil {
			t.Fatalf("Close() error = %v", err)
		}
	})

	service, err := NewService(
		backingStore,
		"",
		filepath.Join(tempDir, "auth-signing-private.pem"),
		15*time.Minute,
		14*24*time.Hour,
		72*time.Hour,
		2*time.Minute,
	)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service, backingStore
}

func TestSignupLoginRefreshAndLogoutLifecycle(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService(t)

	user, signupSession, err := service.Signup(ctx, "user@example.com", "hunter2", "https://ssh.doldolma.com")
	if err != nil {
		t.Fatalf("Signup() error = %v", err)
	}
	if user.Email != "user@example.com" || signupSession.User.ID == "" {
		t.Fatalf("signup result = %+v / %+v", user, signupSession)
	}

	loginUser, loginSession, err := service.Login(ctx, "user@example.com", "hunter2", "https://ssh.doldolma.com")
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

	refreshed, err := service.Refresh(ctx, loginSession.Tokens.RefreshToken, "https://ssh.doldolma.com")
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if refreshed.Tokens.RefreshToken == loginSession.Tokens.RefreshToken {
		t.Fatal("Refresh() did not rotate the refresh token")
	}

	if _, err := service.Refresh(ctx, loginSession.Tokens.RefreshToken, "https://ssh.doldolma.com"); err != nil {
		t.Fatalf("Refresh(old token during handoff) error = %v", err)
	}

	if err := service.Logout(ctx, refreshed.Tokens.RefreshToken); err != nil {
		t.Fatalf("Logout() error = %v", err)
	}
	if _, err := service.Refresh(ctx, refreshed.Tokens.RefreshToken, "https://ssh.doldolma.com"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Refresh(logged out token) error = %v, want %v", err, ErrInvalidCredentials)
	}
}

func TestRefreshAllowsSupersededTokenOnlyDuringHandoffWindow(t *testing.T) {
	ctx := context.Background()
	service, backingStore := newTestService(t)

	_, session, err := service.Signup(ctx, "handoff@example.com", "hunter2", "https://ssh.doldolma.com")
	if err != nil {
		t.Fatalf("Signup() error = %v", err)
	}

	if _, err := service.Refresh(ctx, session.Tokens.RefreshToken, "https://ssh.doldolma.com"); err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}

	record, err := backingStore.GetRefreshToken(ctx, hashToken(session.Tokens.RefreshToken))
	if err != nil {
		t.Fatalf("GetRefreshToken(old token) error = %v", err)
	}
	pastGrace := time.Now().Add(-time.Minute)
	record.GraceUntil = &pastGrace
	if err := backingStore.SaveRefreshToken(ctx, record); err != nil {
		t.Fatalf("SaveRefreshToken(old token) error = %v", err)
	}

	if _, err := service.Refresh(ctx, session.Tokens.RefreshToken, "https://ssh.doldolma.com"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Refresh(expired handoff token) error = %v, want %v", err, ErrInvalidCredentials)
	}
}

func TestSessionBootstrapIncludesOfflineLeaseBoundedByRefreshExpiry(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService(t)

	_, session, err := service.Signup(ctx, "lease@example.com", "hunter2", "https://ssh.doldolma.com")
	if err != nil {
		t.Fatalf("Signup() error = %v", err)
	}
	if session.OfflineLease.Token == "" || session.OfflineLease.VerificationPublicKeyPEM == "" {
		t.Fatalf("offline lease = %+v", session.OfflineLease)
	}

	claims := &OfflineLeaseClaims{}
	parsed, err := jwt.ParseWithClaims(session.OfflineLease.Token, claims, func(token *jwt.Token) (any, error) {
		return &service.signingKey.PublicKey, nil
	})
	if err != nil {
		t.Fatalf("ParseWithClaims() error = %v", err)
	}
	if !parsed.Valid {
		t.Fatal("offline lease token is invalid")
	}
	if claims.Issuer != "https://ssh.doldolma.com" {
		t.Fatalf("claims.Issuer = %q, want %q", claims.Issuer, "https://ssh.doldolma.com")
	}
	if claims.Subject != session.User.ID {
		t.Fatalf("claims.Subject = %q, want %q", claims.Subject, session.User.ID)
	}
	hasDesktopAudience := false
	for _, audience := range claims.Audience {
		if audience == "dolgate-desktop" {
			hasDesktopAudience = true
			break
		}
	}
	if !hasDesktopAudience {
		t.Fatalf("claims.Audience = %+v, want dolgate-desktop", claims.Audience)
	}

	leaseExpiresAt, err := time.Parse(time.RFC3339, session.OfflineLease.ExpiresAt)
	if err != nil {
		t.Fatalf("time.Parse(lease expiry) error = %v", err)
	}
	maxAllowed := time.Now().Add(72 * time.Hour).Add(5 * time.Second)
	if leaseExpiresAt.After(maxAllowed) {
		t.Fatalf("lease expiry = %s, want within 72h", leaseExpiresAt.Format(time.RFC3339))
	}
}

func TestLoginRejectsInvalidCredentials(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService(t)

	if _, _, err := service.Signup(ctx, "user@example.com", "hunter2", "https://ssh.doldolma.com"); err != nil {
		t.Fatalf("Signup() error = %v", err)
	}

	if _, _, err := service.Login(ctx, "user@example.com", "wrong-password", "https://ssh.doldolma.com"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Login(wrong password) error = %v, want %v", err, ErrInvalidCredentials)
	}

	if _, _, err := service.Login(ctx, "missing@example.com", "hunter2", "https://ssh.doldolma.com"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Login(missing user) error = %v, want %v", err, ErrInvalidCredentials)
	}
}

func TestExchangeCodeIsSingleUse(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService(t)

	user, _, err := service.Signup(ctx, "exchange@example.com", "hunter2", "https://ssh.doldolma.com")
	if err != nil {
		t.Fatalf("Signup() error = %v", err)
	}

	code, err := service.IssueExchangeCode(ctx, user)
	if err != nil {
		t.Fatalf("IssueExchangeCode() error = %v", err)
	}

	session, err := service.ExchangeCode(ctx, code, "https://ssh.doldolma.com")
	if err != nil {
		t.Fatalf("ExchangeCode() error = %v", err)
	}
	if session.User.ID != user.ID {
		t.Fatalf("ExchangeCode().User.ID = %q, want %q", session.User.ID, user.ID)
	}

	if _, err := service.ExchangeCode(ctx, code, "https://ssh.doldolma.com"); !errors.Is(err, ErrInvalidExchangeCode) {
		t.Fatalf("ExchangeCode(second use) error = %v, want %v", err, ErrInvalidExchangeCode)
	}
}

func TestBrowserLoginStateRoundTrip(t *testing.T) {
	service, _ := newTestService(t)

	token, err := service.NewBrowserLoginState("desktop", "dolgate://auth/callback", "state-123")
	if err != nil {
		t.Fatalf("NewBrowserLoginState() error = %v", err)
	}

	state, err := service.ParseBrowserLoginState(token)
	if err != nil {
		t.Fatalf("ParseBrowserLoginState() error = %v", err)
	}
	if state.Client != "desktop" || state.RedirectURI != "dolgate://auth/callback" || state.State != "state-123" {
		t.Fatalf("state = %+v", state)
	}
}

func TestNewServiceGeneratesAndReusesSigningKeyFile(t *testing.T) {
	tempDir := t.TempDir()
	backingStore, err := store.OpenSQLite(filepath.Join(tempDir, "auth-test.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	t.Cleanup(func() {
		if err := backingStore.Close(); err != nil {
			t.Fatalf("Close() error = %v", err)
		}
	})

	keyPath := filepath.Join(tempDir, "auth-signing-private.pem")
	firstService, err := NewService(backingStore, "", keyPath, 15*time.Minute, 14*24*time.Hour, 72*time.Hour, 2*time.Minute)
	if err != nil {
		t.Fatalf("first NewService() error = %v", err)
	}
	firstKeyBytes, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("os.ReadFile() error = %v", err)
	}
	if len(firstKeyBytes) == 0 {
		t.Fatal("expected generated key file to be non-empty")
	}

	secondService, err := NewService(backingStore, "", keyPath, 15*time.Minute, 14*24*time.Hour, 72*time.Hour, 2*time.Minute)
	if err != nil {
		t.Fatalf("second NewService() error = %v", err)
	}
	if firstService.signingPublicKeyPEM != secondService.signingPublicKeyPEM {
		t.Fatalf("expected signing public key PEM reuse, got %q vs %q", firstService.signingPublicKeyPEM, secondService.signingPublicKeyPEM)
	}
}
