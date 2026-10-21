package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// 팀 기록·녹화. 기록은 덧붙이기만 하고(고치거나 지우는 길이 없다), 쓴 사람은 서버가 로그인한 계정으로
// 붙인다. 앱이 쓴 기록과 녹화는 팀 키로 잠근 암호문이라 서버는 내용을 모른다. 서버가 쓰는 멤버 변화만
// 평문이다 — 서버가 원래 아는 것이다.
//
// 녹화는 세션 동안 구간마다 올라온다(앱이 로컬 녹화의 구간을 그대로 잠가 보낸다). 한도(개수·용량·한 개
// 최대)는 팀 행을 잠근 트랜잭션에서 팀 합계(teams.replay_count·replay_bytes)로 본다. 넘으면 끝났거나
// 끊긴 녹화를 오래된 것부터 "지워짐"으로 돌려 자리를 만들고, 그 구간 행은 정리 작업이 나눠 지운다.
//
// 녹화·기록 쓰기는 팀 행 잠금을 트랜잭션의 첫 문장으로 잡는다. 그 앞에 평범한 읽기가 없으니, 잠금을 잡은
// 뒤의 평범한 읽기는 잠금을 기다리는 동안 커밋된 것까지 본다(forUpdate 주석의 함정은 잠금 전에 평범한
// 읽기를 한 길에서 생긴다). 범위를 잠그는 읽기는 쓰지 않는다 — MySQL 의 틈 잠금이 다른 팀의 쓰기와 엉킨다.

var (
	// ErrTeamReplayNotFound 는 그 팀에 그 녹화가 없는 경우다.
	ErrTeamReplayNotFound = errors.New("team replay not found")
	// ErrTeamReplayDeleted 는 한도로 지워졌거나 팀이 지워져 녹화가 없어진 경우다.
	ErrTeamReplayDeleted = errors.New("team replay deleted")
	// ErrTeamReplayAuthorOnly 는 녹화한 사람이 아닌 멤버가 그 녹화에 올리려는 경우다.
	ErrTeamReplayAuthorOnly = errors.New("team replay author only")
	// ErrTeamReplayClosed 는 끝난 녹화에 구간을 더 올리려는 경우다.
	ErrTeamReplayClosed = errors.New("team replay closed")
	// ErrTeamReplayTooLarge 는 녹화 하나가 한 개 최대를 넘게 되는 경우다. 구간이 넘기면 그 녹화는 잘린다 —
	// 앞부분은 남고 뒤는 받지 않는다.
	ErrTeamReplayTooLarge = errors.New("team replay too large")
	// ErrTeamReplayQuotaBusy 는 진행 중인 녹화만으로 팀 한도가 차서 자리를 만들 수 없는 경우다. 앱은 그
	// 구간을 들고 있다가 나중에 다시 보낸다.
	ErrTeamReplayQuotaBusy = errors.New("team replay quota busy")
	// ErrTeamReplayIncomplete 는 빠진 구간이 있는데 끝을 알리는 경우다.
	ErrTeamReplayIncomplete = errors.New("team replay incomplete")
)

const (
	// TeamEventSourceApp 은 앱이 올린 활동이다(팀 키로 잠근 암호문).
	TeamEventSourceApp = "app"
	// TeamEventSourceServer 는 서버가 남긴 멤버 변화다(평문 JSON).
	TeamEventSourceServer = "server"
)

// 녹화 상태.
const (
	// TeamReplayLive 는 구간을 받고 있는 녹화다. 멤버는 지금까지 올라온 만큼 볼 수 있다.
	TeamReplayLive = "live"
	// TeamReplayEnded 는 앱이 끝을 알린 녹화다.
	TeamReplayEnded = "ended"
	// TeamReplayCut 는 끝을 알리지 못하고 끊긴 녹화다 — 앱이 비정상 종료를 알렸거나, 오래 새 구간이 없었다.
	TeamReplayCut = "cut"
	// TeamReplayTruncated 는 한 개 최대를 넘어 앞부분만 남은 녹화다.
	TeamReplayTruncated = "truncated"
	// TeamReplayDeleted 는 한도로 지워졌거나 팀이 지워진 녹화다. 행은 꺼진 Replay 의 이유를 말하려고 남긴다.
	TeamReplayDeleted = "deleted"
)

// rotatableTeamReplayStates 는 자리가 모자랄 때 지울 수 있는 녹화다 — 더 받지 않는 것들이다.
var rotatableTeamReplayStates = []string{TeamReplayEnded, TeamReplayCut, TeamReplayTruncated}

const (
	// teamReplayStaleAfter 는 진행 중인 녹화를 끊긴 것으로 보는, 새 구간이 없던 시간이다.
	teamReplayStaleAfter = 24 * time.Hour
	// teamReplaySweepKey 는 녹화 정리의 간격을 세는 이름이다(shouldSweepExpired).
	teamReplaySweepKey = "team_replays"
	// teamReplayPurgeRowsPerSweep 는 정리 한 번에 지우는 구간·덧붙임 행의 상한이다. 큰 팀을 지운 직후에도
	// 정리를 부른 요청이 오래 걸리지 않게 하고, 남으면 다음 쓰기가 잇는다.
	teamReplayPurgeRowsPerSweep = 5000
	// teamReplayPurgeBatch 는 DELETE 한 번에 지우는 행 수다.
	teamReplayPurgeBatch = 500
	// teamReplayTombstonesPerSlot 은 "지워짐" 행을 녹화 한도의 몇 배까지 남길지다. 지운 녹화는 행만 남아
	// 작지만, 오래 쓰는 팀에서 끝없이 늘지 않게 오래된 것부터 버린다.
	teamReplayTombstonesPerSlot = 10
	// teamEventPruneBatch 는 기록을 쓰는 트랜잭션 하나가 한도 밖의 기록을 지우는 최대 줄 수다 — 한도를 크게
	// 줄인 직후에도 그 요청이 오래 걸리지 않게(다음 쓰기가 이어서 지운다).
	teamEventPruneBatch = 1000
)

// TeamHistoryLimits 는 팀 기록·녹화 한도다(설정 teams 구획). 0 이하인 값은 기본값을 쓴다.
type TeamHistoryLimits struct {
	ReplayMaxCount             int64
	ReplayMaxBytes             int64
	ReplayMaxBytesPerRecording int64
	EventMaxCount              int64
}

var defaultTeamHistoryLimits = TeamHistoryLimits{
	ReplayMaxCount:             1000,
	ReplayMaxBytes:             2048 << 20,
	ReplayMaxBytesPerRecording: 200 << 20,
	EventMaxCount:              100000,
}

// teamEventRow 는 팀 기록 한 줄이다. seq 는 서버가 팀마다 매기는 순번이다(teams.event_seq).
type teamEventRow struct {
	TeamID string `gorm:"column:team_id;primaryKey;type:varchar(191);uniqueIndex:idx_team_events_event_id,priority:1"`
	Seq    int64  `gorm:"column:seq;primaryKey;autoIncrement:false"`
	// event_id 는 앱이 매긴 ID 다(서버 기록은 서버가 매긴다). 응답을 못 받아 다시 올려도 한 줄만 남는다.
	EventID      string `gorm:"column:event_id;not null;type:varchar(64);uniqueIndex:idx_team_events_event_id,priority:2"`
	AuthorUserID string `gorm:"column:author_user_id;not null;type:varchar(191)"`
	// author_email 은 그때의 이메일이다 — 그 사람이 나가거나 계정을 지워도 누가 했는지 남는다.
	AuthorEmail string `gorm:"column:author_email;not null;type:varchar(255);default:''"`
	Source      string `gorm:"column:source;not null;type:varchar(16)"`
	// created_at 은 앱이 잰 시각(서버 기록은 서버 시각), received_at 은 서버가 받은 시각이다.
	CreatedAt  time.Time `gorm:"column:created_at;not null;autoCreateTime:false"`
	ReceivedAt time.Time `gorm:"column:received_at;not null"`
	Payload    string    `gorm:"column:payload;not null;type:text"`
}

func (teamEventRow) TableName() string {
	return "team_events"
}

// teamReplayRow 는 팀 녹화 하나다. 메타는 팀 키로 잠근 것이고, 나머지는 서버가 원래 아는 값이다.
type teamReplayRow struct {
	TeamID       string `gorm:"column:team_id;primaryKey;type:varchar(191);index:idx_team_replays_created,priority:1"`
	RecordingID  string `gorm:"column:recording_id;primaryKey;type:varchar(64)"`
	AuthorUserID string `gorm:"column:author_user_id;not null;type:varchar(191)"`
	AuthorEmail  string `gorm:"column:author_email;not null;type:varchar(255);default:''"`
	State        string `gorm:"column:state;not null;type:varchar(16);index:idx_team_replays_sweep,priority:1"`
	// start_meta 는 시작 때 아는 녹화 정보, end_meta 는 끝날 때 아는 것이다(둘 다 팀 키로 잠금). 지워지면 비운다.
	StartMeta string  `gorm:"column:start_meta;not null;type:text"`
	EndMeta   *string `gorm:"column:end_meta;type:text"`
	// segment_count 는 받은 구간 수, last_segment 는 받은 가장 큰 번호다(없으면 -1). 끝을 받을 때 빠진 구간이
	// 없는지 이 둘로 본다.
	SegmentCount int64 `gorm:"column:segment_count;not null;default:0"`
	LastSegment  int64 `gorm:"column:last_segment;not null;default:-1"`
	// total_bytes 는 구간과 덧붙임이 차지하는 양이다. 팀 합계와 한 개 최대에 센다.
	TotalBytes     int64      `gorm:"column:total_bytes;not null;default:0"`
	CreatedAt      time.Time  `gorm:"column:created_at;not null;autoCreateTime:false;index:idx_team_replays_created,priority:2"`
	LastActivityAt time.Time  `gorm:"column:last_activity_at;not null;index:idx_team_replays_sweep,priority:2"`
	EndedAt        *time.Time `gorm:"column:ended_at"`
	// purged 는 지워진 녹화의 구간·덧붙임 행을 정리 작업이 다 지웠는지다.
	Purged bool `gorm:"column:purged;not null;default:false"`
}

func (teamReplayRow) TableName() string {
	return "team_replays"
}

// teamReplaySegmentRow 는 녹화의 구간 하나다 — 로컬 녹화 파일의 gzip 덩어리를 팀 키로 잠근 바이트다.
type teamReplaySegmentRow struct {
	TeamID       string `gorm:"column:team_id;primaryKey;type:varchar(191)"`
	RecordingID  string `gorm:"column:recording_id;primaryKey;type:varchar(64)"`
	SegmentIndex int64  `gorm:"column:segment_index;primaryKey;autoIncrement:false"`
	// info 는 구간 정보(시각·항목 수·출력 양)를 잠근 것이다. 재생 창이 구간을 받기 전에 시간축을 그린다.
	Info      string    `gorm:"column:info;not null;type:text"`
	Data      []byte    `gorm:"column:data;not null"`
	Size      int64     `gorm:"column:size;not null"`
	CreatedAt time.Time `gorm:"column:created_at;not null;autoCreateTime:false"`
}

func (teamReplaySegmentRow) TableName() string {
	return "team_replay_segments"
}

// teamReplayExtraRow 는 녹화 덧붙임 하나다 — 구간별 명령 목록이나 스냅샷(재생 창이 녹화를 다 받지 않고
// 명령 목록을 보이고 멀리 건너뛰게 한다). 번호는 그 구간 번호다.
type teamReplayExtraRow struct {
	TeamID       string    `gorm:"column:team_id;primaryKey;type:varchar(191)"`
	RecordingID  string    `gorm:"column:recording_id;primaryKey;type:varchar(64)"`
	Kind         string    `gorm:"column:kind;primaryKey;type:varchar(16)"`
	SegmentIndex int64     `gorm:"column:segment_index;primaryKey;autoIncrement:false"`
	Data         []byte    `gorm:"column:data;not null"`
	Size         int64     `gorm:"column:size;not null"`
	CreatedAt    time.Time `gorm:"column:created_at;not null;autoCreateTime:false"`
}

func (teamReplayExtraRow) TableName() string {
	return "team_replay_extras"
}

// TeamEventInput 은 앱이 올리는 기록 한 줄이다.
type TeamEventInput struct {
	EventID   string
	CreatedAt time.Time
	Payload   string
}

// TeamEventQuery 는 기록 읽기다. After 를 주면 그 뒤를 오래된 것부터(이어 받기), 아니면 Before 앞을
// 최신부터 준다(Before 가 0 이면 맨 끝부터).
type TeamEventQuery struct {
	Before int64
	After  int64
	Limit  int
}

type TeamEvent struct {
	Seq          int64
	EventID      string
	AuthorUserID string
	AuthorEmail  string
	Source       string
	CreatedAt    time.Time
	ReceivedAt   time.Time
	Payload      string
}

type TeamReplay struct {
	RecordingID    string
	AuthorUserID   string
	AuthorEmail    string
	State          string
	SegmentCount   int64
	LastSegment    int64
	TotalBytes     int64
	CreatedAt      time.Time
	LastActivityAt time.Time
	EndedAt        *time.Time
}

type TeamReplaySegmentInfo struct {
	Index int64
	Info  string
	Size  int64
}

type TeamReplayExtraInfo struct {
	Kind  string
	Index int64
	Size  int64
}

// TeamReplayDetail 은 재생 창이 녹화를 열 때 받는 것이다 — 메타와, 구간·덧붙임의 목록(내용 없이).
type TeamReplayDetail struct {
	TeamReplay
	StartMeta string
	EndMeta   string
	Segments  []TeamReplaySegmentInfo
	Extras    []TeamReplayExtraInfo
}

type TeamReplayCompleteInput struct {
	EndMeta string
	// LastSegment 는 마지막 구간 번호다(구간이 없으면 -1). 서버가 받은 것과 맞아야 끝을 받는다.
	LastSegment int64
	// Cut 은 앱이 비정상 종료를 알리는 것이다(다음 실행 때 마저 보낸 녹화).
	Cut bool
}

// TeamReplayQuery 는 녹화 목록이다. RecordingIDs 를 주면 그 녹화들만(지워진 것까지) 준다 — 기록 화면이
// 보이는 줄의 녹화가 서버에 있는지 묻는다. 아니면 지워지지 않은 녹화를 최신부터, Before(녹화 ID) 앞부터 준다.
type TeamReplayQuery struct {
	Before       string
	Limit        int
	RecordingIDs []string
}

type TeamReplayBlob struct {
	Index int64
	Data  []byte
}

// TeamHistoryStore 는 팀 기록·녹화 저장 기능이다. Store 가 품는다.
type TeamHistoryStore interface {
	TeamHistoryLimits() TeamHistoryLimits
	AppendTeamEvents(ctx context.Context, teamID string, userID string, events []TeamEventInput) (int, error)
	ListTeamEvents(ctx context.Context, teamID string, userID string, query TeamEventQuery) ([]TeamEvent, error)
	StartTeamReplay(ctx context.Context, teamID string, userID string, recordingID string, startMeta string) (TeamReplay, error)
	PutTeamReplaySegment(ctx context.Context, teamID string, userID string, recordingID string, index int64, info string, data []byte) error
	PutTeamReplayExtra(ctx context.Context, teamID string, userID string, recordingID string, kind string, index int64, data []byte) error
	CompleteTeamReplay(ctx context.Context, teamID string, userID string, recordingID string, input TeamReplayCompleteInput) error
	ListTeamReplays(ctx context.Context, teamID string, userID string, query TeamReplayQuery) ([]TeamReplay, error)
	GetTeamReplay(ctx context.Context, teamID string, userID string, recordingID string) (TeamReplayDetail, error)
	ReadTeamReplaySegments(ctx context.Context, teamID string, userID string, recordingID string, from int64, limit int, maxBytes int64) ([]TeamReplayBlob, error)
	ReadTeamReplayExtras(ctx context.Context, teamID string, userID string, recordingID string, kind string, from int64, limit int, maxBytes int64) ([]TeamReplayBlob, error)
}

// SetTeamHistoryLimits 는 팀 기록·녹화 한도다. 0 이하인 값은 기본값을 쓴다.
func (s *GormStore) SetTeamHistoryLimits(limits TeamHistoryLimits) {
	s.sweepMu.Lock()
	defer s.sweepMu.Unlock()
	s.teamHistoryLimits = limits
}

func (s *GormStore) TeamHistoryLimits() TeamHistoryLimits {
	s.sweepMu.Lock()
	limits := s.teamHistoryLimits
	s.sweepMu.Unlock()
	if limits.ReplayMaxCount <= 0 {
		limits.ReplayMaxCount = defaultTeamHistoryLimits.ReplayMaxCount
	}
	if limits.ReplayMaxBytes <= 0 {
		limits.ReplayMaxBytes = defaultTeamHistoryLimits.ReplayMaxBytes
	}
	if limits.ReplayMaxBytesPerRecording <= 0 {
		limits.ReplayMaxBytesPerRecording = defaultTeamHistoryLimits.ReplayMaxBytesPerRecording
	}
	if limits.EventMaxCount <= 0 {
		limits.EventMaxCount = defaultTeamHistoryLimits.EventMaxCount
	}
	return limits
}

// teamUserEmailsTx 는 사용자 ID 마다 지금 이메일을 읽는다. 없는 사용자는 빠진다.
func teamUserEmailsTx(tx *gorm.DB, userIDs ...string) (map[string]string, error) {
	ids := make([]string, 0, len(userIDs))
	seen := make(map[string]bool, len(userIDs))
	for _, id := range userIDs {
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	emails := make(map[string]string, len(ids))
	if len(ids) == 0 {
		return emails, nil
	}
	var rows []userRow
	if err := tx.Select("id", "email").Where("id IN ?", ids).Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, row := range rows {
		emails[row.ID] = row.Email
	}
	return emails, nil
}

// reserveTeamEventSeqsTx 는 팀 기록 순번을 count 개 잡고 첫 번호를 돌려준다. 호출자가 팀 행을 잠근 뒤
// 부른다. 같은 트랜잭션의 읽기는 방금 올린 값을 본다(격리 수준과 상관없이).
func reserveTeamEventSeqsTx(tx *gorm.DB, teamID string, count int) (int64, error) {
	if err := tx.Model(&teamRow{}).Where("id = ?", teamID).
		UpdateColumn("event_seq", gorm.Expr("event_seq + ?", count)).Error; err != nil {
		return 0, err
	}
	var last int64
	if err := tx.Model(&teamRow{}).Where("id = ?", teamID).Select("event_seq").Row().Scan(&last); err != nil {
		return 0, err
	}
	return last - int64(count) + 1, nil
}

// pruneTeamEventsTx 는 팀 기록이 한도를 넘으면 순번이 오래된 것부터 지운다. 순번은 빈틈 없이 오르므로
// lastSeq - maxCount 이하가 한도 밖이다. 한 번에 teamEventPruneBatch 줄까지만 지운다.
func pruneTeamEventsTx(tx *gorm.DB, teamID string, lastSeq int64, maxCount int64) error {
	cutoff := lastSeq - maxCount
	if cutoff <= 0 {
		return nil
	}
	var oldest sql.NullInt64
	if err := tx.Model(&teamEventRow{}).Where("team_id = ?", teamID).Select("MIN(seq)").Row().Scan(&oldest); err != nil {
		return err
	}
	if !oldest.Valid || oldest.Int64 > cutoff {
		return nil
	}
	upper := min(cutoff, oldest.Int64+teamEventPruneBatch-1)
	return tx.Where("team_id = ? AND seq >= ? AND seq <= ?", teamID, oldest.Int64, upper).Delete(&teamEventRow{}).Error
}

// teamServerEvent 는 서버가 남기는 멤버 변화다. 평문 JSON 으로 기록에 들어간다 — 서버가 원래 아는 것이고,
// 빠진 멤버가 다시 들어오지 않아도 남은 멤버가 읽을 수 있어야 한다. 이메일은 그때의 것을 적어 둔다.
type teamServerEvent struct {
	Version  int    `json:"v"`
	Type     string `json:"type"`
	UserID   string `json:"userId"`
	Email    string `json:"email,omitempty"`
	ByUserID string `json:"byUserId,omitempty"`
	ByEmail  string `json:"byEmail,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

const (
	teamServerEventVersion = 1

	teamEventMemberJoined  = "member_joined"
	teamEventMemberLeft    = "member_left"
	teamEventMemberRemoved = "member_removed"
	teamEventOwnerChanged  = "owner_changed"

	// 멤버가 스스로 나가지 않고 빠진 까닭(member_left)과, 소유자가 저절로 바뀐 까닭(owner_changed).
	teamEventReasonVaultReset     = "vault_reset"
	teamEventReasonAccountDeleted = "account_deleted"
	teamEventReasonSuccessor      = "successor"
)

// appendServerTeamEventTx 는 멤버 변화 한 줄을 남긴다. 그 변화를 만드는 트랜잭션 안에서, 팀 행을 잠근 뒤
// 부른다 — 변화가 커밋되지 않으면 기록도 남지 않는다.
func (s *GormStore) appendServerTeamEventTx(tx *gorm.DB, teamID string, actorID string, event teamServerEvent, now time.Time) error {
	emails, err := teamUserEmailsTx(tx, actorID, event.UserID, event.ByUserID)
	if err != nil {
		return err
	}
	event.Version = teamServerEventVersion
	event.Email = emails[event.UserID]
	if event.ByUserID != "" {
		event.ByEmail = emails[event.ByUserID]
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	seq, err := reserveTeamEventSeqsTx(tx, teamID, 1)
	if err != nil {
		return err
	}
	row := teamEventRow{
		TeamID:       teamID,
		Seq:          seq,
		EventID:      uuid.NewString(),
		AuthorUserID: actorID,
		AuthorEmail:  emails[actorID],
		Source:       TeamEventSourceServer,
		CreatedAt:    now,
		ReceivedAt:   now,
		Payload:      string(payload),
	}
	if err := tx.Create(&row).Error; err != nil {
		return err
	}
	return pruneTeamEventsTx(tx, teamID, seq, s.TeamHistoryLimits().EventMaxCount)
}

func (s *GormStore) AppendTeamEvents(ctx context.Context, teamID string, userID string, events []TeamEventInput) (int, error) {
	if len(events) == 0 {
		return 0, nil
	}
	now := time.Now().UTC()
	appended := 0
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if _, err := s.lockTeamRowTx(tx, teamID); err != nil {
			return err
		}
		if _, err := s.lockTeamMemberTx(tx, teamID, userID); err != nil {
			return err
		}
		ids := make([]string, 0, len(events))
		for _, event := range events {
			ids = append(ids, event.EventID)
		}
		var existing []string
		if err := tx.Model(&teamEventRow{}).
			Where("team_id = ? AND event_id IN ?", teamID, ids).
			Pluck("event_id", &existing).Error; err != nil {
			return err
		}
		seen := make(map[string]bool, len(existing)+len(events))
		for _, id := range existing {
			seen[id] = true
		}
		fresh := make([]TeamEventInput, 0, len(events))
		for _, event := range events {
			if seen[event.EventID] {
				continue
			}
			seen[event.EventID] = true
			fresh = append(fresh, event)
		}
		if len(fresh) == 0 {
			return nil
		}
		emails, err := teamUserEmailsTx(tx, userID)
		if err != nil {
			return err
		}
		first, err := reserveTeamEventSeqsTx(tx, teamID, len(fresh))
		if err != nil {
			return err
		}
		rows := make([]teamEventRow, 0, len(fresh))
		for index, event := range fresh {
			rows = append(rows, teamEventRow{
				TeamID:       teamID,
				Seq:          first + int64(index),
				EventID:      event.EventID,
				AuthorUserID: userID,
				AuthorEmail:  emails[userID],
				Source:       TeamEventSourceApp,
				CreatedAt:    event.CreatedAt.UTC(),
				ReceivedAt:   now,
				Payload:      event.Payload,
			})
		}
		if err := tx.Create(&rows).Error; err != nil {
			return err
		}
		appended = len(rows)
		return pruneTeamEventsTx(tx, teamID, first+int64(len(rows))-1, s.TeamHistoryLimits().EventMaxCount)
	})
	if err != nil {
		return 0, err
	}
	return appended, nil
}

func (s *GormStore) ListTeamEvents(ctx context.Context, teamID string, userID string, query TeamEventQuery) ([]TeamEvent, error) {
	db := s.db.WithContext(ctx)
	if _, err := getTeamMemberTx(db, teamID, userID); err != nil {
		return nil, err
	}
	limit := query.Limit
	if limit <= 0 {
		limit = 100
	}
	scope := db.Where("team_id = ?", teamID)
	if query.After > 0 {
		scope = scope.Where("seq > ?", query.After).Order("seq ASC")
	} else {
		if query.Before > 0 {
			scope = scope.Where("seq < ?", query.Before)
		}
		scope = scope.Order("seq DESC")
	}
	var rows []teamEventRow
	if err := scope.Limit(limit).Find(&rows).Error; err != nil {
		return nil, err
	}
	events := make([]TeamEvent, 0, len(rows))
	for _, row := range rows {
		events = append(events, TeamEvent{
			Seq:          row.Seq,
			EventID:      row.EventID,
			AuthorUserID: row.AuthorUserID,
			AuthorEmail:  row.AuthorEmail,
			Source:       row.Source,
			CreatedAt:    row.CreatedAt.UTC(),
			ReceivedAt:   row.ReceivedAt.UTC(),
			Payload:      row.Payload,
		})
	}
	return events, nil
}

func teamReplayFromRow(row teamReplayRow) TeamReplay {
	return TeamReplay{
		RecordingID:    row.RecordingID,
		AuthorUserID:   row.AuthorUserID,
		AuthorEmail:    row.AuthorEmail,
		State:          row.State,
		SegmentCount:   row.SegmentCount,
		LastSegment:    row.LastSegment,
		TotalBytes:     row.TotalBytes,
		CreatedAt:      row.CreatedAt.UTC(),
		LastActivityAt: row.LastActivityAt.UTC(),
		EndedAt:        utcTimePointer(row.EndedAt),
	}
}

func getTeamReplayTx(tx *gorm.DB, teamID string, recordingID string) (teamReplayRow, error) {
	var row teamReplayRow
	err := tx.Where("team_id = ? AND recording_id = ?", teamID, recordingID).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return teamReplayRow{}, ErrTeamReplayNotFound
	}
	return row, err
}

// lockTeamReplayForWriteTx 는 녹화에 쓰기 전에 팀 행을 잠그고 멤버·녹화·올린 사람을 본다.
func (s *GormStore) lockTeamReplayForWriteTx(tx *gorm.DB, teamID string, userID string, recordingID string) (teamRow, teamReplayRow, error) {
	team, err := s.lockTeamRowTx(tx, teamID)
	if err != nil {
		return teamRow{}, teamReplayRow{}, err
	}
	if _, err := s.lockTeamMemberTx(tx, teamID, userID); err != nil {
		return teamRow{}, teamReplayRow{}, err
	}
	replay, err := getTeamReplayTx(tx, teamID, recordingID)
	if err != nil {
		return teamRow{}, teamReplayRow{}, err
	}
	if replay.AuthorUserID != userID {
		return teamRow{}, teamReplayRow{}, ErrTeamReplayAuthorOnly
	}
	if replay.State == TeamReplayDeleted {
		return teamRow{}, teamReplayRow{}, ErrTeamReplayDeleted
	}
	return team, replay, nil
}

// rotateTeamReplaysTx 는 자리를 만들려고 끝났거나 끊긴 녹화를 오래된 것부터 "지워짐"으로 돌린다. keep 은
// 지금 쓰는 녹화라 고르지 않는다. 필요한 만큼 만들 수 없으면 아무것도 바꾸지 않고 ok=false 다. 지운 녹화의
// 구간 행은 정리 작업(sweepTeamReplays)이 지운다. 호출자가 팀 행을 잠근 뒤 부르고, 돌려받은 만큼 팀 합계를 줄인다.
func (s *GormStore) rotateTeamReplaysTx(tx *gorm.DB, teamID string, keep string, needCount int64, needBytes int64, now time.Time) (int64, int64, bool, error) {
	if needCount <= 0 && needBytes <= 0 {
		return 0, 0, true, nil
	}
	var candidates []teamReplayRow
	if err := tx.Select("recording_id", "total_bytes").
		Where("team_id = ? AND state IN ? AND recording_id <> ?", teamID, rotatableTeamReplayStates, keep).
		Order("created_at ASC, recording_id ASC").
		Find(&candidates).Error; err != nil {
		return 0, 0, false, err
	}
	var freedCount, freedBytes int64
	chosen := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if freedCount >= needCount && freedBytes >= needBytes {
			break
		}
		chosen = append(chosen, candidate.RecordingID)
		freedCount++
		freedBytes += candidate.TotalBytes
	}
	if freedCount < needCount || freedBytes < needBytes {
		return 0, 0, false, nil
	}
	if err := tx.Model(&teamReplayRow{}).
		Where("team_id = ? AND recording_id IN ?", teamID, chosen).
		UpdateColumns(map[string]any{
			"state":            TeamReplayDeleted,
			"start_meta":       "",
			"end_meta":         nil,
			"purged":           false,
			"last_activity_at": now,
		}).Error; err != nil {
		return 0, 0, false, err
	}
	if err := s.trimTeamReplayTombstonesTx(tx, teamID); err != nil {
		return 0, 0, false, err
	}
	return freedCount, freedBytes, true, nil
}

// trimTeamReplayTombstonesTx 는 그 팀의 "지워짐" 행이 녹화 한도의 몇 배를 넘으면 오래된 것부터 버린다.
// 구간을 다 지운(purged) 행만 버린다 — 아직 지울 구간이 남은 행은 정리 작업이 찾아야 한다.
func (s *GormStore) trimTeamReplayTombstonesTx(tx *gorm.DB, teamID string) error {
	keep := s.TeamHistoryLimits().ReplayMaxCount * teamReplayTombstonesPerSlot
	var total int64
	if err := tx.Model(&teamReplayRow{}).
		Where("team_id = ? AND state = ? AND purged = ?", teamID, TeamReplayDeleted, true).
		Count(&total).Error; err != nil {
		return err
	}
	excess := total - keep
	if excess <= 0 {
		return nil
	}
	var stale []string
	if err := tx.Model(&teamReplayRow{}).
		Where("team_id = ? AND state = ? AND purged = ?", teamID, TeamReplayDeleted, true).
		Order("created_at ASC, recording_id ASC").
		Limit(int(min(excess, expiredRowSweepBatch))).
		Pluck("recording_id", &stale).Error; err != nil {
		return err
	}
	if len(stale) == 0 {
		return nil
	}
	return tx.Where("team_id = ? AND recording_id IN ?", teamID, stale).Delete(&teamReplayRow{}).Error
}

// shrinkTeamReplayTotalsTx 는 팀 합계를 바꾼다(녹화 수 deltaCount, 용량 deltaBytes).
func shrinkTeamReplayTotalsTx(tx *gorm.DB, teamID string, deltaCount int64, deltaBytes int64) error {
	if deltaCount == 0 && deltaBytes == 0 {
		return nil
	}
	return tx.Model(&teamRow{}).Where("id = ?", teamID).UpdateColumns(map[string]any{
		"replay_count": gorm.Expr("replay_count + ?", deltaCount),
		"replay_bytes": gorm.Expr("replay_bytes + ?", deltaBytes),
	}).Error
}

func (s *GormStore) StartTeamReplay(ctx context.Context, teamID string, userID string, recordingID string, startMeta string) (TeamReplay, error) {
	// 오래 끊긴 진행 중 녹화를 먼저 "끊김"으로 돌려야 자리를 셀 때 지울 수 있는 녹화로 잡힌다.
	s.sweepTeamReplays()
	now := time.Now().UTC()
	var replay TeamReplay
	rotated := false
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		team, err := s.lockTeamRowTx(tx, teamID)
		if err != nil {
			return err
		}
		if _, err := s.lockTeamMemberTx(tx, teamID, userID); err != nil {
			return err
		}
		existing, err := getTeamReplayTx(tx, teamID, recordingID)
		if err == nil {
			// 같은 녹화를 다시 시작하면(응답을 못 받았거나, 앱을 다시 켰거나) 지금 상태를 그대로 준다.
			if existing.AuthorUserID != userID {
				return ErrTeamReplayAuthorOnly
			}
			if existing.State == TeamReplayDeleted {
				return ErrTeamReplayDeleted
			}
			replay = teamReplayFromRow(existing)
			return nil
		}
		if !errors.Is(err, ErrTeamReplayNotFound) {
			return err
		}
		limits := s.TeamHistoryLimits()
		freedCount, freedBytes, ok, err := s.rotateTeamReplaysTx(tx, teamID, recordingID, team.ReplayCount+1-limits.ReplayMaxCount, 0, now)
		if err != nil {
			return err
		}
		if !ok {
			return ErrTeamReplayQuotaBusy
		}
		rotated = freedCount > 0
		emails, err := teamUserEmailsTx(tx, userID)
		if err != nil {
			return err
		}
		row := teamReplayRow{
			TeamID:         teamID,
			RecordingID:    recordingID,
			AuthorUserID:   userID,
			AuthorEmail:    emails[userID],
			State:          TeamReplayLive,
			StartMeta:      startMeta,
			LastSegment:    -1,
			CreatedAt:      now,
			LastActivityAt: now,
		}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		if err := shrinkTeamReplayTotalsTx(tx, teamID, 1-freedCount, -freedBytes); err != nil {
			return err
		}
		replay = teamReplayFromRow(row)
		return nil
	})
	if err != nil {
		return TeamReplay{}, err
	}
	if rotated {
		s.sweepTeamReplaysNow()
	}
	return replay, nil
}

func (s *GormStore) PutTeamReplaySegment(ctx context.Context, teamID string, userID string, recordingID string, index int64, info string, data []byte) error {
	now := time.Now().UTC()
	size := int64(len(data) + len(info))
	truncated := false
	rotated := false
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		team, replay, err := s.lockTeamReplayForWriteTx(tx, teamID, userID, recordingID)
		if err != nil {
			return err
		}
		switch replay.State {
		case TeamReplayEnded:
			return ErrTeamReplayClosed
		case TeamReplayTruncated:
			return ErrTeamReplayTooLarge
		}
		var current teamReplaySegmentRow
		readErr := tx.Select("size").
			Where("team_id = ? AND recording_id = ? AND segment_index = ?", teamID, recordingID, index).
			Take(&current).Error
		exists := readErr == nil
		if readErr != nil && !errors.Is(readErr, gorm.ErrRecordNotFound) {
			return readErr
		}
		delta := size
		if exists {
			delta -= current.Size
		}
		limits := s.TeamHistoryLimits()
		if replay.TotalBytes+delta > limits.ReplayMaxBytesPerRecording {
			// 이 녹화는 여기서 잘린다 — 앞부분은 남고, 뒤는 그 사람 기기에만 있다.
			truncated = true
			return tx.Model(&teamReplayRow{}).
				Where("team_id = ? AND recording_id = ?", teamID, recordingID).
				UpdateColumns(map[string]any{"state": TeamReplayTruncated, "last_activity_at": now}).Error
		}
		freedCount, freedBytes, ok, err := s.rotateTeamReplaysTx(tx, teamID, recordingID, 0, team.ReplayBytes+delta-limits.ReplayMaxBytes, now)
		if err != nil {
			return err
		}
		if !ok {
			return ErrTeamReplayQuotaBusy
		}
		rotated = freedCount > 0
		segment := teamReplaySegmentRow{
			TeamID:       teamID,
			RecordingID:  recordingID,
			SegmentIndex: index,
			Info:         info,
			Data:         data,
			Size:         size,
			CreatedAt:    now,
		}
		if err := tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "team_id"}, {Name: "recording_id"}, {Name: "segment_index"}},
			DoUpdates: clause.AssignmentColumns([]string{"info", "data", "size", "created_at"}),
		}).Create(&segment).Error; err != nil {
			return err
		}
		added := int64(1)
		if exists {
			added = 0
		}
		if err := tx.Model(&teamReplayRow{}).
			Where("team_id = ? AND recording_id = ?", teamID, recordingID).
			UpdateColumns(map[string]any{
				"total_bytes":      gorm.Expr("total_bytes + ?", delta),
				"segment_count":    gorm.Expr("segment_count + ?", added),
				"last_segment":     gorm.Expr("CASE WHEN last_segment < ? THEN ? ELSE last_segment END", index, index),
				"last_activity_at": now,
				// 끊긴 것으로 돌렸던 녹화에 다시 구간이 오면(앱이 오래 오프라인이었다) 이어 받는다.
				"state":    TeamReplayLive,
				"ended_at": nil,
			}).Error; err != nil {
			return err
		}
		return shrinkTeamReplayTotalsTx(tx, teamID, -freedCount, delta-freedBytes)
	})
	if err != nil {
		return err
	}
	if rotated {
		s.sweepTeamReplaysNow()
	}
	if truncated {
		return ErrTeamReplayTooLarge
	}
	return nil
}

func (s *GormStore) PutTeamReplayExtra(ctx context.Context, teamID string, userID string, recordingID string, kind string, index int64, data []byte) error {
	now := time.Now().UTC()
	size := int64(len(data))
	rotated := false
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		team, replay, err := s.lockTeamReplayForWriteTx(tx, teamID, userID, recordingID)
		if err != nil {
			return err
		}
		var current teamReplayExtraRow
		readErr := tx.Select("size").
			Where("team_id = ? AND recording_id = ? AND kind = ? AND segment_index = ?", teamID, recordingID, kind, index).
			Take(&current).Error
		exists := readErr == nil
		if readErr != nil && !errors.Is(readErr, gorm.ErrRecordNotFound) {
			return readErr
		}
		delta := size
		if exists {
			delta -= current.Size
		}
		limits := s.TeamHistoryLimits()
		// 덧붙임은 녹화를 자르지 않는다 — 구간은 다 들어왔는데 덧붙임만 넘치면 그 덧붙임만 받지 않는다.
		if replay.TotalBytes+delta > limits.ReplayMaxBytesPerRecording {
			return ErrTeamReplayTooLarge
		}
		freedCount, freedBytes, ok, err := s.rotateTeamReplaysTx(tx, teamID, recordingID, 0, team.ReplayBytes+delta-limits.ReplayMaxBytes, now)
		if err != nil {
			return err
		}
		if !ok {
			return ErrTeamReplayQuotaBusy
		}
		rotated = freedCount > 0
		extra := teamReplayExtraRow{
			TeamID:       teamID,
			RecordingID:  recordingID,
			Kind:         kind,
			SegmentIndex: index,
			Data:         data,
			Size:         size,
			CreatedAt:    now,
		}
		if err := tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "team_id"}, {Name: "recording_id"}, {Name: "kind"}, {Name: "segment_index"}},
			DoUpdates: clause.AssignmentColumns([]string{"data", "size", "created_at"}),
		}).Create(&extra).Error; err != nil {
			return err
		}
		updates := map[string]any{"total_bytes": gorm.Expr("total_bytes + ?", delta)}
		if replay.State == TeamReplayLive {
			updates["last_activity_at"] = now
		}
		if err := tx.Model(&teamReplayRow{}).
			Where("team_id = ? AND recording_id = ?", teamID, recordingID).
			UpdateColumns(updates).Error; err != nil {
			return err
		}
		return shrinkTeamReplayTotalsTx(tx, teamID, -freedCount, delta-freedBytes)
	})
	if err != nil {
		return err
	}
	if rotated {
		s.sweepTeamReplaysNow()
	}
	return nil
}

func (s *GormStore) CompleteTeamReplay(ctx context.Context, teamID string, userID string, recordingID string, input TeamReplayCompleteInput) error {
	now := time.Now().UTC()
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		_, replay, err := s.lockTeamReplayForWriteTx(tx, teamID, userID, recordingID)
		if err != nil {
			return err
		}
		endMeta := input.EndMeta
		switch replay.State {
		case TeamReplayEnded:
			// 같은 끝을 다시 알리는 것이다(응답을 못 받은 경우). 처음 받은 것을 둔다.
			return nil
		case TeamReplayTruncated:
			// 잘린 녹화는 뒤 구간이 오지 않는다 — 빠진 구간을 따지지 않고 끝 메타만 받는다.
			updates := map[string]any{"last_activity_at": now}
			if replay.EndMeta == nil {
				updates["end_meta"] = endMeta
			}
			if replay.EndedAt == nil {
				updates["ended_at"] = now
			}
			return tx.Model(&teamReplayRow{}).
				Where("team_id = ? AND recording_id = ?", teamID, recordingID).
				UpdateColumns(updates).Error
		}
		if replay.SegmentCount != input.LastSegment+1 || replay.LastSegment != input.LastSegment {
			return ErrTeamReplayIncomplete
		}
		state := TeamReplayEnded
		if input.Cut {
			state = TeamReplayCut
		}
		return tx.Model(&teamReplayRow{}).
			Where("team_id = ? AND recording_id = ?", teamID, recordingID).
			UpdateColumns(map[string]any{
				"state":            state,
				"end_meta":         endMeta,
				"ended_at":         now,
				"last_activity_at": now,
			}).Error
	})
}

func (s *GormStore) ListTeamReplays(ctx context.Context, teamID string, userID string, query TeamReplayQuery) ([]TeamReplay, error) {
	db := s.db.WithContext(ctx)
	if _, err := getTeamMemberTx(db, teamID, userID); err != nil {
		return nil, err
	}
	scope := db.Where("team_id = ?", teamID)
	if len(query.RecordingIDs) > 0 {
		scope = scope.Where("recording_id IN ?", query.RecordingIDs)
	} else {
		scope = scope.Where("state <> ?", TeamReplayDeleted)
		if query.Before != "" {
			cursor, err := getTeamReplayTx(db, teamID, query.Before)
			if err != nil && !errors.Is(err, ErrTeamReplayNotFound) {
				return nil, err
			}
			if err == nil {
				scope = scope.Where("(created_at < ? OR (created_at = ? AND recording_id < ?))", cursor.CreatedAt, cursor.CreatedAt, cursor.RecordingID)
			}
		}
		limit := query.Limit
		if limit <= 0 {
			limit = 50
		}
		scope = scope.Limit(limit)
	}
	var rows []teamReplayRow
	if err := scope.Order("created_at DESC, recording_id DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	replays := make([]TeamReplay, 0, len(rows))
	for _, row := range rows {
		replays = append(replays, teamReplayFromRow(row))
	}
	return replays, nil
}

// readableTeamReplay 는 읽기 전에 멤버와 녹화를 본다. 지워진 녹화는 ErrTeamReplayDeleted 다.
func readableTeamReplay(db *gorm.DB, teamID string, userID string, recordingID string) (teamReplayRow, error) {
	if _, err := getTeamMemberTx(db, teamID, userID); err != nil {
		return teamReplayRow{}, err
	}
	replay, err := getTeamReplayTx(db, teamID, recordingID)
	if err != nil {
		return teamReplayRow{}, err
	}
	if replay.State == TeamReplayDeleted {
		return teamReplayRow{}, ErrTeamReplayDeleted
	}
	return replay, nil
}

func (s *GormStore) GetTeamReplay(ctx context.Context, teamID string, userID string, recordingID string) (TeamReplayDetail, error) {
	var detail TeamReplayDetail
	err := s.readTeamTx(ctx, func(tx *gorm.DB) error {
		replay, err := readableTeamReplay(tx, teamID, userID, recordingID)
		if err != nil {
			return err
		}
		detail.TeamReplay = teamReplayFromRow(replay)
		detail.StartMeta = replay.StartMeta
		if replay.EndMeta != nil {
			detail.EndMeta = *replay.EndMeta
		}
		var segments []teamReplaySegmentRow
		if err := tx.Select("segment_index", "info", "size").
			Where("team_id = ? AND recording_id = ?", teamID, recordingID).
			Order("segment_index ASC").
			Find(&segments).Error; err != nil {
			return err
		}
		detail.Segments = make([]TeamReplaySegmentInfo, 0, len(segments))
		for _, segment := range segments {
			detail.Segments = append(detail.Segments, TeamReplaySegmentInfo{Index: segment.SegmentIndex, Info: segment.Info, Size: segment.Size})
		}
		var extras []teamReplayExtraRow
		if err := tx.Select("kind", "segment_index", "size").
			Where("team_id = ? AND recording_id = ?", teamID, recordingID).
			Order("kind ASC, segment_index ASC").
			Find(&extras).Error; err != nil {
			return err
		}
		detail.Extras = make([]TeamReplayExtraInfo, 0, len(extras))
		for _, extra := range extras {
			detail.Extras = append(detail.Extras, TeamReplayExtraInfo{Kind: extra.Kind, Index: extra.SegmentIndex, Size: extra.Size})
		}
		return nil
	})
	if err != nil {
		return TeamReplayDetail{}, err
	}
	return detail, nil
}

// pickTeamReplayBlobs 는 from 부터 차례로, 합이 maxBytes 를 넘지 않을 만큼(적어도 하나) 고른다.
func pickTeamReplayBlobs(heads []struct {
	SegmentIndex int64
	Size         int64
}, maxBytes int64) []int64 {
	picked := make([]int64, 0, len(heads))
	var total int64
	for _, head := range heads {
		if len(picked) > 0 && total+head.Size > maxBytes {
			break
		}
		picked = append(picked, head.SegmentIndex)
		total += head.Size
	}
	return picked
}

func (s *GormStore) ReadTeamReplaySegments(ctx context.Context, teamID string, userID string, recordingID string, from int64, limit int, maxBytes int64) ([]TeamReplayBlob, error) {
	db := s.db.WithContext(ctx)
	if _, err := readableTeamReplay(db, teamID, userID, recordingID); err != nil {
		return nil, err
	}
	var heads []struct {
		SegmentIndex int64
		Size         int64
	}
	if err := db.Model(&teamReplaySegmentRow{}).
		Select("segment_index", "size").
		Where("team_id = ? AND recording_id = ? AND segment_index >= ?", teamID, recordingID, from).
		Order("segment_index ASC").
		Limit(limit).
		Scan(&heads).Error; err != nil {
		return nil, err
	}
	picked := pickTeamReplayBlobs(heads, maxBytes)
	if len(picked) == 0 {
		return []TeamReplayBlob{}, nil
	}
	var rows []teamReplaySegmentRow
	if err := db.Select("segment_index", "data").
		Where("team_id = ? AND recording_id = ? AND segment_index IN ?", teamID, recordingID, picked).
		Order("segment_index ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	blobs := make([]TeamReplayBlob, 0, len(rows))
	for _, row := range rows {
		blobs = append(blobs, TeamReplayBlob{Index: row.SegmentIndex, Data: row.Data})
	}
	return blobs, nil
}

func (s *GormStore) ReadTeamReplayExtras(ctx context.Context, teamID string, userID string, recordingID string, kind string, from int64, limit int, maxBytes int64) ([]TeamReplayBlob, error) {
	db := s.db.WithContext(ctx)
	if _, err := readableTeamReplay(db, teamID, userID, recordingID); err != nil {
		return nil, err
	}
	var heads []struct {
		SegmentIndex int64
		Size         int64
	}
	if err := db.Model(&teamReplayExtraRow{}).
		Select("segment_index", "size").
		Where("team_id = ? AND recording_id = ? AND kind = ? AND segment_index >= ?", teamID, recordingID, kind, from).
		Order("segment_index ASC").
		Limit(limit).
		Scan(&heads).Error; err != nil {
		return nil, err
	}
	picked := pickTeamReplayBlobs(heads, maxBytes)
	if len(picked) == 0 {
		return []TeamReplayBlob{}, nil
	}
	var rows []teamReplayExtraRow
	if err := db.Select("segment_index", "data").
		Where("team_id = ? AND recording_id = ? AND kind = ? AND segment_index IN ?", teamID, recordingID, kind, picked).
		Order("segment_index ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	blobs := make([]TeamReplayBlob, 0, len(rows))
	for _, row := range rows {
		blobs = append(blobs, TeamReplayBlob{Index: row.SegmentIndex, Data: row.Data})
	}
	return blobs, nil
}

// markTeamReplaysDeletedTx 는 팀을 지울 때 그 팀의 녹화를 모두 "지워짐"으로 돌린다. 큰 구간 행은 팀 삭제
// 트랜잭션에서 지우지 않는다(팀마다 기본 2GB) — 정리 작업이 나눠 지우고, 다 지운 뒤 행도 지운다.
// 녹화 행이 없거나 지워진 녹화의 구간은 아무도 읽지 못한다.
func markTeamReplaysDeletedTx(tx *gorm.DB, teamID string) error {
	return tx.Model(&teamReplayRow{}).Where("team_id = ?", teamID).UpdateColumns(map[string]any{
		"state":      TeamReplayDeleted,
		"start_meta": "",
		"end_meta":   nil,
		"purged":     false,
	}).Error
}

// sweepTeamReplaysNow 는 간격을 기다리지 않고 녹화 정리를 한 번 돈다 — 녹화를 지운 직후에 쓴다.
func (s *GormStore) sweepTeamReplaysNow() {
	s.allowImmediateSweep(teamReplaySweepKey)
	s.sweepTeamReplays()
}

// sweepTeamReplays 는 녹화 쪽 정리다. 쓰기 경로에 얹어 간격을 두고 돈다(sweepExpired 와 같은 방식).
//  1. 오래 새 구간이 없는 진행 중 녹화를 "끊김"으로 돌린다 — 지우지 않는다(앱이 죽은 세션의 녹화도 거기까지 남는다).
//  2. 지워진 녹화의 구간·덧붙임 행을 나눠 지운다.
//  3. 팀이 없어진 "지워짐" 행을 지운다.
func (s *GormStore) sweepTeamReplays() {
	now := time.Now().UTC()
	if !s.shouldSweepExpired(teamReplaySweepKey, now) {
		return
	}
	more := false
	if s.cutStaleTeamReplays(now) {
		more = true
	}
	if s.purgeDeletedTeamReplays() {
		more = true
	}
	if s.dropOrphanedTeamReplays() {
		more = true
	}
	if more {
		s.allowImmediateSweep(teamReplaySweepKey)
	}
}

func (s *GormStore) cutStaleTeamReplays(now time.Time) bool {
	cutoff := now.Add(-teamReplayStaleAfter)
	var stale []teamReplayRow
	if err := s.db.Select("team_id", "recording_id").
		Where("state = ? AND last_activity_at < ?", TeamReplayLive, cutoff).
		Limit(expiredRowSweepBatch).
		Find(&stale).Error; err != nil {
		log.Printf("store: 끊긴 녹화 조회 실패: %v", err)
		return false
	}
	for _, row := range stale {
		// 조건을 다시 건다 — 고르는 사이에 구간이 왔으면 그 녹화는 그대로 둔다.
		if err := s.db.Model(&teamReplayRow{}).
			Where("team_id = ? AND recording_id = ? AND state = ? AND last_activity_at < ?", row.TeamID, row.RecordingID, TeamReplayLive, cutoff).
			UpdateColumns(map[string]any{"state": TeamReplayCut, "ended_at": now}).Error; err != nil {
			log.Printf("store: 끊긴 녹화 표시 실패: %v", err)
			return false
		}
	}
	return len(stale) >= expiredRowSweepBatch
}

// purgeDeletedTeamReplays 는 지워진 녹화의 구간·덧붙임 행을 정리 한 번에 teamReplayPurgeRowsPerSweep 줄까지
// 지운다. 남았으면 true 다.
func (s *GormStore) purgeDeletedTeamReplays() bool {
	var targets []teamReplayRow
	if err := s.db.Select("team_id", "recording_id").
		Where("state = ? AND purged = ?", TeamReplayDeleted, false).
		Order("last_activity_at ASC").
		Limit(100).
		Find(&targets).Error; err != nil {
		log.Printf("store: 지운 녹화 조회 실패: %v", err)
		return false
	}
	budget := teamReplayPurgeRowsPerSweep
	for _, target := range targets {
		done := true
		for _, model := range []any{&teamReplaySegmentRow{}, &teamReplayExtraRow{}} {
			for budget > 0 {
				var indexes []int64
				if err := s.db.Model(model).
					Where("team_id = ? AND recording_id = ?", target.TeamID, target.RecordingID).
					Limit(min(teamReplayPurgeBatch, budget)).
					Pluck("segment_index", &indexes).Error; err != nil {
					log.Printf("store: 지운 녹화의 구간 조회 실패: %v", err)
					return false
				}
				if len(indexes) == 0 {
					break
				}
				if err := s.db.Where("team_id = ? AND recording_id = ? AND segment_index IN ?", target.TeamID, target.RecordingID, indexes).
					Delete(model).Error; err != nil {
					log.Printf("store: 지운 녹화의 구간 정리 실패: %v", err)
					return false
				}
				budget -= len(indexes)
			}
			if budget <= 0 {
				done = false
				break
			}
		}
		if !done {
			return true
		}
		if err := s.db.Model(&teamReplayRow{}).
			Where("team_id = ? AND recording_id = ? AND state = ?", target.TeamID, target.RecordingID, TeamReplayDeleted).
			UpdateColumn("purged", true).Error; err != nil {
			log.Printf("store: 지운 녹화 표시 실패: %v", err)
			return false
		}
	}
	return len(targets) >= 100
}

// dropOrphanedTeamReplays 는 지워진 팀의 녹화 행을 지운다(구간을 다 지운 것만). 남았으면 true 다.
func (s *GormStore) dropOrphanedTeamReplays() bool {
	var orphans []teamReplayRow
	if err := s.db.Select("team_id", "recording_id").
		Where("state = ? AND purged = ? AND NOT EXISTS (SELECT 1 FROM teams WHERE teams.id = team_replays.team_id)", TeamReplayDeleted, true).
		Limit(expiredRowSweepBatch).
		Find(&orphans).Error; err != nil {
		log.Printf("store: 팀이 없어진 녹화 조회 실패: %v", err)
		return false
	}
	byTeam := make(map[string][]string)
	for _, row := range orphans {
		byTeam[row.TeamID] = append(byTeam[row.TeamID], row.RecordingID)
	}
	for teamID, recordingIDs := range byTeam {
		if err := s.db.Where("team_id = ? AND recording_id IN ? AND state = ?", teamID, recordingIDs, TeamReplayDeleted).
			Delete(&teamReplayRow{}).Error; err != nil {
			log.Printf("store: 팀이 없어진 녹화 정리 실패: %v", err)
			return false
		}
	}
	return len(orphans) >= expiredRowSweepBatch
}
