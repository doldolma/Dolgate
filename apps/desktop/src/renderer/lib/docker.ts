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

/**
 * 출력에 줄 수 상한을 걸되 **원래 명령의 종료 코드를 지킨다.**
 *
 * `docker ps … | head -n 201` 의 `$?` 는 **head 의 것**이다 — 도커가 템플릿 오류로 죽어도 0 이
 * 온다. 보조 채널은 그 코드로 "실패했다" 와 "찍을 것이 없었다" 를 가르므로, 파이프가 상태를
 * 삼키면 실패가 다시 "없습니다" 로 보인다(고치려던 그 결함이다). POSIX sh 에는 `pipefail` 이
 * 없으니(dash·busybox ash) 출력을 변수로 받아 상태를 되돌린다.
 *
 * 마지막 `exit` 는 워커가 명령을 `( )` 로 감싸므로 그 서브셸만 빠져나온다.
 *
 * 대가는 있다: 파이프로 흘리던 것을 변수에 받으므로 원격 셸이 출력을 통째로 들고 있게 되고,
 * `head` 가 파이프를 닫아 명령을 일찍 끊지도 못한다(컨테이너 수천 개인 호스트에서 메가바이트
 * 단위다). 전선으로 나가는 양은 그대로다. **파이프로 되돌리지 말 것** — 그러면 상태가 다시
 * 사라진다.
 */
function limitRows(command: string, rows: number = DOCKER_ROW_LIMIT + 1): string {
  return `out=$(${command}); rc=$?; ${emitRows('out', rows)}; exit $rc`;
}

/** 받아 둔 변수를 상한까지만 흘려보낸다. 상태는 부르는 쪽이 `exit` 로 지킨다. */
function emitRows(variable: string, rows: number = DOCKER_ROW_LIMIT + 1): string {
  return `printf '%s\\n' "$${variable}" | head -n ${rows}`;
}

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
      // 도커냐 포드맨이냐. **이름으로 가르면 안 된다** — RHEL 계열의 `podman-docker` 패키지가
      // `/usr/bin/docker` 를 포드맨 래퍼로 깐다(그러면 접두사는 docker 인데 알맹이는 포드맨이다).
      // `--version` 은 데몬에 접속하지 않아 즉답이고, 이미 도는 이 왕복 안에서 끝난다.
      '[ -n "$p" ] && echo "kind=$($p --version 2>/dev/null | head -n 1)"',
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

/**
 * 어느 런타임인가. `inspect` 형식이 방언마다 달라서 꼭 알아야 한다 — 도커는 원본 JSON 맵으로,
 * 포드맨은 구조체로 템플릿을 돌린다(INSPECT_FORMATS 주석 참고).
 *
 * 모르면 'docker' 다. 대다수가 도커이고, 틀렸을 때 잃는 것도 그쪽이 더 작다(포드맨에서 검사가
 * 안 오는 것은 지금까지의 동작 그대로다).
 */
export type DockerDialect = 'docker' | 'podman';

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
  /** 도커 방언인가 포드맨 방언인가. `--version` 이 스스로 밝힌 이름으로 가른다. */
  dialect: DockerDialect;
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
  let dialect: DockerDialect = 'docker';
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
    } else if (text.startsWith('kind=')) {
      answered = true;
      // "podman version 5.4.0" · "Docker version 27.3.1, build ..." — 스스로 밝힌 이름을 믿는다.
      dialect = /podman/i.test(text) ? 'podman' : 'docker';
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
    dialect,
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

/**
 * `ps` 한 줄에서 받아 오는 칸들.
 *
 * **`{{.State}}` 는 쓰지 않는다 — 20.10 이상에만 있는 필드다.** 도커는 모르는 필드를 만나면 그
 * 칸만 비우는 게 아니라 템플릿 실행을 통째로 접는다: stdout 이 빈 채로 exit 1 이고 사연은
 * stderr 로만 나가는데, 보조 채널은 stderr 를 버린다(completion_worker.go). 그래서 19.03 호스트
 * 에서 컨테이너 탭이 오류 한 줄 없이 "없습니다" 로 굳었다 — 이미지·네트워크는 옛 필드만 써서
 * 멀쩡했으니 도커가 안 읽히는 것처럼 보이지도 않았다. `.Status` 는 1.x 부터 있고 첫 낱말이
 * 상태를 그대로 말해 주므로 그것 하나로 낸다(toContainerState).
 */
const CONTAINER_FIELDS = [
  '{{.ID}}',
  '{{.Names}}',
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
  return AUX_PATH_EXPORT + limitRows(`${prefix} ps -a --format '${CONTAINER_FIELDS}'`);
}

/**
 * 상태 문장으로 상태를 가른다("Up 22 hours (healthy)" → running).
 *
 * 왜 `.State` 를 안 받는지는 CONTAINER_FIELDS 주석에 있다. 포드맨도 도커를 흉내 내 같은 문장을
 * 내지만(`Up …`·`Exited (0) …`), **멈춤만 적는 자리가 다르다** — 도커는 "Up 5 minutes (Paused)"
 * 로 달고 포드맨은 "Paused" 한 낱말로 낸다. 그래서 멈춤은 첫 낱말이 아니라 문장 전체에서 본다.
 */
function toContainerState(status: string): DockerContainerState {
  const text = status.trim().toLowerCase();
  if (text.includes('paused')) {
    return 'paused';
  }
  if (text.startsWith('up')) {
    return 'running';
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
    const [id, name, status, image, ports, project, service, workingDir] = parts;
    if (!id || !name) {
      continue;
    }
    containers.push({
      id: id.trim(),
      name: name.trim(),
      state: toContainerState(status ?? ''),
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
/**
 * 한 컨테이너가 목록에 올릴 포트 상한. 범위 게시(`-p 3000-3100:3000-3100`)는 줄이 수백 개가 될
 * 수 있어 앞에서 끊는다 — 그 이상은 터미널에서 볼 일이다.
 */
export const MAX_PORT_ENTRIES = 24;

/** `3000` 또는 `3000-3002` 를 포트 배열로. 범위는 상한까지만 편다. */
function expandPortRange(text: string, limit: number): number[] {
  const [fromText, toText] = text.split('-');
  const from = Number(fromText);
  if (!Number.isFinite(from)) {
    return [];
  }
  const to = toText === undefined ? from : Number(toText);
  if (!Number.isFinite(to) || to < from) {
    return [from];
  }
  const ports: number[] = [];
  for (let port = from; port <= to && ports.length < limit; port += 1) {
    ports.push(port);
  }
  return ports;
}

/**
 * 행에 보여 줄 포트 목록. `ps` 의 공개 매핑과 `inspect` 의 노출 포트를 합친다.
 *
 * 둘 다 필요한 이유: 공개된 포트만 보여 주면 "컨테이너 안에서만 열린 포트" 를 열 수 없고,
 * 노출 포트만 보여 주면 어느 것이 이미 호스트에 열려 있는지 알 수 없다.
 *
 * `ps` 의 포트 칸은 세 가지 모양으로 온다. 셋 다 읽는다 — 예전에는 첫 줄만 읽어서 **범위로 게시한
 * 컨테이너는 포트가 하나도 안 보였다.**
 *   `0.0.0.0:5050->5050/tcp`            공개된 하나
 *   `0.0.0.0:3000-3002->3000-3002/tcp`  범위로 공개
 *   `8080/tcp`                          공개되지 않은 노출 포트
 */
export interface DockerPortList {
  entries: DockerPortEntry[];
  /** 상한을 넘어 빼놓은 포트 수. 0 이 아니면 화면이 그렇게 말한다(조용히 자르지 않는다). */
  omitted: number;
}

export function resolveContainerPorts(
  container: DockerContainer,
  info: DockerInspectInfo | undefined,
): DockerPortList {
  const entries = new Map<string, DockerPortEntry>();
  const put = (containerPort: number, protocol: string, publishedPort: number | null) => {
    const key = `${containerPort}/${protocol}`;
    const existing = entries.get(key);
    // 같은 포트가 IPv4·IPv6 두 줄로 오므로 먼저 온 공개 포트를 지킨다.
    if (!existing || (existing.publishedPort === null && publishedPort !== null)) {
      entries.set(key, { containerPort, protocol, publishedPort });
    }
  };
  for (const part of container.ports.split(',')) {
    const mapped = /^(?:.*?:)?([\d-]+)->([\d-]+)\/(\w+)$/.exec(part.trim());
    if (mapped) {
      const hostPorts = expandPortRange(mapped[1], MAX_PORT_ENTRIES);
      const containerPorts = expandPortRange(mapped[2], MAX_PORT_ENTRIES);
      containerPorts.forEach((containerPort, index) => {
        // 범위는 앞에서부터 짝이 맞는다(3000-3002 → 3000-3002). 짝이 없으면 공개된 것으로
        // 보지 않는다 — 첫 포트로 돌려 쓰면 "3001 이 8000 에 열려 있다" 는 거짓이 된다.
        put(containerPort, mapped[3], hostPorts[index] ?? null);
      });
      continue;
    }
    // 공개되지 않은 노출 포트도 `ps` 가 준다(`8080/tcp`).
    const exposed = /^([\d-]+)\/(\w+)$/.exec(part.trim());
    if (exposed) {
      for (const containerPort of expandPortRange(exposed[1], MAX_PORT_ENTRIES)) {
        put(containerPort, exposed[2], null);
      }
    }
  }
  for (const exposed of info?.exposedPorts ?? []) {
    const [portText, protocol = 'tcp'] = exposed.split('/');
    for (const containerPort of expandPortRange(portText, MAX_PORT_ENTRIES)) {
      put(containerPort, protocol, null);
    }
  }
  const sorted = [...entries.values()].sort(
    (left, right) => left.containerPort - right.containerPort,
  );
  return {
    entries: sorted.slice(0, MAX_PORT_ENTRIES),
    omitted: Math.max(0, sorted.length - MAX_PORT_ENTRIES),
  };
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
  /** 붙어 있는 네트워크. 터널이 어디로 갈지 정하는 근거다(host 네트워킹은 IP 가 빈다). */
  networks: DockerContainerNetwork[];
}

/** 컨테이너가 붙은 네트워크 한 줄. */
export interface DockerContainerNetwork {
  name: string;
  ipAddress: string;
}

const STATS_FIELDS =
  '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}';

// **선택 키는 `index` 로 읽는다.** docker 는 `{{.Id}}`(구조체 필드명은 `ID` 다)를 만나면 구조체
// 렌더링을 포기하고 원본 JSON 맵으로 물러나는데, 맵 모드는 `missingkey=error` 라서 없는 키를
// 만지는 순간 그 줄이 통째로 사라진다(여러 id 를 넘기면 그 줄만 조용히 빠진다). `.State.Health` 는
// 헬스체크가 없는 컨테이너에 아예 없는 키라 `{{if}}` 로 감싸도 소용없다 — 검사가 아니라 접근이
// 오류다. 그래서 헬스체크 없는 컨테이너에서 재시작·헬스·OOM·노출 포트가 전부 오지 않았다.
// `index` 는 없는 키에 빈 값을 준다.
// 마지막 칸은 컨테이너가 여는 포트다 — `ps` 는 **호스트에 공개된 것만** 준다. 공개되지 않은
// 포트도 컨테이너 네트워크로는 열 수 있어야 하므로 여기서 함께 받는다(host 네트워킹 컨테이너는
// `ps` 가 포트를 아예 주지 않아 이것이 유일한 출처다).
//
// **포드맨에는 그 맵 모드가 없다.** 포드맨은 `define.InspectContainerData` **구조체**를 그대로
// 템플릿에 넣으므로(`{{.Id}}` 도 `{{.ID}}` 로 고쳐 준다) `index .` 이 "can't index item of type
// …" 로 죽는다 — 검사 왕복이 통째로 빈다. 그래서 방언마다 한 벌씩 둔다. 두 형식은 **같은 6칸**을
// 내므로 파서는 하나로 충분하다.
/**
 * 네트워크 이름=IP 칸.
 *
 * 검사(INSPECT_FORMATS)와 "이 컨테이너의 네트워크만" 조회(buildContainerNetworksCommand)가 같은
 * 조각을 쓴다 — 두 벌로 두었더니 방언을 한쪽에만 넣고 다른 쪽을 잊기 딱 좋았다.
 */
const NETWORK_FRAGMENTS: Record<DockerDialect, string> = {
  // 도커: 맵 모드다. **`$net.IPAddress` 로 읽으면 안 된다** — 구조체 모드에서 host 네트워킹의
  // 빈 IP 가 `invalid IP` 라는 글자로 찍힌다(실제로 그렇게 나왔다). `index` 는 빈 문자열을 준다.
  docker:
    '{{range $name, $net := index .NetworkSettings "Networks"}}{{$name}}={{index $net "IPAddress"}};{{end}}',
  // 포드맨: 구조체다. `NetworkSettings` 가 포인터라 `with` 로 감싸지 않으면 nil 에서 죽는다.
  // `IPAddress` 는 여기선 그냥 string 이라 도커에서 피했던 문제가 없다.
  podman:
    '{{with .NetworkSettings}}{{range $name, $net := .Networks}}{{$name}}={{$net.IPAddress}};{{end}}{{end}}',
};

const INSPECT_FORMATS: Record<DockerDialect, string> = {
  docker:
    '{{.Id}}\t{{index . "RestartCount"}}\t{{with index .State "Health"}}{{index . "Status"}}{{end}}' +
    '\t{{index .State "OOMKilled"}}' +
    '\t{{range $port, $unused := index .Config "ExposedPorts"}}{{$port}} {{end}}' +
    // 네트워크도 여기서 함께 받는다 — 터널을 열 때 컨테이너 IP 를 다시 물으러 가지 않게.
    '\t' + NETWORK_FRAGMENTS.docker,
  // 포드맨은 구조체라 필드를 그대로 읽는다. **`with` 로 감싸는 것이 여기서는 통한다** — 맵 모드와
  // 달리 필드는 늘 존재하고 값만 nil 이기 때문이다(`State`·`Config`·`NetworkSettings` 가 전부
  // 포인터라 감싸지 않으면 nil 에서 죽는다). `IPAddress` 는 포드맨에서 그냥 string 이라 도커에서
  // 피했던 `invalid IP` 문제가 없다.
  podman:
    '{{.ID}}\t{{.RestartCount}}\t{{with .State}}{{with .Health}}{{.Status}}{{end}}{{end}}' +
    '\t{{with .State}}{{.OOMKilled}}{{end}}' +
    '\t{{with .Config}}{{range $port, $unused := .ExposedPorts}}{{$port}} {{end}}{{end}}' +
    '\t' + NETWORK_FRAGMENTS.podman,
};

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
  options: { stats: boolean; inspectIds: readonly string[]; dialect?: DockerDialect },
): string {
  const parts: string[] = ['rc=0'];
  if (options.stats) {
    // 상태는 **stats 것만** 본다. 지표를 못 주는 호스트를 알아보는 신호가 그것이고, 아래 검사는
    // 그 사이 지워진 컨테이너 하나로도 0 이 아닌 코드를 내기 때문이다(그건 실패가 아니다).
    parts.push(`stats=$(${prefix} stats --no-stream --format '${STATS_FIELDS}'); rc=$?`);
    parts.push(`printf '%s\\n' "$stats"`);
  }
  // 구분자는 stats 를 빼도 넣는다 — 파서가 늘 같은 자리에서 가른다.
  parts.push(`echo ${LIST_SEPARATOR}`);
  if (options.inspectIds.length > 0) {
    const ids = options.inspectIds.map(quoteShellArg).join(' ');
    // 그 사이에 지워진 컨테이너가 있으면 그것만 stderr 로 빠지고 나머지는 그대로 온다. 그 한
    // 줄 때문에 왕복 전체가 실패로 읽히지 않게 상태를 삼킨다(`|| :`).
    const format = INSPECT_FORMATS[options.dialect ?? 'docker'];
    parts.push(`${prefix} inspect ${ids} --format '${format}' 2>/dev/null || :`);
  }
  parts.push('exit $rc');
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

/**
 * `name=ip;` 로 온 네트워크 목록을 가른다. host 네트워킹이면 IP 가 빈 채로 이름만 온다 —
 * **그 빈 값이 정보다**(그 컨테이너는 호스트의 네트워크를 그대로 쓴다).
 */
export function parseContainerNetworks(text: string): DockerContainerNetwork[] {
  const networks: DockerContainerNetwork[] = [];
  for (const part of text.split(';')) {
    const entry = part.trim();
    if (!entry) {
      continue;
    }
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    networks.push({
      name: entry.slice(0, separator),
      ipAddress: entry.slice(separator + 1).trim(),
    });
  }
  return networks;
}

/**
 * 한 컨테이너의 네트워크만 묻는다. 검사 결과가 아직 없을 때(방금 만든 컨테이너의 공개 포트는
 * `ps` 가 먼저 준다) 터널을 열기 직전에 한 번 쓰는 길이다.
 */
export function buildContainerNetworksCommand(
  prefix: string,
  containerId: string,
  dialect: DockerDialect = 'docker',
): string {
  const format = NETWORK_FRAGMENTS[dialect];
  return (
    AUX_PATH_EXPORT +
    `${prefix} inspect ${quoteShellArg(containerId)} --format ${quoteShellArg(format)} 2>/dev/null`
  );
}

export function parseInspect(stdout: string): Map<string, DockerInspectInfo> {
  const info = new Map<string, DockerInspectInfo>();
  for (const line of stdout.split('\n')) {
    if (!line.includes('\t')) {
      continue;
    }
    const [id, restarts, health, oom, exposed, networks] = line.split('\t');
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
      networks: parseContainerNetworks(networks ?? ''),
      exposedPorts: (exposed ?? '').trim().split(/\s+/).filter(Boolean),
    });
  }
  return info;
}

/** 검사(inspect)를 몇 틱마다 전부 훑는가. */
export const INSPECT_EVERY_TICKS = 4;

/**
 * 이번 틱에 검사할 컨테이너 id. 전체는 `INSPECT_EVERY_TICKS` 마다 훑되 **아직 한 번도 못 본
 * 컨테이너는 매 틱 물어본다** — 방금 만든 컨테이너의 포트·헬스·재시작이 다음 훑기까지(느린
 * 호스트면 몇 분) 비어 있으면 안 된다. host 네트워킹 컨테이너는 검사가 포트의 유일한 출처다.
 */
export function inspectTargets(
  tick: number,
  ids: readonly string[],
  known: ReadonlyMap<string, DockerInspectInfo>,
): string[] {
  if (tick % INSPECT_EVERY_TICKS === 0) {
    return [...ids];
  }
  return ids.filter((id) => !known.has(id));
}

/**
 * 온 검사 결과를 이전 값에 덮는다. **부분 검사가 나머지를 지우지 않게** 합치고, 목록에서 사라진
 * 컨테이너는 버린다.
 */
export function mergeInspectInfo(
  previous: ReadonlyMap<string, DockerInspectInfo>,
  incoming: ReadonlyMap<string, DockerInspectInfo>,
  liveIds: readonly string[],
): Map<string, DockerInspectInfo> {
  const live = new Set(liveIds);
  const merged = new Map<string, DockerInspectInfo>();
  for (const [id, info] of previous) {
    if (live.has(id)) {
      merged.set(id, info);
    }
  }
  for (const [id, info] of incoming) {
    merged.set(id, info);
  }
  return merged;
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
  return (
    AUX_PATH_EXPORT +
    limitRows(`${prefix} images --format '{{.Repository}}\\t{{.Tag}}\\t{{.ID}}\\t{{.Size}}'`)
  );
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

/**
 * 볼륨 목록과 "누가 쓰는지" 를 한 왕복에. 마운트는 컨테이너 쪽에서만 알 수 있다.
 *
 * **두 조각 중 하나라도 실패하면 실패다.** 예전에는 마지막 명령의 상태만 남아, `volume ls` 가
 * 죽어도 0 으로 끝나 빈 목록이 "볼륨이 없습니다" 로 보였다. 사용 수만 못 받은 경우도 마찬가지다
 * — 0 개라고 적느니 못 읽었다고 말하는 편이 맞다.
 */
export function buildVolumeListCommand(prefix: string): string {
  return (
    AUX_PATH_EXPORT +
    [
      `list=$(${prefix} volume ls --format '{{.Name}}\\t{{.Driver}}'); rc=$?`,
      `mounts=$(${prefix} ps -a --format '{{.Mounts}}'); mrc=$?`,
      // 먼저 난 실패를 남긴다 — `[ ]` 의 상태가 `$?` 를 덮지 않게 미리 받아 둔다.
      '[ "$rc" -eq 0 ] && rc=$mrc',
      emitRows('list'),
      `echo ${LIST_SEPARATOR}`,
      `printf '%s\\n' "$mounts"`,
      'exit $rc',
    ].join('; ')
  );
}

const ANONYMOUS_VOLUME = /^[0-9a-f]{32,}$/;

export function parseVolumeList(stdout: string): { volumes: DockerVolume[]; truncated: boolean } {
  const [listPart = '', mountsPart = ''] = stdout.split(LIST_SEPARATOR);
  const usage = new Map<string, number>();
  for (const line of mountsPart.split('\n')) {
    // 도커는 `a,b` 로 주는데 **포드맨은 `[a b]` 로 준다** — 포드맨의 `ps` 에는 Mounts 를 꾸미는
    // 메서드가 없어서 `[]string` 필드가 Go 의 슬라이스 표기 그대로 찍힌다. 쉼표로만 가르면 그
    // 줄이 통째로 이름 하나가 되어, 포드맨 호스트에서는 "이 볼륨을 쓰는 컨테이너" 가 늘 0 이었다.
    //
    // 대괄호를 벗기고 쉼표·공백 둘 다로 가른다. 볼륨 이름에는 공백이 못 들어가므로(도커·포드맨
    // 모두 `[a-zA-Z0-9][a-zA-Z0-9_.-]*`) 안전하고, 슬라이스를 그대로 찍는 다른 런타임도 같이
    // 살아난다. 섞여 오는 bind mount 경로는 지금처럼 무해하다 — 볼륨 이름과 맞지 않을 뿐이다.
    for (const mount of line.replace(/^\s*\[|\]\s*$/g, '').split(/[,\s]+/)) {
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
  /** 붙어 있는 컨테이너 수. **포드맨은 알려 주지 않으므로 null** — 0 으로 적으면 거짓말이 된다. */
  containerCount: number | null;
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
/**
 * 도커와 포드맨은 `network inspect` 가 **서로 다른 타입**을 낸다 — 하나의 형식으로는 안 된다.
 *
 * 도커는 `types.NetworkResource`(`IPAM.Config`·`Containers`), 포드맨은 `types.Network`
 * (`Subnets`, 붙은 컨테이너는 아예 없음)다. 도커 형식을 포드맨에 돌리면 템플릿이 죽어 stdout 이
 * 비고, 그러면 네트워크 탭이 통째로 "없습니다" 가 된다(컨테이너 목록의 `{{.State}}` 와 같은
 * 결함이었다).
 *
 * **되는 것을 위에서부터 고르되, 실패한 시도의 출력은 버린다.** 템플릿은 줄 중간에 죽으므로
 * (`podman<TAB>bridge<TAB>` 까지 찍고 오류) 그대로 이으면 그 조각이 다음 시도의 첫 줄에 붙는다.
 * 변수로 받아 **성공한 쪽만** 흘려보내는 이유다.
 */
const NETWORK_FORMATS = {
  docker: '{{.Name}}\t{{.Driver}}\t{{range .IPAM.Config}}{{.Subnet}} {{end}}\t{{len .Containers}}',
  // 칸 수는 맞춰야 한다 — 마지막 탭이 없으면 파서가 컨테이너 수 칸을 아예 못 본다.
  podman: '{{.Name}}\t{{.Driver}}\t{{range .Subnets}}{{.Subnet}} {{end}}\t',
} as const;

export function buildNetworkListCommand(prefix: string): string {
  // 첫 시도의 오류는 **버린다** — 포드맨에서 실패하는 것이 정상이라 그 문장은 사연이 아니라
  // 소음이다. 두 번째 시도의 것은 남긴다: 둘 다 실패했다는 것은 우리가 모르는 런타임이라는
  // 뜻이고, 그때 화면에 보여 줄 단서가 그 한 줄뿐이다(예전에는 그것도 버려서 이유 없는
  // 실패가 됐다).
  const attempt = (format: string, keepStderr = false) =>
    `$(${prefix} network inspect $ids --format '${format}'${keepStderr ? '' : ' 2>/dev/null'})`;
  return (
    AUX_PATH_EXPORT +
    [
      `ids=$(${prefix} network ls -q); rc=$?`,
      // **네트워크가 하나도 없는 것은 실패가 아니다.** `[ -n "$ids" ] &&` 로 끝내면 그런 호스트가
      // 0 이 아닌 상태로 끝나, 정상적인 빈 목록이 "읽을 수 없다" 로 뒤집힌다 — 고치려던 결함의
      // 거울상이다. 그래서 조회를 `if` 안에 두고 상태는 조회한 경우에만 갈아 끼운다.
      'if [ "$rc" -eq 0 ] && [ -n "$ids" ]; then ' +
        `out=${attempt(NETWORK_FORMATS.docker)} || out=${attempt(NETWORK_FORMATS.podman, true)}; rc=$?; ` +
        `${emitRows('out')}; ` +
        'fi',
      'exit $rc',
    ].join('; ')
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
    // 포드맨은 이 칸을 비워 보낸다(붙은 컨테이너를 알려 주지 않는다) — 0 과 구분해서 담는다.
    const countText = (count ?? '').trim();
    const parsedCount = Number(countText);
    networks.push({
      name: name.trim(),
      driver: (driver ?? '').trim(),
      subnet,
      containerCount: countText && Number.isFinite(parsedCount) ? parsedCount : null,
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
