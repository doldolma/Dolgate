package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	syncmodel "dolssh/services/sync-api/internal/sync"
	"gorm.io/gorm"
)

func testStringPtr(value string) *string {
	return &value
}

func testInt64Ptr(value int64) *int64 {
	return &value
}

type storeTestCase struct {
	name string
	open func(t *testing.T) *GormStore
}

func storeTestCases() []storeTestCase {
	cases := []storeTestCase{
		{name: "sqlite", open: openSQLiteTestStore},
	}

	if dsn := strings.TrimSpace(os.Getenv("SYNC_API_POSTGRES_DSN")); dsn != "" {
		cases = append(cases, storeTestCase{
			name: "postgres",
			open: func(t *testing.T) *GormStore {
				return openPostgresTestStore(t, dsn)
			},
		})
	}
	if dsn := strings.TrimSpace(os.Getenv("SYNC_API_MYSQL_DSN")); dsn != "" {
		cases = append(cases, storeTestCase{
			name: "mysql",
			open: func(t *testing.T) *GormStore {
				return openMySQLTestStore(t, dsn)
			},
		})
	}

	return cases
}

func openSQLiteTestStore(t *testing.T) *GormStore {
	t.Helper()

	store, err := OpenSQLite(filepath.Join(t.TempDir(), "sync-api-test.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("Close() error = %v", err)
		}
	})
	return store
}

func openPostgresTestStore(t *testing.T, dsn string) *GormStore {
	t.Helper()

	store, err := OpenPostgres(dsn)
	if err != nil {
		t.Fatalf("OpenPostgres() error = %v", err)
	}
	resetTestStore(t, store)
	t.Cleanup(func() {
		resetTestStore(t, store)
		if err := store.Close(); err != nil {
			t.Fatalf("Close() error = %v", err)
		}
	})
	return store
}

func openMySQLTestStore(t *testing.T, dsn string) *GormStore {
	t.Helper()

	store, err := OpenMySQL(dsn)
	if err != nil {
		t.Fatalf("OpenMySQL() error = %v", err)
	}
	resetTestStore(t, store)
	t.Cleanup(func() {
		resetTestStore(t, store)
		if err := store.Close(); err != nil {
			t.Fatalf("Close() error = %v", err)
		}
	})
	return store
}

func resetTestStore(t *testing.T, store *GormStore) {
	t.Helper()

	tables := []string{
		"sync_records",
		"user_client_observations",
		"user_vault_keys",
		"auth_exchange_codes",
		"refresh_tokens",
		"auth_identities",
		"users",
	}
	for _, table := range tables {
		if err := store.db.Exec("DELETE FROM " + table).Error; err != nil {
			t.Fatalf("reset table %s: %v", table, err)
		}
	}
}

func TestOpenDialectorSupportsPostgresAliases(t *testing.T) {
	for _, driver := range []string{"postgres", "postgresql"} {
		t.Run(driver, func(t *testing.T) {
			dialector, err := openDialector(driver, "host=localhost user=dolgate dbname=dolgate sslmode=disable")
			if err != nil {
				t.Fatalf("openDialector(%q) error = %v", driver, err)
			}
			if dialector.Name() != "postgres" {
				t.Fatalf("dialector.Name() = %q, want postgres", dialector.Name())
			}
		})
	}
}

func TestOpenDialectorRejectsUnsupportedDriver(t *testing.T) {
	_, err := openDialector("oracle", "")
	if err == nil || !strings.Contains(err.Error(), "unsupported db driver: oracle") {
		t.Fatalf("openDialector() error = %v, want unsupported driver", err)
	}
}

func TestGormStoreUserAndIdentityLifecycle(t *testing.T) {
	for _, tc := range storeTestCases() {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			store := tc.open(t)

			user, err := store.CreateUser(ctx, "user@example.com", "hash")
			if err != nil {
				t.Fatalf("CreateUser() error = %v", err)
			}

			byEmail, err := store.GetUserByEmail(ctx, "user@example.com")
			if err != nil {
				t.Fatalf("GetUserByEmail() error = %v", err)
			}
			if byEmail.ID != user.ID {
				t.Fatalf("GetUserByEmail().ID = %q, want %q", byEmail.ID, user.ID)
			}

			if err := store.SaveAuthIdentity(ctx, AuthIdentity{
				UserID:        user.ID,
				Provider:      "oidc",
				Subject:       "sub-1",
				Email:         user.Email,
				EmailVerified: true,
			}); err != nil {
				t.Fatalf("SaveAuthIdentity() error = %v", err)
			}

			identity, err := store.GetAuthIdentity(ctx, "oidc", "sub-1")
			if err != nil {
				t.Fatalf("GetAuthIdentity() error = %v", err)
			}
			if identity.UserID != user.ID || !identity.EmailVerified {
				t.Fatalf("identity = %+v, want user %q verified", identity, user.ID)
			}
		})
	}
}

func TestGormStoreExchangeCodesAndVaultKeys(t *testing.T) {
	for _, tc := range storeTestCases() {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			store := tc.open(t)

			user, err := store.CreateUser(ctx, "exchange@example.com", "hash")
			if err != nil {
				t.Fatalf("CreateUser() error = %v", err)
			}

			expiresAt := time.Now().Add(2 * time.Minute).UTC().Truncate(time.Second)
			if err := store.SaveExchangeCode(ctx, ExchangeCode{
				UserID:    user.ID,
				CodeHash:  "code-hash",
				ExpiresAt: expiresAt,
			}); err != nil {
				t.Fatalf("SaveExchangeCode() error = %v", err)
			}

			code, err := store.ConsumeExchangeCode(ctx, "code-hash")
			if err != nil {
				t.Fatalf("ConsumeExchangeCode() error = %v", err)
			}
			if code.UserID != user.ID {
				t.Fatalf("ConsumeExchangeCode().UserID = %q, want %q", code.UserID, user.ID)
			}

			firstKey, err := store.GetOrCreateUserVaultKey(ctx, user.ID)
			if err != nil {
				t.Fatalf("GetOrCreateUserVaultKey() error = %v", err)
			}
			secondKey, err := store.GetOrCreateUserVaultKey(ctx, user.ID)
			if err != nil {
				t.Fatalf("GetOrCreateUserVaultKey() second call error = %v", err)
			}
			if firstKey.KeyBase64 != secondKey.KeyBase64 {
				t.Fatalf("vault key changed between calls: %q != %q", firstKey.KeyBase64, secondKey.KeyBase64)
			}
		})
	}
}

func TestGormStoreSyncRecordsPreferNewestPayload(t *testing.T) {
	for _, tc := range storeTestCases() {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			store := tc.open(t)

			// 유저 행 선잠금(lockUserRowTx)이 실제 users 행을 요구하므로(postgres/mysql),
			// 실서비스 흐름처럼 유저를 만들고 시작한다.
			user, err := store.CreateUser(ctx, "records@example.com", "hash")
			if err != nil {
				t.Fatalf("CreateUser() error = %v", err)
			}

			if err := store.UpsertSyncRecords(ctx, user.ID, syncmodel.KindHosts, []syncmodel.Record{
				{
					ID:               "host-1",
					EncryptedPayload: "newer",
					UpdatedAt:        "2025-01-02T00:00:00Z",
				},
				{
					ID:               "host-2",
					EncryptedPayload: "latest",
					UpdatedAt:        "2025-01-03T00:00:00Z",
				},
			}); err != nil {
				t.Fatalf("UpsertSyncRecords() initial error = %v", err)
			}

			if err := store.UpsertSyncRecords(ctx, user.ID, syncmodel.KindHosts, []syncmodel.Record{
				{
					ID:               "host-1",
					EncryptedPayload: "older",
					UpdatedAt:        "2025-01-01T00:00:00Z",
				},
			}); err != nil {
				t.Fatalf("UpsertSyncRecords() stale update error = %v", err)
			}

			records, err := store.ListSyncRecords(ctx, user.ID, syncmodel.KindHosts)
			if err != nil {
				t.Fatalf("ListSyncRecords() error = %v", err)
			}
			if len(records) != 2 {
				t.Fatalf("len(records) = %d, want 2", len(records))
			}
			if records[0].ID != "host-2" || records[0].EncryptedPayload != "latest" {
				t.Fatalf("records[0] = %+v, want newest host-2 payload", records[0])
			}
			if records[1].ID != "host-1" || records[1].EncryptedPayload != "newer" {
				t.Fatalf("records[1] = %+v, want preserved newer payload", records[1])
			}
		})
	}
}

// 탈퇴(hard delete) 후 뒤늦게 도착한 push 가 삭제된 유저의 레코드를 부활시키면 안 된다.
// postgres/mysql 은 유저 행 선잠금(lockUserRowTx)이 존재 확인을 겸해 record not found 로
// 거부한다. sqlite 는 FOR UPDATE 미지원으로 잠금을 건너뛰어 이 보장이 store 단에 없으므로
// (존재 확인은 상위 인증 레이어 몫) 스킵한다.
func TestGormStoreUpsertSyncRecordsRejectsMissingUser(t *testing.T) {
	for _, tc := range storeTestCases() {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "sqlite" {
				t.Skip("sqlite 는 유저 행 잠금을 건너뛰어 store 단 존재 확인이 없다")
			}
			ctx := context.Background()
			store := tc.open(t)

			err := store.UpsertSyncRecords(ctx, "no-such-user", syncmodel.KindHosts, []syncmodel.Record{
				{
					ID:               "host-1",
					EncryptedPayload: "payload",
					UpdatedAt:        "2025-01-01T00:00:00Z",
				},
			})
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				t.Fatalf("UpsertSyncRecords() error = %v, want gorm.ErrRecordNotFound", err)
			}
		})
	}
}

func TestGormStoreUserClientObservationsUpsertByInstallation(t *testing.T) {
	for _, tc := range storeTestCases() {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			store := tc.open(t)

			firstSeenAt := time.Date(2026, time.April, 26, 10, 0, 0, 0, time.UTC)
			secondSeenAt := firstSeenAt.Add(15 * time.Minute)

			if err := store.UpsertUserClientObservation(ctx, UserClientObservation{
				UserID:               "user-1",
				ClientName:           "mobile",
				ClientVersion:        "1.6.1",
				Platform:             "ios",
				ClientInstallationID: "install-1",
				LastAuthEvent:        "exchange",
				LastIP:               "203.0.113.10",
				LastUserAgent:        "DolgateMobile/1.6.1",
				ObservedAt:           firstSeenAt,
			}); err != nil {
				t.Fatalf("UpsertUserClientObservation() initial error = %v", err)
			}

			if err := store.UpsertUserClientObservation(ctx, UserClientObservation{
				UserID:               "user-1",
				ClientName:           "mobile",
				ClientVersion:        "1.7.0",
				Platform:             "android",
				ClientInstallationID: "install-1",
				LastAuthEvent:        "refresh",
				LastIP:               "203.0.113.11",
				LastUserAgent:        "DolgateMobile/1.7.0",
				ObservedAt:           secondSeenAt,
			}); err != nil {
				t.Fatalf("UpsertUserClientObservation() update error = %v", err)
			}

			var rows []userClientObservationRow
			if err := store.db.WithContext(ctx).Find(&rows).Error; err != nil {
				t.Fatalf("query observations: %v", err)
			}
			if len(rows) != 1 {
				t.Fatalf("len(rows) = %d, want 1", len(rows))
			}
			if rows[0].FirstSeenAt.UTC() != firstSeenAt {
				t.Fatalf("FirstSeenAt = %s, want %s", rows[0].FirstSeenAt.UTC(), firstSeenAt)
			}
			if rows[0].LastSeenAt.UTC() != secondSeenAt {
				t.Fatalf("LastSeenAt = %s, want %s", rows[0].LastSeenAt.UTC(), secondSeenAt)
			}
			if rows[0].ClientVersion != "1.7.0" {
				t.Fatalf("ClientVersion = %q, want updated version", rows[0].ClientVersion)
			}
			if rows[0].Platform != "android" {
				t.Fatalf("Platform = %q, want updated platform", rows[0].Platform)
			}
			if rows[0].LastAuthEvent != "refresh" {
				t.Fatalf("LastAuthEvent = %q, want refresh", rows[0].LastAuthEvent)
			}
		})
	}
}

func TestGormStoreUserClientObservationsAllowUnknownClientMetadata(t *testing.T) {
	for _, tc := range storeTestCases() {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			store := tc.open(t)

			if err := store.UpsertUserClientObservation(ctx, UserClientObservation{
				UserID:               "user-1",
				ClientName:           "unknown",
				ClientVersion:        "unknown",
				Platform:             "unknown",
				ClientInstallationID: "unknown",
				LastAuthEvent:        "refresh",
				LastIP:               "192.0.2.1",
				LastUserAgent:        "LegacyClient/0.9",
				ObservedAt:           time.Date(2026, time.April, 26, 11, 0, 0, 0, time.UTC),
			}); err != nil {
				t.Fatalf("UpsertUserClientObservation() error = %v", err)
			}

			var row userClientObservationRow
			if err := store.db.WithContext(ctx).Take(&row).Error; err != nil {
				t.Fatalf("query observation: %v", err)
			}
			if row.ClientName != "unknown" || row.ClientVersion != "unknown" || row.Platform != "unknown" || row.ClientInstallationID != "unknown" {
				t.Fatalf("unexpected unknown observation row: %+v", row)
			}
			if row.LastUserAgent != "LegacyClient/0.9" {
				t.Fatalf("LastUserAgent = %q, want LegacyClient/0.9", row.LastUserAgent)
			}
		})
	}
}

func TestGormStoreDeleteUserDataRemovesEveryUserRow(t *testing.T) {
	store := openSQLiteTestStore(t)
	ctx := context.Background()

	user, err := store.CreateUser(ctx, "delete-me@example.com", "hash")
	if err != nil {
		t.Fatalf("CreateUser() error = %v", err)
	}
	keeper, err := store.CreateUser(ctx, "keeper@example.com", "hash")
	if err != nil {
		t.Fatalf("CreateUser(keeper) error = %v", err)
	}

	// 삭제 대상 유저의 모든 테이블에 행을 심는다.
	if err := store.SaveAuthIdentity(ctx, AuthIdentity{UserID: user.ID, Provider: "google", Subject: "sub-1", Email: user.Email, EmailVerified: true}); err != nil {
		t.Fatalf("SaveAuthIdentity() error = %v", err)
	}
	if err := store.SaveRefreshToken(ctx, RefreshToken{UserID: user.ID, TokenHash: "token-hash", ExpiresAt: time.Now().Add(time.Hour), LastUsedAt: time.Now()}); err != nil {
		t.Fatalf("SaveRefreshToken() error = %v", err)
	}
	if err := store.SaveExchangeCode(ctx, ExchangeCode{UserID: user.ID, CodeHash: "code-hash", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatalf("SaveExchangeCode() error = %v", err)
	}
	if _, err := store.GetOrCreateUserVaultKey(ctx, user.ID); err != nil {
		t.Fatalf("GetOrCreateUserVaultKey() error = %v", err)
	}
	if err := store.UpsertUserClientObservation(ctx, UserClientObservation{UserID: user.ID, ClientName: "desktop", ClientVersion: "1", Platform: "test", ClientInstallationID: "install-1", LastAuthEvent: "login", LastIP: "127.0.0.1", LastUserAgent: "test", ObservedAt: time.Now()}); err != nil {
		t.Fatalf("UpsertUserClientObservation() error = %v", err)
	}
	if err := store.UpsertSyncRecords(ctx, user.ID, syncmodel.KindHosts, []syncmodel.Record{{ID: "host-1", EncryptedPayload: "cipher", UpdatedAt: "2026-03-21T15:00:00Z"}}); err != nil {
		t.Fatalf("UpsertSyncRecords() error = %v", err)
	}
	// 다른 유저의 데이터는 남아야 한다.
	if err := store.UpsertSyncRecords(ctx, keeper.ID, syncmodel.KindHosts, []syncmodel.Record{{ID: "host-keep", EncryptedPayload: "cipher", UpdatedAt: "2026-03-21T15:00:00Z"}}); err != nil {
		t.Fatalf("UpsertSyncRecords(keeper) error = %v", err)
	}

	if exists, err := store.UserExists(ctx, user.ID); err != nil || !exists {
		t.Fatalf("UserExists() before delete = %v, %v", exists, err)
	}

	if err := store.DeleteUserData(ctx, user.ID); err != nil {
		t.Fatalf("DeleteUserData() error = %v", err)
	}

	if exists, err := store.UserExists(ctx, user.ID); err != nil || exists {
		t.Fatalf("UserExists() after delete = %v, %v", exists, err)
	}

	// 대상 유저의 행이 모든 테이블에서 사라졌는지 raw count 로 확인한다.
	for _, target := range []struct {
		table  string
		column string
	}{
		{"sync_records", "user_id"},
		{"user_vault_keys", "user_id"},
		{"user_client_observations", "user_id"},
		{"refresh_tokens", "user_id"},
		{"auth_exchange_codes", "user_id"},
		{"auth_identities", "user_id"},
		{"users", "id"},
	} {
		var count int64
		if err := store.db.Table(target.table).Where(target.column+" = ?", user.ID).Count(&count).Error; err != nil {
			t.Fatalf("count %s: %v", target.table, err)
		}
		if count != 0 {
			t.Fatalf("expected %s to be empty for deleted user, got %d rows", target.table, count)
		}
	}

	// keeper 데이터는 그대로.
	records, err := store.ListSyncRecords(ctx, keeper.ID, syncmodel.KindHosts)
	if err != nil {
		t.Fatalf("ListSyncRecords(keeper) error = %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected keeper records to survive, got %d", len(records))
	}
}

func TestGormStoreVaultV2Lifecycle(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()

			user, err := store.CreateUser(ctx, "vault-v2@example.com", "hash")
			if err != nil {
				t.Fatalf("CreateUser() error = %v", err)
			}

			// lazy 생성 전에는 볼트가 없다 — 신규 유저 판별의 근거.
			if _, err := store.GetUserVaultKey(ctx, user.ID); err != ErrVaultNotFound {
				t.Fatalf("GetUserVaultKey() before setup error = %v, want ErrVaultNotFound", err)
			}

			vault := UserVaultKey{
				UserID:           user.ID,
				DekVerifier:      "verifier-1",
				WrappedDekBase64: "wrapped-dek-1",
				KdfAlgorithm:     "argon2id",
				KdfSaltBase64:    "salt-1",
				KdfMemoryKiB:     64 * 1024,
				KdfTimeCost:      3,
				KdfParallelism:   1,
			}
			createdResult, err := store.CreateUserVaultV2(ctx, vault, VaultMutationPrecondition{
				ExpectedEpoch: 0,
			})
			if err != nil {
				t.Fatalf("CreateUserVaultV2() error = %v", err)
			}
			// 최초 설정은 epoch 1 세대를 시작하고, 생성 결과에 epoch 을 실어 돌려준다.
			if createdResult.Epoch != 1 || createdResult.WrapRevision != 1 {
				t.Fatalf("expected first vault epoch/revision 1/1, got %d/%d", createdResult.Epoch, createdResult.WrapRevision)
			}

			created, err := store.GetUserVaultKey(ctx, user.ID)
			if err != nil {
				t.Fatalf("GetUserVaultKey() error = %v", err)
			}
			if created.Version != 2 || created.KeyBase64 != "" {
				t.Fatalf("expected v2 vault without raw key, got %#v", created)
			}
			if created.WrappedDekBase64 != "wrapped-dek-1" || created.KdfAlgorithm != "argon2id" ||
				created.KdfSaltBase64 != "salt-1" || created.KdfMemoryKiB != 64*1024 ||
				created.KdfTimeCost != 3 || created.KdfParallelism != 1 {
				t.Fatalf("unexpected v2 vault fields: %#v", created)
			}
			// 클라이언트가 제출한 검증자가 그대로 보관·배포된다.
			if created.DekVerifier != "verifier-1" {
				t.Fatalf("expected stored dek verifier, got %q", created.DekVerifier)
			}
			if created.Epoch != 1 {
				t.Fatalf("expected epoch 1 from GetUserVaultKey, got %d", created.Epoch)
			}
			// 볼트 생성은 sync_revision 을 bump 해야 한다(ETag 가 볼트 변경을 커버) —
			// 다른 기기의 폴링이 304 로 새 볼트를 놓치지 않도록.
			revAfterCreate, err := store.GetSyncRevision(ctx, user.ID)
			if err != nil {
				t.Fatalf("GetSyncRevision() error = %v", err)
			}
			if revAfterCreate == 0 {
				t.Fatalf("expected CreateUserVaultV2 to bump sync_revision above 0")
			}

			// 두 번째 설정 시도(다른 기기 레이스)는 충돌로 알려준다.
			if _, err := store.CreateUserVaultV2(ctx, vault, VaultMutationPrecondition{
				ExpectedEpoch: 1,
			}); err != ErrVaultConflict {
				t.Fatalf("CreateUserVaultV2() over v2 error = %v, want ErrVaultConflict", err)
			}

			// rewrap(암호 변경)은 wrapped DEK/KDF 만 바꾼다.
			rewrapped := vault
			rewrapped.DekVerifier = ""
			rewrapped.WrappedDekBase64 = "wrapped-dek-2"
			rewrapped.KdfSaltBase64 = "salt-2"
			rewrapResult, err := store.UpdateUserVaultV2(ctx, rewrapped, VaultMutationPrecondition{
				ExpectedEpoch:        1,
				ExpectedDekVerifier:  testStringPtr("verifier-1"),
				ExpectedWrapRevision: testInt64Ptr(1),
			})
			if err != nil {
				t.Fatalf("UpdateUserVaultV2() error = %v", err)
			}
			updated, err := store.GetUserVaultKey(ctx, user.ID)
			if err != nil {
				t.Fatalf("GetUserVaultKey() after rewrap error = %v", err)
			}
			if updated.WrappedDekBase64 != "wrapped-dek-2" || updated.KdfSaltBase64 != "salt-2" || updated.Version != 2 {
				t.Fatalf("unexpected vault after rewrap: %#v", updated)
			}
			// 암호 변경은 DEK 를 안 바꾸므로 epoch 과 verifier 는 그대로여야 한다.
			if rewrapResult.Epoch != 1 || updated.Epoch != 1 {
				t.Fatalf("expected rewrap to preserve epoch 1, got result=%d stored=%d", rewrapResult.Epoch, updated.Epoch)
			}
			if updated.DekVerifier != "verifier-1" {
				t.Fatalf("expected rewrap to preserve dek verifier, got %q", updated.DekVerifier)
			}
			if rewrapResult.WrapRevision != 2 || updated.WrapRevision != 2 {
				t.Fatalf("expected rewrap revision 2, got result=%d stored=%d", rewrapResult.WrapRevision, updated.WrapRevision)
			}

			// 낡은 descriptor를 들고 있던 기기의 rewrap은 현재 wrapper를 덮어쓰면 안 된다.
			staleRewrap := rewrapped
			staleRewrap.WrappedDekBase64 = "stale-wrapped-dek"
			if _, err := store.UpdateUserVaultV2(ctx, staleRewrap, VaultMutationPrecondition{
				ExpectedEpoch:        0,
				ExpectedDekVerifier:  testStringPtr("verifier-1"),
				ExpectedWrapRevision: testInt64Ptr(1),
			}); !errors.Is(err, ErrVaultEpochMismatch) {
				t.Fatalf("stale epoch rewrap error = %v, want ErrVaultEpochMismatch", err)
			}
			if _, err := store.UpdateUserVaultV2(ctx, staleRewrap, VaultMutationPrecondition{
				ExpectedEpoch:        1,
				ExpectedDekVerifier:  testStringPtr("wrong-verifier"),
				ExpectedWrapRevision: testInt64Ptr(1),
			}); !errors.Is(err, ErrVaultEpochMismatch) {
				t.Fatalf("wrong verifier rewrap error = %v, want ErrVaultEpochMismatch", err)
			}
			if _, err := store.UpdateUserVaultV2(ctx, staleRewrap, VaultMutationPrecondition{
				ExpectedEpoch:        1,
				ExpectedDekVerifier:  testStringPtr("verifier-1"),
				ExpectedWrapRevision: testInt64Ptr(1),
			}); !errors.Is(err, ErrVaultEpochMismatch) {
				t.Fatalf("stale wrap revision error = %v, want ErrVaultEpochMismatch", err)
			}
			stillCurrent, err := store.GetUserVaultKey(ctx, user.ID)
			if err != nil || stillCurrent.WrappedDekBase64 != "wrapped-dek-2" {
				t.Fatalf("stale rewrap changed current vault: %#v, %v", stillCurrent, err)
			}

			// 초기화는 볼트와 sync 레코드를 지우고 계정은 남긴다.
			if err := store.UpsertSyncRecords(ctx, user.ID, syncmodel.KindHosts, []syncmodel.Record{{
				ID:               "host-1",
				EncryptedPayload: "ciphertext",
				UpdatedAt:        "2026-07-11T00:00:00Z",
			}}); err != nil {
				t.Fatalf("UpsertSyncRecords() error = %v", err)
			}
			resetEpoch, err := store.ResetUserVault(ctx, user.ID, 1)
			if err != nil {
				t.Fatalf("ResetUserVault() error = %v", err)
			}
			if resetEpoch != 2 {
				t.Fatalf("ResetUserVault() epoch = %d, want 2", resetEpoch)
			}
			if _, err := store.GetUserVaultKey(ctx, user.ID); err != ErrVaultNotFound {
				t.Fatalf("GetUserVaultKey() after reset error = %v, want ErrVaultNotFound", err)
			}
			resetEpoch, err = store.GetUserVaultEpoch(ctx, user.ID)
			if err != nil || resetEpoch != 2 {
				t.Fatalf("GetUserVaultEpoch() after reset = %d, %v; want 2, nil", resetEpoch, err)
			}
			records, err := store.ListSyncRecords(ctx, user.ID, syncmodel.KindHosts)
			if err != nil {
				t.Fatalf("ListSyncRecords() after reset error = %v", err)
			}
			if len(records) != 0 {
				t.Fatalf("expected sync records to be wiped on reset, got %d", len(records))
			}
			exists, err := store.UserExists(ctx, user.ID)
			if err != nil || !exists {
				t.Fatalf("expected user to survive vault reset, exists=%v err=%v", exists, err)
			}

			// reset 이후에는 계정의 E2EE version floor가 유지되어 구클라가 v1 볼트를
			// 다시 만들 수 없다. 새 클라이언트의 재설정만 허용한다.
			if _, err := store.GetOrCreateUserVaultKey(ctx, user.ID); !errors.Is(err, ErrVaultE2EERequired) {
				t.Fatalf("GetOrCreateUserVaultKey() after reset error = %v, want ErrVaultE2EERequired", err)
			}

			// 초기화 후 재설정 가능 — reset(+1)과 재설정(+1)이 각각 epoch 을 올려, 옛 세대
			// (epoch 1)의 push 가 fence 에서 확실히 구분된다.
			recreatedResult, err := store.CreateUserVaultV2(ctx, vault, VaultMutationPrecondition{
				ExpectedEpoch: 2,
			})
			if err != nil {
				t.Fatalf("CreateUserVaultV2() after reset error = %v", err)
			}
			if recreatedResult.Epoch != 3 {
				t.Fatalf("expected epoch 3 after reset(+1)+re-setup(+1), got %d", recreatedResult.Epoch)
			}
			recreated, err := store.GetUserVaultKey(ctx, user.ID)
			if err != nil {
				t.Fatalf("GetUserVaultKey() after re-setup error = %v", err)
			}
			if recreated.Epoch != 3 {
				t.Fatalf("expected stored epoch 3 after re-setup, got %d", recreated.Epoch)
			}
			if _, err := store.ResetUserVault(ctx, user.ID, 2); !errors.Is(err, ErrVaultEpochMismatch) {
				t.Fatalf("delayed reset error = %v, want ErrVaultEpochMismatch", err)
			}
			stillRecreated, err := store.GetUserVaultKey(ctx, user.ID)
			if err != nil || stillRecreated.Epoch != 3 {
				t.Fatalf("delayed reset removed the recreated vault: %#v, %v", stillRecreated, err)
			}
		})
	}
}

func TestGormStoreMigrationBackfillsVaultVersionFloor(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()

			resetHistoryUser, err := store.CreateUser(ctx, "vault-floor-reset@example.com", "hash")
			if err != nil {
				t.Fatalf("CreateUser(reset history) error = %v", err)
			}
			if _, err := store.GetOrCreateUserVaultKey(ctx, resetHistoryUser.ID); err != nil {
				t.Fatalf("GetOrCreateUserVaultKey() error = %v", err)
			}
			if err := store.db.Model(&userRow{}).
				Where("id = ?", resetHistoryUser.ID).
				Updates(map[string]any{"vault_epoch": 4, "vault_version_floor": 1}).Error; err != nil {
				t.Fatalf("seed reset history error = %v", err)
			}

			v2User, err := store.CreateUser(ctx, "vault-floor-v2@example.com", "hash")
			if err != nil {
				t.Fatalf("CreateUser(v2) error = %v", err)
			}
			if err := store.db.Create(&userVaultKeyRow{
				UserID:           v2User.ID,
				Version:          2,
				WrappedDekBase64: "wrapped",
				DekVerifier:      "verifier",
				KdfAlgorithm:     "argon2id",
				KdfSaltBase64:    "salt",
				KdfMemoryKiB:     64 * 1024,
				KdfTimeCost:      3,
				KdfParallelism:   1,
			}).Error; err != nil {
				t.Fatalf("seed v2 row error = %v", err)
			}

			plainLegacyUser, err := store.CreateUser(ctx, "vault-floor-v1@example.com", "hash")
			if err != nil {
				t.Fatalf("CreateUser(v1) error = %v", err)
			}
			if _, err := store.GetOrCreateUserVaultKey(ctx, plainLegacyUser.ID); err != nil {
				t.Fatalf("GetOrCreateUserVaultKey(plain v1) error = %v", err)
			}

			if err := store.migrate(); err != nil {
				t.Fatalf("migrate() error = %v", err)
			}

			for _, expectation := range []struct {
				userID string
				floor  int
			}{
				{userID: resetHistoryUser.ID, floor: 2},
				{userID: v2User.ID, floor: 2},
				{userID: plainLegacyUser.ID, floor: 1},
			} {
				state, err := store.GetUserVaultState(ctx, expectation.userID)
				if err != nil || state.VersionFloor != expectation.floor {
					t.Fatalf("GetUserVaultState(%s) floor = %d, %v; want %d", expectation.userID, state.VersionFloor, err, expectation.floor)
				}
			}
		})
	}
}

func TestGormStoreVaultStateAndPushFenceLifecycle(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			ctx := context.Background()
			store := testCase.open(t)
			user, err := store.CreateUser(ctx, "vault-fence@example.com", "hash")
			if err != nil {
				t.Fatalf("CreateUser() error = %v", err)
			}

			initial, err := store.GetUserVaultState(ctx, user.ID)
			if err != nil || initial.Vault != nil || initial.Epoch != 0 {
				t.Fatalf("initial vault state = %#v, %v; want no vault at epoch 0", initial, err)
			}

			legacy, err := store.GetOrCreateUserVaultKey(ctx, user.ID)
			if err != nil {
				t.Fatalf("GetOrCreateUserVaultKey() error = %v", err)
			}
			staleLegacyFence := VaultPushFence{Epoch: legacy.Epoch, Version: legacy.Version}
			payload := syncmodel.Payload{syncmodel.KindHosts: []syncmodel.Record{{
				ID:               "stale-host",
				EncryptedPayload: "stale-ciphertext",
				UpdatedAt:        "2026-07-15T00:00:00Z",
			}}}

			resetEpoch, err := store.ResetUserVault(ctx, user.ID, 0)
			if err != nil || resetEpoch != 1 {
				t.Fatalf("ResetUserVault() = %d, %v; want 1, nil", resetEpoch, err)
			}
			resetState, err := store.GetUserVaultState(ctx, user.ID)
			if err != nil || resetState.Vault != nil || resetState.Epoch != 1 {
				t.Fatalf("reset vault state = %#v, %v; want no vault at epoch 1", resetState, err)
			}
			if _, err := store.ApplyPushRecords(ctx, user.ID, payload, staleLegacyFence); !errors.Is(err, ErrVaultEpochMismatch) {
				t.Fatalf("ApplyPushRecords() without vault error = %v, want ErrVaultEpochMismatch", err)
			}

			if _, err := store.GetOrCreateUserVaultKey(ctx, user.ID); !errors.Is(err, ErrVaultE2EERequired) {
				t.Fatalf("GetOrCreateUserVaultKey() after reset error = %v, want ErrVaultE2EERequired", err)
			}
			if _, err := store.ApplyPushRecords(ctx, user.ID, payload, staleLegacyFence); !errors.Is(err, ErrVaultEpochMismatch) {
				t.Fatalf("stale v1 fence after reset error = %v, want ErrVaultEpochMismatch", err)
			}
			records, err := store.ListSyncRecords(ctx, user.ID, syncmodel.KindHosts)
			if err != nil || len(records) != 0 {
				t.Fatalf("stale push persisted records = %#v, %v", records, err)
			}

			v2, err := store.CreateUserVaultV2(ctx, UserVaultKey{
				UserID:           user.ID,
				DekVerifier:      "next-verifier",
				WrappedDekBase64: "next-wrapped-dek",
				KdfAlgorithm:     "argon2id",
				KdfSaltBase64:    "next-salt",
				KdfMemoryKiB:     64 * 1024,
				KdfTimeCost:      3,
				KdfParallelism:   1,
			}, VaultMutationPrecondition{ExpectedEpoch: resetEpoch})
			if err != nil {
				t.Fatalf("CreateUserVaultV2() error = %v", err)
			}
			if _, err := store.ApplyPushRecords(ctx, user.ID, payload, staleLegacyFence); !errors.Is(err, ErrVaultEpochMismatch) {
				t.Fatalf("v1 fence after v2 re-setup error = %v, want ErrVaultEpochMismatch", err)
			}
			if _, err := store.ApplyPushRecords(ctx, user.ID, payload, VaultPushFence{Epoch: v2.Epoch, Version: 2}); err != nil {
				t.Fatalf("current v2 fence push error = %v", err)
			}
		})
	}
}

func TestGormStoreConcurrentVaultSetupHasOneWinner(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			user, err := store.CreateUser(context.Background(), "vault-setup-race@example.com", "hash")
			if err != nil {
				t.Fatalf("CreateUser() error = %v", err)
			}

			start := make(chan struct{})
			results := make(chan error, 2)
			var workers sync.WaitGroup
			for index := 0; index < 2; index++ {
				workers.Add(1)
				go func(index int) {
					defer workers.Done()
					<-start
					_, err := store.CreateUserVaultV2(context.Background(), UserVaultKey{
						UserID:           user.ID,
						DekVerifier:      fmt.Sprintf("verifier-%d", index),
						WrappedDekBase64: fmt.Sprintf("wrapped-%d", index),
						KdfAlgorithm:     "argon2id",
						KdfSaltBase64:    fmt.Sprintf("salt-%d", index),
						KdfMemoryKiB:     64 * 1024,
						KdfTimeCost:      3,
						KdfParallelism:   1,
					}, VaultMutationPrecondition{ExpectedEpoch: 0})
					results <- err
				}(index)
			}
			close(start)
			workers.Wait()
			close(results)

			successes := 0
			conflicts := 0
			for result := range results {
				switch {
				case result == nil:
					successes++
				case errors.Is(result, ErrVaultConflict), errors.Is(result, ErrVaultEpochMismatch):
					conflicts++
				default:
					t.Fatalf("unexpected setup result: %v", result)
				}
			}
			if successes != 1 || conflicts != 1 {
				t.Fatalf("setup race results: successes=%d conflicts=%d", successes, conflicts)
			}
			state, err := store.GetUserVaultState(context.Background(), user.ID)
			if err != nil || state.Vault == nil || state.Vault.Version != 2 || state.Epoch != 1 {
				t.Fatalf("vault state after setup race = %#v, %v", state, err)
			}
		})
	}
}

func TestSyncSnapshotIsolationKeepsRevisionAndRecordsTogether(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			if store.driver == "sqlite" {
				t.Skip("SQLite uses a single connection and serializes the whole transaction")
			}
			ctx := context.Background()
			user, err := store.CreateUser(ctx, "snapshot-isolation@example.com", "hash")
			if err != nil {
				t.Fatalf("CreateUser() error = %v", err)
			}
			vault, err := store.GetOrCreateUserVaultKey(ctx, user.ID)
			if err != nil {
				t.Fatalf("GetOrCreateUserVaultKey() error = %v", err)
			}

			tx := store.db.WithContext(ctx).Begin(&sql.TxOptions{
				Isolation: sql.LevelRepeatableRead,
				ReadOnly:  true,
			})
			if tx.Error != nil {
				t.Fatalf("begin snapshot transaction: %v", tx.Error)
			}
			defer tx.Rollback()
			var before userRow
			if err := tx.Select("sync_revision").Where("id = ?", user.ID).Take(&before).Error; err != nil {
				t.Fatalf("read snapshot revision: %v", err)
			}

			pushDone := make(chan error, 1)
			go func() {
				_, err := store.ApplyPushRecords(ctx, user.ID, syncmodel.Payload{
					syncmodel.KindHosts: []syncmodel.Record{{
						ID:               "concurrent-host",
						EncryptedPayload: "ciphertext",
						UpdatedAt:        "2026-07-15T00:00:00Z",
					}},
				}, VaultPushFence{Epoch: vault.Epoch, Version: 1})
				pushDone <- err
			}()
			select {
			case err := <-pushDone:
				if err != nil {
					t.Fatalf("concurrent push error = %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("concurrent push was blocked by a read-only snapshot")
			}

			records, err := listSyncRecordsTx(tx, user.ID, syncmodel.KindHosts)
			if err != nil {
				t.Fatalf("read snapshot records: %v", err)
			}
			if len(records) != 0 || before.SyncRevision != 0 {
				t.Fatalf("mixed snapshot: revision=%d records=%#v", before.SyncRevision, records)
			}
			if err := tx.Rollback().Error; err != nil {
				t.Fatalf("rollback snapshot transaction: %v", err)
			}
			_, current, err := store.GetSyncSnapshot(ctx, user.ID)
			if err != nil || len(current[syncmodel.KindHosts]) != 1 {
				t.Fatalf("current snapshot after push = %#v, %v", current, err)
			}
		})
	}
}

// verifier 도입 이전에 만들어진 v2 볼트는 dek_verifier 가 빈 값이다. 잠금해제로 DEK 를
// 증명한 클라이언트가 rewrap 경로로 지연 백필하고, 이미 값이 있으면 다른 값은 무시된다.
func TestGormStoreVaultVerifierLazyBackfill(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()

			user, err := store.CreateUser(ctx, "vault-backfill@example.com", "hash")
			if err != nil {
				t.Fatalf("CreateUser() error = %v", err)
			}
			base := UserVaultKey{
				UserID:           user.ID,
				DekVerifier:      "verifier-original",
				WrappedDekBase64: "wrapped-dek",
				KdfAlgorithm:     "argon2id",
				KdfSaltBase64:    "salt",
				KdfMemoryKiB:     64 * 1024,
				KdfTimeCost:      3,
				KdfParallelism:   1,
			}
			if _, err := store.CreateUserVaultV2(ctx, base, VaultMutationPrecondition{ExpectedEpoch: 0}); err != nil {
				t.Fatalf("CreateUserVaultV2() error = %v", err)
			}

			// verifier 도입 이전에 만들어진 v2 행을 재현한다(빈 dek_verifier).
			if err := store.db.Model(&userVaultKeyRow{}).
				Where("user_id = ?", user.ID).
				Update("dek_verifier", "").Error; err != nil {
				t.Fatalf("clear dek_verifier error = %v", err)
			}

			backfill := base
			backfill.DekVerifier = "verifier-backfilled"
			result, err := store.UpdateUserVaultV2(ctx, backfill, VaultMutationPrecondition{
				ExpectedEpoch:        1,
				ExpectedDekVerifier:  testStringPtr(""),
				ExpectedWrapRevision: testInt64Ptr(1),
			})
			if err != nil {
				t.Fatalf("UpdateUserVaultV2() backfill error = %v", err)
			}
			if result.DekVerifier != "verifier-backfilled" {
				t.Fatalf("expected lazy backfill to set verifier, got %q", result.DekVerifier)
			}
			if result.WrapRevision != 1 {
				t.Fatalf("verifier-only backfill changed wrap revision: %d", result.WrapRevision)
			}

			// 이미 채워진 verifier 는 다른 값이 와도 바뀌지 않는다(멱등·오동작 클라 방어).
			conflicting := base
			conflicting.DekVerifier = "verifier-attacker"
			_, err = store.UpdateUserVaultV2(ctx, conflicting, VaultMutationPrecondition{
				ExpectedEpoch:        1,
				ExpectedDekVerifier:  testStringPtr("verifier-backfilled"),
				ExpectedWrapRevision: testInt64Ptr(1),
			})
			if !errors.Is(err, ErrVaultEpochMismatch) {
				t.Fatalf("UpdateUserVaultV2() conflicting verifier error = %v, want ErrVaultEpochMismatch", err)
			}
		})
	}
}

func TestGormStoreVaultV2MigratesLegacyRow(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()

			user, err := store.CreateUser(ctx, "vault-migrate@example.com", "hash")
			if err != nil {
				t.Fatalf("CreateUser() error = %v", err)
			}

			legacy, err := store.GetOrCreateUserVaultKey(ctx, user.ID)
			if err != nil {
				t.Fatalf("GetOrCreateUserVaultKey() error = %v", err)
			}
			if legacy.Version != 1 || legacy.KeyBase64 == "" {
				t.Fatalf("expected lazy-created v1 vault, got %#v", legacy)
			}

			// v1 → v2 전환(Phase B 마이그레이션 경로): 같은 트랜잭션에서 DEK 원문이 지워진다.
			legacyVerifier, err := legacyVaultDekVerifier(legacy.KeyBase64)
			if err != nil {
				t.Fatalf("legacyVaultDekVerifier() error = %v", err)
			}
			if _, err := store.CreateUserVaultV2(ctx, UserVaultKey{
				UserID:           user.ID,
				DekVerifier:      base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xff}, 32)),
				WrappedDekBase64: "wrong-wrapped-dek",
				KdfAlgorithm:     "argon2id",
				KdfSaltBase64:    "wrong-salt",
				KdfMemoryKiB:     64 * 1024,
				KdfTimeCost:      3,
				KdfParallelism:   1,
			}, VaultMutationPrecondition{ExpectedEpoch: legacy.Epoch}); !errors.Is(err, ErrVaultEpochMismatch) {
				t.Fatalf("migration with wrong legacy verifier error = %v, want ErrVaultEpochMismatch", err)
			}
			stillLegacy, err := store.GetUserVaultKey(ctx, user.ID)
			if err != nil || stillLegacy.Version != 1 || stillLegacy.KeyBase64 != legacy.KeyBase64 {
				t.Fatalf("failed migration changed legacy vault: %#v, %v", stillLegacy, err)
			}
			migratedResult, err := store.CreateUserVaultV2(ctx, UserVaultKey{
				UserID:           user.ID,
				DekVerifier:      legacyVerifier,
				WrappedDekBase64: "wrapped-dek",
				KdfAlgorithm:     "argon2id",
				KdfSaltBase64:    "salt",
				KdfMemoryKiB:     64 * 1024,
				KdfTimeCost:      3,
				KdfParallelism:   1,
			}, VaultMutationPrecondition{ExpectedEpoch: legacy.Epoch})
			if err != nil {
				t.Fatalf("CreateUserVaultV2() over v1 error = %v", err)
			}
			if migratedResult.Epoch != 1 {
				t.Fatalf("expected migration to start epoch 1, got %d", migratedResult.Epoch)
			}

			migrated, err := store.GetUserVaultKey(ctx, user.ID)
			if err != nil {
				t.Fatalf("GetUserVaultKey() error = %v", err)
			}
			if migrated.Version != 2 {
				t.Fatalf("expected version 2 after migration, got %d", migrated.Version)
			}
			if migrated.KeyBase64 != "" {
				t.Fatalf("expected raw DEK to be erased on migration, got %q", migrated.KeyBase64)
			}
			if migrated.WrappedDekBase64 != "wrapped-dek" {
				t.Fatalf("unexpected wrapped DEK after migration: %#v", migrated)
			}

			// GetOrCreate 는 v2 행을 그대로 돌려준다(재생성 금지).
			roundTripped, err := store.GetOrCreateUserVaultKey(ctx, user.ID)
			if err != nil {
				t.Fatalf("GetOrCreateUserVaultKey() after migration error = %v", err)
			}
			if roundTripped.Version != 2 || roundTripped.KeyBase64 != "" {
				t.Fatalf("expected GetOrCreate to return the v2 row untouched, got %#v", roundTripped)
			}
		})
	}
}

func TestGormStoreUpdateUserVaultV2RequiresV2Row(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()

			user, err := store.CreateUser(ctx, "vault-rewrap-guard@example.com", "hash")
			if err != nil {
				t.Fatalf("CreateUser() error = %v", err)
			}

			rewrap := UserVaultKey{
				UserID:           user.ID,
				WrappedDekBase64: "wrapped-dek",
				KdfAlgorithm:     "argon2id",
				KdfSaltBase64:    "salt",
				KdfMemoryKiB:     64 * 1024,
				KdfTimeCost:      3,
				KdfParallelism:   1,
			}
			if _, err := store.UpdateUserVaultV2(ctx, rewrap, VaultMutationPrecondition{
				ExpectedEpoch:        0,
				ExpectedDekVerifier:  testStringPtr(""),
				ExpectedWrapRevision: testInt64Ptr(0),
			}); err != ErrVaultNotFound {
				t.Fatalf("UpdateUserVaultV2() without vault error = %v, want ErrVaultNotFound", err)
			}

			if _, err := store.GetOrCreateUserVaultKey(ctx, user.ID); err != nil {
				t.Fatalf("GetOrCreateUserVaultKey() error = %v", err)
			}
			if _, err := store.UpdateUserVaultV2(ctx, rewrap, VaultMutationPrecondition{
				ExpectedEpoch:        0,
				ExpectedDekVerifier:  testStringPtr(""),
				ExpectedWrapRevision: testInt64Ptr(0),
			}); err != ErrVaultConflict {
				t.Fatalf("UpdateUserVaultV2() over v1 error = %v, want ErrVaultConflict", err)
			}
		})
	}
}

// 서버가 kind 를 열거하지 않게 만든 변경의 핵심 계약이다.
//
// 첫째, 서버가 모르는 kind 도 저장되고 그대로 돌아와야 한다 — 그래야 동기화 항목을 늘릴 때
// 서버를 배포하지 않아도 된다. 둘째, push 에 없는 kind 는 손대지 않아야 한다 — 그래야 새
// kind 를 모르는 구버전 클라이언트가 그것을 지워 버리지 않는다.
func TestGormStoreStoresUnknownKindsAndLeavesAbsentOnesAlone(t *testing.T) {
	for _, tc := range storeTestCases() {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			store := tc.open(t)

			user, err := store.CreateUser(ctx, "anykind@example.com", "hash")
			if err != nil {
				t.Fatalf("CreateUser() error = %v", err)
			}
			vault, err := store.GetOrCreateUserVaultKey(ctx, user.ID)
			if err != nil {
				t.Fatalf("GetOrCreateUserVaultKey() error = %v", err)
			}
			fence := VaultPushFence{Epoch: vault.Epoch, Version: 1}

			// 서버 코드에 존재하지 않는 kind.
			if _, err := store.ApplyPushRecords(ctx, user.ID, syncmodel.Payload{
				syncmodel.Kind("tailnets"): {{
					ID:               "net-1",
					EncryptedPayload: "ciphertext-tailnet",
					UpdatedAt:        "2026-07-28T00:00:00Z",
				}},
				syncmodel.KindHosts: {{
					ID:               "host-1",
					EncryptedPayload: "ciphertext-host",
					UpdatedAt:        "2026-07-28T00:00:00Z",
				}},
			}, fence); err != nil {
				t.Fatalf("ApplyPushRecords() error = %v", err)
			}

			// 그 kind 를 모르는 구버전 클라이언트가 자기가 아는 것만 push 한다.
			if _, err := store.ApplyPushRecords(ctx, user.ID, syncmodel.Payload{
				syncmodel.KindHosts: {{
					ID:               "host-1",
					EncryptedPayload: "ciphertext-host-v2",
					UpdatedAt:        "2026-07-28T01:00:00Z",
				}},
			}, fence); err != nil {
				t.Fatalf("legacy ApplyPushRecords() error = %v", err)
			}

			_, snapshot, err := store.GetSyncSnapshot(ctx, user.ID)
			if err != nil {
				t.Fatalf("GetSyncSnapshot() error = %v", err)
			}

			tailnets := snapshot[syncmodel.Kind("tailnets")]
			if len(tailnets) != 1 || tailnets[0].EncryptedPayload != "ciphertext-tailnet" {
				t.Errorf("tailnets = %#v — a client that does not know the kind must not drop it", tailnets)
			}
			hosts := snapshot[syncmodel.KindHosts]
			if len(hosts) != 1 || hosts[0].EncryptedPayload != "ciphertext-host-v2" {
				t.Errorf("hosts = %#v, want the newer payload", hosts)
			}
		})
	}
}

// 열거를 없앤 대신 형식으로 막는다.
func TestGormStoreRejectsMalformedKinds(t *testing.T) {
	ctx := context.Background()
	store := openSQLiteTestStore(t)
	user, err := store.CreateUser(ctx, "badkind@example.com", "hash")
	if err != nil {
		t.Fatalf("CreateUser() error = %v", err)
	}
	vault, err := store.GetOrCreateUserVaultKey(ctx, user.ID)
	if err != nil {
		t.Fatalf("GetOrCreateUserVaultKey() error = %v", err)
	}
	fence := VaultPushFence{Epoch: vault.Epoch, Version: 1}

	for _, kind := range []string{"", "has space", "has/slash", strings.Repeat("k", 65)} {
		_, err := store.ApplyPushRecords(ctx, user.ID, syncmodel.Payload{
			syncmodel.Kind(kind): {{
				ID:               "x",
				EncryptedPayload: "c",
				UpdatedAt:        "2026-07-28T00:00:00Z",
			}},
		}, fence)
		if !errors.Is(err, ErrBadSyncRecord) {
			t.Errorf("ApplyPushRecords(kind=%q) error = %v, want ErrBadSyncRecord", kind, err)
		}
	}
}
