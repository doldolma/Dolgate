package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	syncmodel "dolssh/services/sync-api/internal/sync"
)

type userRow struct {
	ID    string `gorm:"column:id;primaryKey;type:varchar(191)"`
	Email string `gorm:"column:email;uniqueIndex;not null;type:varchar(255)"`
	// bcrypt/argon 해시는 길이가 충분히 예측 가능하므로 TEXT 대신 varchar로 두어
	// MySQL의 "TEXT/BLOB default 금지" 제약에 걸리지 않게 한다.
	PasswordHash string `gorm:"column:password_hash;not null;type:varchar(255)"`
}

func (userRow) TableName() string {
	return "users"
}

type authIdentityRow struct {
	Provider      string `gorm:"column:provider;primaryKey;type:varchar(64)"`
	Subject       string `gorm:"column:subject;primaryKey;type:varchar(255)"`
	UserID        string `gorm:"column:user_id;not null;index;type:varchar(191)"`
	Email         string `gorm:"column:email;not null;type:varchar(255)"`
	EmailVerified bool   `gorm:"column:email_verified;not null"`
}

func (authIdentityRow) TableName() string {
	return "auth_identities"
}

type refreshTokenRow struct {
	UserID     string    `gorm:"column:user_id;not null;index;type:varchar(191)"`
	TokenHash  string    `gorm:"column:token_hash;primaryKey;type:varchar(191)"`
	ExpiresAt  time.Time `gorm:"column:expires_at;not null"`
	LastUsedAt time.Time `gorm:"column:last_used_at;not null"`
}

func (refreshTokenRow) TableName() string {
	return "refresh_tokens"
}

type exchangeCodeRow struct {
	CodeHash  string    `gorm:"column:code_hash;primaryKey;type:varchar(191)"`
	UserID    string    `gorm:"column:user_id;not null;index;type:varchar(191)"`
	ExpiresAt time.Time `gorm:"column:expires_at;not null"`
}

func (exchangeCodeRow) TableName() string {
	return "auth_exchange_codes"
}

type userVaultKeyRow struct {
	UserID    string `gorm:"column:user_id;primaryKey;type:varchar(191)"`
	KeyBase64 string `gorm:"column:key_base64;not null;type:varchar(255)"`
}

func (userVaultKeyRow) TableName() string {
	return "user_vault_keys"
}

type syncRecordRow struct {
	ID               string     `gorm:"column:id;primaryKey;type:varchar(191)"`
	UserID           string     `gorm:"column:user_id;primaryKey;index;type:varchar(191)"`
	Kind             string     `gorm:"column:kind;primaryKey;type:varchar(64)"`
	EncryptedPayload string     `gorm:"column:encrypted_payload;not null;type:text"`
	UpdatedAt        time.Time  `gorm:"column:updated_at;not null;autoUpdateTime:false"`
	DeletedAt        *time.Time `gorm:"column:deleted_at"`
}

func (syncRecordRow) TableName() string {
	return "sync_records"
}

type GormStore struct {
	db     *gorm.DB
	driver string
}

func Open(driver string, dsn string) (*GormStore, error) {
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
		_ = sqlDB.Close()
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

func (s *GormStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}

	sqlDB, err := s.db.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
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
	return s.db.AutoMigrate(
		&userRow{},
		&authIdentityRow{},
		&refreshTokenRow{},
		&exchangeCodeRow{},
		&userVaultKeyRow{},
		&syncRecordRow{},
	)
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

func (s *GormStore) GetAuthIdentity(ctx context.Context, provider string, subject string) (AuthIdentity, error) {
	var row authIdentityRow
	if err := s.db.WithContext(ctx).Where("provider = ? AND subject = ?", provider, subject).Take(&row).Error; err != nil {
		return AuthIdentity{}, err
	}
	return AuthIdentity{
		UserID:        row.UserID,
		Provider:      row.Provider,
		Subject:       row.Subject,
		Email:         row.Email,
		EmailVerified: row.EmailVerified,
	}, nil
}

func (s *GormStore) SaveAuthIdentity(ctx context.Context, identity AuthIdentity) error {
	row := authIdentityRow{
		UserID:        identity.UserID,
		Provider:      identity.Provider,
		Subject:       identity.Subject,
		Email:         identity.Email,
		EmailVerified: identity.EmailVerified,
	}
	return s.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{
				{Name: "provider"},
				{Name: "subject"},
			},
			DoUpdates: clause.Assignments(map[string]any{
				"user_id":        row.UserID,
				"email":          row.Email,
				"email_verified": row.EmailVerified,
			}),
		}).
		Create(&row).Error
}

func (s *GormStore) SaveRefreshToken(ctx context.Context, token RefreshToken) error {
	row := refreshTokenRow{
		UserID:     token.UserID,
		TokenHash:  token.TokenHash,
		ExpiresAt:  token.ExpiresAt.UTC(),
		LastUsedAt: token.LastUsedAt.UTC(),
	}
	return s.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "token_hash"}},
			DoUpdates: clause.Assignments(map[string]any{
				"user_id":      row.UserID,
				"expires_at":   row.ExpiresAt,
				"last_used_at": row.LastUsedAt,
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
		UserID:     row.UserID,
		TokenHash:  row.TokenHash,
		ExpiresAt:  row.ExpiresAt,
		LastUsedAt: row.LastUsedAt,
	}, nil
}

func (s *GormStore) DeleteRefreshToken(ctx context.Context, tokenHash string) error {
	return s.db.WithContext(ctx).Where("token_hash = ?", tokenHash).Delete(&refreshTokenRow{}).Error
}

func (s *GormStore) SaveExchangeCode(ctx context.Context, code ExchangeCode) error {
	row := exchangeCodeRow{
		CodeHash:  code.CodeHash,
		UserID:    code.UserID,
		ExpiresAt: code.ExpiresAt.UTC(),
	}
	return s.db.WithContext(ctx).Create(&row).Error
}

func (s *GormStore) ConsumeExchangeCode(ctx context.Context, codeHash string) (ExchangeCode, error) {
	var row exchangeCodeRow
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("code_hash = ?", codeHash).Take(&row).Error; err != nil {
			return err
		}
		return tx.Where("code_hash = ?", codeHash).Delete(&exchangeCodeRow{}).Error
	})
	if err != nil {
		return ExchangeCode{}, err
	}
	return ExchangeCode{
		UserID:    row.UserID,
		CodeHash:  row.CodeHash,
		ExpiresAt: row.ExpiresAt,
	}, nil
}

func (s *GormStore) GetOrCreateUserVaultKey(ctx context.Context, userID string) (UserVaultKey, error) {
	var row userVaultKeyRow
	err := s.db.WithContext(ctx).Where("user_id = ?", userID).Take(&row).Error
	if err == nil {
		return UserVaultKey{
			UserID:    row.UserID,
			KeyBase64: row.KeyBase64,
		}, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return UserVaultKey{}, err
	}

	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return UserVaultKey{}, err
	}

	row = userVaultKeyRow{
		UserID:    userID,
		KeyBase64: base64.StdEncoding.EncodeToString(buffer),
	}
	if err := s.db.WithContext(ctx).Create(&row).Error; err != nil {
		return UserVaultKey{}, err
	}
	return UserVaultKey{
		UserID:    row.UserID,
		KeyBase64: row.KeyBase64,
	}, nil
}

func (s *GormStore) ListSyncRecords(ctx context.Context, userID string, kind syncmodel.Kind) ([]syncmodel.Record, error) {
	if err := validateKind(kind); err != nil {
		return nil, err
	}

	var rows []syncRecordRow
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND kind = ?", userID, string(kind)).
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

func (s *GormStore) UpsertSyncRecords(ctx context.Context, userID string, kind syncmodel.Kind, records []syncmodel.Record) error {
	if err := validateKind(kind); err != nil {
		return err
	}

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, record := range records {
			row, err := toSyncRecordRow(userID, kind, record)
			if err != nil {
				return err
			}

			var current syncRecordRow
			readErr := tx.Where("id = ? AND user_id = ? AND kind = ?", row.ID, row.UserID, row.Kind).Take(&current).Error
			if readErr != nil && !errors.Is(readErr, gorm.ErrRecordNotFound) {
				return readErr
			}
			if readErr == nil && current.UpdatedAt.After(row.UpdatedAt) {
				continue
			}

			if err := tx.
				Clauses(clause.OnConflict{
					Columns: []clause.Column{
						{Name: "id"},
						{Name: "user_id"},
						{Name: "kind"},
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

func toSyncRecord(row syncRecordRow) syncmodel.Record {
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

func toSyncRecordRow(userID string, kind syncmodel.Kind, record syncmodel.Record) (syncRecordRow, error) {
	updatedAt, err := time.Parse(time.RFC3339, record.UpdatedAt)
	if err != nil {
		return syncRecordRow{}, fmt.Errorf("invalid updated_at for record %s: %w", record.ID, err)
	}

	var deletedAt *time.Time
	if record.DeletedAt != nil && *record.DeletedAt != "" {
		parsedDeletedAt, err := time.Parse(time.RFC3339, *record.DeletedAt)
		if err != nil {
			return syncRecordRow{}, fmt.Errorf("invalid deleted_at for record %s: %w", record.ID, err)
		}
		parsedDeletedAt = parsedDeletedAt.UTC()
		deletedAt = &parsedDeletedAt
	}

	return syncRecordRow{
		ID:               record.ID,
		UserID:           userID,
		Kind:             string(kind),
		EncryptedPayload: record.EncryptedPayload,
		UpdatedAt:        updatedAt.UTC(),
		DeletedAt:        deletedAt,
	}, nil
}

func validateKind(kind syncmodel.Kind) error {
	switch kind {
	case syncmodel.KindGroups, syncmodel.KindHosts, syncmodel.KindSecrets, syncmodel.KindKnownHosts, syncmodel.KindPortForwards, syncmodel.KindPreferences:
		return nil
	default:
		return fmt.Errorf("invalid sync kind: %s", kind)
	}
}
