package http

import (
	"context"
	"log"
	"math/rand/v2"
	"sync"
	"time"

	"dolssh/services/sync-api/internal/store"
)

const (
	// defaultSyncWatchHold 는 GET /sync/watch 가 변경을 기다리는 시간이다. 실제로는 ±20%
	// 흔들어(20~30초) 기기들이 같은 박자로 다시 붙지 않게 한다.
	//
	// 프록시(ALB·nginx)의 기본 유휴 타임아웃과 iOS 의 요청 기본 타임아웃이 60초라 그 절반 밑으로
	// 잡는다. 대기가 길수록 요청 수는 줄지만, 변경은 대기 길이와 상관없이 그 순간 전달되므로
	// 속도에는 차이가 없다 — 조용히 끊긴 연결을 빨리 알아채는 쪽을 택했다.
	defaultSyncWatchHold = 25 * time.Second
	// defaultSyncWatchCheckInterval 은 묶음 확인 주기다. 다른 서버로 들어온 변경은 이만큼 늦을
	// 수 있다.
	defaultSyncWatchCheckInterval = 3 * time.Second
)

// syncRevisionReader 는 묶음 확인이 쓰는 저장소 기능이다.
type syncRevisionReader interface {
	GetSyncRevisions(ctx context.Context, userIDs []string) (map[string]int64, error)
	GetTeamWatchRevisions(ctx context.Context, teamIDs []string) (map[store.TeamWatchKey]int64, error)
}

// syncWatchKey 는 대기자 묶음 하나다. 개인 볼트는 teamID 가 비어 있고, 팀 볼트는 (팀, 기다리는 멤버)다 —
// 팀을 멤버마다 따로 묶어야 개인 칸이 바뀌었을 때 그 멤버의 기기만 깨울 수 있다.
type syncWatchKey struct {
	teamID string
	userID string
}

// SyncWatchHub 는 동기화 롱폴링(GET /sync/watch, GET /teams/:id/sync/watch)의 대기자를 볼트별로 묶어
// 깨운다. 개인 볼트는 사용자별, 팀 볼트는 (팀, 멤버)별이다.
//
// 깨우는 길은 둘이다.
//   - notify: 이 서버로 들어온 push 등이 커밋된 뒤 핸들러가 바로 부른다(즉시).
//   - 묶음 확인: 대기자가 있는 동안만 고루틴 하나가 주기마다 대기 중인 사용자들의 리비전을
//     한 번에 읽어, 기다리기 시작한 리비전에서 바뀐 사용자를 깨운다. 서버가 여러 대일 때
//     다른 서버로 들어온 변경을 잡고, notify 를 빠뜨린 경로(로그인 때의 v1 볼트 지연 생성 등)의
//     안전망이 된다. 대기자가 없으면 고루틴도, DB 조회도 없다.
//
// 깨우는 것은 "다시 확인해 보라" 는 신호일 뿐이다. 깨어난 대기자는 리비전을 직접 다시 읽어
// 자기 것과 견준다 — 그래서 다른 기기 몫의 신호에 깨어도 틀린 응답을 주지 않는다.
type SyncWatchHub struct {
	revisions     syncRevisionReader
	checkInterval time.Duration

	mu       sync.Mutex
	entries  map[syncWatchKey]*syncWatchEntry
	checking bool
	closed   bool
	closedCh chan struct{}
}

type syncWatchEntry struct {
	// changed 는 깨울 때 닫힌다. 닫힌 채널은 다시 쓰지 않는다 — 그 뒤에 오는 대기자는 새 항목을 받는다.
	changed chan struct{}
	waiters int
	// since 는 이 항목의 대기자들이 기다리기 시작한 리비전 중 가장 오래된 것이다. 묶음 확인은
	// 이것과 다르면 깨운다. 가장 오래된 것을 잡아야 아무도 놓치지 않는다 — 이미 최신인 대기자는
	// 깨어나 다시 확인하고 도로 기다린다.
	since int64
}

// NewSyncWatchHub 는 대기자 묶음을 만든다. checkInterval 이 0 이하면 기본값(3초)을 쓴다.
func NewSyncWatchHub(revisions syncRevisionReader, checkInterval time.Duration) *SyncWatchHub {
	if checkInterval <= 0 {
		checkInterval = defaultSyncWatchCheckInterval
	}
	return &SyncWatchHub{
		revisions:     revisions,
		checkInterval: checkInterval,
		entries:       make(map[syncWatchKey]*syncWatchEntry),
		closedCh:      make(chan struct{}),
	}
}

// subscribe 는 userID 개인 볼트의 다음 변경 신호를 기다릴 채널을 준다. 기다림을 마치면(신호를 받았든
// 아니든) 반드시 release 를 불러야 한다.
func (h *SyncWatchHub) subscribe(userID string, since int64) (<-chan struct{}, func()) {
	return h.subscribeKey(syncWatchKey{userID: userID}, since)
}

// subscribeTeam 은 팀 볼트를 기다리는 그 멤버의 다음 변경 신호를 준다. since 는 팀 감시 값
// (store.TeamGate.WatchValue)이다.
func (h *SyncWatchHub) subscribeTeam(teamID string, userID string, since int64) (<-chan struct{}, func()) {
	return h.subscribeKey(syncWatchKey{teamID: teamID, userID: userID}, since)
}

func (h *SyncWatchHub) subscribeKey(key syncWatchKey, since int64) (<-chan struct{}, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return h.closedCh, func() {}
	}
	entry := h.entries[key]
	if entry == nil {
		entry = &syncWatchEntry{changed: make(chan struct{}), since: since}
		h.entries[key] = entry
	} else if since < entry.since {
		entry.since = since
	}
	entry.waiters++
	if !h.checking {
		h.checking = true
		go h.checkLoop()
	}
	return entry.changed, func() { h.release(key, entry) }
}

func (h *SyncWatchHub) release(key syncWatchKey, entry *syncWatchEntry) {
	h.mu.Lock()
	defer h.mu.Unlock()
	entry.waiters--
	// 이미 깨워져 빠진 항목이면 같은 키의 새 항목을 지우면 안 된다.
	if entry.waiters <= 0 && h.entries[key] == entry {
		delete(h.entries, key)
	}
}

// notify 는 userID 개인 볼트의 대기자를 모두 깨운다. 리비전이 커밋된 **뒤에** 불러야 한다 — 먼저
// 부르면 깨어난 대기자가 옛 리비전을 읽고 도로 잠든다.
func (h *SyncWatchHub) notify(userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.wakeLocked(syncWatchKey{userID: userID})
}

// notifyTeam 은 그 팀을 기다리는 모든 멤버를 깨운다(팀 레코드·팀 정보가 바뀐 뒤).
func (h *SyncWatchHub) notifyTeam(teamID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for key := range h.entries {
		if key.teamID == teamID {
			h.wakeLocked(key)
		}
	}
}

// notifyTeamMember 는 그 팀을 기다리는 그 멤버의 기기만 깨운다(개인 칸이 바뀐 뒤).
func (h *SyncWatchHub) notifyTeamMember(teamID string, userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.wakeLocked(syncWatchKey{teamID: teamID, userID: userID})
}

func (h *SyncWatchHub) wakeLocked(key syncWatchKey) {
	entry := h.entries[key]
	if entry == nil {
		return
	}
	close(entry.changed)
	delete(h.entries, key)
}

// done 은 Close 되면 닫힌다.
func (h *SyncWatchHub) done() <-chan struct{} {
	return h.closedCh
}

// Close 는 모든 대기자를 풀어 준다. 서버 종료 때 부른다 — 대기는 최대 30초라 그대로 두면
// 종료 유예 안에 끝나지 않는다. 대기자는 304 로 답하고, 클라이언트는 다시 붙는다.
func (h *SyncWatchHub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	close(h.closedCh)
}

func (h *SyncWatchHub) checkLoop() {
	ticker := time.NewTicker(h.checkInterval)
	defer ticker.Stop()
	for {
		select {
		case <-h.closedCh:
			h.mu.Lock()
			h.checking = false
			h.mu.Unlock()
			return
		case <-ticker.C:
		}
		waiting := h.waitingSince()
		if waiting == nil {
			return
		}
		h.checkOnce(waiting)
	}
}

// waitingSince 는 지금 기다리는 묶음과 그 기준 값을 복사해 준다. 아무도 없으면 nil 을 주고 확인
// 고루틴을 끝낸 것으로 표시한다 — 다음 대기자가 새로 띄운다.
func (h *SyncWatchHub) waitingSince() map[syncWatchKey]int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.entries) == 0 {
		h.checking = false
		return nil
	}
	waiting := make(map[syncWatchKey]int64, len(h.entries))
	for key, entry := range h.entries {
		waiting[key] = entry.since
	}
	return waiting
}

func (h *SyncWatchHub) checkOnce(waiting map[syncWatchKey]int64) {
	userIDs := make([]string, 0, len(waiting))
	teamSet := make(map[string]struct{})
	for key := range waiting {
		if key.teamID == "" {
			userIDs = append(userIDs, key.userID)
		} else {
			teamSet[key.teamID] = struct{}{}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if len(userIDs) > 0 {
		h.checkUsers(ctx, waiting, userIDs)
	}
	if len(teamSet) > 0 {
		teamIDs := make([]string, 0, len(teamSet))
		for teamID := range teamSet {
			teamIDs = append(teamIDs, teamID)
		}
		h.checkTeams(ctx, waiting, teamIDs)
	}
}

func (h *SyncWatchHub) checkUsers(ctx context.Context, waiting map[syncWatchKey]int64, userIDs []string) {
	current, err := h.revisions.GetSyncRevisions(ctx, userIDs)
	if err != nil {
		log.Printf("sync watch: revision check failed: %v", err)
		return
	}
	for _, userID := range userIDs {
		key := syncWatchKey{userID: userID}
		// 행이 없으면 탈퇴한 사용자다 — 깨워서 401 을 받게 한다.
		if revision, ok := current[userID]; !ok || revision != waiting[key] {
			h.mu.Lock()
			h.wakeLocked(key)
			h.mu.Unlock()
		}
	}
}

func (h *SyncWatchHub) checkTeams(ctx context.Context, waiting map[syncWatchKey]int64, teamIDs []string) {
	current, err := h.revisions.GetTeamWatchRevisions(ctx, teamIDs)
	if err != nil {
		log.Printf("sync watch: team revision check failed: %v", err)
		return
	}
	for key, since := range waiting {
		if key.teamID == "" {
			continue
		}
		// 값이 없으면 멤버가 아니게 됐거나 팀이 사라진 것이다 — 깨워서 404 를 받게 한다.
		if value, ok := current[store.TeamWatchKey{TeamID: key.teamID, UserID: key.userID}]; !ok || value != since {
			h.mu.Lock()
			h.wakeLocked(key)
			h.mu.Unlock()
		}
	}
}

// jitterSyncWatchHold 는 대기 시간을 ±20% 안에서 흔든다.
func jitterSyncWatchHold(base time.Duration) time.Duration {
	spread := base / 5
	if spread <= 0 {
		return base
	}
	return base - spread + time.Duration(rand.Int64N(int64(2*spread)+1))
}
