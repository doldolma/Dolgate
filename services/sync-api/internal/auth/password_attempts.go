package auth

import (
	"strings"
	"sync"
	"time"
)

// 비밀번호가 틀린 횟수를 계정마다 센다.
//
// 예전에는 IP 단위로 모든 시도(성공 포함)를 셌다. 앞단 프록시 뒤에서는 모든 사용자가 한 IP 라 남의 시도가 내 로그인·
// 토큰 갱신·패스키를 막았고, 앞단을 넓게 믿으면 IP 를 위조할 수 있었다. 진짜로 막아야 할 것은 한 계정에 비밀번호를
// 끝없이 넣어 보는 것 하나라, 그것만 IP 없이 센다.
//
// 셈은 메모리에만 둔다 — 서버를 다시 켜면 처음부터 세고, 여럿 띄우면 서버마다 따로 센다.
const (
	passwordAttemptLimit      = 10
	passwordAttemptWindow     = 15 * time.Minute
	passwordAttemptSweepEvery = time.Minute
)

type passwordAttemptEntry struct {
	failures int
	resetAt  time.Time
}

type passwordAttempts struct {
	mu        sync.Mutex
	now       func() time.Time
	entries   map[string]passwordAttemptEntry
	lastSweep time.Time
}

func newPasswordAttempts() *passwordAttempts {
	return &passwordAttempts{
		now:     time.Now,
		entries: make(map[string]passwordAttemptEntry),
	}
}

// emailAttemptKey 는 로그인의 칸이다. 대소문자·앞뒤 공백이 달라도 같은 계정이다.
func emailAttemptKey(email string) string {
	return "email:" + strings.ToLower(strings.TrimSpace(email))
}

// userAttemptKey 는 비밀번호 바꾸기(현재 비밀번호 확인)의 칸이다.
func userAttemptKey(userID string) string {
	return "user:" + strings.TrimSpace(userID)
}

// locked 는 이 계정의 비밀번호 확인을 지금 막아야 하는가다. 막힌 동안에는 확인하지도 세지도 않으므로, 창이 끝나면
// 풀린다.
func (a *passwordAttempts) locked(key string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	entry, ok := a.entries[key]
	if !ok {
		return false
	}
	if !a.now().Before(entry.resetAt) {
		delete(a.entries, key)
		return false
	}
	return entry.failures >= passwordAttemptLimit
}

// fail 은 비밀번호가 틀린 것을 하나 센다. 첫 실패에서 창이 열리고, 창이 끝나면 처음부터 센다.
func (a *passwordAttempts) fail(key string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	a.sweepLocked(now)
	entry, ok := a.entries[key]
	if !ok || !now.Before(entry.resetAt) {
		entry = passwordAttemptEntry{resetAt: now.Add(passwordAttemptWindow)}
	}
	entry.failures++
	a.entries[key] = entry
}

// succeed 는 맞은 비밀번호다. 그동안 센 것을 지운다.
func (a *passwordAttempts) succeed(key string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.entries, key)
}

// sweepLocked 는 창이 끝난 칸을 1분에 한 번만 지운다. 없는 이메일을 바꿔 가며 찔러도 메모리가 쌓이지 않게 하고,
// 실패마다 전부를 훑지는 않는다.
func (a *passwordAttempts) sweepLocked(now time.Time) {
	if now.Sub(a.lastSweep) < passwordAttemptSweepEvery {
		return
	}
	a.lastSweep = now
	for key, entry := range a.entries {
		if !now.Before(entry.resetAt) {
			delete(a.entries, key)
		}
	}
}
