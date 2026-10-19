package http

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"dolssh/services/sync-api/internal/store"
)

type fakeSyncRevisionReader struct {
	mu         sync.Mutex
	revisions  map[string]int64
	teamValues map[store.TeamWatchKey]int64
	err        error
	calls      int
	teamCalls  int
}

func (f *fakeSyncRevisionReader) GetTeamWatchRevisions(_ context.Context, teamIDs []string) (map[store.TeamWatchKey]int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.teamCalls++
	if f.err != nil {
		return nil, f.err
	}
	wanted := make(map[string]bool, len(teamIDs))
	for _, teamID := range teamIDs {
		wanted[teamID] = true
	}
	result := make(map[store.TeamWatchKey]int64)
	for key, value := range f.teamValues {
		if wanted[key.TeamID] {
			result[key] = value
		}
	}
	return result, nil
}

func (f *fakeSyncRevisionReader) setTeam(teamID string, userID string, value int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.teamValues[store.TeamWatchKey{TeamID: teamID, UserID: userID}] = value
}

func (f *fakeSyncRevisionReader) dropTeam(teamID string, userID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.teamValues, store.TeamWatchKey{TeamID: teamID, UserID: userID})
}

func (f *fakeSyncRevisionReader) teamCallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.teamCalls
}

func (f *fakeSyncRevisionReader) GetSyncRevisions(_ context.Context, userIDs []string) (map[string]int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	result := make(map[string]int64, len(userIDs))
	for _, userID := range userIDs {
		if revision, ok := f.revisions[userID]; ok {
			result[userID] = revision
		}
	}
	return result, nil
}

func (f *fakeSyncRevisionReader) set(userID string, revision int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revisions[userID] = revision
}

func (f *fakeSyncRevisionReader) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func isClosed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func waitClosed(t *testing.T, ch <-chan struct{}, within time.Duration, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(within):
		t.Fatalf("%s: not woken within %v", what, within)
	}
}

// 알림은 그 사용자의 대기자만 깨운다 — 같은 사용자의 기기 여럿은 다 깨고, 다른 사용자는 그대로다.
func TestSyncWatchHubNotifyWakesOnlyThatUser(t *testing.T) {
	hub := NewSyncWatchHub(&fakeSyncRevisionReader{revisions: map[string]int64{}}, time.Hour)
	defer hub.Close()

	first, releaseFirst := hub.subscribe("alice", 3)
	second, releaseSecond := hub.subscribe("alice", 3)
	other, releaseOther := hub.subscribe("bob", 7)
	defer releaseOther()

	hub.notify("alice")
	if !isClosed(first) || !isClosed(second) {
		t.Fatal("both of alice's waiters should wake")
	}
	if isClosed(other) {
		t.Fatal("bob's waiter must not wake on alice's change")
	}
	releaseFirst()
	releaseSecond()

	// 깨운 뒤에 오는 대기자는 새 신호를 기다린다 — 닫힌 채널을 다시 받으면 바로 깨어 버린다.
	next, releaseNext := hub.subscribe("alice", 4)
	defer releaseNext()
	if isClosed(next) {
		t.Fatal("a waiter arriving after the notify must wait for the next change")
	}
}

// 마지막 대기자가 떠나면 항목이 사라진다. 이미 깨워져 빠진 옛 항목을 놓는 것이 같은 사용자의
// 새 항목을 지우면 안 된다.
func TestSyncWatchHubReleaseKeepsTheNewerEntry(t *testing.T) {
	hub := NewSyncWatchHub(&fakeSyncRevisionReader{revisions: map[string]int64{}}, time.Hour)
	defer hub.Close()

	_, releaseOld := hub.subscribe("alice", 1)
	hub.notify("alice")
	fresh, releaseFresh := hub.subscribe("alice", 2)
	releaseOld()

	hub.notify("alice")
	if !isClosed(fresh) {
		t.Fatal("releasing the old entry must not drop the newer waiter")
	}
	releaseFresh()
	if waiters := hub.WaitersForTest(); waiters != 0 {
		t.Fatalf("expected no waiters left, got %d", waiters)
	}
}

// 묶음 확인은 기다리기 시작한 리비전에서 바뀐 사용자만 깨운다. 행이 없으면(탈퇴) 깨워서
// 핸들러가 401 을 주게 한다.
func TestSyncWatchHubCheckWakesChangedAndDeletedUsers(t *testing.T) {
	reader := &fakeSyncRevisionReader{revisions: map[string]int64{"alice": 5, "bob": 9}}
	hub := NewSyncWatchHub(reader, 10*time.Millisecond)
	defer hub.Close()

	alice, releaseAlice := hub.subscribe("alice", 5)
	defer releaseAlice()
	bob, releaseBob := hub.subscribe("bob", 9)
	defer releaseBob()
	carol, releaseCarol := hub.subscribe("carol", 2)
	defer releaseCarol()

	// 다른 서버로 들어온 push 처럼, 알림 없이 DB 만 바뀐다.
	reader.set("alice", 6)
	waitClosed(t, alice, time.Second, "alice (revision changed elsewhere)")
	waitClosed(t, carol, time.Second, "carol (account deleted)")
	if isClosed(bob) {
		t.Fatal("bob's revision did not change; he must keep waiting")
	}
}

// 기준은 대기자들 중 가장 오래된 리비전이다. 최신 기준으로 덮으면 뒤처진 기기를 영영 안 깨운다.
func TestSyncWatchHubCheckUsesTheOldestRevision(t *testing.T) {
	reader := &fakeSyncRevisionReader{revisions: map[string]int64{"alice": 4}}
	// 주기 확인이 끼어들지 않게 길게 두고, 확인은 직접 한 번 돌린다.
	hub := NewSyncWatchHub(reader, time.Hour)
	defer hub.Close()

	// 최신 기기가 먼저 기다리고, 뒤처진 기기가 나중에 붙는다 — 기준이 3 으로 내려가야 한다.
	current, releaseCurrent := hub.subscribe("alice", 4)
	defer releaseCurrent()
	behind, releaseBehind := hub.subscribe("alice", 3)
	defer releaseBehind()

	hub.checkOnce(hub.waitingSince())
	if !isClosed(behind) {
		t.Fatal("the device still on revision 3 must wake")
	}
	// 최신인 기기도 같이 깨지만, 핸들러가 리비전을 다시 읽고 도로 기다린다.
	if !isClosed(current) {
		t.Fatal("waiters share one signal per user")
	}
}

// 대기자가 없으면 확인 고루틴이 끝나고, DB 도 더 읽지 않는다. 다음 대기자가 다시 띄운다.
func TestSyncWatchHubCheckRunsOnlyWhileSomeoneWaits(t *testing.T) {
	reader := &fakeSyncRevisionReader{revisions: map[string]int64{"alice": 1}}
	hub := NewSyncWatchHub(reader, 5*time.Millisecond)
	defer hub.Close()

	_, release := hub.subscribe("alice", 1)
	deadline := time.Now().Add(time.Second)
	for reader.callCount() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the check never ran while someone was waiting")
		}
		time.Sleep(time.Millisecond)
	}
	release()

	deadline = time.Now().Add(time.Second)
	for {
		hub.mu.Lock()
		checking := hub.checking
		hub.mu.Unlock()
		if !checking {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the check kept running with nobody waiting")
		}
		time.Sleep(time.Millisecond)
	}
	calls := reader.callCount()
	time.Sleep(30 * time.Millisecond)
	if after := reader.callCount(); after != calls {
		t.Fatalf("expected no reads with nobody waiting, got %d more", after-calls)
	}

	woken, releaseAgain := hub.subscribe("alice", 0)
	defer releaseAgain()
	waitClosed(t, woken, time.Second, "a new waiter (check restarted)")
}

// 확인이 실패해도 대기자를 깨우지 않는다 — 깨우면 모두가 DB 를 다시 읽으러 몰린다. 다음
// 주기에 다시 본다.
func TestSyncWatchHubCheckErrorKeepsWaiting(t *testing.T) {
	reader := &fakeSyncRevisionReader{revisions: map[string]int64{}, err: errors.New("db down")}
	hub := NewSyncWatchHub(reader, 5*time.Millisecond)
	defer hub.Close()

	changed, release := hub.subscribe("alice", 1)
	defer release()
	deadline := time.Now().Add(time.Second)
	for reader.callCount() < 3 {
		if time.Now().After(deadline) {
			t.Fatal("the check did not retry")
		}
		time.Sleep(time.Millisecond)
	}
	if isClosed(changed) {
		t.Fatal("a failed check must not wake waiters")
	}
}

// 종료 때 대기자를 전부 풀어 준다. 그 뒤로 오는 대기자는 기다리지 않는다.
func TestSyncWatchHubCloseReleasesEveryone(t *testing.T) {
	hub := NewSyncWatchHub(&fakeSyncRevisionReader{revisions: map[string]int64{}}, time.Hour)
	_, release := hub.subscribe("alice", 1)
	defer release()

	hub.Close()
	hub.Close() // 두 번 불러도 괜찮아야 한다(RegisterOnShutdown + defer).
	if !isClosed(hub.done()) {
		t.Fatal("done must be closed after Close")
	}
	late, releaseLate := hub.subscribe("bob", 1)
	defer releaseLate()
	if !isClosed(late) {
		t.Fatal("a waiter arriving after Close must not block")
	}
}

func TestJitterSyncWatchHoldStaysWithinTwentyPercent(t *testing.T) {
	for i := 0; i < 1000; i++ {
		hold := jitterSyncWatchHold(25 * time.Second)
		if hold < 20*time.Second || hold > 30*time.Second {
			t.Fatalf("hold %v outside 20s..30s", hold)
		}
	}
}

// 팀 알림은 그 팀을 기다리는 멤버를 모두 깨우고, 다른 팀과 개인 볼트 대기자는 그대로 둔다.
func TestSyncWatchHubTeamNotifyWakesOnlyThatTeam(t *testing.T) {
	hub := NewSyncWatchHub(&fakeSyncRevisionReader{revisions: map[string]int64{}, teamValues: map[store.TeamWatchKey]int64{}}, time.Hour)
	defer hub.Close()

	alice, releaseAlice := hub.subscribeTeam("team-a", "alice", 3)
	defer releaseAlice()
	bob, releaseBob := hub.subscribeTeam("team-a", "bob", 3)
	defer releaseBob()
	other, releaseOther := hub.subscribeTeam("team-b", "alice", 1)
	defer releaseOther()
	personal, releasePersonal := hub.subscribe("alice", 7)
	defer releasePersonal()

	hub.notifyTeam("team-a")
	if !isClosed(alice) || !isClosed(bob) {
		t.Fatal("team members were not woken")
	}
	if isClosed(other) || isClosed(personal) {
		t.Fatal("a team notification woke another vault")
	}
}

// 개인 칸 알림은 그 팀을 기다리는 그 멤버만 깨운다.
func TestSyncWatchHubTeamMemberNotifyWakesOnlyThatMember(t *testing.T) {
	hub := NewSyncWatchHub(&fakeSyncRevisionReader{revisions: map[string]int64{}, teamValues: map[store.TeamWatchKey]int64{}}, time.Hour)
	defer hub.Close()

	alice, releaseAlice := hub.subscribeTeam("team-a", "alice", 3)
	defer releaseAlice()
	bob, releaseBob := hub.subscribeTeam("team-a", "bob", 3)
	defer releaseBob()

	hub.notifyTeamMember("team-a", "alice")
	if !isClosed(alice) {
		t.Fatal("the member was not woken")
	}
	if isClosed(bob) {
		t.Fatal("another member was woken by someone else's private slot")
	}
}

// 묶음 확인은 값이 바뀐 팀 대기자와 멤버가 아니게 된 대기자를 깨운다. 팀 대기자가 없으면 팀 값을 읽지 않는다.
func TestSyncWatchHubCheckWakesChangedTeamWaitersAndFormerMembers(t *testing.T) {
	reader := &fakeSyncRevisionReader{revisions: map[string]int64{"carol": 5}, teamValues: map[store.TeamWatchKey]int64{}}
	reader.setTeam("team-a", "alice", 3)
	reader.setTeam("team-a", "bob", 3)
	reader.setTeam("team-b", "dave", 9)
	hub := NewSyncWatchHub(reader, 10*time.Millisecond)
	defer hub.Close()

	personal, releasePersonal := hub.subscribe("carol", 5)
	defer releasePersonal()
	time.Sleep(50 * time.Millisecond)
	if calls := reader.teamCallCount(); calls != 0 {
		t.Fatalf("team values were read %d times with no team waiter", calls)
	}

	alice, releaseAlice := hub.subscribeTeam("team-a", "alice", 3)
	defer releaseAlice()
	bob, releaseBob := hub.subscribeTeam("team-a", "bob", 3)
	defer releaseBob()
	dave, releaseDave := hub.subscribeTeam("team-b", "dave", 9)
	defer releaseDave()

	reader.setTeam("team-a", "alice", 4)
	reader.dropTeam("team-a", "bob")
	waitClosed(t, alice, time.Second, "changed team waiter")
	waitClosed(t, bob, time.Second, "former member")
	time.Sleep(50 * time.Millisecond)
	if isClosed(dave) || isClosed(personal) {
		t.Fatal("an unchanged waiter was woken")
	}
}
