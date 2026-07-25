// 접속한 원격 호스트의 부하를 상태바에 보여주기 위한 수집 명령과 파서.
//
// 보조 exec 채널(자동완성 generator 가 쓰는 그 채널)로 /proc 몇 개를 한 번에 읽는다. 읽기
// 전용이라 부작용이 없고, 사용자 셸 히스토리에도 남지 않는다.
//
// CPU 사용률과 네트워크 처리량은 순간값이 존재하지 않는다 — /proc/stat 의 jiffies 와
// /proc/net/dev 의 바이트는 모두 부팅 이후 누적값이다. 그래서 이전 폴링 샘플과의 *차분*으로
// 계산한다. 폴링을 어차피 주기적으로 하므로 왕복이 늘지 않는다(첫 샘플에서는 값이 없다).

/** 파서가 구분자로 쓰는 마커. 명령 출력에 섞일 일이 없도록 흔치 않은 형태로. */
const SECTION = '@@dolgate';

/**
 * 한 번의 exec 로 필요한 것을 모두 읽는다.
 *
 * - `LC_ALL=C`: free/df 출력이 로케일에 따라 달라지는 것을 막는다.
 * - df 는 `-P`(POSIX 형식)로 고정 — 긴 장치명이 줄바꿈되는 것을 막는다.
 * - 각 항목은 실패해도 나머지를 살리도록 `|| true` 로 감싼다(예: 컨테이너에 df 없음).
 */
export function buildHostMetricsCommand(): string {
  const parts = [
    `echo ${SECTION}:stat`,
    'grep -m1 "^cpu " /proc/stat || true',
    `echo ${SECTION}:mem`,
    'grep -E "^(MemTotal|MemAvailable):" /proc/meminfo || true',
    `echo ${SECTION}:net`,
    'cat /proc/net/dev || true',
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
  return `LC_ALL=C sh -c '${parts.join('; ')}'`;
}

export interface HostDiskUsage {
  /** 마운트 지점(`/volume1`). 사용자가 알아보는 이름이라 장치명 대신 이걸 보여준다. */
  mount: string;
  usedKb: number;
  totalKb: number;
}

/** 한 번의 폴링에서 읽어낸 원시 값. 차분이 필요한 항목은 누적값 그대로 담는다. */
export interface HostMetricsSample {
  /** 수집 시각(epoch ms). 차분의 분모가 된다. */
  atMs: number;
  /** /proc/stat 의 busy·total jiffies 누적값. */
  cpu: { busy: number; total: number } | null;
  memTotalKb: number | null;
  memAvailableKb: number | null;
  /** 비-loopback 인터페이스 합계(누적 바이트). */
  net: { rxBytes: number; txBytes: number } | null;
  /** 물리 디스크 합계(누적 바이트). 파티션·RAID/LVM 계층은 빼서 중복 합산을 막는다. */
  diskIo: { readBytes: number; writeBytes: number } | null;
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
  const start = output.indexOf(`${SECTION}:${name}\n`);
  if (start < 0) {
    return '';
  }
  const from = output.indexOf('\n', start);
  if (from < 0) {
    return '';
  }
  const next = output.indexOf(SECTION, from);
  return output.slice(from + 1, next < 0 ? undefined : next);
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
  const total = fields.reduce((sum, value) => sum + value, 0);
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
 * /proc/net/dev 의 인터페이스별 누적 바이트를 합산한다. loopback 은 제외 — 로컬 통신이
 * 실제 회선 사용량으로 잡히면 값이 크게 부풀려진다. 어느 NIC 인지 고르게 하지 않고 합계만
 * 보여주는 것은 의도된 단순화다.
 */
function parseNet(block: string): HostMetricsSample['net'] {
  let rxBytes = 0;
  let txBytes = 0;
  let matched = false;
  for (const line of block.split('\n')) {
    const match = /^\s*([^:\s]+):\s*(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const name = match[1];
    if (name === 'lo' || name.startsWith('lo:')) {
      continue;
    }
    const fields = match[2].trim().split(/\s+/).map(Number);
    // receive: bytes packets errs drop fifo frame compressed multicast (8개)
    // transmit: bytes ... → 송신 바이트는 9번째 필드.
    if (fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) {
      continue;
    }
    rxBytes += fields[0];
    txBytes += fields[8];
    matched = true;
  }
  return matched ? { rxBytes, txBytes } : null;
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
  let readBytes = 0;
  let writeBytes = 0;
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
    readBytes += sectorsRead * 512;
    writeBytes += sectorsWritten * 512;
    matched = true;
  }
  return matched ? { readBytes, writeBytes } : null;
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
    // 마운트 경로에 공백이 있을 수 있어 6번째 필드부터 끝까지 잇는다.
    const mount = fields.slice(5).join(' ');
    if (totalKb === null || usedKb === null || totalKb <= 0 || !mount) {
      continue;
    }
    const existing = byDevice.get(device);
    if (!existing || mount.length < existing.mount.length) {
      byDevice.set(device, { mount, usedKb, totalKb });
    }
  }
  return [...byDevice.values()]
    .sort((left, right) => right.totalKb - left.totalKb)
    .slice(0, MAX_DISKS);
}

/** 명령 출력 한 덩어리를 샘플로 만든다. 읽지 못한 항목은 null 로 남기고 나머지는 살린다. */
export function parseHostMetricsSample(output: string, atMs: number): HostMetricsSample {
  const mem = parseMem(section(output, 'mem'));
  const load = section(output, 'load').trim().split(/\s+/);
  const uptime = section(output, 'uptime').trim().split(/\s+/);
  return {
    atMs,
    cpu: parseCpu(section(output, 'stat')),
    memTotalKb: mem.totalKb,
    memAvailableKb: mem.availableKb,
    net: parseNet(section(output, 'net')),
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
export function computeHostMetrics(
  current: HostMetricsSample,
  previous: HostMetricsSample | null,
): HostMetrics {
  const elapsedMs = previous ? current.atMs - previous.atMs : 0;

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
  const perSecond = (
    currentValue: number | undefined,
    previousValue: number | undefined,
  ): number | null => {
    if (currentValue === undefined || previousValue === undefined || elapsedMs <= 0) {
      return null;
    }
    const delta = currentValue - previousValue;
    // 재부팅 등으로 카운터가 되감기면 음수가 된다 — 이번 값은 버린다.
    return delta >= 0 ? (delta / elapsedMs) * 1000 : null;
  };

  const rxBytesPerSec = perSecond(current.net?.rxBytes, previous?.net?.rxBytes);
  const txBytesPerSec = perSecond(current.net?.txBytes, previous?.net?.txBytes);
  const diskReadBytesPerSec = perSecond(
    current.diskIo?.readBytes,
    previous?.diskIo?.readBytes,
  );
  const diskWriteBytesPerSec = perSecond(
    current.diskIo?.writeBytes,
    previous?.diskIo?.writeBytes,
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
    return `${days}일 ${hours}시간`;
  }
  if (hours > 0) {
    return `${hours}시간 ${minutes}분`;
  }
  return `${minutes}분`;
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
    ? Math.max(...metrics.disks.map((disk) => disk.usedKb / disk.totalKb))
    : null;
  return {
    cpu: metrics.cpuPercent !== null && metrics.cpuPercent >= 90,
    memory: memoryRatio !== null && memoryRatio >= 0.9,
    disk: diskRatio !== null && diskRatio >= 0.9,
  };
}
