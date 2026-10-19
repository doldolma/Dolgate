package http

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"dolssh/services/sync-api/internal/auth"
	storepkg "dolssh/services/sync-api/internal/store"
	syncmodel "dolssh/services/sync-api/internal/sync"
)

// 팀 볼트 API. 사본·상자·레코드는 암호문 그대로 오가고 서버는 내용을 보지 않는다. 서버가 아는 것은
// 팀 이름과 멤버 목록(평문)뿐이다.

const (
	// teamInviteTokenHeader 는 참여 토큰을 싣는 헤더다. 주소(쿼리)에 실으면 요청 로그(gin.Logger)에 남는다.
	teamInviteTokenHeader = "X-Dolgate-Invite-Token"
	teamGateContextKey    = "dolgate.teamGate"

	teamNameMaxRunes        = 100
	teamWrappedKeyMaxBytes  = 4096
	teamInviteBoxMaxBytes   = 8192
	teamInviteTokenMaxBytes = 512
	// teamInviteMaxLifetime 은 링크 기한으로 고를 수 있는 가장 긴 값(30일)에 시계 차이를 조금 더한 것이다.
	teamInviteMaxLifetime = 30*24*time.Hour + 5*time.Minute
)

// teamDataFloorMinimumVersions 는 팀 데이터 수준별로, 그 팀 데이터를 다룰 수 있는 최소 클라이언트
// 버전이다(계정의 syncDataFloorMinimumVersions 와 같은 방식, 팀 단위). 지금은 형식이 하나뿐이라 비어
// 있다 — 형식을 바꿀 때 수준을 정의하면, 그 형식을 쓰기 시작한 팀만 옛 앱이 막힌다.
var teamDataFloorMinimumVersions = map[int]map[string]string{}

var teamJoinTokenHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func registerTeamRoutes(
	router *gin.Engine,
	dataStore storepkg.Store,
	authService *auth.Service,
	syncWatch *SyncWatchHub,
	syncWatchHold time.Duration,
	requireExistingUser gin.HandlerFunc,
) {
	noStore := func(ctx *gin.Context) {
		ctx.Header("Cache-Control", "no-store")
		ctx.Next()
	}

	// touchPersonal 은 팀 목록이 바뀐 사람의 개인 리비전을 올리고 개인 감시를 깨운다 — 그 사람의 다른
	// 기기가 GET /teams 를 다시 읽게. 팀 쪽 트랜잭션이 커밋된 뒤 따로 한다(잠금 순서 users → teams 를
	// 거꾸로 잡지 않으려고). 실패해도 응답은 성공이다 — 다음 GET /teams 에서 맞춰진다.
	touchPersonal := func(ctx *gin.Context, userIDs ...string) {
		background := context.WithoutCancel(ctx.Request.Context())
		if err := dataStore.TouchSyncRevisions(background, userIDs); err != nil {
			log.Printf("teams: 개인 리비전 올리기 실패: %v", err)
		}
		for _, userID := range userIDs {
			syncWatch.notify(userID)
		}
	}

	teams := router.Group("/teams")
	teams.Use(authMiddleware(authService), requireExistingUser, noStore)

	teams.POST("", func(ctx *gin.Context) {
		userID := ctx.GetString("userId")
		var request struct {
			ID             string `json:"id"`
			Name           string `json:"name"`
			WrappedTeamDek string `json:"wrappedTeamDek"`
		}
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		name, ok := normalizeTeamName(request.Name)
		if !ok || !validTeamID(request.ID) || !validOpaque(request.WrappedTeamDek, teamWrappedKeyMaxBytes) {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
			return
		}
		epoch, ok := requireVaultEpochHeader(ctx)
		if !ok {
			return
		}
		team, err := dataStore.CreateTeam(ctx.Request.Context(), storepkg.CreateTeamInput{
			TeamID:         request.ID,
			Name:           name,
			OwnerID:        userID,
			WrappedTeamDek: request.WrappedTeamDek,
			VaultEpoch:     epoch,
		})
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		touchPersonal(ctx, userID)
		ctx.JSON(http.StatusCreated, teamSummaryJSON(team))
	})

	teams.GET("", func(ctx *gin.Context) {
		list, err := dataStore.ListTeamsForUser(ctx.Request.Context(), ctx.GetString("userId"))
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		items := make([]gin.H, 0, len(list))
		for _, team := range list {
			items = append(items, teamSummaryJSON(team))
		}
		ctx.JSON(http.StatusOK, gin.H{"teams": items})
	})

	team := teams.Group("/:teamId")
	// 멤버가 아니면 404 다 — 팀이 있는지도 알리지 않는다. 게이트 값(역할·수준·리비전)은 한 번 읽어 둔다.
	team.Use(func(ctx *gin.Context) {
		gate, err := dataStore.GetTeamGate(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"))
		if err != nil {
			logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
			ctx.Abort()
			return
		}
		if !gate.Member {
			respondTeamError(ctx, storepkg.ErrTeamNotFound)
			ctx.Abort()
			return
		}
		ctx.Set(teamGateContextKey, gate)
		ctx.Next()
	})

	team.PATCH("", func(ctx *gin.Context) {
		teamID := ctx.Param("teamId")
		var request struct {
			Name string `json:"name"`
		}
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		name, ok := normalizeTeamName(request.Name)
		if !ok {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "팀 이름을 확인해 주세요."})
			return
		}
		if err := dataStore.RenameTeam(ctx.Request.Context(), teamID, ctx.GetString("userId"), name); err != nil {
			respondTeamError(ctx, err)
			return
		}
		syncWatch.notifyTeam(teamID)
		ctx.Status(http.StatusNoContent)
	})

	team.DELETE("", func(ctx *gin.Context) {
		teamID := ctx.Param("teamId")
		memberIDs, err := dataStore.DeleteTeam(ctx.Request.Context(), teamID, ctx.GetString("userId"))
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		// 팀 감시를 기다리던 기기는 깨어나 404 를 받고, 개인 감시로는 팀 목록이 바뀐 것을 안다.
		syncWatch.notifyTeam(teamID)
		touchPersonal(ctx, memberIDs...)
		ctx.Status(http.StatusNoContent)
	})

	team.POST("/owner", func(ctx *gin.Context) {
		teamID := ctx.Param("teamId")
		var request struct {
			UserID string `json:"userId"`
		}
		if err := ctx.ShouldBindJSON(&request); err != nil || strings.TrimSpace(request.UserID) == "" {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		if err := dataStore.TransferTeamOwnership(ctx.Request.Context(), teamID, ctx.GetString("userId"), request.UserID); err != nil {
			respondTeamError(ctx, err)
			return
		}
		syncWatch.notifyTeam(teamID)
		ctx.Status(http.StatusNoContent)
	})

	team.GET("/members", func(ctx *gin.Context) {
		members, err := dataStore.ListTeamMembers(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"))
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		items := make([]gin.H, 0, len(members))
		for _, member := range members {
			items = append(items, gin.H{
				"userId":       member.UserID,
				"email":        member.Email,
				"role":         member.Role,
				"hasKey":       member.HasKey,
				"addedBy":      member.AddedBy,
				"addedByEmail": member.AddedByEmail,
				"addedAt":      member.AddedAt.UTC().Format(time.RFC3339),
			})
		}
		ctx.JSON(http.StatusOK, gin.H{"members": items})
	})

	team.POST("/members/:userId/remove", func(ctx *gin.Context) {
		teamID := ctx.Param("teamId")
		targetID := ctx.Param("userId")
		if err := dataStore.RemoveTeamMember(ctx.Request.Context(), teamID, ctx.GetString("userId"), targetID); err != nil {
			respondTeamError(ctx, err)
			return
		}
		syncWatch.notifyTeam(teamID)
		touchPersonal(ctx, targetID)
		ctx.Status(http.StatusNoContent)
	})

	team.POST("/leave", func(ctx *gin.Context) {
		teamID := ctx.Param("teamId")
		userID := ctx.GetString("userId")
		result, err := dataStore.LeaveTeam(ctx.Request.Context(), teamID, userID)
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		syncWatch.notifyTeam(teamID)
		touchPersonal(ctx, userID)
		ctx.JSON(http.StatusOK, gin.H{"teamDeleted": result.TeamDeleted})
	})

	// 링크로 들어온 사람이 상자에서 꺼낸 팀 키를 자기 개인 DEK 로 감싸 올린다. 개인 push 와 같은 볼트
	// 세대 펜스를 건다 — 초기화 전 DEK 를 쥔 기기가 옛 키로 감싼 사본을 올리지 못하게.
	team.PUT("/key", func(ctx *gin.Context) {
		teamID := ctx.Param("teamId")
		var request struct {
			WrappedTeamDek string `json:"wrappedTeamDek"`
		}
		if err := ctx.ShouldBindJSON(&request); err != nil || !validOpaque(request.WrappedTeamDek, teamWrappedKeyMaxBytes) {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		epoch, ok := requireVaultEpochHeader(ctx)
		if !ok {
			return
		}
		if err := dataStore.PutTeamMemberKey(ctx.Request.Context(), teamID, ctx.GetString("userId"), request.WrappedTeamDek, epoch); err != nil {
			respondTeamError(ctx, err)
			return
		}
		syncWatch.notifyTeam(teamID)
		ctx.Status(http.StatusNoContent)
	})

	team.POST("/invites", func(ctx *gin.Context) {
		teamID := ctx.Param("teamId")
		var request struct {
			InviteBox     string `json:"inviteBox"`
			JoinTokenHash string `json:"joinTokenHash"`
			ExpiresAt     string `json:"expiresAt"`
		}
		if err := ctx.ShouldBindJSON(&request); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		expiresAt, err := time.Parse(time.RFC3339, request.ExpiresAt)
		now := time.Now().UTC()
		if err != nil || !expiresAt.After(now) || expiresAt.Sub(now) > teamInviteMaxLifetime ||
			!validOpaque(request.InviteBox, teamInviteBoxMaxBytes) ||
			!teamJoinTokenHashPattern.MatchString(request.JoinTokenHash) {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
			return
		}
		invite, err := dataStore.CreateTeamInvite(ctx.Request.Context(), storepkg.CreateTeamInviteInput{
			TeamID:        teamID,
			CreatedBy:     ctx.GetString("userId"),
			InviteBox:     request.InviteBox,
			JoinTokenHash: request.JoinTokenHash,
			ExpiresAt:     expiresAt,
		})
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		syncWatch.notifyTeam(teamID)
		ctx.JSON(http.StatusCreated, teamInviteJSON(invite))
	})

	team.GET("/invites", func(ctx *gin.Context) {
		invites, err := dataStore.ListTeamInvites(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"))
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		items := make([]gin.H, 0, len(invites))
		for _, invite := range invites {
			items = append(items, teamInviteJSON(invite))
		}
		ctx.JSON(http.StatusOK, gin.H{"invites": items})
	})

	team.DELETE("/invites/:code", func(ctx *gin.Context) {
		teamID := ctx.Param("teamId")
		if err := dataStore.RevokeTeamInvite(ctx.Request.Context(), teamID, ctx.GetString("userId"), ctx.Param("code")); err != nil {
			respondTeamError(ctx, err)
			return
		}
		syncWatch.notifyTeam(teamID)
		ctx.Status(http.StatusNoContent)
	})

	// 아래는 팀 데이터(레코드·개인 칸)를 다루는 길이라 팀 데이터 수준을 못 따라오는 앱을 막는다.
	// 그 팀만 막히고 개인 동기화와 다른 팀은 그대로다.
	data := team.Group("")
	data.Use(func(ctx *gin.Context) {
		gate := ctx.MustGet(teamGateContextKey).(storepkg.TeamGate)
		if rejectOutdatedClientForTeamFloor(ctx, gate.DataFloor) {
			return
		}
		ctx.Next()
	})

	data.GET("/me", func(ctx *gin.Context) {
		gate := ctx.MustGet(teamGateContextKey).(storepkg.TeamGate)
		if match := strings.TrimSpace(ctx.GetHeader("If-None-Match")); match != "" && match == syncRevisionETag(gate.PrivateRevision) {
			ctx.Header("ETag", match)
			ctx.Status(http.StatusNotModified)
			return
		}
		revision, payload, err := dataStore.GetTeamPrivateSnapshot(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"))
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		ctx.Header("ETag", syncRevisionETag(revision))
		ctx.JSON(http.StatusOK, payload)
	})

	// 개인 칸은 그 멤버의 개인 DEK 로 잠근 것이라 볼트 세대 펜스를 건다. 바뀌면 그 멤버의 기기만 깨운다.
	data.PUT("/me", func(ctx *gin.Context) {
		teamID := ctx.Param("teamId")
		userID := ctx.GetString("userId")
		epoch, ok := requireVaultEpochHeader(ctx)
		if !ok {
			return
		}
		var payload syncmodel.Payload
		if err := ctx.ShouldBindJSON(&payload); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		revision, err := dataStore.ApplyTeamPrivateRecords(ctx.Request.Context(), teamID, userID, payload, epoch)
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		syncWatch.notifyTeamMember(teamID, userID)
		ctx.JSON(http.StatusAccepted, gin.H{"revision": revision})
	})

	data.GET("/sync", func(ctx *gin.Context) {
		gate := ctx.MustGet(teamGateContextKey).(storepkg.TeamGate)
		if match := strings.TrimSpace(ctx.GetHeader("If-None-Match")); match != "" && match == syncRevisionETag(gate.Revision) {
			ctx.Header("ETag", match)
			ctx.Status(http.StatusNotModified)
			return
		}
		revision, payload, err := dataStore.GetTeamSyncSnapshot(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"))
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		ctx.Header("ETag", syncRevisionETag(revision))
		ctx.JSON(http.StatusOK, payload)
	})

	data.POST("/sync", func(ctx *gin.Context) {
		teamID := ctx.Param("teamId")
		// 계정 수준과 같이, 레코드를 받기 전에 올린다 — 그 사이 붙은 옛 앱이 새 레코드를 받아 가지 않게.
		if floor := parseTeamDataFloorHeader(ctx.GetHeader(syncDataFloorHeader)); floor > 0 {
			if err := dataStore.RaiseTeamDataFloor(ctx.Request.Context(), teamID, floor); err != nil {
				logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
				return
			}
		}
		var payload syncmodel.Payload
		if err := ctx.ShouldBindJSON(&payload); err != nil {
			logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
			return
		}
		revision, err := dataStore.ApplyTeamPushRecords(ctx.Request.Context(), teamID, ctx.GetString("userId"), payload)
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		syncWatch.notifyTeam(teamID)
		ctx.JSON(http.StatusAccepted, gin.H{"revision": revision})
	})

	// 팀 변경 대기(롱폴링). 개인 /sync/watch 와 같은 방식인데, 팀 레코드·팀 정보·내 개인 칸 셋을 함께
	// 본다. 무엇이 바뀌었는지 응답에 실어 앱이 그것만 다시 받게 한다. If-None-Match 가 없거나 지금과
	// 다르면 바로 답한다 — 앱은 첫 요청으로 지금 값을 받는다.
	data.GET("/sync/watch", func(ctx *gin.Context) {
		teamID := ctx.Param("teamId")
		userID := ctx.GetString("userId")
		gate := ctx.MustGet(teamGateContextKey).(storepkg.TeamGate)
		known := strings.TrimSpace(ctx.GetHeader("If-None-Match"))
		if known != teamWatchETag(gate) {
			respondTeamWatchChanged(ctx, gate)
			return
		}
		since := gate.WatchValue()

		deadline := time.NewTimer(jitterSyncWatchHold(syncWatchHold))
		defer deadline.Stop()
		for {
			changed, release := syncWatch.subscribeTeam(teamID, userID, since)
			woke := false
			select {
			case <-changed:
				woke = true
			case <-deadline.C:
			case <-syncWatch.done():
			case <-ctx.Request.Context().Done():
			}
			release()
			if !woke {
				ctx.Header("ETag", known)
				ctx.Status(http.StatusNotModified)
				return
			}
			current, err := dataStore.GetTeamGate(ctx.Request.Context(), teamID, userID)
			if err != nil {
				logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
				return
			}
			if !current.Member {
				// 빠졌거나 팀이 지워졌다 — 앱은 그 팀의 로컬 데이터를 지운다.
				respondTeamError(ctx, storepkg.ErrTeamNotFound)
				return
			}
			if current.WatchValue() != since {
				respondTeamWatchChanged(ctx, current)
				return
			}
			// 이 기기는 이미 그 값이다(다른 멤버 몫의 신호 등). 남은 시간 동안 다시 기다린다.
		}
	})

	invites := router.Group("/invite")
	invites.Use(authMiddleware(authService), requireExistingUser, noStore)

	// 참여 카드에 보일 것만 준다. 상자는 주지 않는다 — 상자는 참여할 때만 준다. 토큰이 맞지 않으면
	// 답하지 않으니 번호만 아는 사람은 팀 이름 말고는 볼 수 없다.
	invites.GET("/:code/info", func(ctx *gin.Context) {
		token, ok := teamInviteToken(ctx)
		if !ok {
			return
		}
		info, err := dataStore.GetTeamInviteInfo(ctx.Request.Context(), ctx.Param("code"), token)
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		ctx.JSON(http.StatusOK, gin.H{
			"teamId":       info.TeamID,
			"teamName":     info.TeamName,
			"inviterEmail": info.InviterEmail,
			"memberCount":  info.MemberCount,
			"expiresAt":    info.ExpiresAt.UTC().Format(time.RFC3339),
		})
	})

	// 참여하는 순간 멤버가 되고 팀에 알려진 뒤에야 상자를 준다 — 팀 키를 손에 넣은 사람은 반드시 멤버로
	// 드러난다. 사본을 올리기 전에 끊긴 멤버가 다시 부르면 상자만 다시 준다.
	invites.POST("/:code/join", func(ctx *gin.Context) {
		token, ok := teamInviteToken(ctx)
		if !ok {
			return
		}
		userID := ctx.GetString("userId")
		result, err := dataStore.JoinTeam(ctx.Request.Context(), ctx.Param("code"), token, userID)
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		if !result.Rejoined {
			syncWatch.notifyTeam(result.TeamID)
			touchPersonal(ctx, userID)
		}
		ctx.JSON(http.StatusOK, gin.H{
			"teamId":    result.TeamID,
			"teamName":  result.TeamName,
			"inviteBox": result.InviteBox,
			"rejoined":  result.Rejoined,
		})
	})
}

// teamIDsForWake 는 볼트 초기화·탈퇴 전에 그 사람이 든 팀을 읽는다 — 커밋 뒤 남은 멤버들의 팀 감시를
// 바로 깨우려고. 읽기와 커밋 사이에 바뀐 것은 묶음 확인이 몇 초 안에 잡으니, 실패해도 막지 않는다.
func teamIDsForWake(ctx *gin.Context, dataStore storepkg.Store, userID string) []string {
	teams, err := dataStore.ListTeamsForUser(ctx.Request.Context(), userID)
	if err != nil {
		log.Printf("teams: 깨울 팀 목록 읽기 실패: %v", err)
		return nil
	}
	teamIDs := make([]string, 0, len(teams))
	for _, team := range teams {
		teamIDs = append(teamIDs, team.ID)
	}
	return teamIDs
}

func teamSummaryJSON(team storepkg.TeamSummary) gin.H {
	return gin.H{
		"id":             team.ID,
		"name":           team.Name,
		"role":           team.Role,
		"wrappedTeamDek": team.WrappedTeamDek,
		"dataFloor":      team.DataFloor,
		"memberCount":    team.MemberCount,
		"createdAt":      team.CreatedAt.UTC().Format(time.RFC3339),
	}
}

func teamInviteJSON(invite storepkg.TeamInvite) gin.H {
	body := gin.H{
		"code":           invite.Code,
		"createdBy":      invite.CreatedBy,
		"createdByEmail": invite.CreatedByEmail,
		"expiresAt":      invite.ExpiresAt.UTC().Format(time.RFC3339),
		"useCount":       invite.UseCount,
		"createdAt":      invite.CreatedAt.UTC().Format(time.RFC3339),
		"active":         invite.Active,
	}
	if invite.RevokedAt != nil {
		body["revokedAt"] = invite.RevokedAt.UTC().Format(time.RFC3339)
	}
	return body
}

// teamWatchETag 는 팀 감시의 ETag 다. 셋 중 무엇이 바뀌었는지 앱이 알 수 있게 셋을 다 싣는다.
func teamWatchETag(gate storepkg.TeamGate) string {
	return fmt.Sprintf("\"t%d.i%d.p%d\"", gate.Revision, gate.InfoRevision, gate.PrivateRevision)
}

func respondTeamWatchChanged(ctx *gin.Context, gate storepkg.TeamGate) {
	ctx.Header("ETag", teamWatchETag(gate))
	ctx.JSON(http.StatusOK, gin.H{
		"revision":        gate.Revision,
		"infoRevision":    gate.InfoRevision,
		"privateRevision": gate.PrivateRevision,
	})
}

// respondTeamError 는 저장소 오류를 상태 코드로 바꾼다. code 는 앱이 상황을 구분하는 데 쓴다.
func respondTeamError(ctx *gin.Context, err error) {
	switch {
	case errors.Is(err, storepkg.ErrTeamNotFound):
		ctx.JSON(http.StatusNotFound, gin.H{"error": "팀을 찾을 수 없습니다.", "code": "team_not_found"})
	case errors.Is(err, storepkg.ErrTeamOwnerOnly):
		ctx.JSON(http.StatusForbidden, gin.H{"error": "팀 소유자만 할 수 있습니다.", "code": "team_owner_only"})
	case errors.Is(err, storepkg.ErrTeamOwnerMustTransfer):
		ctx.JSON(http.StatusConflict, gin.H{"error": "다른 멤버가 남아 있으면 소유권을 넘긴 뒤에 나갈 수 있습니다.", "code": "team_owner_must_transfer"})
	case errors.Is(err, storepkg.ErrTeamMemberNotFound):
		ctx.JSON(http.StatusNotFound, gin.H{"error": "이 팀의 멤버가 아닙니다.", "code": "team_member_not_found"})
	case errors.Is(err, storepkg.ErrTeamExists):
		ctx.JSON(http.StatusConflict, gin.H{"error": "이미 있는 팀입니다.", "code": "team_exists"})
	case errors.Is(err, storepkg.ErrTeamInviteInvalid):
		ctx.JSON(http.StatusNotFound, gin.H{"error": "초대 링크가 만료되었거나 올바르지 않습니다.", "code": "team_invite_invalid"})
	case errors.Is(err, storepkg.ErrTeamVaultRequired):
		ctx.JSON(http.StatusConflict, gin.H{"error": "동기화 암호를 설정한 계정만 팀을 쓸 수 있습니다.", "code": "team_vault_required"})
	case errors.Is(err, storepkg.ErrTeamAlreadyMember):
		ctx.JSON(http.StatusConflict, gin.H{"error": "이미 이 팀의 멤버입니다.", "code": "team_already_member"})
	case errors.Is(err, storepkg.ErrVaultEpochMismatch):
		ctx.JSON(http.StatusConflict, gin.H{"error": "동기화 암호가 초기화되었습니다. 새 동기화 암호로 잠금을 해제해 주세요.", "code": vaultDekMismatchCode})
	case errors.Is(err, storepkg.ErrBadSyncRecord):
		logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
	default:
		logAndJSONError(ctx, http.StatusInternalServerError, "서버 오류가 발생했습니다.", err)
	}
}

// requireVaultEpochHeader 는 개인 DEK 로 감싼 것을 올리는 요청의 볼트 세대를 읽는다. 없거나 잘못됐으면
// 개인 push 와 같은 409 를 주고 false 다 — 앱은 세션을 갱신해 볼트를 다시 판정한다.
func requireVaultEpochHeader(ctx *gin.Context) (int64, bool) {
	raw := strings.TrimSpace(ctx.GetHeader(vaultEpochHeader))
	epoch, err := strconv.ParseInt(raw, 10, 64)
	if raw == "" || err != nil || epoch < 0 {
		ctx.JSON(http.StatusConflict, gin.H{"error": "동기화 암호가 초기화되었습니다. 새 동기화 암호로 잠금을 해제해 주세요.", "code": vaultDekMismatchCode})
		return 0, false
	}
	return epoch, true
}

func teamInviteToken(ctx *gin.Context) (string, bool) {
	token := strings.TrimSpace(ctx.GetHeader(teamInviteTokenHeader))
	if token == "" || len(token) > teamInviteTokenMaxBytes {
		respondTeamError(ctx, storepkg.ErrTeamInviteInvalid)
		return "", false
	}
	return token, true
}

// validTeamID 는 앱이 만든 팀 ID 가 소문자 표준 UUID 인지 본다. 앱은 이 문자열 그대로 사본의 AAD 에
// 묶으므로 서버가 고쳐 저장하면 안 된다 — 표준형이 아니면 거부한다.
func validTeamID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value
}

func normalizeTeamName(value string) (string, bool) {
	name := strings.TrimSpace(value)
	if name == "" || utf8.RuneCountInString(name) > teamNameMaxRunes {
		return "", false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", false
		}
	}
	return name, true
}

func validOpaque(value string, maxBytes int) bool {
	return value != "" && len(value) <= maxBytes
}

// parseTeamDataFloorHeader 는 팀 push 헤더의 수준을 읽는다. 계정 수준처럼 아는 수준까지만 받는다 —
// 뜻이 없는 큰 값이 저장되면, 나중에 그 수준을 정의하는 순간 그 팀은 이유 없이 막힌다.
func parseTeamDataFloorHeader(value string) int {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0
	}
	parsed, err := strconv.Atoi(trimmed)
	if err != nil || parsed < 0 {
		return 0
	}
	highest := 0
	for level := range teamDataFloorMinimumVersions {
		if level > highest {
			highest = level
		}
	}
	if parsed > highest {
		return highest
	}
	return parsed
}

// rejectOutdatedClientForTeamFloor 는 팀 수준에 못 미치는 클라이언트를 426 으로 막는다(계정의
// rejectOutdatedClientForFloor 와 같은 규칙 — 클라이언트 이름을 안 보내면 통과). true 면 응답을 보냈다.
func rejectOutdatedClientForTeamFloor(ctx *gin.Context, floor int) bool {
	if floor <= 0 {
		return false
	}
	clientName := strings.TrimSpace(ctx.GetHeader(clientHeaderName))
	required := ""
	for level := 1; level <= floor; level++ {
		minimum, gated := teamDataFloorMinimumVersions[level][clientName]
		if !gated {
			continue
		}
		if required == "" || !isClientVersionAtLeast(required, minimum) {
			required = minimum
		}
	}
	if required == "" || isClientVersionAtLeast(ctx.GetHeader(clientVersionHeaderName), required) {
		return false
	}
	ctx.JSON(http.StatusUpgradeRequired, gin.H{"error": "이 팀에는 최신 버전에서 추가한 항목이 있습니다. 앱을 업데이트한 뒤 다시 시도해 주세요.", "code": "team_client_outdated"})
	ctx.Abort()
	return true
}
