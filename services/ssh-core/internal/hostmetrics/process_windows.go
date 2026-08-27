//go:build windows

package hostmetrics

import (
	"path/filepath"
	"sort"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// PROCESS_MEMORY_COUNTERS.
type processMemoryCounters struct {
	Cb                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

/*
프로세스별 CPU 사용률을 내려면 이전 표본이 있어야 한다.

유닉스에서는 `ps` 가 %cpu 를 이미 계산해서 준다. Windows 에는 그런 것이 없고 누적 CPU 시간만
있으므로, 지난번에 읽은 값을 들고 있다가 차분해야 한다.

**세션마다가 아니라 기계마다 하나다.** 로컬 세션이 여럿이어도 가리키는 것은 같은 기계이고,
이 값은 "지난 수집 이후의 비율" 이라 누가 언제 물었든 답이 성립한다. 세션마다 따로 들면 같은
프로세스를 여러 벌 추적하면서 값만 갈라진다.
*/
var tracker = struct {
	mu       sync.Mutex
	at       time.Time
	cpuTicks map[uint32]uint64
}{}

// processSnapshot 은 이번에 읽은 프로세스 하나의 원재료다.
type processSnapshot struct {
	pid        uint32
	name       string
	cpuTicks   uint64
	workingSet uint64
	hasMemory  bool
}

// topProcesses 는 CPU 사용률 상위 limit 개를 돌려준다.
//
// 사용자 이름과 전체 경로는 **상위 목록이 정해진 뒤에만** 찾는다. 둘 다 프로세스마다 핸들을
// 더 열어야 하는 일이라, 수백 개 전부에 하면 수집이 그것에 먹힌다.
func topProcesses(limit int, memTotalKb *uint64) ([]Process, error) {
	snapshots, err := snapshotProcesses()
	if err != nil {
		return nil, err
	}

	now := time.Now()
	tracker.mu.Lock()
	previous := tracker.cpuTicks
	previousAt := tracker.at
	current := make(map[uint32]uint64, len(snapshots))
	for _, snapshot := range snapshots {
		current[snapshot.pid] = snapshot.cpuTicks
	}
	// 사라진 pid 는 함께 사라진다 — 지도를 통째로 갈아 끼운다.
	tracker.cpuTicks = current
	tracker.at = now
	tracker.mu.Unlock()

	// CPU 시간은 100ns 단위다. 벽시계도 같은 단위로 맞춰 나눈다.
	elapsedTicks := float64(now.Sub(previousAt) / 100)
	// 첫 수집에는 이전 표본이 없다. 그때는 모두 0 이다 — 살아 있는 동안의 평균으로 대신
	// 채우면 오래 뜬 프로세스가 늘 위로 올라와, 지금 무엇이 바쁜지를 못 보게 된다.
	haveBaseline := previous != nil && !previousAt.IsZero() && elapsedTicks > 0

	type scored struct {
		snapshot processSnapshot
		percent  float64
	}
	entries := make([]scored, 0, len(snapshots))
	for _, snapshot := range snapshots {
		percent := 0.0
		if haveBaseline {
			if before, ok := previous[snapshot.pid]; ok && snapshot.cpuTicks >= before {
				// `ps` 의 %cpu 와 같이 **코어 하나에 대한 비율**이다 — 여러 코어를 쓰는
				// 프로세스는 100 을 넘는다.
				percent = float64(snapshot.cpuTicks-before) / elapsedTicks * 100
			}
		}
		entries = append(entries, scored{snapshot: snapshot, percent: percent})
	}
	sort.SliceStable(entries, func(a, b int) bool {
		if entries[a].percent != entries[b].percent {
			return entries[a].percent > entries[b].percent
		}
		// 첫 수집처럼 전부 0 일 때는 메모리가 큰 것부터 보여 준다 — 아무 순서로 자르면
		// 목록이 매번 뒤바뀐다.
		return entries[a].snapshot.workingSet > entries[b].snapshot.workingSet
	})
	if len(entries) > limit {
		entries = entries[:limit]
	}

	processes := make([]Process, 0, len(entries))
	for _, entry := range entries {
		process := Process{
			PID:        int(entry.snapshot.pid),
			CPUPercent: entry.percent,
			Command:    entry.snapshot.name,
			User:       processUser(entry.snapshot.pid),
		}
		if fullPath := processImagePath(entry.snapshot.pid); fullPath != "" {
			process.Command = fullPath
		}
		if entry.snapshot.hasMemory {
			rssKb := entry.snapshot.workingSet / 1024
			process.RssKb = &rssKb
			if memTotalKb != nil && *memTotalKb > 0 {
				process.MemPercent = float64(rssKb) / float64(*memTotalKb) * 100
			}
		}
		processes = append(processes, process)
	}
	return processes, nil
}

func snapshotProcesses() ([]processSnapshot, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snapshot)

	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := windows.Process32First(snapshot, &entry); err != nil {
		return nil, err
	}

	var processes []processSnapshot
	for {
		if entry.ProcessID != 0 {
			processes = append(processes, readProcess(entry))
		}
		if err := windows.Process32Next(snapshot, &entry); err != nil {
			// ERROR_NO_MORE_FILES 로 끝난다.
			break
		}
	}
	return processes, nil
}

func readProcess(entry windows.ProcessEntry32) processSnapshot {
	snapshot := processSnapshot{
		pid:  entry.ProcessID,
		name: windows.UTF16ToString(entry.ExeFile[:]),
	}
	// 메모리까지 읽으려면 VM_READ 가 더 필요하다. 다른 사용자의 프로세스에는 없을 수 있으므로
	// 한 단계 낮춰 다시 연다 — 그때는 CPU 만 얻고 메모리는 null 로 둔다.
	handle, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_VM_READ,
		false,
		entry.ProcessID,
	)
	if err != nil {
		handle, err = windows.OpenProcess(
			windows.PROCESS_QUERY_LIMITED_INFORMATION,
			false,
			entry.ProcessID,
		)
		if err != nil {
			return snapshot
		}
	}
	defer windows.CloseHandle(handle)

	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &creation, &exit, &kernel, &user); err == nil {
		snapshot.cpuTicks = filetimeTicks(kernel) + filetimeTicks(user)
	}
	counters := processMemoryCounters{}
	counters.Cb = uint32(unsafe.Sizeof(counters))
	result, _, _ := procGetProcessMemoryInf.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(&counters)),
		uintptr(counters.Cb),
	)
	if result != 0 {
		snapshot.workingSet = uint64(counters.WorkingSetSize)
		snapshot.hasMemory = true
	}
	return snapshot
}

// processUser 는 프로세스를 소유한 계정 이름을 찾는다. 못 찾으면 빈 문자열이다 — 다른
// 사용자나 시스템 프로세스의 토큰은 열 수 없다.
func processUser(pid uint32) string {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(handle)

	var token windows.Token
	if err := windows.OpenProcessToken(handle, windows.TOKEN_QUERY, &token); err != nil {
		return ""
	}
	defer token.Close()

	tokenUser, err := token.GetTokenUser()
	if err != nil {
		return ""
	}
	account, _, _, err := tokenUser.User.Sid.LookupAccount("")
	if err != nil {
		return ""
	}
	return account
}

// processImagePath 는 전체 경로를 찾는다. 목록에서 같은 이름의 프로세스를 가르는 것이 경로라
// 이름만으로는 어느 것인지 알 수 없다.
func processImagePath(pid uint32) string {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(handle)

	buffer := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil {
		return ""
	}
	return filepath.Clean(windows.UTF16ToString(buffer[:size]))
}
