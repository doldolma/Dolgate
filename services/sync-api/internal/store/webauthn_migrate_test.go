package store

import (
	"context"
	"strings"
	"testing"
	"time"
)

// 기존 배포(varchar(512))에서 올라올 때 AutoMigrate 가 컬럼을 넓히고 데이터를 보존하는지.
func TestWebAuthnCredentialIDColumnWidensOnUpgrade(t *testing.T) {
	s := openSQLiteTestStore(t)
	ctx := context.Background()

	// 현재 스키마를 옛 폭으로 되돌린다(SQLite 는 ALTER COLUMN 이 없어 재생성).
	if err := s.db.Exec(`DROP TABLE webauthn_credentials`).Error; err != nil {
		t.Fatalf("drop: %v", err)
	}
	if err := s.db.Exec(`CREATE TABLE webauthn_credentials (
		credential_id_hash varchar(64) PRIMARY KEY,
		credential_id varchar(512) NOT NULL,
		user_id varchar(191) NOT NULL,
		name varchar(128) NOT NULL DEFAULT '',
		data text NOT NULL,
		created_at datetime NOT NULL,
		last_used_at datetime NOT NULL)`).Error; err != nil {
		t.Fatalf("create legacy: %v", err)
	}
	if err := s.db.Exec(`INSERT INTO webauthn_credentials VALUES (?,?,?,?,?,?,?)`,
		webauthnCredentialIDHash("legacy-cred"), "legacy-cred", "user-1", "old key",
		`{"signCount":4}`, time.Now(), time.Now()).Error; err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := s.migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	var ddl string
	if err := s.db.Raw(`SELECT sql FROM sqlite_master WHERE name = 'webauthn_credentials'`).Scan(&ddl).Error; err != nil {
		t.Fatalf("ddl: %v", err)
	}
	if !strings.Contains(ddl, "varchar(1364)") {
		t.Fatalf("column not widened, ddl = %s", ddl)
	}

	credentials, err := s.ListWebAuthnCredentialsByUser(ctx, "user-1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(credentials) != 1 || credentials[0].Name != "old key" || string(credentials[0].Data) != `{"signCount":4}` {
		t.Fatalf("legacy row not preserved: %+v", credentials)
	}

	// 넓힌 폭까지 실제로 들어가는지(스펙 최대 1023 바이트 → 1364 자).
	long := strings.Repeat("a", 1364)
	if err := s.SaveWebAuthnCredential(ctx, WebAuthnCredential{
		CredentialID: long, UserID: "user-1", Data: []byte(`{}`),
	}); err != nil {
		t.Fatalf("save max-length credential id: %v", err)
	}
}
