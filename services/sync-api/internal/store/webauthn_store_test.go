package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"gorm.io/gorm"
)

func TestGormStoreWebAuthnCredentialLifecycle(t *testing.T) {
	store := openSQLiteTestStore(t)
	ctx := context.Background()

	user, err := store.CreateUser(ctx, "passkey@example.com", "")
	if err != nil {
		t.Fatalf("CreateUser() error = %v", err)
	}

	if err := store.SaveWebAuthnCredential(ctx, WebAuthnCredential{
		CredentialID: "cred-a",
		UserID:       user.ID,
		Name:         "MacBook",
		Data:         []byte(`{"signCount":0}`),
	}); err != nil {
		t.Fatalf("SaveWebAuthnCredential() error = %v", err)
	}
	if err := store.SaveWebAuthnCredential(ctx, WebAuthnCredential{
		CredentialID: "cred-b",
		UserID:       user.ID,
		Name:         "YubiKey",
		Data:         []byte(`{"signCount":5}`),
	}); err != nil {
		t.Fatalf("SaveWebAuthnCredential(second) error = %v", err)
	}

	credentials, err := store.ListWebAuthnCredentialsByUser(ctx, user.ID)
	if err != nil {
		t.Fatalf("ListWebAuthnCredentialsByUser() error = %v", err)
	}
	if len(credentials) != 2 {
		t.Fatalf("expected 2 credentials, got %d", len(credentials))
	}

	count, err := store.CountWebAuthnCredentialsByUser(ctx, user.ID)
	if err != nil || count != 2 {
		t.Fatalf("CountWebAuthnCredentialsByUser() = %d, %v; want 2, nil", count, err)
	}

	// 갱신(로그인 후 sign count 반영)은 credential id 기준 in-place 여야 한다(중복 생성 금지).
	if err := store.UpdateWebAuthnCredentialData(ctx, "cred-a", []byte(`{"signCount":9}`), time.Now()); err != nil {
		t.Fatalf("UpdateWebAuthnCredentialData() error = %v", err)
	}
	credentials, _ = store.ListWebAuthnCredentialsByUser(ctx, user.ID)
	if len(credentials) != 2 {
		t.Fatalf("update must not create a row, got %d", len(credentials))
	}
	if err := store.UpdateWebAuthnCredentialData(ctx, "missing", []byte(`{}`), time.Now()); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("UpdateWebAuthnCredentialData(missing) error = %v, want ErrRecordNotFound", err)
	}

	if err := store.DeleteWebAuthnCredential(ctx, user.ID, "cred-a"); err != nil {
		t.Fatalf("DeleteWebAuthnCredential() error = %v", err)
	}
	if count, _ := store.CountWebAuthnCredentialsByUser(ctx, user.ID); count != 1 {
		t.Fatalf("expected 1 credential after delete, got %d", count)
	}
}

func TestGormStoreWebAuthnCeremonyIsOneTime(t *testing.T) {
	store := openSQLiteTestStore(t)
	ctx := context.Background()

	ceremony := WebAuthnCeremony{
		ID:          "ceremony-1",
		UserID:      "",
		Purpose:     "login",
		SessionData: []byte(`{"challenge":"abc"}`),
		ExpiresAt:   time.Now().Add(time.Minute),
	}
	if err := store.SaveWebAuthnCeremony(ctx, ceremony); err != nil {
		t.Fatalf("SaveWebAuthnCeremony() error = %v", err)
	}

	consumed, err := store.ConsumeWebAuthnCeremony(ctx, "ceremony-1")
	if err != nil {
		t.Fatalf("ConsumeWebAuthnCeremony() error = %v", err)
	}
	if consumed.Purpose != "login" || string(consumed.SessionData) != `{"challenge":"abc"}` {
		t.Fatalf("consumed ceremony mismatch: %+v", consumed)
	}

	// 두 번째 소비는 실패해야 한다(일회성).
	if _, err := store.ConsumeWebAuthnCeremony(ctx, "ceremony-1"); err == nil {
		t.Fatalf("expected second ConsumeWebAuthnCeremony to fail")
	}
}

func TestGormStoreDeleteUserDataRemovesWebAuthn(t *testing.T) {
	store := openSQLiteTestStore(t)
	ctx := context.Background()

	user, err := store.CreateUser(ctx, "wipe@example.com", "")
	if err != nil {
		t.Fatalf("CreateUser() error = %v", err)
	}
	if err := store.SaveWebAuthnCredential(ctx, WebAuthnCredential{
		CredentialID: "cred-x", UserID: user.ID, Data: []byte(`{}`),
	}); err != nil {
		t.Fatalf("SaveWebAuthnCredential() error = %v", err)
	}
	if err := store.SaveWebAuthnCeremony(ctx, WebAuthnCeremony{
		ID: "cer-x", UserID: user.ID, Purpose: "register", SessionData: []byte(`{}`), ExpiresAt: time.Now().Add(time.Minute),
	}); err != nil {
		t.Fatalf("SaveWebAuthnCeremony() error = %v", err)
	}

	if err := store.DeleteUserData(ctx, user.ID); err != nil {
		t.Fatalf("DeleteUserData() error = %v", err)
	}

	if count, _ := store.CountWebAuthnCredentialsByUser(ctx, user.ID); count != 0 {
		t.Fatalf("expected credentials wiped, got %d", count)
	}
	if _, err := store.ConsumeWebAuthnCeremony(ctx, "cer-x"); err == nil {
		t.Fatalf("expected ceremony wiped")
	}
}
