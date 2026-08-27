//go:build windows

package hostmetrics

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// IANA ifType. 루프백은 세지 않는다 — 자기 자신과의 통신이 네트워크 사용량으로 잡히면
// 로컬 개발 중에 그래프가 통째로 거짓말을 한다.
const ifTypeSoftwareLoopback = 24

// MIB_IF_ROW2.InterfaceAndOperStatusFlags 의 비트필드. 첫 비트가 HardwareInterface,
// 둘째가 FilterInterface 다.
const flagFilterInterface = 1 << 1

// netCounters 는 인터페이스별 누적 바이트를 읽는다.
//
// **구형 GetIfEntry 는 못 쓴다.** 그쪽 카운터는 32비트라 4GB 에서 감기는데, 이 기계는 부팅
// 몇 시간 만에 이미 900MB 를 넘겼다 — 하루 켜 두면 감긴 값이 음수 델타로 나와 그래프가
// 튄다. GetIfTable2Ex 는 같은 값을 64비트로 준다.
func netCounters() (map[string]NetCounter, error) {
	var table *windows.MibIfTable2
	if err := windows.GetIfTable2Ex(windows.MibIfTableNormal, &table); err != nil {
		return nil, err
	}
	defer windows.FreeMibTable(unsafe.Pointer(table))

	if table.NumEntries == 0 {
		return nil, nil
	}
	rows := unsafe.Slice(&table.Table[0], table.NumEntries)
	counters := make(map[string]NetCounter, len(rows))
	for index := range rows {
		row := &rows[index]
		if row.Type == ifTypeSoftwareLoopback {
			continue
		}
		// **NDIS 필터 모듈을 빼야 한다.** QoS Packet Scheduler·WFP·VirtualBox 같은 필터가
		// 어댑터마다 한 줄씩 더 나오는데, 그 줄들의 카운터는 실제 어댑터와 **같은 값**이다.
		// 그냥 더하면 이 기계에서 트래픽이 5배로 잡혔다(어댑터 1 + 필터 4).
		//
		// 하드웨어인지로 가르지는 않는다 — Tailscale 같은 가상 어댑터는 하드웨어가 아니지만
		// 거기로 흐르는 것은 진짜 트래픽이라 세야 한다.
		if row.InterfaceAndOperStatusFlags&flagFilterInterface != 0 {
			continue
		}
		// 한 바이트도 오간 적 없는 인터페이스는 뺀다. Windows 에는 쓰이지 않는 가상 어댑터가
		// 여럿 있어서(WFP·WAN 미니포트) 그대로 두면 목록이 그것들로 채워진다.
		if row.InOctets == 0 && row.OutOctets == 0 {
			continue
		}
		name := windows.UTF16ToString(row.Alias[:])
		if name == "" {
			name = fmt.Sprintf("if%d", row.InterfaceIndex)
		}
		counters[name] = NetCounter{RxBytes: row.InOctets, TxBytes: row.OutOctets}
	}
	return counters, nil
}

// CTL_CODE(IOCTL_DISK_BASE=0x7, 0x0008, METHOD_BUFFERED=0, FILE_ANY_ACCESS=0)
const ioctlDiskPerformance = 0x00070020

// DISK_PERFORMANCE. 이름과 달리 BytesRead/BytesWritten 은 **누적값**이다(초당이 아니다).
type diskPerformance struct {
	BytesRead           int64
	BytesWritten        int64
	ReadTime            int64
	WriteTime           int64
	IdleTime            int64
	ReadCount           uint32
	WriteCount          uint32
	QueueDepth          uint32
	SplitCount          uint32
	QueryTime           int64
	StorageDeviceNumber uint32
	StorageManagerName  [8]uint16
}

// 물리 디스크를 몇 번까지 찾아볼지. 번호는 0부터 이어지지만 중간이 빌 수 있어(디스크를 뽑은
// 뒤) 한 번 실패했다고 멈추지 않고 이 수까지는 훑는다.
const maxPhysicalDrives = 16

// diskIOCounters 는 물리 디스크별 누적 read/write 바이트를 읽는다.
//
// **권한을 요구하지 않는 열기다.** dwDesiredAccess 를 0 으로 두면 장치 속성만 묻는 핸들이
// 나오고, IOCTL_DISK_PERFORMANCE 는 FILE_ANY_ACCESS 라 그 핸들로 통한다 — 읽기 권한을
// 달라고 하면 관리자 권한이 필요해진다.
//
// 파티션(\\.\C:)이 아니라 물리 디스크를 세는 이유는 리눅스 쪽과 같다 — 파티션까지 함께
// 더하면 같은 바이트를 두 번 센다.
func diskIOCounters() (map[string]DiskIOCounter, error) {
	counters := make(map[string]DiskIOCounter)
	for number := 0; number < maxPhysicalDrives; number++ {
		name := fmt.Sprintf("PhysicalDrive%d", number)
		performance, err := readDiskPerformance(name)
		if err != nil {
			continue
		}
		counters[name] = DiskIOCounter{
			ReadBytes:  uint64(performance.BytesRead),
			WriteBytes: uint64(performance.BytesWritten),
		}
	}
	if len(counters) == 0 {
		// 성능 카운터가 꺼져 있거나(diskperf -n) 장치를 열 수 없는 경우다. 빈 지도 대신
		// nil 을 돌려 "못 읽었다" 를 분명히 한다.
		return nil, nil
	}
	return counters, nil
}

func readDiskPerformance(name string) (diskPerformance, error) {
	var performance diskPerformance
	path, err := windows.UTF16PtrFromString(`\\.\` + name)
	if err != nil {
		return performance, err
	}
	handle, err := windows.CreateFile(
		path,
		0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil,
		windows.OPEN_EXISTING,
		0,
		0,
	)
	if err != nil {
		return performance, err
	}
	defer windows.CloseHandle(handle)

	var returned uint32
	if err := windows.DeviceIoControl(
		handle,
		ioctlDiskPerformance,
		nil,
		0,
		(*byte)(unsafe.Pointer(&performance)),
		uint32(unsafe.Sizeof(performance)),
		&returned,
		nil,
	); err != nil {
		return performance, err
	}
	return performance, nil
}
