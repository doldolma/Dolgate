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

	"keyterm/services/sync-api/internal/store"
)

var ErrInvalidCredentials = errors.New("invalid credentials")
var ErrExpiredRefreshToken = errors.New("expired refresh token")

// TokenPair는 클라이언트가 세션을 유지하는 데 필요한 최소 정보다.
type TokenPair struct {
	AccessToken      string `json:"accessToken"`
	RefreshToken     string `json:"refreshToken"`
	ExpiresInSeconds int    `json:"expiresInSeconds"`
}

type Service struct {
	// 토큰 발급 정책과 저장소를 한곳에 모아 인증 흐름을 단순화한다.
	store           store.Store
	jwtSecret       []byte
	accessTokenTTL  time.Duration
	refreshTokenTTL time.Duration
}

// Claims는 access token에 실어 보낼 사용자 식별 정보다.
type Claims struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
	jwt.RegisteredClaims
}

func NewService(store store.Store, jwtSecret string, accessTokenTTL time.Duration, refreshTokenTTL time.Duration) *Service {
	return &Service{
		store:           store,
		jwtSecret:       []byte(jwtSecret),
		accessTokenTTL:  accessTokenTTL,
		refreshTokenTTL: refreshTokenTTL,
	}
}

func (s *Service) Signup(ctx context.Context, email string, password string) (store.User, TokenPair, error) {
	// 비밀번호는 절대 원문 저장하지 않고 bcrypt 해시만 남긴다.
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return store.User{}, TokenPair{}, err
	}
	user, err := s.store.CreateUser(ctx, email, string(passwordHash))
	if err != nil {
		return store.User{}, TokenPair{}, err
	}
	tokens, err := s.issueTokens(ctx, user)
	return user, tokens, err
}

func (s *Service) Login(ctx context.Context, email string, password string) (store.User, TokenPair, error) {
	// 계정 존재 여부와 비밀번호 오류를 같은 오류로 다뤄 정보 노출을 줄인다.
	user, err := s.store.GetUserByEmail(ctx, email)
	if err != nil {
		return store.User{}, TokenPair{}, ErrInvalidCredentials
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return store.User{}, TokenPair{}, ErrInvalidCredentials
	}
	tokens, err := s.issueTokens(ctx, user)
	return user, tokens, err
}

func (s *Service) Refresh(ctx context.Context, refreshToken string) (TokenPair, error) {
	// refresh token은 해시로 조회해 DB 유출 시 원문 토큰이 드러나지 않게 한다.
	tokenHash := hashToken(refreshToken)
	record, err := s.store.GetRefreshToken(ctx, tokenHash)
	if err != nil {
		return TokenPair{}, ErrInvalidCredentials
	}
	if time.Now().After(record.ExpiresAt) {
		return TokenPair{}, ErrExpiredRefreshToken
	}

	user, err := s.store.GetUserByID(ctx, record.UserID)
	if err != nil {
		return TokenPair{}, ErrInvalidCredentials
	}
	// refresh token에는 userId만 연결되어 있으므로 사용자 본문은 다시 조회한다.
	return s.issueTokens(ctx, user)
}

func (s *Service) ParseAccessToken(token string) (*Claims, error) {
	// middleware에서 access token 검증 시 사용하는 공용 파서다.
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

func (s *Service) issueTokens(ctx context.Context, user store.User) (TokenPair, error) {
	// access token은 짧게, refresh token은 길게 두는 전형적인 세션 전략을 따른다.
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

	if err := s.store.SaveRefreshToken(ctx, store.RefreshToken{
		UserID:    user.ID,
		TokenHash: hashToken(refreshToken),
		ExpiresAt: time.Now().Add(s.refreshTokenTTL),
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
	// refresh token 원문은 충분한 엔트로피를 가진 임의 바이트에서 생성한다.
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func hashToken(raw string) string {
	// refresh token 저장용 단방향 해시.
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
