package store

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	syncmodel "dolssh/services/sync-api/internal/sync"
)

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

			if err := store.UpsertSyncRecords(ctx, "user-1", syncmodel.KindHosts, []syncmodel.Record{
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

			if err := store.UpsertSyncRecords(ctx, "user-1", syncmodel.KindHosts, []syncmodel.Record{
				{
					ID:               "host-1",
					EncryptedPayload: "older",
					UpdatedAt:        "2025-01-01T00:00:00Z",
				},
			}); err != nil {
				t.Fatalf("UpsertSyncRecords() stale update error = %v", err)
			}

			records, err := store.ListSyncRecords(ctx, "user-1", syncmodel.KindHosts)
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
