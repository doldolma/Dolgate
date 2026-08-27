//go:build windows

package hostmetrics

import (
	"encoding/json"
	"testing"
	"time"
)

// 이 파일은 **이 기계에서 실제로 값이 나오는지**를 본다. 가짜 대상이 없는 코드라(커널이
// 상대다) 값의 존재와 앞뒤가 맞는지로 검증한다.

func TestCollectReturnsUsableSample(t *testing.T) {
	sample, err := Collect(Options{System: true})
	if err != nil {
		t.Fatalf("Collect() error = %v", err)
	}
	if sample.Kind != SampleKind {
		t.Errorf("Kind = %q, want %q", sample.Kind, SampleKind)
	}
	if sample.CPU == nil {
		t.Fatal("CPU ticks missing")
	}
	// idle 을 빼지 않으면 busy == total 이 된다 — 유휴 장비가 100% 로 보이던 실수를 막는다.
	if sample.CPU.Busy >= sample.CPU.Total {
		t.Errorf("busy %d must be below total %d", sample.CPU.Busy, sample.CPU.Total)
	}
	if sample.MemTotalKb == nil || *sample.MemTotalKb == 0 {
		t.Fatal("total memory missing")
	}
	if sample.MemAvailableKb == nil || *sample.MemAvailableKb > *sample.MemTotalKb {
		t.Errorf("available memory %v is not within total %d", sample.MemAvailableKb, *sample.MemTotalKb)
	}
	if sample.UptimeSeconds == nil || *sample.UptimeSeconds <= 0 {
		t.Error("uptime missing")
	}
	if sample.CPUCount == nil || *sample.CPUCount <= 0 {
		t.Error("cpu count missing")
	}
	// Windows 에는 load average 가 없다. 0 으로 채우면 "한가하다" 는 거짓말이 된다.
	if sample.LoadAvg1 != nil {
		t.Errorf("LoadAvg1 = %v, want nil on Windows", *sample.LoadAvg1)
	}
	if len(sample.Disks) == 0 {
		t.Error("no fixed disks found")
	}
	for _, disk := range sample.Disks {
		if disk.Mount == "" || disk.TotalKb == 0 {
			t.Errorf("bad disk entry %+v", disk)
		}
		if disk.UsedKb > disk.TotalKb {
			t.Errorf("used %d exceeds total %d on %s", disk.UsedKb, disk.TotalKb, disk.Mount)
		}
	}
	if sample.System == nil || sample.System.Hostname == "" || sample.System.Kernel == "" {
		t.Errorf("system info missing: %+v", sample.System)
	}
	// 요청하지 않았으면 실리지 않는다.
	if sample.Processes != nil {
		t.Errorf("processes were not requested but %d came back", len(sample.Processes))
	}
}

func TestCollectCPUTicksAdvance(t *testing.T) {
	first, err := Collect(Options{})
	if err != nil {
		t.Fatalf("Collect() error = %v", err)
	}
	// 틱이 흐르는지 본다 — 상수를 돌려주면 렌더러의 차분이 늘 0 이 되어 CPU 가 0% 로 굳는다.
	time.Sleep(120 * time.Millisecond)
	second, err := Collect(Options{})
	if err != nil {
		t.Fatalf("Collect() error = %v", err)
	}
	if second.CPU.Total <= first.CPU.Total {
		t.Errorf("total ticks did not advance: %d -> %d", first.CPU.Total, second.CPU.Total)
	}
	if second.CPU.Busy < first.CPU.Busy {
		t.Errorf("busy ticks went backwards: %d -> %d", first.CPU.Busy, second.CPU.Busy)
	}
}

func TestCollectProcessesRespectLimit(t *testing.T) {
	// 첫 수집은 기준선을 만든다(그때는 모두 0%).
	if _, err := Collect(Options{ProcessLimit: 5}); err != nil {
		t.Fatalf("Collect() error = %v", err)
	}
	time.Sleep(150 * time.Millisecond)
	sample, err := Collect(Options{ProcessLimit: 5})
	if err != nil {
		t.Fatalf("Collect() error = %v", err)
	}
	if len(sample.Processes) == 0 {
		t.Fatal("no processes came back")
	}
	if len(sample.Processes) > 5 {
		t.Errorf("limit 5 but %d came back", len(sample.Processes))
	}
	for _, process := range sample.Processes {
		if process.PID <= 0 || process.Command == "" {
			t.Errorf("bad process entry %+v", process)
		}
		if process.CPUPercent < 0 {
			t.Errorf("negative cpu percent %+v", process)
		}
	}
	// 부하 순 정렬이 깨지면 목록이 매번 뒤바뀌어 읽을 수 없게 된다.
	for index := 1; index < len(sample.Processes); index++ {
		if sample.Processes[index-1].CPUPercent < sample.Processes[index].CPUPercent {
			t.Errorf("not sorted by cpu: %+v", sample.Processes)
			break
		}
	}
}

// 렌더러는 이 JSON 을 그대로 읽는다. 못 읽은 값이 키째 빠지면 "요청 안 함" 과 구분이 안 되므로
// null 로 실려야 한다.
func TestSampleMarshalsMissingValuesAsNull(t *testing.T) {
	encoded, err := json.Marshal(Sample{Kind: SampleKind})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	for _, key := range []string{
		"cpu", "memTotalKb", "memAvailableKb", "net", "diskIo",
		"loadAvg1", "uptimeSeconds", "cpuCount", "disks", "processes", "system",
	} {
		value, present := decoded[key]
		if !present {
			t.Errorf("key %q is missing from the document", key)
			continue
		}
		if value != nil {
			t.Errorf("key %q = %v, want null", key, value)
		}
	}
}

// NDIS 필터 모듈(QoS Packet Scheduler·WFP 등)은 실제 어댑터와 **같은 카운터**를 들고 한 줄씩
// 더 나온다. 걸러 내지 않으면 이 기계에서 트래픽이 5배로 잡혔다.
func TestNetCountersExcludeFilterModules(t *testing.T) {
	counters, err := netCounters()
	if err != nil {
		t.Fatalf("netCounters() error = %v", err)
	}
	if len(counters) == 0 {
		t.Skip("이 기계에 트래픽이 오간 인터페이스가 없다")
	}
	seen := map[[2]uint64][]string{}
	for name, counter := range counters {
		key := [2]uint64{counter.RxBytes, counter.TxBytes}
		seen[key] = append(seen[key], name)
	}
	for key, names := range seen {
		if len(names) > 1 {
			t.Errorf("같은 카운터(%v)를 든 인터페이스가 %d개다: %v", key, len(names), names)
		}
	}
}
