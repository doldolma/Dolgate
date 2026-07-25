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
	"unicode/utf8"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"dolssh/services/sync-api/internal/store"
)

var ErrInvalidCredentials = errors.New("invalid credentials")
var ErrExpiredRefreshToken = errors.New("expired refresh token")
var ErrInvalidExchangeCode = errors.New("invalid exchange code")
var ErrCurrentPasswordInvalid = errors.New("current password is invalid")
var ErrPasswordChangeUnavailable = errors.New("password change is unavailable")
var ErrPasswordReuse = errors.New("new password matches current password")
var ErrInvalidPassword = errors.New("invalid password")

type PasswordState string

const (
	PasswordStateUnset       PasswordState = "unset"
	PasswordStateSet         PasswordState = "set"
	PasswordStateUnavailable PasswordState = "unavailable"
)

// ErrVaultClientOutdated — E2EE(v2) 볼트 계정에 v2 를 모르는 구버전 클라이언트가 세션을
// 요청했다. keyBase64 없는 세션을 내려주면 구버전이 정체불명 에러로 죽으므로, 라우터가
// 이 에러를 426 + 업데이트 안내 문구로 바꿔 내려준다.
var ErrVaultClientOutdated = errors.New("client update required for e2ee vault")

// TokenPair는 클라이언트가 세션을 유지하는 데 필요한 최소 정보다.
type TokenPair struct {
	AccessToken      string `json:"accessToken"`
	RefreshToken     string `json:"refreshToken"`
	ExpiresInSeconds int    `json:"expiresInSeconds"`
}

// VaultKdfParams 는 동기화 암호에서 KEK 를 유도하는 파라미터다. 클라이언트가 볼트 설정 시
// 정한 값을 서버는 그대로 보관·배포만 한다(파라미터 교체 여지를 위해 descriptor 에 포함).
type VaultKdfParams struct {
	Algorithm   string `json:"algorithm"`
	SaltBase64  string `json:"saltBase64"`
	MemoryKiB   int    `json:"memoryKib"`
	TimeCost    int    `json:"timeCost"`
	Parallelism int    `json:"parallelism"`
}

// VaultBootstrap 은 세션 응답에 실리는 볼트 descriptor 다.
// version 0: 볼트 없음(신규 유저) — E2EE 지원 클라이언트가 설정 플로우를 시작한다.
// version 1: 레거시 — 서버 보관 DEK 원문을 그대로 내려준다(기존 유저, 기존 동작).
// version 2: E2EE — 동기화 암호로 감싼 DEK 만 내려준다. 서버는 복호화 불가.
type VaultBootstrap struct {
	Version          int    `json:"version"`
	KeyBase64        string `json:"keyBase64,omitempty"`
	WrappedDekBase64 string `json:"wrappedDekBase64,omitempty"`
	// E2EERequired는 계정 floor가 이미 v2인데 과거 버그/롤링 배포로 v1 행이 남은
	// 복구 상태다. 신클라이언트는 이 키로 즉시 마이그레이션하되 legacy sync는 금지한다.
	E2EERequired bool `json:"e2eeRequired,omitempty"`
	// Epoch 는 DEK 세대 번호(단조 증가)다. 클라이언트는 캐시한 epoch 과 비교해
	// "descriptor 가 내 캐시보다 낡은 응답인지"(낮으면 무시) / "DEK 세대가 바뀌었는지"
	// (높으면 verifier 로 재판정)를 순서 있게 판별한다. push 시 fence 헤더로도 쓴다.
	// verifier 도입 이전에 만들어진 볼트는 0 일 수 있다.
	Epoch int64 `json:"epoch,omitempty"`
	// WrapRevision은 같은 epoch 안의 wrapped DEK/KDF 개정 번호다. 필드 도입 전 v2는 0이다.
	WrapRevision int64 `json:"wrapRevision,omitempty"`
	// DekVerifierBase64 는 클라이언트가 설정 시 제출한 DEK 공개 검증자
	// (HMAC-SHA256(key=DEK, msg=고정라벨)). 캐시한 DEK 로 같은 값을 계산해 일치하면
	// 그 DEK 가 이 볼트의 DEK 임이 증명된다 — 최초 신뢰 채택 없이 즉시 판정한다.
	DekVerifierBase64 string          `json:"dekVerifierBase64,omitempty"`
	Kdf               *VaultKdfParams `json:"kdf,omitempty"`
}

// VaultResolution 은 세션 발급 시 볼트 descriptor 를 어떻게 채울지 결정한다.
type VaultResolution int

const (
	// VaultResolutionLegacy — v2 를 모르는 구버전 클라이언트. 볼트가 없으면 기존처럼
	// v1 을 lazy 생성하고, v2 볼트를 만나면 ErrVaultClientOutdated 로 세션 발급을 거부한다.
	VaultResolutionLegacy VaultResolution = iota
	// VaultResolutionE2EE — v2 를 이해하는 클라이언트. 볼트가 없으면 생성하지 않고
	// version 0 을 내려 설정 플로우를 태운다.
	VaultResolutionE2EE
	// VaultResolutionSkip — 세션이 앱 클라이언트로 전달되지 않는 내부 경로(브라우저 폼
	// 로그인 등). 볼트를 조회·생성하지 않는다. 신규 유저가 웹 폼을 거쳤다는 이유만으로
	// v1 볼트가 미리 생성되는 것을 막는 게 핵심이다.
	VaultResolutionSkip
)

type OfflineLease struct {
	Token                    string `json:"token"`
	IssuedAt                 string `json:"issuedAt"`
	ExpiresAt                string `json:"expiresAt"`
	VerificationPublicKeyPEM string `json:"verificationPublicKeyPem"`
}

type SessionBootstrap struct {
	User struct {
		ID            string        `json:"id"`
		Email         string        `json:"email"`
		PasswordState PasswordState `json:"passwordState"`
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
	localAuthEnabled    bool
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
	localAuthEnabled bool,
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
		localAuthEnabled:    localAuthEnabled,
	}, nil
}

func (s *Service) Signup(ctx context.Context, email string, password string, issuer string, vaultResolution VaultResolution) (store.User, SessionBootstrap, error) {
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return store.User{}, SessionBootstrap{}, err
	}
	user, err := s.store.CreateUser(ctx, email, string(passwordHash))
	if err != nil {
		return store.User{}, SessionBootstrap{}, err
	}
	session, err := s.issueSession(ctx, user, issuer, vaultResolution)
	return user, session, err
}

func (s *Service) Login(ctx context.Context, email string, password string, issuer string, vaultResolution VaultResolution) (store.User, SessionBootstrap, error) {
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
	session, err := s.issueSession(ctx, user, issuer, vaultResolution)
	return user, session, err
}

func (s *Service) Refresh(ctx context.Context, refreshToken string, issuer string, vaultResolution VaultResolution) (SessionBootstrap, error) {
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

	return s.issueSessionWithRefresh(ctx, user, issuer, refreshToken, record.ExpiresAt, vaultResolution)
}

func (s *Service) Logout(ctx context.Context, refreshToken string) error {
	if refreshToken == "" {
		return nil
	}
	return s.store.DeleteRefreshToken(ctx, hashToken(refreshToken))
}

// ChangePassword 는 로컬 비밀번호의 최초 설정(OIDC 전용 계정)과 기존 비밀번호 변경을
// 함께 처리한다. 기존 비밀번호가 있으면 현재 값을 반드시 다시 확인하고, 없으면 같은
// 이메일의 검증된 OIDC identity가 있어야 새 로그인 수단을 추가할 수 있다.
func (s *Service) ChangePassword(ctx context.Context, userID string, currentPassword string, newPassword string, refreshToken string) error {
	if !s.localAuthEnabled {
		return ErrPasswordChangeUnavailable
	}
	if utf8.RuneCountInString(newPassword) < 8 || len([]byte(newPassword)) > 72 {
		return ErrInvalidPassword
	}

	user, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		return ErrInvalidCredentials
	}
	expectedHash := user.PasswordHash
	if expectedHash != "" {
		if bcrypt.CompareHashAndPassword([]byte(expectedHash), []byte(currentPassword)) != nil {
			return ErrCurrentPasswordInvalid
		}
		if bcrypt.CompareHashAndPassword([]byte(expectedHash), []byte(newPassword)) == nil {
			return ErrPasswordReuse
		}
	} else {
		verified, verifyErr := s.store.HasVerifiedAuthIdentity(ctx, user.ID, user.Email)
		if verifyErr != nil {
			return verifyErr
		}
		if !verified {
			return ErrPasswordChangeUnavailable
		}
	}

	passwordHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	if err := s.store.UpdateUserPassword(ctx, user.ID, expectedHash, string(passwordHash), hashToken(refreshToken)); err != nil {
		if errors.Is(err, store.ErrPasswordConflict) {
			return ErrCurrentPasswordInvalid
		}
		if errors.Is(err, store.ErrRefreshTokenNotFound) {
			return ErrInvalidCredentials
		}
		return err
	}
	return nil
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

func (s *Service) ExchangeCode(ctx context.Context, code string, issuer string, vaultResolution VaultResolution) (SessionBootstrap, error) {
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
	return s.issueSession(ctx, user, issuer, vaultResolution)
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
	// 같은 키로 서명된 다른 용도의 토큰(WebAuthn 등록 티켓 등)이 access token 으로 재사용되는
	// 것을 막는다 — 등록 티켓은 이 audience 를 갖는다.
	for _, audience := range claims.Audience {
		if audience == webauthnRegisterTicketAudience {
			return nil, ErrInvalidCredentials
		}
	}
	return claims, nil
}

// webauthnRegisterTicketAudience 는 등록 티켓 JWT 의 audience 다. access token 과 서명 키를
// 공유하므로, 양쪽 파서가 audience 로 서로를 구분해 혼용을 차단한다.
const webauthnRegisterTicketAudience = "webauthn-register"

// NewWebAuthnRegisterTicket 은 로그인된 앱이 브라우저 등록 페이지를 열 때 신원을 전달하는
// 단명 티켓이다. 브라우저는 자체 세션이 없으므로 이 티켓으로 begin/finish 를 인가한다.
//
// 티켓은 소지만으로 남의 계정에 패스키를 붙일 수 있는 값이라 한 번만 쓰이게 한다. JWT 자체는
// 상태가 없으므로 발급 시 jti 로 ceremony 행을 하나 남기고, 등록이 실제로 끝날 때 소비한다
// (그 행은 만료 정리 대상이라 따로 치울 필요가 없다).
func (s *Service) NewWebAuthnRegisterTicket(ctx context.Context, userID string) (string, error) {
	ticketID, err := randomToken()
	if err != nil {
		return "", err
	}
	expiresAt := time.Now().Add(webauthnRegisterTicketTTL)
	claims := jwt.RegisteredClaims{
		ID:        ticketID,
		Subject:   userID,
		Audience:  jwt.ClaimStrings{webauthnRegisterTicketAudience},
		ExpiresAt: jwt.NewNumericDate(expiresAt),
		IssuedAt:  jwt.NewNumericDate(time.Now()),
	}
	signed, signErr := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(s.signingKey)
	if signErr != nil {
		return "", signErr
	}
	if err := s.store.SaveWebAuthnCeremony(ctx, store.WebAuthnCeremony{
		ID:          webauthnRegisterTicketCeremonyID(ticketID),
		UserID:      userID,
		Purpose:     WebAuthnPurposeRegisterTicket,
		SessionData: []byte("{}"),
		ExpiresAt:   expiresAt.UTC(),
	}); err != nil {
		return "", err
	}
	return signed, nil
}

const webauthnRegisterTicketTTL = 5 * time.Minute

// WebAuthnPurposeRegisterTicket 은 등록 티켓의 일회성 표식이 쓰는 ceremony purpose 다.
const WebAuthnPurposeRegisterTicket = "register-ticket"

// webauthnRegisterTicketCeremonyID 는 jti 로 티켓 표식 행의 id 를 만든다. 등록 ceremony id 와
// 같은 테이블을 쓰므로 접두사로 구분한다.
func webauthnRegisterTicketCeremonyID(ticketID string) string {
	return "ticket:" + ticketID
}

// ParseWebAuthnRegisterTicket 은 티켓을 검증하고 userID(Subject)와 jti 를 돌려준다. audience 를
// 필수 검증해 access token 이 티켓으로 오용되는 것을 막는다.
func (s *Service) ParseWebAuthnRegisterTicket(token string) (string, string, error) {
	parsed, err := jwt.ParseWithClaims(token, &jwt.RegisteredClaims{}, func(token *jwt.Token) (any, error) {
		if token.Method.Alg() != jwt.SigningMethodRS256.Alg() {
			return nil, fmt.Errorf("unexpected signing method: %s", token.Method.Alg())
		}
		return &s.signingKey.PublicKey, nil
	}, jwt.WithAudience(webauthnRegisterTicketAudience))
	if err != nil {
		return "", "", err
	}
	claims, ok := parsed.Claims.(*jwt.RegisteredClaims)
	if !ok || !parsed.Valid || strings.TrimSpace(claims.Subject) == "" {
		return "", "", ErrInvalidCredentials
	}
	// jti 가 없는 티켓은 일회성 표식을 만들 수 없던 구버전이다 — 지금은 발급하지 않는다.
	if strings.TrimSpace(claims.ID) == "" {
		return "", "", ErrInvalidCredentials
	}
	return claims.Subject, claims.ID, nil
}

// ConsumeWebAuthnRegisterTicket 은 티켓의 일회성 표식을 소비한다. 이미 쓰였거나 만료됐으면
// 실패한다. 등록이 실제로 성사되는 시점에만 부른다 — begin 에서 태우면 생체인증을 취소한
// 사용자가 다시 시도할 수 없다.
func (s *Service) ConsumeWebAuthnRegisterTicket(ctx context.Context, userID string, ticketID string) error {
	record, err := s.store.ConsumeWebAuthnCeremony(ctx, webauthnRegisterTicketCeremonyID(ticketID))
	if err != nil {
		return ErrInvalidCredentials
	}
	if record.Purpose != WebAuthnPurposeRegisterTicket || record.UserID != userID {
		return ErrInvalidCredentials
	}
	if time.Now().After(record.ExpiresAt) {
		return ErrInvalidCredentials
	}
	return nil
}

// resolveVaultBootstrap 은 클라이언트 부류(resolution)에 맞는 볼트 descriptor 를 만든다.
// 자세한 분기 의미는 VaultResolution 상수 주석 참고.
func (s *Service) resolveVaultBootstrap(ctx context.Context, userID string, resolution VaultResolution) (VaultBootstrap, error) {
	if resolution == VaultResolutionSkip {
		return VaultBootstrap{Version: 0}, nil
	}

	state, err := s.store.GetUserVaultState(ctx, userID)
	if err != nil {
		return VaultBootstrap{}, err
	}
	if state.VersionFloor >= 2 && resolution != VaultResolutionE2EE {
		return VaultBootstrap{}, ErrVaultClientOutdated
	}
	if state.Vault == nil {
		if resolution == VaultResolutionE2EE {
			return VaultBootstrap{Version: 0, Epoch: state.Epoch}, nil
		}
		// 구버전 클라이언트 — 기존 동작 그대로 v1 을 lazy 생성한다. 드물게 그 사이 다른
		// 기기가 v2 를 만들었으면 생성 대신 기존 행이 돌아오므로 아래 버전 분기로 잡는다.
		vault, createErr := s.store.GetOrCreateUserVaultKey(ctx, userID)
		if createErr != nil {
			if errors.Is(createErr, store.ErrVaultE2EERequired) {
				return VaultBootstrap{}, ErrVaultClientOutdated
			}
			return VaultBootstrap{}, createErr
		}
		state.Vault = &vault
	}
	vault := *state.Vault

	switch vault.Version {
	case 1:
		return VaultBootstrap{
			Version:      1,
			KeyBase64:    vault.KeyBase64,
			Epoch:        vault.Epoch,
			E2EERequired: state.VersionFloor >= 2,
		}, nil
	case 2:
		if resolution != VaultResolutionE2EE {
			return VaultBootstrap{}, ErrVaultClientOutdated
		}
		return VaultBootstrap{
			Version:           2,
			WrappedDekBase64:  vault.WrappedDekBase64,
			Epoch:             vault.Epoch,
			WrapRevision:      vault.WrapRevision,
			DekVerifierBase64: vault.DekVerifier,
			Kdf: &VaultKdfParams{
				Algorithm:   vault.KdfAlgorithm,
				SaltBase64:  vault.KdfSaltBase64,
				MemoryKiB:   vault.KdfMemoryKiB,
				TimeCost:    vault.KdfTimeCost,
				Parallelism: vault.KdfParallelism,
			},
		}, nil
	default:
		return VaultBootstrap{}, fmt.Errorf("unsupported vault version %d for user %s", vault.Version, userID)
	}
}

func (s *Service) issueSession(ctx context.Context, user store.User, issuer string, vaultResolution VaultResolution) (SessionBootstrap, error) {
	// 볼트 게이트(구클라 × v2 계정 → ErrVaultClientOutdated/426)를 토큰 발급보다 먼저
	// 수행한다 — 뒤에 두면 거부될 세션의 refresh token 행이 시도마다 쌓인다(전달되지
	// 않아 사용 불가지만 idle TTL 까지 잔존하는 쓰레기).
	passwordState, err := s.resolvePasswordState(ctx, user)
	if err != nil {
		return SessionBootstrap{}, err
	}
	vaultBootstrap, err := s.resolveVaultBootstrap(ctx, user.ID, vaultResolution)
	if err != nil {
		return SessionBootstrap{}, err
	}
	tokens, refreshExpiresAt, err := s.issueTokens(ctx, user)
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
	session.User.PasswordState = passwordState
	session.Tokens = tokens
	session.VaultBootstrap = vaultBootstrap
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
func (s *Service) issueSessionWithRefresh(ctx context.Context, user store.User, issuer string, refreshToken string, refreshExpiresAt time.Time, vaultResolution VaultResolution) (SessionBootstrap, error) {
	passwordState, err := s.resolvePasswordState(ctx, user)
	if err != nil {
		return SessionBootstrap{}, err
	}
	accessToken, err := s.signAccessToken(user)
	if err != nil {
		return SessionBootstrap{}, err
	}
	vaultBootstrap, err := s.resolveVaultBootstrap(ctx, user.ID, vaultResolution)
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
	session.User.PasswordState = passwordState
	session.Tokens = TokenPair{
		AccessToken:      accessToken,
		RefreshToken:     refreshToken,
		ExpiresInSeconds: int(s.accessTokenTTL.Seconds()),
	}
	session.VaultBootstrap = vaultBootstrap
	session.OfflineLease = offlineLease
	session.SyncServerTime = time.Now().UTC().Format(time.RFC3339)
	return session, nil
}

func (s *Service) resolvePasswordState(ctx context.Context, user store.User) (PasswordState, error) {
	if !s.localAuthEnabled {
		return PasswordStateUnavailable, nil
	}
	if user.PasswordHash != "" {
		return PasswordStateSet, nil
	}
	verified, err := s.store.HasVerifiedAuthIdentity(ctx, user.ID, user.Email)
	if err != nil {
		return PasswordStateUnavailable, err
	}
	if verified {
		return PasswordStateUnset, nil
	}
	return PasswordStateUnavailable, nil
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
