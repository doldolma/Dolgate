import { describe, expect, it } from 'vitest';
import {
  buildContainerListCommand,
  composeCommandFor,
  computeIoRate,
  resolveContainerPorts,
  buildContainerMetricsCommand,
  buildDockerProbeCommand,
  buildImageListCommand,
  buildNetworkListCommand,
  buildVolumeListCommand,
  collectUsedImages,
  dockerLogsCommand,
  dockerRemoveCommand,
  dockerShellCommand,
  dockerStateCommand,
  groupContainersByStack,
  isImageUsed,
  INSPECT_EVERY_TICKS,
  inspectTargets,
  mergeInspectInfo,
  buildContainerNetworksCommand,
  parseContainerNetworks,
  parseContainerList,
  parseContainerMetrics,
  parseDockerAge,
  parseDockerHealth,
  parseDockerProbe,
  parseDockerSize,
  parseExitCode,
  parseImageList,
  parseNetworkList,
  parsePublishedPorts,
  parseVolumeList,
  stackComposeCommand,
  type DockerContainer,
  type DockerInspectInfo,
} from './docker';

// id·이름·상태문장·이미지·포트·프로젝트·서비스·작업디렉터리 순서다(CONTAINER_FIELDS).
function row(fields: Partial<Record<number, string>>): string {
  const cells = Array.from({ length: 8 }, (_, index) => fields[index] ?? '');
  return cells.join('\t');
}

function container(overrides: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: 'abc123',
    name: 'web',
    state: 'running',
    status: 'Up 2 hours',
    image: 'nginx:1.27',
    ports: '',
    project: null,
    service: null,
    workingDir: null,
    ...overrides,
  };
}

describe('프로브', () => {
  it('되는 방법을 위에서부터 고른다', () => {
    const command = buildDockerProbeCommand();
    // 보조 채널은 로그인 셸이 아니다 — PATH 를 넓히지 않으면 snap·/usr/local 의 도커를 못 찾는다.
    expect(command.startsWith('export PATH="$PATH:')).toBe(true);
    expect(command).toContain('/snap/bin');
    // sudo 는 -n 이어야 한다 — 비밀번호를 물어보는 창이 뜨면 "알아서" 가 깨진다.
    expect(command).toContain('"sudo -n docker"');
    expect(command.indexOf('docker')).toBeLessThan(command.indexOf('podman'));
  });

  // 예전에는 첫 후보가 통해도 `why=` 줄이 `docker ps` 를 한 번 더 돌아, 섹션을 여는 첫 왕복이
  // 늘 두 배였다. 이유는 안 될 때만 필요하다.
  it('되는 방법을 찾으면 이유를 묻지 않는다', () => {
    const command = buildDockerProbeCommand();
    expect(command).toContain('[ -n "$p" ] || echo "why=');
    // `docker ps` 는 후보 루프와 실패 경로에만 있다 — 무조건 도는 자리에는 없다.
    expect(command).not.toContain('; echo "why=');
  });

  it('prefix 줄을 읽는다', () => {
    expect(parseDockerProbe('prefix=sudo -n docker\ncompose=v2\nhas=docker\n')).toEqual({
      prefix: 'sudo -n docker',
      compose: 'v2',
      installed: true,
      answered: true,
      dialect: 'docker',
      reason: null,
    });
  });

  it('권한이 없는 것과 데몬이 꺼진 것을 가른다', () => {
    expect(
      parseDockerProbe(
        'has=docker\nwhy=permission denied while trying to connect to the Docker daemon socket',
      ).reason,
    ).toBe('permission');
    expect(
      parseDockerProbe(
        'has=docker\nwhy=Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
      ).reason,
    ).toBe('daemon');
  });

  it('빈 응답은 "도커 없음" 이 아니라 "대답이 없음" 이다', () => {
    // 도커가 없는 호스트도 why= 한 줄은 온다. 아무 줄도 없으면 명령이 제대로 돌지 않은 것이라
    // 단정하면 안 된다 — 그렇게 단정해서 섹션이 "없습니다" 로 굳었다.
    expect(parseDockerProbe('')).toEqual({
      prefix: null,
      compose: null,
      installed: false,
      answered: false,
      dialect: 'docker',
      reason: null,
    });
    // 진짜 없는 호스트: 이유 줄이 온다.
    const absent = parseDockerProbe('why=sh: 1: docker: not found');
    expect(absent.answered).toBe(true);
    expect(absent.installed).toBe(false);
  });

  /**
   * 이름으로 가르면 안 된다 — RHEL 계열의 `podman-docker` 가 `/usr/bin/docker` 를 포드맨
   * 래퍼로 깐다. 스스로 밝힌 `--version` 을 믿는다.
   */
  it('방언은 --version 이 밝힌 이름으로 가른다', () => {
    const command = buildDockerProbeCommand();
    expect(command).toContain('kind=$($p --version');
    // 데몬에 붙지 않는 명령이라 프로브가 느려지지 않는다.
    expect(command).not.toContain('kind=$($p version');
    expect(parseDockerProbe('prefix=docker\nkind=podman version 5.4.0\n').dialect).toBe('podman');
    // 접두사가 podman 이어도 판단 근거는 이름이 아니라 이 줄이다.
    expect(
      parseDockerProbe('prefix=docker\nkind=Docker version 27.3.1, build abc\n').dialect,
    ).toBe('docker');
    // 못 물어봤으면 도커로 본다 — 대다수가 도커이고, 틀려도 지금까지의 동작 그대로다.
    expect(parseDockerProbe('prefix=docker\n').dialect).toBe('docker');
  });

  it('compose 는 v2 가 있으면 v2, 없으면 v1 로 잡힌다', () => {
    expect(parseDockerProbe('compose=v1\ncompose=v2\n').compose).toBe('v2');
    expect(parseDockerProbe('compose=v1\n').compose).toBe('v1');
    // 둘 다 없으면 null 이고, 그러면 화면이 compose 항목을 만들지 않는다.
    expect(parseDockerProbe('prefix=docker\nhas=docker\n').compose).toBeNull();
  });

  it('compose 판정은 소켓 권한과 무관하다 — 그래서 루프 밖에 있다', () => {
    // sudo 가 필요한 호스트에서는 `docker ps` 가 실패해 prefix 줄이 없다. 그래도 compose 는
    // 알아낼 수 있어야 한다(버전 확인은 데몬에 접속하지 않는다).
    const probe = parseDockerProbe('compose=v2\nhas=docker\nwhy=permission denied');
    expect(probe.prefix).toBeNull();
    expect(probe.compose).toBe('v2');
  });

  it('compose 는 도커를 부르는 방법을 그대로 물려받는다', () => {
    expect(composeCommandFor('docker', 'v2')).toBe('docker compose');
    expect(composeCommandFor('sudo docker', 'v2')).toBe('sudo docker compose');
    // v1 은 별도 실행 파일이라 마지막 낱말만 갈아 끼운다.
    expect(composeCommandFor('sudo -n docker', 'v1')).toBe('sudo -n docker-compose');
    expect(composeCommandFor('docker', null)).toBeNull();
    expect(composeCommandFor(null, 'v2')).toBeNull();
  });

  it('프로브가 compose 를 v2 → v1 순서로 물어본다', () => {
    const command = buildDockerProbeCommand();
    expect(command).toContain('compose version');
    expect(command).toContain('docker-compose');
    expect(command.indexOf('$c compose version')).toBeLessThan(
      command.indexOf('docker-compose'),
    );
  });
});

describe('컨테이너 목록', () => {
  it('정지된 것까지 한 번에 받는다', () => {
    const command = buildContainerListCommand('docker');
    expect(command).toContain('ps -a');
    expect(command).toContain('/snap/bin');
    // 스택은 이름 접두사가 아니라 compose 라벨로 묶는다.
    expect(command).toContain('com.docker.compose.project');
  });

  /**
   * `{{.State}}` 는 20.10 에 생긴 필드이고, 도커는 모르는 필드를 만나면 그 칸만 비우는 게 아니라
   * 템플릿을 통째로 접는다 — stdout 이 비고 사연은 stderr 로만 나가는데 보조 채널은 그것을
   * 버린다. 19.03 호스트에서 컨테이너 탭이 오류 없이 "없습니다" 로 굳었던 것이 이 한 칸이었다.
   */
  it('20.10 이상에만 있는 칸을 넣지 않는다', () => {
    expect(buildContainerListCommand('docker')).not.toContain('{{.State}}');
  });

  /**
   * `docker ps … | head` 의 `$?` 는 **head 의 것**이다 — 도커가 죽어도 0 이 온다. 보조 채널은
   * 그 코드로 "실패했다" 와 "찍을 것이 없었다" 를 가르므로, 파이프가 상태를 삼키면 실패가 다시
   * "없습니다" 로 보인다. POSIX sh 에는 pipefail 이 없어 출력을 변수로 받아 되돌린다.
   */
  it('상한을 걸어도 원래 종료 코드가 남는다', () => {
    const command = buildContainerListCommand('docker');
    expect(command).toContain('out=$(');
    expect(command).toContain('rc=$?');
    expect(command.trimEnd().endsWith('exit $rc')).toBe(true);
  });

  it('탭으로 갈라 읽고 라벨이 없으면 null 이 된다', () => {
    const stdout = [
      row({ 0: 'a1', 1: 'gateway', 2: 'Up 22 hours (healthy)', 3: 'app:1', 4: '0.0.0.0:5050->5050/tcp', 5: 'lime', 6: 'gateway', 7: '/srv/lime' }),
      row({ 0: 'b2', 1: 'loose', 2: 'Exited (137) 3 days ago', 3: 'redis:7' }),
      'Cannot connect to the Docker daemon',
    ].join('\n');
    const { containers, truncated } = parseContainerList(stdout);
    expect(truncated).toBe(false);
    expect(containers).toHaveLength(2);
    expect(containers[0]).toMatchObject({
      name: 'gateway',
      state: 'running',
      project: 'lime',
      service: 'gateway',
      workingDir: '/srv/lime',
    });
    expect(containers[1].project).toBeNull();
  });

  it('상태는 상태 문장에서 낸다', () => {
    const states = [
      ['Up 3 minutes', 'running'],
      ['Up 5 hours (Paused)', 'paused'],
      // 포드맨은 멈춤을 "Paused" 한 낱말로 낸다(도커처럼 "Up …" 에 달지 않는다).
      ['Paused', 'paused'],
      ['Restarting (1) 2 seconds ago', 'restarting'],
      ['Created', 'created'],
      ['Dead', 'dead'],
      ['Exited (0) 6 minutes ago', 'exited'],
    ] as const;
    for (const [status, expected] of states) {
      const stdout = row({ 0: 'a1', 1: 'web', 2: status });
      expect(parseContainerList(stdout).containers[0].state).toBe(expected);
    }
  });

  it('한계를 넘으면 잘렸다고 말한다', () => {
    const lines = Array.from({ length: 205 }, (_, index) =>
      row({ 0: `id${index}`, 1: `c${index}`, 2: 'Up 1 hour' }),
    );
    const { containers, truncated } = parseContainerList(lines.join('\n'));
    expect(containers).toHaveLength(200);
    expect(truncated).toBe(true);
  });
});

describe('스택 묶기', () => {
  it('라벨이 같은 것만 한 스택이 된다 — 이름 접두사는 상관없다', () => {
    const stacks = groupContainersByStack([
      container({ id: '1', name: 'api', project: 'lime' }),
      container({ id: '2', name: 'api-gateway', project: 'der' }),
      container({ id: '3', name: 'solo', project: null }),
    ]);
    expect(stacks.map((stack) => stack.project)).toEqual(['der', 'lime', null]);
    expect(stacks[1].containers).toHaveLength(1);
  });

  it('스택 안에서는 돌고 있는 것이 먼저다', () => {
    const stacks = groupContainersByStack([
      container({ id: '1', name: 'b', project: 'p', state: 'exited', status: 'Exited (0)' }),
      container({ id: '2', name: 'a', project: 'p' }),
    ]);
    expect(stacks[0].containers.map((entry) => entry.name)).toEqual(['a', 'b']);
    expect(stacks[0].runningCount).toBe(1);
  });

  it('스택 디렉터리는 라벨이 있는 컨테이너에서 가져온다', () => {
    const stacks = groupContainersByStack([
      container({ id: '1', project: 'p' }),
      container({ id: '2', project: 'p', workingDir: '/srv/p' }),
    ]);
    expect(stacks[0].workingDir).toBe('/srv/p');
  });
});

describe('행에 보이는 값', () => {
  it('호스트 포트만 뽑는다', () => {
    expect(parsePublishedPorts('0.0.0.0:5050->5050/tcp, :::5050->5050/tcp')).toEqual(['5050']);
    expect(parsePublishedPorts('')).toEqual([]);
  });

  it('지난 시간은 숫자와 단위로만 돌려준다(문구는 화면에서 번역)', () => {
    expect(parseDockerAge('Up 22 hours (healthy)')).toEqual({ count: 22, unit: 'hour' });
    expect(parseDockerAge('Exited (0) 3 days ago')).toEqual({ count: 3, unit: 'day' });
    expect(parseDockerAge('Created')).toBeNull();
  });

  it('헬스체크와 종료 코드를 읽는다', () => {
    expect(parseDockerHealth('Up 2 hours (unhealthy)')).toBe('unhealthy');
    expect(parseExitCode('Exited (137) 3 days ago')).toBe(137);
    expect(parseExitCode('Up 2 hours')).toBeNull();
  });
});

describe('이미지', () => {
  //  는 레이어를 전부 걷느라 수십 초가 걸리고 그동안 보조 채널을 혼자
  // 물어 컨테이너 목록까지 멈춰 세웠다. 이미지 탭은  한 번으로 끝낸다.
  it('목록은 images 한 번으로 끝낸다 — system df 를 부르지 않는다', () => {
    expect(buildImageListCommand('docker')).toContain('images --format');
    expect(buildImageListCommand('docker')).not.toContain('system df');
  });

  it('목록을 큰 것부터 놓는다', () => {
    const { images } = parseImageList(
      ['app\t1.0\tsha1\t412MB', '<none>\t<none>\tsha2\t1.1GB'].join('\n'),
    );
    expect(images[0].repository).toBe('<none>');
    expect(images[0].dangling).toBe(true);
  });

  it('컨테이너가 쓰는 이미지는 미사용으로 표시하지 않는다', () => {
    const used = collectUsedImages([container({ image: 'app:1.0' })]);
    const { images } = parseImageList('app\t1.0\tsha1\t412MB\nold\t9\tsha2\t10MB');
    expect(isImageUsed(images[0], used)).toBe(true);
    expect(isImageUsed(images[1], used)).toBe(false);
  });

  it('크기를 바이트로 환산한다', () => {
    expect(parseDockerSize('1.1GB')).toBeGreaterThan(parseDockerSize('900MB'));
    expect(parseDockerSize('알 수 없음')).toBe(0);
  });
});

describe('볼륨 · 네트워크', () => {
  /**
   * 포드맨의 `ps` 에는 Mounts 를 꾸미는 메서드가 없어 `[]string` 이 Go 슬라이스 표기(`[a b]`)로
   * 그대로 찍힌다. 쉼표로만 가르면 그 줄이 이름 하나가 되어 사용 수가 늘 0 이었다.
   */
  it('마운트가 슬라이스 표기로 와도 센다 — 포드맨', () => {
    const stdout = ['pgdata\tlocal', 'logs\tlocal', '@@dolgate@@', '[pgdata logs]', '[pgdata]'].join('\n');
    const { volumes } = parseVolumeList(stdout);
    expect(volumes[0]).toMatchObject({ name: 'pgdata', usedBy: 2 });
    expect(volumes[1]).toMatchObject({ name: 'logs', usedBy: 1 });
  });

  it('볼륨을 붙인 컨테이너 수를 마운트에서 센다', () => {
    const stdout = ['pgdata\tlocal', 'orphan\tlocal', '@@dolgate@@', 'pgdata,logs', 'pgdata'].join('\n');
    const { volumes } = parseVolumeList(stdout);
    expect(volumes[0]).toMatchObject({ name: 'pgdata', usedBy: 2 });
    expect(volumes[1].usedBy).toBe(0);
  });

  it('익명 볼륨을 알아본다', () => {
    const { volumes } = parseVolumeList(`${'b'.repeat(64)}\tlocal`);
    expect(volumes[0].anonymous).toBe(true);
  });

  /**
   * `inspect` 계열은 포맷 문자열의 `\t` 를 탭으로 바꿔 주지 않는다(목록 명령만 바꿔 준다).
   * 백슬래시-t 두 글자를 넣으면 출력에 탭이 없고, 파서가 그 줄을 전부 버려 네트워크가 어느
   * 호스트에서든 빈 목록으로 보였다.
   */
  it('구분자가 진짜 탭이다 — inspect 는 백슬래시-t 를 바꿔 주지 않는다', () => {
    const command = buildNetworkListCommand('docker');
    expect(command).toContain('\t');
    expect(command).not.toContain('\\t');
  });

  // 네트워크가 하나도 없으면 `network inspect` 가 인자 없이 불려 실패한다.
  it('네트워크가 없으면 inspect 를 부르지 않는다', () => {
    const command = buildNetworkListCommand('docker');
    expect(command).toContain('ids=$(docker network ls -q)');
    expect(command).toContain('[ -n "$ids" ]');
  });

  it('네트워크는 한 번의 inspect 로 서브넷까지 받는다', () => {
    expect(buildNetworkListCommand('docker')).toContain('network inspect $ids');
    const { networks } = parseNetworkList('lime_default\tbridge\t172.19.0.0/16 \t6');
    expect(networks[0]).toMatchObject({
      name: 'lime_default',
      subnet: '172.19.0.0/16',
      containerCount: 6,
    });
  });

  /**
   * 도커는 `IPAM.Config`·`Containers`, 포드맨은 `Subnets` 다. 한 형식만 보내면 다른 쪽에서
   * 템플릿이 죽어 탭이 통째로 "없습니다" 가 된다 — 컨테이너의 `{{.State}}` 와 같은 결함이었다.
   */
  it('도커와 포드맨 형식을 둘 다 시도한다', () => {
    const command = buildNetworkListCommand('podman');
    expect(command).toContain('{{range .IPAM.Config}}');
    expect(command).toContain('{{range .Subnets}}');
    expect(command.indexOf('.IPAM.Config')).toBeLessThan(command.indexOf('.Subnets'));
  });

  /**
   * 템플릿은 **줄 중간에** 죽는다(`podman<탭>bridge<탭>` 까지 찍고 오류). 두 시도를 그냥
   * `||` 로 이으면 그 조각이 다음 시도의 첫 줄에 붙어, 첫 네트워크의 서브넷 칸이 드라이버
   * 이름으로 채워진다. 변수로 받아 성공한 쪽만 흘려보내야 한다.
   */
  /** 둘 다 실패하면 우리가 모르는 런타임이다 — 그때 화면에 보여 줄 단서가 그 한 줄뿐이다. */
  it('첫 시도의 오류만 버리고 두 번째 것은 남긴다', () => {
    const command = buildNetworkListCommand('docker');
    const first = command.indexOf('.IPAM.Config');
    const second = command.indexOf('.Subnets');
    // 첫 시도는 포드맨에서 실패하는 것이 정상이라 소음이다.
    expect(command.slice(first, second)).toContain('2>/dev/null');
    // 두 번째 시도 뒤에는 stderr 를 막는 자리가 없다.
    expect(command.slice(second)).not.toContain('2>/dev/null');
  });

  it('실패한 시도의 출력은 버린다', () => {
    const command = buildNetworkListCommand('docker');
    expect(command).toContain('out=$(');
    expect(command).toContain('printf \'%s\\n\' "$out"');
  });

  /**
   * 네트워크가 하나도 없는 것은 **실패가 아니다.** `[ -n "$ids" ] &&` 로 끝내면 그런 호스트가
   * 0 이 아닌 상태로 끝나, 정상적인 빈 목록이 "읽을 수 없다" 로 뒤집힌다 — 고치려던 결함의
   * 거울상이다.
   */
  it('네트워크가 없어도 성공으로 끝난다', () => {
    const command = buildNetworkListCommand('docker');
    expect(command).toContain('if [ "$rc" -eq 0 ] && [ -n "$ids" ]; then');
    expect(command.trimEnd().endsWith('exit $rc')).toBe(true);
  });

  it('볼륨은 두 조각 중 하나만 실패해도 실패로 끝난다', () => {
    const command = buildVolumeListCommand('docker');
    expect(command).toContain('list=$(');
    expect(command).toContain('mounts=$(');
    // 먼저 난 실패를 남긴다 — `[ ]` 의 상태가 $? 를 덮지 않게 미리 받아 둔다.
    expect(command).toContain('mrc=$?');
    expect(command).toContain('[ "$rc" -eq 0 ] && rc=$mrc');
  });

  it('컨테이너 수를 모르면 0 이 아니라 null 이다', () => {
    // 포드맨은 붙은 컨테이너를 알려 주지 않아 그 칸이 빈 채로 온다.
    expect(parseNetworkList('podman\tbridge\t10.88.0.0/16 \t').networks[0].containerCount).toBeNull();
    // 진짜 0 은 0 으로 남는다 — 모르는 것과 없는 것은 다른 말이다.
    expect(parseNetworkList('bridge\tbridge\t172.17.0.0/16 \t0').networks[0].containerCount).toBe(0);
  });
});

describe('초당 I/O', () => {
  const totals = (atMs: number, netIn: number, blockWrite: number) => ({
    atMs,
    netIn,
    netOut: 0,
    blockRead: 0,
    blockWrite,
  });

  it('두 누적 표본의 차를 시간으로 나눈다', () => {
    // docker stats 의 NET·BLOCK 은 컨테이너가 뜬 뒤로 쌓인 총량이다 — 그대로 보여 주면
    // "지금 흐르는 양" 으로 잘못 읽힌다.
    const rate = computeIoRate(totals(0, 1_000, 500), totals(10_000, 21_000, 1_500));
    expect(rate).toEqual({ netIn: 2_000, netOut: 0, blockRead: 0, blockWrite: 100 });
  });

  it('첫 표본에서는 아직 낼 수 없다', () => {
    expect(computeIoRate(undefined, totals(0, 1_000, 0))).toBeNull();
  });

  it('같은 시각의 두 표본은 버린다 — 0 으로 나누지 않는다', () => {
    expect(computeIoRate(totals(5_000, 1_000, 0), totals(5_000, 2_000, 0))).toBeNull();
  });

  it('컨테이너가 다시 뜨어 누적이 0 으로 돌아가면 음수 대신 0 이다', () => {
    const rate = computeIoRate(totals(0, 900_000, 0), totals(10_000, 1_000, 0));
    expect(rate?.netIn).toBe(0);
  });
});

describe('행에 보여 줄 포트', () => {
  function inspect(exposed: string[]) {
    return {
      id: 'a1b2c3d4e5f6',
      restartCount: 0,
      health: null,
      oomKilled: false,
      exposedPorts: exposed,
      networks: [],
    };
  }

  it('공개된 것과 공개 안 된 것을 합친다', () => {
    const { entries: ports } = resolveContainerPorts(
      container({ ports: '0.0.0.0:5050->5050/tcp' }),
      inspect(['5050/tcp', '8080/tcp']),
    );
    expect(ports).toEqual([
      { containerPort: 5050, protocol: 'tcp', publishedPort: 5050 },
      { containerPort: 8080, protocol: 'tcp', publishedPort: null },
    ]);
  });

  it('같은 포트의 IPv4·IPv6 두 줄을 하나로 본다', () => {
    const { entries: ports } = resolveContainerPorts(
      container({ ports: '0.0.0.0:5050->5050/tcp, :::5050->5050/tcp' }),
      undefined,
    );
    expect(ports).toHaveLength(1);
    expect(ports[0].publishedPort).toBe(5050);
  });

  it('검사 결과가 아직 없어도 공개된 포트는 보여 준다', () => {
    const { entries: ports } = resolveContainerPorts(
      container({ ports: '0.0.0.0:3311->3306/tcp' }),
      undefined,
    );
    expect(ports).toEqual([
      { containerPort: 3306, protocol: 'tcp', publishedPort: 3311 },
    ]);
  });

  it('범위로 게시한 포트도 읽는다 — 예전에는 통째로 사라졌다', () => {
    const { entries: ports } = resolveContainerPorts(
      container({ ports: '0.0.0.0:3000-3002->3000-3002/tcp' }),
      undefined,
    );
    expect(ports).toEqual([
      { containerPort: 3000, protocol: 'tcp', publishedPort: 3000 },
      { containerPort: 3001, protocol: 'tcp', publishedPort: 3001 },
      { containerPort: 3002, protocol: 'tcp', publishedPort: 3002 },
    ]);
  });

  it('공개되지 않은 노출 포트는 ps 만으로도 보인다(검사가 오기 전)', () => {
    const { entries: ports } = resolveContainerPorts(container({ ports: '8080/tcp' }), undefined);
    expect(ports).toEqual([{ containerPort: 8080, protocol: 'tcp', publishedPort: null }]);
  });

  it('아주 넓은 범위는 앞에서 끊고 **몇 개를 뺐는지 말한다**', () => {
    const { entries, omitted } = resolveContainerPorts(
      container({ ports: '0.0.0.0:3000-3100->3000-3100/tcp' }),
      // 검사 결과까지 오면 101 개가 다 모인다 — 상한을 넘은 만큼은 화면이 말한다.
      inspect(Array.from({ length: 101 }, (_, index) => `${3000 + index}/tcp`)),
    );
    expect(entries).toHaveLength(24);
    expect(entries[0].containerPort).toBe(3000);
    expect(omitted).toBe(77);
  });

  it('호스트 범위가 짧으면 짝 없는 포트는 공개된 것으로 보지 않는다', () => {
    const { entries } = resolveContainerPorts(
      container({ ports: '0.0.0.0:8000->3000-3002/tcp' }),
      undefined,
    );
    expect(entries).toEqual([
      { containerPort: 3000, protocol: 'tcp', publishedPort: 8000 },
      { containerPort: 3001, protocol: 'tcp', publishedPort: null },
      { containerPort: 3002, protocol: 'tcp', publishedPort: null },
    ]);
  });

  it('포트가 없으면 빈 목록', () => {
    expect(resolveContainerPorts(container({ ports: '' }), undefined)).toEqual({
      entries: [],
      omitted: 0,
    });
  });
});

describe('명령 만들기', () => {
  it('셸은 bash 가 있으면 bash, 없으면 sh 로 떨어진다', () => {
    const command = dockerShellCommand('docker', container({ name: 'web' }));
    expect(command).toBe(
      "docker exec -it 'web' sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'",
    );
  });

  it('돌고 있으면 로그를 따라가고 정지된 것은 따라가지 않는다', () => {
    expect(dockerLogsCommand('docker', container())).toContain('logs -f --tail 200');
    expect(
      dockerLogsCommand('docker', container({ state: 'exited', status: 'Exited (0)' })),
    ).toBe("docker logs --tail 200 'web'");
  });

  it('이름에 따옴표가 들어와도 인젝션이 되지 않는다', () => {
    expect(dockerRemoveCommand('docker', container({ name: "we'b" }))).toBe(
      "docker rm 'we'\\''b'",
    );
  });

  it('스택 동작은 한 명령으로 여러 컨테이너를 다룬다', () => {
    const command = dockerStateCommand('docker', 'restart', [
      container({ name: 'a' }),
      container({ name: 'b' }),
    ]);
    expect(command).toBe("docker restart 'a' 'b'");
  });

  it('sudo 로 풀린 호스트에서는 그 접두사가 명령에도 붙는다', () => {
    expect(dockerStateCommand('sudo -n docker', 'stop', [container({ name: 'a' })])).toBe(
      "sudo -n docker stop 'a'",
    );
  });

  it('compose 는 프로젝트 디렉터리로 들어가서 부른다 — 그래야 설정 파일을 찾는다', () => {
    // `--project-directory` 는 파일을 찾아 주지 않는다(v1·v2 모두 cwd 나 -f 에서 찾는다).
    // 괄호로 감싸 사용자의 현재 위치는 그대로 둔다.
    expect(
      stackComposeCommand('docker compose', { project: 'lime', workingDir: '/srv/lime' }, 'down'),
    ).toBe("(cd '/srv/lime' && docker compose -p 'lime' down)");
    // v1 만 있는 호스트.
    expect(
      stackComposeCommand(
        'sudo -n docker-compose',
        { project: 'lime', workingDir: '/data/compose/11' },
        'logs -f --tail 200',
      ),
    ).toBe("(cd '/data/compose/11' && sudo -n docker-compose -p 'lime' logs -f --tail 200)");
  });
});

describe('컨테이너 지표는 목록과 다른 왕복이다', () => {
  // `stats --no-stream` 은 데몬이 CPU 차분을 내려고 컬렉터 틱을 두 번 기다린다 — 컨테이너가
  // 하나여도 1~2초가 바닥값이다. `ps -a` 는 그 100분의 1이라, 같이 보내면 목록이 그만큼 늦는다.
  it('목록에는 느린 것이 붙지 않는다', () => {
    const command = buildContainerListCommand('docker');
    expect(command).toContain('ps -a --format');
    expect(command).not.toContain('stats');
    expect(command).not.toContain('inspect');
  });

  it('검사는 받아 둔 id 를 쓴다 — ps 를 다시 부르지 않는다', () => {
    const command = buildContainerMetricsCommand('docker', {
      stats: true,
      inspectIds: ['a1b2c3d4e5f6', 'b1c2d3e4f506'],
    });
    expect(command).toContain('stats --no-stream');
    expect(command).toContain("inspect 'a1b2c3d4e5f6' 'b1c2d3e4f506'");
    // 예전에는 여기서 `ids=$(docker ps -aq)` 로 같은 것을 한 번 더 물었다.
    expect(command).not.toContain('ps -a');
  });

  it('지표를 못 주는 호스트에서는 stats 를 빼고 검사만 싣는다', () => {
    const command = buildContainerMetricsCommand('docker', {
      stats: false,
      inspectIds: ['a1b2c3d4e5f6'],
    });
    expect(command).not.toContain('stats');
    expect(command).toContain("inspect 'a1b2c3d4e5f6'");
  });

  /**
   * 포드맨은 `define.InspectContainerData` **구조체**를 그대로 템플릿에 넣는다(도커처럼 원본 JSON
   * 맵으로 물러나지 않는다). 거기에 `index .` 을 쓰면 "can't index item of type …" 으로 죽어
   * 검사 왕복이 통째로 빈다 — 헬스·재시작·OOM·노출 포트·컨테이너 IP 가 전부 사라진다.
   */
  it('포드맨에는 구조체용 형식을 보낸다', () => {
    const command = buildContainerMetricsCommand('podman', {
      stats: true,
      inspectIds: ['a1b2c3d4e5f6'],
      dialect: 'podman',
    });
    expect(command).not.toContain('index .');
    expect(command).toContain('{{.RestartCount}}');
    // 포인터 필드는 `with` 로 감싸야 한다 — 헬스체크가 없으면 State.Health 가 nil 이다.
    expect(command).toContain('{{with .State}}{{with .Health}}{{.Status}}{{end}}{{end}}');
    // 도커 쪽은 그대로다(맵 모드 전제).
    expect(
      buildContainerMetricsCommand('docker', { stats: true, inspectIds: ['a1'] }),
    ).toContain('index . "RestartCount"');
  });

  it('선택 키는 index 로 읽는다 — 없는 키 하나가 줄을 통째로 날린다', () => {
    // docker 는 `{{.Id}}`(구조체 필드명은 `ID`)를 만나면 원본 JSON 맵으로 렌더하고, 맵 모드는
    // `missingkey=error` 다. `.State.Health` 는 헬스체크가 없는 컨테이너에 아예 없는 키라
    // `{{if}}` 로 감싸도 그 줄이 사라진다(실제로 헬스체크 없는 컨테이너에서 재시작·헬스·OOM·
    // 노출 포트가 전부 오지 않았다). 되돌리지 못하게 여기서 막는다.
    const command = buildContainerMetricsCommand('docker', {
      stats: false,
      inspectIds: ['a1b2c3d4e5f6'],
    });
    expect(command).toContain('{{with index .State "Health"}}');
    expect(command).toContain('{{index .State "OOMKilled"}}');
    expect(command).toContain('index .Config "ExposedPorts"');
    expect(command).not.toContain('{{if .State.Health}}');
    expect(command).not.toContain('.Config.ExposedPorts');
  });

  it('검사할 차례가 아니면 지표만 싣는다', () => {
    const command = buildContainerMetricsCommand('docker', { stats: true, inspectIds: [] });
    expect(command).toContain('stats --no-stream');
    expect(command).not.toContain('inspect');
  });

  it('stats 를 빼도 구분자 자리가 밀리지 않는다', () => {
    const parsed = parseContainerMetrics(
      ['@@dolgate@@', `a1b2c3d4e5f6${'0'.repeat(52)}\t3\tunhealthy\ttrue`].join('\n'),
    );
    expect(parsed.stats.size).toBe(0);
    expect(parsed.inspect.get('a1b2c3d4e5f6')).toEqual({
      id: 'a1b2c3d4e5f6',
      restartCount: 3,
      health: 'unhealthy',
      oomKilled: true,
      exposedPorts: [], networks: [],
    });
  });

  it('NET·BLOCK 은 누적값이라 바이트로도 담는다 — 초당 값은 두 표본의 차로 낸다', () => {
    const parsed = parseContainerMetrics(
      'a1b2c3d4e5f6\t12.40%\t412MiB / 15.6GiB\t2.58%\t632kB / 4.38MB\t22.6MB / 12.3kB\t11',
    );
    const stat = parsed.stats.get('a1b2c3d4e5f6');
    expect(stat?.netInBytes).toBe(632_000);
    expect(stat?.netOutBytes).toBe(4_380_000);
    expect(stat?.blockReadBytes).toBe(22_600_000);
    expect(stat?.blockWriteBytes).toBe(12_300);
  });

  it('지표와 검사를 한 왕복에서 갈라 읽는다', () => {
    const parsed = parseContainerMetrics(
      [
        'a1b2c3d4e5f6\t12.40%\t412MiB / 15.6GiB\t2.58%\t1.2GB / 340MB\t0B / 4.1MB\t18',
        '@@dolgate@@',
        `a1b2c3d4e5f6${'0'.repeat(52)}\t0\thealthy\tfalse`,
      ].join('\n'),
    );
    expect(parsed.stats.get('a1b2c3d4e5f6')?.cpuPercent).toBe(12.4);
    expect(parsed.inspect.get('a1b2c3d4e5f6')?.health).toBe('healthy');
  });
});

describe('검사 대상 고르기', () => {
  const known = new Map<string, DockerInspectInfo>([
    ['a1b2c3d4e5f6', { id: 'a1b2c3d4e5f6', restartCount: 0, health: null, oomKilled: false, exposedPorts: [], networks: [] }],
  ]);

  it('훑는 틱에는 전부 물어본다', () => {
    expect(inspectTargets(0, ['a1b2c3d4e5f6', 'b1c2d3e4f506'], known)).toEqual([
      'a1b2c3d4e5f6',
      'b1c2d3e4f506',
    ]);
    expect(inspectTargets(INSPECT_EVERY_TICKS, ['a1b2c3d4e5f6'], known)).toEqual(['a1b2c3d4e5f6']);
  });

  it('훑는 틱이 아니면 아직 못 본 것만 물어본다 — 방금 만든 컨테이너가 몇 분을 기다리지 않게', () => {
    expect(inspectTargets(1, ['a1b2c3d4e5f6', 'b1c2d3e4f506'], known)).toEqual(['b1c2d3e4f506']);
  });

  it('다 아는 것뿐이면 아무것도 얹지 않는다', () => {
    expect(inspectTargets(1, ['a1b2c3d4e5f6'], known)).toEqual([]);
  });
});

describe('검사 결과 합치기', () => {
  const info = (id: string, restartCount: number): DockerInspectInfo => ({
    id,
    restartCount,
    health: null,
    oomKilled: false,
    exposedPorts: [], networks: [],
  });

  it('부분 검사가 나머지를 지우지 않는다', () => {
    const merged = mergeInspectInfo(
      new Map([['a', info('a', 1)]]),
      new Map([['b', info('b', 2)]]),
      ['a', 'b'],
    );
    expect([...merged.keys()].sort()).toEqual(['a', 'b']);
    expect(merged.get('a')?.restartCount).toBe(1);
  });

  it('온 값이 이전 값을 덮는다', () => {
    const merged = mergeInspectInfo(
      new Map([['a', info('a', 1)]]),
      new Map([['a', info('a', 5)]]),
      ['a'],
    );
    expect(merged.get('a')?.restartCount).toBe(5);
  });

  it('목록에서 사라진 컨테이너는 버린다', () => {
    const merged = mergeInspectInfo(
      new Map([
        ['a', info('a', 1)],
        ['gone', info('gone', 1)],
      ]),
      new Map(),
      ['a'],
    );
    expect([...merged.keys()]).toEqual(['a']);
  });
});

describe('컨테이너 네트워크', () => {
  it('name=ip 목록을 가른다', () => {
    expect(parseContainerNetworks('bridge=172.17.0.5;dolgate_default=172.19.0.4;')).toEqual([
      { name: 'bridge', ipAddress: '172.17.0.5' },
      { name: 'dolgate_default', ipAddress: '172.19.0.4' },
    ]);
  });

  it('host 네트워킹은 이름만 오고 IP 가 빈다 — 그 빈 값이 정보다', () => {
    expect(parseContainerNetworks('host=;')).toEqual([{ name: 'host', ipAddress: '' }]);
  });

  it('빈 출력과 부스러기는 버린다', () => {
    expect(parseContainerNetworks('')).toEqual([]);
    expect(parseContainerNetworks(';=;garbage;')).toEqual([]);
  });

  it('IPv6 주소의 콜론을 건드리지 않는다', () => {
    expect(parseContainerNetworks('bridge=fd00::2;')).toEqual([
      { name: 'bridge', ipAddress: 'fd00::2' },
    ]);
  });

  /** 검사와 같은 조각을 쓴다 — 한쪽만 방언을 넣으면 포드맨에서 터널이 IP 를 못 찾는다. */
  it('컨테이너 네트워크 조회도 방언을 따른다', () => {
    expect(buildContainerNetworksCommand('docker', 'abc')).toContain('index $net "IPAddress"');
    const podman = buildContainerNetworksCommand('podman', 'abc', 'podman');
    expect(podman).not.toContain('index .');
    expect(podman).toContain('{{with .NetworkSettings}}');
    expect(podman).toContain('{{$net.IPAddress}}');
  });

  it('검사 왕복이 네트워크 칸까지 실어 온다', () => {
    const parsed = parseContainerMetrics(
      [
        '@@dolgate@@',
        `a1b2c3d4e5f6${'0'.repeat(52)}\t0\thealthy\tfalse\t80/tcp \thost=;`,
      ].join('\n'),
    );
    expect(parsed.inspect.get('a1b2c3d4e5f6')?.networks).toEqual([
      { name: 'host', ipAddress: '' },
    ]);
  });

  it('네트워크를 따로 묻는 명령은 index 로 읽는다 — $net.IPAddress 는 host 모드에서 "invalid IP" 를 찍는다', () => {
    const command = buildContainerNetworksCommand('sudo docker', 'a1b2c3d4e5f6');
    expect(command).toContain("inspect 'a1b2c3d4e5f6'");
    expect(command).toContain('index .NetworkSettings "Networks"');
    expect(command).toContain('index $net "IPAddress"');
    expect(command).not.toContain('$net.IPAddress');
  });
});
