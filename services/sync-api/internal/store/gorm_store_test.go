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
