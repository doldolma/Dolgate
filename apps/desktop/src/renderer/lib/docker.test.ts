import { describe, expect, it } from 'vitest';
import {
  buildContainerListCommand,
  buildDockerProbeCommand,
  buildNetworkListCommand,
  collectUsedImages,
  dockerLogsCommand,
  dockerRemoveCommand,
  dockerShellCommand,
  dockerStateCommand,
  groupContainersByStack,
  isImageUsed,
  parseContainerList,
  parseDockerAge,
  parseDockerHealth,
  parseDockerProbe,
  parseDockerSize,
  parseExitCode,
  parseImageList,
  parseNetworkList,
  parsePublishedPorts,
  parseVolumeList,
  parseVolumeSizes,
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
  it('목록과 총량을 한 왕복에 받아 큰 것부터 놓는다', () => {
    const stdout = [
      'app\t1.0\tsha1\t412MB',
      '<none>\t<none>\tsha2\t1.1GB',
      '@@dolgate@@',
      'Images\t24\t15\t8.4GB\t2.1GB (25%)',
    ].join('\n');
    const { images, summary } = parseImageList(stdout);
    expect(images[0].repository).toBe('<none>');
    expect(images[0].dangling).toBe(true);
    expect(summary[0]).toMatchObject({ type: 'Images', total: 24, size: '8.4GB' });
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

  it('system df -v 의 볼륨 절에서 크기를 읽는다', () => {
    const stdout = [
      'Images space usage:',
      'REPOSITORY   TAG   SIZE',
      'app          1.0   412MB',
      'Local Volumes space usage:',
      'VOLUME NAME   LINKS     SIZE',
      'pgdata        2         3.6GB',
      'orphan        0         12.4MB',
      'Build cache usage: 0B',
    ].join('\n');
    const sizes = parseVolumeSizes(stdout);
    expect(sizes.get('pgdata')).toBe('3.6GB');
    expect(sizes.get('orphan')).toBe('12.4MB');
    expect(sizes.has('app')).toBe(false);
  });

  it('네트워크는 한 번의 inspect 로 서브넷까지 받는다', () => {
    expect(buildNetworkListCommand('docker')).toContain('network inspect $(docker network ls -q)');
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
