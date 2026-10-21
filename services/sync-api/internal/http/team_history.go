package http

import (
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	storepkg "dolssh/services/sync-api/internal/store"
)

// 팀 기록·녹화 API. 앱이 올리는 기록과 녹화는 팀 키로 잠근 암호문이라 서버는 크기와 순서만 본다(서버가
// 남기는 멤버 변화만 평문이다). 팀 데이터 수준 게이트(data 묶음) 아래에 둔다 — 기록·녹화 형식을 바꿀 때
// 그 팀만 옛 앱을 막는다. 기록과 녹화는 팀 감시를 깨우지 않는다 — 앱은 화면을 열 때 읽는다.

const (
	teamEventBatchMax        = 100
	teamEventPayloadMaxBytes = 16 * 1024
	teamEventListDefault     = 100
	teamEventListMax         = 200
	teamEventBodyMaxBytes    = 2 << 20

	teamReplayMetaMaxBytes     = 64 * 1024
	teamReplayJSONBodyMaxBytes = 256 * 1024
	// teamReplaySegmentMaxBytes 는 구간 하나의 크기 상한이다. 앱은 팀 호스트 녹화의 구간을 압축 전 512KB 로
	// 끊으므로 압축이 안 되는 출력이어도 이 아래다 — 자체 호스팅 앞단 프록시의 기본 본문 한도(nginx 1MB)에도
	// 걸리지 않는다.
	teamReplaySegmentMaxBytes     = 1 << 20
	teamReplaySegmentInfoMaxBytes = 2048
	teamReplayExtraMaxBytes       = 1 << 20
	teamReplaySegmentIndexMax     = 1 << 31
	teamReplayListDefault         = 50
	teamReplayListMax             = 100
	teamReplayIDsMax              = 200
	// teamReplayReadMaxBytes·Items 는 구간·덧붙임을 묶어 받는 응답 하나의 상한이다.
	teamReplayReadMaxBytes = 4 << 20
	teamReplayReadMaxItems = 256

	// teamReplaySegmentInfoHeader 는 구간 정보(시각·항목 수·출력 양을 잠근 것)를 싣는다. 본문은 구간 바이트다.
	teamReplaySegmentInfoHeader = "X-Dolgate-Segment-Info"
)

// teamReplayExtraKinds 는 녹화 덧붙임의 종류다 — 구간별 명령 목록과 스냅샷(되감기 화면).
var teamReplayExtraKinds = map[string]bool{"commands": true, "snapshot": true}

func registerTeamHistoryRoutes(data *gin.RouterGroup, dataStore storepkg.Store) {
	// 앱 활동 기록 올리기. 덧붙이기만 한다 — 고치거나 지우는 길은 없다. 쓴 사람은 로그인한 계정이다.
	data.POST("/events", func(ctx *gin.Context) {
		ctx.Request.Body = http.MaxBytesReader(ctx.Writer, ctx.Request.Body, teamEventBodyMaxBytes)
		var request struct {
			Events []struct {
				ID        string `json:"id"`
				CreatedAt string `json:"createdAt"`
				Payload   string `json:"payload"`
			} `json:"events"`
		}
		if err := ctx.ShouldBindJSON(&request); err != nil {
			respondTeamBodyError(ctx, err)
			return
		}
		if len(request.Events) == 0 || len(request.Events) > teamEventBatchMax {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
			return
		}
		inputs := make([]storepkg.TeamEventInput, 0, len(request.Events))
		for _, event := range request.Events {
			createdAt, err := time.Parse(time.RFC3339Nano, event.CreatedAt)
			if err != nil || !validTeamID(event.ID) || !validOpaque(event.Payload, teamEventPayloadMaxBytes) {
				ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
				return
			}
			inputs = append(inputs, storepkg.TeamEventInput{EventID: event.ID, CreatedAt: createdAt, Payload: event.Payload})
		}
		accepted, err := dataStore.AppendTeamEvents(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"), inputs)
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		ctx.JSON(http.StatusOK, gin.H{"accepted": accepted})
	})

	// 기록 읽기. after 를 주면 그 뒤를 오래된 것부터(열려 있는 화면이 새 줄만 받는다), 아니면 before 앞을
	// 최신부터 준다.
	data.GET("/events", func(ctx *gin.Context) {
		before, okBefore := parseTeamHistoryNumber(ctx.Query("before"))
		after, okAfter := parseTeamHistoryNumber(ctx.Query("after"))
		limit, okLimit := parseTeamHistoryLimit(ctx.Query("limit"), teamEventListDefault, teamEventListMax)
		if !okBefore || !okAfter || !okLimit {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
			return
		}
		events, err := dataStore.ListTeamEvents(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"), storepkg.TeamEventQuery{
			Before: before,
			After:  after,
			Limit:  limit,
		})
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		items := make([]gin.H, 0, len(events))
		for _, event := range events {
			items = append(items, teamEventJSON(event))
		}
		ctx.JSON(http.StatusOK, gin.H{"events": items})
	})

	// 녹화 시작. 같은 녹화를 다시 시작하면(응답을 못 받았거나 앱을 다시 켰다) 지금 상태를 그대로 준다.
	data.POST("/replays", func(ctx *gin.Context) {
		ctx.Request.Body = http.MaxBytesReader(ctx.Writer, ctx.Request.Body, teamReplayJSONBodyMaxBytes)
		var request struct {
			RecordingID string `json:"recordingId"`
			StartMeta   string `json:"startMeta"`
		}
		if err := ctx.ShouldBindJSON(&request); err != nil {
			respondTeamBodyError(ctx, err)
			return
		}
		if !validTeamID(request.RecordingID) || !validOpaque(request.StartMeta, teamReplayMetaMaxBytes) {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
			return
		}
		replay, err := dataStore.StartTeamReplay(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"), request.RecordingID, request.StartMeta)
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		ctx.JSON(http.StatusOK, teamReplayJSON(replay))
	})

	// 녹화 목록. ids 를 주면 그 녹화들의 상태만(지워진 것까지) 준다 — 기록 화면이 보이는 줄의 녹화가 서버에
	// 있는지, 없으면 왜 없는지를 묻는다.
	data.GET("/replays", func(ctx *gin.Context) {
		query := storepkg.TeamReplayQuery{}
		if raw := strings.TrimSpace(ctx.Query("ids")); raw != "" {
			for _, id := range strings.Split(raw, ",") {
				id = strings.TrimSpace(id)
				if !validTeamID(id) {
					ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
					return
				}
				query.RecordingIDs = append(query.RecordingIDs, id)
			}
			if len(query.RecordingIDs) > teamReplayIDsMax {
				ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
				return
			}
		} else {
			before := strings.TrimSpace(ctx.Query("before"))
			limit, ok := parseTeamHistoryLimit(ctx.Query("limit"), teamReplayListDefault, teamReplayListMax)
			if !ok || (before != "" && !validTeamID(before)) {
				ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
				return
			}
			query.Before = before
			query.Limit = limit
		}
		replays, err := dataStore.ListTeamReplays(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"), query)
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		items := make([]gin.H, 0, len(replays))
		for _, replay := range replays {
			items = append(items, teamReplayJSON(replay))
		}
		ctx.JSON(http.StatusOK, gin.H{"replays": items})
	})

	replay := data.Group("/replays/:recordingId")
	replay.Use(func(ctx *gin.Context) {
		if !validTeamID(ctx.Param("recordingId")) {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
			ctx.Abort()
			return
		}
		ctx.Next()
	})

	// 재생 창이 녹화를 열 때 받는 것 — 메타와 구간·덧붙임의 목록(내용 없이).
	replay.GET("", func(ctx *gin.Context) {
		detail, err := dataStore.GetTeamReplay(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"), ctx.Param("recordingId"))
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		body := teamReplayJSON(detail.TeamReplay)
		body["startMeta"] = detail.StartMeta
		if detail.EndMeta != "" {
			body["endMeta"] = detail.EndMeta
		}
		segments := make([]gin.H, 0, len(detail.Segments))
		for _, segment := range detail.Segments {
			segments = append(segments, gin.H{"index": segment.Index, "info": segment.Info, "size": segment.Size})
		}
		extras := make([]gin.H, 0, len(detail.Extras))
		for _, extra := range detail.Extras {
			extras = append(extras, gin.H{"kind": extra.Kind, "index": extra.Index, "size": extra.Size})
		}
		body["segments"] = segments
		body["extras"] = extras
		ctx.JSON(http.StatusOK, body)
	})

	// 구간 올리기 — 본문은 잠근 구간 바이트, 구간 정보는 헤더에. 같은 번호를 다시 올리면 덮어쓴다(이어 보내기).
	replay.PUT("/segments/:index", func(ctx *gin.Context) {
		index, ok := parseTeamReplayIndex(ctx.Param("index"))
		info := strings.TrimSpace(ctx.GetHeader(teamReplaySegmentInfoHeader))
		if !ok || !validOpaque(info, teamReplaySegmentInfoMaxBytes) {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
			return
		}
		body, ok := readTeamReplayBody(ctx, teamReplaySegmentMaxBytes)
		if !ok {
			return
		}
		if err := dataStore.PutTeamReplaySegment(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"), ctx.Param("recordingId"), index, info, body); err != nil {
			respondTeamError(ctx, err)
			return
		}
		ctx.Status(http.StatusNoContent)
	})

	replay.GET("/segments", func(ctx *gin.Context) {
		from, okFrom := parseTeamHistoryNumber(ctx.Query("from"))
		limit, okLimit := parseTeamHistoryLimit(ctx.Query("limit"), teamReplayReadMaxItems, teamReplayReadMaxItems)
		if !okFrom || !okLimit {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
			return
		}
		blobs, err := dataStore.ReadTeamReplaySegments(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"), ctx.Param("recordingId"), from, limit, teamReplayReadMaxBytes)
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		writeTeamReplayFrames(ctx, blobs)
	})

	// 덧붙임 올리기 — 구간별 명령 목록이나 스냅샷. 번호는 그 구간 번호다. 끝난 녹화에도 받는다(훑기가
	// 구간을 뒤따라오므로).
	replay.PUT("/extras/:kind/:index", func(ctx *gin.Context) {
		kind := ctx.Param("kind")
		index, ok := parseTeamReplayIndex(ctx.Param("index"))
		if !ok || !teamReplayExtraKinds[kind] {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
			return
		}
		body, ok := readTeamReplayBody(ctx, teamReplayExtraMaxBytes)
		if !ok {
			return
		}
		if err := dataStore.PutTeamReplayExtra(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"), ctx.Param("recordingId"), kind, index, body); err != nil {
			respondTeamError(ctx, err)
			return
		}
		ctx.Status(http.StatusNoContent)
	})

	replay.GET("/extras/:kind", func(ctx *gin.Context) {
		kind := ctx.Param("kind")
		from, okFrom := parseTeamHistoryNumber(ctx.Query("from"))
		limit, okLimit := parseTeamHistoryLimit(ctx.Query("limit"), teamReplayReadMaxItems, teamReplayReadMaxItems)
		if !teamReplayExtraKinds[kind] || !okFrom || !okLimit {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
			return
		}
		blobs, err := dataStore.ReadTeamReplayExtras(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"), ctx.Param("recordingId"), kind, from, limit, teamReplayReadMaxBytes)
		if err != nil {
			respondTeamError(ctx, err)
			return
		}
		writeTeamReplayFrames(ctx, blobs)
	})

	// 녹화 끝. lastSegment 까지 빠짐없이 와 있어야 받는다. cut 은 앱이 비정상 종료를 알리는 것이다.
	replay.POST("/complete", func(ctx *gin.Context) {
		ctx.Request.Body = http.MaxBytesReader(ctx.Writer, ctx.Request.Body, teamReplayJSONBodyMaxBytes)
		var request struct {
			EndMeta     string `json:"endMeta"`
			LastSegment *int64 `json:"lastSegment"`
			Cut         bool   `json:"cut"`
		}
		if err := ctx.ShouldBindJSON(&request); err != nil {
			respondTeamBodyError(ctx, err)
			return
		}
		if !validOpaque(request.EndMeta, teamReplayMetaMaxBytes) || request.LastSegment == nil ||
			*request.LastSegment < -1 || *request.LastSegment >= teamReplaySegmentIndexMax {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
			return
		}
		if err := dataStore.CompleteTeamReplay(ctx.Request.Context(), ctx.Param("teamId"), ctx.GetString("userId"), ctx.Param("recordingId"), storepkg.TeamReplayCompleteInput{
			EndMeta:     request.EndMeta,
			LastSegment: *request.LastSegment,
			Cut:         request.Cut,
		}); err != nil {
			respondTeamError(ctx, err)
			return
		}
		ctx.Status(http.StatusNoContent)
	})
}

func teamEventJSON(event storepkg.TeamEvent) gin.H {
	return gin.H{
		"seq":          event.Seq,
		"id":           event.EventID,
		"source":       event.Source,
		"authorUserId": event.AuthorUserID,
		"authorEmail":  event.AuthorEmail,
		"createdAt":    event.CreatedAt.UTC().Format(time.RFC3339Nano),
		"receivedAt":   event.ReceivedAt.UTC().Format(time.RFC3339Nano),
		"payload":      event.Payload,
	}
}

func teamReplayJSON(replay storepkg.TeamReplay) gin.H {
	body := gin.H{
		"recordingId":    replay.RecordingID,
		"authorUserId":   replay.AuthorUserID,
		"authorEmail":    replay.AuthorEmail,
		"state":          replay.State,
		"segmentCount":   replay.SegmentCount,
		"lastSegment":    replay.LastSegment,
		"totalBytes":     replay.TotalBytes,
		"createdAt":      replay.CreatedAt.UTC().Format(time.RFC3339Nano),
		"lastActivityAt": replay.LastActivityAt.UTC().Format(time.RFC3339Nano),
	}
	if replay.EndedAt != nil {
		body["endedAt"] = replay.EndedAt.UTC().Format(time.RFC3339Nano)
	}
	return body
}

// writeTeamReplayFrames 는 구간·덧붙임을 바이트 그대로 묶어 보낸다. 하나마다 [번호 8바이트][길이 4바이트]
// [내용]이고 둘 다 빅엔디언이다. JSON·base64 로 싸면 33% 커진다.
func writeTeamReplayFrames(ctx *gin.Context, blobs []storepkg.TeamReplayBlob) {
	size := 0
	for _, blob := range blobs {
		size += 12 + len(blob.Data)
	}
	body := make([]byte, 0, size)
	for _, blob := range blobs {
		body = binary.BigEndian.AppendUint64(body, uint64(blob.Index))
		body = binary.BigEndian.AppendUint32(body, uint32(len(blob.Data)))
		body = append(body, blob.Data...)
	}
	ctx.Data(http.StatusOK, "application/octet-stream", body)
}

// readTeamReplayBody 는 구간·덧붙임 본문을 읽는다. 상한을 넘으면 413 을 주고 false 다.
func readTeamReplayBody(ctx *gin.Context, maxBytes int64) ([]byte, bool) {
	data, err := io.ReadAll(http.MaxBytesReader(ctx.Writer, ctx.Request.Body, maxBytes))
	if err != nil {
		respondTeamBodyError(ctx, err)
		return nil, false
	}
	if len(data) == 0 {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "잘못된 요청입니다."})
		return nil, false
	}
	return data, true
}

// respondTeamBodyError 는 본문을 읽지 못한 경우다. 너무 크면 413 이다 — 앱은 그 녹화를 더 보내지 않는다.
func respondTeamBodyError(ctx *gin.Context, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		ctx.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "요청이 너무 큽니다.", "code": "team_request_too_large"})
		return
	}
	logAndJSONError(ctx, http.StatusBadRequest, "잘못된 요청입니다.", err)
}

// parseTeamHistoryNumber 는 생략할 수 있는 0 이상의 수다. 비었으면 0 이다.
func parseTeamHistoryNumber(value string) (int64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, true
	}
	parsed, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil || parsed < 0 {
		return 0, false
	}
	return parsed, true
}

func parseTeamHistoryLimit(value string, fallback int, maxLimit int) (int, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fallback, true
	}
	parsed, err := strconv.Atoi(trimmed)
	if err != nil || parsed < 1 {
		return 0, false
	}
	return min(parsed, maxLimit), true
}

func parseTeamReplayIndex(value string) (int64, bool) {
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 || parsed >= teamReplaySegmentIndexMax {
		return 0, false
	}
	return parsed, true
}
