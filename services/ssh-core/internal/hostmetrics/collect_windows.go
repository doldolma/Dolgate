//go:build windows

package hostmetrics

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const supported = true

// x/sys/windows 가 감싸 두지 않은 것만 직접 부른다. DLL export 를 부르는 것은 cgo 가 아니라
// 그냥 syscall 이고, 이 저장소에는 이미 같은 방식이 있다(cmd/aws-conpty-wrapper).
var (
	kernel32                = windows.NewLazySystemDLL("kernel32.dll")
	procGetSystemTimes      = kernel32.NewProc("GetSystemTimes")
	procGlobalMemoryStatus  = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetTickCount64      = kernel32.NewProc("GetTickCount64")
	psapi                   = windows.NewLazySystemDLL("psapi.dll")
	procGetProcessMemoryInf = psapi.NewProc("GetProcessMemoryInfo")
)

// MEMORYSTATUSEX. Length 를 먼저 채워야 커널이 받는다.
type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

func collect(options Options) (Sample, error) {
	sample := Sample{Kind: SampleKind}

	if busy, total, err := cpuTicks(); err == nil {
		sample.CPU = &CPUTicks{Kind: "ticks", Busy: busy, Total: total}
	}
	if totalKb, availableKb, err := memory(); err == nil {
		sample.MemTotalKb = &totalKb
		sample.MemAvailableKb = &availableKb
	}
	if seconds, ok := uptimeSeconds(); ok {
		sample.UptimeSeconds = &seconds
	}
	cpuCount := runtime.NumCPU()
	sample.CPUCount = &cpuCount
	// LoadAvg1 은 늘 nil 이다 — Windows 에 load average 라는 개념이 없다. 0 으로 채우면
	// "한가하다" 는 거짓말이 된다.

	sample.Disks = diskUsage()
	if counters, err := netCounters(); err == nil {
		sample.Net = counters
	}
	if counters, err := diskIOCounters(); err == nil {
		sample.DiskIO = counters
	}
	if options.ProcessLimit > 0 {
		if processes, err := topProcesses(options.ProcessLimit, sample.MemTotalKb); err == nil {
			sample.Processes = processes
		}
	}
	if options.System {
		sample.System = systemInfo()
	}
	return sample, nil
}

func filetimeTicks(value windows.Filetime) uint64 {
	return uint64(value.HighDateTime)<<32 | uint64(value.LowDateTime)
}

// cpuTicks 는 /proc/stat 의 `cpu` 줄과 같은 뜻을 돌려준다(단위는 100ns).
//
// GetSystemTimes 의 kernel 에는 **idle 이 포함돼 있다** — 그래서 busy 를 낼 때 빼야 한다.
// 이것을 빠뜨리면 유휴 장비가 100% 로 보인다.
func cpuTicks() (busy, total uint64, err error) {
	var idle, kernel, user windows.Filetime
	result, _, callErr := procGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&idle)),
		uintptr(unsafe.Pointer(&kernel)),
		uintptr(unsafe.Pointer(&user)),
	)
	if result == 0 {
		return 0, 0, callErr
	}
	idleTicks, kernelTicks, userTicks := filetimeTicks(idle), filetimeTicks(kernel), filetimeTicks(user)
	total = kernelTicks + userTicks
	if idleTicks > total {
		return 0, 0, fmt.Errorf("idle ticks exceed total")
	}
	return total - idleTicks, total, nil
}

func memory() (totalKb, availableKb uint64, err error) {
	status := memoryStatusEx{}
	status.Length = uint32(unsafe.Sizeof(status))
	result, _, callErr := procGlobalMemoryStatus.Call(uintptr(unsafe.Pointer(&status)))
	if result == 0 {
		return 0, 0, callErr
	}
	return status.TotalPhys / 1024, status.AvailPhys / 1024, nil
}

func uptimeSeconds() (float64, bool) {
	milliseconds, _, _ := procGetTickCount64.Call()
	if milliseconds == 0 {
		return 0, false
	}
	return (time.Duration(milliseconds) * time.Millisecond).Seconds(), true
}

// diskUsage 는 고정 드라이브만 센다.
//
// 네트워크 드라이브와 이동식 매체를 빼는 이유는 df 와 같다 — 꽂혀 있지 않은 카드리더가
// 0바이트 볼륨으로 목록을 채우고, 매핑된 공유는 이 기계의 자원이 아니다.
func diskUsage() []DiskUsage {
	buffer := make([]uint16, 512)
	length, err := windows.GetLogicalDriveStrings(uint32(len(buffer)), &buffer[0])
	if err != nil || length == 0 {
		return nil
	}
	if int(length) < len(buffer) {
		buffer = buffer[:length]
	}

	var disks []DiskUsage
	start := 0
	for index := 0; index < len(buffer); index++ {
		if buffer[index] != 0 {
			continue
		}
		root := windows.UTF16ToString(buffer[start:index])
		start = index + 1
		if root == "" {
			continue
		}
		rootPtr, err := windows.UTF16PtrFromString(root)
		if err != nil {
			continue
		}
		if windows.GetDriveType(rootPtr) != windows.DRIVE_FIXED {
			continue
		}
		// free 는 이 사용자에게 허용된 여유(쿼터 반영), totalFree 는 볼륨 전체의 여유다.
		// df 의 available 과 같은 뜻은 앞의 것이다.
		var available, total, totalFree uint64
		if err := windows.GetDiskFreeSpaceEx(rootPtr, &available, &total, &totalFree); err != nil {
			continue
		}
		if total == 0 {
			continue
		}
		disks = append(disks, DiskUsage{
			Mount:       root,
			TotalKb:     total / 1024,
			UsedKb:      (total - totalFree) / 1024,
			AvailableKb: available / 1024,
		})
	}
	return disks
}

func systemInfo() *SystemInfo {
	info := &SystemInfo{Arch: unameArch()}
	if hostname, err := os.Hostname(); err == nil {
		info.Hostname = hostname
	}
	version := windows.RtlGetVersion()
	// `uname -sr` 과 같은 모양으로 맞춘다 — 화면은 이 줄을 커널로 읽는다.
	info.Kernel = fmt.Sprintf(
		"Windows %d.%d.%d",
		version.MajorVersion, version.MinorVersion, version.BuildNumber,
	)
	info.CPUModel = processorName()
	return info
}

// unameArch 는 GOARCH 를 uname -m 이 쓰는 이름으로 옮긴다. 화면의 다른 호스트들이 그 이름을
// 쓰고 있어서, 여기만 amd64 라고 적으면 같은 것이 두 이름으로 보인다.
func unameArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "aarch64"
	case "386":
		return "i686"
	default:
		return runtime.GOARCH
	}
}

func processorName() string {
	key, err := registry.OpenKey(
		registry.LOCAL_MACHINE,
		`HARDWARE\DESCRIPTION\System\CentralProcessor\0`,
		registry.QUERY_VALUE,
	)
	if err != nil {
		return ""
	}
	defer key.Close()
	name, _, err := key.GetStringValue("ProcessorNameString")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(name)
}
