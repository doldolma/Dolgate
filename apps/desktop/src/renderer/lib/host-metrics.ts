// 접속한 원격 호스트의 부하를 상태바에 보여주기 위한 수집 명령과 파서.
//
// 보조 exec 채널(자동완성 generator 가 쓰는 그 채널)로 /proc 몇 개를 한 번에 읽는다. 읽기
// 전용이라 부작용이 없고, 사용자 셸 히스토리에도 남지 않는다.
//
// CPU 사용률과 네트워크 처리량은 순간값이 존재하지 않는다 — /proc/stat 의 jiffies 와
// /proc/net/dev 의 바이트는 모두 부팅 이후 누적값이다. 그래서 이전 폴링 샘플과의 *차분*으로
// 계산한다. 폴링을 어차피 주기적으로 하므로 왕복이 늘지 않는다(첫 샘플에서는 값이 없다).

import { t } from '../i18n';

/** 파서가 구분자로 쓰는 마커. 명령 출력에 섞일 일이 없도록 흔치 않은 형태로. */
const SECTION = '@@dolgate';

/**
 * 한 번의 exec 로 필요한 것을 모두 읽는다.
 *
 * - `LC_ALL=C`: free/df 출력이 로케일에 따라 달라지는 것을 막는다.
 * - df 는 `-P`(POSIX 형식)로 고정 — 긴 장치명이 줄바꿈되는 것을 막는다.
 * - 각 항목은 실패해도 나머지를 살리도록 `|| true` 로 감싼다(예: 컨테이너에 df 없음).
 */
export function buildHostMetricsCommand(
  options: { processLimit?: number; system?: boolean } = {},
): string {
  const parts = [
    `echo ${SECTION}:stat`,
    'grep -m1 "^cpu " /proc/stat || true',
    `echo ${SECTION}:mem`,
    'grep -E "^(MemTotal|MemAvailable):" /proc/meminfo || true',
    `echo ${SECTION}:net`,
    'cat /proc/net/dev || true',
    // 어느 것이 진짜 장치인지. /sys/class/net/<이름>/device 가 있으면 실제 NIC 이고,
    // 브리지·veth·본드·VLAN·터널에는 없다(netdata 가 쓰는 판정). 자세한 이유는 parseNet 옆에.
    `echo ${SECTION}:netdev`,
    'for i in /sys/class/net/*; do [ -e "$i/device" ] && echo "${i##*/}"; done 2>/dev/null || true',
    `echo ${SECTION}:load`,
    'cat /proc/loadavg || true',
    `echo ${SECTION}:uptime`,
    'cat /proc/uptime || true',
    `echo ${SECTION}:cpus`,
    'nproc 2>/dev/null || grep -c "^processor" /proc/cpuinfo || true',
    `echo ${SECTION}:diskio`,
    'cat /proc/diskstats || true',
    `echo ${SECTION}:disk`,
    'df -Pk || true',
  ];
  // 프로세스 목록은 세션 패널이 보고 있을 때만 태운다. 출력이 커서(수백 줄) 상태바만 쓰는
  // 평소에도 실어 보내면 왕복마다 그만큼을 버리게 된다.
  //
  // `-o …=` 로 헤더를 없애고 CPU 내림차순 상위 N개만 가져온다. busybox ps 처럼 이 옵션을
  // 모르는 호스트에서는 빈 섹션이 되고(`|| true`), 그때 UI 가 "읽을 수 없다" 를 말한다.
  const processLimit = options.processLimit ?? 0;
  if (processLimit > 0) {
    parts.push(
      `echo ${SECTION}:ps`,
      `ps -eo pid=,user=,pcpu=,pmem=,rss=,args= --sort=-pcpu 2>/dev/null | head -n ${processLimit} || true`,
    );
  }
  // 정적인 값(호스트명·커널·아키텍처·CPU 종류)은 **한 번만** 태운다. 세션이 사는 동안 바뀌지
  // 않으므로(커널 교체는 재부팅이고 그건 새 세션이다) 자원 섹션이 열릴 때 한 번 받아 캐시한다.
  //
  // 명령 전체가 sh -c '...' 안이라 작은따옴표를 쓸 수 없다 — 큰따옴표만 쓴다.
  if (options.system) {
    parts.push(
      `echo ${SECTION}:sys`,
      'uname -srm || true',
      'hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null || true',
      // x86 은 "model name", ARM(라즈베리파이 등)은 "Model"·"Hardware" 로 적는다. 맥은
      // /proc 이 없어 sysctl 로 간다.
      'grep -m1 -E "^(model name|Model|Hardware)" /proc/cpuinfo 2>/dev/null | cut -d: -f2- || sysctl -n machdep.cpu.brand_string 2>/dev/null || true',
    );
  }
  return `LC_ALL=C sh -c '${parts.join('; ')}'`;
}

/**
 * 이 호스트가 무엇인지 — 세션 동안 바뀌지 않는 값들.
 *
 * 못 읽은 항목은 null 이다(빈 문자열로 두면 화면이 빈 줄을 그린다).
 */
export interface HostSystemInfo {
  hostname: string | null;
  /** `uname -sr` — 커널 이름과 릴리스(`Linux 5.15.0-91-generic`). */
  kernel: string | null;
  /** `uname -m` — 아키텍처(`x86_64`, `aarch64`). */
  arch: string | null;
  cpuModel: string | null;
}

/**
 * `sys` 섹션을 읽는다 — 첫 줄이 `uname -srm`, 둘째 줄이 호스트명, 셋째 줄이 CPU 종류다.
 *
 * 항목이 하나도 없으면 null 을 돌려준다(요청하지 않은 것과 못 읽은 것을 구분하지 않는다 —
 * 어느 쪽이든 보여 줄 것이 없다).
 */
export function parseHostSystemInfo(block: string): HostSystemInfo | null {
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }
  const [unameLine, hostnameLine, cpuLine] = lines;
  // `uname -srm` 은 "Linux 5.15.0-91-generic x86_64" — 마지막 조각이 아키텍처다.
  let kernel: string | null = null;
  let arch: string | null = null;
  if (unameLine) {
    const pieces = unameLine.split(/\s+/);
    if (pieces.length >= 3) {
      arch = pieces[pieces.length - 1] ?? null;
      kernel = pieces.slice(0, -1).join(' ');
    } else {
      kernel = unameLine;
    }
  }
  const info: HostSystemInfo = {
    hostname: hostnameLine ?? null,
    kernel,
    arch,
    cpuModel: cpuLine ? cpuLine.replace(/\s+/g, ' ').trim() : null,
  };
  return info.hostname || info.kernel || info.arch || info.cpuModel ? info : null;
}

/** 프로세스 한 줄. 종료·우선순위 변경은 하지 않으므로 보여 줄 것만 담는다. */
export interface HostProcess {
  pid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  /** 상주 메모리(KB). 못 읽으면 null. */
  rssKb: number | null;
  /** 전체 명령줄. 길면 UI 가 자른다 — 여기서 자르면 검색이 안 걸린다. */
  command: string;
}

/**
 * `ps -eo pid=,user=,pcpu=,pmem=,rss=,args=` 출력을 읽는다.
 *
 * args 에 공백이 들어 있으므로 앞의 다섯 칸만 나누고 나머지를 전부 명령으로 본다.
 */
export function parseHostProcesses(block: string): HostProcess[] {
  const rows: HostProcess[] = [];
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) {
      continue;
    }
    const pid = toNumber(parts[0]);
    const cpuPercent = toNumber(parts[2]);
    const memPercent = toNumber(parts[3]);
    if (pid === null) {
      continue;
    }
    rows.push({
      pid,
      user: parts[1],
      cpuPercent: cpuPercent ?? 0,
      memPercent: memPercent ?? 0,
      rssKb: toNumber(parts[4]),
      command: parts.slice(5).join(' '),
    });
  }
  return rows;
}

export interface HostDiskUsage {
  /** 마운트 지점(`/volume1`). 사용자가 알아보는 이름이라 장치명 대신 이걸 보여준다. */
  mount: string;
  usedKb: number;
  totalKb: number;
  /**
   * 이 사용자가 실제로 쓸 수 있는 여유(KB).
   *
   * 사용률은 `used / total` 이 아니라 **`used / (used + available)`** 이다 — `df` 가 쓰는 식이다.
   * ext4 는 기본 5% 를 root 예약으로 잡는데 그것을 여유로 세면, df 가 95% 라고 하는 볼륨이
   * 화면에서는 90% 가 되고 경고도 그만큼 늦게 걸린다. 총량은 그대로 보여 준다(디스크 크기를
   * 줄여 적으면 그건 또 다른 거짓말이다).
   */
  availableKb: number;
}

/** 한 번의 폴링에서 읽어낸 원시 값. 차분이 필요한 항목은 누적값 그대로 담는다. */
export interface HostMetricsSample {
  /** 수집 시각(epoch ms). 차분의 분모가 된다. */
  atMs: number;
  /** /proc/stat 의 busy·total jiffies 누적값. */
  cpu: { busy: number; total: number } | null;
  memTotalKb: number | null;
  memAvailableKb: number | null;
  /**
   * 비-loopback 인터페이스의 **인터페이스별** 누적 바이트.
   *
   * 여기서 미리 더하지 않는 이유는 목록이 변하기 때문이다 — 자세한 것은 `sumDelta` 주석에.
   */
  net: Record<string, { rxBytes: number; txBytes: number }> | null;
  /** 물리 디스크의 **디스크별** 누적 바이트. 파티션·RAID/LVM 계층은 빼서 중복 합산을 막는다. */
  diskIo: Record<string, { readBytes: number; writeBytes: number }> | null;
  loadAvg1: number | null;
  uptimeSeconds: number | null;
  cpuCount: number | null;
  /** 실제 블록 장치 파일시스템만, 큰 것부터. Synology 처럼 / 가 시스템 파티션인 경우가 있어
   *  루트 하나만 보면 정작 데이터 볼륨을 못 본다. */
  disks: HostDiskUsage[];
}

/** 두 샘플로 계산한, 화면에 그대로 쓸 수 있는 값. */
export interface HostMetrics {
  /** 0~100. 이전 샘플이 없으면 null. */
  cpuPercent: number | null;
  memUsedKb: number | null;
  memTotalKb: number | null;
  /** 초당 바이트. 이전 샘플이 없으면 null. */
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  diskReadBytesPerSec: number | null;
  diskWriteBytesPerSec: number | null;
  loadAvg1: number | null;
  cpuCount: number | null;
  uptimeSeconds: number | null;
  disks: HostDiskUsage[];
}

function section(output: string, name: string): string {
  // 개행까지 포함해 찾는다. 이름만으로 찾으면 `disk` 가 `diskio` 마커에 먼저 걸려
  // 엉뚱한 섹션을 읽는다(한쪽 이름이 다른 쪽의 접두사인 경우).
  //
  // **줄 맨 앞에 있는 마커만 센다.** 우리가 띄운 `sh -c 'echo @@dolgate:stat; …'` 자신이
  // `ps` 출력에 한 줄로 나타나기 때문이다 — 그 줄 가운데의 마커를 섹션 경계로 보면 프로세스
  // 목록이 거기서 통째로 잘린다. 우리가 찍는 마커는 언제나 줄 처음에 온다.
  const marker = `${SECTION}:${name}\n`;
  let start = output.startsWith(marker) ? 0 : output.indexOf(`\n${marker}`) + 1;
  if (start <= 0 && !output.startsWith(marker)) {
    return '';
  }
  const from = output.indexOf('\n', start);
  if (from < 0) {
    return '';
  }
  const next = output.indexOf(`\n${SECTION}`, from);
  return output.slice(from + 1, next < 0 ? undefined : next + 1);
}

function toNumber(value: string | undefined): number | null {
  // 빈 문자열을 그냥 Number() 에 넣으면 0 이 된다. 항목을 읽지 못한 것과 값이 0 인 것은
  // 달라서(읽기 실패한 호스트에 "load 0.00" 이 뜨면 안 된다) 빈 값은 없는 것으로 본다.
  if (value === undefined || value.trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `cpu  user nice system idle iowait irq softirq steal ...`
 *
 * idle + iowait 를 idle 로 보고 나머지를 busy 로 친다(top 과 같은 관례).
 */
function parseCpu(block: string): HostMetricsSample['cpu'] {
  const line = block.split('\n').find((entry) => entry.startsWith('cpu '));
  if (!line) {
    return null;
  }
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) {
    return null;
  }
  // 앞 8개(user·nice·system·idle·iowait·irq·softirq·steal)만 센다. 커널은 `guest`(9번째)를
  // **이미 user 안에 넣어서** 보고하고 `guest_nice`(10번째)도 nice 안에 있다 — 다 더하면 두 번
  // 세어져, KVM 게스트를 돌리는 호스트에서 실제 50% 가 66.7% 로 나온다. procps top·htop 도
  // 같은 이유로 이 둘을 total 에서 뺀다.
  const total = fields.slice(0, 8).reduce((sum, value) => sum + value, 0);
  const idle = fields[3] + (fields[4] ?? 0);
  return { busy: total - idle, total };
}

/**
 * MemAvailable 을 쓴다. MemFree 로 계산하면 페이지 캐시가 사용량으로 잡혀 리눅스에서는
 * 거의 항상 "메모리 꽉 참"으로 보인다.
 */
function parseMem(block: string): { totalKb: number | null; availableKb: number | null } {
  let totalKb: number | null = null;
  let availableKb: number | null = null;
  for (const line of block.split('\n')) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s*kB/.exec(line.trim());
    if (!match) {
      continue;
    }
    if (match[1] === 'MemTotal') {
      totalKb = Number(match[2]);
    } else {
      availableKb = Number(match[2]);
    }
  }
  return { totalKb, availableKb };
}

/**
 * /proc/net/dev 의 인터페이스별 누적 바이트. **여기서 더하지 않는다** — 어느 것을 셀지는
 * `filterPhysicalInterfaces` 가 정하고, 차분은 인터페이스별로 낸다(`sumDelta`).
 */
function parseNet(block: string): HostMetricsSample['net'] {
  // 프로토타입 없이 만든다 — 아래 차분이 "이전 샘플에 없는 장치" 를 `undefined` 로 판정하는데,
  // 평범한 객체라면 `constructor` 같은 이름이 없는데도 `undefined` 가 아니다.
  const interfaces: Record<string, { rxBytes: number; txBytes: number }> = Object.create(null);
  let matched = false;
  for (const line of block.split('\n')) {
    const match = /^\s*([^:\s]+):\s*(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const name = match[1];
    if (name === 'lo') {
      continue;
    }
    const fields = match[2].trim().split(/\s+/).map(Number);
    // receive: bytes packets errs drop fifo frame compressed multicast (8개)
    // transmit: bytes ... → 송신 바이트는 9번째 필드.
    if (fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) {
      continue;
    }
    interfaces[name] = { rxBytes: fields[0], txBytes: fields[8] };
    matched = true;
  }
  return matched ? interfaces : null;
}

/**
 * `netdev` 섹션 — 진짜 장치인 인터페이스 이름들. 못 읽었으면 null(빈 목록과 구분한다).
 *
 * 글롭이 안 펼쳐지면 `/sys/class/net/*` 이 그대로 한 줄로 온다 — 경로 모양이면 버린다.
 */
function parsePhysicalInterfaces(block: string): Set<string> | null {
  const names = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes('/'));
  return names.length > 0 ? new Set(names) : null;
}

/**
 * 셀 인터페이스를 고른다. **다 더하면 안 된다** — 같은 바이트가 지나는 계층마다 세어진다.
 *
 * 도커 컨테이너가 100 MB 를 받으면 `eth0` 의 수신, `docker0` 의 송신, `veth…` 의 송신으로
 * 세 번 잡혀서 "받기만 했는데 보내기가 두 배" 로 찍힌다. 본딩·VLAN·터널(Tailscale·WireGuard)은
 * 정확히 2배다. 그래서 모니터링 툴들은 합계를 내지 않고 인터페이스별로 보여 주거나 하나를
 * 고르게 한다.
 *
 * 판정은 netdata 와 같다 — `/sys/class/net/<이름>/device` 가 있으면 진짜 장치. 이름 패턴을
 * 나열하는 것보다 정확하고, 본딩도 저절로 풀린다(본드는 빠지고 슬레이브만 세므로 2배가 안 된다).
 *
 * **물리 장치를 하나도 못 찾으면 예전처럼 전부 센다.** 컨테이너 안에서 붙은 세션은 자기 eth0 이
 * veth 라 물리 장치가 없는데, 거기서 0을 보여 주느니 겹쳐 세는 편이 낫다.
 */
function filterPhysicalInterfaces(
  net: HostMetricsSample['net'],
  physical: Set<string> | null,
): HostMetricsSample['net'] {
  if (!net || !physical) {
    return net;
  }
  const kept: Record<string, { rxBytes: number; txBytes: number }> = Object.create(null);
  let matched = false;
  for (const [name, entry] of Object.entries(net)) {
    if (physical.has(name)) {
      kept[name] = entry;
      matched = true;
    }
  }
  return matched ? kept : net;
}

/**
 * 물리 디스크로 볼 이름들. 포함 목록으로 가는 이유는 중복 합산 때문이다 — /proc/diskstats 는
 * 파티션(sda1)·RAID(md0)·device-mapper(dm-0, Synology 의 cachedev)를 물리 디스크와 함께
 * 나열하는데, 이들은 결국 같은 디스크를 거치므로 다 더하면 실제의 2~3배가 나온다.
 * 모르는 장치는 빼는 쪽이 부풀리는 쪽보다 낫다.
 */
const PHYSICAL_DISK_PATTERN =
  /^(?:sd[a-z]+|vd[a-z]+|hd[a-z]+|xvd[a-z]+|sata\d+|nvme\d+n\d+|mmcblk\d+)$/;

/**
 * /proc/diskstats 에서 물리 디스크의 읽기/쓰기 누적 바이트를 합산한다.
 *
 * 필드 배치(major minor name 뒤): 1 reads, 2 reads merged, 3 sectors read, 4 ms,
 * 5 writes, 6 writes merged, 7 sectors written … 섹터는 관례상 512 바이트다(물리 섹터
 * 크기와 무관하게 커널이 512 로 환산해 보고한다).
 */
function parseDiskIo(block: string): HostMetricsSample['diskIo'] {
  const disks: Record<string, { readBytes: number; writeBytes: number }> = Object.create(null);
  let matched = false;
  for (const line of block.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) {
      continue;
    }
    const name = fields[2];
    if (!PHYSICAL_DISK_PATTERN.test(name)) {
      continue;
    }
    const sectorsRead = toNumber(fields[5]);
    const sectorsWritten = toNumber(fields[9]);
    if (sectorsRead === null || sectorsWritten === null) {
      continue;
    }
    disks[name] = { readBytes: sectorsRead * 512, writeBytes: sectorsWritten * 512 };
    matched = true;
  }
  return matched ? disks : null;
}

/**
 * 이 파일시스템의 사용률(0~1). **`df` 와 같은 식이다** — 분모가 총량이 아니라 `used + available`
 * 이라, root 예약 블록을 여유로 세지 않는다. 화면의 숫자가 `df` 와 어긋나지 않게 하려면 사용률을
 * 계산하는 자리는 여기 하나여야 한다.
 */
export function diskUsedRatio(disk: HostDiskUsage): number {
  const capacity = disk.usedKb + disk.availableKb;
  return capacity > 0 ? disk.usedKb / capacity : 0;
}

/** 툴팁에 보여줄 파일시스템 최대 개수. 더 늘리면 "간략히"가 무너진다. */
const MAX_DISKS = 4;

/**
 * df -Pk 전체에서 사람이 관심 있는 파일시스템만 추린다.
 *
 * - 실제 블록 장치(`/dev/...`)만 남긴다. tmpfs·devtmpfs·overlay 같은 메모리 파일시스템과
 *   rclone/NFS 류 원격 마운트는 "이 서버 디스크"가 아니라서 뺀다.
 * - loop 장치는 스쿼시 이미지라 사용률이 늘 100% 근처다 — 의미 없는 경고만 만든다.
 * - 같은 장치가 여러 곳에 걸려 있으면(Synology 의 ContainerManager bind mount 등) 하나만
 *   남긴다. 가장 짧은 마운트 경로가 원래 볼륨이다.
 * - 큰 것부터 정렬한다. Synology 는 / 가 2GB 남짓한 시스템 파티션이라, 루트만 보면 정작
 *   데이터가 있는 /volume1 을 못 본다.
 */
function parseDisks(block: string): HostDiskUsage[] {
  const byDevice = new Map<string, HostDiskUsage>();
  for (const [index, line] of block.split('\n').entries()) {
    if (index === 0 || line.trim().length === 0) {
      continue;
    }
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) {
      continue;
    }
    const device = fields[0];
    if (!device.startsWith('/dev/') || device.startsWith('/dev/loop')) {
      continue;
    }
    const totalKb = toNumber(fields[1]);
    const usedKb = toNumber(fields[2]);
    const availableKb = toNumber(fields[3]);
    // 마운트 경로에 공백이 있을 수 있어 6번째 필드부터 끝까지 잇는다.
    const mount = fields.slice(5).join(' ');
    if (totalKb === null || usedKb === null || availableKb === null || totalKb <= 0 || !mount) {
      continue;
    }
    const existing = byDevice.get(device);
    if (!existing || mount.length < existing.mount.length) {
      byDevice.set(device, { mount, usedKb, totalKb, availableKb });
    }
  }
  return [...byDevice.values()]
    .sort((left, right) => right.totalKb - left.totalKb)
    .slice(0, MAX_DISKS);
}

/** 명령 출력 한 덩어리를 샘플로 만든다. 읽지 못한 항목은 null 로 남기고 나머지는 살린다. */
/**
 * 프로세스 섹션만 따로 읽는다. 지표 샘플과 수명이 달라(요청했을 때만 있다) 같은 구조체에
 * 넣지 않는다 — 없는 것과 빈 것을 구분해야 UI 가 "읽을 수 없다" 를 말할 수 있다.
 */
export function parseHostProcessesFromOutput(output: string): HostProcess[] | null {
  if (!output.includes(`${SECTION}:ps`)) {
    return null;
  }
  return parseHostProcesses(section(output, 'ps'));
}

/** 출력에 sys 섹션이 있으면 읽는다. 요청하지 않은 왕복이면 null. */
export function parseHostSystemInfoFromOutput(output: string): HostSystemInfo | null {
  if (!output.includes(`${SECTION}:sys`)) {
    return null;
  }
  return parseHostSystemInfo(section(output, 'sys'));
}

export function parseHostMetricsSample(output: string, atMs: number): HostMetricsSample {
  const mem = parseMem(section(output, 'mem'));
  const load = section(output, 'load').trim().split(/\s+/);
  const uptime = section(output, 'uptime').trim().split(/\s+/);
  return {
    atMs,
    cpu: parseCpu(section(output, 'stat')),
    memTotalKb: mem.totalKb,
    memAvailableKb: mem.availableKb,
    net: filterPhysicalInterfaces(
      parseNet(section(output, 'net')),
      parsePhysicalInterfaces(section(output, 'netdev')),
    ),
    diskIo: parseDiskIo(section(output, 'diskio')),
    loadAvg1: toNumber(load[0]),
    uptimeSeconds: toNumber(uptime[0]),
    cpuCount: toNumber(section(output, 'cpus').trim().split(/\s+/)[0]),
    disks: parseDisks(section(output, 'disk')),
  };
}

/** 이 값들 중 하나라도 읽혔는지 — 전부 실패면 이 호스트에서는 지표를 못 쓴다고 본다. */
export function hasAnyHostMetric(sample: HostMetricsSample): boolean {
  return (
    sample.cpu !== null ||
    sample.memTotalKb !== null ||
    sample.net !== null ||
    sample.loadAvg1 !== null
  );
}

/**
 * 이전 샘플과 비교해 표시값을 만든다. previous 가 없으면 누적값에서 바로 얻을 수 있는
 * 것들(메모리·load·디스크)만 채우고 CPU·네트워크는 null 로 둔다.
 */

/**
 * 장치별로 뺀 **다음** 더한다. 합계를 먼저 내고 빼면 목록이 바뀌는 순간 값이 망가진다.
 *
 * 시놀로지·도커 호스트에서는 컨테이너의 `veth…` 가 수시로 생겼다 사라지고, USB 디스크도
 * 붙었다 빠진다. 합계로 다루면:
 *
 * - **사라질 때** 합계가 뒤로 가고, 음수 델타라 그 회차가 통째로 버려진다 — 차트에서 그 계열만
 *   끊긴다(같은 샘플인데 ↓는 이어지고 ↑만 빵꾸 나던 것이 이것이다).
 * - **생길 때** 그 장치의 **평생 누적**이 한 회차의 델타로 들어온다 — 3초 만에 수십 MB 를
 *   보낸 것으로 찍히고, 그 한 점이 차트 눈금 꼭대기를 10분 동안 붙잡는다.
 *
 * 그래서 양쪽 샘플에 **다 있는** 장치만 센다. 새로 생긴 장치는 이번 회차에서 빠지고 다음
 * 회차부터 정상으로 잡힌다.
 *
 * 어떤 장치의 카운터가 되감겼으면(그 장치만 리셋·32비트 랩어라운드) **이번 회차는 값을 내지
 * 않는다.** 그 장치만 빼고 나머지로 합계를 내면, 마침 나머지가 한가할 때 "트래픽 없음" 이라는
 * 정상값 0 이 나온다 — 회선이 꽉 차 있는데 차트에 직선이 그려진다. 되감겼다는 것은 그 사이
 * 얼마가 지나갔는지 모른다는 뜻이므로, 0 이라고 말하는 것은 거짓말이다. 재부팅으로 전부
 * 되감긴 경우도 같은 자리에서 걸린다.
 */
function sumDelta<T>(
  current: Record<string, T> | null | undefined,
  previous: Record<string, T> | null | undefined,
  pick: (entry: T) => number,
): number | null {
  if (!current || !previous) {
    return null;
  }
  let total = 0;
  let counted = 0;
  for (const [name, entry] of Object.entries(current)) {
    const before = previous[name];
    if (before === undefined) {
      continue;
    }
    const delta = pick(entry) - pick(before);
    if (delta < 0) {
      return null;
    }
    total += delta;
    counted += 1;
  }
  return counted > 0 ? total : null;
}

/**
 * 차분의 분모(ms).
 *
 * `atMs` 는 렌더러가 **응답을 받은** 때다. 그 차이로 나누면 분모에 왕복 지연의 요동이 그대로
 * 섞인다 — 한 번은 0.2초 만에 오고 다음은 1.5초 걸리면, 원격에서 카운터를 읽은 간격이 3.0초여도
 * 분모는 4.3초가 되어 값이 30% 작게 나온다. RTT 가 한 자릿수 ms 인 LAN 에서는 티가 안 나지만
 * SSM 이나 점프를 여러 번 넘는 호스트에서는 크다.
 *
 * `/proc/uptime` 은 **원격 호스트가 스스로 잰 시각**이고 같은 왕복에서 함께 읽어 온다. 두 값의
 * 차이가 곧 카운터를 읽은 간격이라, 지연이 끼어들 자리가 없다(분해능 10ms).
 *
 * 되감기면(재부팅) 벽시계로 물러선다 — 그 왕복은 어차피 카운터도 함께 리셋되어 값이 안 나온다.
 */
function resolveElapsedMs(
  current: HostMetricsSample,
  previous: HostMetricsSample | null,
): number {
  if (!previous) {
    return 0;
  }
  if (current.uptimeSeconds !== null && previous.uptimeSeconds !== null) {
    const remoteMs = (current.uptimeSeconds - previous.uptimeSeconds) * 1000;
    if (remoteMs > 0) {
      return remoteMs;
    }
  }
  return current.atMs - previous.atMs;
}

/**
 * 초당 값을 낼 수 있는 최소 간격.
 *
 * 0.2초 간격의 차분도 산술적으로는 초당 값이지만, **옆에 놓인 3초·10초짜리 값들과 비교할 수
 * 있는 값이 아니다** — 그 짧은 창에 우연히 걸린 버스트가 다섯 배로 부풀어, 그 한 점이 차트
 * 눈금을 10분 동안 붙잡는다. 그런 왕복은 값을 내지 않고 선을 끊는다.
 */
export const MIN_RATE_INTERVAL_MS = 1_000;

export function computeHostMetrics(
  current: HostMetricsSample,
  previous: HostMetricsSample | null,
): HostMetrics {
  const elapsedMs = resolveElapsedMs(current, previous);

  let cpuPercent: number | null = null;
  if (previous?.cpu && current.cpu) {
    const totalDelta = current.cpu.total - previous.cpu.total;
    const busyDelta = current.cpu.busy - previous.cpu.busy;
    // 재부팅이나 카운터 리셋이면 음수가 나온다 — 그때는 이번 값을 버린다.
    if (totalDelta > 0 && busyDelta >= 0) {
      cpuPercent = Math.min(100, Math.max(0, (busyDelta / totalDelta) * 100));
    }
  }

  // 네트워크·디스크 모두 누적 바이트라 같은 방식으로 초당 값을 낸다.
  const perSecond = (delta: number | null): number | null =>
    delta === null || elapsedMs < MIN_RATE_INTERVAL_MS ? null : (delta / elapsedMs) * 1000;

  const rxBytesPerSec = perSecond(sumDelta(current.net, previous?.net, (e) => e.rxBytes));
  const txBytesPerSec = perSecond(sumDelta(current.net, previous?.net, (e) => e.txBytes));
  const diskReadBytesPerSec = perSecond(
    sumDelta(current.diskIo, previous?.diskIo, (e) => e.readBytes),
  );
  const diskWriteBytesPerSec = perSecond(
    sumDelta(current.diskIo, previous?.diskIo, (e) => e.writeBytes),
  );

  const memUsedKb =
    current.memTotalKb !== null && current.memAvailableKb !== null
      ? Math.max(0, current.memTotalKb - current.memAvailableKb)
      : null;

  return {
    cpuPercent,
    memUsedKb,
    memTotalKb: current.memTotalKb,
    rxBytesPerSec,
    txBytesPerSec,
    diskReadBytesPerSec,
    diskWriteBytesPerSec,
    loadAvg1: current.loadAvg1,
    cpuCount: current.cpuCount,
    uptimeSeconds: current.uptimeSeconds,
    disks: current.disks,
  };
}

const BYTE_UNITS = ['B', 'K', 'M', 'G', 'T'];

/** 네트워크 속도 표기(`1.2 M/s`). 좁은 상태바라 소수점 한 자리까지만. */
export function formatBytesPerSecond(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return '—';
  }
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const text = unit === 0 || scaled >= 100 ? Math.round(scaled).toString() : scaled.toFixed(1);
  return `${text} ${BYTE_UNITS[unit]}/s`;
}

/** 메모리·디스크 표기(`6.1 GiB`). KiB 를 입력으로 받는다. */
export function formatKibibytes(valueKb: number | null): string {
  if (valueKb === null || !Number.isFinite(valueKb) || valueKb < 0) {
    return '—';
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = valueKb;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const text = scaled >= 100 ? Math.round(scaled).toString() : scaled.toFixed(1);
  return `${text} ${units[unit]}`;
}

export function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`;
}

/** `3일 4시간` / `5시간 12분` / `7분`. */
export function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return t('hostMetrics.daysHours', { days, hours });
  }
  if (hours > 0) {
    return t('hostMetrics.hoursMinutes', { hours, minutes });
  }
  return t('hostMetrics.minutes', { minutes });
}

/** 상태바에서 색을 바꿀지 판단한다. 임계치를 넘을 때만 강조해 평소에는 조용하도록. */
export function isHostMetricAlarming(metrics: HostMetrics): {
  cpu: boolean;
  memory: boolean;
  disk: boolean;
} {
  const memoryRatio =
    metrics.memUsedKb !== null && metrics.memTotalKb
      ? metrics.memUsedKb / metrics.memTotalKb
      : null;
  const diskRatio = metrics.disks.length
    ? Math.max(...metrics.disks.map(diskUsedRatio))
    : null;
  return {
    cpu: metrics.cpuPercent !== null && metrics.cpuPercent >= 90,
    memory: memoryRatio !== null && memoryRatio >= 0.9,
    disk: diskRatio !== null && diskRatio >= 0.9,
  };
}
