package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func appTeamEvent(id string, at time.Time) TeamEventInput {
	return TeamEventInput{EventID: id, CreatedAt: at, Payload: "sealed-" + id}
}

func readServerTeamEvents(t *testing.T, store *GormStore, teamID string, reader teamTestUser) []teamServerEvent {
	t.Helper()
	events, err := store.ListTeamEvents(context.Background(), teamID, reader.ID, TeamEventQuery{Limit: 200})
	if err != nil {
		t.Fatalf("ListTeamEvents() error = %v", err)
	}
	var server []teamServerEvent
	for index := len(events) - 1; index >= 0; index-- {
		event := events[index]
		if event.Source != TeamEventSourceServer {
			continue
		}
		var decoded teamServerEvent
		if err := json.Unmarshal([]byte(event.Payload), &decoded); err != nil {
			t.Fatalf("server event payload %q: %v", event.Payload, err)
		}
		server = append(server, decoded)
	}
	return server
}

// requireTeamReplayTotals 는 팀 합계가 남아 있는 녹화의 실제 합과 같은지 본다.
func requireTeamReplayTotals(t *testing.T, store *GormStore, teamID string) (int64, int64) {
	t.Helper()
	var team teamRow
	if err := store.db.Where("id = ?", teamID).Take(&team).Error; err != nil {
		t.Fatalf("read team: %v", err)
	}
	var live []teamReplayRow
	if err := store.db.Where("team_id = ? AND state <> ?", teamID, TeamReplayDeleted).Find(&live).Error; err != nil {
		t.Fatalf("read replays: %v", err)
	}
	var bytesSum int64
	for _, replay := range live {
		var segments, extras int64
		store.db.Model(&teamReplaySegmentRow{}).Where("team_id = ? AND recording_id = ?", teamID, replay.RecordingID).Select("COALESCE(SUM(size), 0)").Row().Scan(&segments)
		store.db.Model(&teamReplayExtraRow{}).Where("team_id = ? AND recording_id = ?", teamID, replay.RecordingID).Select("COALESCE(SUM(size), 0)").Row().Scan(&extras)
		if replay.TotalBytes != segments+extras {
			t.Fatalf("replay %s total_bytes = %d, rows say %d", replay.RecordingID, replay.TotalBytes, segments+extras)
		}
		bytesSum += replay.TotalBytes
	}
	if team.ReplayCount != int64(len(live)) || team.ReplayBytes != bytesSum {
		t.Fatalf("team totals = %d recordings / %d bytes, rows say %d / %d", team.ReplayCount, team.ReplayBytes, len(live), bytesSum)
	}
	return team.ReplayCount, team.ReplayBytes
}

func requireTeamReplayState(t *testing.T, store *GormStore, teamID string, recordingID string, want string) {
	t.Helper()
	var replay teamReplayRow
	if err := store.db.Where("team_id = ? AND recording_id = ?", teamID, recordingID).Take(&replay).Error; err != nil {
		t.Fatalf("read replay %s: %v", recordingID, err)
	}
	if replay.State != want {
		t.Fatalf("replay %s state = %q, want %q", recordingID, replay.State, want)
	}
}

func startTestReplay(t *testing.T, store *GormStore, teamID string, author teamTestUser) string {
	t.Helper()
	recordingID := uuid.NewString()
	if _, err := store.StartTeamReplay(context.Background(), teamID, author.ID, recordingID, "start-"+recordingID); err != nil {
		t.Fatalf("StartTeamReplay() error = %v", err)
	}
	return recordingID
}

func putTestSegment(t *testing.T, store *GormStore, teamID string, author teamTestUser, recordingID string, index int64, size int) {
	t.Helper()
	if err := store.PutTeamReplaySegment(context.Background(), teamID, author.ID, recordingID, index, "i", bytes.Repeat([]byte{'x'}, size-1)); err != nil {
		t.Fatalf("PutTeamReplaySegment(%s #%d) error = %v", recordingID, index, err)
	}
}

func TestTeamEventsAreAppendOnlyAndCarryTheServerAuthor(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "events-owner@example.com", true)
			member := createTeamTestUser(t, store, "events-member@example.com", true)
			outsider := createTeamTestUser(t, store, "events-outsider@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			inviteTestMember(t, store, teamID, owner, member)
			base := time.Date(2026, 10, 21, 1, 2, 3, 456_000_000, time.UTC)

			first := []TeamEventInput{appTeamEvent("e1", base), appTeamEvent("e2", base.Add(time.Second))}
			if appended, err := store.AppendTeamEvents(ctx, teamID, member.ID, first); err != nil || appended != 2 {
				t.Fatalf("append = %d, %v", appended, err)
			}
			// 응답을 못 받고 다시 올리면 이미 받은 줄은 건너뛴다. 한 묶음 안에서 겹친 것도 한 줄이다.
			again := []TeamEventInput{appTeamEvent("e2", base.Add(time.Second)), appTeamEvent("e3", base.Add(2*time.Second)), appTeamEvent("e3", base)}
			if appended, err := store.AppendTeamEvents(ctx, teamID, member.ID, again); err != nil || appended != 1 {
				t.Fatalf("re-append = %d, %v", appended, err)
			}
			if _, err := store.AppendTeamEvents(ctx, teamID, outsider.ID, []TeamEventInput{appTeamEvent("x", base)}); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("outsider append error = %v, want ErrTeamNotFound", err)
			}
			if _, err := store.ListTeamEvents(ctx, teamID, outsider.ID, TeamEventQuery{}); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("outsider read error = %v, want ErrTeamNotFound", err)
			}

			newest, err := store.ListTeamEvents(ctx, teamID, owner.ID, TeamEventQuery{Limit: 2})
			if err != nil || len(newest) != 2 || newest[0].EventID != "e3" || newest[1].EventID != "e2" {
				t.Fatalf("newest events = %#v, %v", newest, err)
			}
			if newest[0].AuthorUserID != member.ID || newest[0].AuthorEmail != member.Email || newest[0].Source != TeamEventSourceApp {
				t.Fatalf("app event author = %#v", newest[0])
			}
			if !newest[1].CreatedAt.Equal(base.Add(time.Second)) || newest[1].ReceivedAt.IsZero() {
				t.Fatalf("app event times = %#v", newest[1])
			}
			older, err := store.ListTeamEvents(ctx, teamID, owner.ID, TeamEventQuery{Before: newest[1].Seq, Limit: 10})
			if err != nil || len(older) != 2 || older[0].EventID != "e1" || older[1].Source != TeamEventSourceServer {
				t.Fatalf("older events = %#v, %v", older, err)
			}
			// after 는 그 뒤를 오래된 것부터 준다 — 열려 있는 화면이 새 줄만 받는다.
			later, err := store.ListTeamEvents(ctx, teamID, owner.ID, TeamEventQuery{After: older[0].Seq, Limit: 10})
			if err != nil || len(later) != 2 || later[0].EventID != "e2" || later[1].EventID != "e3" {
				t.Fatalf("later events = %#v, %v", later, err)
			}
			for index := 1; index < len(later); index++ {
				if later[index].Seq != later[index-1].Seq+1 {
					t.Fatalf("sequence has a gap: %#v", later)
				}
			}
		})
	}
}

func TestTeamEventsKeepTheNewestWithinTheLimit(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			store.SetTeamHistoryLimits(TeamHistoryLimits{EventMaxCount: 5})
			owner := createTeamTestUser(t, store, "events-limit-owner@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			for index := 1; index <= 8; index++ {
				if _, err := store.AppendTeamEvents(ctx, teamID, owner.ID, []TeamEventInput{appTeamEvent(fmt.Sprintf("e%d", index), time.Now())}); err != nil {
					t.Fatalf("append %d: %v", index, err)
				}
			}
			events, err := store.ListTeamEvents(ctx, teamID, owner.ID, TeamEventQuery{Limit: 100})
			if err != nil || len(events) != 5 || events[0].EventID != "e8" || events[4].EventID != "e4" {
				t.Fatalf("events within the limit = %#v, %v", events, err)
			}
			if count := countTeamRows(t, store, &teamEventRow{}, "team_id = ?", teamID); count != 5 {
				t.Fatalf("event rows = %d, want 5", count)
			}
		})
	}
}

func TestTeamMemberChangesAreRecordedByTheServer(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "changes-owner@example.com", true)
			bob := createTeamTestUser(t, store, "changes-bob@example.com", true)
			carol := createTeamTestUser(t, store, "changes-carol@example.com", true)
			dave := createTeamTestUser(t, store, "changes-dave@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			inviteTestMember(t, store, teamID, owner, bob)
			time.Sleep(10 * time.Millisecond)
			inviteTestMember(t, store, teamID, bob, carol)
			inviteTestMember(t, store, teamID, owner, dave)

			// 빠진 멤버가 남긴 활동은 남는다.
			if _, err := store.AppendTeamEvents(ctx, teamID, dave.ID, []TeamEventInput{appTeamEvent("dave-was-here", time.Now())}); err != nil {
				t.Fatalf("dave append: %v", err)
			}
			// 실패한 일은 기록도 남기지 않는다.
			if err := store.RemoveTeamMember(ctx, teamID, bob.ID, dave.ID); !errors.Is(err, ErrTeamOwnerOnly) {
				t.Fatalf("member removing = %v, want ErrTeamOwnerOnly", err)
			}
			if err := store.RemoveTeamMember(ctx, teamID, owner.ID, dave.ID); err != nil {
				t.Fatalf("RemoveTeamMember() error = %v", err)
			}
			if err := store.TransferTeamOwnership(ctx, teamID, owner.ID, bob.ID); err != nil {
				t.Fatalf("TransferTeamOwnership() error = %v", err)
			}
			if _, err := store.LeaveTeam(ctx, teamID, owner.ID); err != nil {
				t.Fatalf("LeaveTeam() error = %v", err)
			}
			epoch, err := store.GetUserVaultEpoch(ctx, bob.ID)
			if err != nil {
				t.Fatalf("GetUserVaultEpoch() error = %v", err)
			}
			// 소유자(bob)가 볼트를 초기화하면 빠지고, 다음 멤버(carol)가 소유자를 잇는다.
			if _, err := store.ResetUserVault(ctx, bob.ID, epoch); err != nil {
				t.Fatalf("ResetUserVault() error = %v", err)
			}

			got := readServerTeamEvents(t, store, teamID, carol)
			want := []teamServerEvent{
				{Type: teamEventMemberJoined, UserID: bob.ID, Email: bob.Email, ByUserID: owner.ID, ByEmail: owner.Email},
				{Type: teamEventMemberJoined, UserID: carol.ID, Email: carol.Email, ByUserID: bob.ID, ByEmail: bob.Email},
				{Type: teamEventMemberJoined, UserID: dave.ID, Email: dave.Email, ByUserID: owner.ID, ByEmail: owner.Email},
				{Type: teamEventMemberRemoved, UserID: dave.ID, Email: dave.Email, ByUserID: owner.ID, ByEmail: owner.Email},
				{Type: teamEventOwnerChanged, UserID: bob.ID, Email: bob.Email, ByUserID: owner.ID, ByEmail: owner.Email},
				{Type: teamEventMemberLeft, UserID: owner.ID, Email: owner.Email},
				{Type: teamEventMemberLeft, UserID: bob.ID, Email: bob.Email, Reason: teamEventReasonVaultReset},
				{Type: teamEventOwnerChanged, UserID: carol.ID, Email: carol.Email, ByUserID: bob.ID, ByEmail: bob.Email, Reason: teamEventReasonSuccessor},
			}
			if len(got) != len(want) {
				t.Fatalf("server events = %#v, want %d", got, len(want))
			}
			for index := range want {
				want[index].Version = teamServerEventVersion
				if got[index] != want[index] {
					t.Fatalf("server event %d = %#v, want %#v", index, got[index], want[index])
				}
			}
			events, err := store.ListTeamEvents(ctx, teamID, carol.ID, TeamEventQuery{Limit: 100})
			if err != nil {
				t.Fatalf("ListTeamEvents() error = %v", err)
			}
			found := false
			for _, event := range events {
				if event.EventID == "dave-was-here" && event.AuthorEmail == dave.Email {
					found = true
				}
			}
			if !found {
				t.Fatalf("removed member's event is gone: %#v", events)
			}

			if err := store.DeleteUserData(ctx, carol.ID); err != nil {
				t.Fatalf("DeleteUserData() error = %v", err)
			}
			if count := countTeamRows(t, store, &teamEventRow{}, "team_id = ?", teamID); count != 0 {
				t.Fatalf("events of a deleted team = %d rows, want 0", count)
			}
		})
	}
}

func TestTeamReplayLifecycle(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "replay-owner@example.com", true)
			member := createTeamTestUser(t, store, "replay-member@example.com", true)
			outsider := createTeamTestUser(t, store, "replay-outsider@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			inviteTestMember(t, store, teamID, owner, member)
			recordingID := uuid.NewString()

			started, err := store.StartTeamReplay(ctx, teamID, member.ID, recordingID, "start-meta")
			if err != nil || started.State != TeamReplayLive || started.LastSegment != -1 || started.AuthorEmail != member.Email {
				t.Fatalf("start = %#v, %v", started, err)
			}
			if again, err := store.StartTeamReplay(ctx, teamID, member.ID, recordingID, "other"); err != nil || again.RecordingID != recordingID {
				t.Fatalf("restart = %#v, %v", again, err)
			}
			if _, err := store.StartTeamReplay(ctx, teamID, owner.ID, recordingID, "steal"); !errors.Is(err, ErrTeamReplayAuthorOnly) {
				t.Fatalf("someone else's start = %v, want ErrTeamReplayAuthorOnly", err)
			}

			// 1MB 남짓한 구간이 DB 셋 모두에서 그대로 왕복해야 한다(SQLite blob·Postgres bytea·MySQL longblob).
			big := make([]byte, 1<<20)
			if _, err := rand.Read(big); err != nil {
				t.Fatalf("rand: %v", err)
			}
			segments := [][]byte{[]byte("first"), big, []byte("third")}
			for index, data := range segments {
				if err := store.PutTeamReplaySegment(ctx, teamID, member.ID, recordingID, int64(index), fmt.Sprintf("info-%d", index), data); err != nil {
					t.Fatalf("put segment %d: %v", index, err)
				}
			}
			// 같은 번호를 다시 올리면 덮어쓴다 — 합계를 두 번 세지 않는다.
			if err := store.PutTeamReplaySegment(ctx, teamID, member.ID, recordingID, 2, "info-2", []byte("third")); err != nil {
				t.Fatalf("re-put segment: %v", err)
			}
			if err := store.PutTeamReplaySegment(ctx, teamID, owner.ID, recordingID, 3, "i", []byte("x")); !errors.Is(err, ErrTeamReplayAuthorOnly) {
				t.Fatalf("someone else's segment = %v, want ErrTeamReplayAuthorOnly", err)
			}
			count, total := requireTeamReplayTotals(t, store, teamID)
			if count != 1 || total != int64(len("first")+len(big)+len("third")+3*len("info-0")) {
				t.Fatalf("totals = %d / %d", count, total)
			}

			// 진행 중인 녹화도 멤버가 읽는다.
			detail, err := store.GetTeamReplay(ctx, teamID, owner.ID, recordingID)
			if err != nil || detail.State != TeamReplayLive || detail.StartMeta != "start-meta" || len(detail.Segments) != 3 || detail.Segments[1].Info != "info-1" {
				t.Fatalf("detail = %#v, %v", detail, err)
			}
			blobs, err := store.ReadTeamReplaySegments(ctx, teamID, owner.ID, recordingID, 0, 10, 1024)
			if err != nil || len(blobs) != 1 || blobs[0].Index != 0 || string(blobs[0].Data) != "first" {
				t.Fatalf("small batch = %#v, %v", blobs, err)
			}
			blobs, err = store.ReadTeamReplaySegments(ctx, teamID, owner.ID, recordingID, 1, 10, 8<<20)
			if err != nil || len(blobs) != 2 || !bytes.Equal(blobs[0].Data, big) || blobs[1].Index != 2 {
				t.Fatalf("big batch = %d blobs, %v", len(blobs), err)
			}
			if _, err := store.GetTeamReplay(ctx, teamID, outsider.ID, recordingID); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("outsider read = %v, want ErrTeamNotFound", err)
			}

			if err := store.CompleteTeamReplay(ctx, teamID, member.ID, recordingID, TeamReplayCompleteInput{EndMeta: "end", LastSegment: 3}); !errors.Is(err, ErrTeamReplayIncomplete) {
				t.Fatalf("complete with a missing segment = %v, want ErrTeamReplayIncomplete", err)
			}
			if err := store.CompleteTeamReplay(ctx, teamID, member.ID, recordingID, TeamReplayCompleteInput{EndMeta: "end", LastSegment: 2}); err != nil {
				t.Fatalf("complete: %v", err)
			}
			if err := store.CompleteTeamReplay(ctx, teamID, member.ID, recordingID, TeamReplayCompleteInput{EndMeta: "end", LastSegment: 2}); err != nil {
				t.Fatalf("complete again: %v", err)
			}
			if err := store.PutTeamReplaySegment(ctx, teamID, member.ID, recordingID, 3, "i", []byte("late")); !errors.Is(err, ErrTeamReplayClosed) {
				t.Fatalf("segment after the end = %v, want ErrTeamReplayClosed", err)
			}
			detail, err = store.GetTeamReplay(ctx, teamID, owner.ID, recordingID)
			if err != nil || detail.State != TeamReplayEnded || detail.EndMeta != "end" || detail.EndedAt == nil {
				t.Fatalf("ended detail = %#v, %v", detail, err)
			}

			// 빠진 멤버가 남긴 녹화는 남고, 그 사람은 더 읽지도 올리지도 못한다 — 진행 중이던 녹화도 거기까지다.
			unfinished := startTestReplay(t, store, teamID, member)
			if err := store.RemoveTeamMember(ctx, teamID, owner.ID, member.ID); err != nil {
				t.Fatalf("remove: %v", err)
			}
			if err := store.PutTeamReplaySegment(ctx, teamID, member.ID, unfinished, 0, "i", []byte("x")); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("removed member segment = %v, want ErrTeamNotFound", err)
			}
			if err := store.CompleteTeamReplay(ctx, teamID, member.ID, unfinished, TeamReplayCompleteInput{EndMeta: "e", LastSegment: -1}); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("removed member complete = %v, want ErrTeamNotFound", err)
			}
			if _, err := store.GetTeamReplay(ctx, teamID, owner.ID, recordingID); err != nil {
				t.Fatalf("removed member's recording: %v", err)
			}
			if _, err := store.ReadTeamReplaySegments(ctx, teamID, member.ID, recordingID, 0, 10, 1<<20); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("removed member read = %v, want ErrTeamNotFound", err)
			}
			if _, err := store.StartTeamReplay(ctx, teamID, member.ID, uuid.NewString(), "m"); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("removed member start = %v, want ErrTeamNotFound", err)
			}
		})
	}
}

func TestTeamReplayRotationByCount(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			store.SetTeamHistoryLimits(TeamHistoryLimits{ReplayMaxCount: 2})
			owner := createTeamTestUser(t, store, "count-owner@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")

			finish := func(recordingID string) {
				t.Helper()
				if err := store.CompleteTeamReplay(ctx, teamID, owner.ID, recordingID, TeamReplayCompleteInput{EndMeta: "e", LastSegment: -1}); err != nil {
					t.Fatalf("complete %s: %v", recordingID, err)
				}
			}
			first := startTestReplay(t, store, teamID, owner)
			putTestSegment(t, store, teamID, owner, first, 0, 10)
			if err := store.CompleteTeamReplay(ctx, teamID, owner.ID, first, TeamReplayCompleteInput{EndMeta: "e", LastSegment: 0}); err != nil {
				t.Fatalf("complete first: %v", err)
			}
			time.Sleep(5 * time.Millisecond)
			second := startTestReplay(t, store, teamID, owner)
			finish(second)
			time.Sleep(5 * time.Millisecond)
			// 셋째는 자리가 없다 — 끝난 둘 중 오래된 첫째가 지워진다.
			third := startTestReplay(t, store, teamID, owner)
			requireTeamReplayState(t, store, teamID, first, TeamReplayDeleted)
			requireTeamReplayState(t, store, teamID, second, TeamReplayEnded)
			if _, err := store.GetTeamReplay(ctx, teamID, owner.ID, first); !errors.Is(err, ErrTeamReplayDeleted) {
				t.Fatalf("rotated recording = %v, want ErrTeamReplayDeleted", err)
			}
			listed, err := store.ListTeamReplays(ctx, teamID, owner.ID, TeamReplayQuery{RecordingIDs: []string{first, second}})
			if err != nil || len(listed) != 2 {
				t.Fatalf("listed by ids = %#v, %v", listed, err)
			}
			states := map[string]string{}
			for _, replay := range listed {
				states[replay.RecordingID] = replay.State
			}
			if states[first] != TeamReplayDeleted || states[second] != TeamReplayEnded {
				t.Fatalf("states by ids = %#v", states)
			}
			time.Sleep(5 * time.Millisecond)
			fourth := startTestReplay(t, store, teamID, owner)
			requireTeamReplayState(t, store, teamID, second, TeamReplayDeleted)
			// 남은 둘은 진행 중이라 지울 수 없다 — 다섯째는 기다린다.
			if _, err := store.StartTeamReplay(ctx, teamID, owner.ID, uuid.NewString(), "s"); !errors.Is(err, ErrTeamReplayQuotaBusy) {
				t.Fatalf("start while full of live recordings = %v, want ErrTeamReplayQuotaBusy", err)
			}
			finish(third)
			time.Sleep(5 * time.Millisecond)
			fifth := startTestReplay(t, store, teamID, owner)
			requireTeamReplayState(t, store, teamID, third, TeamReplayDeleted)
			requireTeamReplayState(t, store, teamID, fourth, TeamReplayLive)
			requireTeamReplayState(t, store, teamID, fifth, TeamReplayLive)
			recent, err := store.ListTeamReplays(ctx, teamID, owner.ID, TeamReplayQuery{Limit: 10})
			if err != nil || len(recent) != 2 || recent[0].RecordingID != fifth || recent[1].RecordingID != fourth {
				t.Fatalf("recent replays = %#v, %v", recent, err)
			}
			page, err := store.ListTeamReplays(ctx, teamID, owner.ID, TeamReplayQuery{Before: fifth, Limit: 10})
			if err != nil || len(page) != 1 || page[0].RecordingID != fourth {
				t.Fatalf("next page = %#v, %v", page, err)
			}
			requireTeamReplayTotals(t, store, teamID)
		})
	}
}

func TestTeamReplayRotationByBytesAndTruncation(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			store.SetTeamHistoryLimits(TeamHistoryLimits{ReplayMaxBytes: 100, ReplayMaxBytesPerRecording: 80})
			owner := createTeamTestUser(t, store, "bytes-owner@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")

			first := startTestReplay(t, store, teamID, owner)
			putTestSegment(t, store, teamID, owner, first, 0, 60)
			if err := store.CompleteTeamReplay(ctx, teamID, owner.ID, first, TeamReplayCompleteInput{EndMeta: "e", LastSegment: 0}); err != nil {
				t.Fatalf("complete first: %v", err)
			}
			time.Sleep(5 * time.Millisecond)
			second := startTestReplay(t, store, teamID, owner)
			putTestSegment(t, store, teamID, owner, second, 0, 30)
			// 90 + 30 > 100 — 끝난 첫째(60)를 지워 자리를 만든다. 진행 중인 둘째는 지우지 않는다.
			putTestSegment(t, store, teamID, owner, second, 1, 30)
			requireTeamReplayState(t, store, teamID, first, TeamReplayDeleted)
			if _, total := requireTeamReplayTotals(t, store, teamID); total != 60 {
				t.Fatalf("team bytes = %d, want 60", total)
			}
			third := startTestReplay(t, store, teamID, owner)
			// 60 + 50 > 100 인데 남은 녹화는 진행 중이다 — 받지 않고 나중에 다시 보내게 한다.
			if err := store.PutTeamReplaySegment(ctx, teamID, owner.ID, third, 0, "i", bytes.Repeat([]byte{'x'}, 49)); !errors.Is(err, ErrTeamReplayQuotaBusy) {
				t.Fatalf("segment while full = %v, want ErrTeamReplayQuotaBusy", err)
			}

			// 한 개 최대(80)를 넘게 하는 구간부터는 받지 않고, 녹화는 잘린 채 앞부분이 남는다.
			if err := store.PutTeamReplaySegment(ctx, teamID, owner.ID, second, 2, "i", bytes.Repeat([]byte{'x'}, 29)); !errors.Is(err, ErrTeamReplayTooLarge) {
				t.Fatalf("segment over the per-recording max = %v, want ErrTeamReplayTooLarge", err)
			}
			requireTeamReplayState(t, store, teamID, second, TeamReplayTruncated)
			if err := store.PutTeamReplaySegment(ctx, teamID, owner.ID, second, 2, "i", []byte("x")); !errors.Is(err, ErrTeamReplayTooLarge) {
				t.Fatalf("segment after truncation = %v, want ErrTeamReplayTooLarge", err)
			}
			// 잘린 녹화의 끝은 빠진 구간을 따지지 않고 받는다(뒤는 오지 않는다).
			if err := store.CompleteTeamReplay(ctx, teamID, owner.ID, second, TeamReplayCompleteInput{EndMeta: "end", LastSegment: 7}); err != nil {
				t.Fatalf("complete truncated: %v", err)
			}
			detail, err := store.GetTeamReplay(ctx, teamID, owner.ID, second)
			if err != nil || detail.State != TeamReplayTruncated || detail.EndMeta != "end" || len(detail.Segments) != 2 {
				t.Fatalf("truncated detail = %#v, %v", detail, err)
			}
			if _, total := requireTeamReplayTotals(t, store, teamID); total != 60 {
				t.Fatalf("team bytes after truncation = %d, want 60", total)
			}
			// 이제 둘째는 지울 수 있다 — 셋째의 구간이 들어간다.
			putTestSegment(t, store, teamID, owner, third, 0, 50)
			requireTeamReplayState(t, store, teamID, second, TeamReplayDeleted)
			requireTeamReplayTotals(t, store, teamID)
		})
	}
}

func TestTeamReplayExtras(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			store.SetTeamHistoryLimits(TeamHistoryLimits{ReplayMaxBytesPerRecording: 100})
			owner := createTeamTestUser(t, store, "extras-owner@example.com", true)
			member := createTeamTestUser(t, store, "extras-member@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			inviteTestMember(t, store, teamID, owner, member)
			recordingID := startTestReplay(t, store, teamID, owner)
			putTestSegment(t, store, teamID, owner, recordingID, 0, 20)

			// 진행 중에도 구간을 따라 올라온다.
			if err := store.PutTeamReplayExtra(ctx, teamID, owner.ID, recordingID, "commands", 0, []byte("cmd-0")); err != nil {
				t.Fatalf("put commands: %v", err)
			}
			if err := store.CompleteTeamReplay(ctx, teamID, owner.ID, recordingID, TeamReplayCompleteInput{EndMeta: "e", LastSegment: 0}); err != nil {
				t.Fatalf("complete: %v", err)
			}
			// 훑기가 뒤따라와 끝난 뒤에 오는 덧붙임도 받는다.
			if err := store.PutTeamReplayExtra(ctx, teamID, owner.ID, recordingID, "snapshot", 0, []byte("screen")); err != nil {
				t.Fatalf("put snapshot after the end: %v", err)
			}
			if err := store.PutTeamReplayExtra(ctx, teamID, member.ID, recordingID, "commands", 1, []byte("x")); !errors.Is(err, ErrTeamReplayAuthorOnly) {
				t.Fatalf("someone else's extra = %v, want ErrTeamReplayAuthorOnly", err)
			}
			// 덧붙임이 한 개 최대를 넘기면 그 덧붙임만 받지 않는다 — 녹화는 그대로다.
			if err := store.PutTeamReplayExtra(ctx, teamID, owner.ID, recordingID, "snapshot", 1, bytes.Repeat([]byte{'s'}, 80)); !errors.Is(err, ErrTeamReplayTooLarge) {
				t.Fatalf("extra over the per-recording max = %v, want ErrTeamReplayTooLarge", err)
			}
			requireTeamReplayState(t, store, teamID, recordingID, TeamReplayEnded)

			detail, err := store.GetTeamReplay(ctx, teamID, member.ID, recordingID)
			if err != nil || len(detail.Extras) != 2 || detail.Extras[0].Kind != "commands" || detail.Extras[1].Kind != "snapshot" {
				t.Fatalf("extras in detail = %#v, %v", detail.Extras, err)
			}
			commands, err := store.ReadTeamReplayExtras(ctx, teamID, member.ID, recordingID, "commands", 0, 10, 1<<20)
			if err != nil || len(commands) != 1 || string(commands[0].Data) != "cmd-0" {
				t.Fatalf("commands = %#v, %v", commands, err)
			}
			if _, total := requireTeamReplayTotals(t, store, teamID); total != 20+5+6 {
				t.Fatalf("team bytes with extras = %d", total)
			}
		})
	}
}

func TestTeamReplaySweepCutsStaleRecordingsAndPurgesDeletedOnes(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			store.SetTeamHistoryLimits(TeamHistoryLimits{ReplayMaxCount: 1})
			owner := createTeamTestUser(t, store, "sweep-replay-owner@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")

			// 앱이 죽어 끝을 알리지 못한 녹화: 하루 동안 새 구간이 없으면 "끊김" — 지우지 않는다.
			stale := startTestReplay(t, store, teamID, owner)
			putTestSegment(t, store, teamID, owner, stale, 0, 10)
			if err := store.PutTeamReplayExtra(ctx, teamID, owner.ID, stale, "commands", 0, []byte("c")); err != nil {
				t.Fatalf("put extra: %v", err)
			}
			if err := store.db.Model(&teamReplayRow{}).Where("recording_id = ?", stale).
				UpdateColumn("last_activity_at", time.Now().UTC().Add(-25*time.Hour)).Error; err != nil {
				t.Fatalf("age the recording: %v", err)
			}
			store.sweepTeamReplaysNow()
			requireTeamReplayState(t, store, teamID, stale, TeamReplayCut)
			if _, err := store.GetTeamReplay(ctx, teamID, owner.ID, stale); err != nil {
				t.Fatalf("cut recording is still readable: %v", err)
			}
			// 그 앱이 돌아와 이어 보내면 다시 진행 중이다.
			putTestSegment(t, store, teamID, owner, stale, 1, 10)
			requireTeamReplayState(t, store, teamID, stale, TeamReplayLive)
			if err := store.CompleteTeamReplay(ctx, teamID, owner.ID, stale, TeamReplayCompleteInput{EndMeta: "e", LastSegment: 1, Cut: true}); err != nil {
				t.Fatalf("complete as cut: %v", err)
			}
			requireTeamReplayState(t, store, teamID, stale, TeamReplayCut)

			// 다음 녹화가 자리를 차지하면 끊긴 녹화가 지워지고, 그 구간 행은 정리가 지운다.
			next := startTestReplay(t, store, teamID, owner)
			requireTeamReplayState(t, store, teamID, stale, TeamReplayDeleted)
			if count := countTeamRows(t, store, &teamReplaySegmentRow{}, "recording_id = ?", stale); count != 0 {
				t.Fatalf("segments of a rotated recording = %d rows", count)
			}
			if count := countTeamRows(t, store, &teamReplayExtraRow{}, "recording_id = ?", stale); count != 0 {
				t.Fatalf("extras of a rotated recording = %d rows", count)
			}
			var tombstone teamReplayRow
			if err := store.db.Where("recording_id = ?", stale).Take(&tombstone).Error; err != nil || !tombstone.Purged || tombstone.StartMeta != "" || tombstone.EndMeta != nil {
				t.Fatalf("tombstone = %#v, %v", tombstone, err)
			}
			requireTeamReplayTotals(t, store, teamID)

			// 팀을 지우면 녹화는 "지워짐"이 되고, 정리가 구간과 행까지 지운다.
			putTestSegment(t, store, teamID, owner, next, 0, 10)
			if _, err := store.DeleteTeam(ctx, teamID, owner.ID); err != nil {
				t.Fatalf("DeleteTeam() error = %v", err)
			}
			store.sweepTeamReplaysNow()
			store.sweepTeamReplaysNow()
			for _, model := range []any{&teamReplayRow{}, &teamReplaySegmentRow{}, &teamReplayExtraRow{}, &teamEventRow{}} {
				if count := countTeamRows(t, store, model, "team_id = ?", teamID); count != 0 {
					t.Fatalf("%T rows of a deleted team = %d", model, count)
				}
			}
		})
	}
}

func TestTeamReplayTombstonesStayBounded(t *testing.T) {
	store := openSQLiteTestStore(t)
	ctx := context.Background()
	store.SetTeamHistoryLimits(TeamHistoryLimits{ReplayMaxCount: 1})
	owner := createTeamTestUser(t, store, "tomb-owner@example.com", true)
	teamID := createTestTeam(t, store, owner, "Acme")
	for index := 0; index < teamReplayTombstonesPerSlot+5; index++ {
		recordingID := startTestReplay(t, store, teamID, owner)
		if err := store.CompleteTeamReplay(ctx, teamID, owner.ID, recordingID, TeamReplayCompleteInput{EndMeta: "e", LastSegment: -1}); err != nil {
			t.Fatalf("complete: %v", err)
		}
	}
	store.sweepTeamReplaysNow()
	startTestReplay(t, store, teamID, owner)
	if count := countTeamRows(t, store, &teamReplayRow{}, "team_id = ? AND state = ?", teamID, TeamReplayDeleted); count > teamReplayTombstonesPerSlot+1 {
		t.Fatalf("tombstones = %d, want at most %d", count, teamReplayTombstonesPerSlot+1)
	}
}

// 같은 팀에 동시에 기록·녹화를 써도 순번이 겹치지 않고 팀 합계가 실제 행과 맞는다. SQLite 는 연결 하나로
// 직렬화하므로 실제 경쟁은 MySQL·Postgres 실행(SYNC_API_MYSQL_DSN 등)에서 드러난다.
func TestTeamHistoryConcurrentWritesKeepSequencesAndTotals(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			store.SetTeamHistoryLimits(TeamHistoryLimits{ReplayMaxCount: 6, ReplayMaxBytes: 4000, ReplayMaxBytesPerRecording: 1500})
			owner := createTeamTestUser(t, store, "race-history-owner@example.com", true)
			member := createTeamTestUser(t, store, "race-history-member@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			inviteTestMember(t, store, teamID, owner, member)

			errs := make(chan error, 256)
			var workers sync.WaitGroup
			start := make(chan struct{})
			run := func(work func() error) {
				workers.Add(1)
				go func() {
					defer workers.Done()
					<-start
					if err := work(); err != nil {
						errs <- err
					}
				}()
			}
			for writer := 0; writer < 8; writer++ {
				writer := writer
				run(func() error {
					for batch := 0; batch < 5; batch++ {
						events := []TeamEventInput{
							appTeamEvent(fmt.Sprintf("w%d-b%d-a", writer, batch), time.Now()),
							appTeamEvent(fmt.Sprintf("w%d-b%d-b", writer, batch), time.Now()),
						}
						if _, err := store.AppendTeamEvents(ctx, teamID, member.ID, events); err != nil {
							return err
						}
					}
					return nil
				})
				run(func() error {
					recordingID := uuid.NewString()
					if _, err := store.StartTeamReplay(ctx, teamID, member.ID, recordingID, "s"); err != nil {
						if errors.Is(err, ErrTeamReplayQuotaBusy) {
							return nil
						}
						return err
					}
					last := int64(-1)
					for index := int64(0); index < 4; index++ {
						err := store.PutTeamReplaySegment(ctx, teamID, member.ID, recordingID, index, "i", bytes.Repeat([]byte{'x'}, 199))
						if errors.Is(err, ErrTeamReplayQuotaBusy) || errors.Is(err, ErrTeamReplayDeleted) {
							return nil
						}
						if err != nil {
							return err
						}
						last = index
					}
					err := store.CompleteTeamReplay(ctx, teamID, member.ID, recordingID, TeamReplayCompleteInput{EndMeta: "e", LastSegment: last})
					if errors.Is(err, ErrTeamReplayDeleted) {
						return nil
					}
					return err
				})
			}
			// 멤버 변화(서버 기록)도 같은 순번을 쓴다.
			run(func() error {
				return store.RenameTeam(ctx, teamID, owner.ID, "Renamed")
			})
			run(func() error {
				extra := createTeamTestUser(t, store, "race-history-extra@example.com", true)
				token := "race-history-token"
				invite, err := store.CreateTeamInvite(ctx, CreateTeamInviteInput{
					TeamID: teamID, CreatedBy: owner.ID, InviteBox: "box", JoinTokenHash: HashTeamJoinToken(token), ExpiresAt: time.Now().Add(time.Hour),
				})
				if err != nil {
					return err
				}
				_, err = store.JoinTeam(ctx, invite.Code, token, extra.ID)
				return err
			})
			close(start)
			workers.Wait()
			close(errs)
			for err := range errs {
				t.Fatalf("concurrent history write failed: %v", err)
			}

			events, err := store.ListTeamEvents(ctx, teamID, owner.ID, TeamEventQuery{Limit: 200})
			if err != nil {
				t.Fatalf("ListTeamEvents() error = %v", err)
			}
			// 만들 때 참여 1 + 동시 참여 1 + 앱 기록 80. 최신부터 오므로 82 부터 1 까지 빈틈없이 내려가야 한다.
			if len(events) != 82 {
				t.Fatalf("events = %d, want 82", len(events))
			}
			for index, event := range events {
				if event.Seq != int64(len(events)-index) {
					t.Fatalf("event %d has seq %d — sequence has a gap or a duplicate", index, event.Seq)
				}
			}
			requireTeamReplayTotals(t, store, teamID)
		})
	}
}
