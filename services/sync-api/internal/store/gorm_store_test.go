package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	syncmodel "dolssh/services/sync-api/internal/sync"
)

func openTestStore(t *testing.T) *GormStore {
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

func TestGormStoreUserAndIdentityLifecycle(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)

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
}

func TestGormStoreExchangeCodesAndVaultKeys(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)

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
}

func TestGormStoreSyncRecordsPreferNewestPayload(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)

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
}

func TestGormStoreUserClientObservationsUpsertByInstallation(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)

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
}

func TestGormStoreUserClientObservationsAllowUnknownClientMetadata(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)

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
}
