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
  collectUsedImages,
  dockerLogsCommand,
  dockerRemoveCommand,
  dockerShellCommand,
  dockerStateCommand,
  groupContainersByStack,
  isImageUsed,
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
} from './docker';

function row(fields: Partial<Record<number, string>>): string {
  const cells = Array.from({ length: 9 }, (_, index) => fields[index] ?? '');
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
      reason: null,
    });
    // 진짜 없는 호스트: 이유 줄이 온다.
    const absent = parseDockerProbe('why=sh: 1: docker: not found');
    expect(absent.answered).toBe(true);
    expect(absent.installed).toBe(false);
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

  it('탭으로 갈라 읽고 라벨이 없으면 null 이 된다', () => {
    const stdout = [
      row({ 0: 'a1', 1: 'gateway', 2: 'running', 3: 'Up 22 hours (healthy)', 4: 'app:1', 5: '0.0.0.0:5050->5050/tcp', 6: 'lime', 7: 'gateway', 8: '/srv/lime' }),
      row({ 0: 'b2', 1: 'loose', 2: 'exited', 3: 'Exited (137) 3 days ago', 4: 'redis:7' }),
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

  it('State 를 주지 않는 옛 도커는 상태 문장으로 판단한다', () => {
    const stdout = row({ 0: 'a1', 1: 'web', 3: 'Up 3 minutes' });
    expect(parseContainerList(stdout).containers[0].state).toBe('running');
  });

  it('한계를 넘으면 잘렸다고 말한다', () => {
    const lines = Array.from({ length: 205 }, (_, index) =>
      row({ 0: `id${index}`, 1: `c${index}`, 2: 'running', 3: 'Up 1 hour' }),
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
    expect(buildNetworkListCommand('docker')).toContain('ids=$(docker network ls -q); [ -n "$ids" ]');
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
    };
  }

  it('공개된 것과 공개 안 된 것을 합친다', () => {
    const ports = resolveContainerPorts(
      container({ ports: '0.0.0.0:5050->5050/tcp' }),
      inspect(['5050/tcp', '8080/tcp']),
    );
    expect(ports).toEqual([
      { containerPort: 5050, protocol: 'tcp', publishedPort: 5050 },
      { containerPort: 8080, protocol: 'tcp', publishedPort: null },
    ]);
  });

  it('같은 포트의 IPv4·IPv6 두 줄을 하나로 본다', () => {
    const ports = resolveContainerPorts(
      container({ ports: '0.0.0.0:5050->5050/tcp, :::5050->5050/tcp' }),
      undefined,
    );
    expect(ports).toHaveLength(1);
    expect(ports[0].publishedPort).toBe(5050);
  });

  it('검사 결과가 아직 없어도 공개된 포트는 보여 준다', () => {
    const ports = resolveContainerPorts(
      container({ ports: '0.0.0.0:3311->3306/tcp' }),
      undefined,
    );
    expect(ports).toEqual([
      { containerPort: 3306, protocol: 'tcp', publishedPort: 3311 },
    ]);
  });

  it('포트가 없으면 빈 목록', () => {
    expect(resolveContainerPorts(container({ ports: '' }), undefined)).toEqual([]);
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
      exposedPorts: [],
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
