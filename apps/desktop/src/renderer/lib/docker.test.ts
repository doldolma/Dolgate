import { describe, expect, it } from 'vitest';
import {
  buildContainerListCommand,
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
    expect(parseDockerProbe('prefix=sudo -n docker\nhas=docker\nwhy=\n')).toEqual({
      prefix: 'sudo -n docker',
      installed: true,
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

  it('아무것도 없으면 설치되지 않은 것으로 본다', () => {
    expect(parseDockerProbe('')).toEqual({ prefix: null, installed: false, reason: null });
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

  it('compose 명령은 프로젝트 디렉터리를 명시한다', () => {
    expect(stackComposeCommand('docker', '/srv/lime', 'down')).toBe(
      "docker compose --project-directory '/srv/lime' down",
    );
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
    });
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
