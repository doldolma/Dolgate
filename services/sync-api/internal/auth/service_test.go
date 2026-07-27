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
		true,
	)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service, backingStore
}

func TestSignupLoginRefreshAndLogoutLifecycle(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService(t)

	user, signupSession, err := service.Signup(ctx, "user@example.com", "hunter2", "https://ssh.doldolma.com", VaultResolutionLegacy)
	if err != nil {
		t.Fatalf("Signup() error = %v", err)
	}
	if user.Email != "user@example.com" || signupSession.User.ID == "" {
		t.Fatalf("signup result = %+v / %+v", user, signupSession)
	}

	loginUser, loginSession, err := service.Login(ctx, "user@example.com", "hunter2", "https://ssh.doldolma.com", VaultResolutionLegacy)
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

	refreshed, err := service.Refresh(ctx, loginSession.Tokens.RefreshToken, "https://ssh.doldolma.com", VaultResolutionLegacy)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if refreshed.Tokens.RefreshToken != loginSession.Tokens.RefreshToken {
		t.Fatal("Refresh() should slide the same refresh token in place, not rotate it")
	}

	if _, err := service.Refresh(ctx, loginSession.Tokens.RefreshToken, "https://ssh.doldolma.com", VaultResolutionLegacy); err != nil {
		t.Fatalf("Refresh(same token reused) error = %v", err)
	}

	if err := service.Logout(ctx, refreshed.Tokens.RefreshToken); err != nil {
		t.Fatalf("Logout() error = %v", err)
	}
	if _, err := service.Refresh(ctx, refreshed.Tokens.RefreshToken, "https://ssh.doldolma.com", VaultResolutionLegacy); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Refresh(logged out token) error = %v, want %v", err, ErrInvalidCredentials)
	}
}

func TestChangePasswordVerifiesCurrentPasswordAndRevokesOtherSessions(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService(t)

	_, currentSession, err := service.Signup(ctx, "password@example.com", "old-password", "https://ssh.doldolma.com", VaultResolutionLegacy)
	if err != nil {
		t.Fatalf("Signup() error = %v", err)
	}
	if currentSession.User.PasswordState != PasswordStateSet {
		t.Fatalf("PasswordState = %q, want %q", currentSession.User.PasswordState, PasswordStateSet)
	}
	_, otherSession, err := service.Login(ctx, "password@example.com", "old-password", "https://ssh.doldolma.com", VaultResolutionLegacy)
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}

	if err := service.ChangePassword(ctx, currentSession.User.ID, "wrong-password", "new-password", currentSession.Tokens.RefreshToken); !errors.Is(err, ErrCurrentPasswordInvalid) {
		t.Fatalf("ChangePassword(wrong current) error = %v, want %v", err, ErrCurrentPasswordInvalid)
	}
	if err := service.ChangePassword(ctx, currentSession.User.ID, "old-password", "old-password", currentSession.Tokens.RefreshToken); !errors.Is(err, ErrPasswordReuse) {
		t.Fatalf("ChangePassword(reused) error = %v, want %v", err, ErrPasswordReuse)
	}
	if err := service.ChangePassword(ctx, currentSession.User.ID, "old-password", "new-password", currentSession.Tokens.RefreshToken); err != nil {
		t.Fatalf("ChangePassword() error = %v", err)
	}

	if _, _, err := service.Login(ctx, "password@example.com", "old-password", "https://ssh.doldolma.com", VaultResolutionLegacy); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Login(old password) error = %v, want %v", err, ErrInvalidCredentials)
	}
	if _, _, err := service.Login(ctx, "password@example.com", "new-password", "https://ssh.doldolma.com", VaultResolutionLegacy); err != nil {
		t.Fatalf("Login(new password) error = %v", err)
	}
	if _, err := service.Refresh(ctx, currentSession.Tokens.RefreshToken, "https://ssh.doldolma.com", VaultResolutionLegacy); err != nil {
		t.Fatalf("Refresh(current session) error = %v", err)
	}
	if _, err := service.Refresh(ctx, otherSession.Tokens.RefreshToken, "https://ssh.doldolma.com", VaultResolutionLegacy); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Refresh(other session) error = %v, want %v", err, ErrInvalidCredentials)
	}
}

func TestOIDCOnlyUserCanSetPassword(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService(t)

	user, err := service.ResolveOIDCUser(ctx, "oidc", "subject-1", "oidc@example.com", true)
	if err != nil {
		t.Fatalf("ResolveOIDCUser() error = %v", err)
	}
	session, err := service.issueSession(ctx, user, "https://ssh.doldolma.com", VaultResolutionLegacy)
	if err != nil {
		t.Fatalf("issueSession() error = %v", err)
	}
	if session.User.PasswordState != PasswordStateUnset {
		t.Fatalf("PasswordState = %q, want %q", session.User.PasswordState, PasswordStateUnset)
	}

	if err := service.ChangePassword(ctx, user.ID, "", "new-password", session.Tokens.RefreshToken); err != nil {
		t.Fatalf("ChangePassword() error = %v", err)
	}
	_, loginSession, err := service.Login(ctx, user.Email, "new-password", "https://ssh.doldolma.com", VaultResolutionLegacy)
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}
	if loginSession.User.PasswordState != PasswordStateSet {
		t.Fatalf("PasswordState after setup = %q, want %q", loginSession.User.PasswordState, PasswordStateSet)
	}
}

func TestUnverifiedOIDCUserCannotSetPassword(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService(t)

	user, err := service.ResolveOIDCUser(ctx, "oidc", "subject-unverified", "unverified@example.com", false)
	if err != nil {
		t.Fatalf("ResolveOIDCUser() error = %v", err)
	}
	session, err := service.issueSession(ctx, user, "https://ssh.doldolma.com", VaultResolutionLegacy)
	if err != nil {
		t.Fatalf("issueSession() error = %v", err)
	}
	if session.User.PasswordState != PasswordStateUnavailable {
		t.Fatalf("PasswordState = %q, want %q", session.User.PasswordState, PasswordStateUnavailable)
	}
	if err := service.ChangePassword(ctx, user.ID, "", "new-password", session.Tokens.RefreshToken); !errors.Is(err, ErrPasswordChangeUnavailable) {
		t.Fatalf("ChangePassword() error = %v, want %v", err, ErrPasswordChangeUnavailable)
	}
}

func TestRefreshSlidesTokenAndIgnoresLegacyRotationState(t *testing.T) {
	ctx := context.Background()
	service, backingStore := newTestService(t)

	_, session, err := service.Signup(ctx, "slide@example.com", "hunter2", "https://ssh.doldolma.com", VaultResolutionLegacy)
	if err != nil {
		t.Fatalf("Signup() error = %v", err)
	}

	// 같은 토큰으로 반복 갱신해도 회전 없이 계속 성공하고 동일 토큰이 유지된다(슬라이딩 idle).
	refreshed, err := service.Refresh(ctx, session.Tokens.RefreshToken, "https://ssh.doldolma.com", VaultResolutionLegacy)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if refreshed.Tokens.RefreshToken != session.Tokens.RefreshToken {
		t.Fatal("Refresh() should keep the same refresh token, not rotate it")
	}

	// 회전 시절에 박힌 레거시 상태(SupersededAt + 만료된 GraceUntil)가 있어도 무효화하지 않고
	// 통과시켜야 한다 — 배포 전에 발급된 토큰을 든 기존 클라이언트의 하위호환.
	record, err := backingStore.GetRefreshToken(ctx, hashToken(session.Tokens.RefreshToken))
	if err != nil {
		t.Fatalf("GetRefreshToken() error = %v", err)
	}
	pastGrace := time.Now().Add(-time.Minute)
	supersededAt := time.Now().Add(-2 * time.Minute)
	record.SupersededAt = &supersededAt
	record.GraceUntil = &pastGrace
	if err := backingStore.SaveRefreshToken(ctx, record); err != nil {
		t.Fatalf("SaveRefreshToken() error = %v", err)
	}

	if _, err := service.Refresh(ctx, session.Tokens.RefreshToken, "https://ssh.doldolma.com", VaultResolutionLegacy); err != nil {
		t.Fatalf("Refresh(legacy superseded token) should succeed under sliding idle, got %v", err)
	}

	// 갱신이 레거시 회전 상태를 정리했는지 확인.
	record, err = backingStore.GetRefreshToken(ctx, hashToken(session.Tokens.RefreshToken))
	if err != nil {
		t.Fatalf("GetRefreshToken(after) error = %v", err)
	}
	if record.SupersededAt != nil || record.GraceUntil != nil {
		t.Fatal("Refresh() should clear legacy SupersededAt/GraceUntil")
	}
}

func TestSessionBootstrapIncludesOfflineLeaseBoundedByRefreshExpiry(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService(t)

	_, session, err := service.Signup(ctx, "lease@example.com", "hunter2", "https://ssh.doldolma.com", VaultResolutionLegacy)
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

	if _, _, err := service.Signup(ctx, "user@example.com", "hunter2", "https://ssh.doldolma.com", VaultResolutionLegacy); err != nil {
		t.Fatalf("Signup() error = %v", err)
	}

	if _, _, err := service.Login(ctx, "user@example.com", "wrong-password", "https://ssh.doldolma.com", VaultResolutionLegacy); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Login(wrong password) error = %v, want %v", err, ErrInvalidCredentials)
	}

	if _, _, err := service.Login(ctx, "missing@example.com", "hunter2", "https://ssh.doldolma.com", VaultResolutionLegacy); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Login(missing user) error = %v, want %v", err, ErrInvalidCredentials)
	}
}

func TestExchangeCodeIsSingleUse(t *testing.T) {
	ctx := context.Background()
	service, _ := newTestService(t)

	user, _, err := service.Signup(ctx, "exchange@example.com", "hunter2", "https://ssh.doldolma.com", VaultResolutionLegacy)
	if err != nil {
		t.Fatalf("Signup() error = %v", err)
	}

	code, err := service.IssueExchangeCode(ctx, user)
	if err != nil {
		t.Fatalf("IssueExchangeCode() error = %v", err)
	}

	session, err := service.ExchangeCode(ctx, code, "https://ssh.doldolma.com", VaultResolutionLegacy)
	if err != nil {
		t.Fatalf("ExchangeCode() error = %v", err)
	}
	if session.User.ID != user.ID {
		t.Fatalf("ExchangeCode().User.ID = %q, want %q", session.User.ID, user.ID)
	}

	if _, err := service.ExchangeCode(ctx, code, "https://ssh.doldolma.com", VaultResolutionLegacy); !errors.Is(err, ErrInvalidExchangeCode) {
		t.Fatalf("ExchangeCode(second use) error = %v, want %v", err, ErrInvalidExchangeCode)
	}
}

func TestBrowserLoginStateRoundTrip(t *testing.T) {
	service, _ := newTestService(t)

	token, err := service.NewBrowserLoginState("desktop", "dolgate://auth/callback", "state-123", "ko")
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
	// 언어를 잃으면 OIDC 를 다녀온 뒤 브리지 페이지가 브라우저 언어로 되돌아간다.
	if state.Lang != "ko" {
		t.Fatalf("state.Lang = %q, want ko", state.Lang)
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
	firstService, err := NewService(backingStore, "", keyPath, 15*time.Minute, 14*24*time.Hour, 72*time.Hour, 2*time.Minute, true)
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

	secondService, err := NewService(backingStore, "", keyPath, 15*time.Minute, 14*24*time.Hour, 72*time.Hour, 2*time.Minute, true)
	if err != nil {
		t.Fatalf("second NewService() error = %v", err)
	}
	if firstService.signingPublicKeyPEM != secondService.signingPublicKeyPEM {
		t.Fatalf("expected signing public key PEM reuse, got %q vs %q", firstService.signingPublicKeyPEM, secondService.signingPublicKeyPEM)
	}
}
