package store

import (
	"context"
	"time"

	syncmodel "dolssh/services/sync-api/internal/sync"
)

type User struct {
	ID           string
	Email        string
	PasswordHash string
}

type AuthIdentity struct {
	UserID        string
	Provider      string
	Subject       string
	Email         string
	EmailVerified bool
}

type RefreshToken struct {
	UserID       string
	TokenHash    string
	ExpiresAt    time.Time
	LastUsedAt   time.Time
	GraceUntil   *time.Time
	SupersededAt *time.Time
}

type ExchangeCode struct {
	UserID    string
	CodeHash  string
	ExpiresAt time.Time
}

type UserVaultKey struct {
	UserID    string
	KeyBase64 string
}

type UserClientObservation struct {
	UserID               string
	ClientName           string
	ClientVersion        string
	Platform             string
	ClientInstallationID string
	LastAuthEvent        string
	LastIP               string
	LastUserAgent        string
	ObservedAt           time.Time
}

type Store interface {
	CreateUser(ctx context.Context, email string, passwordHash string) (User, error)
	GetUserByEmail(ctx context.Context, email string) (User, error)
	GetUserByID(ctx context.Context, id string) (User, error)

	GetAuthIdentity(ctx context.Context, provider string, subject string) (AuthIdentity, error)
	SaveAuthIdentity(ctx context.Context, identity AuthIdentity) error

	SaveRefreshToken(ctx context.Context, token RefreshToken) error
	GetRefreshToken(ctx context.Context, tokenHash string) (RefreshToken, error)
	DeleteRefreshToken(ctx context.Context, tokenHash string) error

	SaveExchangeCode(ctx context.Context, code ExchangeCode) error
	ConsumeExchangeCode(ctx context.Context, codeHash string) (ExchangeCode, error)

	GetOrCreateUserVaultKey(ctx context.Context, userID string) (UserVaultKey, error)
	UpsertUserClientObservation(ctx context.Context, observation UserClientObservation) error

	ListSyncRecords(ctx context.Context, userID string, kind syncmodel.Kind) ([]syncmodel.Record, error)
	UpsertSyncRecords(ctx context.Context, userID string, kind syncmodel.Kind, records []syncmodel.Record) error
}
