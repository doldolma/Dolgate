package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	syncmodel "keyterm/services/sync-api/internal/sync"
)

type userRow struct {
	ID           string `gorm:"column:id;primaryKey;type:varchar(191)"`
	Email        string `gorm:"column:email;uniqueIndex;not null;type:varchar(255)"`
	PasswordHash string `gorm:"column:password_hash;not null;type:text"`
}

func (userRow) TableName() string {
	return "users"
}

type refreshTokenRow struct {
	UserID    string    `gorm:"column:user_id;not null;index;type:varchar(191)"`
	TokenHash string    `gorm:"column:token_hash;primaryKey;type:varchar(191)"`
	ExpiresAt time.Time `gorm:"column:expires_at;not null"`
}

func (refreshTokenRow) TableName() string {
	return "refresh_tokens"
}

// SyncRecordRow는 hosts / snippets 테이블이 공유하는 컬럼 구조를 표현한다.
type SyncRecordRow struct {
	ID               string     `gorm:"column:id;primaryKey;type:varchar(191)"`
	UserID           string     `gorm:"column:user_id;primaryKey;index;type:varchar(191)"`
	EncryptedPayload string     `gorm:"column:encrypted_payload;not null;type:text"`
	UpdatedAt        time.Time  `gorm:"column:updated_at;not null;autoUpdateTime:false"`
	DeletedAt        *time.Time `gorm:"column:deleted_at"`
}

type hostRow struct {
	SyncRecordRow
}

func (hostRow) TableName() string {
	return "hosts"
}

type snippetRow struct {
	SyncRecordRow
}

func (snippetRow) TableName() string {
	return "snippets"
}

type GormStore struct {
	db     *gorm.DB
	driver string
}

func Open(driver string, dsn string) (*GormStore, error) {
	// GORM은 저장소 계층 안에만 두고 상위 계층은 Store 인터페이스만 보게 유지한다.
	dialector, err := openDialector(driver, dsn)
	if err != nil {
		return nil, err
	}

	db, err := gorm.Open(dialector, &gorm.Config{
		DisableForeignKeyConstraintWhenMigrating: true,
	})
	if err != nil {
		return nil, err
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}

	// SQLite는 단일 연결로 두는 편이 잠금 충돌을 줄이기 쉽다.
	if driver == "sqlite" {
		sqlDB.SetMaxOpenConns(1)
		sqlDB.SetMaxIdleConns(1)
	} else {
		sqlDB.SetMaxOpenConns(10)
		sqlDB.SetMaxIdleConns(5)
		sqlDB.SetConnMaxLifetime(30 * time.Minute)
	}

	store := &GormStore{
		db:     db,
		driver: driver,
	}
	if err := store.migrate(); err != nil {
		return nil, err
	}
	return store, nil
}

func OpenSQLite(dsn string) (*GormStore, error) {
	return Open("sqlite", dsn)
}

func OpenMySQL(dsn string) (*GormStore, error) {
	return Open("mysql", dsn)
}

func openDialector(driver string, dsn string) (gorm.Dialector, error) {
	switch driver {
	case "sqlite":
		return sqlite.Open(dsn), nil
	case "mysql":
		return mysql.Open(dsn), nil
	default:
		return nil, fmt.Errorf("unsupported db driver: %s", driver)
	}
}

func (s *GormStore) migrate() error {
	// SQLite와 MySQL 모두에서 같은 모델로 마이그레이션이 가능하도록 GORM 모델을 통일한다.
	return s.db.AutoMigrate(&userRow{}, &refreshTokenRow{}, &hostRow{}, &snippetRow{})
}

func (s *GormStore) CreateUser(ctx context.Context, email string, passwordHash string) (User, error) {
	row := userRow{
		ID:           uuid.NewString(),
		Email:        email,
		PasswordHash: passwordHash,
	}

	if err := s.db.WithContext(ctx).Create(&row).Error; err != nil {
		return User{}, err
	}
	return User{
		ID:           row.ID,
		Email:        row.Email,
		PasswordHash: row.PasswordHash,
	}, nil
}

func (s *GormStore) GetUserByEmail(ctx context.Context, email string) (User, error) {
	var row userRow
	if err := s.db.WithContext(ctx).Where("email = ?", email).Take(&row).Error; err != nil {
		return User{}, err
	}
	return User{
		ID:           row.ID,
		Email:        row.Email,
		PasswordHash: row.PasswordHash,
	}, nil
}

func (s *GormStore) GetUserByID(ctx context.Context, id string) (User, error) {
	var row userRow
	if err := s.db.WithContext(ctx).Where("id = ?", id).Take(&row).Error; err != nil {
		return User{}, err
	}
	return User{
		ID:           row.ID,
		Email:        row.Email,
		PasswordHash: row.PasswordHash,
	}, nil
}

func (s *GormStore) SaveRefreshToken(ctx context.Context, token RefreshToken) error {
	row := refreshTokenRow{
		UserID:    token.UserID,
		TokenHash: token.TokenHash,
		ExpiresAt: token.ExpiresAt.UTC(),
	}

	// token_hash를 기준으로 refresh token을 upsert해서 SQLite/MySQL 양쪽에서 같은 동작을 유지한다.
	return s.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "token_hash"}},
			DoUpdates: clause.Assignments(map[string]any{
				"user_id":    row.UserID,
				"expires_at": row.ExpiresAt,
			}),
		}).
		Create(&row).Error
}

func (s *GormStore) GetRefreshToken(ctx context.Context, tokenHash string) (RefreshToken, error) {
	var row refreshTokenRow
	if err := s.db.WithContext(ctx).Where("token_hash = ?", tokenHash).Take(&row).Error; err != nil {
		return RefreshToken{}, err
	}
	return RefreshToken{
		UserID:    row.UserID,
		TokenHash: row.TokenHash,
		ExpiresAt: row.ExpiresAt,
	}, nil
}

func (s *GormStore) ListSyncRecords(ctx context.Context, userID string, kind string) ([]syncmodel.Record, error) {
	table, err := validateKind(kind)
	if err != nil {
		return nil, err
	}

	var rows []SyncRecordRow
	if err := s.db.WithContext(ctx).
		Table(table).
		Where("user_id = ?", userID).
		Order("updated_at DESC").
		Find(&rows).Error; err != nil {
		return nil, err
	}

	records := make([]syncmodel.Record, 0, len(rows))
	for _, row := range rows {
		records = append(records, toSyncRecord(row))
	}
	return records, nil
}

func (s *GormStore) UpsertSyncRecords(ctx context.Context, userID string, kind string, records []syncmodel.Record) error {
	table, err := validateKind(kind)
	if err != nil {
		return err
	}

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, record := range records {
			row, err := toSyncRecordRow(userID, record)
			if err != nil {
				return err
			}

			var current SyncRecordRow
			readErr := tx.Table(table).
				Where("id = ? AND user_id = ?", row.ID, row.UserID).
				Take(&current).Error
			if readErr != nil && !errors.Is(readErr, gorm.ErrRecordNotFound) {
				return readErr
			}
			if readErr == nil && current.UpdatedAt.After(row.UpdatedAt) {
				// 서버에 더 최신 데이터가 있으면 last-write-wins 규칙에 따라 덮어쓰지 않는다.
				continue
			}

			if err := tx.Table(table).
				Clauses(clause.OnConflict{
					Columns: []clause.Column{
						{Name: "id"},
						{Name: "user_id"},
					},
					DoUpdates: clause.AssignmentColumns([]string{
						"encrypted_payload",
						"updated_at",
						"deleted_at",
					}),
				}).
				Create(&row).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func toSyncRecord(row SyncRecordRow) syncmodel.Record {
	var deletedAt *string
	if row.DeletedAt != nil {
		value := row.DeletedAt.UTC().Format(time.RFC3339)
		deletedAt = &value
	}

	return syncmodel.Record{
		ID:               row.ID,
		EncryptedPayload: row.EncryptedPayload,
		UpdatedAt:        row.UpdatedAt.UTC().Format(time.RFC3339),
		DeletedAt:        deletedAt,
	}
}

func toSyncRecordRow(userID string, record syncmodel.Record) (SyncRecordRow, error) {
	updatedAt, err := time.Parse(time.RFC3339, record.UpdatedAt)
	if err != nil {
		return SyncRecordRow{}, fmt.Errorf("invalid updated_at for record %s: %w", record.ID, err)
	}

	var deletedAt *time.Time
	if record.DeletedAt != nil && *record.DeletedAt != "" {
		parsedDeletedAt, err := time.Parse(time.RFC3339, *record.DeletedAt)
		if err != nil {
			return SyncRecordRow{}, fmt.Errorf("invalid deleted_at for record %s: %w", record.ID, err)
		}
		parsedDeletedAt = parsedDeletedAt.UTC()
		deletedAt = &parsedDeletedAt
	}

	return SyncRecordRow{
		ID:               record.ID,
		UserID:           userID,
		EncryptedPayload: record.EncryptedPayload,
		UpdatedAt:        updatedAt.UTC(),
		DeletedAt:        deletedAt,
	}, nil
}

func validateKind(kind string) (string, error) {
	// Table 이름은 화이트리스트로 제한해 동적 SQL 조합을 안전하게 유지한다.
	switch kind {
	case "hosts":
		return "hosts", nil
	case "snippets":
		return "snippets", nil
	default:
		return "", fmt.Errorf("invalid sync kind: %s", kind)
	}
}
