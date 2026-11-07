package http_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"dolssh/services/sync-api/internal/auth"
	httpserver "dolssh/services/sync-api/internal/http"
	"dolssh/services/sync-api/internal/store"
)

// watchTestEnv 는 저장소와 인증 서비스를 나눠 쓰는 라우터들을 만든다. 라우터마다 SyncWatch 를
// 따로 주면 "서버 여러 대, DB 하나" 가 된다.
type watchTestEnv struct {
	store       *store.GormStore
	authService *auth.Service
}

func newWatchTestEnv(t *testing.T) *watchTestEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	sqliteStore, err := store.OpenSQLite(filepath.Join(t.TempDir(), "sync-watch.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() {
		if err := sqliteStore.Close(); err != nil {
			t.Fatalf("close sqlite: %v", err)
		}
	})
	authService, err := auth.NewService(
		sqliteStore,
		"",
		filepath.Join(t.TempDir(), "auth-signing-private.pem"),
		15*time.Minute,
		time.Hour,
		72*time.Hour,
		2*time.Minute,
		true,
	)
	if err != nil {
		t.Fatalf("new auth service: %v", err)
	}
	return &watchTestEnv{store: sqliteStore, authService: authService}
}

// hub 는 이 저장소로 묶음 확인을 하는 대기자 묶음이다. 주기를 한 시간으로 주면 알림으로만 깬다.
func (env *watchTestEnv) hub(t *testing.T, checkInterval time.Duration) *httpserver.SyncWatchHub {
	t.Helper()
	hub := httpserver.NewSyncWatchHub(env.store, checkInterval)
	t.Cleanup(hub.Close)
	return hub
}

func (env *watchTestEnv) router(t *testing.T, config httpserver.RouterConfig) *gin.Engine {
	t.Helper()
	config.LocalAuthEnabled = true
	config.LocalSignupEnabled = true
	router, err := httpserver.NewRouter(env.store, env.authService, config)
	if err != nil {
		t.Fatalf("new router: %v", err)
	}
	return router
}

// watchTestAccount 는 볼트까지 설정해 push 할 수 있는 계정이다.
type watchTestAccount struct {
	token       string
	epoch       int64
	pushes      int
	lastPayload string
}

func newWatchTestAccount(t *testing.T, router *gin.Engine, email string) *watchTestAccount {
	t.Helper()
	signup, recorder := vaultTestSession(t, router, http.MethodPost, "/auth/signup",
		`{"email":"`+email+`","password":"supersecure"}`, vaultE2EECapableVersion)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("signup failed: %d %s", recorder.Code, recorder.Body.String())
	}
	token := signup.Tokens.AccessToken
	setup := httptest.NewRecorder()
	router.ServeHTTP(setup, vaultTestRequest(http.MethodPost, "/auth/vault",
		buildVaultSetupBody(bytes.Repeat([]byte{0xA1}, 60), bytes.Repeat([]byte{0xB2}, 16)), token, vaultE2EECapableVersion))
	if setup.Code != http.StatusOK {
		t.Fatalf("vault setup failed: %d %s", setup.Code, setup.Body.String())
	}
	return &watchTestAccount{token: token, epoch: vaultEpochFromResponse(t, setup)}
}

// push 는 내용이 실제로 바뀐 push 를 보내고 새 리비전을 준다.
func (a *watchTestAccount) push(t *testing.T, router *gin.Engine) int64 {
	t.Helper()
	a.pushes++
	a.lastPayload = fmt.Sprintf(`{"hosts":[{"id":"host-1","encrypted_payload":"w%d","updated_at":"2026-10-12T00:00:%02dZ"}]}`, a.pushes, a.pushes)
	return a.send(t, router, a.lastPayload)
}

// pushSame 은 직전 push 를 그대로 다시 보낸다 — 저장소는 no-op 이라 리비전이 그대로다.
func (a *watchTestAccount) pushSame(t *testing.T, router *gin.Engine) int64 {
	t.Helper()
	return a.send(t, router, a.lastPayload)
}

func (a *watchTestAccount) send(t *testing.T, router *gin.Engine, payload string) int64 {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := vaultTestRequest(http.MethodPost, "/sync", payload, a.token, vaultE2EECapableVersion)
	setVaultEpochHeader(request, a.epoch)
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("push failed: %d %s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Revision int64 `json:"revision"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode push revision: %v", err)
	}
	return body.Revision
}

func (a *watchTestAccount) currentETag(t *testing.T, router *gin.Engine) string {
	t.Helper()
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, vaultTestRequest(http.MethodGet, "/sync", "", a.token, vaultE2EECapableVersion))
	if recorder.Code != http.StatusOK {
		t.Fatalf("get /sync failed: %d %s", recorder.Code, recorder.Body.String())
	}
	return recorder.Header().Get("ETag")
}

func (a *watchTestAccount) watch(router *gin.Engine, etag string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := vaultTestRequest(http.MethodGet, "/sync/watch", "", a.token, vaultE2EECapableVersion)
	if etag != "" {
		request.Header.Set("If-None-Match", etag)
	}
	router.ServeHTTP(recorder, request)
	return recorder
}

// watchAsync 는 대기를 고루틴에서 걸고, 허브에 실제로 걸릴 때까지 기다린 뒤 돌아온다.
func (a *watchTestAccount) watchAsync(t *testing.T, router *gin.Engine, hub *httpserver.SyncWatchHub, etag string) <-chan *httptest.ResponseRecorder {
	t.Helper()
	before := hub.WaitersForTest()
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		result <- a.watch(router, etag)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for hub.WaitersForTest() <= before {
		select {
		case recorder := <-result:
			t.Fatalf("watch answered before waiting: %d %s", recorder.Code, recorder.Body.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("watch never started waiting")
		}
		time.Sleep(2 * time.Millisecond)
	}
	return result
}

func awaitWatch(t *testing.T, result <-chan *httptest.ResponseRecorder, within time.Duration, what string) *httptest.ResponseRecorder {
	t.Helper()
	select {
	case recorder := <-result:
		return recorder
	case <-time.After(within):
		t.Fatalf("%s: watch did not answer within %v", what, within)
		return nil
	}
}

func assertWatchChanged(t *testing.T, recorder *httptest.ResponseRecorder, revision int64) {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200 from watch, got %d %s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Revision int64 `json:"revision"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode watch body: %v", err)
	}
	if body.Revision != revision {
		t.Fatalf("expected revision %d, got %d", revision, body.Revision)
	}
	if etag := recorder.Header().Get("ETag"); etag != fmt.Sprintf("\"%d\"", revision) {
		t.Fatalf("expected ETag for revision %d, got %q", revision, etag)
	}
	if cacheControl := recorder.Header().Get("Cache-Control"); cacheControl != "no-store" {
		t.Fatalf("expected Cache-Control no-store, got %q", cacheControl)
	}
}

// 클라이언트가 뒤처져 있으면 기다리지 않고 바로 답한다. 처음 붙는 기기(If-None-Match 없음)도 같다.
func TestSyncWatchAnswersAtOnceWhenTheClientIsBehind(t *testing.T) {
	env := newWatchTestEnv(t)
	router := env.router(t, httpserver.RouterConfig{SyncWatchHold: 10 * time.Second})
	account := newWatchTestAccount(t, router, "watch-behind@example.com")
	stale := account.currentETag(t, router)
	revision := account.push(t, router)

	started := time.Now()
	assertWatchChanged(t, account.watch(router, stale), revision)
	assertWatchChanged(t, account.watch(router, ""), revision)
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("expected immediate answers, took %v", elapsed)
	}
}

// 기다리는 중에 다른 기기가 push 하면 그 순간 깬다. 주기 확인은 한 시간으로 막아 둬, 깨운 것이
// 알림이라는 것을 확인한다.
func TestSyncWatchWakesTheMomentAnotherDevicePushes(t *testing.T) {
	env := newWatchTestEnv(t)
	hub := env.hub(t, time.Hour)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: hub, SyncWatchHold: 10 * time.Second})
	account := newWatchTestAccount(t, router, "watch-wake@example.com")
	etag := account.currentETag(t, router)

	result := account.watchAsync(t, router, hub, etag)
	pushedAt := time.Now()
	revision := account.push(t, router)
	recorder := awaitWatch(t, result, 2*time.Second, "after a push")
	assertWatchChanged(t, recorder, revision)
	if elapsed := time.Since(pushedAt); elapsed > time.Second {
		t.Fatalf("expected the watch to wake right after the push, took %v", elapsed)
	}
	if waiters := hub.WaitersForTest(); waiters != 0 {
		t.Fatalf("expected no waiters left, got %d", waiters)
	}
}

// 바뀐 것이 없으면 대기 시간이 지나 304 로 끝난다. 리비전이 그대로인 신호(같은 내용 재-push)에
// 깨어도 200 을 주지 않고 도로 기다린다.
func TestSyncWatchTimesOutWithNotModified(t *testing.T) {
	env := newWatchTestEnv(t)
	hub := env.hub(t, time.Hour)
	hold := 400 * time.Millisecond
	router := env.router(t, httpserver.RouterConfig{SyncWatch: hub, SyncWatchHold: hold})
	account := newWatchTestAccount(t, router, "watch-timeout@example.com")
	revision := account.push(t, router)
	etag := account.currentETag(t, router)

	started := time.Now()
	result := account.watchAsync(t, router, hub, etag)
	if same := account.pushSame(t, router); same != revision {
		t.Fatalf("expected an identical push to keep revision %d, got %d", revision, same)
	}
	recorder := awaitWatch(t, result, 5*time.Second, "with nothing changed")
	if recorder.Code != http.StatusNotModified {
		t.Fatalf("expected 304 after the hold, got %d %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("expected an empty 304, got %q", recorder.Body.String())
	}
	if recorder.Header().Get("ETag") != etag {
		t.Fatalf("expected ETag %q on 304, got %q", etag, recorder.Header().Get("ETag"))
	}
	// ±20% 지터 — 그보다 빨리 끝났다면 신호에 깨어 그대로 답한 것이다.
	if elapsed := time.Since(started); elapsed < hold*4/5 {
		t.Fatalf("expected to wait out the hold (%v), answered after %v", hold, elapsed)
	}
	if waiters := hub.WaitersForTest(); waiters != 0 {
		t.Fatalf("expected no waiters left, got %d", waiters)
	}
}

// 서버가 여러 대일 때: 다른 서버로 들어온 push 는 알림이 오지 않지만 묶음 확인이 잡는다.
func TestSyncWatchWakesWhenThePushLandsOnAnotherServer(t *testing.T) {
	env := newWatchTestEnv(t)
	// push 를 받는 서버의 알림은 대기 서버의 허브에 닿지 않는다.
	pushServer := env.router(t, httpserver.RouterConfig{SyncWatch: env.hub(t, time.Hour), SyncWatchHold: 10 * time.Second})
	waitingHub := env.hub(t, 50*time.Millisecond)
	waitServer := env.router(t, httpserver.RouterConfig{SyncWatch: waitingHub, SyncWatchHold: 10 * time.Second})
	account := newWatchTestAccount(t, pushServer, "watch-cross@example.com")
	etag := account.currentETag(t, waitServer)

	result := account.watchAsync(t, waitServer, waitingHub, etag)
	pushedAt := time.Now()
	revision := account.push(t, pushServer)
	recorder := awaitWatch(t, result, 2*time.Second, "after a push on another server")
	assertWatchChanged(t, recorder, revision)
	if elapsed := time.Since(pushedAt); elapsed > time.Second {
		t.Fatalf("expected the check (every 50ms) to wake the waiter quickly, took %v", elapsed)
	}
}

// 서버가 종료되면 대기자가 바로 풀린다(304). 그대로 두면 종료 유예 안에 끝나지 않는다.
func TestSyncWatchReleasesWaitersOnShutdown(t *testing.T) {
	env := newWatchTestEnv(t)
	hub := env.hub(t, time.Hour)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: hub, SyncWatchHold: 10 * time.Second})
	account := newWatchTestAccount(t, router, "watch-shutdown@example.com")
	etag := account.currentETag(t, router)

	result := account.watchAsync(t, router, hub, etag)
	closedAt := time.Now()
	hub.Close()
	recorder := awaitWatch(t, result, 2*time.Second, "after shutdown")
	if recorder.Code != http.StatusNotModified {
		t.Fatalf("expected 304 on shutdown, got %d %s", recorder.Code, recorder.Body.String())
	}
	if elapsed := time.Since(closedAt); elapsed > time.Second {
		t.Fatalf("expected the waiter to be released at once, took %v", elapsed)
	}
}

// 기다리는 중에 탈퇴하면 401 로 깨운다 — 그 기기는 바로 로그아웃된다.
func TestSyncWatchTellsADeletedAccountToSignIn(t *testing.T) {
	env := newWatchTestEnv(t)
	hub := env.hub(t, time.Hour)
	router := env.router(t, httpserver.RouterConfig{SyncWatch: hub, SyncWatchHold: 10 * time.Second})
	account := newWatchTestAccount(t, router, "watch-delete@example.com")
	etag := account.currentETag(t, router)

	result := account.watchAsync(t, router, hub, etag)
	deletion := httptest.NewRecorder()
	router.ServeHTTP(deletion, vaultTestRequest(http.MethodDelete, "/auth/account", "", account.token, vaultE2EECapableVersion))
	if deletion.Code != http.StatusNoContent {
		t.Fatalf("delete account failed: %d %s", deletion.Code, deletion.Body.String())
	}
	recorder := awaitWatch(t, result, 2*time.Second, "after account deletion")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 after deletion, got %d %s", recorder.Code, recorder.Body.String())
	}
}

// Compression proxies can weaken a strong ETag without changing its revision.
func TestSyncWeakETag(t *testing.T) {
	env := newWatchTestEnv(t)
	hub := env.hub(t, time.Hour)
	// watchAsync 가 대기 등록을 확인할 틈이 있어야 한다. 100ms(지터로 80~120ms)면 바쁜 CI 에서 그 틈을
	// 놓쳐 "watch answered before waiting" 으로 실패할 수 있다 — TestSyncWatchTimesOutWithNotModified 와 맞춘다.
	router := env.router(t, httpserver.RouterConfig{SyncWatch: hub, SyncWatchHold: 400 * time.Millisecond})
	account := newWatchTestAccount(t, router, "weak-etag@example.com")
	etag := account.currentETag(t, router)
	weak := "W/" + etag

	t.Run("pull avoids retransmitting unchanged data", func(t *testing.T) {
		request := vaultTestRequest(http.MethodGet, "/sync", "", account.token, vaultE2EECapableVersion)
		request.Header.Set("If-None-Match", weak)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusNotModified || recorder.Body.Len() != 0 {
			t.Fatalf("expected empty 304 for weak current ETag, got %d (%d bytes)", recorder.Code, recorder.Body.Len())
		}
		if got := recorder.Header().Get("ETag"); got != etag {
			t.Fatalf("expected canonical ETag %q, got %q", etag, got)
		}
	})

	for _, test := range []struct {
		name   string
		header string
		want   int
	}{
		{"strong", etag, http.StatusNotModified},
		{"weak with whitespace", " \tW/" + etag + " \t", http.StatusNotModified},
		{"missing", "", http.StatusOK},
		{"stale weak", `W/"0"`, http.StatusOK},
		{"unquoted", etag[1 : len(etag)-1], http.StatusOK},
		{"invalid weak prefix", "w/" + etag, http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := vaultTestRequest(http.MethodGet, "/sync", "", account.token, vaultE2EECapableVersion)
			request.Header.Set("If-None-Match", test.header)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != test.want {
				t.Fatalf("expected %d for %q, got %d", test.want, test.header, recorder.Code)
			}
		})
	}

	t.Run("watch waits instead of reporting a false change", func(t *testing.T) {
		result := account.watchAsync(t, router, hub, weak)
		recorder := awaitWatch(t, result, 5*time.Second, "with a weak current ETag")
		if recorder.Code != http.StatusNotModified || recorder.Body.Len() != 0 {
			t.Fatalf("expected empty 304 after waiting, got %d", recorder.Code)
		}
		if got := recorder.Header().Get("ETag"); got != etag {
			t.Fatalf("expected canonical ETag %q, got %q", etag, got)
		}
	})

	t.Run("weak stale ETag still reports changes", func(t *testing.T) {
		revision := account.push(t, router)
		assertWatchChanged(t, account.watch(router, weak), revision)
		request := vaultTestRequest(http.MethodGet, "/sync", "", account.token, vaultE2EECapableVersion)
		request.Header.Set("If-None-Match", weak)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK || recorder.Body.Len() == 0 {
			t.Fatalf("expected full 200 for stale weak ETag, got %d", recorder.Code)
		}
	})
}
