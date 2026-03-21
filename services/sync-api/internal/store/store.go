package store

import (
	"context"
	"time"

	syncmodel "keyterm/services/sync-api/internal/sync"
)

type User struct {
	ID           string
	Email        string
	PasswordHash string
}

type RefreshToken struct {
	UserID    string
	TokenHash string
	ExpiresAt time.Time
}

type Store interface {
	CreateUser(ctx context.Context, email string, passwordHash string) (User, error)
	GetUserByEmail(ctx context.Context, email string) (User, error)
	GetUserByID(ctx context.Context, id string) (User, error)
	SaveRefreshToken(ctx context.Context, token RefreshToken) error
	GetRefreshToken(ctx context.Context, tokenHash string) (RefreshToken, error)
	ListSyncRecords(ctx context.Context, userID string, kind string) ([]syncmodel.Record, error)
	UpsertSyncRecords(ctx context.Context, userID string, kind string, records []syncmodel.Record) error
}
