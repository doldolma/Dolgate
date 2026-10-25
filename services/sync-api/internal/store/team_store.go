package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	syncmodel "dolssh/services/sync-api/internal/sync"
)

// 팀 볼트의 sentinel 에러. 라우터가 상태 코드로 바꾼다.
var (
	// ErrTeamNotFound 는 팀이 없거나 요청한 사람이 멤버가 아닌 경우다. 둘을 구분하지 않는다 —
	// 멤버가 아닌 사람에게는 팀이 있는지조차 알리지 않는다.
	ErrTeamNotFound = errors.New("team not found")
	// ErrTeamOwnerOnly 는 소유자만 하는 일(제거·소유권 넘기기·이름 바꾸기·팀 삭제)을 멤버가 하려는 경우다.
	ErrTeamOwnerOnly = errors.New("team owner only")
	// ErrTeamExists 는 앱이 만든 팀 ID 가 이미 있는 경우다.
	ErrTeamExists = errors.New("team already exists")
	// ErrTeamOwnerMustTransfer 는 다른 멤버가 남아 있는데 소유자가 나가거나 자기를 빼려는 경우다.
	ErrTeamOwnerMustTransfer = errors.New("team owner must transfer ownership first")
	// ErrTeamMemberNotFound 는 대상 사용자(제거·소유권 넘기기)가 그 팀 멤버가 아닌 경우다.
	ErrTeamMemberNotFound = errors.New("team member not found")
	// ErrTeamInviteInvalid 는 초대 링크를 쓸 수 없는 모든 경우다 — 코드 없음, 토큰 불일치, 기한 지남,
	// 취소됨. 하나로 묶어 어느 쪽인지 밖에서 알 수 없게 한다.
	ErrTeamInviteInvalid = errors.New("team invite invalid")
	// ErrTeamVaultRequired 는 E2EE(v2) 볼트가 없는 계정이 팀을 만들거나 들어오려는 경우다. v1 볼트는
	// 서버가 DEK 원문을 갖고 있어서, 그것으로 감싼 팀 키는 서버가 열 수 있다.
	ErrTeamVaultRequired = errors.New("team requires an e2ee vault")
	// ErrTeamAlreadyMember 는 사본까지 올린 멤버가 링크로 다시 들어오려는 경우다.
	ErrTeamAlreadyMember = errors.New("already a team member")
)

const (
	TeamRoleOwner  = "owner"
	TeamRoleMember = "member"
)

// defaultTeamHistoryRetention 은 이전 판을 남겨 두는 기간의 기본값이다(설정 teams.historyRetentionDays).
const defaultTeamHistoryRetention = 90 * 24 * time.Hour

// teamRow 는 팀 하나다. 이름은 평문이다 — 링크 페이지·알림·팀 목록이 풀지 않고 바로 쓴다(설계).
type teamRow struct {
	ID   string `gorm:"column:id;primaryKey;type:varchar(191)"`
	Name string `gorm:"column:name;not null;type:varchar(255)"`
	// revision 은 팀 레코드가 바뀔 때마다 +1 이다. GET /teams/:id/sync 의 ETag 다.
	Revision int64 `gorm:"column:revision;not null;default:0"`
	// info_revision 은 레코드가 아닌 팀 정보(이름·멤버·역할·사본·초대 링크)가 바뀔 때마다 +1 이다.
	// 팀 감시가 이것도 보므로 멤버 변화가 기다리던 기기에 바로 전해진다.
	InfoRevision int64 `gorm:"column:info_revision;not null;default:0"`
	// data_floor 는 이 팀 데이터를 다루려면 앱이 갖춰야 하는 수준이다. 계정의 sync_data_floor 와 같은
	// 방식(push 헤더로 올리기만 한다)인데 팀 단위라, 못 따라오는 앱은 그 팀만 막힌다.
	DataFloor int `gorm:"column:data_floor;not null;default:0"`
	// event_seq 는 그 팀 기록의 마지막 순번이다. 기록을 쓰는 트랜잭션이 팀 행을 잠그고 올린다.
	EventSeq int64 `gorm:"column:event_seq;not null;default:0"`
	// replay_count·replay_bytes 는 지금 남아 있는 녹화(지워진 것은 빼고 진행 중인 것은 넣고)의 합계다.
	// 녹화를 쓰는 트랜잭션이 팀 행을 잠그고 고친다 — 한도를 볼 때 녹화를 다 더하지 않으려고.
	ReplayCount int64     `gorm:"column:replay_count;not null;default:0"`
	ReplayBytes int64     `gorm:"column:replay_bytes;not null;default:0"`
	CreatedBy   string    `gorm:"column:created_by;not null;type:varchar(191)"`
	CreatedAt   time.Time `gorm:"column:created_at;not null"`
	UpdatedAt   time.Time `gorm:"column:updated_at;not null"`
}

func (teamRow) TableName() string {
	return "teams"
}

type teamMemberRow struct {
	TeamID string `gorm:"column:team_id;primaryKey;type:varchar(191)"`
	UserID string `gorm:"column:user_id;primaryKey;index;type:varchar(191)"`
	Role   string `gorm:"column:role;not null;type:varchar(16)"`
	// wrapped_team_dek 는 이 멤버의 개인 DEK 로 감싼 팀 키다. 링크로 들어온 직후 사본을 올리기
	// 전에는 비어 있다.
	WrappedTeamDek *string `gorm:"column:wrapped_team_dek;type:text"`
	// joined_via 는 이 멤버가 들어온 초대 코드다. 팀을 만든 사람은 비어 있다.
	JoinedVia *string `gorm:"column:joined_via;type:varchar(64)"`
	// added_by 는 그 초대 링크를 만든 멤버다. 팀을 만든 사람은 자기 자신이다.
	AddedBy string `gorm:"column:added_by;not null;type:varchar(191)"`
	// added_at 은 소유자가 빠질 때 누가 이을지 정한다 — 가장 먼저 들어온 멤버가 잇는다.
	AddedAt time.Time `gorm:"column:added_at;not null"`
	// private_revision 은 이 멤버의 개인 칸이 바뀔 때마다 +1 이다. 팀 감시가 그 멤버의 기기만 깨운다.
	PrivateRevision int64 `gorm:"column:private_revision;not null;default:0"`
}

func (teamMemberRow) TableName() string {
	return "team_members"
}

type teamInviteRow struct {
	Code      string `gorm:"column:code;primaryKey;type:varchar(64)"`
	TeamID    string `gorm:"column:team_id;not null;index;type:varchar(191)"`
	CreatedBy string `gorm:"column:created_by;not null;type:varchar(191)"`
	// invite_box 는 링크의 비밀값(# 뒤, 서버는 모른다)으로 잠근 팀 키다. 기한이 지나거나 취소되면
	// 지운다 — DB 가 새고 옛 링크가 채팅에 남아 있어도 팀 키가 나오지 않게. 행은 목록용으로 남긴다.
	InviteBox *string `gorm:"column:invite_box;type:text"`
	// sealed_secret 은 그 비밀값을 팀 키로 잠근 것이다(서버는 팀 키가 없어 못 연다). 멤버가 목록에서 링크를
	// 다시 복사할 때 앱이 연다. 상자와 함께 지운다 — 쓸 수 없는 링크는 다시 복사할 까닭도 없다.
	SealedSecret *string `gorm:"column:sealed_secret;type:text"`
	// join_token_hash 는 참여 토큰의 SHA-256(hex)이다. 토큰은 상자 열쇠와 따로 뽑은 값이라, 서버가
	// 참여 때 토큰을 봐도 상자는 못 연다.
	JoinTokenHash string     `gorm:"column:join_token_hash;not null;type:varchar(64)"`
	ExpiresAt     time.Time  `gorm:"column:expires_at;not null;index"`
	UseCount      int64      `gorm:"column:use_count;not null;default:0"`
	RevokedAt     *time.Time `gorm:"column:revoked_at"`
	CreatedAt     time.Time  `gorm:"column:created_at;not null"`
}

func (teamInviteRow) TableName() string {
	return "team_invites"
}

// teamMemberPrivateRow 는 멤버 개인 칸의 레코드 하나다. 그 멤버의 개인 DEK 로 잠근 암호문이라 팀
// 키로는 안 열리고, 서버는 주인에게만 돌려준다.
type teamMemberPrivateRow struct {
	TeamID           string     `gorm:"column:team_id;primaryKey;type:varchar(191)"`
	UserID           string     `gorm:"column:user_id;primaryKey;type:varchar(191)"`
	Kind             string     `gorm:"column:kind;primaryKey;type:varchar(64)"`
	ID               string     `gorm:"column:id;primaryKey;type:varchar(191)"`
	EncryptedPayload string     `gorm:"column:encrypted_payload;not null;type:text"`
	UpdatedAt        time.Time  `gorm:"column:updated_at;not null;autoUpdateTime:false"`
	DeletedAt        *time.Time `gorm:"column:deleted_at"`
}

func (teamMemberPrivateRow) TableName() string {
	return "team_member_private"
}

// teamSyncRecordRow 는 팀 레코드 하나다. 개인 sync_records 와 같은 모양에 올린 사람을 더했다 —
// 서버가 원래 아는 값이고, "누가 바꿨는지"(제품 2단계)가 여기서 나온다.
type teamSyncRecordRow struct {
	TeamID           string     `gorm:"column:team_id;primaryKey;type:varchar(191)"`
	Kind             string     `gorm:"column:kind;primaryKey;type:varchar(64)"`
	ID               string     `gorm:"column:id;primaryKey;type:varchar(191)"`
	EncryptedPayload string     `gorm:"column:encrypted_payload;not null;type:text"`
	UpdatedAt        time.Time  `gorm:"column:updated_at;not null;autoUpdateTime:false"`
	DeletedAt        *time.Time `gorm:"column:deleted_at"`
	UpdatedBy        string     `gorm:"column:updated_by;not null;type:varchar(191)"`
}

func (teamSyncRecordRow) TableName() string {
	return "team_sync_records"
}

// teamRecordHistoryRow 는 덮어쓰이거나 지워진 팀 레코드의 이전 판이다(암호문 그대로). 소유자가
// 이것으로 되돌린다(화면은 제품 2단계). 보존 기간이 지나면 지운다.
type teamRecordHistoryRow struct {
	Seq              int64      `gorm:"column:seq;primaryKey;autoIncrement"`
	TeamID           string     `gorm:"column:team_id;not null;index:idx_team_record_history_record,priority:1;type:varchar(191)"`
	Kind             string     `gorm:"column:kind;not null;index:idx_team_record_history_record,priority:2;type:varchar(64)"`
	RecordID         string     `gorm:"column:record_id;not null;index:idx_team_record_history_record,priority:3;type:varchar(191)"`
	EncryptedPayload string     `gorm:"column:encrypted_payload;not null;type:text"`
	UpdatedAt        time.Time  `gorm:"column:updated_at;not null;autoUpdateTime:false"`
	DeletedAt        *time.Time `gorm:"column:deleted_at"`
	// updated_by 는 그 판을 쓴 사람, changed_by 는 그 판을 밀어낸 사람이다.
	UpdatedBy string    `gorm:"column:updated_by;not null;type:varchar(191)"`
	ChangedBy string    `gorm:"column:changed_by;not null;type:varchar(191)"`
	ChangedAt time.Time `gorm:"column:changed_at;not null;index"`
}

func (teamRecordHistoryRow) TableName() string {
	return "team_record_history"
}

// TeamSummary 는 한 사용자가 본 팀이다 — 내 역할과 내 사본이 붙는다.
type TeamSummary struct {
	ID   string
	Name string
	Role string
	// WrappedTeamDek 은 내 개인 DEK 로 감싼 팀 키다. 링크로 들어온 직후 아직 안 올렸으면 빈 값이다.
	WrappedTeamDek string
	DataFloor      int
	MemberCount    int
	CreatedAt      time.Time
}

type CreateTeamInput struct {
	// TeamID 는 앱이 만든다 — 사본을 감쌀 때 팀 ID 를 AAD 로 묶어야 해서, 만들기 전에 알아야 한다.
	TeamID         string
	Name           string
	OwnerID        string
	WrappedTeamDek string
	// VaultEpoch 는 사본을 감싼 개인 DEK 의 세대다(개인 push 의 펜스와 같다).
	VaultEpoch int64
}

type TeamMember struct {
	UserID       string
	Email        string
	Role         string
	HasKey       bool
	AddedBy      string
	AddedByEmail string
	AddedAt      time.Time
}

type CreateTeamInviteInput struct {
	TeamID    string
	CreatedBy string
	InviteBox string
	// SealedSecret 은 없을 수 있다 — 이 칸을 모르는 앱이 만든 링크는 다시 복사할 수 없을 뿐이다.
	SealedSecret  string
	JoinTokenHash string
	ExpiresAt     time.Time
}

type TeamInvite struct {
	Code           string
	CreatedBy      string
	CreatedByEmail string
	ExpiresAt      time.Time
	UseCount       int64
	RevokedAt      *time.Time
	CreatedAt      time.Time
	// Active 는 지금 이 링크로 들어올 수 있는지다(상자가 있고, 기한 전이고, 취소되지 않음).
	Active bool
	// SealedSecret 은 링크 비밀값을 팀 키로 잠근 것이다. 살아 있는 링크에만 있다.
	SealedSecret string
}

// TeamInviteInfo 는 참여 카드에 보이는 것이다. 상자는 없다 — 상자는 참여할 때만 준다.
type TeamInviteInfo struct {
	TeamID       string
	TeamName     string
	InviterEmail string
	MemberCount  int
	ExpiresAt    time.Time
}

// TeamInvitePage 는 로그인 없이 여는 링크 페이지에 보일 것 — 팀 이름뿐이다(초대한 사람은 앱의 참여 카드에서).
type TeamInvitePage struct {
	TeamName string
}

type TeamJoinResult struct {
	TeamID    string
	TeamName  string
	InviteBox string
	// Rejoined 는 사본을 올리기 전에 끊긴 멤버가 상자를 다시 받은 경우다.
	Rejoined bool
}

// TeamGate 는 팀 경로마다 게이트가 한 번에 읽는 값이다. Member 가 false 면 나머지는 0 이다.
type TeamGate struct {
	Member          bool
	Role            string
	DataFloor       int
	Revision        int64
	InfoRevision    int64
	PrivateRevision int64
}

// WatchValue 는 팀 감시가 견주는 값이다. 세 리비전은 오르기만 하므로 합이 바뀌면 무언가 바뀐 것이다.
func (g TeamGate) WatchValue() int64 {
	return g.Revision + g.InfoRevision + g.PrivateRevision
}

type TeamLeaveResult struct {
	// TeamDeleted 는 마지막 한 명이 나가 팀째 지워진 경우다.
	TeamDeleted bool
}

// TeamWatchKey 는 팀 감시 대기자 하나(그 팀, 기다리는 멤버)다.
type TeamWatchKey struct {
	TeamID string
	UserID string
}

// TeamStore 는 팀 볼트 저장 기능이다. Store 가 품는다.
//
// 잠금 순서 전역 규칙: users → teams → 팀 하위 표. 개인 DEK 로 잠근 것을 올리는 길(팀 만들기·
// 사본·개인 칸)과 참여는 사용자 행을 먼저 잠그고(볼트 세대 확인), 볼트 초기화·탈퇴도 사용자 행을
// 먼저 잠근다. 팀만 바꾸는 쓰기는 팀 행만 잠그고 users 행은 잡지 않는다 — 그래서 반대 순서로 잡아
// 교착하는 길이 없다. 팀 목록이 바뀐 사람의 개인 리비전은 커밋 뒤 TouchSyncRevisions 로 따로 올린다.
type TeamStore interface {
	CreateTeam(ctx context.Context, input CreateTeamInput) (TeamSummary, error)
	ListTeamsForUser(ctx context.Context, userID string) ([]TeamSummary, error)
	RenameTeam(ctx context.Context, teamID string, actorID string, name string) error
	TransferTeamOwnership(ctx context.Context, teamID string, actorID string, newOwnerID string) error
	// DeleteTeam 은 팀과 그 데이터를 모두 지우고, 지우기 직전의 멤버 ID 를 돌려준다.
	DeleteTeam(ctx context.Context, teamID string, actorID string) ([]string, error)
	ListTeamMembers(ctx context.Context, teamID string, actorID string) ([]TeamMember, error)
	RemoveTeamMember(ctx context.Context, teamID string, actorID string, targetID string) error
	LeaveTeam(ctx context.Context, teamID string, userID string) (TeamLeaveResult, error)
	PutTeamMemberKey(ctx context.Context, teamID string, userID string, wrappedTeamDek string, vaultEpoch int64) error

	CreateTeamInvite(ctx context.Context, input CreateTeamInviteInput) (TeamInvite, error)
	ListTeamInvites(ctx context.Context, teamID string, actorID string) ([]TeamInvite, error)
	RevokeTeamInvite(ctx context.Context, teamID string, actorID string, code string) error
	GetTeamInviteInfo(ctx context.Context, code string, joinToken string) (TeamInviteInfo, error)
	// GetTeamInvitePage 는 로그인 없이 여는 링크 페이지에 보일 팀 이름이다. 쓸 수 없는 링크면 ErrTeamInviteInvalid.
	GetTeamInvitePage(ctx context.Context, code string) (TeamInvitePage, error)
	JoinTeam(ctx context.Context, code string, joinToken string, userID string) (TeamJoinResult, error)

	GetTeamGate(ctx context.Context, teamID string, userID string) (TeamGate, error)
	GetTeamSyncSnapshot(ctx context.Context, teamID string, userID string) (int64, syncmodel.Payload, error)
	ApplyTeamPushRecords(ctx context.Context, teamID string, userID string, payload syncmodel.Payload) (int64, error)
	RaiseTeamDataFloor(ctx context.Context, teamID string, floor int) error
	GetTeamPrivateSnapshot(ctx context.Context, teamID string, userID string) (int64, syncmodel.Payload, error)
	ApplyTeamPrivateRecords(ctx context.Context, teamID string, userID string, payload syncmodel.Payload, vaultEpoch int64) (int64, error)

	// GetTeamWatchRevisions 는 팀 감시 묶음 확인용이다 — 그 팀들의 멤버마다 감시 값을 준다. 멤버가
	// 아니게 된 키는 결과에 없다.
	GetTeamWatchRevisions(ctx context.Context, teamIDs []string) (map[TeamWatchKey]int64, error)
	// TouchSyncRevisions 는 팀 목록이 바뀐 사람들의 개인 리비전을 +1 해 그 사람의 다른 기기를
	// 깨운다. 사람마다 따로 커밋한다(users 행을 한꺼번에 잡지 않는다).
	TouchSyncRevisions(ctx context.Context, userIDs []string) error
}

// SetTeamHistoryRetention 은 이전 판을 남겨 두는 기간이다. 0 이하면 기본값(90일)이다.
func (s *GormStore) SetTeamHistoryRetention(retention time.Duration) {
	s.sweepMu.Lock()
	defer s.sweepMu.Unlock()
	s.teamHistoryRetention = retention
}

func (s *GormStore) teamHistoryRetentionValue() time.Duration {
	s.sweepMu.Lock()
	defer s.sweepMu.Unlock()
	if s.teamHistoryRetention <= 0 {
		return defaultTeamHistoryRetention
	}
	return s.teamHistoryRetention
}

// HashTeamJoinToken 은 참여 토큰을 저장·대조하는 모양(SHA-256 hex)으로 바꾼다. 앱도 같은 식으로
// 해시를 만들어 링크를 만들 때 올린다.
func HashTeamJoinToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func newTeamInviteCode() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// lockTeamRowTx 는 팀 행을 잠그고 읽는다. 팀을 바꾸는 쓰기는 모두 이것부터 해서 그 팀의 쓰기를
// 직렬화한다(제거와 push, 제거와 링크 만들기가 서로 앞지르지 않게). SQLite 는 pool=1 이 모든 접근을
// 직렬화하므로 잠그지 않는다.
func (s *GormStore) lockTeamRowTx(tx *gorm.DB, teamID string) (teamRow, error) {
	query := tx
	if s.driver != "sqlite" {
		query = query.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	var row teamRow
	err := query.Where("id = ?", teamID).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return teamRow{}, ErrTeamNotFound
	}
	return row, err
}

// forUpdate 는 쓰기 트랜잭션 안에서 판단에 쓰는 읽기를 잠금 읽기로 바꾼다.
//
// MySQL 의 기본 격리(REPEATABLE READ)에서 평범한 SELECT 는 그 트랜잭션의 첫 읽기 시점 스냅숏을 본다.
// 그래서 팀 잠금을 기다리는 사이 다른 트랜잭션이 커밋한 것(멤버 제거, 링크 취소)을 못 보고 옛 행으로
// 판단한다 — 실제로 제거와 동시에 쓴 개인 칸이 제거 뒤에 남았다. 잠금 읽기는 늘 최신 커밋을 본다.
// 사용자 행을 먼저 잡는 길(참여·사본·개인 칸·초기화·탈퇴)은 팀 잠금 전에 평범한 읽기를 하므로 이것을
// 쓴다. SQLite 는 연결 하나로 직렬화돼 필요 없다.
//
// 세션으로 돌려줘 여러 번 써도 된다 — 체인 메서드가 돌려준 *gorm.DB 를 다시 쓰면 앞 조건이 쌓인다.
func (s *GormStore) forUpdate(tx *gorm.DB) *gorm.DB {
	if s.driver == "sqlite" {
		return tx
	}
	return tx.Clauses(clause.Locking{Strength: "UPDATE"}).Session(&gorm.Session{})
}

// lockTeamMemberTx 는 멤버 행을 잠금 읽기로 본다(forUpdate 주석 참고). 팀 행을 잡은 뒤에 부른다.
func (s *GormStore) lockTeamMemberTx(tx *gorm.DB, teamID string, userID string) (teamMemberRow, error) {
	return getTeamMemberTx(s.forUpdate(tx), teamID, userID)
}

func getTeamMemberTx(tx *gorm.DB, teamID string, userID string) (teamMemberRow, error) {
	var row teamMemberRow
	err := tx.Where("team_id = ? AND user_id = ?", teamID, userID).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return teamMemberRow{}, ErrTeamNotFound
	}
	return row, err
}

// requireTeamVaultTx 는 사용자 행을 잠근 뒤 E2EE(v2) 볼트가 있는지 본다. vaultEpoch 가 있으면 세대도
// 대조한다 — 개인 DEK 로 감싼 것(팀 키 사본·개인 칸)을 올리는 길이 쓰며, 초기화 전 DEK 를 쥔
// 기기가 옛 키로 감싼 것을 올리지 못하게 한다(개인 push 의 펜스와 같은 규칙).
func (s *GormStore) requireTeamVaultTx(tx *gorm.DB, userID string, vaultEpoch *int64) error {
	if err := s.lockUserRowTx(tx, userID); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrTeamVaultRequired
		}
		return err
	}
	var vault userVaultKeyRow
	err := tx.Select("version").Where("user_id = ?", userID).Take(&vault).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrTeamVaultRequired
	}
	if err != nil {
		return err
	}
	if vault.Version < 2 {
		return ErrTeamVaultRequired
	}
	if vaultEpoch == nil {
		return nil
	}
	epoch, err := getVaultEpochTx(tx, userID)
	if err != nil {
		return err
	}
	if epoch != *vaultEpoch {
		return ErrVaultEpochMismatch
	}
	return nil
}

func bumpTeamInfoRevisionTx(tx *gorm.DB, teamID string, extra map[string]any) error {
	updates := map[string]any{"info_revision": gorm.Expr("info_revision + 1")}
	for key, value := range extra {
		updates[key] = value
	}
	return tx.Model(&teamRow{}).Where("id = ?", teamID).Updates(updates).Error
}

// revokeTeamInvitesTx 는 그 팀의 링크를 모두 쓸 수 없게 하고 상자를 지운다. 멤버가 빠질 때 부른다 —
// 뺀 사람이 아는 링크로 되돌아오지 못하게.
func revokeTeamInvitesTx(tx *gorm.DB, teamID string, now time.Time) error {
	return tx.Model(&teamInviteRow{}).
		Where("team_id = ? AND revoked_at IS NULL", teamID).
		Updates(map[string]any{"invite_box": nil, "sealed_secret": nil, "revoked_at": now}).Error
}

// removeTeamMemberTx 는 멤버 하나의 사본·접근·개인 칸과 그 팀의 링크를 지운다. 호출자가 팀 행을
// 잠근 뒤 부른다.
func removeTeamMemberTx(tx *gorm.DB, teamID string, userID string, now time.Time) error {
	if err := tx.Where("team_id = ? AND user_id = ?", teamID, userID).Delete(&teamMemberPrivateRow{}).Error; err != nil {
		return err
	}
	if err := tx.Where("team_id = ? AND user_id = ?", teamID, userID).Delete(&teamMemberRow{}).Error; err != nil {
		return err
	}
	if err := revokeTeamInvitesTx(tx, teamID, now); err != nil {
		return err
	}
	return bumpTeamInfoRevisionTx(tx, teamID, nil)
}

// deleteTeamDataTx 는 팀과 그 팀의 모든 행을 지운다. 호출자가 팀 행을 잠근 뒤 부른다. 녹화는 "지워짐"으로만
// 돌린다 — 큰 구간 행은 정리 작업이 나눠 지운다(markTeamReplaysDeletedTx).
func deleteTeamDataTx(tx *gorm.DB, teamID string) error {
	for _, model := range []any{
		&teamRecordHistoryRow{},
		&teamSyncRecordRow{},
		&teamMemberPrivateRow{},
		&teamInviteRow{},
		&teamEventRow{},
		&teamMemberRow{},
	} {
		if err := tx.Where("team_id = ?", teamID).Delete(model).Error; err != nil {
			return err
		}
	}
	if err := markTeamReplaysDeletedTx(tx, teamID); err != nil {
		return err
	}
	return tx.Where("id = ?", teamID).Delete(&teamRow{}).Error
}

// leaveAllTeamsTx 는 볼트 초기화·회원 탈퇴 트랜잭션 안에서 그 사람을 모든 팀에서 뺀다. 호출자가
// 사용자 행을 먼저 잠근다(잠금 순서 users → teams). 소유자였으면 가장 먼저 들어온 멤버가 잇고,
// 마지막 한 명이었으면 팀째 지운다. reason 은 팀 기록에 남는 까닭이다(teamEventReason*).
func (s *GormStore) leaveAllTeamsTx(tx *gorm.DB, userID string, reason string) error {
	var teamIDs []string
	if err := tx.Model(&teamMemberRow{}).
		Where("user_id = ?", userID).
		Order("team_id").
		Pluck("team_id", &teamIDs).Error; err != nil {
		return err
	}
	now := time.Now().UTC()
	for _, teamID := range teamIDs {
		if _, err := s.lockTeamRowTx(tx, teamID); err != nil {
			if errors.Is(err, ErrTeamNotFound) {
				continue
			}
			return err
		}
		member, err := s.lockTeamMemberTx(tx, teamID, userID)
		if err != nil {
			if errors.Is(err, ErrTeamNotFound) {
				continue
			}
			return err
		}
		var successor teamMemberRow
		successorErr := s.forUpdate(tx).Where("team_id = ? AND user_id <> ?", teamID, userID).
			Order("added_at ASC, user_id ASC").
			Take(&successor).Error
		if errors.Is(successorErr, gorm.ErrRecordNotFound) {
			if err := deleteTeamDataTx(tx, teamID); err != nil {
				return err
			}
			continue
		}
		if successorErr != nil {
			return successorErr
		}
		if member.Role == TeamRoleOwner {
			if err := tx.Model(&teamMemberRow{}).
				Where("team_id = ? AND user_id = ?", teamID, successor.UserID).
				Update("role", TeamRoleOwner).Error; err != nil {
				return err
			}
		}
		if err := removeTeamMemberTx(tx, teamID, userID, now); err != nil {
			return err
		}
		if err := s.appendServerTeamEventTx(tx, teamID, userID, teamServerEvent{
			Type: teamEventMemberLeft, UserID: userID, Reason: reason,
		}, now); err != nil {
			return err
		}
		if member.Role == TeamRoleOwner {
			if err := s.appendServerTeamEventTx(tx, teamID, userID, teamServerEvent{
				Type: teamEventOwnerChanged, UserID: successor.UserID, ByUserID: userID, Reason: teamEventReasonSuccessor,
			}, now); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *GormStore) CreateTeam(ctx context.Context, input CreateTeamInput) (TeamSummary, error) {
	now := time.Now().UTC()
	var summary TeamSummary
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.requireTeamVaultTx(tx, input.OwnerID, &input.VaultEpoch); err != nil {
			return err
		}
		var existing int64
		if err := tx.Model(&teamRow{}).Where("id = ?", input.TeamID).Count(&existing).Error; err != nil {
			return err
		}
		if existing > 0 {
			return ErrTeamExists
		}
		team := teamRow{
			ID:           input.TeamID,
			Name:         input.Name,
			InfoRevision: 1,
			CreatedBy:    input.OwnerID,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(&team).Error; err != nil {
			if isDuplicateKeyError(err) {
				return ErrTeamExists
			}
			return err
		}
		key := input.WrappedTeamDek
		owner := teamMemberRow{
			TeamID:         input.TeamID,
			UserID:         input.OwnerID,
			Role:           TeamRoleOwner,
			WrappedTeamDek: &key,
			AddedBy:        input.OwnerID,
			AddedAt:        now,
		}
		if err := tx.Create(&owner).Error; err != nil {
			return err
		}
		summary = TeamSummary{
			ID:             team.ID,
			Name:           team.Name,
			Role:           TeamRoleOwner,
			WrappedTeamDek: key,
			MemberCount:    1,
			CreatedAt:      team.CreatedAt,
		}
		return nil
	})
	if err != nil {
		return TeamSummary{}, err
	}
	return summary, nil
}

func (s *GormStore) ListTeamsForUser(ctx context.Context, userID string) ([]TeamSummary, error) {
	type listRow struct {
		ID             string
		Name           string
		DataFloor      int
		CreatedAt      time.Time
		Role           string
		WrappedTeamDek *string
	}
	var rows []listRow
	if err := s.db.WithContext(ctx).
		Table("team_members").
		Select("teams.id AS id, teams.name AS name, teams.data_floor AS data_floor, teams.created_at AS created_at, team_members.role AS role, team_members.wrapped_team_dek AS wrapped_team_dek").
		Joins("JOIN teams ON teams.id = team_members.team_id").
		Where("team_members.user_id = ?", userID).
		Order("teams.created_at ASC, teams.id ASC").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	teams := make([]TeamSummary, 0, len(rows))
	if len(rows) == 0 {
		return teams, nil
	}
	teamIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		teamIDs = append(teamIDs, row.ID)
	}
	counts, err := countTeamMembers(s.db.WithContext(ctx), teamIDs)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		summary := TeamSummary{
			ID:          row.ID,
			Name:        row.Name,
			Role:        row.Role,
			DataFloor:   row.DataFloor,
			MemberCount: counts[row.ID],
			CreatedAt:   row.CreatedAt.UTC(),
		}
		if row.WrappedTeamDek != nil {
			summary.WrappedTeamDek = *row.WrappedTeamDek
		}
		teams = append(teams, summary)
	}
	return teams, nil
}

func countTeamMembers(db *gorm.DB, teamIDs []string) (map[string]int, error) {
	type countRow struct {
		TeamID string
		Total  int
	}
	var rows []countRow
	if err := db.Model(&teamMemberRow{}).
		Select("team_id AS team_id, COUNT(*) AS total").
		Where("team_id IN ?", teamIDs).
		Group("team_id").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	counts := make(map[string]int, len(rows))
	for _, row := range rows {
		counts[row.TeamID] = row.Total
	}
	return counts, nil
}

// requireTeamOwnerTx 는 팀 행을 잠그고 actor 가 그 팀의 소유자인지 본다.
func (s *GormStore) requireTeamOwnerTx(tx *gorm.DB, teamID string, actorID string) error {
	if _, err := s.lockTeamRowTx(tx, teamID); err != nil {
		return err
	}
	actor, err := getTeamMemberTx(tx, teamID, actorID)
	if err != nil {
		return err
	}
	if actor.Role != TeamRoleOwner {
		return ErrTeamOwnerOnly
	}
	return nil
}

func (s *GormStore) RenameTeam(ctx context.Context, teamID string, actorID string, name string) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.requireTeamOwnerTx(tx, teamID, actorID); err != nil {
			return err
		}
		return bumpTeamInfoRevisionTx(tx, teamID, map[string]any{"name": name})
	})
}

func (s *GormStore) TransferTeamOwnership(ctx context.Context, teamID string, actorID string, newOwnerID string) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.requireTeamOwnerTx(tx, teamID, actorID); err != nil {
			return err
		}
		if newOwnerID == actorID {
			return nil
		}
		if _, err := getTeamMemberTx(tx, teamID, newOwnerID); err != nil {
			if errors.Is(err, ErrTeamNotFound) {
				return ErrTeamMemberNotFound
			}
			return err
		}
		// 넘기기는 역할만 바꾼다. 키는 오가지 않는다 — 소유자는 관리 권한이지 더 많이 보는 자리가 아니다.
		if err := tx.Model(&teamMemberRow{}).
			Where("team_id = ? AND user_id = ?", teamID, actorID).
			Update("role", TeamRoleMember).Error; err != nil {
			return err
		}
		if err := tx.Model(&teamMemberRow{}).
			Where("team_id = ? AND user_id = ?", teamID, newOwnerID).
			Update("role", TeamRoleOwner).Error; err != nil {
			return err
		}
		if err := s.appendServerTeamEventTx(tx, teamID, actorID, teamServerEvent{
			Type: teamEventOwnerChanged, UserID: newOwnerID, ByUserID: actorID,
		}, time.Now().UTC()); err != nil {
			return err
		}
		return bumpTeamInfoRevisionTx(tx, teamID, nil)
	})
}

func (s *GormStore) DeleteTeam(ctx context.Context, teamID string, actorID string) ([]string, error) {
	var memberIDs []string
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.requireTeamOwnerTx(tx, teamID, actorID); err != nil {
			return err
		}
		if err := tx.Model(&teamMemberRow{}).Where("team_id = ?", teamID).Order("user_id").Pluck("user_id", &memberIDs).Error; err != nil {
			return err
		}
		return deleteTeamDataTx(tx, teamID)
	})
	if err != nil {
		return nil, err
	}
	return memberIDs, nil
}

func (s *GormStore) ListTeamMembers(ctx context.Context, teamID string, actorID string) ([]TeamMember, error) {
	db := s.db.WithContext(ctx)
	if _, err := getTeamMemberTx(db, teamID, actorID); err != nil {
		return nil, err
	}
	type memberRow struct {
		UserID         string
		Email          *string
		Role           string
		WrappedTeamDek *string
		AddedBy        string
		AddedByEmail   *string
		AddedAt        time.Time
	}
	var rows []memberRow
	if err := db.Table("team_members").
		Select("team_members.user_id AS user_id, members.email AS email, team_members.role AS role, team_members.wrapped_team_dek AS wrapped_team_dek, team_members.added_by AS added_by, adders.email AS added_by_email, team_members.added_at AS added_at").
		Joins("LEFT JOIN users AS members ON members.id = team_members.user_id").
		Joins("LEFT JOIN users AS adders ON adders.id = team_members.added_by").
		Where("team_members.team_id = ?", teamID).
		Order("team_members.added_at ASC, team_members.user_id ASC").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	members := make([]TeamMember, 0, len(rows))
	for _, row := range rows {
		member := TeamMember{
			UserID:  row.UserID,
			Role:    row.Role,
			HasKey:  row.WrappedTeamDek != nil && *row.WrappedTeamDek != "",
			AddedBy: row.AddedBy,
			AddedAt: row.AddedAt.UTC(),
		}
		if row.Email != nil {
			member.Email = *row.Email
		}
		if row.AddedByEmail != nil {
			member.AddedByEmail = *row.AddedByEmail
		}
		members = append(members, member)
	}
	return members, nil
}

func (s *GormStore) RemoveTeamMember(ctx context.Context, teamID string, actorID string, targetID string) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.requireTeamOwnerTx(tx, teamID, actorID); err != nil {
			return err
		}
		if targetID == actorID {
			// 소유자는 자기를 빼지 않는다 — 넘기고 나간다.
			return ErrTeamOwnerMustTransfer
		}
		if _, err := getTeamMemberTx(tx, teamID, targetID); err != nil {
			if errors.Is(err, ErrTeamNotFound) {
				return ErrTeamMemberNotFound
			}
			return err
		}
		now := time.Now().UTC()
		if err := removeTeamMemberTx(tx, teamID, targetID, now); err != nil {
			return err
		}
		return s.appendServerTeamEventTx(tx, teamID, actorID, teamServerEvent{
			Type: teamEventMemberRemoved, UserID: targetID, ByUserID: actorID,
		}, now)
	})
}

func (s *GormStore) LeaveTeam(ctx context.Context, teamID string, userID string) (TeamLeaveResult, error) {
	var result TeamLeaveResult
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if _, err := s.lockTeamRowTx(tx, teamID); err != nil {
			return err
		}
		member, err := getTeamMemberTx(tx, teamID, userID)
		if err != nil {
			return err
		}
		var total int64
		if err := tx.Model(&teamMemberRow{}).Where("team_id = ?", teamID).Count(&total).Error; err != nil {
			return err
		}
		if total <= 1 {
			// 마지막 한 명이 나가면 팀을 지운다.
			result.TeamDeleted = true
			return deleteTeamDataTx(tx, teamID)
		}
		if member.Role == TeamRoleOwner {
			return ErrTeamOwnerMustTransfer
		}
		now := time.Now().UTC()
		if err := removeTeamMemberTx(tx, teamID, userID, now); err != nil {
			return err
		}
		return s.appendServerTeamEventTx(tx, teamID, userID, teamServerEvent{
			Type: teamEventMemberLeft, UserID: userID,
		}, now)
	})
	if err != nil {
		return TeamLeaveResult{}, err
	}
	return result, nil
}

func (s *GormStore) PutTeamMemberKey(ctx context.Context, teamID string, userID string, wrappedTeamDek string, vaultEpoch int64) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.requireTeamVaultTx(tx, userID, &vaultEpoch); err != nil {
			return err
		}
		if _, err := s.lockTeamRowTx(tx, teamID); err != nil {
			return err
		}
		if _, err := s.lockTeamMemberTx(tx, teamID, userID); err != nil {
			return err
		}
		if err := tx.Model(&teamMemberRow{}).
			Where("team_id = ? AND user_id = ?", teamID, userID).
			Update("wrapped_team_dek", wrappedTeamDek).Error; err != nil {
			return err
		}
		return bumpTeamInfoRevisionTx(tx, teamID, nil)
	})
}

func (s *GormStore) CreateTeamInvite(ctx context.Context, input CreateTeamInviteInput) (TeamInvite, error) {
	now := time.Now().UTC()
	var invite TeamInvite
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 팀 행을 잠가 멤버 제거(링크를 모두 지운다)와 직렬화한다 — 빠지는 사람이 그 틈에 만든
		// 링크가 살아남지 않게.
		if _, err := s.lockTeamRowTx(tx, input.TeamID); err != nil {
			return err
		}
		if _, err := getTeamMemberTx(tx, input.TeamID, input.CreatedBy); err != nil {
			return err
		}
		code, err := newTeamInviteCode()
		if err != nil {
			return err
		}
		box := input.InviteBox
		row := teamInviteRow{
			Code:          code,
			TeamID:        input.TeamID,
			CreatedBy:     input.CreatedBy,
			InviteBox:     &box,
			JoinTokenHash: input.JoinTokenHash,
			ExpiresAt:     input.ExpiresAt.UTC(),
			CreatedAt:     now,
		}
		if input.SealedSecret != "" {
			sealed := input.SealedSecret
			row.SealedSecret = &sealed
		}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		invite = TeamInvite{
			Code:      code,
			CreatedBy: input.CreatedBy,
			ExpiresAt: row.ExpiresAt,
			CreatedAt: now,
			Active:    row.ExpiresAt.After(now),
		}
		if invite.Active {
			invite.SealedSecret = input.SealedSecret
		}
		return bumpTeamInfoRevisionTx(tx, input.TeamID, nil)
	})
	if err != nil {
		return TeamInvite{}, err
	}
	s.sweepExpiredTeamInviteBoxes()
	return invite, nil
}

func (s *GormStore) ListTeamInvites(ctx context.Context, teamID string, actorID string) ([]TeamInvite, error) {
	db := s.db.WithContext(ctx)
	if _, err := getTeamMemberTx(db, teamID, actorID); err != nil {
		return nil, err
	}
	type inviteRow struct {
		Code           string
		CreatedBy      string
		CreatedByEmail *string
		HasBox         int
		SealedSecret   *string
		ExpiresAt      time.Time
		UseCount       int64
		RevokedAt      *time.Time
		CreatedAt      time.Time
	}
	var rows []inviteRow
	if err := db.Table("team_invites").
		Select("team_invites.code AS code, team_invites.created_by AS created_by, users.email AS created_by_email, CASE WHEN team_invites.invite_box IS NULL THEN 0 ELSE 1 END AS has_box, team_invites.sealed_secret AS sealed_secret, team_invites.expires_at AS expires_at, team_invites.use_count AS use_count, team_invites.revoked_at AS revoked_at, team_invites.created_at AS created_at").
		Joins("LEFT JOIN users ON users.id = team_invites.created_by").
		Where("team_invites.team_id = ?", teamID).
		Order("team_invites.created_at DESC, team_invites.code ASC").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	invites := make([]TeamInvite, 0, len(rows))
	for _, row := range rows {
		invite := TeamInvite{
			Code:      row.Code,
			CreatedBy: row.CreatedBy,
			ExpiresAt: row.ExpiresAt.UTC(),
			UseCount:  row.UseCount,
			RevokedAt: utcTimePointer(row.RevokedAt),
			CreatedAt: row.CreatedAt.UTC(),
			Active:    row.HasBox == 1 && row.RevokedAt == nil && row.ExpiresAt.After(now),
		}
		if row.CreatedByEmail != nil {
			invite.CreatedByEmail = *row.CreatedByEmail
		}
		// 기한이 막 지나 정리 전인 링크의 것도 내주지 않는다.
		if invite.Active && row.SealedSecret != nil {
			invite.SealedSecret = *row.SealedSecret
		}
		invites = append(invites, invite)
	}
	return invites, nil
}

func (s *GormStore) RevokeTeamInvite(ctx context.Context, teamID string, actorID string, code string) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if _, err := s.lockTeamRowTx(tx, teamID); err != nil {
			return err
		}
		// 취소는 멤버 누구나 한다 — 멤버는 믿는 사이다.
		if _, err := getTeamMemberTx(tx, teamID, actorID); err != nil {
			return err
		}
		var invite teamInviteRow
		if err := tx.Where("code = ? AND team_id = ?", code, teamID).Take(&invite).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrTeamInviteInvalid
			}
			return err
		}
		if invite.RevokedAt != nil {
			return nil
		}
		if err := tx.Model(&teamInviteRow{}).
			Where("code = ?", code).
			Updates(map[string]any{"invite_box": nil, "sealed_secret": nil, "revoked_at": time.Now().UTC()}).Error; err != nil {
			return err
		}
		return bumpTeamInfoRevisionTx(tx, teamID, nil)
	})
}

// liveInvite 는 아직 쓸 수 있는 링크인지다 — 상자가 있고, 취소되지 않았고, 기한 안이다.
func liveInvite(invite teamInviteRow, now time.Time) bool {
	return invite.InviteBox != nil && *invite.InviteBox != "" && invite.RevokedAt == nil && invite.ExpiresAt.After(now)
}

// usableInvite 는 링크로 지금 들어올 수 있는지 본다. 이유는 밖에 알리지 않는다(ErrTeamInviteInvalid 하나).
// 토큰 대조는 상수 시간이다.
func usableInvite(invite teamInviteRow, joinToken string, now time.Time) bool {
	if !liveInvite(invite, now) {
		return false
	}
	if joinToken == "" {
		return false
	}
	presented := HashTeamJoinToken(joinToken)
	return subtle.ConstantTimeCompare([]byte(presented), []byte(invite.JoinTokenHash)) == 1
}

func (s *GormStore) GetTeamInviteInfo(ctx context.Context, code string, joinToken string) (TeamInviteInfo, error) {
	db := s.db.WithContext(ctx)
	var invite teamInviteRow
	if err := db.Where("code = ?", code).Take(&invite).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return TeamInviteInfo{}, ErrTeamInviteInvalid
		}
		return TeamInviteInfo{}, err
	}
	if !usableInvite(invite, joinToken, time.Now().UTC()) {
		return TeamInviteInfo{}, ErrTeamInviteInvalid
	}
	var team teamRow
	if err := db.Select("id", "name").Where("id = ?", invite.TeamID).Take(&team).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return TeamInviteInfo{}, ErrTeamInviteInvalid
		}
		return TeamInviteInfo{}, err
	}
	counts, err := countTeamMembers(db, []string{team.ID})
	if err != nil {
		return TeamInviteInfo{}, err
	}
	info := TeamInviteInfo{
		TeamID:      team.ID,
		TeamName:    team.Name,
		MemberCount: counts[team.ID],
		ExpiresAt:   invite.ExpiresAt.UTC(),
	}
	var inviter userRow
	if err := db.Select("email").Where("id = ?", invite.CreatedBy).Take(&inviter).Error; err == nil {
		info.InviterEmail = inviter.Email
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return TeamInviteInfo{}, err
	}
	return info, nil
}

// GetTeamInvitePage 는 링크 페이지(로그인 없이 열린다)에 보일 팀 이름을 준다. 토큰을 받지 않으므로 팀 이름
// 말고는 아무것도 주지 않는다(설계 — 번호를 아는 사람은 팀 이름까지만 본다). 기한이 지났거나 취소됐거나 없는
// 링크면 ErrTeamInviteInvalid 다 — 페이지는 이름 없이 만료 안내만 보인다.
func (s *GormStore) GetTeamInvitePage(ctx context.Context, code string) (TeamInvitePage, error) {
	db := s.db.WithContext(ctx)
	var invite teamInviteRow
	if err := db.Where("code = ?", code).Take(&invite).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return TeamInvitePage{}, ErrTeamInviteInvalid
		}
		return TeamInvitePage{}, err
	}
	if !liveInvite(invite, time.Now().UTC()) {
		return TeamInvitePage{}, ErrTeamInviteInvalid
	}
	var team teamRow
	if err := db.Select("id", "name").Where("id = ?", invite.TeamID).Take(&team).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return TeamInvitePage{}, ErrTeamInviteInvalid
		}
		return TeamInvitePage{}, err
	}
	return TeamInvitePage{TeamName: team.Name}, nil
}

func (s *GormStore) JoinTeam(ctx context.Context, code string, joinToken string, userID string) (TeamJoinResult, error) {
	var result TeamJoinResult
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.requireTeamVaultTx(tx, userID, nil); err != nil {
			return err
		}
		var invite teamInviteRow
		if err := tx.Where("code = ?", code).Take(&invite).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrTeamInviteInvalid
			}
			return err
		}
		team, err := s.lockTeamRowTx(tx, invite.TeamID)
		if err != nil {
			if errors.Is(err, ErrTeamNotFound) {
				return ErrTeamInviteInvalid
			}
			return err
		}
		// 팀을 잠근 뒤 잠금 읽기로 다시 읽는다 — 앞의 읽기와 잠금 사이에 취소·제거(링크를 모두 지운다)가
		// 커밋됐을 수 있다. 앞의 읽기를 잠금 읽기로 하면 안 된다: 링크 행을 먼저 잡고 팀 행을 기다리게 돼,
		// 팀 행을 잡고 링크를 지우는 제거와 서로 반대 순서가 된다(교착).
		if err := s.forUpdate(tx).Where("code = ?", code).Take(&invite).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrTeamInviteInvalid
			}
			return err
		}
		now := time.Now().UTC()
		if !usableInvite(invite, joinToken, now) {
			return ErrTeamInviteInvalid
		}
		result = TeamJoinResult{TeamID: team.ID, TeamName: team.Name, InviteBox: *invite.InviteBox}
		existing, err := s.lockTeamMemberTx(tx, team.ID, userID)
		if err == nil {
			if existing.WrappedTeamDek != nil && *existing.WrappedTeamDek != "" {
				return ErrTeamAlreadyMember
			}
			// 참여 직후 사본을 올리기 전에 끊긴 경우다 — 상자만 다시 준다.
			result.Rejoined = true
			return nil
		}
		if !errors.Is(err, ErrTeamNotFound) {
			return err
		}
		joinedVia := invite.Code
		member := teamMemberRow{
			TeamID:    team.ID,
			UserID:    userID,
			Role:      TeamRoleMember,
			JoinedVia: &joinedVia,
			AddedBy:   invite.CreatedBy,
			AddedAt:   now,
		}
		if err := tx.Create(&member).Error; err != nil {
			return err
		}
		if err := tx.Model(&teamInviteRow{}).
			Where("code = ?", invite.Code).
			Update("use_count", gorm.Expr("use_count + 1")).Error; err != nil {
			return err
		}
		// 링크로 들어온 사람은 반드시 팀 기록에 남는다 — 누구의 링크로 들어왔는지까지.
		if err := s.appendServerTeamEventTx(tx, team.ID, userID, teamServerEvent{
			Type: teamEventMemberJoined, UserID: userID, ByUserID: invite.CreatedBy,
		}, now); err != nil {
			return err
		}
		return bumpTeamInfoRevisionTx(tx, team.ID, nil)
	})
	if err != nil {
		return TeamJoinResult{}, err
	}
	s.sweepExpiredTeamInviteBoxes()
	return result, nil
}

func (s *GormStore) GetTeamGate(ctx context.Context, teamID string, userID string) (TeamGate, error) {
	type gateRow struct {
		Role            string
		DataFloor       int
		Revision        int64
		InfoRevision    int64
		PrivateRevision int64
	}
	var rows []gateRow
	if err := s.db.WithContext(ctx).
		Table("team_members").
		Select("team_members.role AS role, teams.data_floor AS data_floor, teams.revision AS revision, teams.info_revision AS info_revision, team_members.private_revision AS private_revision").
		Joins("JOIN teams ON teams.id = team_members.team_id").
		Where("team_members.team_id = ? AND team_members.user_id = ?", teamID, userID).
		Limit(1).
		Scan(&rows).Error; err != nil {
		return TeamGate{}, err
	}
	if len(rows) == 0 {
		return TeamGate{}, nil
	}
	row := rows[0]
	return TeamGate{
		Member:          true,
		Role:            row.Role,
		DataFloor:       row.DataFloor,
		Revision:        row.Revision,
		InfoRevision:    row.InfoRevision,
		PrivateRevision: row.PrivateRevision,
	}, nil
}

// readTeamTx 는 스냅숏을 읽는 트랜잭션을 연다. 개인 GetSyncSnapshot 과 같이, 리비전과 레코드를 한
// 시점에서 읽어 ETag 와 데이터가 어긋나지 않게 한다.
func (s *GormStore) readTeamTx(ctx context.Context, read func(tx *gorm.DB) error) error {
	if s.driver == "sqlite" {
		return s.db.WithContext(ctx).Transaction(read)
	}
	return s.db.WithContext(ctx).Transaction(read, &sql.TxOptions{
		Isolation: sql.LevelRepeatableRead,
		ReadOnly:  true,
	})
}

func (s *GormStore) GetTeamSyncSnapshot(ctx context.Context, teamID string, userID string) (int64, syncmodel.Payload, error) {
	var revision int64
	payload := make(syncmodel.Payload)
	err := s.readTeamTx(ctx, func(tx *gorm.DB) error {
		if _, err := getTeamMemberTx(tx, teamID, userID); err != nil {
			return err
		}
		var team teamRow
		if err := tx.Select("revision").Where("id = ?", teamID).Take(&team).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrTeamNotFound
			}
			return err
		}
		revision = team.Revision
		var rows []teamSyncRecordRow
		if err := tx.Where("team_id = ?", teamID).Order("updated_at DESC").Find(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			kind := syncmodel.Kind(row.Kind)
			payload[kind] = append(payload[kind], toSyncRecord(syncRecordRow{
				ID:               row.ID,
				EncryptedPayload: row.EncryptedPayload,
				UpdatedAt:        row.UpdatedAt,
				DeletedAt:        row.DeletedAt,
			}))
		}
		return nil
	})
	if err != nil {
		return 0, nil, err
	}
	return revision, payload, nil
}

// ApplyTeamPushRecords 는 팀 레코드를 개인 push 와 같은 규칙(레코드 단위로 나중에 쓴 쪽, 같은 내용의
// 재-push 는 변경 아님)으로 반영하고 팀 리비전을 돌려준다. 덮어쓰거나 지우기 직전의 판은 이전 판
// 표로 옮긴다 — 개인 쪽은 지우면 빈 암호문으로 덮여 내용이 사라지지만, 팀은 소유자가 되돌릴 수 있어야
// 한다.
func (s *GormStore) ApplyTeamPushRecords(ctx context.Context, teamID string, userID string, payload syncmodel.Payload) (int64, error) {
	if err := payload.Validate(); err != nil {
		return 0, fmt.Errorf("%w: %v", ErrBadSyncRecord, err)
	}
	kinds := payload.Kinds()
	now := time.Now().UTC()
	var revision int64
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		team, err := s.lockTeamRowTx(tx, teamID)
		if err != nil {
			return err
		}
		if _, err := getTeamMemberTx(tx, teamID, userID); err != nil {
			return err
		}
		total := 0
		for _, kind := range kinds {
			written, err := upsertTeamRecordsTx(tx, teamID, userID, kind, payload[kind], now)
			if err != nil {
				return err
			}
			total += written
		}
		if total == 0 {
			revision = team.Revision
			return nil
		}
		if err := tx.Model(&teamRow{}).Where("id = ?", teamID).
			Update("revision", gorm.Expr("revision + 1")).Error; err != nil {
			return err
		}
		var updated teamRow
		if err := tx.Select("revision").Where("id = ?", teamID).Take(&updated).Error; err != nil {
			return err
		}
		revision = updated.Revision
		return nil
	})
	if err != nil {
		return 0, err
	}
	s.sweepTeamRecordHistory()
	return revision, nil
}

func upsertTeamRecordsTx(tx *gorm.DB, teamID string, userID string, kind syncmodel.Kind, records []syncmodel.Record, now time.Time) (int, error) {
	written := 0
	for _, record := range records {
		// 시각 해석은 개인 레코드와 같은 규칙을 쓴다.
		parsed, err := toSyncRecordRow("", kind, record)
		if err != nil {
			return written, fmt.Errorf("%w: %v", ErrBadSyncRecord, err)
		}
		row := teamSyncRecordRow{
			TeamID:           teamID,
			Kind:             parsed.Kind,
			ID:               parsed.ID,
			EncryptedPayload: parsed.EncryptedPayload,
			UpdatedAt:        parsed.UpdatedAt,
			DeletedAt:        parsed.DeletedAt,
			UpdatedBy:        userID,
		}

		var current teamSyncRecordRow
		readErr := tx.Where("team_id = ? AND kind = ? AND id = ?", row.TeamID, row.Kind, row.ID).Take(&current).Error
		if readErr != nil && !errors.Is(readErr, gorm.ErrRecordNotFound) {
			return written, readErr
		}
		if readErr == nil {
			if current.UpdatedAt.After(row.UpdatedAt) {
				continue
			}
			if current.UpdatedAt.Equal(row.UpdatedAt) &&
				current.EncryptedPayload == row.EncryptedPayload &&
				equalTimePointers(current.DeletedAt, row.DeletedAt) {
				continue
			}
			// 내용이 있는 판만 남긴다 — 지운 표시(빈 암호문)는 되돌릴 내용이 없다.
			if current.EncryptedPayload != "" {
				history := teamRecordHistoryRow{
					TeamID:           current.TeamID,
					Kind:             current.Kind,
					RecordID:         current.ID,
					EncryptedPayload: current.EncryptedPayload,
					UpdatedAt:        current.UpdatedAt,
					DeletedAt:        current.DeletedAt,
					UpdatedBy:        current.UpdatedBy,
					ChangedBy:        userID,
					ChangedAt:        now,
				}
				if err := tx.Create(&history).Error; err != nil {
					return written, err
				}
			}
		}

		if err := tx.
			Clauses(clause.OnConflict{
				Columns: []clause.Column{
					{Name: "team_id"},
					{Name: "kind"},
					{Name: "id"},
				},
				DoUpdates: clause.AssignmentColumns([]string{
					"encrypted_payload",
					"updated_at",
					"deleted_at",
					"updated_by",
				}),
			}).
			Create(&row).Error; err != nil {
			return written, err
		}
		written++
	}
	return written, nil
}

// RaiseTeamDataFloor 는 팀 수준을 올리기만 한다(RaiseSyncDataFloor 와 같은 이유로 내리는 길이 없다).
func (s *GormStore) RaiseTeamDataFloor(ctx context.Context, teamID string, floor int) error {
	if floor <= 0 {
		return nil
	}
	return s.db.WithContext(ctx).Model(&teamRow{}).
		Where("id = ? AND data_floor < ?", teamID, floor).
		Update("data_floor", floor).Error
}

func (s *GormStore) GetTeamPrivateSnapshot(ctx context.Context, teamID string, userID string) (int64, syncmodel.Payload, error) {
	var revision int64
	payload := make(syncmodel.Payload)
	err := s.readTeamTx(ctx, func(tx *gorm.DB) error {
		member, err := getTeamMemberTx(tx, teamID, userID)
		if err != nil {
			return err
		}
		revision = member.PrivateRevision
		var rows []teamMemberPrivateRow
		if err := tx.Where("team_id = ? AND user_id = ?", teamID, userID).Order("updated_at DESC").Find(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			kind := syncmodel.Kind(row.Kind)
			payload[kind] = append(payload[kind], toSyncRecord(syncRecordRow{
				ID:               row.ID,
				EncryptedPayload: row.EncryptedPayload,
				UpdatedAt:        row.UpdatedAt,
				DeletedAt:        row.DeletedAt,
			}))
		}
		return nil
	})
	if err != nil {
		return 0, nil, err
	}
	return revision, payload, nil
}

// ApplyTeamPrivateRecords 는 그 멤버의 개인 칸에 레코드를 반영하고 개인 칸 리비전을 돌려준다. 개인
// DEK 로 잠근 것이라 볼트 세대 펜스를 건다. 팀 행도 잠가 제거와 직렬화한다 — 빠진 멤버의 개인 칸이
// 그 틈에 되살아나지 않게.
func (s *GormStore) ApplyTeamPrivateRecords(ctx context.Context, teamID string, userID string, payload syncmodel.Payload, vaultEpoch int64) (int64, error) {
	if err := payload.Validate(); err != nil {
		return 0, fmt.Errorf("%w: %v", ErrBadSyncRecord, err)
	}
	kinds := payload.Kinds()
	var revision int64
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.requireTeamVaultTx(tx, userID, &vaultEpoch); err != nil {
			return err
		}
		if _, err := s.lockTeamRowTx(tx, teamID); err != nil {
			return err
		}
		member, err := s.lockTeamMemberTx(tx, teamID, userID)
		if err != nil {
			return err
		}
		total := 0
		for _, kind := range kinds {
			written, err := upsertTeamPrivateRecordsTx(s.forUpdate(tx), tx, teamID, userID, kind, payload[kind])
			if err != nil {
				return err
			}
			total += written
		}
		if total == 0 {
			revision = member.PrivateRevision
			return nil
		}
		if err := tx.Model(&teamMemberRow{}).
			Where("team_id = ? AND user_id = ?", teamID, userID).
			Update("private_revision", gorm.Expr("private_revision + 1")).Error; err != nil {
			return err
		}
		updated, err := getTeamMemberTx(tx, teamID, userID)
		if err != nil {
			return err
		}
		revision = updated.PrivateRevision
		return nil
	})
	if err != nil {
		return 0, err
	}
	return revision, nil
}

// reader 는 지금 행을 보는 읽기(쓰기 트랜잭션에서는 잠금 읽기), tx 는 쓰기다.
func upsertTeamPrivateRecordsTx(reader *gorm.DB, tx *gorm.DB, teamID string, userID string, kind syncmodel.Kind, records []syncmodel.Record) (int, error) {
	written := 0
	for _, record := range records {
		parsed, err := toSyncRecordRow("", kind, record)
		if err != nil {
			return written, fmt.Errorf("%w: %v", ErrBadSyncRecord, err)
		}
		row := teamMemberPrivateRow{
			TeamID:           teamID,
			UserID:           userID,
			Kind:             parsed.Kind,
			ID:               parsed.ID,
			EncryptedPayload: parsed.EncryptedPayload,
			UpdatedAt:        parsed.UpdatedAt,
			DeletedAt:        parsed.DeletedAt,
		}
		var current teamMemberPrivateRow
		readErr := reader.Where("team_id = ? AND user_id = ? AND kind = ? AND id = ?", teamID, userID, row.Kind, row.ID).Take(&current).Error
		if readErr != nil && !errors.Is(readErr, gorm.ErrRecordNotFound) {
			return written, readErr
		}
		if readErr == nil {
			if current.UpdatedAt.After(row.UpdatedAt) {
				continue
			}
			if current.UpdatedAt.Equal(row.UpdatedAt) &&
				current.EncryptedPayload == row.EncryptedPayload &&
				equalTimePointers(current.DeletedAt, row.DeletedAt) {
				continue
			}
		}
		if err := tx.
			Clauses(clause.OnConflict{
				Columns: []clause.Column{
					{Name: "team_id"},
					{Name: "user_id"},
					{Name: "kind"},
					{Name: "id"},
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

// teamWatchBatchSize 는 GetTeamWatchRevisions 가 IN 목록 하나에 담는 팀 수다(syncRevisionBatchSize 와 같은 이유).
const teamWatchBatchSize = 500

func (s *GormStore) GetTeamWatchRevisions(ctx context.Context, teamIDs []string) (map[TeamWatchKey]int64, error) {
	values := make(map[TeamWatchKey]int64)
	type watchRow struct {
		TeamID          string
		UserID          string
		Revision        int64
		InfoRevision    int64
		PrivateRevision int64
	}
	for start := 0; start < len(teamIDs); start += teamWatchBatchSize {
		end := min(start+teamWatchBatchSize, len(teamIDs))
		var rows []watchRow
		if err := s.db.WithContext(ctx).
			Table("team_members").
			Select("team_members.team_id AS team_id, team_members.user_id AS user_id, teams.revision AS revision, teams.info_revision AS info_revision, team_members.private_revision AS private_revision").
			Joins("JOIN teams ON teams.id = team_members.team_id").
			Where("team_members.team_id IN ?", teamIDs[start:end]).
			Scan(&rows).Error; err != nil {
			return nil, err
		}
		for _, row := range rows {
			gate := TeamGate{Revision: row.Revision, InfoRevision: row.InfoRevision, PrivateRevision: row.PrivateRevision}
			values[TeamWatchKey{TeamID: row.TeamID, UserID: row.UserID}] = gate.WatchValue()
		}
	}
	return values, nil
}

func (s *GormStore) TouchSyncRevisions(ctx context.Context, userIDs []string) error {
	var firstErr error
	for _, userID := range userIDs {
		if userID == "" {
			continue
		}
		if err := s.db.WithContext(ctx).Model(&userRow{}).
			Where("id = ?", userID).
			Update("sync_revision", gorm.Expr("sync_revision + 1")).Error; err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// sweepExpiredTeamInviteBoxes 는 기한이 지난 링크의 상자와 잠근 비밀값을 지운다(행은 목록용으로
// 남긴다). 쓰기 경로에 얹어 간격을 두고 돈다 — sweepExpired 와 같은 방식이다.
func (s *GormStore) sweepExpiredTeamInviteBoxes() {
	now := time.Now().UTC()
	table := teamInviteRow{}.TableName()
	if !s.shouldSweepExpired(table, now) {
		return
	}
	var codes []string
	if err := s.db.Model(&teamInviteRow{}).
		Where("(invite_box IS NOT NULL OR sealed_secret IS NOT NULL) AND expires_at < ?", now).
		Limit(expiredRowSweepBatch).
		Pluck("code", &codes).Error; err != nil {
		log.Printf("store: 지난 초대 상자 조회 실패: %v", err)
		return
	}
	if len(codes) == 0 {
		return
	}
	if err := s.db.Model(&teamInviteRow{}).
		Where("code IN ?", codes).
		Updates(map[string]any{"invite_box": nil, "sealed_secret": nil}).Error; err != nil {
		log.Printf("store: 지난 초대 상자 정리 실패: %v", err)
		return
	}
	if len(codes) >= expiredRowSweepBatch {
		s.allowImmediateSweep(table)
	}
}

// sweepTeamRecordHistory 는 보존 기간이 지난 이전 판을 지운다. 팀 push 뒤에 간격을 두고 돈다.
func (s *GormStore) sweepTeamRecordHistory() {
	now := time.Now().UTC()
	table := teamRecordHistoryRow{}.TableName()
	if !s.shouldSweepExpired(table, now) {
		return
	}
	cutoff := now.Add(-s.teamHistoryRetentionValue())
	var seqs []int64
	if err := s.db.Model(&teamRecordHistoryRow{}).
		Where("changed_at < ?", cutoff).
		Limit(expiredRowSweepBatch).
		Pluck("seq", &seqs).Error; err != nil {
		log.Printf("store: 지난 이전 판 조회 실패: %v", err)
		return
	}
	if len(seqs) == 0 {
		return
	}
	if err := s.db.Where("seq IN ?", seqs).Delete(&teamRecordHistoryRow{}).Error; err != nil {
		log.Printf("store: 지난 이전 판 정리 실패: %v", err)
		return
	}
	if len(seqs) >= expiredRowSweepBatch {
		s.allowImmediateSweep(table)
	}
}
