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
      `p=; for c in ${candidates}; do $c ps -q >/dev/null 2>&1 && { p=$c; echo "prefix=$c"; break; }; done`,
      // compose 가 v2 플러그인인지 v1 인지. **버전 확인은 데몬에 접속하지 않으므로** 소켓
      // 권한과 무관하게, 위 루프가 실패했더라도 답이 나온다 — 이걸 루프 안에 두었다가 sudo 가
      // 필요한 호스트에서 compose 항목이 통째로 사라졌다. 붙일 접두사는 화면 쪽에서 정해진
      // 호출 방법에 맞춰 만든다(composeCommandFor).
      'docker compose version >/dev/null 2>&1 && echo compose=v2',
      'command -v docker-compose >/dev/null 2>&1 && echo compose=v1',
      'command -v docker >/dev/null 2>&1 && echo has=docker',
      'command -v podman >/dev/null 2>&1 && echo has=podman',
      // 안 되면 이유까지 한 줄 받아 온다 — 권한이 없는 것과 데몬이 꺼진 것은 다른 말이고,
      // 우리가 대신 할 수 있는 일도 다르다.
      //
      // **되는 방법을 찾았으면 묻지 않는다.** 예전에는 첫 후보가 통해도 이 줄이 `docker ps` 를
      // 한 번 더 돌아, 섹션을 여는 첫 왕복이 늘 두 배였다. `||` 는 왼쪽이 성공하면 오른쪽을
      // 실행하지 않으므로 그 안의 명령 치환도 돌지 않는다.
      '[ -n "$p" ] || echo "why=$(docker ps -q 2>&1 >/dev/null | head -n 1)"',
    ].join('; ')
  );
}

export type DockerComposeKind = 'v2' | 'v1' | null;

export interface DockerProbe {
  /** 쓸 수 있는 호출 방법. null 이면 목록을 받을 수 없다. */
  prefix: string | null;
  /**
   * compose 가 어느 쪽인가. v2 는 `docker compose`(플러그인), v1 은 `docker-compose`(따로 깔린
   * 실행 파일). 없으면 null — 그때는 스택 단위 compose 동작(로그·down)을 만들지 않는다.
   */
  compose: DockerComposeKind;
  /** 바이너리는 깔려 있는가(권한만 막힌 경우를 가른다). */
  installed: boolean;
  /**
   * 프로브가 **대답을 하기는 했는가.**
   *
   * 도커가 없는 호스트도 `why=`(command not found) 한 줄은 낸다. 아무 줄도 없다는 것은 명령이
   * 제대로 돌지 않았다는 뜻이다(보조 채널이 아직 준비되지 않았거나 이번 차례를 놓쳤다) —
   * 그걸 "도커 없음" 으로 단정하면 섹션이 통째로 "없습니다" 로 굳는다. 실제로 그렇게 굳었다.
   */
  answered: boolean;
  /** 안 될 때 도커가 낸 첫 줄. 데몬이 꺼진 것과 권한이 없는 것을 가른다. */
  reason: 'permission' | 'daemon' | 'unknown' | null;
}

export function parseDockerProbe(stdout: string): DockerProbe {
  let prefix: string | null = null;
  let compose: DockerComposeKind = null;
  let installed = false;
  let answered = false;
  let why = '';
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text.startsWith('prefix=')) {
      const value = text.slice('prefix='.length).trim();
      if (value) {
        answered = true;
        prefix = value;
      }
    } else if (text === 'compose=v2') {
      answered = true;
      compose = 'v2';
    } else if (text === 'compose=v1' && compose === null) {
      answered = true;
      // 둘 다 있으면 v2 를 쓴다 — v1 은 옛 호스트의 마지막 수단이다.
      compose = 'v1';
    } else if (text.startsWith('has=')) {
      answered = true;
      installed = true;
    } else if (text.startsWith('why=')) {
      answered = true;
      why = text.slice('why='.length).trim();
    }
  }
  return {
    prefix,
    compose,
    installed,
    answered,
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

/** 초당 흐름(바이트). 누적값 두 표본의 차로 낸다. */
export interface DockerIoRate {
  netIn: number;
  netOut: number;
  blockRead: number;
  blockWrite: number;
}

export interface DockerIoTotals {
  atMs: number;
  netIn: number;
  netOut: number;
  blockRead: number;
  blockWrite: number;
}

export function ioTotalsOf(stat: DockerStat, atMs: number): DockerIoTotals {
  return {
    atMs,
    netIn: stat.netInBytes,
    netOut: stat.netOutBytes,
    blockRead: stat.blockReadBytes,
    blockWrite: stat.blockWriteBytes,
  };
}

/**
 * 두 누적 표본으로 초당 값을 낸다. 첫 표본이거나 시간이 안 흘렀으면 null — 화면은 그때
 * "재는 중" 으로 둔다.
 *
 * 컨테이너가 다시 뜨면 누적이 0 으로 돌아간다. 그때 음수가 나오는데 0 으로 눌러 둔다(다음
 * 표본부터 정상값이 나온다).
 */
export function computeIoRate(
  previous: DockerIoTotals | undefined,
  current: DockerIoTotals,
): DockerIoRate | null {
  if (!previous) {
    return null;
  }
  const elapsedSeconds = (current.atMs - previous.atMs) / 1000;
  if (elapsedSeconds <= 0) {
    return null;
  }
  const perSecond = (now: number, then: number) =>
    now >= then ? (now - then) / elapsedSeconds : 0;
  return {
    netIn: perSecond(current.netIn, previous.netIn),
    netOut: perSecond(current.netOut, previous.netOut),
    blockRead: perSecond(current.blockRead, previous.blockRead),
    blockWrite: perSecond(current.blockWrite, previous.blockWrite),
  };
}

export interface DockerPortEntry {
  /** 컨테이너 쪽 포트. */
  containerPort: number;
  protocol: string;
  /** 호스트에 공개된 포트. 공개되지 않았으면 null. */
  publishedPort: number | null;
}

/**
 * 행에 보여 줄 포트 목록. `ps` 의 공개 매핑과 `inspect` 의 노출 포트를 합친다.
 *
 * 둘 다 필요한 이유: 공개된 포트만 보여 주면 "컨테이너 안에서만 열린 포트" 를 열 수 없고,
 * 노출 포트만 보여 주면 어느 것이 이미 호스트에 열려 있는지 알 수 없다.
 */
export function resolveContainerPorts(
  container: DockerContainer,
  info: DockerInspectInfo | undefined,
): DockerPortEntry[] {
  const entries = new Map<string, DockerPortEntry>();
  for (const part of container.ports.split(',')) {
    const match = /(?::(\d+))?->(\d+)\/(\w+)/.exec(part.trim());
    if (!match) {
      continue;
    }
    const containerPort = Number(match[2]);
    const key = `${containerPort}/${match[3]}`;
    const published = match[1] ? Number(match[1]) : null;
    const existing = entries.get(key);
    // 같은 포트가 IPv4·IPv6 두 줄로 오므로 먼저 온 공개 포트를 지킨다.
    if (!existing || (existing.publishedPort === null && published !== null)) {
      entries.set(key, { containerPort, protocol: match[3], publishedPort: published });
    }
  }
  for (const exposed of info?.exposedPorts ?? []) {
    const [portText, protocol = 'tcp'] = exposed.split('/');
    const containerPort = Number(portText);
    if (!Number.isFinite(containerPort)) {
      continue;
    }
    const key = `${containerPort}/${protocol}`;
    if (!entries.has(key)) {
      entries.set(key, { containerPort, protocol, publishedPort: null });
    }
  }
  return [...entries.values()].sort(
    (left, right) => left.containerPort - right.containerPort,
  );
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
  /**
   * 누적 바이트. `docker stats` 의 NET·BLOCK I/O 는 **컨테이너가 뜬 뒤로 쌓인 총량**이라 그대로
   * 보여 주면 "지금 얼마나 흐르는지" 로 잘못 읽힌다. 두 표본의 차로 초당 값을 낸다.
   */
  netInBytes: number;
  netOutBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}

export interface DockerInspectInfo {
  id: string;
  restartCount: number;
  health: 'healthy' | 'unhealthy' | 'starting' | null;
  oomKilled: boolean;
  /** 컨테이너가 여는 포트("80/tcp"). 공개 여부와 무관하다. */
  exposedPorts: string[];
}

const STATS_FIELDS =
  '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}';

// Health 는 헬스체크가 없으면 nil 이라 `{{if}}` 로 감싸야 템플릿이 죽지 않는다.
// 마지막 칸은 컨테이너가 여는 포트다 — `ps` 는 **호스트에 공개된 것만** 준다. 공개되지 않은
// 포트도 컨테이너 네트워크로는 열 수 있어야 하므로 여기서 함께 받는다.
const INSPECT_FIELDS =
  '{{.Id}}\t{{.RestartCount}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}' +
  '\t{{.State.OOMKilled}}\t{{range $port, $unused := .Config.ExposedPorts}}{{$port}} {{end}}';

/**
 * 지표(+ 검사)를 받는다. **목록과 다른 왕복이다.**
 *
 * `stats --no-stream` 은 데몬이 CPU 차분을 내려고 컬렉터 틱을 두 번 기다린다 — 컨테이너가
 * 하나여도 1~2초가 바닥값이고 많으면 더 걸린다. `ps -a` 는 그 100분의 1이다. 둘을 한 왕복에
 * 묶으면 이름 몇 줄을 그리는 데 stats 시간을 통째로 기다리게 된다(그래서 갈랐다). 목록이 먼저
 * 그려지고 CPU·MEM 은 이 왕복이 오는 대로 채워진다.
 *
 * 검사 대상은 **방금 받은 목록의 id** 다 — 여기서 `ps -aq` 를 다시 부르지 않는다(같은 것을
 * 묻는 데몬 왕복이 하나 준다). id 가 없으면 검사를 아예 빼는데, 인자 없는 `inspect` 는 실패하기
 * 때문이기도 하다.
 */
export function buildContainerMetricsCommand(
  prefix: string,
  options: { stats: boolean; inspectIds: readonly string[] },
): string {
  const parts: string[] = [];
  if (options.stats) {
    parts.push(`${prefix} stats --no-stream --format '${STATS_FIELDS}'`);
  }
  // 구분자는 stats 를 빼도 넣는다 — 파서가 늘 같은 자리에서 가른다.
  parts.push(`echo ${LIST_SEPARATOR}`);
  if (options.inspectIds.length > 0) {
    const ids = options.inspectIds.map(quoteShellArg).join(' ');
    // 그 사이에 지워진 컨테이너가 있으면 그것만 stderr 로 빠지고 나머지는 그대로 온다.
    parts.push(`${prefix} inspect ${ids} --format '${INSPECT_FIELDS}' 2>/dev/null`);
  }
  return AUX_PATH_EXPORT + parts.join('; ');
}

export interface DockerMetrics {
  /** 짧은 ID → 지표. stats 를 붙이지 않았거나 실패하면 빈 Map. */
  stats: Map<string, DockerStat>;
  /** 짧은 ID → 검사 결과. */
  inspect: Map<string, DockerInspectInfo>;
}

export function parseContainerMetrics(stdout: string): DockerMetrics {
  const [statsPart = '', inspectPart = ''] = stdout.split(LIST_SEPARATOR);
  return {
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
      netInBytes: parseBinarySize(netIn),
      netOutBytes: parseBinarySize(netOut),
      blockReadBytes: parseBinarySize(blockRead),
      blockWriteBytes: parseBinarySize(blockWrite),
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
    const [id, restarts, health, oom, exposed] = line.split('\t');
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
      exposedPorts: (exposed ?? '').trim().split(/\s+/).filter(Boolean),
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

const LIST_SEPARATOR = '@@dolgate@@';

/**
 * 이미지 목록. `docker images` 한 번이 전부다.
 *
 * **`docker system df` 는 쓰지 않는다.** 디스크 총량·회수 가능량을 정확히 내주지만 레이어를
 * 전부 걷느라 이미지가 많은 호스트에서 수십 초가 걸리고, 그동안 보조 채널을 혼자 물고 있어
 * 컨테이너 목록·지표까지 함께 멈춘다. 여기서 필요한 것은 "무엇이 있고 대략 얼마나 큰가" 이고,
 * 그건 이 한 줄로 충분하다. 볼륨 크기(`system df -v`)를 뺀 것도 같은 이유다.
 */
export function buildImageListCommand(prefix: string): string {
  return `${AUX_PATH_EXPORT}${prefix} images --format '{{.Repository}}\\t{{.Tag}}\\t{{.ID}}\\t{{.Size}}' | head -n ${DOCKER_ROW_LIMIT + 1}`;
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
  truncated: boolean;
}

export function parseImageList(stdout: string): DockerImageList {
  const images: DockerImage[] = [];
  let seen = 0;
  for (const line of stdout.split('\n')) {
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
  // 큰 것부터. 이미지 목록을 여는 이유는 거의 늘 디스크다.
  images.sort((left, right) => right.sizeBytes - left.sizeBytes);
  return { images, truncated: seen > DOCKER_ROW_LIMIT };
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

export interface DockerNetwork {
  name: string;
  driver: string;
  subnet: string | null;
  containerCount: number;
}

/**
 * 이름·드라이버·서브넷·붙은 컨테이너 수를 한 왕복에. `network ls` 만으로는 서브넷을 알 수 없어
 * `inspect` 를 쓰지만, 네트워크마다 부르면 왕복이 여러 번이 되므로 id 를 한꺼번에 넘긴다.
 *
 * **구분자는 진짜 탭이어야 한다(`\t`, 백슬래시-t 두 글자가 아니라).** docker 의 `--format` 은
 * 두 세계다 — `ps`·`images`·`volume ls` 같은 목록 명령은 CLI 가 포맷 문자열의 `\t` 를 탭으로
 * 치환해 주지만, `inspect` 계열은 Go 템플릿을 그대로 파싱해 아무것도 치환하지 않는다. 여기에
 * 백슬래시-t 를 넣으면 출력에 탭이 없고, 파서가 탭 없는 줄을 전부 버려 네트워크가 **어느
 * 호스트에서든** 빈 목록으로 보였다. 컨테이너 검사(INSPECT_FIELDS)가 멀쩡했던 것은 그쪽이
 * 처음부터 진짜 탭을 쓰고 있어서다.
 *
 * 네트워크가 하나도 없으면 `network inspect` 는 인자 없이 불려 실패한다 — 먼저 id 를 세어 본다.
 */
export function buildNetworkListCommand(prefix: string): string {
  const format =
    '{{.Name}}\t{{.Driver}}\t{{range .IPAM.Config}}{{.Subnet}} {{end}}\t{{len .Containers}}';
  return (
    AUX_PATH_EXPORT +
    `ids=$(${prefix} network ls -q); [ -n "$ids" ] && ` +
    `${prefix} network inspect $ids --format '${format}' | head -n ${DOCKER_ROW_LIMIT + 1}`
  );
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
 * 정해진 호출 방법에 맞춰 compose 를 부르는 방법을 만든다.
 *
 * 접두사는 도커를 부르는 방법 그대로다 — `sudo docker` 로 풀린 호스트면 compose 도 `sudo docker
 * compose` 여야 한다. v1 은 별도 실행 파일이라 마지막 낱말만 갈아 끼운다(`sudo docker` →
 * `sudo docker-compose`).
 */
export function composeCommandFor(
  prefix: string | null,
  kind: DockerComposeKind,
): string | null {
  if (!prefix || !kind) {
    return null;
  }
  if (kind === 'v2') {
    return `${prefix} compose`;
  }
  const parts = prefix.split(' ');
  parts[parts.length - 1] = 'docker-compose';
  return parts.join(' ');
}

/**
 * 스택 단위 compose 명령.
 *
 * **프로젝트 디렉터리로 들어가서 부른다.** `--project-directory` 는 compose 파일을 찾아 주지
 * 않는다 — v1·v2 모두 설정 파일은 **현재 디렉터리**(또는 `-f`)에서 찾는다. 그래서 그것만
 * 넘기면 `no configuration file provided: not found` 가 난다(실제로 그렇게 났다).
 *
 * 괄호로 감싸 서브셸에서 `cd` 한다 — 사용자가 보고 있는 셸의 현재 위치를 바꾸지 않는다.
 * 그 디렉터리의 `.env` 도 그때 함께 읽히므로 변수 치환이 up 할 때와 같아진다.
 *
 * 이름은 `-p` 로 명시한다. 디렉터리 이름에서 유추한 이름은 up 할 때 쓴 이름과 다를 수 있다
 * (`/data/compose/11` 처럼 번호로 된 디렉터리가 그렇다).
 */
export function stackComposeCommand(
  composeCommand: string,
  stack: { project: string | null; workingDir: string | null },
  args: string,
): string {
  const name = stack.project ? ` -p ${quoteShellArg(stack.project)}` : '';
  const command = `${composeCommand}${name} ${args}`;
  return stack.workingDir
    ? `(cd ${quoteShellArg(stack.workingDir)} && ${command})`
    : command;
}
