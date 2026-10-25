package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	syncmodel "dolssh/services/sync-api/internal/sync"
)

// teamTestUser 는 시험용 계정이다. vaultEpoch 는 E2EE 볼트를 만들었을 때의 세대다.
type teamTestUser struct {
	ID         string
	Email      string
	VaultEpoch int64
}

func createTeamTestUser(t *testing.T, store *GormStore, email string, withVault bool) teamTestUser {
	t.Helper()
	ctx := context.Background()
	user, err := store.CreateUser(ctx, email, "hash")
	if err != nil {
		t.Fatalf("CreateUser(%s) error = %v", email, err)
	}
	result := teamTestUser{ID: user.ID, Email: email}
	if withVault {
		result.VaultEpoch = createTeamTestVault(t, store, user.ID)
	}
	return result
}

func createTeamTestVault(t *testing.T, store *GormStore, userID string) int64 {
	t.Helper()
	ctx := context.Background()
	epoch, err := store.GetUserVaultEpoch(ctx, userID)
	if err != nil {
		t.Fatalf("GetUserVaultEpoch() error = %v", err)
	}
	vault, err := store.CreateUserVaultV2(ctx, UserVaultKey{
		UserID:           userID,
		DekVerifier:      "verifier-" + userID,
		WrappedDekBase64: "wrapped-" + userID,
		KdfAlgorithm:     "argon2id",
		KdfSaltBase64:    "salt",
		KdfMemoryKiB:     64 * 1024,
		KdfTimeCost:      3,
		KdfParallelism:   1,
	}, VaultMutationPrecondition{ExpectedEpoch: epoch})
	if err != nil {
		t.Fatalf("CreateUserVaultV2() error = %v", err)
	}
	return vault.Epoch
}

func createTestTeam(t *testing.T, store *GormStore, owner teamTestUser, name string) string {
	t.Helper()
	teamID := uuid.NewString()
	if _, err := store.CreateTeam(context.Background(), CreateTeamInput{
		TeamID:         teamID,
		Name:           name,
		OwnerID:        owner.ID,
		WrappedTeamDek: "team-key-for-" + owner.ID,
		VaultEpoch:     owner.VaultEpoch,
	}); err != nil {
		t.Fatalf("CreateTeam() error = %v", err)
	}
	return teamID
}

// inviteTestMember 는 링크를 만들어 member 를 참여시키고 사본까지 올린다.
func inviteTestMember(t *testing.T, store *GormStore, teamID string, inviter teamTestUser, member teamTestUser) {
	t.Helper()
	ctx := context.Background()
	token := "join-token-" + member.ID
	invite, err := store.CreateTeamInvite(ctx, CreateTeamInviteInput{
		TeamID:        teamID,
		CreatedBy:     inviter.ID,
		InviteBox:     "box",
		JoinTokenHash: HashTeamJoinToken(token),
		ExpiresAt:     time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("CreateTeamInvite() error = %v", err)
	}
	if _, err := store.JoinTeam(ctx, invite.Code, token, member.ID); err != nil {
		t.Fatalf("JoinTeam(%s) error = %v", member.Email, err)
	}
	if err := store.PutTeamMemberKey(ctx, teamID, member.ID, "team-key-for-"+member.ID, member.VaultEpoch); err != nil {
		t.Fatalf("PutTeamMemberKey(%s) error = %v", member.Email, err)
	}
}

func teamTestRecord(id string, payload string, at time.Time, deleted bool) syncmodel.Record {
	record := syncmodel.Record{
		ID:               id,
		EncryptedPayload: payload,
		UpdatedAt:        at.UTC().Format(syncTimestampLayout),
	}
	if deleted {
		value := at.UTC().Format(syncTimestampLayout)
		record.DeletedAt = &value
	}
	return record
}

func countTeamRows(t *testing.T, store *GormStore, model any, where string, args ...any) int64 {
	t.Helper()
	var count int64
	if err := store.db.Model(model).Where(where, args...).Count(&count).Error; err != nil {
		t.Fatalf("count rows: %v", err)
	}
	return count
}

func requireTeamRole(t *testing.T, store *GormStore, teamID string, userID string, want string) {
	t.Helper()
	var member teamMemberRow
	if err := store.db.Where("team_id = ? AND user_id = ?", teamID, userID).Take(&member).Error; err != nil {
		t.Fatalf("read member %s: %v", userID, err)
	}
	if member.Role != want {
		t.Fatalf("member %s role = %q, want %q", userID, member.Role, want)
	}
}

func TestTeamCreateRequiresE2EEVaultAndCurrentEpoch(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			noVault := createTeamTestUser(t, store, "team-novault@example.com", false)
			owner := createTeamTestUser(t, store, "team-owner@example.com", true)

			input := CreateTeamInput{TeamID: uuid.NewString(), Name: "Acme", OwnerID: noVault.ID, WrappedTeamDek: "k"}
			if _, err := store.CreateTeam(ctx, input); !errors.Is(err, ErrTeamVaultRequired) {
				t.Fatalf("CreateTeam without vault error = %v, want ErrTeamVaultRequired", err)
			}

			input.OwnerID = owner.ID
			input.VaultEpoch = owner.VaultEpoch + 7
			if _, err := store.CreateTeam(ctx, input); !errors.Is(err, ErrVaultEpochMismatch) {
				t.Fatalf("CreateTeam with stale epoch error = %v, want ErrVaultEpochMismatch", err)
			}

			input.VaultEpoch = owner.VaultEpoch
			created, err := store.CreateTeam(ctx, input)
			if err != nil {
				t.Fatalf("CreateTeam() error = %v", err)
			}
			if created.Role != TeamRoleOwner || created.WrappedTeamDek != "k" || created.MemberCount != 1 {
				t.Fatalf("created team = %#v", created)
			}
			if _, err := store.CreateTeam(ctx, input); !errors.Is(err, ErrTeamExists) {
				t.Fatalf("CreateTeam same id error = %v, want ErrTeamExists", err)
			}

			teams, err := store.ListTeamsForUser(ctx, owner.ID)
			if err != nil || len(teams) != 1 {
				t.Fatalf("ListTeamsForUser() = %#v, %v", teams, err)
			}
			if teams[0].ID != input.TeamID || teams[0].Name != "Acme" || teams[0].Role != TeamRoleOwner || teams[0].MemberCount != 1 || teams[0].WrappedTeamDek != "k" {
				t.Fatalf("listed team = %#v", teams[0])
			}
		})
	}
}

func TestTeamInviteJoinFlow(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "invite-owner@example.com", true)
			joiner := createTeamTestUser(t, store, "invite-joiner@example.com", true)
			second := createTeamTestUser(t, store, "invite-second@example.com", true)
			noVault := createTeamTestUser(t, store, "invite-novault@example.com", false)
			teamID := createTestTeam(t, store, owner, "Acme Infra")

			token := "secret-join-token"
			invite, err := store.CreateTeamInvite(ctx, CreateTeamInviteInput{
				TeamID:        teamID,
				CreatedBy:     owner.ID,
				InviteBox:     "sealed-team-key",
				JoinTokenHash: HashTeamJoinToken(token),
				ExpiresAt:     time.Now().Add(time.Hour),
			})
			if err != nil {
				t.Fatalf("CreateTeamInvite() error = %v", err)
			}

			// 토큰이 없거나 틀리면 정보도 주지 않는다 — 번호만 아는 사람은 초대한 사람을 못 본다.
			for _, presented := range []string{"", "wrong-token"} {
				if _, err := store.GetTeamInviteInfo(ctx, invite.Code, presented); !errors.Is(err, ErrTeamInviteInvalid) {
					t.Fatalf("GetTeamInviteInfo(%q) error = %v, want ErrTeamInviteInvalid", presented, err)
				}
				if _, err := store.JoinTeam(ctx, invite.Code, presented, joiner.ID); !errors.Is(err, ErrTeamInviteInvalid) {
					t.Fatalf("JoinTeam(%q) error = %v, want ErrTeamInviteInvalid", presented, err)
				}
			}
			info, err := store.GetTeamInviteInfo(ctx, invite.Code, token)
			if err != nil {
				t.Fatalf("GetTeamInviteInfo() error = %v", err)
			}
			if info.TeamID != teamID || info.TeamName != "Acme Infra" || info.InviterEmail != owner.Email || info.MemberCount != 1 {
				t.Fatalf("invite info = %#v", info)
			}

			if _, err := store.JoinTeam(ctx, invite.Code, token, noVault.ID); !errors.Is(err, ErrTeamVaultRequired) {
				t.Fatalf("JoinTeam without vault error = %v, want ErrTeamVaultRequired", err)
			}

			joined, err := store.JoinTeam(ctx, invite.Code, token, joiner.ID)
			if err != nil {
				t.Fatalf("JoinTeam() error = %v", err)
			}
			if joined.TeamID != teamID || joined.InviteBox != "sealed-team-key" || joined.Rejoined {
				t.Fatalf("join result = %#v", joined)
			}
			teams, err := store.ListTeamsForUser(ctx, joiner.ID)
			if err != nil || len(teams) != 1 || teams[0].WrappedTeamDek != "" || teams[0].Role != TeamRoleMember || teams[0].MemberCount != 2 {
				t.Fatalf("joiner teams before key = %#v, %v", teams, err)
			}

			// 사본을 올리기 전에 끊겼으면 상자를 다시 받는다. 들어온 수는 늘지 않는다.
			again, err := store.JoinTeam(ctx, invite.Code, token, joiner.ID)
			if err != nil || !again.Rejoined || again.InviteBox != "sealed-team-key" {
				t.Fatalf("rejoin before key = %#v, %v", again, err)
			}
			if err := store.PutTeamMemberKey(ctx, teamID, joiner.ID, "joiner-copy", joiner.VaultEpoch+1); !errors.Is(err, ErrVaultEpochMismatch) {
				t.Fatalf("PutTeamMemberKey stale epoch error = %v, want ErrVaultEpochMismatch", err)
			}
			if err := store.PutTeamMemberKey(ctx, teamID, joiner.ID, "joiner-copy", joiner.VaultEpoch); err != nil {
				t.Fatalf("PutTeamMemberKey() error = %v", err)
			}
			if _, err := store.JoinTeam(ctx, invite.Code, token, joiner.ID); !errors.Is(err, ErrTeamAlreadyMember) {
				t.Fatalf("JoinTeam after key error = %v, want ErrTeamAlreadyMember", err)
			}
			teams, err = store.ListTeamsForUser(ctx, joiner.ID)
			if err != nil || len(teams) != 1 || teams[0].WrappedTeamDek != "joiner-copy" {
				t.Fatalf("joiner teams after key = %#v, %v", teams, err)
			}

			// 한 링크로 여러 명이 들어온다(인원 제한 없음).
			if _, err := store.JoinTeam(ctx, invite.Code, token, second.ID); err != nil {
				t.Fatalf("second JoinTeam() error = %v", err)
			}
			invites, err := store.ListTeamInvites(ctx, teamID, owner.ID)
			if err != nil || len(invites) != 1 || invites[0].UseCount != 2 || !invites[0].Active || invites[0].CreatedByEmail != owner.Email {
				t.Fatalf("invites = %#v, %v", invites, err)
			}

			members, err := store.ListTeamMembers(ctx, teamID, second.ID)
			if err != nil || len(members) != 3 {
				t.Fatalf("ListTeamMembers() = %#v, %v", members, err)
			}
			if members[0].UserID != owner.ID || members[0].Role != TeamRoleOwner || !members[0].HasKey {
				t.Fatalf("first member = %#v", members[0])
			}
			if members[1].UserID != joiner.ID || members[1].AddedByEmail != owner.Email || !members[1].HasKey {
				t.Fatalf("second member = %#v", members[1])
			}
			if members[2].UserID != second.ID || members[2].HasKey {
				t.Fatalf("third member = %#v", members[2])
			}
		})
	}
}

func TestTeamInviteRejectsExpiredAndRevokedLinks(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "expire-owner@example.com", true)
			joiner := createTeamTestUser(t, store, "expire-joiner@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")

			expired, err := store.CreateTeamInvite(ctx, CreateTeamInviteInput{
				TeamID: teamID, CreatedBy: owner.ID, InviteBox: "box", JoinTokenHash: HashTeamJoinToken("t1"),
				ExpiresAt: time.Now().Add(-time.Minute),
			})
			if err != nil {
				t.Fatalf("CreateTeamInvite(expired) error = %v", err)
			}
			if _, err := store.JoinTeam(ctx, expired.Code, "t1", joiner.ID); !errors.Is(err, ErrTeamInviteInvalid) {
				t.Fatalf("join expired error = %v, want ErrTeamInviteInvalid", err)
			}

			revoked, err := store.CreateTeamInvite(ctx, CreateTeamInviteInput{
				TeamID: teamID, CreatedBy: owner.ID, InviteBox: "box", JoinTokenHash: HashTeamJoinToken("t2"),
				ExpiresAt: time.Now().Add(time.Hour),
			})
			if err != nil {
				t.Fatalf("CreateTeamInvite() error = %v", err)
			}
			if err := store.RevokeTeamInvite(ctx, teamID, owner.ID, revoked.Code); err != nil {
				t.Fatalf("RevokeTeamInvite() error = %v", err)
			}
			if _, err := store.GetTeamInviteInfo(ctx, revoked.Code, "t2"); !errors.Is(err, ErrTeamInviteInvalid) {
				t.Fatalf("info revoked error = %v, want ErrTeamInviteInvalid", err)
			}
			if _, err := store.JoinTeam(ctx, revoked.Code, "t2", joiner.ID); !errors.Is(err, ErrTeamInviteInvalid) {
				t.Fatalf("join revoked error = %v, want ErrTeamInviteInvalid", err)
			}
			// 취소하면 상자가 그 자리에서 지워진다.
			if count := countTeamRows(t, store, &teamInviteRow{}, "code = ? AND invite_box IS NOT NULL", revoked.Code); count != 0 {
				t.Fatalf("revoked invite still has a box")
			}
			if err := store.RevokeTeamInvite(ctx, teamID, joiner.ID, revoked.Code); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("revoke by non-member error = %v, want ErrTeamNotFound", err)
			}

			// 기한이 지난 상자는 정리 작업이 지운다. 아직 살아 있는 링크의 상자는 남는다.
			live, err := store.CreateTeamInvite(ctx, CreateTeamInviteInput{
				TeamID: teamID, CreatedBy: owner.ID, InviteBox: "box", JoinTokenHash: HashTeamJoinToken("t3"),
				ExpiresAt: time.Now().Add(time.Hour),
			})
			if err != nil {
				t.Fatalf("CreateTeamInvite(live) error = %v", err)
			}
			store.allowImmediateSweep(teamInviteRow{}.TableName())
			store.sweepExpiredTeamInviteBoxes()
			if count := countTeamRows(t, store, &teamInviteRow{}, "code = ? AND invite_box IS NOT NULL", expired.Code); count != 0 {
				t.Fatalf("expired invite box survived the sweep")
			}
			if count := countTeamRows(t, store, &teamInviteRow{}, "code = ? AND invite_box IS NOT NULL", live.Code); count != 1 {
				t.Fatalf("live invite box was swept")
			}
		})
	}
}

// 잠근 비밀값은 링크를 쓸 수 있는 동안만 멤버에게 간다 — 취소·기한·멤버 제거와 함께 지워진다.
func TestTeamInviteSealedSecretLivesWithTheLink(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "sealed-owner@example.com", true)
			member := createTeamTestUser(t, store, "sealed-member@example.com", true)
			outsider := createTeamTestUser(t, store, "sealed-outsider@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			inviteTestMember(t, store, teamID, owner, member)

			create := func(token string, sealed string, lifetime time.Duration) TeamInvite {
				t.Helper()
				invite, err := store.CreateTeamInvite(ctx, CreateTeamInviteInput{
					TeamID: teamID, CreatedBy: owner.ID, InviteBox: "box", SealedSecret: sealed,
					JoinTokenHash: HashTeamJoinToken(token), ExpiresAt: time.Now().Add(lifetime),
				})
				if err != nil {
					t.Fatalf("CreateTeamInvite(%s) error = %v", token, err)
				}
				return invite
			}
			live := create("live", "sealed-live", time.Hour)
			if live.SealedSecret != "sealed-live" {
				t.Fatalf("created invite = %#v", live)
			}
			// 이 칸을 모르는 앱이 만든 링크 — 다시 복사할 수 없을 뿐 그대로 쓴다.
			plain := create("plain", "", time.Hour)
			expired := create("expired", "sealed-expired", -time.Minute)
			if expired.SealedSecret != "" {
				t.Fatalf("expired invite came back with its sealed secret")
			}
			revoked := create("revoked", "sealed-revoked", time.Hour)
			if err := store.RevokeTeamInvite(ctx, teamID, member.ID, revoked.Code); err != nil {
				t.Fatalf("RevokeTeamInvite() error = %v", err)
			}

			sealedByCode := func(actor teamTestUser) map[string]string {
				t.Helper()
				invites, err := store.ListTeamInvites(ctx, teamID, actor.ID)
				if err != nil {
					t.Fatalf("ListTeamInvites() error = %v", err)
				}
				sealed := map[string]string{}
				for _, invite := range invites {
					sealed[invite.Code] = invite.SealedSecret
				}
				return sealed
			}
			// 만든 사람이 아닌 멤버도 받는다. 기한이 지난 것은 정리 전이어도 내주지 않는다.
			for _, actor := range []teamTestUser{owner, member} {
				sealed := sealedByCode(actor)
				if sealed[live.Code] != "sealed-live" || sealed[plain.Code] != "" || sealed[expired.Code] != "" || sealed[revoked.Code] != "" {
					t.Fatalf("sealed secrets for %s = %#v", actor.Email, sealed)
				}
			}
			if _, err := store.ListTeamInvites(ctx, teamID, outsider.ID); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("outsider list error = %v, want ErrTeamNotFound", err)
			}
			// 취소하면 그 자리에서, 기한이 지나면 정리 작업이 지운다.
			if count := countTeamRows(t, store, &teamInviteRow{}, "code = ? AND sealed_secret IS NOT NULL", revoked.Code); count != 0 {
				t.Fatalf("revoked invite kept its sealed secret")
			}
			store.allowImmediateSweep(teamInviteRow{}.TableName())
			store.sweepExpiredTeamInviteBoxes()
			if count := countTeamRows(t, store, &teamInviteRow{}, "code = ? AND sealed_secret IS NOT NULL", expired.Code); count != 0 {
				t.Fatalf("expired invite kept its sealed secret after the sweep")
			}
			if count := countTeamRows(t, store, &teamInviteRow{}, "code = ? AND sealed_secret IS NOT NULL", live.Code); count != 1 {
				t.Fatalf("live invite lost its sealed secret in the sweep")
			}
			// 참여 응답에는 상자만 있다.
			joined, err := store.JoinTeam(ctx, live.Code, "live", outsider.ID)
			if err != nil || joined.InviteBox != "box" {
				t.Fatalf("JoinTeam() = %#v, %v", joined, err)
			}
		})
	}
}

func TestTeamOwnerOnlyActionsAndMembership(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "perm-owner@example.com", true)
			member := createTeamTestUser(t, store, "perm-member@example.com", true)
			outsider := createTeamTestUser(t, store, "perm-outsider@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			inviteTestMember(t, store, teamID, owner, member)

			if err := store.RenameTeam(ctx, teamID, member.ID, "Mine"); !errors.Is(err, ErrTeamOwnerOnly) {
				t.Fatalf("member rename error = %v, want ErrTeamOwnerOnly", err)
			}
			if err := store.TransferTeamOwnership(ctx, teamID, member.ID, member.ID); !errors.Is(err, ErrTeamOwnerOnly) {
				t.Fatalf("member transfer error = %v, want ErrTeamOwnerOnly", err)
			}
			if _, err := store.DeleteTeam(ctx, teamID, member.ID); !errors.Is(err, ErrTeamOwnerOnly) {
				t.Fatalf("member delete error = %v, want ErrTeamOwnerOnly", err)
			}
			if err := store.RemoveTeamMember(ctx, teamID, member.ID, owner.ID); !errors.Is(err, ErrTeamOwnerOnly) {
				t.Fatalf("member remove error = %v, want ErrTeamOwnerOnly", err)
			}

			// 멤버가 아니면 팀이 없는 것과 같다.
			if err := store.RenameTeam(ctx, teamID, outsider.ID, "X"); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("outsider rename error = %v, want ErrTeamNotFound", err)
			}
			if _, err := store.ListTeamMembers(ctx, teamID, outsider.ID); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("outsider members error = %v, want ErrTeamNotFound", err)
			}
			if _, err := store.ApplyTeamPushRecords(ctx, teamID, outsider.ID, syncmodel.Payload{"hosts": {teamTestRecord("h", "p", time.Now(), false)}}); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("outsider push error = %v, want ErrTeamNotFound", err)
			}
			if _, _, err := store.GetTeamSyncSnapshot(ctx, teamID, outsider.ID); !errors.Is(err, ErrTeamNotFound) {
				t.Fatalf("outsider snapshot error = %v, want ErrTeamNotFound", err)
			}
			if gate, err := store.GetTeamGate(ctx, teamID, outsider.ID); err != nil || gate.Member {
				t.Fatalf("outsider gate = %#v, %v", gate, err)
			}

			// 다른 멤버가 있으면 소유자는 나가지도, 자기를 빼지도 못한다 — 먼저 넘긴다.
			if _, err := store.LeaveTeam(ctx, teamID, owner.ID); !errors.Is(err, ErrTeamOwnerMustTransfer) {
				t.Fatalf("owner leave error = %v, want ErrTeamOwnerMustTransfer", err)
			}
			if err := store.RemoveTeamMember(ctx, teamID, owner.ID, owner.ID); !errors.Is(err, ErrTeamOwnerMustTransfer) {
				t.Fatalf("owner self-remove error = %v, want ErrTeamOwnerMustTransfer", err)
			}
			if err := store.TransferTeamOwnership(ctx, teamID, owner.ID, outsider.ID); !errors.Is(err, ErrTeamMemberNotFound) {
				t.Fatalf("transfer to outsider error = %v, want ErrTeamMemberNotFound", err)
			}

			if err := store.RenameTeam(ctx, teamID, owner.ID, "Acme Infra"); err != nil {
				t.Fatalf("owner rename error = %v", err)
			}
			if err := store.TransferTeamOwnership(ctx, teamID, owner.ID, member.ID); err != nil {
				t.Fatalf("transfer error = %v", err)
			}
			requireTeamRole(t, store, teamID, member.ID, TeamRoleOwner)
			requireTeamRole(t, store, teamID, owner.ID, TeamRoleMember)
			teams, err := store.ListTeamsForUser(ctx, owner.ID)
			if err != nil || len(teams) != 1 || teams[0].Name != "Acme Infra" || teams[0].Role != TeamRoleMember {
				t.Fatalf("teams after rename/transfer = %#v, %v", teams, err)
			}
			// 넘긴 뒤에는 옛 소유자가 그냥 나갈 수 있다.
			if result, err := store.LeaveTeam(ctx, teamID, owner.ID); err != nil || result.TeamDeleted {
				t.Fatalf("former owner leave = %#v, %v", result, err)
			}
		})
	}
}

func TestTeamRemovalIsAtomicAndRevokesEveryLink(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "remove-owner@example.com", true)
			member := createTeamTestUser(t, store, "remove-member@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			inviteTestMember(t, store, teamID, owner, member)
			if _, err := store.ApplyTeamPrivateRecords(ctx, teamID, member.ID, syncmodel.Payload{
				"hostPrefs": {teamTestRecord("pref-1", "mine", time.Now(), false)},
			}, member.VaultEpoch); err != nil {
				t.Fatalf("ApplyTeamPrivateRecords() error = %v", err)
			}
			knownToken := "member-knows-this"
			known, err := store.CreateTeamInvite(ctx, CreateTeamInviteInput{
				TeamID: teamID, CreatedBy: member.ID, InviteBox: "box", SealedSecret: "sealed",
				JoinTokenHash: HashTeamJoinToken(knownToken), ExpiresAt: time.Now().Add(time.Hour),
			})
			if err != nil {
				t.Fatalf("CreateTeamInvite() error = %v", err)
			}

			// 제거 도중(링크 취소 단계)에서 실패하면 아무것도 바뀌지 않아야 한다.
			callbackName := "test:fail_team_invite_update"
			if err := store.db.Callback().Update().Before("gorm:update").Register(callbackName, func(db *gorm.DB) {
				if db.Statement.Table == (teamInviteRow{}).TableName() {
					_ = db.AddError(errors.New("injected failure"))
				}
			}); err != nil {
				t.Fatalf("register callback: %v", err)
			}
			if err := store.RemoveTeamMember(ctx, teamID, owner.ID, member.ID); err == nil {
				t.Fatal("RemoveTeamMember with injected failure succeeded")
			}
			if err := store.db.Callback().Update().Remove(callbackName); err != nil {
				t.Fatalf("remove callback: %v", err)
			}
			if gate, err := store.GetTeamGate(ctx, teamID, member.ID); err != nil || !gate.Member {
				t.Fatalf("member gone after failed removal: %#v, %v", gate, err)
			}
			if count := countTeamRows(t, store, &teamMemberPrivateRow{}, "team_id = ? AND user_id = ?", teamID, member.ID); count != 1 {
				t.Fatalf("private records after failed removal = %d, want 1", count)
			}
			if count := countTeamRows(t, store, &teamInviteRow{}, "code = ? AND invite_box IS NOT NULL AND sealed_secret IS NOT NULL AND revoked_at IS NULL", known.Code); count != 1 {
				t.Fatalf("invite changed after failed removal")
			}

			if err := store.RemoveTeamMember(ctx, teamID, owner.ID, member.ID); err != nil {
				t.Fatalf("RemoveTeamMember() error = %v", err)
			}
			if gate, err := store.GetTeamGate(ctx, teamID, member.ID); err != nil || gate.Member {
				t.Fatalf("removed member still has access: %#v, %v", gate, err)
			}
			if count := countTeamRows(t, store, &teamMemberPrivateRow{}, "team_id = ? AND user_id = ?", teamID, member.ID); count != 0 {
				t.Fatalf("private records survived removal: %d", count)
			}
			if count := countTeamRows(t, store, &teamInviteRow{}, "team_id = ? AND (invite_box IS NOT NULL OR sealed_secret IS NOT NULL OR revoked_at IS NULL)", teamID); count != 0 {
				t.Fatalf("%d invites still usable after removal", count)
			}
			// 뺀 사람이 아는 링크로는 되돌아오지 못한다.
			if _, err := store.JoinTeam(ctx, known.Code, knownToken, member.ID); !errors.Is(err, ErrTeamInviteInvalid) {
				t.Fatalf("rejoin with old link error = %v, want ErrTeamInviteInvalid", err)
			}
			if err := store.RemoveTeamMember(ctx, teamID, owner.ID, member.ID); !errors.Is(err, ErrTeamMemberNotFound) {
				t.Fatalf("remove twice error = %v, want ErrTeamMemberNotFound", err)
			}
		})
	}
}

func TestTeamLastMemberLeavingDeletesTheTeam(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "last-owner@example.com", true)
			member := createTeamTestUser(t, store, "last-member@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			inviteTestMember(t, store, teamID, owner, member)
			if _, err := store.ApplyTeamPushRecords(ctx, teamID, owner.ID, syncmodel.Payload{"hosts": {teamTestRecord("h1", "v1", time.Now(), false)}}); err != nil {
				t.Fatalf("push error = %v", err)
			}

			if result, err := store.LeaveTeam(ctx, teamID, member.ID); err != nil || result.TeamDeleted {
				t.Fatalf("member leave = %#v, %v", result, err)
			}
			if count := countTeamRows(t, store, &teamInviteRow{}, "team_id = ? AND invite_box IS NOT NULL", teamID); count != 0 {
				t.Fatalf("links survived a member leaving: %d", count)
			}
			result, err := store.LeaveTeam(ctx, teamID, owner.ID)
			if err != nil || !result.TeamDeleted {
				t.Fatalf("last member leave = %#v, %v", result, err)
			}
			for _, model := range []any{&teamRow{}, &teamMemberRow{}, &teamInviteRow{}, &teamSyncRecordRow{}, &teamRecordHistoryRow{}, &teamMemberPrivateRow{}} {
				column := "team_id"
				if _, ok := model.(*teamRow); ok {
					column = "id"
				}
				if count := countTeamRows(t, store, model, column+" = ?", teamID); count != 0 {
					t.Fatalf("%T rows left after the team was deleted: %d", model, count)
				}
			}
		})
	}
}

func TestTeamDeleteByOwnerRemovesEverythingAndReportsMembers(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "delete-owner@example.com", true)
			member := createTeamTestUser(t, store, "delete-member@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			inviteTestMember(t, store, teamID, owner, member)

			memberIDs, err := store.DeleteTeam(ctx, teamID, owner.ID)
			if err != nil {
				t.Fatalf("DeleteTeam() error = %v", err)
			}
			if len(memberIDs) != 2 {
				t.Fatalf("former members = %v, want both", memberIDs)
			}
			for _, user := range []teamTestUser{owner, member} {
				teams, err := store.ListTeamsForUser(ctx, user.ID)
				if err != nil || len(teams) != 0 {
					t.Fatalf("teams of %s after delete = %#v, %v", user.Email, teams, err)
				}
			}
		})
	}
}

func TestTeamVaultResetAndAccountDeletionLeaveEveryTeam(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			alice := createTeamTestUser(t, store, "succ-alice@example.com", true)
			bob := createTeamTestUser(t, store, "succ-bob@example.com", true)
			carol := createTeamTestUser(t, store, "succ-carol@example.com", true)

			shared := createTestTeam(t, store, alice, "Shared")
			inviteTestMember(t, store, shared, alice, bob)
			// 가장 먼저 들어온 멤버가 잇는다 — carol 은 bob 보다 늦게 들어온다.
			time.Sleep(10 * time.Millisecond)
			inviteTestMember(t, store, shared, alice, carol)
			solo := createTestTeam(t, store, alice, "Solo")
			bobs := createTestTeam(t, store, bob, "Bob's")
			inviteTestMember(t, store, bobs, bob, alice)

			epoch, err := store.GetUserVaultEpoch(ctx, alice.ID)
			if err != nil {
				t.Fatalf("GetUserVaultEpoch() error = %v", err)
			}
			if _, err := store.ResetUserVault(ctx, alice.ID, epoch); err != nil {
				t.Fatalf("ResetUserVault() error = %v", err)
			}
			if teams, err := store.ListTeamsForUser(ctx, alice.ID); err != nil || len(teams) != 0 {
				t.Fatalf("alice teams after reset = %#v, %v", teams, err)
			}
			requireTeamRole(t, store, shared, bob.ID, TeamRoleOwner)
			requireTeamRole(t, store, shared, carol.ID, TeamRoleMember)
			if count := countTeamRows(t, store, &teamRow{}, "id = ?", solo); count != 0 {
				t.Fatalf("alice's solo team survived her reset")
			}
			requireTeamRole(t, store, bobs, bob.ID, TeamRoleOwner)
			if count := countTeamRows(t, store, &teamMemberRow{}, "team_id = ?", bobs); count != 1 {
				t.Fatalf("bob's team members after alice reset = %d, want 1", count)
			}

			if err := store.DeleteUserData(ctx, bob.ID); err != nil {
				t.Fatalf("DeleteUserData() error = %v", err)
			}
			requireTeamRole(t, store, shared, carol.ID, TeamRoleOwner)
			if count := countTeamRows(t, store, &teamRow{}, "id = ?", bobs); count != 0 {
				t.Fatalf("bob's team survived his account deletion")
			}
			if count := countTeamRows(t, store, &teamMemberRow{}, "user_id = ?", bob.ID); count != 0 {
				t.Fatalf("bob still a member somewhere after account deletion")
			}
		})
	}
}

func TestTeamPushKeepsPreviousVersions(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "history-owner@example.com", true)
			member := createTeamTestUser(t, store, "history-member@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			inviteTestMember(t, store, teamID, owner, member)
			base := time.Date(2026, 10, 19, 1, 0, 0, 0, time.UTC)

			first := syncmodel.Payload{"hosts": {teamTestRecord("h1", "v1", base, false)}}
			revision, err := store.ApplyTeamPushRecords(ctx, teamID, owner.ID, first)
			if err != nil || revision != 1 {
				t.Fatalf("first push = %d, %v", revision, err)
			}
			// 같은 것을 다시 올리면 변경이 아니다 — 리비전도 이전 판도 그대로다.
			if revision, err := store.ApplyTeamPushRecords(ctx, teamID, owner.ID, first); err != nil || revision != 1 {
				t.Fatalf("same push = %d, %v", revision, err)
			}
			if revision, err := store.ApplyTeamPushRecords(ctx, teamID, member.ID, syncmodel.Payload{"hosts": {teamTestRecord("h1", "v2", base.Add(time.Minute), false)}}); err != nil || revision != 2 {
				t.Fatalf("member edit = %d, %v", revision, err)
			}
			// 더 오래된 쓰기는 진다.
			if revision, err := store.ApplyTeamPushRecords(ctx, teamID, owner.ID, syncmodel.Payload{"hosts": {teamTestRecord("h1", "stale", base.Add(-time.Minute), false)}}); err != nil || revision != 2 {
				t.Fatalf("stale push = %d, %v", revision, err)
			}
			if revision, err := store.ApplyTeamPushRecords(ctx, teamID, member.ID, syncmodel.Payload{"hosts": {teamTestRecord("h1", "", base.Add(2*time.Minute), true)}}); err != nil || revision != 3 {
				t.Fatalf("delete push = %d, %v", revision, err)
			}

			var history []teamRecordHistoryRow
			if err := store.db.Where("team_id = ?", teamID).Order("seq ASC").Find(&history).Error; err != nil {
				t.Fatalf("read history: %v", err)
			}
			if len(history) != 2 {
				t.Fatalf("history rows = %d, want 2: %#v", len(history), history)
			}
			if history[0].EncryptedPayload != "v1" || history[0].UpdatedBy != owner.ID || history[0].ChangedBy != member.ID || history[0].RecordID != "h1" {
				t.Fatalf("first previous version = %#v", history[0])
			}
			if history[1].EncryptedPayload != "v2" || history[1].UpdatedBy != member.ID || history[1].ChangedBy != member.ID {
				t.Fatalf("second previous version = %#v", history[1])
			}

			revision, payload, err := store.GetTeamSyncSnapshot(ctx, teamID, owner.ID)
			if err != nil || revision != 3 {
				t.Fatalf("snapshot = %d, %v", revision, err)
			}
			hosts := payload["hosts"]
			if len(hosts) != 1 || hosts[0].DeletedAt == nil || hosts[0].EncryptedPayload != "" {
				t.Fatalf("snapshot hosts = %#v", hosts)
			}
			var stored teamSyncRecordRow
			if err := store.db.Where("team_id = ? AND id = ?", teamID, "h1").Take(&stored).Error; err != nil || stored.UpdatedBy != member.ID {
				t.Fatalf("stored record = %#v, %v", stored, err)
			}
		})
	}
}

func TestTeamHistorySweepRemovesExpiredVersions(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			owner := createTeamTestUser(t, store, "sweep-owner@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			store.SetTeamHistoryRetention(time.Hour)
			now := time.Now().UTC()
			for index, changedAt := range []time.Time{now.Add(-2 * time.Hour), now.Add(-time.Minute)} {
				row := teamRecordHistoryRow{
					TeamID: teamID, Kind: "hosts", RecordID: fmt.Sprintf("h%d", index), EncryptedPayload: "old",
					UpdatedAt: changedAt, UpdatedBy: owner.ID, ChangedBy: owner.ID, ChangedAt: changedAt,
				}
				if err := store.db.Create(&row).Error; err != nil {
					t.Fatalf("insert history: %v", err)
				}
			}
			store.allowImmediateSweep(teamRecordHistoryRow{}.TableName())
			store.sweepTeamRecordHistory()
			var left []teamRecordHistoryRow
			if err := store.db.Where("team_id = ?", teamID).Find(&left).Error; err != nil {
				t.Fatalf("read history: %v", err)
			}
			if len(left) != 1 || left[0].RecordID != "h1" {
				t.Fatalf("history after sweep = %#v, want only the recent one", left)
			}
		})
	}
}

func TestTeamPrivateSlotsBelongToTheirOwner(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "private-owner@example.com", true)
			member := createTeamTestUser(t, store, "private-member@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			inviteTestMember(t, store, teamID, owner, member)

			mine := syncmodel.Payload{"hostPrefs": {teamTestRecord("h1", "fav", time.Now(), false)}}
			if _, err := store.ApplyTeamPrivateRecords(ctx, teamID, owner.ID, mine, owner.VaultEpoch+1); !errors.Is(err, ErrVaultEpochMismatch) {
				t.Fatalf("stale private push error = %v, want ErrVaultEpochMismatch", err)
			}
			revision, err := store.ApplyTeamPrivateRecords(ctx, teamID, owner.ID, mine, owner.VaultEpoch)
			if err != nil || revision != 1 {
				t.Fatalf("private push = %d, %v", revision, err)
			}
			if revision, err := store.ApplyTeamPrivateRecords(ctx, teamID, owner.ID, mine, owner.VaultEpoch); err != nil || revision != 1 {
				t.Fatalf("same private push = %d, %v", revision, err)
			}

			revision, payload, err := store.GetTeamPrivateSnapshot(ctx, teamID, owner.ID)
			if err != nil || revision != 1 || len(payload["hostPrefs"]) != 1 {
				t.Fatalf("owner private snapshot = %d %#v %v", revision, payload, err)
			}
			revision, payload, err = store.GetTeamPrivateSnapshot(ctx, teamID, member.ID)
			if err != nil || revision != 0 || len(payload) != 0 {
				t.Fatalf("member sees someone else's private slot: %d %#v %v", revision, payload, err)
			}

			ownerGate, _ := store.GetTeamGate(ctx, teamID, owner.ID)
			memberGate, _ := store.GetTeamGate(ctx, teamID, member.ID)
			if ownerGate.PrivateRevision != 1 || memberGate.PrivateRevision != 0 {
				t.Fatalf("private revisions owner=%d member=%d", ownerGate.PrivateRevision, memberGate.PrivateRevision)
			}
		})
	}
}

func TestTeamWatchValuesFollowRecordsInfoAndPrivateSlots(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "watch-owner@example.com", true)
			member := createTeamTestUser(t, store, "watch-member@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			inviteTestMember(t, store, teamID, owner, member)

			read := func() map[TeamWatchKey]int64 {
				t.Helper()
				values, err := store.GetTeamWatchRevisions(ctx, []string{teamID})
				if err != nil {
					t.Fatalf("GetTeamWatchRevisions() error = %v", err)
				}
				return values
			}
			ownerKey := TeamWatchKey{TeamID: teamID, UserID: owner.ID}
			memberKey := TeamWatchKey{TeamID: teamID, UserID: member.ID}
			before := read()
			gate, err := store.GetTeamGate(ctx, teamID, owner.ID)
			if err != nil || gate.WatchValue() != before[ownerKey] {
				t.Fatalf("gate %#v does not match watch value %d (%v)", gate, before[ownerKey], err)
			}

			if _, err := store.ApplyTeamPushRecords(ctx, teamID, member.ID, syncmodel.Payload{"hosts": {teamTestRecord("h1", "v1", time.Now(), false)}}); err != nil {
				t.Fatalf("push error = %v", err)
			}
			afterPush := read()
			if afterPush[ownerKey] == before[ownerKey] || afterPush[memberKey] == before[memberKey] {
				t.Fatalf("team push did not move every member's watch value")
			}

			if _, err := store.ApplyTeamPrivateRecords(ctx, teamID, owner.ID, syncmodel.Payload{"hostPrefs": {teamTestRecord("p", "x", time.Now(), false)}}, owner.VaultEpoch); err != nil {
				t.Fatalf("private push error = %v", err)
			}
			afterPrivate := read()
			if afterPrivate[ownerKey] == afterPush[ownerKey] {
				t.Fatalf("private push did not move the owner's watch value")
			}
			if afterPrivate[memberKey] != afterPush[memberKey] {
				t.Fatalf("someone else's private push moved the member's watch value")
			}

			if err := store.RenameTeam(ctx, teamID, owner.ID, "Renamed"); err != nil {
				t.Fatalf("rename error = %v", err)
			}
			afterRename := read()
			if afterRename[memberKey] == afterPrivate[memberKey] {
				t.Fatalf("team info change did not move the member's watch value")
			}

			if err := store.RemoveTeamMember(ctx, teamID, owner.ID, member.ID); err != nil {
				t.Fatalf("remove error = %v", err)
			}
			if _, ok := read()[memberKey]; ok {
				t.Fatalf("removed member still has a watch value")
			}
		})
	}
}

func TestTeamDataFloorOnlyRises(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "floor-owner@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			for _, floor := range []int{1, 0, -3} {
				if err := store.RaiseTeamDataFloor(ctx, teamID, floor); err != nil {
					t.Fatalf("RaiseTeamDataFloor(%d) error = %v", floor, err)
				}
			}
			gate, err := store.GetTeamGate(ctx, teamID, owner.ID)
			if err != nil || gate.DataFloor != 1 {
				t.Fatalf("data floor = %#v, %v, want 1", gate, err)
			}
		})
	}
}

func TestTouchSyncRevisionsBumpsEachUser(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			alice := createTeamTestUser(t, store, "touch-alice@example.com", false)
			bob := createTeamTestUser(t, store, "touch-bob@example.com", false)
			if err := store.TouchSyncRevisions(ctx, []string{alice.ID, bob.ID, alice.ID}); err != nil {
				t.Fatalf("TouchSyncRevisions() error = %v", err)
			}
			revisions, err := store.GetSyncRevisions(ctx, []string{alice.ID, bob.ID})
			if err != nil || revisions[alice.ID] != 2 || revisions[bob.ID] != 1 {
				t.Fatalf("revisions = %#v, %v", revisions, err)
			}
		})
	}
}

// 팀 행을 잡는 쓰기(push·제거)와 사용자 행부터 잡는 쓰기(초기화·개인 칸)가 겹쳐도 교착하지 않는다.
// SQLite 는 연결 하나로 직렬화하므로 실제 잠금 경쟁은 MySQL·Postgres 실행에서 드러난다.
func TestTeamConcurrentWritesDoNotDeadlock(t *testing.T) {
	for _, testCase := range storeTestCases() {
		t.Run(testCase.name, func(t *testing.T) {
			store := testCase.open(t)
			ctx := context.Background()
			owner := createTeamTestUser(t, store, "race-owner@example.com", true)
			pusher := createTeamTestUser(t, store, "race-pusher@example.com", true)
			leaver := createTeamTestUser(t, store, "race-leaver@example.com", true)
			removed := createTeamTestUser(t, store, "race-removed@example.com", true)
			latecomer := createTeamTestUser(t, store, "race-latecomer@example.com", true)
			teamID := createTestTeam(t, store, owner, "Acme")
			for _, user := range []teamTestUser{pusher, leaver, removed} {
				inviteTestMember(t, store, teamID, owner, user)
			}
			latecomerToken := "latecomer-token"
			latecomerLink, err := store.CreateTeamInvite(ctx, CreateTeamInviteInput{
				TeamID: teamID, CreatedBy: owner.ID, InviteBox: "box", JoinTokenHash: HashTeamJoinToken(latecomerToken),
				ExpiresAt: time.Now().Add(time.Hour),
			})
			if err != nil {
				t.Fatalf("CreateTeamInvite() error = %v", err)
			}

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
					_, err := store.ApplyTeamPushRecords(ctx, teamID, pusher.ID, syncmodel.Payload{
						"hosts": {teamTestRecord(fmt.Sprintf("h%d", index), "v", base.Add(time.Duration(index)*time.Millisecond), false)},
					})
					return err
				})
				run(func() error {
					_, err := store.ApplyTeamPrivateRecords(ctx, teamID, pusher.ID, syncmodel.Payload{
						"hostPrefs": {teamTestRecord(fmt.Sprintf("p%d", index), "v", base.Add(time.Duration(index)*time.Millisecond), false)},
					}, pusher.VaultEpoch)
					return err
				})
			}
			run(func() error {
				err := store.RemoveTeamMember(ctx, teamID, owner.ID, removed.ID)
				return err
			})
			run(func() error {
				epoch, err := store.GetUserVaultEpoch(ctx, leaver.ID)
				if err != nil {
					return err
				}
				_, err = store.ResetUserVault(ctx, leaver.ID, epoch)
				return err
			})
			run(func() error {
				// 빠지는 사람이 동시에 제 개인 칸을 쓰면, 먼저 빠졌을 때는 멤버가 아니라는 답이 맞다.
				_, err := store.ApplyTeamPrivateRecords(ctx, teamID, removed.ID, syncmodel.Payload{
					"hostPrefs": {teamTestRecord("late", "v", base, false)},
				}, removed.VaultEpoch)
				if errors.Is(err, ErrTeamNotFound) {
					return nil
				}
				return err
			})
			run(func() error {
				// 제거가 링크를 모두 지우는 것과 겹친다. 먼저 들어왔으면 성공, 늦었으면 링크가 없다는 답이 맞다.
				_, err := store.JoinTeam(ctx, latecomerLink.Code, latecomerToken, latecomer.ID)
				if errors.Is(err, ErrTeamInviteInvalid) {
					return nil
				}
				return err
			})
			close(start)
			workers.Wait()
			close(errs)
			for err := range errs {
				t.Fatalf("concurrent team write failed: %v", err)
			}

			if gate, err := store.GetTeamGate(ctx, teamID, removed.ID); err != nil || gate.Member {
				t.Fatalf("removed member after race = %#v, %v", gate, err)
			}
			if count := countTeamRows(t, store, &teamMemberPrivateRow{}, "team_id = ? AND user_id = ?", teamID, removed.ID); count != 0 {
				t.Fatalf("removed member's private slot came back: %d rows", count)
			}
			if gate, err := store.GetTeamGate(ctx, teamID, leaver.ID); err != nil || gate.Member {
				t.Fatalf("reset member after race = %#v, %v", gate, err)
			}
			revision, payload, err := store.GetTeamSyncSnapshot(ctx, teamID, owner.ID)
			if err != nil || len(payload["hosts"]) != 10 || revision != 10 {
				t.Fatalf("team records after race = %d records, revision %d, %v", len(payload["hosts"]), revision, err)
			}
		})
	}
}
