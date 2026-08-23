package autocomplete

import (
	"bytes"
	"strings"
	"testing"
)

// 호스트 OS 는 연결마다 한 번 도는 이 스냅샷에 실려 온다 — 왕복을 늘리지 않기 위해서다.
func TestSnapshotCommandCarriesTheOsProbe(t *testing.T) {
	command := RemoteSnapshotCommand()
	// os-release 가 없는 세 갈래(macOS·Synology DSM·그 밖)가 모두 들어 있어야 한다.
	for _, want := range []string{
		"/etc/os-release", "ID_LIKE", "PRETTY_NAME",
		"uname -s", "uname -r", "sw_vers",
		// 표시 파일. os-release 가 데비안·FreeBSD 인 어플라이언스를 갈라내는 유일한 단서다.
		"/etc/synoinfo.conf", "productversion",
		"/etc/pve", "/etc/unraid-version", "/etc/config/uLinux.conf",
		"/usr/local/opnsense", "/etc/platform", "TrueNAS",
		"/etc/openmediavault", "/etc/rpi-issue", "/system/build.prop",
	} {
		if !strings.Contains(command, want) {
			t.Fatalf("스냅샷 명령에 %q 가 없다", want)
		}
	}
	// os-release 를 소스하면 그 파일의 변수가 명령의 변수를 덮는다.
	if strings.Contains(command, ". /etc/os-release") {
		t.Fatal("os-release 를 소스하지 않고 읽어야 한다")
	}
}

func snapshotFields(values ...string) []byte {
	var buffer bytes.Buffer
	for _, value := range values {
		buffer.WriteString(value)
		buffer.WriteByte(0)
	}
	return buffer.Bytes()
}

func TestParseSnapshotReadsHostOs(t *testing.T) {
	result := ParseSnapshot(snapshotFields(
		"S", "bash",
		"O", "ubuntu", "debian", "Ubuntu 20.04.6 LTS",
		"H", "ls -la",
	), 1)

	if result.Snapshot.Os == nil {
		t.Fatal("OS 를 읽지 못했다")
	}
	if result.Snapshot.Os.Id != "ubuntu" || result.Snapshot.Os.Like != "debian" {
		t.Fatalf("예상과 다르다: %+v", result.Snapshot.Os)
	}
	if result.Snapshot.Os.PrettyName != "Ubuntu 20.04.6 LTS" {
		t.Fatalf("이름이 다르다: %q", result.Snapshot.Os.PrettyName)
	}
	// 다른 필드가 밀리지 않아야 한다 — O 는 칸 세 개를 먹는다.
	if len(result.Snapshot.History) != 1 || result.Snapshot.History[0] != "ls -la" {
		t.Fatalf("히스토리가 밀렸다: %+v", result.Snapshot.History)
	}
}

func TestParseSnapshotWithoutOs(t *testing.T) {
	// 읽지 못하는 호스트(os-release 도 uname 도 없음)에서는 아무것도 오지 않는다.
	result := ParseSnapshot(snapshotFields("S", "zsh", "H", "pwd"), 1)
	if result.Snapshot.Os != nil {
		t.Fatalf("없어야 한다: %+v", result.Snapshot.Os)
	}
}

func TestParseSnapshotIgnoresJunkOs(t *testing.T) {
	// id 가 비었거나 제어문자가 섞였으면 버린다(이 값으로 아이콘을 고른다).
	for _, fields := range [][]byte{
		snapshotFields("S", "bash", "O", "", "", ""),
		snapshotFields("S", "bash", "O", "ubu\x07ntu", "", "x"),
	} {
		if os := ParseSnapshot(fields, 1).Snapshot.Os; os != nil {
			t.Fatalf("버려야 한다: %+v", os)
		}
	}
}

func TestParseSnapshotOsIsLowercased(t *testing.T) {
	// uname 은 `Darwin`, `FreeBSD` 처럼 대문자를 준다 — 아이콘 대조는 소문자 하나로 한다.
	// S(셸)가 없으면 스냅샷 자체가 만들어지지 않는다 — 실제 출력도 S 가 먼저 온다.
	result := ParseSnapshot(snapshotFields("S", "zsh", "O", "Darwin", "", "macOS 26.5.2"), 1)
	if result.Snapshot.Os.Id != "darwin" {
		t.Fatalf("소문자여야 한다: %q", result.Snapshot.Os.Id)
	}
}

// NAS·컨테이너처럼 ash(busybox)를 쓰는 호스트도 OS 는 알려줄 수 있어야 한다. 자동완성은 못
// 하지만(bash·zsh 가 아니다) 아이콘은 셸과 상관이 없다 — Synology DSM 에서 아무것도 안 잡히던
// 이유가 이 게이트였다.
func TestOsProbeRunsBeforeTheShellGate(t *testing.T) {
	command := RemoteSnapshotCommand()
	gate := strings.Index(command, "bash|zsh")
	probe := strings.Index(command, "/etc/os-release")
	if probe < 0 || gate < 0 {
		t.Fatal("명령에서 프로브나 게이트를 못 찾았다")
	}
	if probe > gate {
		t.Fatal("OS 프로브가 셸 게이트 뒤에 있으면 ash 호스트에서 돌지 않는다")
	}
}

func TestParseSnapshotKeepsOsForUnsupportedShell(t *testing.T) {
	result := ParseSnapshot(snapshotFields("O", "dsm", "", "Synology DSM 7.2", "S", "ash"), 3)

	if result.Capability.Status != "unsupported" {
		t.Fatalf("자동완성은 지원 대상이 아니어야 한다: %q", result.Capability.Status)
	}
	if result.Snapshot == nil || result.Snapshot.Os == nil {
		t.Fatal("OS 는 실려 와야 한다")
	}
	if result.Snapshot.Os.Id != "dsm" || result.Snapshot.Os.PrettyName != "Synology DSM 7.2" {
		t.Fatalf("값이 다르다: %+v", result.Snapshot.Os)
	}
	// 자동완성 재료는 비어 있어야 한다 — 이 경로는 아이콘만을 위한 것이다.
	if len(result.Snapshot.History) != 0 || len(result.Snapshot.Executables) != 0 {
		t.Fatalf("자동완성 재료가 실렸다: %+v", result.Snapshot)
	}
}

func TestParseSnapshotWithoutOsAndUnsupportedShell(t *testing.T) {
	// OS 도 못 읽었으면 스냅샷을 만들 이유가 없다.
	if snapshot := ParseSnapshot(snapshotFields("S", "ash"), 1).Snapshot; snapshot != nil {
		t.Fatalf("스냅샷이 없어야 한다: %+v", snapshot)
	}
}

func TestParseSnapshotReadsSynologyDsm(t *testing.T) {
	// DSM 은 os-release 가 없어 /etc/VERSION 에서 버전을 읽는다. 마크는 없지만(글자 뱃지)
	// 이름은 보여야 한다 — 예전에는 "Linux" 만 떴다.
	result := ParseSnapshot(snapshotFields("O", "dsm", "", "Synology DSM 7.2.2", "S", "ash"), 1)
	if result.Snapshot.Os.Id != "dsm" {
		t.Fatalf("id 가 다르다: %+v", result.Snapshot.Os)
	}
	if result.Snapshot.Os.PrettyName != "Synology DSM 7.2.2" {
		t.Fatalf("이름이 다르다: %q", result.Snapshot.Os.PrettyName)
	}
}

// 표시 파일이 os-release 를 이겨야 한다. 순서가 뒤집히면 Proxmox·TrueNAS·openmediavault·
// Raspberry Pi OS 가 모두 데비안으로 보인다 — 그 호스트에서는 영원히 고쳐지지 않는다.
func TestMarkerFilesWinOverOsRelease(t *testing.T) {
	command := RemoteSnapshotCommand()
	release := strings.Index(command, "PRETTY_NAME")
	markers := strings.Index(command, "/etc/pve")
	if release < 0 || markers < 0 {
		t.Fatal("명령에서 os-release 나 표시 파일을 못 찾았다")
	}
	if markers < release {
		t.Fatal("표시 파일 검사가 os-release 보다 먼저면 이름을 os-release 에서 못 가져온다")
	}
	// 출력은 한 번뿐이어야 한다 — 분기마다 printf 하면 값이 두 번 실린다.
	if got := strings.Count(command, "printf 'O"); got != 1 {
		t.Fatalf("O 필드 출력이 %d 곳이다 — 한 곳이어야 한다", got)
	}
}

func TestParseSnapshotReadsAppliances(t *testing.T) {
	for _, item := range []struct{ id, pretty string }{
		{"pve", "Proxmox VE"},
		{"qts", "QNAP QTS"},
		{"truenas", "TrueNAS-SCALE-24.04.2"},
		{"unraid", "Unraid 6.12.10"},
		{"omv", "openmediavault"},
		{"opnsense", "OPNsense"},
		{"android", "Android"},
	} {
		result := ParseSnapshot(snapshotFields("S", "bash", "O", item.id, "", item.pretty), 1)
		if result.Snapshot.Os == nil || result.Snapshot.Os.Id != item.id {
			t.Fatalf("%s 를 읽지 못했다: %+v", item.id, result.Snapshot.Os)
		}
		if result.Snapshot.Os.PrettyName != item.pretty {
			t.Fatalf("%s 이름이 다르다: %q", item.id, result.Snapshot.Os.PrettyName)
		}
	}
}
