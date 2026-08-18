package store

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/schema"

	syncmodel "dolssh/services/sync-api/internal/sync"
)

type userRow struct {
	ID    string `gorm:"column:id;primaryKey;type:varchar(191)"`
	Email string `gorm:"column:email;uniqueIndex;not null;type:varchar(255)"`
	// bcrypt/argon 해시는 길이가 충분히 예측 가능하므로 TEXT 대신 varchar로 두어
	// MySQL의 "TEXT/BLOB default 금지" 제약에 걸리지 않게 한다.
	PasswordHash string `gorm:"column:password_hash;not null;type:varchar(255)"`
	// sync_revision 은 push/reset 마다 원자적으로 +1 되는 단조 카운터다. GET /sync 의
	// ETag 로 쓰여, 변경이 없으면 클라이언트 폴링이 304 로 조기 종료하게 한다.
	SyncRevision int64 `gorm:"column:sync_revision;not null;default:0"`
	// vault_epoch 은 DEK 세대 번호다. 초기화(reset)와 재설정(CreateUserVaultV2)이 +1 하고
	// rewrap 은 유지한다. 볼트 행이 아니라 사용자 행에 있어 초기화로 볼트 행이 지워져도
	// 단조성이 유지된다 — push fence(WHERE vault_epoch = ?)와 클라이언트의 신선도 비교
	// ("descriptor 의 epoch 이 내 캐시보다 낮으면 낡은 응답") 양쪽의 근거다.
	VaultEpoch int64 `gorm:"column:vault_epoch;not null;default:0"`
	// vault_version_floor는 계정이 한 번이라도 사용한 최소 볼트 프로토콜이다. v2 설정 뒤
	// reset으로 볼트 행이 사라져도 2가 남아 구클라이언트의 v1 lazy 재생성을 막는다.
	VaultVersionFloor int `gorm:"column:vault_version_floor;not null;default:1"`
	// sync_data_floor 는 **이 계정의 데이터를 다루려면 클라이언트가 갖춰야 하는 능력 수준**이다.
	// 0 = 아무 버전이나 괜찮음.
	//
	// 왜 필요한가: 옛 클라이언트는 모르는 호스트 종류를 SSH 로 간주해 화면이 비거나(없는 필드를
	// 읽다 던진다) 레코드를 `kind:"ssh"` 로 고쳐 되올려 다른 기기의 원본까지 덮어쓴다. 그 빌드는
	// 고칠 수 없으니 서버가 동기화를 끊고 업데이트를 안내해야 하는데, **모든 계정에 하한을 걸면
	// 그 종류를 쓰지도 않는 사용자까지 업데이트를 강요받는다.** 그래서 위험한 데이터를 실제로
	// 가진 계정만 표시한다.
	//
	// 올리는 쪽은 클라이언트다 — 페이로드가 암호문이라 서버는 안을 볼 수 없다. push 헤더로
	// 받아 max 로만 갱신한다(단조). 내려가지 않는다: 그 종류를 다 지웠는지 서버가 확인할 방법이
	// 없고, 잘못 내리면 옛 클라이언트가 다시 데이터를 망칠 수 있다.
	SyncDataFloor int `gorm:"column:sync_data_floor;not null;default:0"`
	// 계정이 만들어진 시각과 이 행이 마지막으로 바뀐 시각. GORM 이 이름으로 알아보고 채운다.
	//
	// **nullable 이다.** 이 컬럼이 생기기 전에 만들어진 계정은 진짜 생성 시각을 알 수 없다.
	// NOT NULL 로 두면 AutoMigrate 가 기존 행에 무언가를 채워야 하는데(SQLite 는 아예 거부한다),
	// 마이그레이션 시각을 넣으면 "그때 가입한 계정" 이라는 거짓이 사실처럼 남는다. 모른다는 것은
	// NULL 로 둔다.
	//
	// `updated_at` 은 **행이 바뀔 때마다** 움직여야 의미가 있다. 이 파일의 users 갱신은
	// `Update`/`Updates` 를 쓴다 — `UpdateColumn` 계열은 GORM 이 자동 시각을 건너뛰므로 그것으로
	// 바꾸면 이 컬럼이 생성 시각에 멈춘 채 거짓말을 한다(예외는 migrate() 의 보정 한 곳이고,
	// 그 이유는 그쪽에 적어 두었다).
	CreatedAt *time.Time `gorm:"column:created_at"`
	UpdatedAt *time.Time `gorm:"column:updated_at"`
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

// webauthnCredentialRow — 등록된 패스키. PK 는 원본 credential id 의 sha256(hex, 64자)로,
// credential id 가 authenticator 마다 길이가 달라(수백 바이트까지) MySQL 인덱스 한계를
// 넘길 수 있어 고정 길이 해시를 키로 쓴다. CredentialID(base64url 원본)와 Data(마샬링된
// 자격증명 JSON)는 참조·복원용 컬럼이다.
type webauthnCredentialRow struct {
	CredentialIDHash string `gorm:"column:credential_id_hash;primaryKey;type:varchar(64)"`
	// 스펙상 credential id 는 최대 1023 바이트이고 base64url(무패딩) 로 담으므로 1364 자가 필요하다.
	// 인덱스가 걸린 컬럼이 아니라(PK 는 credential_id_hash) 길이를 늘려도 키 길이 제한과 무관하다.
	CredentialID string    `gorm:"column:credential_id;not null;type:varchar(1364)"`
	UserID       string    `gorm:"column:user_id;not null;index;type:varchar(191)"`
	Name         string    `gorm:"column:name;not null;default:'';type:varchar(128)"`
	Data         string    `gorm:"column:data;not null;type:text"`
	CreatedAt    time.Time `gorm:"column:created_at;not null"`
	LastUsedAt   time.Time `gorm:"column:last_used_at;not null"`
}

func (webauthnCredentialRow) TableName() string {
	return "webauthn_credentials"
}

// webauthnCeremonyRow — begin/finish 사이 일회성 챌린지 상태. exchange code 처럼 소비 시 삭제.
type webauthnCeremonyRow struct {
	ID          string `gorm:"column:id;primaryKey;type:varchar(191)"`
	UserID      string `gorm:"column:user_id;not null;default:'';index;type:varchar(191)"`
	Purpose     string `gorm:"column:purpose;not null;type:varchar(32)"`
	SessionData string `gorm:"column:session_data;not null;type:text"`
	// 청소가 이 컬럼으로 스캔하고, 계정 삭제가 user_id 로 스캔한다.
	ExpiresAt time.Time `gorm:"column:expires_at;not null;index"`
}

func (webauthnCeremonyRow) TableName() string {
	return "webauthn_ceremonies"
}

type refreshTokenRow struct {
	UserID       string     `gorm:"column:user_id;not null;index;type:varchar(191)"`
	TokenHash    string     `gorm:"column:token_hash;primaryKey;type:varchar(191)"`
	ExpiresAt    time.Time  `gorm:"column:expires_at;not null"`
	LastUsedAt   time.Time  `gorm:"column:last_used_at;not null"`
	GraceUntil   *time.Time `gorm:"column:grace_until"`
	SupersededAt *time.Time `gorm:"column:superseded_at"`
}

func (refreshTokenRow) TableName() string {
	return "refresh_tokens"
}

type exchangeCodeRow struct {
	CodeHash string `gorm:"column:code_hash;primaryKey;type:varchar(191)"`
	UserID   string `gorm:"column:user_id;not null;index;type:varchar(191)"`
	// ceremony 쪽과 같은 이유 — 만료 정리가 이 컬럼으로 스캔한다.
	ExpiresAt time.Time `gorm:"column:expires_at;not null;index"`
}

func (exchangeCodeRow) TableName() string {
	return "auth_exchange_codes"
}

// v2(E2EE) 볼트는 key_base64 를 빈 값으로 두고 wrapped_dek_base64 + KDF 파라미터만 보관한다.
// 컬럼 default 는 AutoMigrate 시 기존 v1 행을 그대로 유효하게 만들기 위한 값이다.
type userVaultKeyRow struct {
	UserID           string `gorm:"column:user_id;primaryKey;type:varchar(191)"`
	Version          int    `gorm:"column:version;not null;default:1"`
	KeyBase64        string `gorm:"column:key_base64;not null;type:varchar(255)"`
	WrappedDekBase64 string `gorm:"column:wrapped_dek_base64;not null;default:'';type:varchar(512)"`
	// dek_verifier 는 클라이언트가 제출한 DEK 공개 검증자(store.UserVaultKey.DekVerifier
	// 주석 참고). 도입 이전에 만들어진 v2 행은 빈 값으로 남고, 잠금해제한 클라이언트가
	// rewrap 경로로 지연 백필한다(서버는 DEK 를 모르므로 스스로 계산할 수 없다).
	DekVerifier    string `gorm:"column:dek_verifier;not null;default:'';type:varchar(128)"`
	KdfAlgorithm   string `gorm:"column:kdf_algorithm;not null;default:'';type:varchar(32)"`
	KdfSaltBase64  string `gorm:"column:kdf_salt_base64;not null;default:'';type:varchar(255)"`
	KdfMemoryKiB   int    `gorm:"column:kdf_memory_kib;not null;default:0"`
	KdfTimeCost    int    `gorm:"column:kdf_time_cost;not null;default:0"`
	KdfParallelism int    `gorm:"column:kdf_parallelism;not null;default:0"`
	WrapRevision   int64  `gorm:"column:wrap_revision;not null;default:0"`
}

func (userVaultKeyRow) TableName() string {
	return "user_vault_keys"
}

type userClientObservationRow struct {
	UserID               string    `gorm:"column:user_id;not null;type:varchar(191);index;uniqueIndex:idx_user_client_installation"`
	ClientName           string    `gorm:"column:client_name;not null;type:varchar(64);uniqueIndex:idx_user_client_installation"`
	ClientVersion        string    `gorm:"column:client_version;not null;type:varchar(64)"`
	Platform             string    `gorm:"column:platform;not null;type:varchar(32)"`
	ClientInstallationID string    `gorm:"column:client_installation_id;not null;type:varchar(191);uniqueIndex:idx_user_client_installation"`
	FirstSeenAt          time.Time `gorm:"column:first_seen_at;not null"`
	LastSeenAt           time.Time `gorm:"column:last_seen_at;not null;index"`
	LastAuthEvent        string    `gorm:"column:last_auth_event;not null;type:varchar(32)"`
	LastIP               string    `gorm:"column:last_ip;not null;type:varchar(255)"`
	LastUserAgent        string    `gorm:"column:last_user_agent;not null;type:text"`
}

func (userClientObservationRow) TableName() string {
	return "user_client_observations"
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

	// 만료 행 청소는 쓰기 경로에 얹혀 돈다(별도 스위퍼 고루틴 없이). begin 은 /login
	// 페이지를 볼 때마다 불리므로 매번 지우면 쓰기가 배가 된다 — 간격을 두고 한 번씩만.
	// 간격은 테이블마다 따로 센다. 하나로 묶으면 쓰기가 잦은 쪽(ceremony)이 매 창을
	// 차지해 exchange code 는 사실상 정리되지 않는다.
	sweepMu     sync.Mutex
	lastSweptAt map[string]time.Time
}

// 만료 행 청소 간격.
const expiredRowSweepInterval = 5 * time.Minute

// shouldSweepExpired 는 마지막 청소로부터 간격이 지났으면 true 를 돌려주고 시각을 갱신한다.
func (s *GormStore) shouldSweepExpired(table string, now time.Time) bool {
	s.sweepMu.Lock()
	defer s.sweepMu.Unlock()
	if s.lastSweptAt == nil {
		s.lastSweptAt = make(map[string]time.Time)
	}
	if last, ok := s.lastSweptAt[table]; ok && now.Sub(last) < expiredRowSweepInterval {
		return false
	}
	s.lastSweptAt[table] = now
	return true
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

func OpenPostgres(dsn string) (*GormStore, error) {
	return Open("postgres", dsn)
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
		return sqlite.Open(withSQLiteDefaults(dsn)), nil
	case "mysql":
		return mysql.Open(dsn), nil
	case "postgres", "postgresql":
		return postgres.Open(dsn), nil
	default:
		return nil, fmt.Errorf("unsupported db driver: %s", driver)
	}
}

// withSQLiteDefaults 는 DSN 에 명시가 없을 때 busy_timeout 과 WAL 을 기본으로 켠다.
// 지금은 pool=1 이 모든 접근을 직렬화해 잠금 충돌이 없지만, 그 가정은 코드 어디에도
// 강제돼 있지 않다 — 풀 크기를 늘리거나 외부 프로세스(백업/CLI)가 같은 파일을 열면
// busy_timeout 없인 즉시 SQLITE_BUSY 5xx 가 난다. 사용자가 DSN 에 _pragma 를 직접
// 지정했다면 그대로 존중한다.
func withSQLiteDefaults(dsn string) string {
	if strings.Contains(dsn, "_pragma=") || dsn == ":memory:" || strings.HasPrefix(dsn, "file::memory:") {
		return dsn
	}
	separator := "?"
	if strings.Contains(dsn, "?") {
		separator = "&"
	}
	return dsn + separator + "_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
}

func (s *GormStore) migrate() error {
	if err := s.db.AutoMigrate(
		&userRow{},
		&authIdentityRow{},
		&refreshTokenRow{},
		&exchangeCodeRow{},
		&userVaultKeyRow{},
		&userClientObservationRow{},
		&syncRecordRow{},
		&webauthnCredentialRow{},
		&webauthnCeremonyRow{},
	); err != nil {
		return err
	}
	// 현재 v2 행 또는 reset 이력(vault_epoch > 0)이 있는 계정은 E2EE floor를 복원한다.
	// 이 작업은 멱등이며, 이후에는 v2 생성/reset 트랜잭션이 floor를 직접 유지한다.
	//
	// **여기만 UpdateColumn 을 유지한다.** 스키마 보정은 계정에 일어난 변경이 아니라 우리 쪽
	// 사정이다 — updated_at 을 움직이면 서버를 올릴 때마다 모든 계정이 "방금 수정됨" 이 된다.
	return s.db.Model(&userRow{}).
		Where("vault_epoch > ? OR EXISTS (SELECT 1 FROM user_vault_keys WHERE user_vault_keys.user_id = users.id AND user_vault_keys.version >= ?)", 0, 2).
		UpdateColumn("vault_version_floor", 2).Error
}

func (s *GormStore) CreateUser(ctx context.Context, email string, passwordHash string) (User, error) {
	row := userRow{
		ID:           uuid.NewString(),
		Email:        email,
		PasswordHash: passwordHash,
	}

	if err := s.db.WithContext(ctx).Create(&row).Error; err != nil {
		if isDuplicateKeyError(err) {
			return User{}, ErrEmailAlreadyExists
		}
		return User{}, err
	}
	return User{
		ID:           row.ID,
		Email:        row.Email,
		PasswordHash: row.PasswordHash,
	}, nil
}

// isDuplicateKeyError 는 unique 제약 위반을 방언에 상관없이 알아본다. gorm 의
// TranslateError 는 전역 설정이라 다른 경로의 에러 형태까지 바꾸므로 여기서만 판별한다.
func isDuplicateKeyError(err error) bool {
	if errors.Is(err, gorm.ErrDuplicatedKey) {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "duplicate entry") || // MySQL 1062
		strings.Contains(message, "unique constraint") // Postgres 23505 / SQLite
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

func (s *GormStore) HasVerifiedAuthIdentity(ctx context.Context, userID string, email string) (bool, error) {
	var count int64
	err := s.db.WithContext(ctx).
		Model(&authIdentityRow{}).
		Where("user_id = ? AND email_verified = ? AND LOWER(email) = LOWER(?)", userID, true, strings.TrimSpace(email)).
		Count(&count).Error
	return count > 0, err
}

// UpdateUserPassword 는 비밀번호 해시 변경과 세션 폐기를 한 트랜잭션으로 묶는다.
// users 행을 먼저 잠가 다른 비밀번호 변경과 직렬화하고, 현재 기기의 refresh token만
// 남긴다. 변경 전에 발급된 exchange code도 지워 이전 로그인 흐름의 재사용을 막는다.
func (s *GormStore) UpdateUserPassword(
	ctx context.Context,
	userID string,
	expectedPasswordHash string,
	passwordHash string,
	keepRefreshTokenHash string,
) error {
	if userID == "" || passwordHash == "" || keepRefreshTokenHash == "" {
		return errors.New("userID, passwordHash and keepRefreshTokenHash are required")
	}
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.lockUserRowTx(tx, userID); err != nil {
			return err
		}

		var user userRow
		if err := tx.Where("id = ?", userID).Take(&user).Error; err != nil {
			return err
		}
		if user.PasswordHash != expectedPasswordHash {
			return ErrPasswordConflict
		}

		var refreshCount int64
		if err := tx.Model(&refreshTokenRow{}).
			Where("user_id = ? AND token_hash = ? AND expires_at > ?", userID, keepRefreshTokenHash, time.Now().UTC()).
			Count(&refreshCount).Error; err != nil {
			return err
		}
		if refreshCount == 0 {
			return ErrRefreshTokenNotFound
		}

		if err := tx.Model(&userRow{}).
			Where("id = ?", userID).
			Update("password_hash", passwordHash).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ? AND token_hash <> ?", userID, keepRefreshTokenHash).
			Delete(&refreshTokenRow{}).Error; err != nil {
			return err
		}
		return tx.Where("user_id = ?", userID).Delete(&exchangeCodeRow{}).Error
	})
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

func webauthnCredentialIDHash(credentialID string) string {
	sum := sha256.Sum256([]byte(credentialID))
	return hex.EncodeToString(sum[:])
}

func (s *GormStore) SaveWebAuthnCredential(ctx context.Context, credential WebAuthnCredential) error {
	now := time.Now().UTC()
	createdAt := credential.CreatedAt
	if createdAt.IsZero() {
		createdAt = now
	}
	lastUsedAt := credential.LastUsedAt
	if lastUsedAt.IsZero() {
		lastUsedAt = createdAt
	}
	row := webauthnCredentialRow{
		CredentialIDHash: webauthnCredentialIDHash(credential.CredentialID),
		CredentialID:     credential.CredentialID,
		UserID:           credential.UserID,
		Name:             credential.Name,
		Data:             string(credential.Data),
		CreatedAt:        createdAt.UTC(),
		LastUsedAt:       lastUsedAt.UTC(),
	}
	// credential id 는 인증기가 정하는 값이라 남의 것을 그대로 흉내 낼 수 있다. upsert 로
	// 쓰면 충돌 시 data(공개키까지)를 덮어써, 공격자가 소유권을 못 가져가도 피해자의 패스키를
	// 못 쓰게 만들 수 있다. "먼저 읽고 판단"은 잠그지 않으면 경쟁에 진다.
	//
	// 그래서 소유자를 조건에 넣은 UPDATE 를 먼저 하고, 0행이면 INSERT 를 시도한다. 남의
	// 자격증명이면 UPDATE 가 0행이고 INSERT 가 중복키로 튕겨 나온다 — 방언에 상관없이
	// (MySQL 의 ON DUPLICATE KEY UPDATE 는 WHERE 를 못 붙인다) 원자적이다.
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		updated := tx.Model(&webauthnCredentialRow{}).
			Where("credential_id_hash = ? AND user_id = ?", row.CredentialIDHash, row.UserID).
			Updates(map[string]any{
				"credential_id": row.CredentialID,
				"name":          row.Name,
				"data":          row.Data,
				"last_used_at":  row.LastUsedAt,
			})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected > 0 {
			return nil
		}
		if err := tx.Create(&row).Error; err != nil {
			if isDuplicateKeyError(err) {
				return ErrWebAuthnCredentialOwned
			}
			return err
		}
		return nil
	})
}

func (s *GormStore) ListWebAuthnCredentialsByUser(ctx context.Context, userID string) ([]WebAuthnCredential, error) {
	var rows []webauthnCredentialRow
	if err := s.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("created_at ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	credentials := make([]WebAuthnCredential, 0, len(rows))
	for _, row := range rows {
		credentials = append(credentials, WebAuthnCredential{
			CredentialID: row.CredentialID,
			UserID:       row.UserID,
			Name:         row.Name,
			Data:         []byte(row.Data),
			CreatedAt:    row.CreatedAt,
			LastUsedAt:   row.LastUsedAt,
		})
	}
	return credentials, nil
}

func (s *GormStore) UpdateWebAuthnCredentialData(ctx context.Context, credentialID string, data []byte, lastUsedAt time.Time) error {
	result := s.db.WithContext(ctx).
		Model(&webauthnCredentialRow{}).
		Where("credential_id_hash = ?", webauthnCredentialIDHash(credentialID)).
		Updates(map[string]any{
			"data":         string(data),
			"last_used_at": lastUsedAt.UTC(),
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (s *GormStore) DeleteWebAuthnCredential(ctx context.Context, userID string, credentialID string) error {
	return s.db.WithContext(ctx).
		Where("user_id = ? AND credential_id_hash = ?", userID, webauthnCredentialIDHash(credentialID)).
		Delete(&webauthnCredentialRow{}).Error
}

func (s *GormStore) CountWebAuthnCredentialsByUser(ctx context.Context, userID string) (int64, error) {
	var count int64
	if err := s.db.WithContext(ctx).
		Model(&webauthnCredentialRow{}).
		Where("user_id = ?", userID).
		Count(&count).Error; err != nil {
		return 0, err
	}
	return count, nil
}

func (s *GormStore) SaveWebAuthnCeremony(ctx context.Context, ceremony WebAuthnCeremony) error {
	row := webauthnCeremonyRow{
		ID:          ceremony.ID,
		UserID:      ceremony.UserID,
		Purpose:     ceremony.Purpose,
		SessionData: string(ceremony.SessionData),
		ExpiresAt:   ceremony.ExpiresAt.UTC(),
	}
	if err := s.db.WithContext(ctx).Create(&row).Error; err != nil {
		return err
	}
	// begin 은 로그인 페이지를 볼 때마다 행을 하나 남기는데, 지우는 건 성공적으로 소비된
	// 것뿐이다. 이탈·실패분을 여기서 정리하지 않으면 테이블이 끝없이 자란다.
	s.sweepExpired(&webauthnCeremonyRow{}, "id")
	return nil
}

// 한 번의 정리에서 지우는 최대 행 수. 상한이 없으면 오래 방치된 배포의 첫 정리가 수백만
// 행짜리 DELETE 가 되어, 그걸 유발한 요청(로그인)이 그동안 멈추고 테이블이 잠긴다.
const expiredRowSweepBatch = 1000

// sweepExpired 는 만료된 행을 배치만큼 지운다. 실패해도 호출자의 작업은 이미 성공했으므로
// 삼킨다. 배치를 가득 채워 지웠으면 아직 밀린 것이므로 다음 쓰기에서 곧바로 이어서 지운다.
func (s *GormStore) sweepExpired(model schema.Tabler, primaryKeyColumn string) {
	now := time.Now().UTC()
	table := model.TableName()
	if !s.shouldSweepExpired(table, now) {
		return
	}
	// LIMIT 을 건 DELETE 는 방언마다 지원이 갈려서(Postgres 는 불가) 키를 먼저 뽑아 지운다.
	// 요청 컨텍스트는 쓰지 않는다 — 클라이언트가 끊겨도 정리는 마쳐야 다음으로 밀리지 않는다.
	var keys []string
	if err := s.db.Model(model).
		Where("expires_at < ?", now).
		Limit(expiredRowSweepBatch).
		Pluck(primaryKeyColumn, &keys).Error; err != nil {
		log.Printf("store: 만료 행 조회 실패: %v", err)
		return
	}
	if len(keys) == 0 {
		return
	}
	if err := s.db.Where(primaryKeyColumn+" IN ?", keys).Delete(model).Error; err != nil {
		log.Printf("store: 만료 행 정리 실패: %v", err)
		return
	}
	if len(keys) >= expiredRowSweepBatch {
		s.allowImmediateSweep(table)
	}
}

// allowImmediateSweep 은 그 테이블의 다음 쓰기가 간격을 기다리지 않고 정리를 잇게 한다.
func (s *GormStore) allowImmediateSweep(table string) {
	s.sweepMu.Lock()
	defer s.sweepMu.Unlock()
	delete(s.lastSweptAt, table)
}

func (s *GormStore) ConsumeWebAuthnCeremony(ctx context.Context, id string) (WebAuthnCeremony, error) {
	var row webauthnCeremonyRow
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("id = ?", id).Take(&row).Error; err != nil {
			return err
		}
		// Take 은 잠그지 않는 스냅샷 읽기라, 동시에 같은 ceremony 를 소비하면 양쪽 다 행을
		// 본다(어써션 재사용). 실제로 지운 쪽만 1행이므로 RowsAffected 로 승자를 가린다.
		result := tx.Where("id = ?", id).Delete(&webauthnCeremonyRow{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		return nil
	})
	if err != nil {
		return WebAuthnCeremony{}, err
	}
	return WebAuthnCeremony{
		ID:          row.ID,
		UserID:      row.UserID,
		Purpose:     row.Purpose,
		SessionData: []byte(row.SessionData),
		ExpiresAt:   row.ExpiresAt,
	}, nil
}

func (s *GormStore) SaveRefreshToken(ctx context.Context, token RefreshToken) error {
	row := refreshTokenRow{
		UserID:       token.UserID,
		TokenHash:    token.TokenHash,
		ExpiresAt:    token.ExpiresAt.UTC(),
		LastUsedAt:   token.LastUsedAt.UTC(),
		GraceUntil:   utcTimePointer(token.GraceUntil),
		SupersededAt: utcTimePointer(token.SupersededAt),
	}
	return s.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "token_hash"}},
			DoUpdates: clause.Assignments(map[string]any{
				"user_id":       row.UserID,
				"expires_at":    row.ExpiresAt,
				"last_used_at":  row.LastUsedAt,
				"grace_until":   row.GraceUntil,
				"superseded_at": row.SupersededAt,
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
		UserID:       row.UserID,
		TokenHash:    row.TokenHash,
		ExpiresAt:    row.ExpiresAt,
		LastUsedAt:   row.LastUsedAt,
		GraceUntil:   utcTimePointer(row.GraceUntil),
		SupersededAt: utcTimePointer(row.SupersededAt),
	}, nil
}

func (s *GormStore) DeleteRefreshToken(ctx context.Context, tokenHash string) error {
	return s.db.WithContext(ctx).Where("token_hash = ?", tokenHash).Delete(&refreshTokenRow{}).Error
}

func utcTimePointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	normalized := value.UTC()
	return &normalized
}

func (s *GormStore) SaveExchangeCode(ctx context.Context, code ExchangeCode) error {
	row := exchangeCodeRow{
		CodeHash:  code.CodeHash,
		UserID:    code.UserID,
		ExpiresAt: code.ExpiresAt.UTC(),
	}
	if err := s.db.WithContext(ctx).Create(&row).Error; err != nil {
		return err
	}
	// ceremony 와 같은 이유 — 앱으로 전달되지 못한 코드가 영구히 남는다.
	s.sweepExpired(&exchangeCodeRow{}, "code_hash")
	return nil
}

func (s *GormStore) ConsumeExchangeCode(ctx context.Context, codeHash string) (ExchangeCode, error) {
	var row exchangeCodeRow
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("code_hash = ?", codeHash).Take(&row).Error; err != nil {
			return err
		}
		// ceremony 소비와 같은 이유 — Take 은 잠그지 않아 동시에 같은 코드를 쓰면 양쪽 다
		// 행을 보고, 하나의 코드에서 세션(리프레시 토큰)이 둘 발급된다.
		result := tx.Where("code_hash = ?", codeHash).Delete(&exchangeCodeRow{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		return nil
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

func toUserVaultKey(row userVaultKeyRow) UserVaultKey {
	version := row.Version
	if version == 0 {
		// AutoMigrate 이전에 만들어져 default 를 못 받은 행 방어 — 레거시는 전부 v1 이다.
		version = 1
	}
	return UserVaultKey{
		UserID:           row.UserID,
		Version:          version,
		DekVerifier:      row.DekVerifier,
		KeyBase64:        row.KeyBase64,
		WrappedDekBase64: row.WrappedDekBase64,
		KdfAlgorithm:     row.KdfAlgorithm,
		KdfSaltBase64:    row.KdfSaltBase64,
		KdfMemoryKiB:     row.KdfMemoryKiB,
		KdfTimeCost:      row.KdfTimeCost,
		KdfParallelism:   row.KdfParallelism,
		WrapRevision:     row.WrapRevision,
	}
}

const vaultDekVerifierLabel = "dolgate-dek-verifier-v1"

func legacyVaultDekVerifier(keyBase64 string) (string, error) {
	dek, err := base64.StdEncoding.DecodeString(strings.TrimSpace(keyBase64))
	if err != nil || len(dek) != 32 {
		return "", errors.New("invalid legacy vault key")
	}
	mac := hmac.New(sha256.New, dek)
	_, _ = mac.Write([]byte(vaultDekVerifierLabel))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (s *GormStore) GetOrCreateUserVaultKey(ctx context.Context, userID string) (UserVaultKey, error) {
	// lazy v1 생성도 reset/v2 설정과 같은 users → vault 잠금 순서를 따른다. 볼트 행과
	// epoch 을 같은 트랜잭션에서 읽어, reset 이후 재생성된 v1 descriptor 가 epoch 0으로
	// 내려가거나 "옛 key + 새 epoch" 조합이 만들어지지 않게 한다.
	var result UserVaultKey
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.lockUserRowTx(tx, userID); err != nil {
			return err
		}
		meta, err := getVaultMetaTx(tx, userID)
		if err != nil {
			return err
		}

		var row userVaultKeyRow
		err = tx.Where("user_id = ?", userID).Take(&row).Error
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			if err != nil {
				return err
			}
		} else {
			if meta.VersionFloor >= 2 {
				return ErrVaultE2EERequired
			}
			buffer := make([]byte, 32)
			if _, err := rand.Read(buffer); err != nil {
				return err
			}

			row = userVaultKeyRow{
				UserID:    userID,
				Version:   1,
				KeyBase64: base64.StdEncoding.EncodeToString(buffer),
			}
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
		}

		result = toUserVaultKey(row)
		result.Epoch = meta.Epoch
		return nil
	})
	if err != nil {
		return UserVaultKey{}, err
	}
	return result, nil
}

func (s *GormStore) GetUserVaultKey(ctx context.Context, userID string) (UserVaultKey, error) {
	state, err := s.GetUserVaultState(ctx, userID)
	if err != nil {
		return UserVaultKey{}, err
	}
	if state.Vault == nil {
		return UserVaultKey{}, ErrVaultNotFound
	}
	return *state.Vault, nil
}

func (s *GormStore) GetUserVaultState(ctx context.Context, userID string) (UserVaultState, error) {
	// READ COMMITTED에서는 단순히 두 SELECT를 같은 트랜잭션에 넣는 것만으로 부족하다.
	// users 행을 먼저 잠그면 reset/create와 같은 순서로 직렬화되어 old row + new epoch 같은
	// 혼합 descriptor가 만들어지지 않는다.
	var result UserVaultState
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.lockUserRowTx(tx, userID); err != nil {
			return err
		}
		meta, err := getVaultMetaTx(tx, userID)
		if err != nil {
			return err
		}
		result.Epoch = meta.Epoch
		result.VersionFloor = meta.VersionFloor

		var row userVaultKeyRow
		err = tx.Where("user_id = ?", userID).Take(&row).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		vault := toUserVaultKey(row)
		vault.Epoch = meta.Epoch
		result.Vault = &vault
		return nil
	})
	if err != nil {
		return UserVaultState{}, err
	}
	return result, nil
}

type vaultMeta struct {
	Epoch        int64
	VersionFloor int
}

func getVaultMetaTx(tx *gorm.DB, userID string) (vaultMeta, error) {
	var row userRow
	if err := tx.Select("vault_epoch", "vault_version_floor").Where("id = ?", userID).Take(&row).Error; err != nil {
		return vaultMeta{}, err
	}
	floor := row.VaultVersionFloor
	if floor < 1 {
		floor = 1
	}
	return vaultMeta{Epoch: row.VaultEpoch, VersionFloor: floor}, nil
}

// getVaultEpochTx 는 주어진 tx/DB 핸들에서 사용자의 vault_epoch 을 읽는다.
func getVaultEpochTx(tx *gorm.DB, userID string) (int64, error) {
	meta, err := getVaultMetaTx(tx, userID)
	return meta.Epoch, err
}

func (s *GormStore) GetUserVaultEpoch(ctx context.Context, userID string) (int64, error) {
	return getVaultEpochTx(s.db.WithContext(ctx), userID)
}

func (s *GormStore) CreateUserVaultV2(ctx context.Context, vault UserVaultKey, precondition VaultMutationPrecondition) (UserVaultKey, error) {
	var created UserVaultKey
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 잠금 순서 전역 규칙(users → records → vault, lockUserRowTx 주석 참고).
		if err := s.lockUserRowTx(tx, vault.UserID); err != nil {
			return err
		}
		meta, err := getVaultMetaTx(tx, vault.UserID)
		if err != nil {
			return err
		}
		if meta.Epoch != precondition.ExpectedEpoch {
			return ErrVaultEpochMismatch
		}
		var current userVaultKeyRow
		err = tx.Where("user_id = ?", vault.UserID).Take(&current).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if err == nil && current.Version >= 2 {
			return ErrVaultConflict
		}
		if err == nil && current.Version < 2 {
			if expected, verifyErr := legacyVaultDekVerifier(current.KeyBase64); verifyErr != nil || !hmac.Equal([]byte(expected), []byte(vault.DekVerifier)) {
				return ErrVaultEpochMismatch
			}
		}

		row := userVaultKeyRow{
			UserID:  vault.UserID,
			Version: 2,
			// 클라이언트가 DEK 에서 유도해 제출한 검증자. 서버는 DEK 를 모르므로 저장만 한다.
			DekVerifier: vault.DekVerifier,
			// v1 → v2 마이그레이션 지점: 서버가 보관하던 DEK 원문을 여기서 지운다.
			KeyBase64:        "",
			WrappedDekBase64: vault.WrappedDekBase64,
			KdfAlgorithm:     vault.KdfAlgorithm,
			KdfSaltBase64:    vault.KdfSaltBase64,
			KdfMemoryKiB:     vault.KdfMemoryKiB,
			KdfTimeCost:      vault.KdfTimeCost,
			KdfParallelism:   vault.KdfParallelism,
			WrapRevision:     1,
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// 두 기기가 동시에 설정하는 레이스: PK 충돌을 에러로 받으면 Postgres 는
			// 트랜잭션이 aborted 상태가 되어 이후 재확인 쿼리도 실패한다(25P02).
			// OnConflict DoNothing + RowsAffected 로 충돌을 에러 없이 판별한다.
			create := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row)
			if create.Error != nil {
				return create.Error
			}
			if create.RowsAffected > 0 {
				return finalizeVaultCreateTx(tx, vault.UserID, row, &created)
			}
			// 동시 생성 레이스의 패자. 그 사이 생긴 행이 v2 면 진짜 충돌(다른 기기가 먼저
			// 설정)이지만, 구버전 클라 로그인의 lazy v1 생성이면 마이그레이션 케이스다 —
			// 아래 v1→v2 전환 UPDATE 가 정확히 그 경우를 처리하므로 그대로 진행한다.
			var existing userVaultKeyRow
			if err := tx.Where("user_id = ?", vault.UserID).Take(&existing).Error; err != nil {
				return err
			}
			if existing.Version >= 2 {
				return ErrVaultConflict
			}
			if expected, verifyErr := legacyVaultDekVerifier(existing.KeyBase64); verifyErr != nil || !hmac.Equal([]byte(expected), []byte(vault.DekVerifier)) {
				return ErrVaultEpochMismatch
			}
		}
		// v1 → v2 in-place 전환. 동시 전환의 패자는 0 행 매칭이지만 gorm 은 nil 을 돌려주므로
		// RowsAffected 를 확인해 충돌로 알려준다(안 하면 패자가 승자의 응답으로 200 을 받아,
		// 자기 암호로 풀 수 없는 볼트를 자기 것으로 캐시하는 조용한 잠금 상태가 된다).
		update := tx.Model(&userVaultKeyRow{}).
			Where("user_id = ? AND version < ?", vault.UserID, 2).
			Select("version", "dek_verifier", "key_base64", "wrapped_dek_base64", "kdf_algorithm", "kdf_salt_base64", "kdf_memory_kib", "kdf_time_cost", "kdf_parallelism", "wrap_revision").
			Updates(&row)
		if update.Error != nil {
			return update.Error
		}
		if update.RowsAffected == 0 {
			return ErrVaultConflict
		}
		return finalizeVaultCreateTx(tx, vault.UserID, row, &created)
	})
	if err != nil {
		return UserVaultKey{}, err
	}
	return created, nil
}

// finalizeVaultCreateTx 는 볼트 설정/재설정의 마무리를 같은 트랜잭션에서 처리한다:
// (1) sync_revision +1 — 볼트 생성도 다른 기기의 폴링이 감지해야 한다(304 로 새 볼트를
// 놓치지 않도록). (2) vault_epoch +1 — 새 DEK 세대의 시작. (3) 새 epoch 을 읽어 생성된
// 볼트로 돌려준다(핸들러가 재조회 없이 응답에 싣는다).
func finalizeVaultCreateTx(tx *gorm.DB, userID string, row userVaultKeyRow, out *UserVaultKey) error {
	if err := bumpSyncRevisionTx(tx, userID, nil); err != nil {
		return err
	}
	if err := tx.Model(&userRow{}).
		Where("id = ?", userID).
		Updates(map[string]any{
			"vault_epoch":         gorm.Expr("vault_epoch + 1"),
			"vault_version_floor": 2,
		}).Error; err != nil {
		return err
	}
	epoch, err := getVaultEpochTx(tx, userID)
	if err != nil {
		return err
	}
	result := toUserVaultKey(row)
	result.Epoch = epoch
	*out = result
	return nil
}

func (s *GormStore) UpdateUserVaultV2(ctx context.Context, vault UserVaultKey, precondition VaultMutationPrecondition) (UserVaultKey, error) {
	var updated UserVaultKey
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.lockUserRowTx(tx, vault.UserID); err != nil {
			return err
		}
		meta, err := getVaultMetaTx(tx, vault.UserID)
		if err != nil {
			return err
		}
		if meta.Epoch != precondition.ExpectedEpoch || precondition.ExpectedDekVerifier == nil || precondition.ExpectedWrapRevision == nil {
			return ErrVaultEpochMismatch
		}
		var current userVaultKeyRow
		err = tx.Where("user_id = ?", vault.UserID).Take(&current).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrVaultNotFound
		}
		if err != nil {
			return err
		}
		if current.Version != 2 {
			return ErrVaultConflict
		}
		if current.WrapRevision != *precondition.ExpectedWrapRevision {
			return ErrVaultEpochMismatch
		}
		expectedVerifier := strings.TrimSpace(*precondition.ExpectedDekVerifier)
		if !hmac.Equal([]byte(current.DekVerifier), []byte(expectedVerifier)) {
			return ErrVaultEpochMismatch
		}
		if current.DekVerifier != "" && vault.DekVerifier != "" && !hmac.Equal([]byte(current.DekVerifier), []byte(vault.DekVerifier)) {
			return ErrVaultEpochMismatch
		}

		wrapperChanged :=
			current.WrappedDekBase64 != vault.WrappedDekBase64 ||
				current.KdfAlgorithm != vault.KdfAlgorithm ||
				current.KdfSaltBase64 != vault.KdfSaltBase64 ||
				current.KdfMemoryKiB != vault.KdfMemoryKiB ||
				current.KdfTimeCost != vault.KdfTimeCost ||
				current.KdfParallelism != vault.KdfParallelism
		if wrapperChanged {
			update := tx.Model(&userVaultKeyRow{}).
				Where("user_id = ? AND version = ? AND wrap_revision = ?", vault.UserID, 2, *precondition.ExpectedWrapRevision).
				Updates(map[string]any{
					"wrapped_dek_base64": vault.WrappedDekBase64,
					"kdf_algorithm":      vault.KdfAlgorithm,
					"kdf_salt_base64":    vault.KdfSaltBase64,
					"kdf_memory_kib":     vault.KdfMemoryKiB,
					"kdf_time_cost":      vault.KdfTimeCost,
					"kdf_parallelism":    vault.KdfParallelism,
					"wrap_revision":      gorm.Expr("wrap_revision + 1"),
				})
			if update.Error != nil {
				return update.Error
			}
			if update.RowsAffected == 0 {
				return ErrVaultEpochMismatch
			}
		}

		// verifier 지연 백필: verifier 도입 이전에 만들어진 v2 행에만 채운다. rewrap 은
		// DEK 불변이므로 이미 있는 verifier 와 다른 값이 오면 위 precondition에서 거부한다
		// (덮어쓰기를 허용하면 오동작 클라이언트가 다른 기기들의 로컬 검증을 깨뜨릴 수 있다).
		if vault.DekVerifier != "" && current.DekVerifier == "" {
			backfill := tx.Model(&userVaultKeyRow{}).
				Where("user_id = ? AND version = ? AND dek_verifier = ?", vault.UserID, 2, "").
				UpdateColumn("dek_verifier", vault.DekVerifier)
			if backfill.Error != nil {
				return backfill.Error
			}
			if backfill.RowsAffected == 0 {
				return ErrVaultEpochMismatch
			}
		}

		var after userVaultKeyRow
		if err := tx.Where("user_id = ?", vault.UserID).Take(&after).Error; err != nil {
			return err
		}
		epoch, err := getVaultEpochTx(tx, vault.UserID)
		if err != nil {
			return err
		}
		updated = toUserVaultKey(after)
		updated.Epoch = epoch
		return nil
	})
	if err != nil {
		return UserVaultKey{}, err
	}
	return updated, nil
}

// ResetUserVault 는 볼트 초기화 — 동기화 암호 분실 시 최후 수단으로, 볼트 행과 모든 sync
// 레코드를 지운다. 계정·인증·기기 관찰은 남으므로 사용자는 곧바로 새 볼트를 설정할 수 있다.
//
// refresh 토큰은 일부러 남긴다. 예전엔 "다른 기기가 옛 DEK 로 push 해 서버를 오염시키는
// 레이스"를 막으려고 전체 토큰을 지웠지만, 그 방식은 초기화한 기기 자신을 포함해 모든
// 기기를 강제 로그아웃시키는 부작용이 컸다. 지금은 vault_epoch fence 가 옛 세대의 push 를
// 커밋 시점에 거부하므로 오염은 토큰을 지우지 않아도 막힌다. 옛 DEK 를 든 기기는 다음
// push 에서 409 를 받고 잠금 화면으로 부드럽게 전환한다.
//
// 잠금 순서는 전역 규칙(users → sync_records → user_vault_keys, lockUserRowTx 주석
// 참고)을 따른다 — push/create 와 교차 데드락이 생기지 않도록 users 행을 먼저 잠근다.
func (s *GormStore) ResetUserVault(ctx context.Context, userID string, expectedEpoch int64) (int64, error) {
	if userID == "" {
		return 0, errors.New("userID is required")
	}
	var epoch int64
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.lockUserRowTx(tx, userID); err != nil {
			return err
		}
		meta, err := getVaultMetaTx(tx, userID)
		if err != nil {
			return err
		}
		if meta.Epoch != expectedEpoch {
			return ErrVaultEpochMismatch
		}
		if err := tx.Where("user_id = ?", userID).Delete(&syncRecordRow{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", userID).Delete(&userVaultKeyRow{}).Error; err != nil {
			return err
		}
		// 데이터가 지워졌으니 revision 을 올려 다른 기기의 폴링이 변경을 감지하게 하고,
		// epoch 을 올려 옛 DEK 세대의 push 가 재설정 전의 창에서도 fence 에 걸리게 한다.
		if err := tx.Model(&userRow{}).
			Where("id = ?", userID).
			Updates(map[string]any{
				"sync_revision":       gorm.Expr("sync_revision + 1"),
				"vault_epoch":         gorm.Expr("vault_epoch + 1"),
				"vault_version_floor": 2,
			}).Error; err != nil {
			return err
		}
		epoch, err = getVaultEpochTx(tx, userID)
		return err
	})
	if err != nil {
		return 0, err
	}
	return epoch, nil
}

func (s *GormStore) UpsertUserClientObservation(ctx context.Context, observation UserClientObservation) error {
	observedAt := observation.ObservedAt
	if observedAt.IsZero() {
		observedAt = time.Now()
	}
	observedAt = observedAt.UTC()

	row := userClientObservationRow{
		UserID:               observation.UserID,
		ClientName:           observation.ClientName,
		ClientVersion:        observation.ClientVersion,
		Platform:             observation.Platform,
		ClientInstallationID: observation.ClientInstallationID,
		FirstSeenAt:          observedAt,
		LastSeenAt:           observedAt,
		LastAuthEvent:        observation.LastAuthEvent,
		LastIP:               observation.LastIP,
		LastUserAgent:        observation.LastUserAgent,
	}

	return s.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{
				{Name: "user_id"},
				{Name: "client_name"},
				{Name: "client_installation_id"},
			},
			DoUpdates: clause.Assignments(map[string]any{
				"client_version":  row.ClientVersion,
				"platform":        row.Platform,
				"last_seen_at":    row.LastSeenAt,
				"last_auth_event": row.LastAuthEvent,
				"last_ip":         row.LastIP,
				"last_user_agent": row.LastUserAgent,
			}),
		}).
		Create(&row).Error
}

func (s *GormStore) ListSyncRecords(ctx context.Context, userID string, kind syncmodel.Kind) ([]syncmodel.Record, error) {
	if err := validateKind(kind); err != nil {
		return nil, err
	}
	return listSyncRecordsTx(s.db.WithContext(ctx), userID, kind)
}

// listSyncRecordsTx 는 주어진 tx/DB 핸들에서 한 kind 의 레코드를 읽는다. GetSyncSnapshot 이
// revision + 모든 kind 를 단일 읽기 트랜잭션으로 묶는 데 재사용한다.
// listAllSyncRecordsTx 는 이 사용자의 모든 레코드를 kind 로 묶어 돌려준다. 레코드가 하나도
// 없는 kind 는 키 자체가 없다 — 클라이언트는 없는 배열을 빈 배열로 다룬다.
func listAllSyncRecordsTx(tx *gorm.DB, userID string) (syncmodel.Payload, error) {
	var rows []syncRecordRow
	if err := tx.
		Where("user_id = ?", userID).
		Order("updated_at DESC").
		Find(&rows).Error; err != nil {
		return nil, err
	}

	payload := make(syncmodel.Payload)
	for _, row := range rows {
		kind := syncmodel.Kind(row.Kind)
		payload[kind] = append(payload[kind], toSyncRecord(row))
	}
	return payload, nil
}

func listSyncRecordsTx(tx *gorm.DB, userID string, kind syncmodel.Kind) ([]syncmodel.Record, error) {
	var rows []syncRecordRow
	if err := tx.
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

func (s *GormStore) GetSyncRevision(ctx context.Context, userID string) (int64, error) {
	var row userRow
	err := s.db.WithContext(ctx).Select("sync_revision").Where("id = ?", userID).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return row.SyncRevision, nil
}

// GetSyncDataFloor 는 이 계정의 데이터가 요구하는 클라이언트 능력 수준이다(userRow 주석 참고).
// 계정 행이 없으면 0 — 게이트하지 않는다.
func (s *GormStore) GetSyncDataFloor(ctx context.Context, userID string) (int, error) {
	var row userRow
	err := s.db.WithContext(ctx).Select("sync_data_floor").Where("id = ?", userID).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return row.SyncDataFloor, nil
}

// RaiseSyncDataFloor 는 floor 를 올리기만 한다.
//
// 단일 UPDATE 의 WHERE 로 단조성을 지킨다 — 앱에서 읽고 비교해 쓰면 동시 push 두 개가 서로의
// 값을 덮어 낮은 쪽이 이길 수 있다. 이미 같거나 높으면 아무 행도 바뀌지 않는다(오류 아님).
//
// **내리는 길은 없다.** 아직 pull 하지 않은 기기는 그 데이터를 아직 로컬에 안 갖고 있어서 자기
// 수준을 0 으로 신고한다 — 그 신고로 계정을 내리면 다른 기기가 올린 보호가 사라진다. 그래서 자동
// 하강을 만들면 안 된다. 대가로, 계정에서 그 종류를 전부 지워도 수준은 남는다(예: RDP 호스트를
// 다 지운 계정의 옛 기기는 계속 막힌다). 필요해지면 지원용 경로를 따로 만든다.
func (s *GormStore) RaiseSyncDataFloor(ctx context.Context, userID string, floor int) error {
	if floor <= 0 {
		return nil
	}
	return s.db.WithContext(ctx).Model(&userRow{}).
		Where("id = ? AND sync_data_floor < ?", userID, floor).
		Update("sync_data_floor", floor).Error
}

// bumpSyncRevisionTx 는 주어진 트랜잭션에서 원자적 UPDATE(sync_revision = sync_revision + 1)
// 로 카운터를 올리고 새 값을 out 에 담는다. 앱 코드의 read-modify-write 가 아니라 DB 단일
// 문장이라 동시 push 에서도 lost update 없이 직렬화된다.
func bumpSyncRevisionTx(tx *gorm.DB, userID string, out *int64) error {
	if err := tx.Model(&userRow{}).
		Where("id = ?", userID).
		Update("sync_revision", gorm.Expr("sync_revision + 1")).Error; err != nil {
		return err
	}
	var row userRow
	if err := tx.Select("sync_revision").Where("id = ?", userID).Take(&row).Error; err != nil {
		return err
	}
	if out != nil {
		*out = row.SyncRevision
	}
	return nil
}

func (s *GormStore) UpsertSyncRecords(ctx context.Context, userID string, kind syncmodel.Kind, records []syncmodel.Record) error {
	if err := validateKind(kind); err != nil {
		return err
	}

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.lockUserRowTx(tx, userID); err != nil {
			return err
		}
		_, err := upsertSyncRecordsTx(tx, userID, kind, records)
		return err
	})
}

// lockUserRowTx 는 사용자 행을 SELECT ... FOR UPDATE 로 잠가, 이 사용자의 볼트/레코드
// 쓰기 트랜잭션 전체(read-compare-write)를 시작 시점부터 직렬화한다. 레코드별 행 잠금은
// "아직 존재하지 않는 행"(동시 신규 생성)을 잠글 수 없어 LWW 경쟁이 남지만, 사용자 행
// 잠금은 push 두 개가 같은 새 ID 를 만들며 서로의 읽기를 앞지르는 것까지 막는다.
//
// 잠금 순서 전역 규칙: users → sync_records → user_vault_keys. push/reset/create 가
// 모두 이 순서를 지켜야 교차 데드락이 없다.
//
// SQLite 는 FOR UPDATE 문법이 없고 pool=1 이 모든 접근을 직렬화하므로 잠그지 않는다.
func (s *GormStore) lockUserRowTx(tx *gorm.DB, userID string) error {
	if s.driver == "sqlite" {
		return nil
	}
	var row userRow
	return tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Select("id").Where("id = ?", userID).Take(&row).Error
}

// upsertSyncRecordsTx 는 주어진 트랜잭션 안에서 한 kind 의 레코드를 upsert 하고 실제로 쓴
// 행 수를 돌려준다(개별 tx 를 열지 않는다). ApplyPushRecords 가 모든 kind + revision bump
// 를 한 트랜잭션으로 묶고, 변경 0건이면 bump 를 생략하는 데 쓴다. 동시성 안전은 호출자의
// 사용자 행 선잠금(lockUserRowTx)이 보장한다.
func upsertSyncRecordsTx(tx *gorm.DB, userID string, kind syncmodel.Kind, records []syncmodel.Record) (int, error) {
	written := 0
	for _, record := range records {
		row, err := toSyncRecordRow(userID, kind, record)
		if err != nil {
			// 클라이언트가 보낸 레코드 자체가 잘못된 것(잘못된 타임스탬프 등) — 서버 오류가
			// 아니라 400 으로 분류되도록 sentinel 을 감싼다.
			return written, fmt.Errorf("%w: %v", ErrBadSyncRecord, err)
		}

		var current syncRecordRow
		readErr := tx.Where("id = ? AND user_id = ? AND kind = ?", row.ID, row.UserID, row.Kind).Take(&current).Error
		if readErr != nil && !errors.Is(readErr, gorm.ErrRecordNotFound) {
			return written, readErr
		}
		if readErr == nil {
			if current.UpdatedAt.After(row.UpdatedAt) {
				continue
			}
			// 동일 타임스탬프 + 동일 내용은 변경이 아니다(전체 스냅샷을 매번 push 하는
			// 클라이언트의 재-push). written 으로 세지 않아야 no-op push 가 revision 을
			// 올려 다른 기기들의 304 최적화를 무력화하지 않는다. 동일 타임스탬프인데
			// 내용이 다르면 기존대로 마지막 쓰기가 이긴다.
			if current.UpdatedAt.Equal(row.UpdatedAt) &&
				current.EncryptedPayload == row.EncryptedPayload &&
				equalTimePointers(current.DeletedAt, row.DeletedAt) {
				continue
			}
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
			return written, err
		}
		written++
	}
	return written, nil
}

// ApplyPushRecords 는 push 페이로드의 모든 kind upsert 와 sync_revision bump 를 단일
// 트랜잭션으로 처리하고 revision 을 돌려준다. 이렇게 해야 "데이터는 커밋됐는데 revision
// 은 옛 값" 인 창이 사라져(원자성), 다른 기기가 304 로 변경을 놓치지 않는다.
// LWW 로 전부 스킵된(=실제 변경 0건) push 는 bump 하지 않고 현재 revision 을 돌려준다 —
// 무변경 재-push 루프 하나가 전 기기의 304 최적화를 무력화하지 않게 한다.
//
// fence는 라우터가 사전 검사에서 본 epoch+version이다. 사용자 행 잠금을 얻은 직후 현재
// 상태와 대조하므로, v1 구클라이언트 push도 reset/v2 migration이 먼저 커밋됐다면 어떤
// 레코드도 쓰기 전에 거부된다.
func (s *GormStore) ApplyPushRecords(ctx context.Context, userID string, payload syncmodel.Payload, fence VaultPushFence) (int64, error) {
	// 페이로드에 담긴 kind 만 순회한다. 안 담긴 kind 는 손대지 않는다 — 그래서 tailnets 를
	// 모르는 구버전 클라이언트가 push 해도 서버의 tailnets 레코드가 지워지지 않는다.
	if err := payload.Validate(); err != nil {
		return 0, fmt.Errorf("%w: %v", ErrBadSyncRecord, err)
	}
	kinds := payload.Kinds()
	var revision int64
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 사용자 행 선잠금 — 이 사용자의 push 전체를 직렬화해 LWW 판정이 항상 최신
		// 커밋 기준이 되게 한다(신규 레코드 동시 생성 경쟁 포함).
		if err := s.lockUserRowTx(tx, userID); err != nil {
			return err
		}
		if err := validateVaultPushFenceTx(tx, userID, fence); err != nil {
			return err
		}
		totalWritten := 0
		for _, kind := range kinds {
			written, err := upsertSyncRecordsTx(tx, userID, kind, payload[kind])
			if err != nil {
				return err
			}
			totalWritten += written
		}
		if totalWritten == 0 {
			var row userRow
			if err := tx.Select("sync_revision").Where("id = ?", userID).Take(&row).Error; err != nil {
				return err
			}
			revision = row.SyncRevision
			return nil
		}
		result := tx.Model(&userRow{}).
			Where("id = ?", userID).
			Update("sync_revision", gorm.Expr("sync_revision + 1"))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		var row userRow
		if err := tx.Select("sync_revision").Where("id = ?", userID).Take(&row).Error; err != nil {
			return err
		}
		revision = row.SyncRevision
		return nil
	})
	if err != nil {
		return 0, err
	}
	return revision, nil
}

func validateVaultPushFenceTx(tx *gorm.DB, userID string, fence VaultPushFence) error {
	var user userRow
	if err := tx.Select("vault_epoch").Where("id = ?", userID).Take(&user).Error; err != nil {
		return err
	}
	if user.VaultEpoch != fence.Epoch {
		return ErrVaultEpochMismatch
	}
	var vault userVaultKeyRow
	if err := tx.Select("version").Where("user_id = ?", userID).Take(&vault).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrVaultEpochMismatch
		}
		return err
	}
	version := vault.Version
	if version == 0 {
		version = 1
	}
	if version != fence.Version {
		return ErrVaultEpochMismatch
	}
	return nil
}

// GetSyncSnapshot 은 revision 과 모든 kind 의 레코드를 단일 (읽기) 트랜잭션에서 읽어
// 일관 스냅샷으로 돌려준다. revision 을 함께 읽어 ETag 와 데이터가 어긋나지 않게 한다.
func (s *GormStore) GetSyncSnapshot(ctx context.Context, userID string) (int64, syncmodel.Payload, error) {
	var revision int64
	var payload syncmodel.Payload
	readSnapshot := func(tx *gorm.DB) error {
		var row userRow
		rerr := tx.Select("sync_revision").Where("id = ?", userID).Take(&row).Error
		if rerr != nil && !errors.Is(rerr, gorm.ErrRecordNotFound) {
			return rerr
		}
		revision = row.SyncRevision

		// 종류별로 쿼리하면 kind 목록을 서버가 알아야 한다. 사용자 행을 한 번 읽어
		// kind 로 묶으면 서버가 몰라도 되고, 왕복도 kind 수만큼에서 한 번으로 준다.
		var lerr error
		payload, lerr = listAllSyncRecordsTx(tx, userID)
		return lerr
	}
	var err error
	if s.driver == "sqlite" {
		err = s.db.WithContext(ctx).Transaction(readSnapshot)
	} else {
		err = s.db.WithContext(ctx).Transaction(readSnapshot, &sql.TxOptions{
			Isolation: sql.LevelRepeatableRead,
			ReadOnly:  true,
		})
	}
	if err != nil {
		return 0, nil, err
	}
	return revision, payload, nil
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

func equalTimePointers(a *time.Time, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}

// validateKind 는 형식만 본다. 어떤 kind 인지는 서버가 알 필요가 없다 — 그것을 열거하면
// 동기화 항목을 하나 늘릴 때마다 서버 배포가 묶인다.
func validateKind(kind syncmodel.Kind) error {
	return syncmodel.ValidateKind(kind)
}

// UserExists 는 탈퇴 여부 판별용 — "행 없음"은 (false, nil), 드라이버 에러만 err.
func (s *GormStore) UserExists(ctx context.Context, userID string) (bool, error) {
	var count int64
	if err := s.db.WithContext(ctx).Model(&userRow{}).Where("id = ?", userID).Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

// DeleteUserData 는 회원 탈퇴용으로 사용자의 모든 행을 단일 트랜잭션으로 hard delete 한다.
// sync_records 는 soft-delete 표시(deleted_at)와 무관하게 행 자체를 지운다("흔적 없이").
func (s *GormStore) DeleteUserData(ctx context.Context, userID string) error {
	if userID == "" {
		return errors.New("userID is required")
	}
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// push/reset/setup 과 같은 users 선잠금 순서를 지켜 반대 순서의 교착을 막는다.
		if err := s.lockUserRowTx(tx, userID); err != nil {
			return err
		}
		targets := []struct {
			model  any
			column string
		}{
			{&syncRecordRow{}, "user_id"},
			{&userVaultKeyRow{}, "user_id"},
			{&userClientObservationRow{}, "user_id"},
			{&refreshTokenRow{}, "user_id"},
			{&exchangeCodeRow{}, "user_id"},
			{&webauthnCredentialRow{}, "user_id"},
			{&webauthnCeremonyRow{}, "user_id"},
			{&authIdentityRow{}, "user_id"},
			{&userRow{}, "id"},
		}
		for _, target := range targets {
			if err := tx.Where(target.column+" = ?", userID).Delete(target.model).Error; err != nil {
				return err
			}
		}
		return nil
	})
}
