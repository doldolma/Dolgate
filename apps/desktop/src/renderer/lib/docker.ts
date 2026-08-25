// 도커 섹션이 보조 채널로 물어보는 명령과 그 출력 파서.
//
// 왜 여기 모으나: 명령 문자열과 파싱은 순수 함수라 테스트가 붙고, 섹션 컴포넌트는 그린 것만
// 책임진다. 자원·프로세스 섹션이 `lib/host-metrics.ts` 를 두고 같은 모양으로 갈랐다.
//
// 규칙 하나: **사용자에게 시키지 않는다.** 권한이 없으면 우리가 `sudo -n` 까지 해 보고, 그래도
// 안 되면 그때 한 줄로 말한다. "sudo 로 다시 확인하시겠습니까" 같은 것은 만들지 않는다.

import { AUX_PATH_EXPORT } from './aux-path';

/** 도커를 부르는 방법. 위에서부터 되는 것을 쓴다. */
export const DOCKER_PREFIX_CANDIDATES = ['docker', 'sudo -n docker', 'podman'] as const;

/** 목록 한 번에 받는 최대 줄 수. 넘으면 잘렸다고 말하고 검색으로 좁히게 한다. */
export const DOCKER_ROW_LIMIT = 200;

/** 셸에 넘기는 값을 감싼다 — 이름에 따옴표가 들어와도 인젝션이 되지 않게. */
export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * 어떤 방법으로 도커를 부를 수 있는지 한 번의 왕복으로 알아본다.
 *
 * `sudo -n` 은 비밀번호를 요구하지 않는 sudo 다 — 물어볼 창이 없으므로 조용히 실패하고 다음
 * 후보로 넘어간다. 마지막 두 줄(has=)은 "도커가 아예 없다" 와 "있는데 우리가 못 만진다" 를
 * 가르는 데만 쓴다(아예 없으면 섹션 자체를 띄우지 않는다).
 */
export function buildDockerProbeCommand(): string {
  const candidates = DOCKER_PREFIX_CANDIDATES.map((candidate) =>
    candidate.includes(' ') ? `"${candidate}"` : candidate,
  ).join(' ');
  return (
    AUX_PATH_EXPORT +
    [
      `for c in ${candidates}; do $c ps -q >/dev/null 2>&1 && { echo "prefix=$c"; break; }; done`,
      'command -v docker >/dev/null 2>&1 && echo has=docker',
      'command -v podman >/dev/null 2>&1 && echo has=podman',
      // 안 되면 이유까지 한 줄 받아 온다 — 권한이 없는 것과 데몬이 꺼진 것은 다른 말이고,
      // 우리가 대신 할 수 있는 일도 다르다.
      "echo \"why=$(docker ps -q 2>&1 >/dev/null | head -n 1)\"",
    ].join('; ')
  );
}

export interface DockerProbe {
  /** 쓸 수 있는 호출 방법. null 이면 목록을 받을 수 없다. */
  prefix: string | null;
  /** 바이너리는 깔려 있는가(권한만 막힌 경우를 가른다). */
  installed: boolean;
  /** 안 될 때 도커가 낸 첫 줄. 데몬이 꺼진 것과 권한이 없는 것을 가른다. */
  reason: 'permission' | 'daemon' | 'unknown' | null;
}

export function parseDockerProbe(stdout: string): DockerProbe {
  let prefix: string | null = null;
  let installed = false;
  let why = '';
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text.startsWith('prefix=')) {
      const value = text.slice('prefix='.length).trim();
      if (value) {
        prefix = value;
      }
    } else if (text.startsWith('has=')) {
      installed = true;
    } else if (text.startsWith('why=')) {
      why = text.slice('why='.length).trim();
    }
  }
  return {
    prefix,
    installed,
    reason: prefix || !installed ? null : classifyDockerFailure(why),
  };
}

function classifyDockerFailure(text: string): 'permission' | 'daemon' | 'unknown' {
  if (/permission denied/i.test(text)) {
    return 'permission';
  }
  // "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." —
  // 도커 데스크톱이 꺼져 있거나 서비스가 죽은 것이다.
  if (/cannot connect|is the docker daemon running|no such file/i.test(text)) {
    return 'daemon';
  }
  return 'unknown';
}

/* ─── 컨테이너 ─────────────────────────────────────────────────────────── */

export type DockerContainerState =
  | 'running'
  | 'restarting'
  | 'paused'
  | 'exited'
  | 'created'
  | 'dead';

export interface DockerContainer {
  id: string;
  name: string;
  state: DockerContainerState;
  /** docker 가 준 원문 상태("Up 22 hours (healthy)") — 상세에 그대로 보여 준다. */
  status: string;
  image: string;
  /** 원문 포트 매핑. */
  ports: string;
  /** compose 스택 이름. 라벨이 없으면 null(= 묶이지 않은 것). */
  project: string | null;
  /** compose 서비스 이름. */
  service: string | null;
  /** compose 파일이 있는 디렉터리. 스택 단위 명령에 필요하다. */
  workingDir: string | null;
}

const CONTAINER_FIELDS = [
  '{{.ID}}',
  '{{.Names}}',
  '{{.State}}',
  '{{.Status}}',
  '{{.Image}}',
  '{{.Ports}}',
  '{{.Label "com.docker.compose.project"}}',
  '{{.Label "com.docker.compose.service"}}',
  '{{.Label "com.docker.compose.project.working_dir"}}',
].join('\\t');

/**
 * 정지된 것까지 한 번에 받는다(`-a`). 정지 포함 토글을 두지 않기 때문이다 — 무엇을 보여 줄지는
 * 우리가 정하고(그룹 끝에 흐리게), 검색도 받아 온 목록을 앱에서 거른다. 왕복은 하나면 된다.
 */
export function buildContainerListCommand(prefix: string): string {
  return `${AUX_PATH_EXPORT}${prefix} ps -a --format '${CONTAINER_FIELDS}' | head -n ${DOCKER_ROW_LIMIT + 1}`;
}

function toContainerState(state: string, status: string): DockerContainerState {
  const normalized = state.trim().toLowerCase();
  if (
    normalized === 'running' ||
    normalized === 'restarting' ||
    normalized === 'paused' ||
    normalized === 'exited' ||
    normalized === 'created' ||
    normalized === 'dead'
  ) {
    return normalized;
  }
  // 20.10 미만 도커는 `.State` 를 주지 않는다 — 상태 문장의 첫 낱말로 가른다.
  const text = status.trim().toLowerCase();
  if (text.startsWith('up')) {
    return text.includes('paused') ? 'paused' : 'running';
  }
  if (text.startsWith('restarting')) {
    return 'restarting';
  }
  if (text.startsWith('created')) {
    return 'created';
  }
  if (text.startsWith('dead')) {
    return 'dead';
  }
  return 'exited';
}

export interface DockerContainerList {
  containers: DockerContainer[];
  /** 한 번에 받을 수 있는 줄 수를 넘었다. */
  truncated: boolean;
}

export function parseContainerList(stdout: string): DockerContainerList {
  const containers: DockerContainer[] = [];
  let seen = 0;
  for (const line of stdout.split('\n')) {
    // 탭이 없는 줄은 우리 형식이 아니다(데몬 오류 문장 등) — 조용히 버린다.
    if (!line.includes('\t')) {
      continue;
    }
    seen += 1;
    if (containers.length >= DOCKER_ROW_LIMIT) {
      continue;
    }
    const parts = line.split('\t');
    const [id, name, state, status, image, ports, project, service, workingDir] = parts;
    if (!id || !name) {
      continue;
    }
    containers.push({
      id: id.trim(),
      name: name.trim(),
      state: toContainerState(state ?? '', status ?? ''),
      status: (status ?? '').trim(),
      image: (image ?? '').trim(),
      ports: (ports ?? '').trim(),
      project: (project ?? '').trim() || null,
      service: (service ?? '').trim() || null,
      workingDir: (workingDir ?? '').trim() || null,
    });
  }
  return { containers, truncated: seen > DOCKER_ROW_LIMIT };
}

/** 목록에 보이는 이름. compose 서비스가 있으면 그것(스택 안에서는 접두사가 군더더기다). */
export function containerLabel(container: DockerContainer): string {
  return container.service ?? container.name;
}

export function isContainerRunning(container: DockerContainer): boolean {
  return container.state === 'running' || container.state === 'restarting';
}

export interface DockerStack {
  /** compose 프로젝트 이름. null 이면 묶이지 않은 것들이다. */
  project: string | null;
  /** 스택 단위 명령에 쓸 디렉터리(하나라도 라벨이 있으면 그것). */
  workingDir: string | null;
  containers: DockerContainer[];
  runningCount: number;
}

/** 스택 머리를 만들 최소 크기. 한 개짜리는 머리 한 줄이 그 자체로 낭비다. */
export const MIN_STACK_SIZE = 2;

export interface DockerLayout {
  /** 머리를 달아 묶을 스택(둘 이상). */
  stacks: DockerStack[];
  /** 한 개짜리 스택과 라벨 없는 것들 — 머리 없이 그냥 줄로 놓는다. */
  loose: DockerContainer[];
}

/**
 * 목록을 어떻게 놓을지 정한다.
 *
 * **묶는 것이 한 줄을 벌어야 묶는다.** compose 프로젝트라도 컨테이너가 하나면 머리 + 줄로 두 줄이
 * 되어, 한 개짜리 프로젝트가 여럿인 호스트에서는 화면이 머리로 반쯤 찬다(실측: 21개 중 7개가
 * 한 개짜리 → 머리만 8줄). 그런 것은 라벨 없는 것들과 함께 평평한 줄로 내려놓고, 프로젝트
 * 이름은 행을 펼치면 보인다.
 *
 * 들여쓴 줄 = 위 스택에 속한 것, 붙은 줄 = 혼자인 것. 머리 하나("스택 없음")를 더 쓰지 않고도
 * 구분이 된다.
 */
export function layoutContainers(
  containers: readonly DockerContainer[],
  minStackSize: number = MIN_STACK_SIZE,
): DockerLayout {
  const stacks: DockerStack[] = [];
  const loose: DockerContainer[] = [];
  for (const stack of groupContainersByStack(containers)) {
    if (stack.project !== null && stack.containers.length >= minStackSize) {
      stacks.push(stack);
    } else {
      loose.push(...stack.containers);
    }
  }
  loose.sort((left, right) => {
    const leftRunning = isContainerRunning(left) ? 0 : 1;
    const rightRunning = isContainerRunning(right) ? 0 : 1;
    return leftRunning - rightRunning || left.name.localeCompare(right.name);
  });
  return { stacks, loose };
}

/**
 * 스택으로 묶는다. 기준은 **`com.docker.compose.project` 라벨**이다 — 이름 접두사가 아니다.
 * 접두사로 묶으면 `api`·`api-gateway` 처럼 남의 이름이 한 스택으로 끌려 들어온다.
 *
 * 순서: 스택은 이름 오름차순, 묶이지 않은 것은 맨 뒤. 스택 안에서는 돌고 있는 것이 먼저고
 * 정지된 것이 끝에 온다(그래서 흐리게 그려도 자리가 예측된다).
 */
export function groupContainersByStack(
  containers: readonly DockerContainer[],
): DockerStack[] {
  const byProject = new Map<string, DockerStack>();
  for (const container of containers) {
    const key = container.project ?? '';
    let stack = byProject.get(key);
    if (!stack) {
      stack = {
        project: container.project,
        workingDir: null,
        containers: [],
        runningCount: 0,
      };
      byProject.set(key, stack);
    }
    stack.containers.push(container);
    if (container.workingDir && !stack.workingDir) {
      stack.workingDir = container.workingDir;
    }
    if (isContainerRunning(container)) {
      stack.runningCount += 1;
    }
  }
  const stacks = [...byProject.values()];
  for (const stack of stacks) {
    stack.containers.sort((left, right) => {
      const leftRunning = isContainerRunning(left) ? 0 : 1;
      const rightRunning = isContainerRunning(right) ? 0 : 1;
      return (
        leftRunning - rightRunning ||
        containerLabel(left).localeCompare(containerLabel(right))
      );
    });
  }
  return stacks.sort((left, right) => {
    if (left.project === null) {
      return 1;
    }
    if (right.project === null) {
      return -1;
    }
    return left.project.localeCompare(right.project);
  });
}

/** 호스트에 열린 포트만 뽑는다(`0.0.0.0:5050->5050/tcp, :::5050->…` → ['5050']). */
export function parsePublishedPorts(ports: string): string[] {
  const found: string[] = [];
  for (const entry of ports.split(',')) {
    const match = /:(\d+)->/.exec(entry.trim());
    if (match && !found.includes(match[1])) {
      found.push(match[1]);
    }
  }
  return found;
}

export type DockerAgeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

export interface DockerAge {
  count: number;
  unit: DockerAgeUnit;
}

const AGE_UNITS: Array<[RegExp, DockerAgeUnit]> = [
  [/^sec/, 'second'],
  [/^min/, 'minute'],
  [/^hour/, 'hour'],
  [/^day/, 'day'],
  [/^week/, 'week'],
  [/^month/, 'month'],
  [/^year/, 'year'],
];

/**
 * 상태 문장에서 지난 시간을 뽑는다("Up 22 hours (healthy)" → 22시간). 숫자와 단위만 돌려주고
 * 문구는 화면에서 번역한다 — 여기서 한국어를 만들면 영어 UI 에서 다시 뜯어야 한다.
 */
export function parseDockerAge(status: string): DockerAge | null {
  const match = /(\d+)\s+(second|minute|hour|day|week|month|year)s?/i.exec(status);
  if (!match) {
    return null;
  }
  const unit = AGE_UNITS.find(([pattern]) => pattern.test(match[2].toLowerCase()));
  return unit ? { count: Number(match[1]), unit: unit[1] } : null;
}

/** 상태 문장에 헬스체크 결과가 들어 있으면 뽑는다. */
export function parseDockerHealth(status: string): 'healthy' | 'unhealthy' | 'starting' | null {
  if (/\(healthy\)/i.test(status)) {
    return 'healthy';
  }
  if (/\(unhealthy\)/i.test(status)) {
    return 'unhealthy';
  }
  if (/\(health: starting\)/i.test(status)) {
    return 'starting';
  }
  return null;
}

/** 종료 코드("Exited (137) 3 days ago" → 137). */
export function parseExitCode(status: string): number | null {
  const match = /^Exited \((\d+)\)/i.exec(status.trim());
  return match ? Number(match[1]) : null;
}

/* ─── 지표(stats) · 검사(inspect) ───────────────────────────────────────── */

export interface DockerStat {
  /** 짧은 ID(ps 의 .ID 와 같은 형식). */
  id: string;
  cpuPercent: number;
  memBytes: number;
  memLimitBytes: number;
  memPercent: number;
  netIn: string;
  netOut: string;
  blockRead: string;
  blockWrite: string;
  pids: number;
}

export interface DockerInspectInfo {
  id: string;
  restartCount: number;
  health: 'healthy' | 'unhealthy' | 'starting' | null;
  oomKilled: boolean;
}

/**
 * 목록 + 지표(+ 검사)를 **한 왕복**으로 받는다.
 *
 * 세 명령의 주기가 다르지만(목록은 자주, 검사는 드물게) 왕복을 나누면 채널을 세 번 잡는다 —
 * 필요할 때만 뒤에 붙여 한 번에 보낸다. 응답은 구분자로 갈라 읽는다.
 *
 * `stats --no-stream` 은 데몬이 CPU 차분을 재는 동안 기다리므로 컨테이너가 많으면 초 단위로
 * 걸린다. 그래서 호출부가 걸린 시간을 재서 주기를 늘린다(사용자가 고르지 않는다).
 */
export function buildSnapshotCommand(
  prefix: string,
  options: { stats: boolean; inspect: boolean },
): string {
  const parts = [buildContainerListCommand(prefix).slice(AUX_PATH_EXPORT.length)];
  if (options.stats) {
    parts.push(`echo ${LIST_SEPARATOR}`);
    parts.push(
      `${prefix} stats --no-stream --format '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}'`,
    );
  }
  if (options.inspect) {
    parts.push(`echo ${LIST_SEPARATOR}`);
    // 컨테이너가 하나도 없으면 `inspect` 는 인자 없이 실패한다 — 먼저 id 를 세어 본다.
    // Health 는 헬스체크가 없으면 nil 이라 `{{if}}` 로 감싸야 템플릿이 죽지 않는다.
    parts.push(
      `ids=$(${prefix} ps -aq); [ -n "$ids" ] && ${prefix} inspect $ids --format ` +
        `'{{.Id}}\t{{.RestartCount}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}\t{{.State.OOMKilled}}'`,
    );
  }
  return AUX_PATH_EXPORT + parts.join('; ');
}

export interface DockerSnapshot {
  containers: DockerContainer[];
  truncated: boolean;
  /** 짧은 ID → 지표. stats 를 붙이지 않았거나 실패하면 빈 Map. */
  stats: Map<string, DockerStat>;
  /** 짧은 ID → 검사 결과. */
  inspect: Map<string, DockerInspectInfo>;
}

export function parseSnapshot(stdout: string): DockerSnapshot {
  const [listPart = '', statsPart = '', inspectPart = ''] = stdout.split(LIST_SEPARATOR);
  const list = parseContainerList(listPart);
  return {
    containers: list.containers,
    truncated: list.truncated,
    stats: parseStats(statsPart),
    inspect: parseInspect(inspectPart),
  };
}

/** "412MiB / 15.6GiB" → [바이트, 바이트]. */
export function parseMemUsage(text: string): [number, number] {
  const [used = '', limit = ''] = text.split('/');
  return [parseBinarySize(used), parseBinarySize(limit)];
}

const BINARY_UNITS: Record<string, number> = {
  b: 1,
  kb: 1000,
  kib: 1024,
  mb: 1000 ** 2,
  mib: 1024 ** 2,
  gb: 1000 ** 3,
  gib: 1024 ** 3,
  tb: 1000 ** 4,
  tib: 1024 ** 4,
};

export function parseBinarySize(text: string): number {
  const match = /^([\d.]+)\s*([kmgt]?i?b)$/i.exec(text.trim());
  if (!match) {
    return 0;
  }
  return Number(match[1]) * (BINARY_UNITS[match[2].toLowerCase()] ?? 1);
}

function parsePercent(text: string): number {
  const value = Number.parseFloat(text.replace('%', '').trim());
  return Number.isFinite(value) ? value : 0;
}

function splitPair(text: string): [string, string] {
  const [left = '', right = ''] = text.split('/');
  return [left.trim(), right.trim()];
}

export function parseStats(stdout: string): Map<string, DockerStat> {
  const stats = new Map<string, DockerStat>();
  for (const line of stdout.split('\n')) {
    if (!line.includes('\t')) {
      continue;
    }
    const [id, cpu, mem, memPct, net, block, pids] = line.split('\t');
    if (!id || id.trim() === 'CONTAINER ID') {
      continue;
    }
    const [memBytes, memLimitBytes] = parseMemUsage(mem ?? '');
    const [netIn, netOut] = splitPair(net ?? '');
    const [blockRead, blockWrite] = splitPair(block ?? '');
    stats.set(id.trim(), {
      id: id.trim(),
      cpuPercent: parsePercent(cpu ?? ''),
      memBytes,
      memLimitBytes,
      memPercent: parsePercent(memPct ?? ''),
      netIn,
      netOut,
      blockRead,
      blockWrite,
      pids: Number((pids ?? '').trim()) || 0,
    });
  }
  return stats;
}

export function parseInspect(stdout: string): Map<string, DockerInspectInfo> {
  const info = new Map<string, DockerInspectInfo>();
  for (const line of stdout.split('\n')) {
    if (!line.includes('\t')) {
      continue;
    }
    const [id, restarts, health, oom] = line.split('\t');
    if (!id) {
      continue;
    }
    const shortId = id.trim().slice(0, 12);
    const healthText = (health ?? '').trim().toLowerCase();
    info.set(shortId, {
      id: shortId,
      restartCount: Number((restarts ?? '').trim()) || 0,
      health:
        healthText === 'healthy' || healthText === 'unhealthy' || healthText === 'starting'
          ? healthText
          : null,
      oomKilled: (oom ?? '').trim() === 'true',
    });
  }
  return info;
}

/** 행이 "아픈" 이유. 없으면 null — 문제 그룹에 올릴지 판정하는 데도 쓴다. */
export type DockerTrouble = 'restarting' | 'unhealthy' | 'oom' | 'crashed';

export function troubleOf(
  container: DockerContainer,
  info: DockerInspectInfo | undefined,
): DockerTrouble | null {
  if (container.state === 'restarting') {
    return 'restarting';
  }
  if (info?.oomKilled) {
    return 'oom';
  }
  if (info?.health === 'unhealthy' || parseDockerHealth(container.status) === 'unhealthy') {
    return 'unhealthy';
  }
  // 0 으로 끝난 종료는 "할 일을 마친 것" 일 수 있다 — 비정상 코드만 문제로 본다.
  const exit = parseExitCode(container.status);
  if (exit !== null && exit !== 0) {
    return 'crashed';
  }
  return null;
}

/* ─── 이미지 ───────────────────────────────────────────────────────────── */

export interface DockerImage {
  repository: string;
  tag: string;
  id: string;
  size: string;
  /** 정렬용으로 환산한 바이트. */
  sizeBytes: number;
  /** 태그가 없는 중간 이미지. */
  dangling: boolean;
}

export interface DockerDiskSummary {
  /** `docker system df` 의 한 줄. */
  type: string;
  total: number;
  active: number;
  size: string;
  reclaimable: string;
}

const LIST_SEPARATOR = '@@dolgate@@';

/**
 * 이미지 목록과 총량을 한 왕복에 받는다. 총량은 `docker images` 를 더하지 않고 `system df` 에서
 * 가져온다 — 레이어를 공유하는 이미지들은 크기를 더하면 실제 디스크보다 크게 나온다.
 */
export function buildImageListCommand(prefix: string): string {
  return AUX_PATH_EXPORT + [
    `${prefix} images --format '{{.Repository}}\\t{{.Tag}}\\t{{.ID}}\\t{{.Size}}' | head -n ${DOCKER_ROW_LIMIT + 1}`,
    `echo ${LIST_SEPARATOR}`,
    `${prefix} system df --format '{{.Type}}\\t{{.TotalCount}}\\t{{.Active}}\\t{{.Size}}\\t{{.Reclaimable}}'`,
  ].join('; ');
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
};

export function parseDockerSize(text: string): number {
  const match = /^([\d.]+)\s*([kmgt]?b)$/i.exec(text.trim());
  if (!match) {
    return 0;
  }
  return Number(match[1]) * (SIZE_UNITS[match[2].toLowerCase()] ?? 1);
}

export interface DockerImageList {
  images: DockerImage[];
  summary: DockerDiskSummary[];
  truncated: boolean;
}

export function parseImageList(stdout: string): DockerImageList {
  const [listPart = '', summaryPart = ''] = stdout.split(LIST_SEPARATOR);
  const images: DockerImage[] = [];
  let seen = 0;
  for (const line of listPart.split('\n')) {
    if (!line.includes('\t')) {
      continue;
    }
    seen += 1;
    if (images.length >= DOCKER_ROW_LIMIT) {
      continue;
    }
    const [repository, tag, id, size] = line.split('\t');
    if (!repository || !id) {
      continue;
    }
    images.push({
      repository: repository.trim(),
      tag: (tag ?? '').trim(),
      id: id.trim(),
      size: (size ?? '').trim(),
      sizeBytes: parseDockerSize(size ?? ''),
      dangling: repository.trim() === '<none>',
    });
  }
  const summary: DockerDiskSummary[] = [];
  for (const line of summaryPart.split('\n')) {
    if (!line.includes('\t')) {
      continue;
    }
    const [type, total, active, size, reclaimable] = line.split('\t');
    summary.push({
      type: (type ?? '').trim(),
      total: Number((total ?? '').trim()) || 0,
      active: Number((active ?? '').trim()) || 0,
      size: (size ?? '').trim(),
      reclaimable: (reclaimable ?? '').trim(),
    });
  }
  // 큰 것부터. 이미지 목록을 여는 이유는 거의 늘 디스크다.
  images.sort((left, right) => right.sizeBytes - left.sizeBytes);
  return { images, summary, truncated: seen > DOCKER_ROW_LIMIT };
}

/** 컨테이너가 쓰고 있는 이미지 집합(`repo:tag` 와 짧은 ID 둘 다 담는다). */
export function collectUsedImages(containers: readonly DockerContainer[]): Set<string> {
  const used = new Set<string>();
  for (const container of containers) {
    if (container.image) {
      used.add(container.image);
    }
  }
  return used;
}

export function isImageUsed(image: DockerImage, used: ReadonlySet<string>): boolean {
  if (image.dangling) {
    return false;
  }
  const tagged = image.tag && image.tag !== '<none>'
    ? `${image.repository}:${image.tag}`
    : image.repository;
  if (used.has(tagged) || used.has(image.repository)) {
    return true;
  }
  // 컨테이너가 ID 로 떠 있는 경우(`docker run <sha>`).
  for (const entry of used) {
    if (entry.startsWith(image.id) || image.id.startsWith(entry)) {
      return true;
    }
  }
  return false;
}

/* ─── 볼륨 ─────────────────────────────────────────────────────────────── */

export interface DockerVolume {
  name: string;
  driver: string;
  /** 이 볼륨을 붙인 컨테이너 수. */
  usedBy: number;
  /** 익명 볼륨(이름이 해시). */
  anonymous: boolean;
}

/** 볼륨 목록과 "누가 쓰는지" 를 한 왕복에. 마운트는 컨테이너 쪽에서만 알 수 있다. */
export function buildVolumeListCommand(prefix: string): string {
  return AUX_PATH_EXPORT + [
    `${prefix} volume ls --format '{{.Name}}\\t{{.Driver}}' | head -n ${DOCKER_ROW_LIMIT + 1}`,
    `echo ${LIST_SEPARATOR}`,
    `${prefix} ps -a --format '{{.Mounts}}'`,
  ].join('; ');
}

const ANONYMOUS_VOLUME = /^[0-9a-f]{32,}$/;

export function parseVolumeList(stdout: string): { volumes: DockerVolume[]; truncated: boolean } {
  const [listPart = '', mountsPart = ''] = stdout.split(LIST_SEPARATOR);
  const usage = new Map<string, number>();
  for (const line of mountsPart.split('\n')) {
    for (const mount of line.split(',')) {
      const name = mount.trim();
      if (name) {
        usage.set(name, (usage.get(name) ?? 0) + 1);
      }
    }
  }
  const volumes: DockerVolume[] = [];
  let seen = 0;
  for (const line of listPart.split('\n')) {
    if (!line.includes('\t')) {
      continue;
    }
    seen += 1;
    if (volumes.length >= DOCKER_ROW_LIMIT) {
      continue;
    }
    const [name, driver] = line.split('\t');
    if (!name) {
      continue;
    }
    const trimmed = name.trim();
    volumes.push({
      name: trimmed,
      driver: (driver ?? '').trim(),
      usedBy: usage.get(trimmed) ?? 0,
      anonymous: ANONYMOUS_VOLUME.test(trimmed),
    });
  }
  return { volumes, truncated: seen > DOCKER_ROW_LIMIT };
}

/**
 * 볼륨 크기. `system df -v` 는 초 단위로 걸릴 수 있어서 목록과 같은 왕복에 태우지 않고,
 * 볼륨 탭을 열면 뒤에서 한 번 돌려 자리를 채운다(누르게 하지 않는다).
 */
export function buildVolumeSizeCommand(prefix: string): string {
  return `${AUX_PATH_EXPORT}${prefix} system df -v`;
}

/** `system df -v` 의 "Local Volumes space usage" 표에서 이름 → 크기를 뽑는다. */
export function parseVolumeSizes(stdout: string): Map<string, string> {
  const sizes = new Map<string, string>();
  let inSection = false;
  for (const line of stdout.split('\n')) {
    if (/local volumes space usage/i.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) {
      continue;
    }
    const text = line.trim();
    if (!text) {
      continue;
    }
    if (/^VOLUME NAME/i.test(text)) {
      continue;
    }
    // 다음 절이 시작되면 끝난다("Build cache usage: …").
    if (/space usage:?$/i.test(text) || /^build cache/i.test(text)) {
      break;
    }
    const parts = text.split(/\s{2,}|\t/).filter(Boolean);
    if (parts.length < 3) {
      continue;
    }
    sizes.set(parts[0].trim(), parts[parts.length - 1].trim());
  }
  return sizes;
}

/* ─── 네트워크 ─────────────────────────────────────────────────────────── */

export interface DockerNetwork {
  name: string;
  driver: string;
  subnet: string | null;
  containerCount: number;
}

/**
 * 이름·드라이버·서브넷·붙은 컨테이너 수를 한 왕복에. `network ls` 만으로는 서브넷을 알 수 없어
 * `inspect` 를 쓰지만, 네트워크마다 부르면 왕복이 여러 번이 되므로 id 를 한꺼번에 넘긴다.
 */
export function buildNetworkListCommand(prefix: string): string {
  const format =
    '{{.Name}}\\t{{.Driver}}\\t{{range .IPAM.Config}}{{.Subnet}} {{end}}\\t{{len .Containers}}';
  return `${AUX_PATH_EXPORT}${prefix} network inspect $(${prefix} network ls -q) --format '${format}' 2>/dev/null | head -n ${DOCKER_ROW_LIMIT + 1}`;
}

export function parseNetworkList(stdout: string): { networks: DockerNetwork[]; truncated: boolean } {
  const networks: DockerNetwork[] = [];
  let seen = 0;
  for (const line of stdout.split('\n')) {
    if (!line.includes('\t')) {
      continue;
    }
    seen += 1;
    if (networks.length >= DOCKER_ROW_LIMIT) {
      continue;
    }
    const [name, driver, subnets, count] = line.split('\t');
    if (!name) {
      continue;
    }
    const subnet = (subnets ?? '').trim().split(/\s+/).filter(Boolean)[0] ?? null;
    networks.push({
      name: name.trim(),
      driver: (driver ?? '').trim(),
      subnet,
      containerCount: Number((count ?? '').trim()) || 0,
    });
  }
  return { networks, truncated: seen > DOCKER_ROW_LIMIT };
}

/* ─── 명령 만들기 ──────────────────────────────────────────────────────── */

/**
 * 컨테이너 안으로 들어가는 명령. bash 가 있으면 bash, 없으면 sh 로 떨어진다 — 어느 쪽인지
 * 사용자가 고르게 하지 않는다.
 *
 * 이 명령이 새 탭에서 돌면 `subshell-detect` 가 `docker exec` 를 알아보고 셸 통합을 다시
 * 넣어 준다(컨테이너 안에서도 명령 블록이 잡힌다).
 */
export function dockerShellCommand(prefix: string, container: DockerContainer): string {
  const target = quoteShellArg(container.name);
  return `${prefix} exec -it ${target} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`;
}

export function dockerLogsCommand(prefix: string, container: DockerContainer): string {
  const follow = isContainerRunning(container) ? '-f ' : '';
  return `${prefix} logs ${follow}--tail 200 ${quoteShellArg(container.name)}`;
}

export function dockerStateCommand(
  prefix: string,
  action: 'start' | 'stop' | 'restart',
  containers: readonly DockerContainer[],
): string {
  const names = containers.map((container) => quoteShellArg(container.name)).join(' ');
  return `${prefix} ${action} ${names}`;
}

export function dockerRemoveCommand(prefix: string, container: DockerContainer): string {
  return `${prefix} rm ${quoteShellArg(container.name)}`;
}

export function dockerImagePruneCommand(prefix: string): string {
  return `${prefix} image prune -a`;
}

export function dockerVolumePruneCommand(prefix: string): string {
  return `${prefix} volume prune`;
}

export function dockerImageRemoveCommand(prefix: string, image: DockerImage): string {
  const target = image.dangling
    ? image.id
    : `${image.repository}${image.tag && image.tag !== '<none>' ? `:${image.tag}` : ''}`;
  return `${prefix} rmi ${quoteShellArg(target)}`;
}

export function dockerVolumeRemoveCommand(prefix: string, volume: DockerVolume): string {
  return `${prefix} volume rm ${quoteShellArg(volume.name)}`;
}

export function dockerNetworkRemoveCommand(prefix: string, network: DockerNetwork): string {
  return `${prefix} network rm ${quoteShellArg(network.name)}`;
}

/**
 * 스택 로그·down 은 compose 가 필요하다. 디렉터리를 모르면(라벨이 없으면) 그 항목을 아예 만들지
 * 않는다 — 눌리지 않는 메뉴를 보여 주는 것보다 없는 것이 낫다.
 */
export function stackComposeCommand(
  prefix: string,
  workingDir: string,
  args: string,
): string {
  return `${prefix} compose --project-directory ${quoteShellArg(workingDir)} ${args}`;
}
