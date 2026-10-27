package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	syncmodel "dolssh/services/sync-api/internal/sync"
)

// joinTestTeamAs 는 inviter 가 그 역할의 링크를 만들어 user 를 들이고 사본까지 올린다.
func joinTestTeamAs(t *testing.T, store *GormStore, teamID string, inviter teamTestUser, user teamTestUser, role string) {
	t.Helper()
	ctx := context.Background()
	token := "join-" + role + "-" + user.ID
	invite, err := store.CreateTeamInvite(ctx, CreateTeamInviteInput{
		TeamID: teamID, CreatedBy: inviter.ID, InviteBox: "box", Role: role,
		JoinTokenHash: HashTeamJoinToken(token), ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("CreateTeamInvite(%s) error = %v", role, err)
	}
	if _, err := store.JoinTeam(ctx, invite.Code, token, user.ID); err != nil {
		t.Fatalf("JoinTeam(%s) error = %v", user.Email, err)
	}
	if err := store.PutTeamMemberKey(ctx, teamID, user.ID, "team-key-for-"+user.ID, user.VaultEpoch); err != nil {
		t.Fatalf("PutTeamMemberKey(%s) error = %v", user.Email, err)
	}
}

// roleTestTeam 은 역할 넷이 다 있는 팀과 바깥 사람이다.
type roleTestTeam struct {
	id       string
	owner    teamTestUser
	admin    teamTestUser
	member   teamTestUser
	viewer   teamTestUser
	outsider teamTestUser
}

func newRoleTestTeam(t *testing.T, store *GormStore, prefix string) roleTestTeam {
	t.Helper()
	team := roleTestTeam{
		owner:    createTeamTestUser(t, store, prefix+"-owner@example.com", true),
		admin:    createTeamTestUser(t, store, prefix+"-admin@example.com", true),
		member:   createTeamTestUser(t, store, prefix+"-member@example.com", true),
		viewer:   createTeamTestUser(t, store, prefix+"-viewer@example.com", true),
		outsider: createTeamTestUser(t, store, prefix+"-outsider@example.com", true),
	}
	team.id = createTestTeam(t, store, team.owner, "Acme")
	joinTestTeamAs(t, store, team.id, team.owner, team.admin, TeamRoleMember)
	if err := store.SetTeamMemberRole(context.Background(), team.id, team.owner.ID, team.admin.ID, TeamRoleAdmin); err != nil {
		t.Fatalf("SetTeamMemberRole(admin) error = %v", err)
	}
	joinTestTeamAs(t, store, team.id, team.owner, team.member, TeamRoleMember)
	// 관리자도 링크를 만든다 — 읽기 전용 링크로.
	joinTestTeamAs(t, store, team.id, team.admin, team.viewer, TeamRoleViewer)
	return team
}

func TestTeamViewerCannotWriteRecordsButKeepsItsOwnSlots(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			team := newRoleTestTeam(t, store, "viewer-write")
			requireTeamRole(t, store, team.id, team.viewer.ID, TeamRoleViewer)
			hosts := syncmodel.Payload{"hosts": {teamTestRecord("h1", "cipher", time.Now(), false)}}

			if _, err := store.ApplyTeamPushRecords(ctx, team.id, team.viewer.ID, hosts); !errors.Is(err, ErrTeamReadOnly) {
				t.Fatalf("viewer push error = %v, want ErrTeamReadOnly", err)
			}
			if count := countTeamRows(t, store, &teamSyncRecordRow{}, "team_id = ?", team.id); count != 0 {
				t.Fatalf("viewer push wrote %d records", count)
			}
			for _, writer := range []teamTestUser{team.member, team.admin, team.owner} {
				if _, err := store.ApplyTeamPushRecords(ctx, team.id, writer.ID, hosts); err != nil {
					t.Fatalf("%s push error = %v", writer.Email, err)
				}
			}

			// 읽기 전용도 보고, 내 칸을 쓰고, 기록·녹화를 올린다.
			if _, payload, err := store.GetTeamSyncSnapshot(ctx, team.id, team.viewer.ID); err != nil || len(payload["hosts"]) != 1 {
				t.Fatalf("viewer snapshot = %#v, %v", payload, err)
			}
			if _, err := store.ApplyTeamPrivateRecords(ctx, team.id, team.viewer.ID, syncmodel.Payload{
				"hostCredentials": {teamTestRecord("h1", "mine", time.Now(), false)},
			}, team.viewer.VaultEpoch); err != nil {
				t.Fatalf("viewer private slot error = %v", err)
			}
			if _, err := store.AppendTeamEvents(ctx, team.id, team.viewer.ID, []TeamEventInput{appTeamEvent("viewer-was-here", time.Now())}); err != nil {
				t.Fatalf("viewer events error = %v", err)
			}
			recordingID := startTestReplay(t, store, team.id, team.viewer)
			putTestSegment(t, store, team.id, team.viewer, recordingID, 0, 10)
		})
	}
}

func TestTeamInvitesAreForAdminsAndCarryARole(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			team := newRoleTestTeam(t, store, "invite-roles")
			input := func(creator teamTestUser, token string, role string) CreateTeamInviteInput {
				return CreateTeamInviteInput{
					TeamID: team.id, CreatedBy: creator.ID, InviteBox: "box", Role: role,
					JoinTokenHash: HashTeamJoinToken(token), ExpiresAt: time.Now().Add(time.Hour),
				}
			}
			live, err := store.CreateTeamInvite(ctx, input(team.owner, "live", ""))
			if err != nil || live.Role != TeamRoleMember {
				t.Fatalf("default role invite = %#v, %v", live, err)
			}

			for _, lower := range []teamTestUser{team.member, team.viewer} {
				if _, err := store.CreateTeamInvite(ctx, input(lower, "x", TeamRoleMember)); !errors.Is(err, ErrTeamAdminOnly) {
					t.Fatalf("%s create invite = %v, want ErrTeamAdminOnly", lower.Email, err)
				}
				if _, err := store.ListTeamInvites(ctx, team.id, lower.ID); !errors.Is(err, ErrTeamAdminOnly) {
					t.Fatalf("%s list invites = %v, want ErrTeamAdminOnly", lower.Email, err)
				}
				if err := store.RevokeTeamInvite(ctx, team.id, lower.ID, live.Code); !errors.Is(err, ErrTeamAdminOnly) {
					t.Fatalf("%s revoke invite = %v, want ErrTeamAdminOnly", lower.Email, err)
				}
			}
			if _, err := store.CreateTeamInvite(ctx, input(team.outsider, "x", "")); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("outsider create invite = %v, want ErrTeamNotFound", err)
			}
			// 링크로는 관리자·소유자를 주지 않는다.
			for _, role := range []string{TeamRoleAdmin, TeamRoleOwner, "boss"} {
				if _, err := store.CreateTeamInvite(ctx, input(team.admin, "x", role)); !errors.Is(err, ErrTeamRoleInvalid) {
					t.Fatalf("invite with role %q = %v, want ErrTeamRoleInvalid", role, err)
				}
			}

			viewerLink, err := store.CreateTeamInvite(ctx, input(team.admin, "viewer-link", TeamRoleViewer))
			if err != nil || viewerLink.Role != TeamRoleViewer {
				t.Fatalf("viewer invite = %#v, %v", viewerLink, err)
			}
			invites, err := store.ListTeamInvites(ctx, team.id, team.admin.ID)
			if err != nil {
				t.Fatalf("admin list invites: %v", err)
			}
			roles := map[string]string{}
			for _, invite := range invites {
				roles[invite.Code] = invite.Role
			}
			if roles[live.Code] != TeamRoleMember || roles[viewerLink.Code] != TeamRoleViewer {
				t.Fatalf("listed invite roles = %#v", roles)
			}

			// 참여 카드가 역할을 미리 알리고, 들어오면 그 역할이다.
			newcomer := createTeamTestUser(t, store, "invite-roles-newcomer@example.com", true)
			info, err := store.GetTeamInviteInfo(ctx, viewerLink.Code, "viewer-link")
			if err != nil || info.Role != TeamRoleViewer {
				t.Fatalf("invite info = %#v, %v", info, err)
			}
			if _, err := store.JoinTeam(ctx, viewerLink.Code, "viewer-link", newcomer.ID); err != nil {
				t.Fatalf("join viewer link: %v", err)
			}
			requireTeamRole(t, store, team.id, newcomer.ID, TeamRoleViewer)

			// 이 칸이 비어 있는 링크(칸이 생기기 전 것 등)는 멤버로 들어온다 — 읽기 전용보다 넓게 주지 않는다는
			// 뜻이 아니라, 모르는 값을 관리자로 읽지 않는다는 뜻이다.
			if err := store.db.Model(&teamInviteRow{}).Where("code = ?", live.Code).Update("role", "").Error; err != nil {
				t.Fatalf("blank role: %v", err)
			}
			late := createTeamTestUser(t, store, "invite-roles-late@example.com", true)
			if info, err := store.GetTeamInviteInfo(ctx, live.Code, "live"); err != nil || info.Role != TeamRoleMember {
				t.Fatalf("blank role info = %#v, %v", info, err)
			}
			if _, err := store.JoinTeam(ctx, live.Code, "live", late.ID); err != nil {
				t.Fatalf("join blank role link: %v", err)
			}
			requireTeamRole(t, store, team.id, late.ID, TeamRoleMember)
			// 행에 관리자가 적혀 있어도(손댄 DB 등) 링크로는 관리자가 되지 않는다.
			forged, err := store.CreateTeamInvite(ctx, input(team.owner, "forged", TeamRoleViewer))
			if err != nil {
				t.Fatalf("create forged link: %v", err)
			}
			if err := store.db.Model(&teamInviteRow{}).Where("code = ?", forged.Code).Update("role", TeamRoleAdmin).Error; err != nil {
				t.Fatalf("forge role: %v", err)
			}
			if info, err := store.GetTeamInviteInfo(ctx, forged.Code, "forged"); err != nil || info.Role != TeamRoleMember {
				t.Fatalf("forged link info = %#v, %v", info, err)
			}
			intruder := createTeamTestUser(t, store, "invite-roles-intruder@example.com", true)
			if _, err := store.JoinTeam(ctx, forged.Code, "forged", intruder.ID); err != nil {
				t.Fatalf("join forged link: %v", err)
			}
			requireTeamRole(t, store, team.id, intruder.ID, TeamRoleMember)

			var joinedViewer *teamServerEvent
			for _, event := range readServerTeamEvents(t, store, team.id, team.owner) {
				if event.Type == teamEventMemberJoined && event.UserID == newcomer.ID {
					event := event
					joinedViewer = &event
				}
			}
			if joinedViewer == nil || joinedViewer.Role != TeamRoleViewer {
				t.Fatalf("viewer join event = %#v", joinedViewer)
			}
		})
	}
}

func TestTeamRoleChangesFollowTheRanks(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			team := newRoleTestTeam(t, store, "role-change")
			set := func(actor teamTestUser, target teamTestUser, role string) error {
				return store.SetTeamMemberRole(ctx, team.id, actor.ID, target.ID, role)
			}
			infoRevision := func() int64 {
				t.Helper()
				gate, err := store.GetTeamGate(ctx, team.id, team.owner.ID)
				if err != nil {
					t.Fatalf("GetTeamGate: %v", err)
				}
				return gate.InfoRevision
			}

			for _, lower := range []teamTestUser{team.member, team.viewer} {
				if err := set(lower, team.viewer, TeamRoleMember); !errors.Is(err, ErrTeamAdminOnly) {
					t.Fatalf("%s changing a role = %v, want ErrTeamAdminOnly", lower.Email, err)
				}
			}
			if err := set(team.outsider, team.viewer, TeamRoleMember); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("outsider changing a role = %v, want ErrTeamNotFound", err)
			}
			// 관리자는 멤버 ↔ 읽기 전용만 바꾼다.
			if err := set(team.admin, team.member, TeamRoleAdmin); !errors.Is(err, ErrTeamOwnerOnly) {
				t.Fatalf("admin promoting to admin = %v, want ErrTeamOwnerOnly", err)
			}
			if err := set(team.admin, team.admin, TeamRoleMember); !errors.Is(err, ErrTeamOwnerOnly) {
				t.Fatalf("admin demoting itself = %v, want ErrTeamOwnerOnly", err)
			}
			if err := set(team.admin, team.owner, TeamRoleMember); !errors.Is(err, ErrTeamRoleInvalid) {
				t.Fatalf("admin changing the owner = %v, want ErrTeamRoleInvalid", err)
			}
			before := infoRevision()
			if err := set(team.admin, team.viewer, TeamRoleMember); err != nil {
				t.Fatalf("admin viewer→member: %v", err)
			}
			requireTeamRole(t, store, team.id, team.viewer.ID, TeamRoleMember)
			if infoRevision() <= before {
				t.Fatal("role change did not bump the team info revision")
			}
			if err := set(team.admin, team.viewer, TeamRoleViewer); err != nil {
				t.Fatalf("admin member→viewer: %v", err)
			}

			// 소유자는 관리자까지 준다. 소유자 자신과 소유자 자리는 넘기기로만 바뀐다.
			for _, role := range []string{TeamRoleOwner, "boss", ""} {
				if err := set(team.owner, team.member, role); !errors.Is(err, ErrTeamRoleInvalid) {
					t.Fatalf("role %q = %v, want ErrTeamRoleInvalid", role, err)
				}
			}
			if err := set(team.owner, team.owner, TeamRoleAdmin); !errors.Is(err, ErrTeamRoleInvalid) {
				t.Fatalf("owner changing itself = %v, want ErrTeamRoleInvalid", err)
			}
			if err := set(team.owner, team.outsider, TeamRoleMember); !errors.Is(err, ErrTeamMemberNotFound) {
				t.Fatalf("changing an outsider = %v, want ErrTeamMemberNotFound", err)
			}
			if err := set(team.owner, team.member, TeamRoleAdmin); err != nil {
				t.Fatalf("owner member→admin: %v", err)
			}
			if err := set(team.owner, team.admin, TeamRoleViewer); err != nil {
				t.Fatalf("owner admin→viewer: %v", err)
			}
			requireTeamRole(t, store, team.id, team.member.ID, TeamRoleAdmin)
			requireTeamRole(t, store, team.id, team.admin.ID, TeamRoleViewer)

			// 같은 역할로 바꾸면 아무것도 남기지 않는다.
			before = infoRevision()
			eventsBefore := len(readServerTeamEvents(t, store, team.id, team.owner))
			if err := set(team.owner, team.member, TeamRoleAdmin); err != nil {
				t.Fatalf("same role: %v", err)
			}
			if infoRevision() != before || len(readServerTeamEvents(t, store, team.id, team.owner)) != eventsBefore {
				t.Fatal("a no-op role change left a trace")
			}

			var changes []teamServerEvent
			for _, event := range readServerTeamEvents(t, store, team.id, team.owner) {
				if event.Type == teamEventRoleChanged {
					changes = append(changes, event)
				}
			}
			want := []struct {
				user string
				by   string
				role string
			}{
				{team.admin.ID, team.owner.ID, TeamRoleAdmin},
				{team.viewer.ID, team.admin.ID, TeamRoleMember},
				{team.viewer.ID, team.admin.ID, TeamRoleViewer},
				{team.member.ID, team.owner.ID, TeamRoleAdmin},
				{team.admin.ID, team.owner.ID, TeamRoleViewer},
			}
			if len(changes) != len(want) {
				t.Fatalf("role events = %#v", changes)
			}
			for index, expected := range want {
				if changes[index].UserID != expected.user || changes[index].ByUserID != expected.by || changes[index].Role != expected.role {
					t.Fatalf("role event %d = %#v, want %#v", index, changes[index], expected)
				}
			}
		})
	}
}

func TestTeamRemovalFollowsTheRanks(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			team := newRoleTestTeam(t, store, "remove-ranks")
			remove := func(actor teamTestUser, target teamTestUser) error {
				return store.RemoveTeamMember(ctx, team.id, actor.ID, target.ID)
			}
			if err := remove(team.member, team.viewer); !errors.Is(err, ErrTeamAdminOnly) {
				t.Fatalf("member removing = %v, want ErrTeamAdminOnly", err)
			}
			if err := remove(team.viewer, team.member); !errors.Is(err, ErrTeamAdminOnly) {
				t.Fatalf("viewer removing = %v, want ErrTeamAdminOnly", err)
			}
			// 관리자는 멤버·읽기 전용만 뺀다.
			if err := remove(team.admin, team.owner); !errors.Is(err, ErrTeamOwnerOnly) {
				t.Fatalf("admin removing the owner = %v, want ErrTeamOwnerOnly", err)
			}
			if err := remove(team.admin, team.admin); !errors.Is(err, ErrTeamOwnerOnly) {
				t.Fatalf("admin removing itself = %v, want ErrTeamOwnerOnly", err)
			}
			if err := remove(team.admin, team.viewer); err != nil {
				t.Fatalf("admin removing the viewer: %v", err)
			}
			if err := remove(team.admin, team.member); err != nil {
				t.Fatalf("admin removing the member: %v", err)
			}
			if err := remove(team.owner, team.admin); err != nil {
				t.Fatalf("owner removing the admin: %v", err)
			}
			if err := remove(team.owner, team.owner); !errors.Is(err, ErrTeamOwnerMustTransfer) {
				t.Fatalf("owner removing itself = %v, want ErrTeamOwnerMustTransfer", err)
			}
			members, err := store.ListTeamMembers(ctx, team.id, team.owner.ID)
			if err != nil || len(members) != 1 {
				t.Fatalf("members left = %#v, %v", members, err)
			}
		})
	}
}

func TestTeamOwnerSuccessionPrefersAdminsThenMembers(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "succession-owner@example.com", true)
			viewer := createTeamTestUser(t, store, "succession-viewer@example.com", true)
			member := createTeamTestUser(t, store, "succession-member@example.com", true)
			admin := createTeamTestUser(t, store, "succession-admin@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			// 들어온 차례는 읽기 전용 → 멤버 → 관리자다. 잇는 차례는 역할이 먼저다.
			joinTestTeamAs(t, store, teamID, owner, viewer, TeamRoleViewer)
			time.Sleep(10 * time.Millisecond)
			joinTestTeamAs(t, store, teamID, owner, member, TeamRoleMember)
			time.Sleep(10 * time.Millisecond)
			joinTestTeamAs(t, store, teamID, owner, admin, TeamRoleMember)
			if err := store.SetTeamMemberRole(ctx, teamID, owner.ID, admin.ID, TeamRoleAdmin); err != nil {
				t.Fatalf("SetTeamMemberRole: %v", err)
			}
			reset := func(user teamTestUser) {
				t.Helper()
				epoch, err := store.GetUserVaultEpoch(ctx, user.ID)
				if err != nil {
					t.Fatalf("GetUserVaultEpoch: %v", err)
				}
				if _, err := store.ResetUserVault(ctx, user.ID, epoch); err != nil {
					t.Fatalf("ResetUserVault(%s): %v", user.Email, err)
				}
			}
			reset(owner)
			requireTeamRole(t, store, teamID, admin.ID, TeamRoleOwner)
			reset(admin)
			requireTeamRole(t, store, teamID, member.ID, TeamRoleOwner)
			reset(member)
			requireTeamRole(t, store, teamID, viewer.ID, TeamRoleOwner)
		})
	}
}

func TestTeamReplaysAreForAdminsAndTheirAuthors(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			team := newRoleTestTeam(t, store, "replay-roles")
			byMember := startTestReplay(t, store, team.id, team.member)
			putTestSegment(t, store, team.id, team.member, byMember, 0, 10)
			if err := store.PutTeamReplayExtra(ctx, team.id, team.member.ID, byMember, "commands", 0, []byte("cmd")); err != nil {
				t.Fatalf("put commands: %v", err)
			}
			byViewer := startTestReplay(t, store, team.id, team.viewer)
			started, err := store.StartTeamReplay(ctx, team.id, team.owner.ID, "8f0c4a52-7c43-4a59-9a6c-6d2b1f0b1a11", "start")
			if err != nil || !started.Viewable {
				t.Fatalf("started = %#v, %v", started, err)
			}
			byOwner := started.RecordingID

			viewable := func(user teamTestUser, query TeamReplayQuery) map[string]bool {
				t.Helper()
				replays, err := store.ListTeamReplays(ctx, team.id, user.ID, query)
				if err != nil {
					t.Fatalf("ListTeamReplays(%s): %v", user.Email, err)
				}
				result := map[string]bool{}
				for _, replay := range replays {
					result[replay.RecordingID] = replay.Viewable
				}
				return result
			}
			// 목록은 모두에게 주되, 볼 수 있는지를 싣는다.
			for _, check := range []struct {
				user teamTestUser
				want map[string]bool
			}{
				{team.viewer, map[string]bool{byMember: false, byViewer: true, byOwner: false}},
				{team.member, map[string]bool{byMember: true, byViewer: false, byOwner: false}},
				{team.admin, map[string]bool{byMember: true, byViewer: true, byOwner: true}},
				{team.owner, map[string]bool{byMember: true, byViewer: true, byOwner: true}},
			} {
				for _, query := range []TeamReplayQuery{{Limit: 10}, {RecordingIDs: []string{byMember, byViewer, byOwner}}} {
					got := viewable(check.user, query)
					for id, want := range check.want {
						if got[id] != want {
							t.Fatalf("%s sees %s viewable=%v, want %v (query %#v)", check.user.Email, id, got[id], want, query)
						}
					}
				}
			}

			// 받기는 서버가 막는다 — 상세·구간·덧붙임 모두.
			for _, lower := range []teamTestUser{team.viewer} {
				if _, err := store.GetTeamReplay(ctx, team.id, lower.ID, byMember); !errors.Is(err, ErrTeamReplayForbidden) {
					t.Fatalf("%s detail = %v, want ErrTeamReplayForbidden", lower.Email, err)
				}
				if _, err := store.ReadTeamReplaySegments(ctx, team.id, lower.ID, byMember, 0, 10, 1<<20); !errors.Is(err, ErrTeamReplayForbidden) {
					t.Fatalf("%s segments = %v, want ErrTeamReplayForbidden", lower.Email, err)
				}
				if _, err := store.ReadTeamReplayExtras(ctx, team.id, lower.ID, byMember, "commands", 0, 10, 1<<20); !errors.Is(err, ErrTeamReplayForbidden) {
					t.Fatalf("%s extras = %v, want ErrTeamReplayForbidden", lower.Email, err)
				}
			}
			if _, err := store.GetTeamReplay(ctx, team.id, team.member.ID, byOwner); !errors.Is(err, ErrTeamReplayForbidden) {
				t.Fatalf("member reading the owner's = %v, want ErrTeamReplayForbidden", err)
			}
			for _, reader := range []teamTestUser{team.member, team.admin, team.owner} {
				detail, err := store.GetTeamReplay(ctx, team.id, reader.ID, byMember)
				if err != nil || !detail.Viewable {
					t.Fatalf("%s detail = %#v, %v", reader.Email, detail.TeamReplay, err)
				}
				if blobs, err := store.ReadTeamReplaySegments(ctx, team.id, reader.ID, byMember, 0, 10, 1<<20); err != nil || len(blobs) != 1 {
					t.Fatalf("%s segments = %d, %v", reader.Email, len(blobs), err)
				}
				if blobs, err := store.ReadTeamReplayExtras(ctx, team.id, reader.ID, byMember, "commands", 0, 10, 1<<20); err != nil || len(blobs) != 1 {
					t.Fatalf("%s extras = %d, %v", reader.Email, len(blobs), err)
				}
			}
			// 역할이 바뀌면 바로 따른다.
			if err := store.SetTeamMemberRole(ctx, team.id, team.owner.ID, team.viewer.ID, TeamRoleAdmin); err != nil {
				t.Fatalf("promote viewer: %v", err)
			}
			if _, err := store.GetTeamReplay(ctx, team.id, team.viewer.ID, byMember); err != nil {
				t.Fatalf("promoted viewer detail: %v", err)
			}
		})
	}
}

func TestTeamRecordVersionsAreForAdminsAndRestoreByPush(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			team := newRoleTestTeam(t, store, "versions")
			base := time.Now().UTC().Add(-time.Hour)
			push := func(user teamTestUser, payload syncmodel.Payload) {
				t.Helper()
				if _, err := store.ApplyTeamPushRecords(ctx, team.id, user.ID, payload); err != nil {
					t.Fatalf("push by %s: %v", user.Email, err)
				}
			}
			push(team.admin, syncmodel.Payload{
				"hosts":  {teamTestRecord("h1", "host-v1", base, false)},
				"groups": {teamTestRecord("g1", "group-v1", base, false)},
			})
			push(team.member, syncmodel.Payload{"hosts": {teamTestRecord("h1", "host-v2", base.Add(time.Minute), false)}})
			// 멤버가 호스트와 그룹을 한 번에 지운다 — 한 묶음이다.
			push(team.member, syncmodel.Payload{
				"hosts":  {teamTestRecord("h1", "", base.Add(2*time.Minute), true)},
				"groups": {teamTestRecord("g1", "", base.Add(2*time.Minute), true)},
			})

			for _, lower := range []teamTestUser{team.member, team.viewer} {
				if _, err := store.ListTeamRecordVersions(ctx, team.id, lower.ID, TeamRecordVersionQuery{}); !errors.Is(err, ErrTeamAdminOnly) {
					t.Fatalf("%s versions = %v, want ErrTeamAdminOnly", lower.Email, err)
				}
			}
			if _, err := store.ListTeamRecordVersions(ctx, team.id, team.outsider.ID, TeamRecordVersionQuery{}); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("outsider versions = %v, want ErrTeamNotFound", err)
			}

			versions, err := store.ListTeamRecordVersions(ctx, team.id, team.admin.ID, TeamRecordVersionQuery{})
			if err != nil || len(versions) != 3 {
				t.Fatalf("versions = %#v, %v", versions, err)
			}
			// 최신부터: 지우기 묶음(g1 v1·h1 v2 — 순서는 올린 차례), 그다음 덮어쓴 h1 v1.
			deleteSet := versions[:2]
			if deleteSet[0].ChangedBy != team.member.ID || deleteSet[1].ChangedBy != team.member.ID ||
				!deleteSet[0].ChangedAt.Equal(deleteSet[1].ChangedAt) || deleteSet[0].ChangedByEmail != team.member.Email {
				t.Fatalf("delete set = %#v", deleteSet)
			}
			payloads := map[string]string{deleteSet[0].RecordID: deleteSet[0].EncryptedPayload, deleteSet[1].RecordID: deleteSet[1].EncryptedPayload}
			if payloads["h1"] != "host-v2" || payloads["g1"] != "group-v1" {
				t.Fatalf("delete set payloads = %#v", payloads)
			}
			overwritten := versions[2]
			if overwritten.RecordID != "h1" || overwritten.EncryptedPayload != "host-v1" || overwritten.UpdatedBy != team.admin.ID ||
				overwritten.UpdatedByEmail != team.admin.Email || overwritten.ChangedBy != team.member.ID || overwritten.DeletedAt != nil {
				t.Fatalf("overwritten version = %#v", overwritten)
			}
			if !(versions[0].Seq > versions[1].Seq && versions[1].Seq > versions[2].Seq) {
				t.Fatalf("versions are not newest first: %#v", versions)
			}

			// 한 레코드만, 커서로 이어서, 양을 정해서.
			onlyHost, err := store.ListTeamRecordVersions(ctx, team.id, team.owner.ID, TeamRecordVersionQuery{Kind: "hosts", RecordID: "h1"})
			if err != nil || len(onlyHost) != 2 || onlyHost[0].EncryptedPayload != "host-v2" || onlyHost[1].EncryptedPayload != "host-v1" {
				t.Fatalf("h1 versions = %#v, %v", onlyHost, err)
			}
			rest, err := store.ListTeamRecordVersions(ctx, team.id, team.owner.ID, TeamRecordVersionQuery{Before: versions[0].Seq})
			if err != nil || len(rest) != 2 || rest[0].Seq != versions[1].Seq {
				t.Fatalf("versions before %d = %#v, %v", versions[0].Seq, rest, err)
			}
			one, err := store.ListTeamRecordVersions(ctx, team.id, team.owner.ID, TeamRecordVersionQuery{Limit: 1})
			if err != nil || len(one) != 1 || one[0].Seq != versions[0].Seq {
				t.Fatalf("one version = %#v, %v", one, err)
			}

			// 되살리기는 보통 올리기다 — 그 판을 새 시각으로. 읽기 전용은 못 한다.
			restore := syncmodel.Payload{
				"hosts":  {teamTestRecord("h1", "host-v2", time.Now(), false)},
				"groups": {teamTestRecord("g1", "group-v1", time.Now(), false)},
			}
			if _, err := store.ApplyTeamPushRecords(ctx, team.id, team.viewer.ID, restore); !errors.Is(err, ErrTeamReadOnly) {
				t.Fatalf("viewer restore = %v, want ErrTeamReadOnly", err)
			}
			push(team.admin, restore)
			_, snapshot, err := store.GetTeamSyncSnapshot(ctx, team.id, team.member.ID)
			if err != nil {
				t.Fatalf("snapshot: %v", err)
			}
			if len(snapshot["hosts"]) != 1 || snapshot["hosts"][0].EncryptedPayload != "host-v2" || snapshot["hosts"][0].DeletedAt != nil ||
				len(snapshot["groups"]) != 1 || snapshot["groups"][0].EncryptedPayload != "group-v1" || snapshot["groups"][0].DeletedAt != nil {
				t.Fatalf("restored snapshot = %#v", snapshot)
			}
			// 지운 표시는 되살릴 내용이 없어 이전 판에 남지 않는다.
			after, err := store.ListTeamRecordVersions(ctx, team.id, team.admin.ID, TeamRecordVersionQuery{})
			if err != nil || len(after) != 3 {
				t.Fatalf("versions after restore = %#v, %v", after, err)
			}
		})
	}
}

// 역할 바꾸기는 팀 행을 잠그므로 올리기·링크 만들기와 차례로 선다 — 바뀌기 전 것은 통과하고 뒤의 것은 막힌다.
// 교착 없이, 막힌 것 말고는 실패가 없어야 한다.
func TestTeamRoleChangesRaceWritesCleanly(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			team := newRoleTestTeam(t, store, "role-race")
			var accepted atomic.Int64
			errs := make(chan error, 64)
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
			base := time.Now()
			for index := 0; index < 10; index++ {
				index := index
				run(func() error {
					_, err := store.ApplyTeamPushRecords(ctx, team.id, team.member.ID, syncmodel.Payload{
						"hosts": {teamTestRecord(fmt.Sprintf("h%d", index), "v", base.Add(time.Duration(index)*time.Millisecond), false)},
					})
					if errors.Is(err, ErrTeamReadOnly) {
						return nil
					}
					if err == nil {
						accepted.Add(1)
					}
					return err
				})
				run(func() error {
					_, err := store.CreateTeamInvite(ctx, CreateTeamInviteInput{
						TeamID: team.id, CreatedBy: team.admin.ID, InviteBox: "box",
						JoinTokenHash: HashTeamJoinToken(fmt.Sprintf("race-%d", index)), ExpiresAt: time.Now().Add(time.Hour),
					})
					if errors.Is(err, ErrTeamAdminOnly) {
						return nil
					}
					return err
				})
			}
			run(func() error {
				return store.SetTeamMemberRole(ctx, team.id, team.owner.ID, team.member.ID, TeamRoleViewer)
			})
			run(func() error {
				return store.SetTeamMemberRole(ctx, team.id, team.owner.ID, team.admin.ID, TeamRoleMember)
			})
			run(func() error { return store.RemoveTeamMember(ctx, team.id, team.owner.ID, team.viewer.ID) })
			close(start)
			workers.Wait()
			close(errs)
			for err := range errs {
				t.Fatalf("concurrent write failed: %v", err)
			}

			requireTeamRole(t, store, team.id, team.member.ID, TeamRoleViewer)
			requireTeamRole(t, store, team.id, team.admin.ID, TeamRoleMember)
			if count := countTeamRows(t, store, &teamSyncRecordRow{}, "team_id = ?", team.id); count != accepted.Load() {
				t.Fatalf("records = %d, accepted pushes = %d", count, accepted.Load())
			}
			if _, err := store.ApplyTeamPushRecords(ctx, team.id, team.member.ID, syncmodel.Payload{
				"hosts": {teamTestRecord("late", "v", time.Now(), false)},
			}); !errors.Is(err, ErrTeamReadOnly) {
				t.Fatalf("push after the demotion = %v, want ErrTeamReadOnly", err)
			}
		})
	}
}
