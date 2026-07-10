package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"dolssh/services/sync-api/internal/store"
)

var ErrInvalidCredentials = errors.New("invalid credentials")
var ErrExpiredRefreshToken = errors.New("expired refresh token")
var ErrInvalidExchangeCode = errors.New("invalid exchange code")

// TokenPair는 클라이언트가 세션을 유지하는 데 필요한 최소 정보다.
type TokenPair struct {
	AccessToken      string `json:"accessToken"`
	RefreshToken     string `json:"refreshToken"`
	ExpiresInSeconds int    `json:"expiresInSeconds"`
}

type VaultBootstrap struct {
	KeyBase64 string `json:"keyBase64"`
}

type OfflineLease struct {
	Token                    string `json:"token"`
	IssuedAt                 string `json:"issuedAt"`
	ExpiresAt                string `json:"expiresAt"`
	VerificationPublicKeyPEM string `json:"verificationPublicKeyPem"`
}

type SessionBootstrap struct {
	User struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	} `json:"user"`
	Tokens         TokenPair      `json:"tokens"`
	VaultBootstrap VaultBootstrap `json:"vaultBootstrap"`
	OfflineLease   OfflineLease   `json:"offlineLease"`
	SyncServerTime string         `json:"syncServerTime"`
}

type Service struct {
	store               store.Store
	signingKey          *rsa.PrivateKey
	signingPublicKeyPEM string
	accessTokenTTL      time.Duration
	refreshTokenIdleTTL time.Duration
	offlineLeaseTTL     time.Duration
	refreshHandoffTTL   time.Duration
}

// Claims는 access token에 실어 보낼 사용자 식별 정보다.
type Claims struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
	jwt.RegisteredClaims
}

// BrowserLoginState는 OIDC 라운드트립 동안 desktop redirect 정보를 보존한다.
type BrowserLoginState struct {
	Client      string `json:"client"`
	RedirectURI string `json:"redirectUri"`
	State       string `json:"state"`
	jwt.RegisteredClaims
}

type OfflineLeaseClaims struct {
	jwt.RegisteredClaims
}

func NewService(
	store store.Store,
	signingPrivateKeyPEM string,
	signingPrivateKeyPath string,
	accessTokenTTL time.Duration,
	refreshTokenIdleTTL time.Duration,
	offlineLeaseTTL time.Duration,
	refreshHandoffTTL time.Duration,
) (*Service, error) {
	signingKey, signingPublicKeyPEM, err := resolveSigningKeypair(signingPrivateKeyPEM, signingPrivateKeyPath)
	if err != nil {
		return nil, err
	}

	return &Service{
		store:               store,
		signingKey:          signingKey,
		signingPublicKeyPEM: signingPublicKeyPEM,
		accessTokenTTL:      accessTokenTTL,
		refreshTokenIdleTTL: refreshTokenIdleTTL,
		offlineLeaseTTL:     offlineLeaseTTL,
		refreshHandoffTTL:   refreshHandoffTTL,
	}, nil
}

func (s *Service) Signup(ctx context.Context, email string, password string, issuer string) (store.User, SessionBootstrap, error) {
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return store.User{}, SessionBootstrap{}, err
	}
	user, err := s.store.CreateUser(ctx, email, string(passwordHash))
	if err != nil {
		return store.User{}, SessionBootstrap{}, err
	}
	session, err := s.issueSession(ctx, user, issuer)
	return user, session, err
}

func (s *Service) Login(ctx context.Context, email string, password string, issuer string) (store.User, SessionBootstrap, error) {
	user, err := s.store.GetUserByEmail(ctx, email)
	if err != nil {
		return store.User{}, SessionBootstrap{}, ErrInvalidCredentials
	}
	if user.PasswordHash == "" {
		return store.User{}, SessionBootstrap{}, ErrInvalidCredentials
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return store.User{}, SessionBootstrap{}, ErrInvalidCredentials
	}
	session, err := s.issueSession(ctx, user, issuer)
	return user, session, err
}

func (s *Service) Refresh(ctx context.Context, refreshToken string, issuer string) (SessionBootstrap, error) {
	tokenHash := hashToken(refreshToken)
	record, err := s.store.GetRefreshToken(ctx, tokenHash)
	if err != nil {
		return SessionBootstrap{}, ErrInvalidCredentials
	}
	now := time.Now()
	if now.After(record.ExpiresAt) {
		_ = s.store.DeleteRefreshToken(ctx, tokenHash)
		return SessionBootstrap{}, ErrExpiredRefreshToken
	}

	user, err := s.store.GetUserByID(ctx, record.UserID)
	if err != nil {
		return SessionBootstrap{}, ErrInvalidCredentials
	}

	// 슬라이딩 idle: 토큰을 회전(교체)하지 않고 같은 토큰의 만료만 idle TTL 만큼 앞으로 민다.
	// 회전 + 재사용 감지는 슬립/오프라인/갱신응답 유실로 옛 토큰이 재사용되면 뜬금없이
	// 로그아웃시키는 부작용이 있어 제거했다. "쓰면 계속 연장, idle 기간 미사용에만 만료" 정책.
	// 레거시 회전 상태(SupersededAt/GraceUntil)는 무효화하지 않고 정리만 해 — 회전 시절에
	// 발급된 토큰을 들고 있는 기존 클라이언트도 그대로 통과한다(하위호환).
	record.LastUsedAt = now
	record.ExpiresAt = now.Add(s.refreshTokenIdleTTL)
	record.SupersededAt = nil
	record.GraceUntil = nil
	if err := s.store.SaveRefreshToken(ctx, record); err != nil {
		return SessionBootstrap{}, err
	}

	return s.issueSessionWithRefresh(ctx, user, issuer, refreshToken, record.ExpiresAt)
}

func (s *Service) Logout(ctx context.Context, refreshToken string) error {
	if refreshToken == "" {
		return nil
	}
	return s.store.DeleteRefreshToken(ctx, hashToken(refreshToken))
}

// DeleteAccount 는 회원 탈퇴 — 사용자의 모든 서버측 데이터를 즉시 영구 삭제한다.
// refresh 토큰도 함께 지워지므로 다른 기기는 다음 토큰 갱신(401)에서 로그아웃된다.
func (s *Service) DeleteAccount(ctx context.Context, userID string) error {
	if userID == "" {
		return errors.New("userID is required")
	}
	return s.store.DeleteUserData(ctx, userID)
}

func (s *Service) IssueExchangeCode(ctx context.Context, user store.User) (string, error) {
	code, err := randomToken()
	if err != nil {
		return "", err
	}
	if err := s.store.SaveExchangeCode(ctx, store.ExchangeCode{
		UserID:    user.ID,
		CodeHash:  hashToken(code),
		ExpiresAt: time.Now().Add(2 * time.Minute),
	}); err != nil {
		return "", err
	}
	return code, nil
}

func (s *Service) ExchangeCode(ctx context.Context, code string, issuer string) (SessionBootstrap, error) {
	record, err := s.store.ConsumeExchangeCode(ctx, hashToken(code))
	if err != nil {
		return SessionBootstrap{}, ErrInvalidExchangeCode
	}
	if time.Now().After(record.ExpiresAt) {
		return SessionBootstrap{}, ErrInvalidExchangeCode
	}
	user, err := s.store.GetUserByID(ctx, record.UserID)
	if err != nil {
		return SessionBootstrap{}, ErrInvalidExchangeCode
	}
	return s.issueSession(ctx, user, issuer)
}

func (s *Service) ResolveOIDCUser(ctx context.Context, provider string, subject string, email string, emailVerified bool) (store.User, error) {
	identity, err := s.store.GetAuthIdentity(ctx, provider, subject)
	if err == nil {
		return s.store.GetUserByID(ctx, identity.UserID)
	}

	var user store.User
	if emailVerified {
		user, err = s.store.GetUserByEmail(ctx, email)
	}
	if err != nil || user.ID == "" {
		user, err = s.store.CreateUser(ctx, email, "")
		if err != nil {
			return store.User{}, err
		}
	}

	if err := s.store.SaveAuthIdentity(ctx, store.AuthIdentity{
		UserID:        user.ID,
		Provider:      provider,
		Subject:       subject,
		Email:         email,
		EmailVerified: emailVerified,
	}); err != nil {
		return store.User{}, err
	}
	return user, nil
}

func (s *Service) NewBrowserLoginState(client string, redirectURI string, state string) (string, error) {
	claims := BrowserLoginState{
		Client:      client,
		RedirectURI: redirectURI,
		State:       state,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(10 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(s.signingKey)
}

func (s *Service) ParseBrowserLoginState(token string) (*BrowserLoginState, error) {
	parsed, err := jwt.ParseWithClaims(token, &BrowserLoginState{}, func(token *jwt.Token) (any, error) {
		if token.Method.Alg() != jwt.SigningMethodRS256.Alg() {
			return nil, fmt.Errorf("unexpected signing method: %s", token.Method.Alg())
		}
		return &s.signingKey.PublicKey, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := parsed.Claims.(*BrowserLoginState)
	if !ok || !parsed.Valid {
		return nil, ErrInvalidCredentials
	}
	return claims, nil
}

func (s *Service) ParseAccessToken(token string) (*Claims, error) {
	parsed, err := jwt.ParseWithClaims(token, &Claims{}, func(token *jwt.Token) (any, error) {
		if token.Method.Alg() != jwt.SigningMethodRS256.Alg() {
			return nil, fmt.Errorf("unexpected signing method: %s", token.Method.Alg())
		}
		return &s.signingKey.PublicKey, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := parsed.Claims.(*Claims)
	if !ok || !parsed.Valid {
		return nil, ErrInvalidCredentials
	}
	return claims, nil
}

func (s *Service) issueSession(ctx context.Context, user store.User, issuer string) (SessionBootstrap, error) {
	tokens, refreshExpiresAt, err := s.issueTokens(ctx, user)
	if err != nil {
		return SessionBootstrap{}, err
	}
	vaultKey, err := s.store.GetOrCreateUserVaultKey(ctx, user.ID)
	if err != nil {
		return SessionBootstrap{}, err
	}
	offlineLease, err := s.issueOfflineLease(user, issuer, refreshExpiresAt)
	if err != nil {
		return SessionBootstrap{}, err
	}

	var session SessionBootstrap
	session.User.ID = user.ID
	session.User.Email = user.Email
	session.Tokens = tokens
	session.VaultBootstrap = VaultBootstrap{KeyBase64: vaultKey.KeyBase64}
	session.OfflineLease = offlineLease
	session.SyncServerTime = time.Now().UTC().Format(time.RFC3339)
	return session, nil
}

// issueSessionWithRefresh builds a session bootstrap that reuses an existing,
// already-extended refresh token instead of minting a new one. Refresh uses this
// so the refresh token slides forward in place (no rotation), avoiding the
// spurious logouts that rotation + reuse-detection caused on sleep/offline or
// lost refresh responses. Response shape is identical to issueSession, so every
// client version persists and reuses the returned token exactly as before.
func (s *Service) issueSessionWithRefresh(ctx context.Context, user store.User, issuer string, refreshToken string, refreshExpiresAt time.Time) (SessionBootstrap, error) {
	accessToken, err := s.signAccessToken(user)
	if err != nil {
		return SessionBootstrap{}, err
	}
	vaultKey, err := s.store.GetOrCreateUserVaultKey(ctx, user.ID)
	if err != nil {
		return SessionBootstrap{}, err
	}
	offlineLease, err := s.issueOfflineLease(user, issuer, refreshExpiresAt)
	if err != nil {
		return SessionBootstrap{}, err
	}

	var session SessionBootstrap
	session.User.ID = user.ID
	session.User.Email = user.Email
	session.Tokens = TokenPair{
		AccessToken:      accessToken,
		RefreshToken:     refreshToken,
		ExpiresInSeconds: int(s.accessTokenTTL.Seconds()),
	}
	session.VaultBootstrap = VaultBootstrap{KeyBase64: vaultKey.KeyBase64}
	session.OfflineLease = offlineLease
	session.SyncServerTime = time.Now().UTC().Format(time.RFC3339)
	return session, nil
}

func (s *Service) signAccessToken(user store.User) (string, error) {
	claims := Claims{
		UserID: user.ID,
		Email:  user.Email,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.ID,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(s.accessTokenTTL)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(s.signingKey)
}

func (s *Service) issueTokens(ctx context.Context, user store.User) (TokenPair, time.Time, error) {
	signedToken, err := s.signAccessToken(user)
	if err != nil {
		return TokenPair{}, time.Time{}, err
	}

	refreshToken, err := randomToken()
	if err != nil {
		return TokenPair{}, time.Time{}, err
	}

	now := time.Now()
	refreshExpiresAt := now.Add(s.refreshTokenIdleTTL)
	if err := s.store.SaveRefreshToken(ctx, store.RefreshToken{
		UserID:       user.ID,
		TokenHash:    hashToken(refreshToken),
		ExpiresAt:    refreshExpiresAt,
		LastUsedAt:   now,
		GraceUntil:   nil,
		SupersededAt: nil,
	}); err != nil {
		return TokenPair{}, time.Time{}, err
	}

	return TokenPair{
		AccessToken:      signedToken,
		RefreshToken:     refreshToken,
		ExpiresInSeconds: int(s.accessTokenTTL.Seconds()),
	}, refreshExpiresAt, nil
}

func (s *Service) issueOfflineLease(user store.User, issuer string, refreshExpiresAt time.Time) (OfflineLease, error) {
	now := time.Now().UTC()
	leaseExpiresAt := now.Add(s.offlineLeaseTTL)
	if refreshExpiresAt.UTC().Before(leaseExpiresAt) {
		leaseExpiresAt = refreshExpiresAt.UTC()
	}

	claims := OfflineLeaseClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			Subject:   user.ID,
			Audience:  jwt.ClaimStrings{"dolgate-desktop"},
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(leaseExpiresAt),
		},
	}

	token, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(s.signingKey)
	if err != nil {
		return OfflineLease{}, err
	}

	return OfflineLease{
		Token:                    token,
		IssuedAt:                 now.Format(time.RFC3339),
		ExpiresAt:                leaseExpiresAt.Format(time.RFC3339),
		VerificationPublicKeyPEM: s.signingPublicKeyPEM,
	}, nil
}

func resolveSigningKeypair(privateKeyPEM string, privateKeyPath string) (*rsa.PrivateKey, string, error) {
	trimmedPEM := strings.TrimSpace(privateKeyPEM)
	if trimmedPEM != "" {
		return parseSigningKeypair(trimmedPEM)
	}

	trimmedPath := strings.TrimSpace(privateKeyPath)
	if trimmedPath == "" {
		return nil, "", errors.New("auth signing private key pem or path is required")
	}

	existing, err := os.ReadFile(trimmedPath)
	if err == nil {
		return parseSigningKeypair(string(existing))
	}
	if !os.IsNotExist(err) {
		return nil, "", fmt.Errorf("read auth signing private key: %w", err)
	}

	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, "", err
	}
	privateKeyPEMEncoded, err := encodePrivateKeyPEM(privateKey)
	if err != nil {
		return nil, "", err
	}
	if err := os.MkdirAll(filepath.Dir(trimmedPath), 0o700); err != nil {
		return nil, "", fmt.Errorf("create auth signing key directory: %w", err)
	}
	if err := os.WriteFile(trimmedPath, []byte(privateKeyPEMEncoded), 0o600); err != nil {
		return nil, "", fmt.Errorf("write auth signing private key: %w", err)
	}
	publicKeyPEM, err := encodePublicKeyPEM(&privateKey.PublicKey)
	if err != nil {
		return nil, "", err
	}
	return privateKey, publicKeyPEM, nil
}

func parseSigningKeypair(privateKeyPEM string) (*rsa.PrivateKey, string, error) {
	block, _ := pem.Decode([]byte(privateKeyPEM))
	if block == nil {
		return nil, "", errors.New("invalid auth signing private key pem")
	}

	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err == nil {
		privateKey, ok := parsed.(*rsa.PrivateKey)
		if !ok {
			return nil, "", errors.New("auth signing private key must be rsa")
		}
		publicKeyPEM, err := encodePublicKeyPEM(&privateKey.PublicKey)
		if err != nil {
			return nil, "", err
		}
		return privateKey, publicKeyPEM, nil
	}

	privateKey, pkcs1Err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if pkcs1Err != nil {
		return nil, "", fmt.Errorf("parse auth signing private key: %w", err)
	}
	publicKeyPEM, err := encodePublicKeyPEM(&privateKey.PublicKey)
	if err != nil {
		return nil, "", err
	}
	return privateKey, publicKeyPEM, nil
}

func encodePrivateKeyPEM(privateKey *rsa.PrivateKey) (string, error) {
	encoded, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: encoded,
	})), nil
}

func encodePublicKeyPEM(publicKey *rsa.PublicKey) (string, error) {
	encoded, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: encoded,
	})), nil
}

func randomToken() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
