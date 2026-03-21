package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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

type SessionBootstrap struct {
	User struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	} `json:"user"`
	Tokens         TokenPair      `json:"tokens"`
	VaultBootstrap VaultBootstrap `json:"vaultBootstrap"`
	SyncServerTime string         `json:"syncServerTime"`
}

type Service struct {
	store               store.Store
	jwtSecret           []byte
	accessTokenTTL      time.Duration
	refreshTokenIdleTTL time.Duration
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

func NewService(store store.Store, jwtSecret string, accessTokenTTL time.Duration, refreshTokenIdleTTL time.Duration) *Service {
	return &Service{
		store:               store,
		jwtSecret:           []byte(jwtSecret),
		accessTokenTTL:      accessTokenTTL,
		refreshTokenIdleTTL: refreshTokenIdleTTL,
	}
}

func (s *Service) Signup(ctx context.Context, email string, password string) (store.User, SessionBootstrap, error) {
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return store.User{}, SessionBootstrap{}, err
	}
	user, err := s.store.CreateUser(ctx, email, string(passwordHash))
	if err != nil {
		return store.User{}, SessionBootstrap{}, err
	}
	session, err := s.issueSession(ctx, user)
	return user, session, err
}

func (s *Service) Login(ctx context.Context, email string, password string) (store.User, SessionBootstrap, error) {
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
	session, err := s.issueSession(ctx, user)
	return user, session, err
}

func (s *Service) Refresh(ctx context.Context, refreshToken string) (SessionBootstrap, error) {
	tokenHash := hashToken(refreshToken)
	record, err := s.store.GetRefreshToken(ctx, tokenHash)
	if err != nil {
		return SessionBootstrap{}, ErrInvalidCredentials
	}
	if time.Now().After(record.ExpiresAt) {
		_ = s.store.DeleteRefreshToken(ctx, tokenHash)
		return SessionBootstrap{}, ErrExpiredRefreshToken
	}

	user, err := s.store.GetUserByID(ctx, record.UserID)
	if err != nil {
		return SessionBootstrap{}, ErrInvalidCredentials
	}

	// refresh 성공 시 토큰을 회전시켜 idle 14일 정책을 밀어준다.
	if err := s.store.DeleteRefreshToken(ctx, tokenHash); err != nil {
		return SessionBootstrap{}, err
	}
	return s.issueSession(ctx, user)
}

func (s *Service) Logout(ctx context.Context, refreshToken string) error {
	if refreshToken == "" {
		return nil
	}
	return s.store.DeleteRefreshToken(ctx, hashToken(refreshToken))
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

func (s *Service) ExchangeCode(ctx context.Context, code string) (SessionBootstrap, error) {
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
	return s.issueSession(ctx, user)
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
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtSecret)
}

func (s *Service) ParseBrowserLoginState(token string) (*BrowserLoginState, error) {
	parsed, err := jwt.ParseWithClaims(token, &BrowserLoginState{}, func(token *jwt.Token) (any, error) {
		return s.jwtSecret, nil
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
		return s.jwtSecret, nil
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

func (s *Service) issueSession(ctx context.Context, user store.User) (SessionBootstrap, error) {
	tokens, err := s.issueTokens(ctx, user)
	if err != nil {
		return SessionBootstrap{}, err
	}
	vaultKey, err := s.store.GetOrCreateUserVaultKey(ctx, user.ID)
	if err != nil {
		return SessionBootstrap{}, err
	}

	var session SessionBootstrap
	session.User.ID = user.ID
	session.User.Email = user.Email
	session.Tokens = tokens
	session.VaultBootstrap = VaultBootstrap{KeyBase64: vaultKey.KeyBase64}
	session.SyncServerTime = time.Now().UTC().Format(time.RFC3339)
	return session, nil
}

func (s *Service) issueTokens(ctx context.Context, user store.User) (TokenPair, error) {
	claims := Claims{
		UserID: user.ID,
		Email:  user.Email,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.ID,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(s.accessTokenTTL)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}

	signedToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtSecret)
	if err != nil {
		return TokenPair{}, err
	}

	refreshToken, err := randomToken()
	if err != nil {
		return TokenPair{}, err
	}

	now := time.Now()
	if err := s.store.SaveRefreshToken(ctx, store.RefreshToken{
		UserID:     user.ID,
		TokenHash:  hashToken(refreshToken),
		ExpiresAt:  now.Add(s.refreshTokenIdleTTL),
		LastUsedAt: now,
	}); err != nil {
		return TokenPair{}, err
	}

	return TokenPair{
		AccessToken:      signedToken,
		RefreshToken:     refreshToken,
		ExpiresInSeconds: int(s.accessTokenTTL.Seconds()),
	}, nil
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
