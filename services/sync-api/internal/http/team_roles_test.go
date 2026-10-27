package http_test

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	httpserver "dolssh/services/sync-api/internal/http"
	"dolssh/services/sync-api/internal/store"
)

// teamRouteRule 은 팀 경로 하나를 누가 쓰는지다. minimum 이 비면 멤버 누구나다.
type teamRouteRule struct {
	minimum    string
	deniedCode string
}

var (
	anyTeamMember    = teamRouteRule{}
	teamWritersOnly  = teamRouteRule{minimum: "member", deniedCode: "team_read_only"}
	teamAdminsOnly   = teamRouteRule{minimum: "admin", deniedCode: "team_admin_only"}
	teamOwnerOnly    = teamRouteRule{minimum: "owner", deniedCode: "team_owner_only"}
	teamReplayReader = teamRouteRule{minimum: "admin", deniedCode: "team_replay_forbidden"}
	// 시험의 녹화는 소유자가 만든다 — 올리기는 녹화한 사람(소유자)만 된다.
	teamReplayAuthor = teamRouteRule{minimum: "owner", deniedCode: "team_replay_author_only"}
)

// teamRouteRules 는 /teams/:teamId 아래 모든 경로의 규칙이다. 경로를 더하면 여기에도 적어야 시험이 통과한다 —
// 새 경로가 역할 검사 없이 들어오지 못하게.
var teamRouteRules = map[string]teamRouteRule{
	"PATCH /teams/:teamId":                                        teamOwnerOnly,
	"DELETE /teams/:teamId":                                       teamOwnerOnly,
	"POST /teams/:teamId/owner":                                   teamOwnerOnly,
	"GET /teams/:teamId/members":                                  anyTeamMember,
	"PUT /teams/:teamId/members/:userId/role":                     teamAdminsOnly,
	"POST /teams/:teamId/members/:userId/remove":                  teamAdminsOnly,
	"POST /teams/:teamId/leave":                                   anyTeamMember,
	"PUT /teams/:teamId/key":                                      anyTeamMember,
	"POST /teams/:teamId/invites":                                 teamAdminsOnly,
	"GET /teams/:teamId/invites":                                  teamAdminsOnly,
	"DELETE /teams/:teamId/invites/:code":                         teamAdminsOnly,
	"GET /teams/:teamId/me":                                       anyTeamMember,
	"PUT /teams/:teamId/me":                                       anyTeamMember,
	"GET /teams/:teamId/sync":                                     anyTeamMember,
	"POST /teams/:teamId/sync":                                    teamWritersOnly,
	"GET /teams/:teamId/sync/watch":                               anyTeamMember,
	"GET /teams/:teamId/versions":                                 teamAdminsOnly,
	"POST /teams/:teamId/events":                                  anyTeamMember,
	"GET /teams/:teamId/events":                                   anyTeamMember,
	"POST /teams/:teamId/replays":                                 anyTeamMember,
	"GET /teams/:teamId/replays":                                  anyTeamMember,
	"GET /teams/:teamId/replays/:recordingId":                     teamReplayReader,
	"PUT /teams/:teamId/replays/:recordingId/segments/:index":     teamReplayAuthor,
	"GET /teams/:teamId/replays/:recordingId/segments":            teamReplayReader,
	"PUT /teams/:teamId/replays/:recordingId/extras/:kind/:index": teamReplayAuthor,
	"GET /teams/:teamId/replays/:recordingId/extras/:kind":        teamReplayReader,
	"POST /teams/:teamId/replays/:recordingId/complete":           teamReplayAuthor,
}

var teamRoleOrder = []string{"viewer", "member", "admin", "owner"}

func teamRoleRankOf(role string) int {
	for index, name := range teamRoleOrder {
		if name == role {
			return index + 1
		}
	}
	return 0
}

// createRoleInviteOverHTTP 는 그 역할의 링크를 만들고 (코드, 토큰)을 준다.
func createRoleInviteOverHTTP(t *testing.T, router *gin.Engine, inviter *watchTestAccount, teamID string, role string) (string, string) {
	t.Helper()
	token := "token-" + uuid.NewString()
	recorder := teamCall(router, inviter, http.MethodPost, "/teams/"+teamID+"/invites",
		fmt.Sprintf(`{"inviteBox":"sealed-team-key","joinTokenHash":%q,"expiresAt":%q,"role":%q}`,
			store.HashTeamJoinToken(token), time.Now().Add(time.Hour).UTC().Format(time.RFC3339), role), nil)
	expectStatus(t, recorder, http.StatusCreated, "create "+role+" invite")
	var body struct {
		Code string `json:"code"`
		Role string `json:"role"`
	}
	decodeJSON(t, recorder, &body)
	if body.Role != role {
		t.Fatalf("invite role = %q, want %q", body.Role, role)
	}
	return body.Code, token
}

func addRoleMemberOverHTTP(t *testing.T, router *gin.Engine, teamID string, inviter *watchTestAccount, user *watchTestAccount, role string) {
	t.Helper()
	code, token := createRoleInviteOverHTTP(t, router, inviter, teamID, role)
	expectStatus(t, joinOverHTTP(router, user, code, token), http.StatusOK, "join as "+role)
	expectStatus(t, teamCall(router, user, http.MethodPut, "/teams/"+teamID+"/key", `{"wrappedTeamDek":"copy"}`, epochHeader(user)), http.StatusNoContent, "put key")
}

// roleRouteTeam 은 역할 넷이 다 있는 팀 하나와, 경로를 부를 때 쓸 값들이다.
type roleRouteTeam struct {
	id          string
	userIDs     map[string]string
	inviteCode  string
	recordingID string
}

func newRoleRouteTeam(t *testing.T, router *gin.Engine, accounts map[string]*watchTestAccount, emails map[string]string) roleRouteTeam {
	t.Helper()
	owner := accounts["owner"]
	team := roleRouteTeam{id: createTeamOverHTTP(t, router, owner, "Acme"), userIDs: map[string]string{}}
	addMemberOverHTTP(t, router, team.id, owner, accounts["admin"])
	addMemberOverHTTP(t, router, team.id, owner, accounts["member"])
	addRoleMemberOverHTTP(t, router, team.id, owner, accounts["viewer"], "viewer")
	for _, role := range teamRoleOrder {
		team.userIDs[role] = teamMemberIDByEmail(t, router, owner, team.id, emails[role])
	}
	setTeamRoleOverHTTP(t, router, owner, team.id, team.userIDs["admin"], "admin")
	team.inviteCode, _ = createInviteOverHTTP(t, router, owner, team.id, time.Hour)

	team.recordingID = uuid.NewString()
	base := "/teams/" + team.id + "/replays/" + team.recordingID
	expectStatus(t, teamCall(router, owner, http.MethodPost, "/teams/"+team.id+"/replays",
		fmt.Sprintf(`{"recordingId":%q,"startMeta":"start"}`, team.recordingID), nil), http.StatusOK, "start replay")
	expectStatus(t, putReplaySegment(router, owner, team.id, team.recordingID, 0, "info-0", []byte("segment-0")), http.StatusNoContent, "segment 0")
	expectStatus(t, teamCall(router, owner, http.MethodPut, base+"/extras/commands/0", "cmd-0",
		map[string]string{"Content-Type": "application/octet-stream"}), http.StatusNoContent, "commands 0")
	return team
}

// roleRouteRequest 는 그 경로를 그 사람이 부를 요청이다 — 통과하면 정말 그 일을 하는 올바른 요청이다.
func roleRouteRequest(team roleRouteTeam, route string, account *watchTestAccount) (string, string, string, map[string]string) {
	method, pattern, _ := strings.Cut(route, " ")
	path := strings.NewReplacer(
		":teamId", team.id,
		":userId", team.userIDs["viewer"],
		":code", team.inviteCode,
		":recordingId", team.recordingID,
		":index", "1",
		":kind", "commands",
	).Replace(pattern)
	octet := map[string]string{"Content-Type": "application/octet-stream"}
	switch route {
	case "PATCH /teams/:teamId":
		return method, path, `{"name":"Renamed"}`, nil
	case "POST /teams/:teamId/owner":
		return method, path, fmt.Sprintf(`{"userId":%q}`, team.userIDs["admin"]), nil
	case "PUT /teams/:teamId/members/:userId/role":
		return method, path, `{"role":"member"}`, nil
	case "PUT /teams/:teamId/key":
		return method, path, `{"wrappedTeamDek":"copy-again"}`, epochHeader(account)
	case "POST /teams/:teamId/invites":
		return method, path, fmt.Sprintf(`{"inviteBox":"box","joinTokenHash":%q,"expiresAt":%q}`,
			store.HashTeamJoinToken(uuid.NewString()), time.Now().Add(time.Hour).UTC().Format(time.RFC3339)), nil
	case "PUT /teams/:teamId/me":
		return method, path, `{"hostPrefs":[{"id":"h1","encrypted_payload":"mine","updated_at":"2026-10-26T01:00:00.000Z"}]}`, epochHeader(account)
	case "POST /teams/:teamId/sync":
		return method, path, fmt.Sprintf(`{"hosts":[{"id":%q,"encrypted_payload":"cipher","updated_at":"2026-10-26T01:00:00.000Z"}]}`, uuid.NewString()), nil
	case "POST /teams/:teamId/events":
		return method, path, eventsBody(appEventJSON(uuid.NewString(), "payload")), nil
	case "POST /teams/:teamId/replays":
		return method, path, fmt.Sprintf(`{"recordingId":%q,"startMeta":"start"}`, uuid.NewString()), nil
	case "PUT /teams/:teamId/replays/:recordingId/segments/:index":
		return method, path, "segment-1", map[string]string{"Content-Type": "application/octet-stream", "X-Dolgate-Segment-Info": "info-1"}
	case "PUT /teams/:teamId/replays/:recordingId/extras/:kind/:index":
		return method, path, "cmd-1", octet
	case "POST /teams/:teamId/replays/:recordingId/complete":
		return method, path, `{"endMeta":"end","lastSegment":0}`, nil
	case "GET /teams/:teamId/replays/:recordingId/segments", "GET /teams/:teamId/replays/:recordingId/extras/:kind":
		return method, path + "?from=0", "", nil
	}
	return method, path, "", nil
}

// 팀 경로 하나하나를 역할 넷으로 불러, 규칙대로 막히고 통과하는지 본다. 경로 목록은 라우터에서 읽는다.
func TestTeamRoutesCheckRoles(t *testing.T) {
	env := newWatchTestEnv(t)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	emails := map[string]string{}
	accounts := map[string]*watchTestAccount{}
	for _, role := range teamRoleOrder {
		emails[role] = "route-" + role + "@example.com"
		accounts[role] = newWatchTestAccount(t, router, emails[role])
	}

	var routes []string
	for _, info := range router.Routes() {
		if strings.HasPrefix(info.Path, "/teams/:teamId") {
			routes = append(routes, info.Method+" "+info.Path)
		}
	}
	sort.Strings(routes)
	listed := map[string]bool{}
	for _, route := range routes {
		listed[route] = true
		if _, ok := teamRouteRules[route]; !ok {
			t.Errorf("%s has no role rule — add it to teamRouteRules", route)
		}
	}
	for route := range teamRouteRules {
		if !listed[route] {
			t.Errorf("rule for %s, but the router has no such route", route)
		}
	}
	if t.Failed() {
		t.FailNow()
	}

	for _, route := range routes {
		rule := teamRouteRules[route]
		team := newRoleRouteTeam(t, router, accounts, emails)
		// 낮은 역할부터 부른다 — 막히는 쪽이 먼저라, 통과하며 바꾸는 일(나가기·삭제)이 뒤를 흐리지 않는다.
		for _, role := range teamRoleOrder {
			account := accounts[role]
			method, path, body, headers := roleRouteRequest(team, route, account)
			recorder := teamCall(router, account, method, path, body, headers)
			what := fmt.Sprintf("%s as %s", route, role)
			if teamRoleRankOf(role) < teamRoleRankOf(rule.minimum) {
				expectTeamCode(t, recorder, http.StatusForbidden, rule.deniedCode, what)
				continue
			}
			if recorder.Code == http.StatusForbidden || strings.Contains(recorder.Body.String(), `"team_not_found"`) || recorder.Code >= 500 {
				t.Fatalf("%s: status %d: %s", what, recorder.Code, recorder.Body.String())
			}
		}
	}
}

func TestTeamRolesOverHTTP(t *testing.T) {
	env := newWatchTestEnv(t)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	owner := newWatchTestAccount(t, router, "roles-http-owner@example.com")
	member := newWatchTestAccount(t, router, "roles-http-member@example.com")
	viewer := newWatchTestAccount(t, router, "roles-http-viewer@example.com")
	teamID := createTeamOverHTTP(t, router, owner, "Acme")
	addMemberOverHTTP(t, router, teamID, owner, member)

	// 참여 카드가 역할을 미리 알린다.
	code, token := createRoleInviteOverHTTP(t, router, owner, teamID, "viewer")
	info := teamCall(router, viewer, http.MethodGet, "/invite/"+code+"/info", "", map[string]string{"X-Dolgate-Invite-Token": token})
	expectStatus(t, info, http.StatusOK, "invite info")
	var card struct {
		Role string `json:"role"`
	}
	decodeJSON(t, info, &card)
	if card.Role != "viewer" {
		t.Fatalf("invite card role = %q", card.Role)
	}
	expectTeamCode(t, teamCall(router, owner, http.MethodPost, "/teams/"+teamID+"/invites",
		fmt.Sprintf(`{"inviteBox":"box","joinTokenHash":%q,"expiresAt":%q,"role":"admin"}`,
			store.HashTeamJoinToken("x"), time.Now().Add(time.Hour).UTC().Format(time.RFC3339)), nil),
		http.StatusBadRequest, "team_role_invalid", "admin invite")
	joined := joinOverHTTP(router, viewer, code, token)
	expectStatus(t, joined, http.StatusOK, "join")
	var joinBody struct {
		Role string `json:"role"`
	}
	decodeJSON(t, joined, &joinBody)
	if joinBody.Role != "viewer" {
		t.Fatalf("join role = %q", joinBody.Role)
	}
	// 사본을 올리기 전에 다시 부르면 상자와 함께 지금 역할을 다시 준다.
	rejoined := joinOverHTTP(router, viewer, code, token)
	expectStatus(t, rejoined, http.StatusOK, "rejoin before the key")
	decodeJSON(t, rejoined, &joinBody)
	if joinBody.Role != "viewer" {
		t.Fatalf("rejoin role = %q", joinBody.Role)
	}
	expectStatus(t, teamCall(router, viewer, http.MethodPut, "/teams/"+teamID+"/key", `{"wrappedTeamDek":"copy"}`, epochHeader(viewer)), http.StatusNoContent, "put key")

	roleInList := func(account *watchTestAccount) string {
		t.Helper()
		listed := teamCall(router, account, http.MethodGet, "/teams", "", nil)
		expectStatus(t, listed, http.StatusOK, "teams")
		var body struct {
			Teams []struct {
				ID   string `json:"id"`
				Role string `json:"role"`
			} `json:"teams"`
		}
		decodeJSON(t, listed, &body)
		for _, team := range body.Teams {
			if team.ID == teamID {
				return team.Role
			}
		}
		t.Fatalf("team missing from the list")
		return ""
	}
	if role := roleInList(viewer); role != "viewer" {
		t.Fatalf("viewer's role = %q", role)
	}
	viewerID := teamMemberIDByEmail(t, router, owner, teamID, "roles-http-viewer@example.com")
	expectTeamCode(t, teamCall(router, owner, http.MethodPut, "/teams/"+teamID+"/members/"+viewerID+"/role", `{"role":"owner"}`, nil),
		http.StatusBadRequest, "team_role_invalid", "role owner")
	expectStatus(t, teamCall(router, owner, http.MethodPut, "/teams/"+teamID+"/members/"+viewerID+"/role", `{"role":`, nil),
		http.StatusBadRequest, "broken body")
	setTeamRoleOverHTTP(t, router, owner, teamID, viewerID, "member")
	if role := roleInList(viewer); role != "member" {
		t.Fatalf("role after the change = %q", role)
	}
	setTeamRoleOverHTTP(t, router, owner, teamID, viewerID, "viewer")

	// 녹화 목록은 모두에게 주되, 볼 수 있는지를 싣는다.
	recordingID := uuid.NewString()
	expectStatus(t, teamCall(router, member, http.MethodPost, "/teams/"+teamID+"/replays",
		fmt.Sprintf(`{"recordingId":%q,"startMeta":"start"}`, recordingID), nil), http.StatusOK, "start")
	viewableFor := func(account *watchTestAccount) bool {
		t.Helper()
		listed := teamCall(router, account, http.MethodGet, "/teams/"+teamID+"/replays?ids="+recordingID, "", nil)
		expectStatus(t, listed, http.StatusOK, "replays")
		var body struct {
			Replays []struct {
				Viewable bool `json:"viewable"`
			} `json:"replays"`
		}
		decodeJSON(t, listed, &body)
		if len(body.Replays) != 1 {
			t.Fatalf("replays = %s", listed.Body.String())
		}
		return body.Replays[0].Viewable
	}
	if !viewableFor(member) || viewableFor(viewer) || !viewableFor(owner) {
		t.Fatal("viewable flags do not follow the roles")
	}

	// 이전 판 목록 — 관리자 이상, 암호문과 누가·언제.
	push := func(payload string) {
		t.Helper()
		expectStatus(t, teamCall(router, member, http.MethodPost, "/teams/"+teamID+"/sync", payload, nil), http.StatusAccepted, "push")
	}
	push(`{"hosts":[{"id":"h1","encrypted_payload":"v1","updated_at":"2026-10-26T01:00:00.000Z"}]}`)
	push(`{"hosts":[{"id":"h1","encrypted_payload":"v2","updated_at":"2026-10-26T01:01:00.000Z"}]}`)
	expectTeamCode(t, teamCall(router, member, http.MethodGet, "/teams/"+teamID+"/versions", "", nil), http.StatusForbidden, "team_admin_only", "member versions")
	listed := teamCall(router, owner, http.MethodGet, "/teams/"+teamID+"/versions?kind=hosts&recordId=h1", "", nil)
	expectStatus(t, listed, http.StatusOK, "versions")
	var versions struct {
		Versions []struct {
			Seq              int64  `json:"seq"`
			Kind             string `json:"kind"`
			RecordID         string `json:"recordId"`
			EncryptedPayload string `json:"encryptedPayload"`
			UpdatedByEmail   string `json:"updatedByEmail"`
			ChangedByEmail   string `json:"changedByEmail"`
			ChangedAt        string `json:"changedAt"`
			Deleted          *bool  `json:"deleted"`
		} `json:"versions"`
	}
	decodeJSON(t, listed, &versions)
	if len(versions.Versions) != 1 || versions.Versions[0].EncryptedPayload != "v1" || versions.Versions[0].Kind != "hosts" ||
		versions.Versions[0].ChangedByEmail != "roles-http-member@example.com" || versions.Versions[0].ChangedAt == "" ||
		versions.Versions[0].Deleted == nil || *versions.Versions[0].Deleted {
		t.Fatalf("versions = %s", listed.Body.String())
	}
	for _, query := range []string{"?kind=hosts", "?recordId=h1", "?before=0", "?before=x", "?limit=0"} {
		expectStatus(t, teamCall(router, owner, http.MethodGet, "/teams/"+teamID+"/versions"+query, "", nil), http.StatusBadRequest, "versions"+query)
	}
	// 지운 표시와 함께 내용이 있던 판이면 지운 시각도 싣는다.
	push(`{"hosts":[{"id":"h2","encrypted_payload":"gone","updated_at":"2026-10-26T02:00:00.000Z","deleted_at":"2026-10-26T02:00:00.000Z"}]}`)
	push(`{"hosts":[{"id":"h2","encrypted_payload":"back","updated_at":"2026-10-26T02:01:00.000Z"}]}`)
	deleted := teamCall(router, owner, http.MethodGet, "/teams/"+teamID+"/versions?kind=hosts&recordId=h2", "", nil)
	expectStatus(t, deleted, http.StatusOK, "deleted versions")
	var deletedVersions struct {
		Versions []struct {
			DeletedAt string `json:"deletedAt"`
			Deleted   bool   `json:"deleted"`
		} `json:"versions"`
	}
	decodeJSON(t, deleted, &deletedVersions)
	// 그 판을 밀어낸 올리기는 되살리기(지움이 아님)다.
	if len(deletedVersions.Versions) != 1 || deletedVersions.Versions[0].DeletedAt == "" || deletedVersions.Versions[0].Deleted {
		t.Fatalf("deleted version = %s", deleted.Body.String())
	}
	// 살아 있던 레코드를 지운 올리기의 판은 deleted 다.
	push(`{"hosts":[{"id":"h3","encrypted_payload":"alive","updated_at":"2026-10-26T03:00:00.000Z"}]}`)
	push(`{"hosts":[{"id":"h3","encrypted_payload":"","updated_at":"2026-10-26T03:01:00.000Z","deleted_at":"2026-10-26T03:01:00.000Z"}]}`)
	removed := teamCall(router, owner, http.MethodGet, "/teams/"+teamID+"/versions?kind=hosts&recordId=h3", "", nil)
	expectStatus(t, removed, http.StatusOK, "removed versions")
	var removedVersions struct {
		Versions []struct {
			EncryptedPayload string `json:"encryptedPayload"`
			DeletedAt        string `json:"deletedAt"`
			Deleted          bool   `json:"deleted"`
		} `json:"versions"`
	}
	decodeJSON(t, removed, &removedVersions)
	if len(removedVersions.Versions) != 1 || removedVersions.Versions[0].EncryptedPayload != "alive" ||
		removedVersions.Versions[0].DeletedAt != "" || !removedVersions.Versions[0].Deleted {
		t.Fatalf("removed version = %s", removed.Body.String())
	}
	emptied := teamCall(router, owner, http.MethodGet, fmt.Sprintf("/teams/%s/versions?before=%d", teamID, versions.Versions[0].Seq), "", nil)
	expectStatus(t, emptied, http.StatusOK, "versions before")
	if strings.Contains(emptied.Body.String(), `"seq"`) {
		t.Fatalf("versions before the oldest = %s", emptied.Body.String())
	}
}

// 역할이 바뀌면 바뀐 사람의 다른 기기는 개인 감시로 팀 목록(역할)을 다시 읽고, 그 팀을 보는 기기는 팀 감시로 안다.
func TestTeamRoleChangesWakeTheTargetAndTheTeam(t *testing.T) {
	env := newWatchTestEnv(t)
	hub := env.hub(t, time.Hour)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: hub})
	owner := newWatchTestAccount(t, router, "role-wake-owner@example.com")
	member := newWatchTestAccount(t, router, "role-wake-member@example.com")
	teamID := createTeamOverHTTP(t, router, owner, "Acme")
	addMemberOverHTTP(t, router, teamID, owner, member)
	memberID := teamMemberIDByEmail(t, router, owner, teamID, "role-wake-member@example.com")

	personal := member.watchAsync(t, router, hub, member.currentETag(t, router))
	team := teamWatchAsync(t, router, hub, owner, teamID, currentTeamWatchETag(t, router, owner, teamID))
	setTeamRoleOverHTTP(t, router, owner, teamID, memberID, "viewer")
	expectStatus(t, awaitWatch(t, personal, 2*time.Second, "member's personal watch after the role change"), http.StatusOK, "member's personal watch after the role change")
	expectStatus(t, awaitWatch(t, team, 2*time.Second, "team watch after the role change"), http.StatusOK, "team watch after the role change")
}
