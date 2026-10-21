package http_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	httpserver "dolssh/services/sync-api/internal/http"
	"dolssh/services/sync-api/internal/store"
)

// teamCall 은 팀 API 요청 하나다. epoch 를 주면 볼트 세대 헤더를 싣는다.
func teamCall(router *gin.Engine, account *watchTestAccount, method string, path string, body string, headers map[string]string) *httptest.ResponseRecorder {
	request := vaultTestRequest(method, path, body, account.token, vaultE2EECapableVersion)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func epochHeader(account *watchTestAccount) map[string]string {
	return map[string]string{"X-Dolgate-Vault-Epoch": strconv.FormatInt(account.epoch, 10)}
}

func expectStatus(t *testing.T, recorder *httptest.ResponseRecorder, status int, what string) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("%s: status %d, want %d: %s", what, recorder.Code, status, recorder.Body.String())
	}
}

func expectTeamCode(t *testing.T, recorder *httptest.ResponseRecorder, status int, code string, what string) {
	t.Helper()
	expectStatus(t, recorder, status, what)
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || body.Code != code {
		t.Fatalf("%s: code %q, want %q (%s)", what, body.Code, code, recorder.Body.String())
	}
}

func decodeJSON(t *testing.T, recorder *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(recorder.Body.Bytes(), target); err != nil {
		t.Fatalf("decode %s: %v", recorder.Body.String(), err)
	}
}

func createTeamOverHTTP(t *testing.T, router *gin.Engine, owner *watchTestAccount, name string) string {
	t.Helper()
	teamID := uuid.NewString()
	recorder := teamCall(router, owner, http.MethodPost, "/teams",
		fmt.Sprintf(`{"id":%q,"name":%q,"wrappedTeamDek":"owner-copy"}`, teamID, name), epochHeader(owner))
	expectStatus(t, recorder, http.StatusCreated, "create team")
	return teamID
}

// createInviteOverHTTP 는 링크를 만들고 (코드, 토큰)을 준다.
func createInviteOverHTTP(t *testing.T, router *gin.Engine, inviter *watchTestAccount, teamID string, lifetime time.Duration) (string, string) {
	t.Helper()
	token := "token-" + uuid.NewString()
	recorder := teamCall(router, inviter, http.MethodPost, "/teams/"+teamID+"/invites",
		fmt.Sprintf(`{"inviteBox":"sealed-team-key","joinTokenHash":%q,"expiresAt":%q}`,
			store.HashTeamJoinToken(token), time.Now().Add(lifetime).UTC().Format(time.RFC3339)), nil)
	expectStatus(t, recorder, http.StatusCreated, "create invite")
	var body struct {
		Code string `json:"code"`
	}
	decodeJSON(t, recorder, &body)
	return body.Code, token
}

func joinOverHTTP(router *gin.Engine, joiner *watchTestAccount, code string, token string) *httptest.ResponseRecorder {
	headers := map[string]string{}
	if token != "" {
		headers["X-Dolgate-Invite-Token"] = token
	}
	return teamCall(router, joiner, http.MethodPost, "/invite/"+code+"/join", "", headers)
}

func addMemberOverHTTP(t *testing.T, router *gin.Engine, teamID string, inviter *watchTestAccount, member *watchTestAccount) {
	t.Helper()
	code, token := createInviteOverHTTP(t, router, inviter, teamID, time.Hour)
	expectStatus(t, joinOverHTTP(router, member, code, token), http.StatusOK, "join")
	expectStatus(t, teamCall(router, member, http.MethodPut, "/teams/"+teamID+"/key", `{"wrappedTeamDek":"member-copy"}`, epochHeader(member)), http.StatusNoContent, "put key")
}

func TestTeamCreateValidatesIDAndVaultEpoch(t *testing.T) {
	env := newWatchTestEnv(t)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	owner := newWatchTestAccount(t, router, "team-create@example.com")

	teamID := uuid.NewString()
	body := fmt.Sprintf(`{"id":%q,"name":"Acme","wrappedTeamDek":"k"}`, teamID)
	expectTeamCode(t, teamCall(router, owner, http.MethodPost, "/teams", body, nil), http.StatusConflict, "vault_dek_mismatch", "no epoch header")
	stale := map[string]string{"X-Dolgate-Vault-Epoch": strconv.FormatInt(owner.epoch+1, 10)}
	expectTeamCode(t, teamCall(router, owner, http.MethodPost, "/teams", body, stale), http.StatusConflict, "vault_dek_mismatch", "stale epoch")
	upper := fmt.Sprintf(`{"id":%q,"name":"Acme","wrappedTeamDek":"k"}`, "A3BB189E-8BF9-3888-9912-ACE4E6543002")
	expectStatus(t, teamCall(router, owner, http.MethodPost, "/teams", upper, epochHeader(owner)), http.StatusBadRequest, "non-canonical id")
	expectStatus(t, teamCall(router, owner, http.MethodPost, "/teams", fmt.Sprintf(`{"id":%q,"name":"  ","wrappedTeamDek":"k"}`, teamID), epochHeader(owner)), http.StatusBadRequest, "blank name")

	created := teamCall(router, owner, http.MethodPost, "/teams", body, epochHeader(owner))
	expectStatus(t, created, http.StatusCreated, "create")
	expectTeamCode(t, teamCall(router, owner, http.MethodPost, "/teams", body, epochHeader(owner)), http.StatusConflict, "team_exists", "duplicate id")

	var list struct {
		Teams []struct {
			ID             string `json:"id"`
			Name           string `json:"name"`
			Role           string `json:"role"`
			WrappedTeamDek string `json:"wrappedTeamDek"`
			MemberCount    int    `json:"memberCount"`
		} `json:"teams"`
	}
	listed := teamCall(router, owner, http.MethodGet, "/teams", "", nil)
	expectStatus(t, listed, http.StatusOK, "list")
	decodeJSON(t, listed, &list)
	if len(list.Teams) != 1 || list.Teams[0].ID != teamID || list.Teams[0].Role != "owner" || list.Teams[0].WrappedTeamDek != "k" || list.Teams[0].MemberCount != 1 {
		t.Fatalf("teams = %#v", list.Teams)
	}
}

func TestTeamInviteJoinAndPermissions(t *testing.T) {
	env := newWatchTestEnv(t)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	owner := newWatchTestAccount(t, router, "perm-owner@example.com")
	member := newWatchTestAccount(t, router, "perm-member@example.com")
	outsider := newWatchTestAccount(t, router, "perm-outsider@example.com")
	teamID := createTeamOverHTTP(t, router, owner, "Acme Infra")
	code, token := createInviteOverHTTP(t, router, owner, teamID, 7*24*time.Hour)

	// 토큰이 없거나 틀리면 정보도 참여도 없다. 맞으면 정보에도 상자는 없다.
	infoPath := "/invite/" + code + "/info"
	expectTeamCode(t, teamCall(router, member, http.MethodGet, infoPath, "", nil), http.StatusNotFound, "team_invite_invalid", "info without token")
	expectTeamCode(t, teamCall(router, member, http.MethodGet, infoPath, "", map[string]string{"X-Dolgate-Invite-Token": "wrong"}), http.StatusNotFound, "team_invite_invalid", "info with wrong token")
	info := teamCall(router, member, http.MethodGet, infoPath, "", map[string]string{"X-Dolgate-Invite-Token": token})
	expectStatus(t, info, http.StatusOK, "info")
	var infoBody map[string]any
	decodeJSON(t, info, &infoBody)
	if infoBody["teamName"] != "Acme Infra" || infoBody["inviterEmail"] != "perm-owner@example.com" || infoBody["memberCount"] != float64(1) {
		t.Fatalf("info = %#v", infoBody)
	}
	if _, leaked := infoBody["inviteBox"]; leaked {
		t.Fatalf("info leaked the invite box: %#v", infoBody)
	}
	expectTeamCode(t, joinOverHTTP(router, member, code, ""), http.StatusNotFound, "team_invite_invalid", "join without token")

	joined := joinOverHTTP(router, member, code, token)
	expectStatus(t, joined, http.StatusOK, "join")
	var joinBody struct {
		TeamID    string `json:"teamId"`
		InviteBox string `json:"inviteBox"`
		Rejoined  bool   `json:"rejoined"`
	}
	decodeJSON(t, joined, &joinBody)
	if joinBody.TeamID != teamID || joinBody.InviteBox != "sealed-team-key" || joinBody.Rejoined {
		t.Fatalf("join = %#v", joinBody)
	}
	// 사본을 올리기 전에 끊겼으면 상자만 다시 받는다.
	rejoined := joinOverHTTP(router, member, code, token)
	expectStatus(t, rejoined, http.StatusOK, "rejoin")
	decodeJSON(t, rejoined, &joinBody)
	if !joinBody.Rejoined || joinBody.InviteBox != "sealed-team-key" {
		t.Fatalf("rejoin = %#v", joinBody)
	}
	expectStatus(t, teamCall(router, member, http.MethodPut, "/teams/"+teamID+"/key", `{"wrappedTeamDek":"member-copy"}`, epochHeader(member)), http.StatusNoContent, "put key")
	expectTeamCode(t, joinOverHTTP(router, member, code, token), http.StatusConflict, "team_already_member", "join after key")

	// 멤버가 아니면 팀이 없는 것과 같다.
	for _, path := range []string{"/teams/" + teamID + "/members", "/teams/" + teamID + "/sync", "/teams/" + teamID + "/invites", "/teams/" + teamID + "/me"} {
		expectTeamCode(t, teamCall(router, outsider, http.MethodGet, path, "", nil), http.StatusNotFound, "team_not_found", "outsider GET "+path)
	}

	// 소유자만: 이름 바꾸기·팀 삭제·소유권 넘기기·제거.
	expectTeamCode(t, teamCall(router, member, http.MethodPatch, "/teams/"+teamID, `{"name":"Mine"}`, nil), http.StatusForbidden, "team_owner_only", "member rename")
	expectTeamCode(t, teamCall(router, member, http.MethodDelete, "/teams/"+teamID, "", nil), http.StatusForbidden, "team_owner_only", "member delete")
	expectTeamCode(t, teamCall(router, member, http.MethodPost, "/teams/"+teamID+"/owner", `{"userId":"x"}`, nil), http.StatusForbidden, "team_owner_only", "member transfer")
	var members struct {
		Members []struct {
			UserID       string `json:"userId"`
			Email        string `json:"email"`
			Role         string `json:"role"`
			HasKey       bool   `json:"hasKey"`
			AddedByEmail string `json:"addedByEmail"`
		} `json:"members"`
	}
	listed := teamCall(router, member, http.MethodGet, "/teams/"+teamID+"/members", "", nil)
	expectStatus(t, listed, http.StatusOK, "members")
	decodeJSON(t, listed, &members)
	if len(members.Members) != 2 || members.Members[1].Email != "perm-member@example.com" || members.Members[1].AddedByEmail != "perm-owner@example.com" || !members.Members[1].HasKey {
		t.Fatalf("members = %#v", members.Members)
	}
	ownerID := members.Members[0].UserID
	memberID := members.Members[1].UserID
	expectTeamCode(t, teamCall(router, member, http.MethodPost, "/teams/"+teamID+"/members/"+ownerID+"/remove", "", nil), http.StatusForbidden, "team_owner_only", "member removes owner")
	expectTeamCode(t, teamCall(router, owner, http.MethodPost, "/teams/"+teamID+"/leave", "", nil), http.StatusConflict, "team_owner_must_transfer", "owner leave with members")

	// 제거하면 그 사람은 팀을 못 보고, 알던 링크로 되돌아오지도 못한다.
	expectStatus(t, teamCall(router, owner, http.MethodPost, "/teams/"+teamID+"/members/"+memberID+"/remove", "", nil), http.StatusNoContent, "remove")
	expectTeamCode(t, teamCall(router, member, http.MethodGet, "/teams/"+teamID+"/sync", "", nil), http.StatusNotFound, "team_not_found", "removed member sync")
	expectTeamCode(t, joinOverHTTP(router, member, code, token), http.StatusNotFound, "team_invite_invalid", "rejoin with old link")
}

func TestTeamInviteValidatesLifetimeAndRevocation(t *testing.T) {
	env := newWatchTestEnv(t)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	owner := newWatchTestAccount(t, router, "invite-life-owner@example.com")
	joiner := newWatchTestAccount(t, router, "invite-life-joiner@example.com")
	teamID := createTeamOverHTTP(t, router, owner, "Acme")
	hash := store.HashTeamJoinToken("x")

	for _, expiresAt := range []time.Time{time.Now().Add(-time.Minute), time.Now().Add(31 * 24 * time.Hour)} {
		body := fmt.Sprintf(`{"inviteBox":"box","joinTokenHash":%q,"expiresAt":%q}`, hash, expiresAt.UTC().Format(time.RFC3339))
		expectStatus(t, teamCall(router, owner, http.MethodPost, "/teams/"+teamID+"/invites", body, nil), http.StatusBadRequest, "invite lifetime "+expiresAt.String())
	}
	expectStatus(t, teamCall(router, owner, http.MethodPost, "/teams/"+teamID+"/invites",
		fmt.Sprintf(`{"inviteBox":"box","joinTokenHash":"not-hex","expiresAt":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339)), nil),
		http.StatusBadRequest, "malformed token hash")

	code, token := createInviteOverHTTP(t, router, owner, teamID, time.Hour)
	expectStatus(t, teamCall(router, owner, http.MethodDelete, "/teams/"+teamID+"/invites/"+code, "", nil), http.StatusNoContent, "revoke")
	expectTeamCode(t, joinOverHTTP(router, joiner, code, token), http.StatusNotFound, "team_invite_invalid", "join revoked")
	var invites struct {
		Invites []struct {
			Code   string `json:"code"`
			Active bool   `json:"active"`
		} `json:"invites"`
	}
	listed := teamCall(router, owner, http.MethodGet, "/teams/"+teamID+"/invites", "", nil)
	expectStatus(t, listed, http.StatusOK, "list invites")
	decodeJSON(t, listed, &invites)
	if len(invites.Invites) != 1 || invites.Invites[0].Code != code || invites.Invites[0].Active {
		t.Fatalf("invites = %#v", invites.Invites)
	}
}

func TestTeamSyncAndPrivateSlots(t *testing.T) {
	env := newWatchTestEnv(t)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	owner := newWatchTestAccount(t, router, "sync-owner@example.com")
	member := newWatchTestAccount(t, router, "sync-member@example.com")
	teamID := createTeamOverHTTP(t, router, owner, "Acme")
	addMemberOverHTTP(t, router, teamID, owner, member)

	pushed := teamCall(router, member, http.MethodPost, "/teams/"+teamID+"/sync",
		`{"hosts":[{"id":"h1","encrypted_payload":"team-cipher","updated_at":"2026-10-19T01:00:00.000Z"}]}`, nil)
	expectStatus(t, pushed, http.StatusAccepted, "team push")
	var revision struct {
		Revision int64 `json:"revision"`
	}
	decodeJSON(t, pushed, &revision)
	if revision.Revision != 1 {
		t.Fatalf("team revision = %d", revision.Revision)
	}
	pulled := teamCall(router, owner, http.MethodGet, "/teams/"+teamID+"/sync", "", nil)
	expectStatus(t, pulled, http.StatusOK, "team pull")
	if etag := pulled.Header().Get("ETag"); etag != `"1"` {
		t.Fatalf("team ETag = %q", etag)
	}
	var payload map[string][]map[string]any
	decodeJSON(t, pulled, &payload)
	if len(payload["hosts"]) != 1 || payload["hosts"][0]["encrypted_payload"] != "team-cipher" {
		t.Fatalf("team payload = %#v", payload)
	}
	expectStatus(t, teamCall(router, owner, http.MethodGet, "/teams/"+teamID+"/sync", "", map[string]string{"If-None-Match": `"1"`}), http.StatusNotModified, "team pull unchanged")

	// 개인 칸: 볼트 세대 펜스, 주인만 본다.
	private := `{"hostPrefs":[{"id":"h1","encrypted_payload":"mine","updated_at":"2026-10-19T01:00:00.000Z"}]}`
	expectTeamCode(t, teamCall(router, owner, http.MethodPut, "/teams/"+teamID+"/me", private, nil), http.StatusConflict, "vault_dek_mismatch", "private without epoch")
	expectStatus(t, teamCall(router, owner, http.MethodPut, "/teams/"+teamID+"/me", private, epochHeader(owner)), http.StatusAccepted, "private push")
	ownerPrivate := teamCall(router, owner, http.MethodGet, "/teams/"+teamID+"/me", "", nil)
	expectStatus(t, ownerPrivate, http.StatusOK, "owner private pull")
	var ownerSlot map[string][]map[string]any
	decodeJSON(t, ownerPrivate, &ownerSlot)
	if len(ownerSlot["hostPrefs"]) != 1 {
		t.Fatalf("owner private slot = %#v", ownerSlot)
	}
	memberPrivate := teamCall(router, member, http.MethodGet, "/teams/"+teamID+"/me", "", nil)
	expectStatus(t, memberPrivate, http.StatusOK, "member private pull")
	var memberSlot map[string][]map[string]any
	decodeJSON(t, memberPrivate, &memberSlot)
	if len(memberSlot) != 0 {
		t.Fatalf("member sees someone else's private slot: %#v", memberSlot)
	}
}

func TestTeamDataFloorGatesOnlyThatTeam(t *testing.T) {
	restore := httpserver.SetTeamDataFloorMinimumVersionsForTest(map[int]map[string]string{1: {"desktop": "9.0.0"}})
	defer restore()
	env := newWatchTestEnv(t)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	owner := newWatchTestAccount(t, router, "floor-owner@example.com")
	gated := createTeamOverHTTP(t, router, owner, "New format")
	plain := createTeamOverHTTP(t, router, owner, "Old format")

	expectStatus(t, teamCall(router, owner, http.MethodPost, "/teams/"+gated+"/sync",
		`{"hosts":[{"id":"h1","encrypted_payload":"x","updated_at":"2026-10-19T01:00:00.000Z"}]}`,
		map[string]string{"X-Dolgate-Sync-Data-Floor": "1"}), http.StatusAccepted, "push raising floor")

	oldDesktop := map[string]string{"X-Dolgate-Client": "desktop", "X-Dolgate-Client-Version": "1.9.14"}
	expectTeamCode(t, teamCall(router, owner, http.MethodGet, "/teams/"+gated+"/sync", "", oldDesktop), http.StatusUpgradeRequired, "team_client_outdated", "old desktop on gated team")
	expectStatus(t, teamCall(router, owner, http.MethodGet, "/teams/"+plain+"/sync", "", oldDesktop), http.StatusOK, "old desktop on another team")
	expectStatus(t, teamCall(router, owner, http.MethodGet, "/sync", "", oldDesktop), http.StatusOK, "old desktop personal sync")
	newDesktop := map[string]string{"X-Dolgate-Client": "desktop", "X-Dolgate-Client-Version": "9.0.0"}
	expectStatus(t, teamCall(router, owner, http.MethodGet, "/teams/"+gated+"/sync", "", newDesktop), http.StatusOK, "new desktop on gated team")
}

// teamWatchAsync 는 팀 감시를 고루틴에서 걸고, 허브에 실제로 걸릴 때까지 기다린다.
func teamWatchAsync(t *testing.T, router *gin.Engine, hub *httpserver.SyncWatchHub, account *watchTestAccount, teamID string, etag string) <-chan *httptest.ResponseRecorder {
	t.Helper()
	before := hub.WaitersForTest()
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		result <- teamCall(router, account, http.MethodGet, "/teams/"+teamID+"/sync/watch", "", map[string]string{"If-None-Match": etag})
	}()
	deadline := time.Now().Add(5 * time.Second)
	for hub.WaitersForTest() <= before {
		select {
		case recorder := <-result:
			t.Fatalf("team watch answered before waiting: %d %s", recorder.Code, recorder.Body.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("team watch never started waiting")
		}
		time.Sleep(2 * time.Millisecond)
	}
	return result
}

func currentTeamWatchETag(t *testing.T, router *gin.Engine, account *watchTestAccount, teamID string) string {
	t.Helper()
	recorder := teamCall(router, account, http.MethodGet, "/teams/"+teamID+"/sync/watch", "", nil)
	expectStatus(t, recorder, http.StatusOK, "first team watch")
	return recorder.Header().Get("ETag")
}

func TestTeamWatchWakesMembersAndOnlyTheOwnerOfAPrivateSlot(t *testing.T) {
	env := newWatchTestEnv(t)
	hub := env.hub(t, time.Hour)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: hub, SyncWatchHold: 400 * time.Millisecond})
	owner := newWatchTestAccount(t, router, "watch-team-owner@example.com")
	member := newWatchTestAccount(t, router, "watch-team-member@example.com")
	teamID := createTeamOverHTTP(t, router, owner, "Acme")
	addMemberOverHTTP(t, router, teamID, owner, member)

	// 다른 멤버의 push 에 바로 깨어난다.
	memberETag := currentTeamWatchETag(t, router, member, teamID)
	waiting := teamWatchAsync(t, router, hub, member, teamID, memberETag)
	expectStatus(t, teamCall(router, owner, http.MethodPost, "/teams/"+teamID+"/sync",
		`{"hosts":[{"id":"h1","encrypted_payload":"x","updated_at":"2026-10-19T01:00:00.000Z"}]}`, nil), http.StatusAccepted, "owner push")
	woke := awaitWatch(t, waiting, 2*time.Second, "member watch after push")
	expectStatus(t, woke, http.StatusOK, "member watch after push")
	var changed struct {
		Revision        int64 `json:"revision"`
		PrivateRevision int64 `json:"privateRevision"`
	}
	decodeJSON(t, woke, &changed)
	if changed.Revision != 1 {
		t.Fatalf("watch body = %s", woke.Body.String())
	}

	// 내 개인 칸이 바뀌면 내 기기만 깨어난다 — 다른 멤버는 대기 시간이 다 돼 304 다.
	memberETag = woke.Header().Get("ETag")
	ownerETag := currentTeamWatchETag(t, router, owner, teamID)
	memberWaiting := teamWatchAsync(t, router, hub, member, teamID, memberETag)
	ownerWaiting := teamWatchAsync(t, router, hub, owner, teamID, ownerETag)
	expectStatus(t, teamCall(router, owner, http.MethodPut, "/teams/"+teamID+"/me",
		`{"hostPrefs":[{"id":"h1","encrypted_payload":"mine","updated_at":"2026-10-19T01:00:00.000Z"}]}`, epochHeader(owner)), http.StatusAccepted, "owner private push")
	ownerWoke := awaitWatch(t, ownerWaiting, 2*time.Second, "owner watch after private push")
	expectStatus(t, ownerWoke, http.StatusOK, "owner watch after private push")
	decodeJSON(t, ownerWoke, &changed)
	if changed.PrivateRevision != 1 {
		t.Fatalf("owner watch body = %s", ownerWoke.Body.String())
	}
	expectStatus(t, awaitWatch(t, memberWaiting, 2*time.Second, "member watch after owner's private push"), http.StatusNotModified, "member watch after owner's private push")

	// 제거되면 기다리던 감시가 404 로 끝난다.
	memberWaiting = teamWatchAsync(t, router, hub, member, teamID, memberETag)
	var members struct {
		Members []struct {
			UserID string `json:"userId"`
		} `json:"members"`
	}
	listed := teamCall(router, owner, http.MethodGet, "/teams/"+teamID+"/members", "", nil)
	decodeJSON(t, listed, &members)
	expectStatus(t, teamCall(router, owner, http.MethodPost, "/teams/"+teamID+"/members/"+members.Members[1].UserID+"/remove", "", nil), http.StatusNoContent, "remove")
	expectTeamCode(t, awaitWatch(t, memberWaiting, 2*time.Second, "removed member watch"), http.StatusNotFound, "team_not_found", "removed member watch")
}

// 다른 서버로 들어온 팀 변경도 묶음 확인이 잡는다.
func TestTeamWatchWakesWhenThePushLandsOnAnotherServer(t *testing.T) {
	env := newWatchTestEnv(t)
	hubA := env.hub(t, 20*time.Millisecond)
	routerA := env.router(t, httpserver.RouterConfig{SyncWatch: hubA})
	routerB := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	owner := newWatchTestAccount(t, routerA, "watch-other-owner@example.com")
	teamID := createTeamOverHTTP(t, routerA, owner, "Acme")

	waiting := teamWatchAsync(t, routerA, hubA, owner, teamID, currentTeamWatchETag(t, routerA, owner, teamID))
	expectStatus(t, teamCall(routerB, owner, http.MethodPost, "/teams/"+teamID+"/sync",
		`{"hosts":[{"id":"h1","encrypted_payload":"x","updated_at":"2026-10-19T01:00:00.000Z"}]}`, nil), http.StatusAccepted, "push on server B")
	expectStatus(t, awaitWatch(t, waiting, 2*time.Second, "watch on server A"), http.StatusOK, "watch on server A")
}

// 팀 목록이 바뀐 사람의 다른 기기는 개인 감시로 알게 된다(참여·제거·팀 삭제).
func TestTeamMembershipChangesWakeThePersonalWatch(t *testing.T) {
	env := newWatchTestEnv(t)
	hub := env.hub(t, time.Hour)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: hub})
	owner := newWatchTestAccount(t, router, "personal-owner@example.com")
	member := newWatchTestAccount(t, router, "personal-member@example.com")
	teamID := createTeamOverHTTP(t, router, owner, "Acme")

	code, token := createInviteOverHTTP(t, router, owner, teamID, time.Hour)
	waiting := member.watchAsync(t, router, hub, member.currentETag(t, router))
	expectStatus(t, joinOverHTTP(router, member, code, token), http.StatusOK, "join")
	expectStatus(t, awaitWatch(t, waiting, 2*time.Second, "member's personal watch after join"), http.StatusOK, "member's personal watch after join")
	expectStatus(t, teamCall(router, member, http.MethodPut, "/teams/"+teamID+"/key", `{"wrappedTeamDek":"member-copy"}`, epochHeader(member)), http.StatusNoContent, "put key")

	var members struct {
		Members []struct {
			UserID string `json:"userId"`
		} `json:"members"`
	}
	decodeJSON(t, teamCall(router, owner, http.MethodGet, "/teams/"+teamID+"/members", "", nil), &members)
	waiting = member.watchAsync(t, router, hub, member.currentETag(t, router))
	expectStatus(t, teamCall(router, owner, http.MethodPost, "/teams/"+teamID+"/members/"+members.Members[1].UserID+"/remove", "", nil), http.StatusNoContent, "remove")
	expectStatus(t, awaitWatch(t, waiting, 2*time.Second, "member's personal watch after removal"), http.StatusOK, "member's personal watch after removal")

	addMemberOverHTTP(t, router, teamID, owner, member)
	ownerWaiting := owner.watchAsync(t, router, hub, owner.currentETag(t, router))
	memberWaiting := member.watchAsync(t, router, hub, member.currentETag(t, router))
	expectStatus(t, teamCall(router, owner, http.MethodDelete, "/teams/"+teamID, "", nil), http.StatusNoContent, "delete team")
	expectStatus(t, awaitWatch(t, ownerWaiting, 2*time.Second, "owner's personal watch after delete"), http.StatusOK, "owner's personal watch after delete")
	expectStatus(t, awaitWatch(t, memberWaiting, 2*time.Second, "member's personal watch after delete"), http.StatusOK, "member's personal watch after delete")
	var list struct {
		Teams []any `json:"teams"`
	}
	decodeJSON(t, teamCall(router, member, http.MethodGet, "/teams", "", nil), &list)
	if len(list.Teams) != 0 {
		t.Fatalf("member still sees the deleted team: %#v", list.Teams)
	}
}

// 볼트를 초기화하면 모든 팀에서 빠지고, 소유자였으면 가장 먼저 들어온 멤버가 잇는다.
func TestTeamVaultResetLeavesEveryTeam(t *testing.T) {
	env := newWatchTestEnv(t)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	owner := newWatchTestAccount(t, router, "reset-owner@example.com")
	member := newWatchTestAccount(t, router, "reset-member@example.com")
	teamID := createTeamOverHTTP(t, router, owner, "Acme")
	addMemberOverHTTP(t, router, teamID, owner, member)

	reset := teamCall(router, owner, http.MethodPost, "/auth/vault/reset", fmt.Sprintf(`{"expectedEpoch":%d}`, owner.epoch), nil)
	expectStatus(t, reset, http.StatusOK, "vault reset")
	var list struct {
		Teams []struct {
			ID   string `json:"id"`
			Role string `json:"role"`
		} `json:"teams"`
	}
	decodeJSON(t, teamCall(router, owner, http.MethodGet, "/teams", "", nil), &list)
	if len(list.Teams) != 0 {
		t.Fatalf("owner still in teams after reset: %#v", list.Teams)
	}
	decodeJSON(t, teamCall(router, member, http.MethodGet, "/teams", "", nil), &list)
	if len(list.Teams) != 1 || list.Teams[0].ID != teamID || list.Teams[0].Role != "owner" {
		t.Fatalf("member teams after owner reset = %#v", list.Teams)
	}
}

func TestServerInfoAdvertisesTeams(t *testing.T) {
	env := newWatchTestEnv(t)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/info", nil))
	expectStatus(t, recorder, http.StatusOK, "server info")
	var body struct {
		Capabilities struct {
			Teams struct {
				Enabled bool `json:"enabled"`
			} `json:"teams"`
		} `json:"capabilities"`
	}
	decodeJSON(t, recorder, &body)
	if !body.Capabilities.Teams.Enabled {
		t.Fatalf("server info does not advertise teams: %s", recorder.Body.String())
	}
}

// 초기화·탈퇴로 빠진 사람이 있으면 남은 멤버의 팀 감시가 바로 깨어난다(묶음 확인을 기다리지 않는다).
func TestTeamVaultResetAndAccountDeletionWakeRemainingMembers(t *testing.T) {
	env := newWatchTestEnv(t)
	hub := env.hub(t, time.Hour)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: hub})
	owner := newWatchTestAccount(t, router, "wake-owner@example.com")
	member := newWatchTestAccount(t, router, "wake-member@example.com")
	other := newWatchTestAccount(t, router, "wake-other@example.com")
	teamID := createTeamOverHTTP(t, router, owner, "Acme")
	addMemberOverHTTP(t, router, teamID, owner, member)
	addMemberOverHTTP(t, router, teamID, owner, other)

	waiting := teamWatchAsync(t, router, hub, member, teamID, currentTeamWatchETag(t, router, member, teamID))
	expectStatus(t, teamCall(router, owner, http.MethodPost, "/auth/vault/reset", fmt.Sprintf(`{"expectedEpoch":%d}`, owner.epoch), nil), http.StatusOK, "owner vault reset")
	expectStatus(t, awaitWatch(t, waiting, 2*time.Second, "member team watch after owner reset"), http.StatusOK, "member team watch after owner reset")

	waiting = teamWatchAsync(t, router, hub, other, teamID, currentTeamWatchETag(t, router, other, teamID))
	expectStatus(t, teamCall(router, member, http.MethodDelete, "/auth/account", "", nil), http.StatusNoContent, "member account deletion")
	expectStatus(t, awaitWatch(t, waiting, 2*time.Second, "other team watch after member deletion"), http.StatusOK, "other team watch after member deletion")
}

// 링크 페이지는 로그인 없이 열리고 팀 이름만 보인다 — 이름은 HTML 로 이스케이프되고, 초대한 사람·상자는 없다.
// `앱 열기` 는 로그인 콜백(dolgate://)과 다른 스킴으로 넘긴다.
func TestTeamInvitePageShowsOnlyTheTeamName(t *testing.T) {
	env := newWatchTestEnv(t)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	owner := newWatchTestAccount(t, router, "invite-page-owner@example.com")
	teamID := createTeamOverHTTP(t, router, owner, "Acme <script>alert(1)</script>")
	code, _ := createInviteOverHTTP(t, router, owner, teamID, time.Hour)

	request := httptest.NewRequest(http.MethodGet, "/invite/"+code, nil)
	request.Header.Set("Accept-Language", "ko-KR,ko;q=0.9")
	page := httptest.NewRecorder()
	router.ServeHTTP(page, request)

	expectStatus(t, page, http.StatusOK, "invite page")
	body := page.Body.String()
	for _, want := range []string{
		"Acme &lt;script&gt;alert(1)&lt;/script&gt;",
		`property="og:title"`,
		"Dolgate 에서 열기",
		"Dolgate 내려받기",
		`"dolgate-invite"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("invite page lacks %q:\n%s", want, body)
		}
	}
	for _, unwanted := range []string{"<script>alert(1)", "invite-page-owner@example.com", "sealed-team-key"} {
		if strings.Contains(body, unwanted) {
			t.Fatalf("invite page shows %q:\n%s", unwanted, body)
		}
	}
	if csp := page.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'none'") {
		t.Fatalf("invite page CSP = %q", csp)
	}
	if cache := page.Header().Get("Cache-Control"); cache != "no-store" {
		t.Fatalf("invite page Cache-Control = %q", cache)
	}
}

// 취소했거나 없는 링크는 팀 이름 없이 만료 안내만 보인다(열기 단추도 없다).
func TestTeamInvitePageForAnUnusableLink(t *testing.T) {
	env := newWatchTestEnv(t)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	owner := newWatchTestAccount(t, router, "invite-page-gone@example.com")
	teamID := createTeamOverHTTP(t, router, owner, "Hidden Team")
	code, _ := createInviteOverHTTP(t, router, owner, teamID, time.Hour)
	expectStatus(t, teamCall(router, owner, http.MethodDelete, "/teams/"+teamID+"/invites/"+code, "", nil), http.StatusNoContent, "revoke")

	for _, path := range []string{"/invite/" + code, "/invite/no-such-code"} {
		page := httptest.NewRecorder()
		router.ServeHTTP(page, httptest.NewRequest(http.MethodGet, path, nil))
		expectStatus(t, page, http.StatusNotFound, path)
		body := page.Body.String()
		if !strings.Contains(body, "This invite link has expired") {
			t.Fatalf("%s: no expiry notice:\n%s", path, body)
		}
		for _, unwanted := range []string{"Hidden Team", "open-app", "dolgate-invite"} {
			if strings.Contains(body, unwanted) {
				t.Fatalf("%s: shows %q:\n%s", path, unwanted, body)
			}
		}
	}
}
