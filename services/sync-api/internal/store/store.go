package store

import (
	"context"
	"errors"
	"time"

	syncmodel "dolssh/services/sync-api/internal/sync"
)

// 볼트 조회·설정에서 쓰는 sentinel 에러. gorm 에러를 밖으로 흘리지 않는다.
var (
	ErrVaultNotFound = errors.New("vault not found")
	// ErrVaultConflict 는 이미 v2 볼트가 있는데 다시 만들려 하거나(다른 기기 선점),
	// v2 가 아닌 볼트를 rewrap 하려 할 때 돌려준다.
	ErrVaultConflict = errors.New("vault conflict")
	// ErrBadSyncRecord 는 push 페이로드의 레코드 자체가 잘못된 경우(파싱 불가 타임스탬프 등).
	// 서버 오류(500)가 아니라 잘못된 요청(400)으로 분류하기 위한 sentinel.
	ErrBadSyncRecord = errors.New("bad sync record")
	// ErrVaultEpochMismatch 는 push 가 실은 볼트 epoch 이 서버의 현재 epoch 과 다른 경우다.
	// 초기화(reset)·재설정이 epoch 을 올리므로, 옛 DEK 세대의 기기가 쓰는 것을 커밋 시점에
	// 원자적으로 거부한다(검사-커밋 사이 창 없음).
	ErrVaultEpochMismatch = errors.New("vault epoch mismatch")
	// ErrVaultE2EERequired 는 한 번 v2가 된 계정에서 v1 볼트를 다시 lazy 생성하려는
	// downgrade 시도다. reset으로 볼트 행이 사라져도 users.vault_version_floor가 남는다.
	ErrVaultE2EERequired = errors.New("e2ee vault required")
	// ErrPasswordConflict 는 비밀번호 검증 뒤 저장하기 전에 다른 요청이 먼저 해시를
	// 바꾼 경우다. 현재 비밀번호 오류와 같은 사용자 응답으로 처리한다.
	ErrPasswordConflict = errors.New("password changed concurrently")
	// ErrRefreshTokenNotFound 는 비밀번호 변경에서 유지할 현재 세션이 이미 사라진 경우다.
	ErrRefreshTokenNotFound = errors.New("refresh token not found")
)

type User struct {
	ID           string
	Email        string
	PasswordHash string
}

type AuthIdentity struct {
	UserID        string
	Provider      string
	Subject       string
	Email         string
	EmailVerified bool
}

type RefreshToken struct {
	UserID       string
	TokenHash    string
	ExpiresAt    time.Time
	LastUsedAt   time.Time
	GraceUntil   *time.Time
	SupersededAt *time.Time
}

type ExchangeCode struct {
	UserID    string
	CodeHash  string
	ExpiresAt time.Time
}

// UserVaultKey 는 사용자 sync 볼트의 키 자료다.
// version 1(레거시): 서버가 생성한 DEK 원문(KeyBase64)을 보관·배포한다 — 서버가 복호화 가능한 구조.
// version 2(E2EE): 클라이언트가 동기화 암호(KDF→KEK)로 감싼 DEK(WrappedDekBase64)만 보관한다 —
// 서버는 어떤 시점에도 DEK 원문을 알 수 없다. v2 행의 KeyBase64 는 빈 값이다.
type UserVaultKey struct {
	UserID  string
	Version int
	// Epoch 는 DEK 세대 번호다(users.vault_epoch — 볼트 행이 아니라 사용자 행에 있어
	// 초기화로 행이 지워져도 단조성이 유지된다). 초기화(reset)와 재설정(CreateUserVaultV2)
	// 이 각각 +1 하므로, 두 epoch 값은 크기 비교만으로 신선도를 판별할 수 있다.
	// 암호 변경(rewrap)은 DEK 가 그대로이므로 올리지 않는다.
	Epoch int64
	// DekVerifier 는 클라이언트가 DEK 에서 유도해 제출한 공개 검증자
	// (HMAC-SHA256(key=DEK, msg=고정라벨), base64)다. 256비트 랜덤 DEK 에서 역산이
	// 불가능하므로 zero-knowledge 를 깨지 않으면서, 클라이언트가 캐시한 DEK 가 이 볼트의
	// DEK 인지 로컬에서 즉시 판정하게 해준다(최초 신뢰 채택이 필요 없어진다).
	DekVerifier      string
	KeyBase64        string
	WrappedDekBase64 string
	KdfAlgorithm     string
	KdfSaltBase64    string
	KdfMemoryKiB     int
	KdfTimeCost      int
	KdfParallelism   int
	// WrapRevision은 같은 DEK epoch 안에서 wrapped DEK/KDF가 변경된 순서다.
	// 기존 v2 행은 0, 신규 생성은 1이며 rewrap 성공마다 +1 한다.
	WrapRevision int64
}

// UserVaultState 는 한 시점의 볼트 행과 users.vault_epoch 을 함께 표현한다.
// Vault 가 nil 이어도 Epoch 은 유효하며, reset 직후의 version 0 descriptor 에 사용한다.
type UserVaultState struct {
	Vault        *UserVaultKey
	Epoch        int64
	VersionFloor int
}

// VaultMutationPrecondition 은 클라이언트가 변이를 시작할 때 관찰한 볼트 세대다.
// 저장소가 users 행을 잠근 뒤 다시 대조하므로 reset/재설정과의 TOCTOU가 없다.
type VaultMutationPrecondition struct {
	ExpectedEpoch        int64
	ExpectedDekVerifier  *string
	ExpectedWrapRevision *int64
}

// VaultPushFence 는 라우터가 push 검증 때 관찰한 볼트 세대와 형식이다. 저장소는 사용자
// 행을 잠근 뒤 이 둘을 다시 확인해, 검사와 커밋 사이의 reset/migration을 차단한다.
type VaultPushFence struct {
	Epoch   int64
	Version int
}

// WebAuthnCredential 은 사용자가 등록한 패스키 하나다. Data 는 인증(auth) 계층이 소유하는
// 불투명한 직렬화 바이트(마샬링된 자격증명)로, 스토어는 WebAuthn 라이브러리에 의존하지 않고
// 그대로 보관·반환만 한다. CredentialID 는 base64url 로 인코딩된 원본 credential id 다.
type WebAuthnCredential struct {
	CredentialID string
	UserID       string
	Name         string
	Data         []byte
	CreatedAt    time.Time
	LastUsedAt   time.Time
}

// WebAuthnCeremony 는 begin/finish 사이에 보존해야 하는 일회성 챌린지 상태다. SessionData 는
// auth 계층이 마샬링한 불투명 바이트다. exchange code 와 동일하게 소비 시 삭제한다.
// UserID 는 등록 ceremony 에서만 채워지고, discoverable 로그인 ceremony 에서는 비어 있다.
type WebAuthnCeremony struct {
	ID          string
	UserID      string
	Purpose     string
	SessionData []byte
	ExpiresAt   time.Time
}

type UserClientObservation struct {
	UserID               string
	ClientName           string
	ClientVersion        string
	Platform             string
	ClientInstallationID string
	LastAuthEvent        string
	LastIP               string
	LastUserAgent        string
	ObservedAt           time.Time
}

type Store interface {
	CreateUser(ctx context.Context, email string, passwordHash string) (User, error)
	GetUserByEmail(ctx context.Context, email string) (User, error)
	GetUserByID(ctx context.Context, id string) (User, error)
	HasVerifiedAuthIdentity(ctx context.Context, userID string, email string) (bool, error)
	UpdateUserPassword(ctx context.Context, userID string, expectedPasswordHash string, passwordHash string, keepRefreshTokenHash string) error

	GetAuthIdentity(ctx context.Context, provider string, subject string) (AuthIdentity, error)
	SaveAuthIdentity(ctx context.Context, identity AuthIdentity) error

	// WebAuthn 패스키 자격증명. Save 는 credential id 기준 upsert 다.
	SaveWebAuthnCredential(ctx context.Context, credential WebAuthnCredential) error
	ListWebAuthnCredentialsByUser(ctx context.Context, userID string) ([]WebAuthnCredential, error)
	// UpdateWebAuthnCredentialData 는 로그인 성공 후 sign count 등 갱신된 자격증명 바이트와
	// 마지막 사용 시각을 저장한다. 대상 행이 없으면 gorm.ErrRecordNotFound.
	UpdateWebAuthnCredentialData(ctx context.Context, credentialID string, data []byte, lastUsedAt time.Time) error
	DeleteWebAuthnCredential(ctx context.Context, userID string, credentialID string) error
	CountWebAuthnCredentialsByUser(ctx context.Context, userID string) (int64, error)

	// WebAuthn ceremony(챌린지) 일회성 저장/소비. Consume 는 트랜잭션 내 조회 후 삭제한다.
	SaveWebAuthnCeremony(ctx context.Context, ceremony WebAuthnCeremony) error
	ConsumeWebAuthnCeremony(ctx context.Context, id string) (WebAuthnCeremony, error)

	SaveRefreshToken(ctx context.Context, token RefreshToken) error
	GetRefreshToken(ctx context.Context, tokenHash string) (RefreshToken, error)
	DeleteRefreshToken(ctx context.Context, tokenHash string) error

	SaveExchangeCode(ctx context.Context, code ExchangeCode) error
	ConsumeExchangeCode(ctx context.Context, codeHash string) (ExchangeCode, error)

	GetOrCreateUserVaultKey(ctx context.Context, userID string) (UserVaultKey, error)
	// GetUserVaultState 는 볼트와 epoch 을 같은 잠금/트랜잭션 경계에서 읽는다. 볼트가
	// 없으면 ErrVaultNotFound 대신 Vault=nil과 현재 Epoch을 반환한다.
	GetUserVaultState(ctx context.Context, userID string) (UserVaultState, error)

	// GetUserVaultKey 는 볼트 행이 없으면 ErrVaultNotFound — lazy 생성하지 않는다.
	// (E2EE 지원 클라이언트에는 "볼트 없음"을 그대로 알려 설정 플로우를 태운다.)
	GetUserVaultKey(ctx context.Context, userID string) (UserVaultKey, error)
	// GetUserVaultEpoch 는 볼트 행 유무와 무관하게 users.vault_epoch 을 돌려준다.
	// reset 직후 version 0 descriptor 에도 세대를 실어 늦게 도착한 옛 응답과 구분한다.
	GetUserVaultEpoch(ctx context.Context, userID string) (int64, error)
	// CreateUserVaultV2 는 E2EE 볼트를 설정한다. 행이 없으면 생성하고, v1 행이 있으면 같은
	// 트랜잭션에서 v2 로 교체하며 서버 보관 DEK 원문(key_base64)을 지운다(마이그레이션).
	// 같은 트랜잭션에서 users.vault_epoch 을 +1 하고, 생성된 볼트(Epoch 포함)를 돌려준다.
	// 이미 v2 면 ErrVaultConflict — 다른 기기가 먼저 설정한 것이므로 잠금해제 플로우로 전환한다.
	CreateUserVaultV2(ctx context.Context, vault UserVaultKey, precondition VaultMutationPrecondition) (UserVaultKey, error)
	// UpdateUserVaultV2 는 동기화 암호 변경(rewrap) — 기존 v2 행의 wrapped DEK/KDF 만 교체한다.
	// DEK 가 그대로이므로 epoch 은 올리지 않는다. vault.DekVerifier 가 비어 있지 않고 기존
	// 행의 verifier 가 비어 있으면 채운다(verifier 도입 이전 볼트의 지연 백필 — 잠금해제로
	// DEK 를 암호학적으로 증명한 클라이언트만 이 값을 만들 수 있다). 갱신된 볼트를 돌려준다.
	// v2 행이 없으면 ErrVaultNotFound/ErrVaultConflict.
	UpdateUserVaultV2(ctx context.Context, vault UserVaultKey, precondition VaultMutationPrecondition) (UserVaultKey, error)
	// ResetUserVault 는 볼트 초기화(동기화 암호 분실 최후 수단) — 볼트 행과 모든 sync 레코드를
	// 단일 트랜잭션으로 hard delete 하고 vault_epoch 을 +1 한다(옛 세대의 push 가 초기화
	// 직후 창에서도 epoch fence 에 걸리게). 계정·인증은 남는다.
	ResetUserVault(ctx context.Context, userID string, expectedEpoch int64) (int64, error)

	UpsertUserClientObservation(ctx context.Context, observation UserClientObservation) error

	// sync push/pull 은 원자성·일관성을 보장하는 이 두 메서드만 쓴다. kind 별 단건
	// upsert/list 는 revision bump 를 우회하므로 인터페이스에 노출하지 않는다(테스트는
	// GormStore 구체 타입의 메서드를 직접 쓴다).
	//
	// ApplyPushRecords 는 push 페이로드의 모든 kind upsert 와 revision bump 를 단일
	// 트랜잭션으로 처리하고 revision 을 돌려준다(데이터/ETag 원자성). 실제 변경이
	// 0건이면 bump 없이 현재 revision 을 돌려준다.
	//
	// fence가 있으면 사용자 행을 잠근 직후 epoch과 vault version을 다시 확인한다. v1
	// 구클라이언트 push에도 fence를 전달해야 reset/migration 직후의 오염을 막을 수 있다.
	ApplyPushRecords(ctx context.Context, userID string, payload syncmodel.Payload, fence VaultPushFence) (int64, error)
	// GetSyncSnapshot 은 revision + 모든 kind 를 단일 읽기 트랜잭션으로 읽어 일관 스냅샷을 준다.
	GetSyncSnapshot(ctx context.Context, userID string) (int64, syncmodel.Payload, error)

	// 유저 존재 확인 — 탈퇴 직후 잔여 access 토큰의 sync 재유입(데이터 부활) 차단용.
	// "행 없음"은 (false, nil), 드라이버 에러만 err 로 돌려준다.
	UserExists(ctx context.Context, userID string) (bool, error)

	// 회원 탈퇴 — 사용자의 모든 서버측 데이터(계정·인증·vault 키·기기 관찰·sync 레코드)를
	// 단일 트랜잭션으로 즉시 hard delete 한다.
	DeleteUserData(ctx context.Context, userID string) error
}
