// 이 컴퓨터의 자원을 셸을 거치지 않고 읽는다.
//
// 로컬 터미널의 "호스트" 는 앱이 돌고 있는 바로 그 기계다. 그런데 지표 수집은 원격과 같은
// 길을 썼다 — 렌더러가 만든 POSIX 스크립트를 보조 채널에서 돌리고 출력을 파싱하는 길이다.
// Windows 에는 그 스크립트를 돌릴 셸이 없어 로컬 세션의 자원 섹션이 통째로 비어 있었다.
//
// PowerShell 로 같은 값을 뽑는 길은 있지만(CIM 으로 전부 나온다) **호출마다 새 프로세스**라
// 이 기계에서 한 번에 2.4초가 들었다 — 폴링 주기가 3초인데 그 대부분을 수집이 먹는다. 반면
// 같은 값을 Win32 로 직접 읽으면 0.5ms 다. 그래서 셸을 아예 빼고 여기서 읽는다.
//
// **유닉스는 그대로 셸 경로를 쓴다.** macOS 네이티브 수집은 CPU 는 mach, 디스크 IO 는 IOKit
// 이라 판이 하나 더 필요한데, 거기서는 지금 스크립트가 잘 돌고 있다. 고쳐야 할 곳만 고친다.
package hostmetrics

import "errors"

// SampleKind 는 이 문서의 모양을 렌더러에 밝힌다. 렌더러는 완성 질의의 stdout 이 이것으로
// 시작하면 셸 출력 파서 대신 JSON 으로 읽는다 — 두 생산자가 같은 통로를 쓰기 때문이다.
const SampleKind = "host-metrics-v1"

// ErrUnsupported 는 이 플랫폼에서 네이티브 수집을 하지 않는다는 뜻이다(유닉스). 호출자는
// 셸 경로로 돌아가야 한다 — 실패가 아니다.
var ErrUnsupported = errors.New("native host metrics are not collected on this platform")

// Options 는 이번 왕복에서 무엇까지 실을지 고른다. 렌더러의 요청과 같은 뜻이다.
type Options struct {
	// ProcessLimit 이 0 이면 프로세스 목록을 싣지 않는다. 세션 패널이 프로세스 섹션을 보고
	// 있을 때만 켜진다 — 목록이 커서 상태바만 쓰는 평소에도 실으면 그만큼을 버린다.
	ProcessLimit int
	// System 은 세션이 사는 동안 바뀌지 않는 값(호스트명·커널·아키텍처·CPU 종류)이다.
	// 자원 섹션이 열릴 때 한 번만 받아 캐시한다.
	System bool
}

// CPUTicks 는 /proc/stat 과 같은 누적 틱이다. 단위는 상관없다 — 렌더러가 두 표본을 차분해
// 비율만 쓴다.
type CPUTicks struct {
	Kind  string `json:"kind"`
	Busy  uint64 `json:"busy"`
	Total uint64 `json:"total"`
}

// NetCounter 는 인터페이스별 누적 바이트다. 여기서 미리 더하지 않는다 — 목록이 변하기
// 때문이다(렌더러의 sumDelta 주석 참고).
type NetCounter struct {
	RxBytes uint64 `json:"rxBytes"`
	TxBytes uint64 `json:"txBytes"`
}

// DiskIOCounter 는 물리 디스크별 누적 바이트다.
type DiskIOCounter struct {
	ReadBytes  uint64 `json:"readBytes"`
	WriteBytes uint64 `json:"writeBytes"`
}

// DiskUsage 는 df 한 줄에 해당한다. 사용률은 used/(used+available) 로 낸다 — 렌더러 쪽
// HostDiskUsage 주석과 같은 이유다.
type DiskUsage struct {
	Mount       string `json:"mount"`
	UsedKb      uint64 `json:"usedKb"`
	TotalKb     uint64 `json:"totalKb"`
	AvailableKb uint64 `json:"availableKb"`
}

// Process 는 `ps -eo pid,user,pcpu,pmem,rss,args` 한 줄에 해당한다.
type Process struct {
	PID        int     `json:"pid"`
	User       string  `json:"user"`
	CPUPercent float64 `json:"cpuPercent"`
	MemPercent float64 `json:"memPercent"`
	// RssKb 는 못 읽으면 null 이다. 다른 사용자의 프로세스는 열 권한이 없을 수 있다.
	RssKb   *uint64 `json:"rssKb"`
	Command string  `json:"command"`
}

// SystemInfo 는 uname 세 조각과 CPU 이름이다.
type SystemInfo struct {
	Hostname string `json:"hostname"`
	Kernel   string `json:"kernel"`
	Arch     string `json:"arch"`
	CPUModel string `json:"cpuModel"`
}

// Sample 은 렌더러의 HostMetricsSample 과 같은 모양이다.
//
// 못 읽은 값은 **빠뜨리지 않고 null 로 싣는다** — 렌더러가 "요청하지 않음" 과 "못 읽음" 을
// 가르지 않고 둘 다 null 로 다루므로, 값이 없다는 사실 자체가 답이다. Windows 에 없는
// load average 가 늘 그런 경우다.
type Sample struct {
	Kind           string                   `json:"kind"`
	CPU            *CPUTicks                `json:"cpu"`
	MemTotalKb     *uint64                  `json:"memTotalKb"`
	MemAvailableKb *uint64                  `json:"memAvailableKb"`
	Net            map[string]NetCounter    `json:"net"`
	DiskIO         map[string]DiskIOCounter `json:"diskIo"`
	LoadAvg1       *float64                 `json:"loadAvg1"`
	UptimeSeconds  *float64                 `json:"uptimeSeconds"`
	CPUCount       *int                     `json:"cpuCount"`
	Disks          []DiskUsage              `json:"disks"`
	// Processes 가 nil 이면 이번에 요청하지 않은 것이다(빈 배열은 "읽었는데 없다" 는 뜻이라
	// 다르다 — 실제로는 일어나지 않지만 구분을 흐리지 않는다).
	Processes []Process   `json:"processes"`
	System    *SystemInfo `json:"system"`
}

// Supported 는 이 플랫폼에서 네이티브 수집을 하는지 알려 준다.
func Supported() bool {
	return supported
}

// Collect 는 이 컴퓨터의 지표를 한 번 읽는다.
//
// 부분 실패는 오류가 아니다. 항목 하나를 못 읽어도(디스크 성능 카운터가 꺼져 있는 등) 나머지는
// 그대로 실어 보내고 그 항목만 null 로 둔다 — 화면 하나를 통째로 비우는 편이 더 나쁘다.
func Collect(options Options) (Sample, error) {
	return collect(options)
}
