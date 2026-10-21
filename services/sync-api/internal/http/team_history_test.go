package http_test

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	httpserver "dolssh/services/sync-api/internal/http"
	"dolssh/services/sync-api/internal/store"
)

type replayFrame struct {
	Index int64
	Data  []byte
}

// decodeReplayFrames 는 구간·덧붙임 묶음 응답([번호 8바이트][길이 4바이트][내용]…)을 푼다.
func decodeReplayFrames(t *testing.T, body []byte) []replayFrame {
	t.Helper()
	var frames []replayFrame
	for len(body) > 0 {
		if len(body) < 12 {
			t.Fatalf("short frame header: %d bytes", len(body))
		}
		index := int64(binary.BigEndian.Uint64(body[:8]))
		length := int(binary.BigEndian.Uint32(body[8:12]))
		body = body[12:]
		if len(body) < length {
			t.Fatalf("frame %d wants %d bytes, %d left", index, length, len(body))
		}
		frames = append(frames, replayFrame{Index: index, Data: append([]byte(nil), body[:length]...)})
		body = body[length:]
	}
	return frames
}

func putReplaySegment(router *gin.Engine, account *watchTestAccount, teamID string, recordingID string, index int, info string, data []byte) *httptest.ResponseRecorder {
	headers := map[string]string{"Content-Type": "application/octet-stream"}
	if info != "" {
		headers["X-Dolgate-Segment-Info"] = info
	}
	return teamCall(router, account, http.MethodPut,
		fmt.Sprintf("/teams/%s/replays/%s/segments/%d", teamID, recordingID, index), string(data), headers)
}

func eventsBody(events ...string) string {
	return `{"events":[` + strings.Join(events, ",") + `]}`
}

func appEventJSON(id string, payload string) string {
	return fmt.Sprintf(`{"id":%q,"createdAt":%q,"payload":%q}`, id, time.Now().UTC().Format(time.RFC3339Nano), payload)
}

type teamEventItem struct {
	Seq         int64  `json:"seq"`
	ID          string `json:"id"`
	Source      string `json:"source"`
	AuthorEmail string `json:"authorEmail"`
	CreatedAt   string `json:"createdAt"`
	ReceivedAt  string `json:"receivedAt"`
	Payload     string `json:"payload"`
}

func listEventsOverHTTP(t *testing.T, router *gin.Engine, account *watchTestAccount, teamID string, query string) []teamEventItem {
	t.Helper()
	recorder := teamCall(router, account, http.MethodGet, "/teams/"+teamID+"/events"+query, "", nil)
	expectStatus(t, recorder, http.StatusOK, "list events")
	var body struct {
		Events []teamEventItem `json:"events"`
	}
	decodeJSON(t, recorder, &body)
	return body.Events
}

func TestServerInfoCarriesTeamHistoryLimits(t *testing.T) {
	env := newWatchTestEnv(t)
	env.store.SetTeamHistoryLimits(store.TeamHistoryLimits{ReplayMaxCount: 7, ReplayMaxBytes: 7 << 20, ReplayMaxBytesPerRecording: 1 << 20, EventMaxCount: 70})
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/info", nil))
	expectStatus(t, recorder, http.StatusOK, "api info")
	var body struct {
		Capabilities struct {
			Teams struct {
				Enabled bool `json:"enabled"`
				History *struct {
					ReplayMaxCount             int64 `json:"replayMaxCount"`
					ReplayMaxBytes             int64 `json:"replayMaxBytes"`
					ReplayMaxBytesPerRecording int64 `json:"replayMaxBytesPerRecording"`
					SegmentMaxBytes            int64 `json:"segmentMaxBytes"`
				} `json:"history"`
			} `json:"teams"`
		} `json:"capabilities"`
	}
	decodeJSON(t, recorder, &body)
	history := body.Capabilities.Teams.History
	if !body.Capabilities.Teams.Enabled || history == nil || history.ReplayMaxCount != 7 || history.ReplayMaxBytes != 7<<20 ||
		history.ReplayMaxBytesPerRecording != 1<<20 || history.SegmentMaxBytes != 1<<20 {
		t.Fatalf("team history capabilities = %s", recorder.Body.String())
	}
}

func TestTeamEventsOverHTTP(t *testing.T) {
	env := newWatchTestEnv(t)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	owner := newWatchTestAccount(t, router, "http-events-owner@example.com")
	member := newWatchTestAccount(t, router, "http-events-member@example.com")
	outsider := newWatchTestAccount(t, router, "http-events-outsider@example.com")
	teamID := createTeamOverHTTP(t, router, owner, "Acme")
	addMemberOverHTTP(t, router, teamID, owner, member)
	path := "/teams/" + teamID + "/events"

	first, second := uuid.NewString(), uuid.NewString()
	// 본문에 쓴 사람을 적어도 서버는 로그인한 계정으로 붙인다.
	forged := fmt.Sprintf(`{"id":%q,"createdAt":%q,"payload":"sealed","authorUserId":"someone-else","authorEmail":"boss@example.com","source":"server"}`,
		second, time.Now().UTC().Format(time.RFC3339Nano))
	recorder := teamCall(router, member, http.MethodPost, path, eventsBody(appEventJSON(first, "sealed"), forged), nil)
	expectStatus(t, recorder, http.StatusOK, "append events")
	var appended struct {
		Accepted int `json:"accepted"`
	}
	decodeJSON(t, recorder, &appended)
	if appended.Accepted != 2 {
		t.Fatalf("accepted = %d, want 2", appended.Accepted)
	}
	expectStatus(t, teamCall(router, member, http.MethodPost, path, eventsBody(appEventJSON(first, "sealed")), nil), http.StatusOK, "re-append")

	events := listEventsOverHTTP(t, router, owner, teamID, "")
	if len(events) != 3 || events[0].ID != second || events[1].ID != first || events[2].Source != "server" {
		t.Fatalf("events = %#v", events)
	}
	for _, event := range events[:2] {
		if event.Source != "app" || event.AuthorEmail != "http-events-member@example.com" || event.ReceivedAt == "" {
			t.Fatalf("app event = %#v", event)
		}
	}
	var joined struct {
		Type    string `json:"type"`
		Email   string `json:"email"`
		ByEmail string `json:"byEmail"`
	}
	if err := json.Unmarshal([]byte(events[2].Payload), &joined); err != nil || joined.Type != "member_joined" ||
		joined.Email != "http-events-member@example.com" || joined.ByEmail != "http-events-owner@example.com" {
		t.Fatalf("server event payload = %q (%v)", events[2].Payload, err)
	}
	newer := listEventsOverHTTP(t, router, owner, teamID, fmt.Sprintf("?after=%d", events[2].Seq))
	if len(newer) != 2 || newer[0].ID != first || newer[1].ID != second {
		t.Fatalf("events after the join = %#v", newer)
	}
	older := listEventsOverHTTP(t, router, owner, teamID, fmt.Sprintf("?before=%d&limit=1", events[0].Seq))
	if len(older) != 1 || older[0].ID != first {
		t.Fatalf("one event before the newest = %#v", older)
	}

	// 덧붙이기만 된다 — 고치거나 지우는 길이 없다.
	for _, method := range []string{http.MethodDelete, http.MethodPut, http.MethodPatch} {
		if recorder := teamCall(router, owner, method, path, "", nil); recorder.Code < 400 {
			t.Fatalf("%s %s = %d, want no such route", method, path, recorder.Code)
		}
	}
	if recorder := teamCall(router, owner, http.MethodDelete, path+"/"+first, "", nil); recorder.Code < 400 {
		t.Fatalf("DELETE one event = %d, want no such route", recorder.Code)
	}

	bad := map[string]string{
		"not a uuid":      eventsBody(appEventJSON("e1", "sealed")),
		"bad time":        eventsBody(fmt.Sprintf(`{"id":%q,"createdAt":"yesterday","payload":"p"}`, uuid.NewString())),
		"empty payload":   eventsBody(appEventJSON(uuid.NewString(), "")),
		"payload too big": eventsBody(appEventJSON(uuid.NewString(), strings.Repeat("p", 16*1024+1))),
		"no events":       eventsBody(),
	}
	tooMany := make([]string, 0, 101)
	for index := 0; index < 101; index++ {
		tooMany = append(tooMany, appEventJSON(uuid.NewString(), "p"))
	}
	bad["too many"] = eventsBody(tooMany...)
	for name, body := range bad {
		expectStatus(t, teamCall(router, member, http.MethodPost, path, body, nil), http.StatusBadRequest, name)
	}
	expectTeamCode(t, teamCall(router, member, http.MethodPost, path, `{"events":[`+strings.Repeat(" ", 2<<20)+`]}`, nil),
		http.StatusRequestEntityTooLarge, "team_request_too_large", "body too big")
	expectTeamCode(t, teamCall(router, outsider, http.MethodGet, path, "", nil), http.StatusNotFound, "team_not_found", "outsider read")
	expectTeamCode(t, teamCall(router, outsider, http.MethodPost, path, eventsBody(appEventJSON(uuid.NewString(), "p")), nil),
		http.StatusNotFound, "team_not_found", "outsider append")
}

func TestTeamReplaysOverHTTP(t *testing.T) {
	env := newWatchTestEnv(t)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	owner := newWatchTestAccount(t, router, "http-replay-owner@example.com")
	member := newWatchTestAccount(t, router, "http-replay-member@example.com")
	teamID := createTeamOverHTTP(t, router, owner, "Acme")
	addMemberOverHTTP(t, router, teamID, owner, member)
	recordingID := uuid.NewString()
	base := "/teams/" + teamID + "/replays"

	recorder := teamCall(router, member, http.MethodPost, base, fmt.Sprintf(`{"recordingId":%q,"startMeta":"sealed-start"}`, recordingID), nil)
	expectStatus(t, recorder, http.StatusOK, "start")
	var started struct {
		State       string `json:"state"`
		LastSegment int64  `json:"lastSegment"`
	}
	decodeJSON(t, recorder, &started)
	if started.State != "live" || started.LastSegment != -1 {
		t.Fatalf("started = %s", recorder.Body.String())
	}
	expectStatus(t, teamCall(router, member, http.MethodPost, base, `{"recordingId":"not-a-uuid","startMeta":"s"}`, nil), http.StatusBadRequest, "bad recording id")

	segments := [][]byte{[]byte("\x1f\x8bfirst-member"), bytes.Repeat([]byte{0xFF, 0x00}, 300*1024)}
	for index, data := range segments {
		expectStatus(t, putReplaySegment(router, member, teamID, recordingID, index, fmt.Sprintf("sealed-info-%d", index), data), http.StatusNoContent, "put segment")
	}
	expectStatus(t, putReplaySegment(router, member, teamID, recordingID, 2, "", []byte("x")), http.StatusBadRequest, "no segment info")
	expectStatus(t, teamCall(router, member, http.MethodPut, base+"/"+recordingID+"/segments/-1", "x", map[string]string{"X-Dolgate-Segment-Info": "i"}), http.StatusBadRequest, "negative index")
	expectTeamCode(t, putReplaySegment(router, member, teamID, recordingID, 2, "i", bytes.Repeat([]byte{'x'}, 1<<20+1)),
		http.StatusRequestEntityTooLarge, "team_request_too_large", "segment over 1MB")
	expectTeamCode(t, putReplaySegment(router, owner, teamID, recordingID, 2, "i", []byte("x")),
		http.StatusForbidden, "team_replay_author_only", "someone else's segment")

	// 진행 중에도 다른 멤버가 연다 — 메타와 구간 목록, 그다음 구간을 묶어 받는다.
	recorder = teamCall(router, owner, http.MethodGet, base+"/"+recordingID, "", nil)
	expectStatus(t, recorder, http.StatusOK, "detail")
	var detail struct {
		State       string `json:"state"`
		AuthorEmail string `json:"authorEmail"`
		StartMeta   string `json:"startMeta"`
		Segments    []struct {
			Index int64  `json:"index"`
			Info  string `json:"info"`
			Size  int64  `json:"size"`
		} `json:"segments"`
	}
	decodeJSON(t, recorder, &detail)
	if detail.State != "live" || detail.AuthorEmail != "http-replay-member@example.com" || detail.StartMeta != "sealed-start" ||
		len(detail.Segments) != 2 || detail.Segments[1].Info != "sealed-info-1" || detail.Segments[1].Size != int64(len(segments[1])+len("sealed-info-1")) {
		t.Fatalf("detail = %s", recorder.Body.String())
	}
	recorder = teamCall(router, owner, http.MethodGet, base+"/"+recordingID+"/segments?from=0", "", nil)
	expectStatus(t, recorder, http.StatusOK, "read segments")
	if contentType := recorder.Header().Get("Content-Type"); contentType != "application/octet-stream" {
		t.Fatalf("segments content type = %q", contentType)
	}
	frames := decodeReplayFrames(t, recorder.Body.Bytes())
	if len(frames) != 2 || frames[0].Index != 0 || !bytes.Equal(frames[0].Data, segments[0]) || !bytes.Equal(frames[1].Data, segments[1]) {
		t.Fatalf("frames = %d", len(frames))
	}
	frames = decodeReplayFrames(t, teamCall(router, owner, http.MethodGet, base+"/"+recordingID+"/segments?from=1&limit=1", "", nil).Body.Bytes())
	if len(frames) != 1 || frames[0].Index != 1 {
		t.Fatalf("from=1 frames = %#v", frames)
	}

	extraPath := base + "/" + recordingID + "/extras/commands/0"
	expectStatus(t, teamCall(router, member, http.MethodPut, extraPath, "sealed-commands", nil), http.StatusNoContent, "put commands")
	expectStatus(t, teamCall(router, member, http.MethodPut, base+"/"+recordingID+"/extras/bogus/0", "x", nil), http.StatusBadRequest, "unknown extra kind")
	frames = decodeReplayFrames(t, teamCall(router, owner, http.MethodGet, base+"/"+recordingID+"/extras/commands", "", nil).Body.Bytes())
	if len(frames) != 1 || string(frames[0].Data) != "sealed-commands" {
		t.Fatalf("commands frames = %#v", frames)
	}

	completePath := base + "/" + recordingID + "/complete"
	expectTeamCode(t, teamCall(router, member, http.MethodPost, completePath, `{"endMeta":"sealed-end","lastSegment":2}`, nil),
		http.StatusConflict, "team_replay_incomplete", "complete with a missing segment")
	expectStatus(t, teamCall(router, member, http.MethodPost, completePath, `{"endMeta":"sealed-end"}`, nil), http.StatusBadRequest, "complete without lastSegment")
	expectStatus(t, teamCall(router, member, http.MethodPost, completePath, `{"endMeta":"sealed-end","lastSegment":1}`, nil), http.StatusNoContent, "complete")
	expectTeamCode(t, putReplaySegment(router, member, teamID, recordingID, 2, "i", []byte("late")),
		http.StatusConflict, "team_replay_closed", "segment after the end")

	recorder = teamCall(router, owner, http.MethodGet, fmt.Sprintf("%s?ids=%s,%s", base, recordingID, uuid.NewString()), "", nil)
	expectStatus(t, recorder, http.StatusOK, "replays by ids")
	var listed struct {
		Replays []struct {
			RecordingID string `json:"recordingId"`
			State       string `json:"state"`
			EndedAt     string `json:"endedAt"`
		} `json:"replays"`
	}
	decodeJSON(t, recorder, &listed)
	if len(listed.Replays) != 1 || listed.Replays[0].RecordingID != recordingID || listed.Replays[0].State != "ended" || listed.Replays[0].EndedAt == "" {
		t.Fatalf("replays by ids = %s", recorder.Body.String())
	}
	expectStatus(t, teamCall(router, owner, http.MethodGet, base+"?ids=nope", "", nil), http.StatusBadRequest, "bad ids")
	expectStatus(t, teamCall(router, owner, http.MethodGet, base+"/not-a-uuid", "", nil), http.StatusBadRequest, "bad recording path")
	expectTeamCode(t, teamCall(router, owner, http.MethodGet, base+"/"+uuid.NewString(), "", nil), http.StatusNotFound, "team_replay_not_found", "unknown recording")
}

func TestTeamReplayLimitsOverHTTP(t *testing.T) {
	env := newWatchTestEnv(t)
	env.store.SetTeamHistoryLimits(store.TeamHistoryLimits{ReplayMaxCount: 1, ReplayMaxBytes: 1000, ReplayMaxBytesPerRecording: 100})
	router := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour)})
	owner := newWatchTestAccount(t, router, "http-limit-owner@example.com")
	teamID := createTeamOverHTTP(t, router, owner, "Acme")
	base := "/teams/" + teamID + "/replays"

	first := uuid.NewString()
	expectStatus(t, teamCall(router, owner, http.MethodPost, base, fmt.Sprintf(`{"recordingId":%q,"startMeta":"s"}`, first), nil), http.StatusOK, "start first")
	expectStatus(t, putReplaySegment(router, owner, teamID, first, 0, "i", bytes.Repeat([]byte{'x'}, 60)), http.StatusNoContent, "first segment")
	// 한 개 최대(100)를 넘기는 구간 — 그 녹화는 앞부분만 남는다.
	expectTeamCode(t, putReplaySegment(router, owner, teamID, first, 1, "i", bytes.Repeat([]byte{'x'}, 60)),
		http.StatusRequestEntityTooLarge, "team_replay_too_large", "over the per-recording max")

	// 녹화 한도(1)가 진행 중인 녹화 없이 차 있으면 지우고, 진행 중이면 기다리게 한다.
	second := uuid.NewString()
	recorder := teamCall(router, owner, http.MethodPost, base, fmt.Sprintf(`{"recordingId":%q,"startMeta":"s"}`, second), nil)
	expectStatus(t, recorder, http.StatusOK, "start second rotates the truncated first")
	expectTeamCode(t, teamCall(router, owner, http.MethodGet, base+"/"+first, "", nil), http.StatusGone, "team_replay_deleted", "rotated recording")
	recorder = teamCall(router, owner, http.MethodPost, base, fmt.Sprintf(`{"recordingId":%q,"startMeta":"s"}`, uuid.NewString()), nil)
	expectTeamCode(t, recorder, http.StatusConflict, "team_replay_quota_busy", "start while the only slot is live")
	if recorder.Header().Get("Retry-After") == "" {
		t.Fatalf("quota busy without Retry-After")
	}
}
