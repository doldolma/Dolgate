package store

import (
	"context"
	"errors"
	"fmt"
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

// begin 은 /login 페이지를 볼 때마다 행을 남기고 지우는 건 성공 소비뿐이라, 정리가 없으면
// 이탈·실패분이 영구히 쌓인다.
func TestGormStoreWebAuthnCeremonySweepsExpired(t *testing.T) {
	store := openSQLiteTestStore(t)
	ctx := context.Background()

	past := time.Now().Add(-time.Hour)
	for _, id := range []string{"stale-1", "stale-2", "stale-3"} {
		if err := store.SaveWebAuthnCeremony(ctx, WebAuthnCeremony{
			ID: id, Purpose: "login", SessionData: []byte(`{}`), ExpiresAt: past,
		}); err != nil {
			t.Fatalf("SaveWebAuthnCeremony(%s) error = %v", id, err)
		}
	}

	// 청소는 간격을 두고 돌기 때문에, 직전 청소 시각을 지워 다음 쓰기에서 실행되게 한다.
	store.allowImmediateSweep(webauthnCeremonyRow{}.TableName())
	if err := store.SaveWebAuthnCeremony(ctx, WebAuthnCeremony{
		ID: "live", Purpose: "login", SessionData: []byte(`{}`), ExpiresAt: time.Now().Add(time.Minute),
	}); err != nil {
		t.Fatalf("SaveWebAuthnCeremony(live) error = %v", err)
	}

	var remaining []string
	if err := store.db.Model(&webauthnCeremonyRow{}).Pluck("id", &remaining).Error; err != nil {
		t.Fatalf("pluck: %v", err)
	}
	if len(remaining) != 1 || remaining[0] != "live" {
		t.Fatalf("만료 ceremony 가 남았다: %v", remaining)
	}
}

// 한 번의 정리가 테이블 전체를 지우려 들면, 오래 방치된 배포의 첫 로그인이 수백만 행짜리
// DELETE 를 동기로 물고 그동안 테이블이 잠긴다. 배치로 끊되 밀린 건 이어서 지워야 한다.
func TestGormStoreSweepIsBatchedAndResumes(t *testing.T) {
	store := openSQLiteTestStore(t)

	past := time.Now().Add(-time.Hour)
	total := expiredRowSweepBatch + 250
	rows := make([]webauthnCeremonyRow, 0, total)
	for i := 0; i < total; i++ {
		rows = append(rows, webauthnCeremonyRow{
			ID: fmt.Sprintf("stale-%d", i), Purpose: "login", SessionData: "{}", ExpiresAt: past.UTC(),
		})
	}
	if err := store.db.CreateInBatches(rows, 200).Error; err != nil {
		t.Fatalf("seed: %v", err)
	}

	remaining := func() int64 {
		var count int64
		store.db.Model(&webauthnCeremonyRow{}).Count(&count)
		return count
	}

	store.allowImmediateSweep(webauthnCeremonyRow{}.TableName())
	store.sweepExpired(&webauthnCeremonyRow{}, "id")
	if got := remaining(); got != int64(total-expiredRowSweepBatch) {
		t.Fatalf("첫 정리 후 남은 행 = %d, want %d", got, total-expiredRowSweepBatch)
	}

	// 배치를 가득 채웠으므로 간격을 기다리지 않고 다음 정리가 이어져야 한다.
	store.sweepExpired(&webauthnCeremonyRow{}, "id")
	if got := remaining(); got != 0 {
		t.Fatalf("이어진 정리 후 남은 행 = %d, want 0", got)
	}

	// 다 지웠으면 간격 전에는 다시 돌지 않는다.
	if err := store.db.Create(&webauthnCeremonyRow{
		ID: "stale-late", Purpose: "login", SessionData: "{}", ExpiresAt: past.UTC(),
	}).Error; err != nil {
		t.Fatalf("seed late: %v", err)
	}
	store.sweepExpired(&webauthnCeremonyRow{}, "id")
	if got := remaining(); got != 1 {
		t.Fatalf("간격 안에서는 정리하지 않아야 한다, 남은 행 = %d", got)
	}
}

// 하나의 exchange code 로 세션이 둘 발급되면 안 된다(코드는 로컬 콜백 URL·로그에 노출된다).
func TestGormStoreExchangeCodeConsumedOnlyOnce(t *testing.T) {
	store := openSQLiteTestStore(t)
	ctx := context.Background()

	if err := store.SaveExchangeCode(ctx, ExchangeCode{
		CodeHash: "hash-1", UserID: "user-1", ExpiresAt: time.Now().Add(time.Minute),
	}); err != nil {
		t.Fatalf("SaveExchangeCode() error = %v", err)
	}
	if _, err := store.ConsumeExchangeCode(ctx, "hash-1"); err != nil {
		t.Fatalf("ConsumeExchangeCode() error = %v", err)
	}
	if _, err := store.ConsumeExchangeCode(ctx, "hash-1"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("두 번째 소비 error = %v, want ErrRecordNotFound", err)
	}
}

// 같은 credential id 를 남의 계정에 등록하려는 시도는 거부돼야 한다. 통과시키면 upsert 가
// 소유자를 바꿔 피해자의 패스키 행이 사라지고, 그 뒤 피해자 로그인이 unknown_credential 로
// 나가 패스워드 매니저에서까지 삭제된다(되돌릴 수 없음).
func TestGormStoreWebAuthnCredentialCannotBeStolen(t *testing.T) {
	store := openSQLiteTestStore(t)
	ctx := context.Background()

	victim, err := store.CreateUser(ctx, "victim@example.com", "")
	if err != nil {
		t.Fatalf("CreateUser(victim) error = %v", err)
	}
	attacker, err := store.CreateUser(ctx, "attacker@example.com", "")
	if err != nil {
		t.Fatalf("CreateUser(attacker) error = %v", err)
	}

	if err := store.SaveWebAuthnCredential(ctx, WebAuthnCredential{
		CredentialID: "cred-shared", UserID: victim.ID, Name: "victim key", Data: []byte(`{"signCount":3}`),
	}); err != nil {
		t.Fatalf("SaveWebAuthnCredential(victim) error = %v", err)
	}

	err = store.SaveWebAuthnCredential(ctx, WebAuthnCredential{
		CredentialID: "cred-shared", UserID: attacker.ID, Name: "attacker key", Data: []byte(`{"signCount":0}`),
	})
	if !errors.Is(err, ErrWebAuthnCredentialOwned) {
		t.Fatalf("SaveWebAuthnCredential(attacker) error = %v, want ErrWebAuthnCredentialOwned", err)
	}

	credentials, err := store.ListWebAuthnCredentialsByUser(ctx, victim.ID)
	if err != nil {
		t.Fatalf("ListWebAuthnCredentialsByUser() error = %v", err)
	}
	if len(credentials) != 1 || credentials[0].Name != "victim key" {
		t.Fatalf("victim credential must survive intact, got %+v", credentials)
	}
	// data 에는 공개키가 들어 있다. 소유권이 안 넘어가도 이게 덮이면 피해자는 서명 검증에
	// 실패해 로그인할 수 없게 된다(그런데 기록은 있으니 stale 정리 신호도 안 나간다).
	if string(credentials[0].Data) != `{"signCount":3}` {
		t.Fatalf("victim credential data was overwritten: %s", credentials[0].Data)
	}
	if count, _ := store.CountWebAuthnCredentialsByUser(ctx, attacker.ID); count != 0 {
		t.Fatalf("attacker must not own the credential, count = %d", count)
	}

	// 같은 사용자의 재등록(같은 인증기로 다시 등록)은 그대로 갱신돼야 한다.
	if err := store.SaveWebAuthnCredential(ctx, WebAuthnCredential{
		CredentialID: "cred-shared", UserID: victim.ID, Name: "renamed", Data: []byte(`{"signCount":7}`),
	}); err != nil {
		t.Fatalf("SaveWebAuthnCredential(re-register) error = %v", err)
	}
	credentials, _ = store.ListWebAuthnCredentialsByUser(ctx, victim.ID)
	if len(credentials) != 1 || credentials[0].Name != "renamed" {
		t.Fatalf("re-registration must update in place, got %+v", credentials)
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
