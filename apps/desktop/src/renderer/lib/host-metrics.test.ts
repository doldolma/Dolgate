import { describe, expect, it } from 'vitest';
import {
  buildHostMetricsCommand,
  computeHostMetrics,
  formatBytesPerSecond,
  formatKibibytes,
  formatUptime,
  hasAnyHostMetric,
  isHostMetricAlarming,
  parseHostMetricsSample,
  parseHostProcesses,
  parseHostProcessesFromOutput,
  parseHostSystemInfo,
  parseHostSystemInfoFromOutput,
} from './host-metrics';

/** 실제 /proc 출력 형태 그대로. 필드 위치에 의존하는 파서라 형식을 흉내 내면 의미가 없다. */
function output(overrides: Partial<Record<string, string>> = {}): string {
  const sections: Record<string, string> = {
    stat: 'cpu  1250 0 890 987654 320 0 45 0 0 0',
    mem: 'MemTotal:       16316412 kB\nMemAvailable:   10245680 kB',
    net: [
      'Inter-|   Receive                                                |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
      '    lo: 500000     100    0    0    0     0          0         0   500000     100    0    0    0     0       0          0',
      '  eth0: 987654321   54321    0    0    0     0          0         0 123456789   43210    0    0    0     0       0          0',
    ].join('\n'),
    load: '0.42 0.35 0.30 2/345 12345',
    uptime: '123456.78 987654.32',
    cpus: '4',
    // 물리 디스크(sata1·sata2)만 세어야 한다. 파티션(sata1p1)·RAID(md0)·
    // device-mapper(dm-0)·loop 를 같이 더하면 실제의 몇 배가 된다.
    diskio: [
      '   8       0 sata1 1000 0 20000 100 500 0 8000 50 0 100 150',
      '   8       1 sata1p1 900 0 18000 90 400 0 7000 40 0 90 130',
      '   8      16 sata2 2000 0 40000 200 800 0 16000 80 0 200 280',
      '   8      17 sata2p1 1900 0 38000 190 700 0 15000 70 0 190 260',
      '   9       0 md0 2800 0 56000 280 1200 0 22000 110 0 280 390',
      ' 253       0 dm-0 2800 0 56000 280 1200 0 22000 110 0 280 390',
      '   7       0 loop0 10 0 200 1 0 0 0 0 0 1 1',
    ].join('\n'),
    disk: [
      'Filesystem              1024-blocks       Used  Available Capacity Mounted on',
      '/dev/md0                    2411520    1677721     599040      74% /',
      'devtmpfs                    5033984          0    5033984       0% /dev',
      'tmpfs                       5033984      29696    5004288       1% /tmp',
      '/dev/loop0                    27648        768      24576       4% /tmp/SynologyAuthService',
      '/dev/mapper/cachedev_0   3865470566  868220928 2936143872      23% /volume2',
      '/dev/mapper/cachedev_1   1932735283 1181116006  730894336      61% /volume1',
      '/dev/usb1p1              3865470566 1717986918 2147483648      45% /volumeUSB1/usbshare',
      '/dev/mapper/cachedev_1   1932735283 1181116006  730894336      61% /volume1/@appdata/ContainerManager/all_shares/docker',
      '/dev/mapper/cachedev_1   1932735283 1181116006  730894336      61% /volume1/@appdata/ContainerManager/all_shares/photo',
      'google{YRXYK}:        2576980377600 2147483648000 476741369856  82% /volume2/downloads/gdrive',
    ].join('\n'),
    ...overrides,
  };
  return Object.entries(sections)
    .map(([name, body]) => `@@dolgate:${name}\n${body}`)
    .join('\n');
}

describe('parseHostMetricsSample', () => {
  it('/proc 출력에서 각 항목을 뽑아낸다', () => {
    const sample = parseHostMetricsSample(output(), 1_000);

    // busy = 전체 - (idle 987654 + iowait 320)
    expect(sample.cpu).toEqual({ busy: 1250 + 890 + 45, total: 990159 });
    expect(sample.memTotalKb).toBe(16316412);
    expect(sample.memAvailableKb).toBe(10245680);
    // loopback 은 빼고 eth0 만.
    expect(sample.net).toEqual({ rxBytes: 987654321, txBytes: 123456789 });
    expect(sample.loadAvg1).toBe(0.42);
    expect(sample.uptimeSeconds).toBe(123456.78);
    expect(sample.cpuCount).toBe(4);
    // (20000 + 40000) 섹터 × 512 = 30,720,000 — 파티션·md0·dm-0·loop 는 빠진다.
    expect(sample.diskIo).toEqual({
      readBytes: (20000 + 40000) * 512,
      writeBytes: (8000 + 16000) * 512,
    });
    // 큰 것부터, 장치당 하나. tmpfs·loop·rclone(google{}:) 은 빠지고,
    // 같은 cachedev_1 의 bind mount 들은 원래 볼륨(/volume1)으로 합쳐진다.
    expect(sample.disks.map((disk) => disk.mount)).toEqual([
      '/volume2',
      '/volumeUSB1/usbshare',
      '/volume1',
      '/',
    ]);
  });

  it('loopback 만 있으면 네트워크는 없는 것으로 본다', () => {
    const sample = parseHostMetricsSample(
      output({
        net: [
          'Inter-|   Receive                                                |  Transmit',
          ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
          '    lo: 500000     100    0    0    0     0          0         0   500000     100    0    0    0     0       0          0',
        ].join('\n'),
      }),
      1_000,
    );
    expect(sample.net).toBeNull();
  });

  it('일부 항목이 실패해도 나머지는 살린다', () => {
    // 컨테이너에 df 가 없거나 /proc/net/dev 를 못 읽는 경우.
    const sample = parseHostMetricsSample(output({ disk: '', net: '' }), 1_000);
    expect(sample.disks).toEqual([]);
    expect(sample.net).toBeNull();
    expect(sample.memTotalKb).toBe(16316412);
    expect(hasAnyHostMetric(sample)).toBe(true);
  });

  it('아무것도 못 읽으면 지표 없음으로 판정한다', () => {
    const sample = parseHostMetricsSample('sh: /proc: not found', 1_000);
    expect(hasAnyHostMetric(sample)).toBe(false);
  });
});

describe('computeHostMetrics', () => {
  it('첫 샘플에서는 CPU·네트워크가 비어 있고 나머지는 채워진다', () => {
    const metrics = computeHostMetrics(parseHostMetricsSample(output(), 1_000), null);

    expect(metrics.cpuPercent).toBeNull();
    expect(metrics.rxBytesPerSec).toBeNull();
    expect(metrics.diskReadBytesPerSec).toBeNull();
    expect(metrics.memUsedKb).toBe(16316412 - 10245680);
    expect(metrics.loadAvg1).toBe(0.42);
    expect(metrics.disks[0]?.mount).toBe('/volume2');
  });

  it('이전 샘플과의 차분으로 CPU 사용률을 낸다', () => {
    const first = parseHostMetricsSample(output(), 0);
    // 1초 동안 busy 가 25, 전체가 100 늘었다 → 25%.
    const second = parseHostMetricsSample(
      output({ stat: 'cpu  1275 0 890 987729 320 0 45 0 0 0' }),
      1_000,
    );

    const metrics = computeHostMetrics(second, first);
    expect(metrics.cpuPercent).toBeCloseTo(25, 5);
  });

  it('디스크 I/O 도 차분으로 초당 값을 낸다', () => {
    const first = parseHostMetricsSample(output(), 0);
    const second = parseHostMetricsSample(
      output({
        diskio: [
          '   8       0 sata1 1000 0 21000 100 500 0 8500 50 0 100 150',
          '   8       1 sata1p1 900 0 18000 90 400 0 7000 40 0 90 130',
          '   8      16 sata2 2000 0 40000 200 800 0 16000 80 0 200 280',
        ].join('\n'),
      }),
      2_000,
    );

    const metrics = computeHostMetrics(second, first);
    // 읽기 1000 섹터 × 512 / 2초, 쓰기 500 섹터 × 512 / 2초
    expect(metrics.diskReadBytesPerSec).toBeCloseTo((1000 * 512) / 2, 5);
    expect(metrics.diskWriteBytesPerSec).toBeCloseTo((500 * 512) / 2, 5);
  });

  it('경과 시간으로 나눠 네트워크 처리량을 낸다', () => {
    const first = parseHostMetricsSample(output(), 0);
    const second = parseHostMetricsSample(
      output({
        net: [
          'Inter-|   Receive                                                |  Transmit',
          ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
          '    lo: 500000     100    0    0    0     0          0         0   500000     100    0    0    0     0       0          0',
          '  eth0: 987664321   54321    0    0    0     0          0         0 123458789   43210    0    0    0     0       0          0',
        ].join('\n'),
      }),
      2_000,
    );

    const metrics = computeHostMetrics(second, first);
    // 수신 10,000 바이트 / 2초
    expect(metrics.rxBytesPerSec).toBeCloseTo(5000, 5);
    expect(metrics.txBytesPerSec).toBeCloseTo(1000, 5);
  });

  it('카운터가 되감기면(재부팅) 그 값을 버린다', () => {
    const first = parseHostMetricsSample(output(), 0);
    const rebooted = parseHostMetricsSample(
      output({
        stat: 'cpu  10 0 5 100 0 0 0 0 0 0',
        net: [
          'Inter-|   Receive                                                |  Transmit',
          ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
          '  eth0: 100   5    0    0    0     0          0         0 50   3    0    0    0     0       0          0',
        ].join('\n'),
      }),
      1_000,
    );

    const metrics = computeHostMetrics(rebooted, first);
    expect(metrics.cpuPercent).toBeNull();
    expect(metrics.rxBytesPerSec).toBeNull();
    // 누적이 아닌 값은 그대로 쓸 수 있어야 한다.
    expect(metrics.memTotalKb).toBe(16316412);
  });
});

describe('표시 포맷', () => {
  it('바이트 속도를 단위와 함께 줄여 쓴다', () => {
    expect(formatBytesPerSecond(0)).toBe('0 B/s');
    expect(formatBytesPerSecond(1536)).toBe('1.5 K/s');
    expect(formatBytesPerSecond(5 * 1024 * 1024)).toBe('5.0 M/s');
    expect(formatBytesPerSecond(null)).toBe('—');
  });

  it('메모리를 GiB 단위로 보여준다', () => {
    expect(formatKibibytes(6_291_456)).toBe('6.0 GiB');
    expect(formatKibibytes(null)).toBe('—');
  });

  it('uptime 을 사람이 읽는 형태로 보여준다', () => {
    expect(formatUptime(123456)).toBe('1일 10시간');
    expect(formatUptime(3720)).toBe('1시간 2분');
    expect(formatUptime(420)).toBe('7분');
    expect(formatUptime(null)).toBe('—');
  });

  it('임계치를 넘을 때만 강조한다', () => {
    const calm = computeHostMetrics(parseHostMetricsSample(output(), 0), null);
    expect(isHostMetricAlarming(calm)).toEqual({ cpu: false, memory: false, disk: false });

    const busy = computeHostMetrics(
      parseHostMetricsSample(
        output({
          mem: 'MemTotal:       16316412 kB\nMemAvailable:     100000 kB',
          disk: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1000000 950000 50000 95% /',
        }),
        0,
      ),
      null,
    );
    expect(isHostMetricAlarming(busy).memory).toBe(true);
    expect(isHostMetricAlarming(busy).disk).toBe(true);
  });
});

describe('buildHostMetricsCommand', () => {
  it('읽기 전용 명령만 담고 로케일을 고정한다', () => {
    const command = buildHostMetricsCommand();
    expect(command).toContain('LC_ALL=C');
    expect(command).toContain('/proc/stat');
    expect(command).toContain('/proc/meminfo');
    expect(command).toContain('/proc/net/dev');
    // 쓰기·삭제로 읽힐 만한 것이 섞이면 안 된다.
    expect(command).not.toMatch(/\b(rm|mv|kill|shutdown|>)\b/);
  });
});

describe('프로세스 목록', () => {
  it('요청하지 않으면 명령에 ps 가 들어가지 않는다', () => {
    // 출력이 커서(수백 줄) 상태바만 쓰는 평소에는 실어 보내지 않는다.
    expect(buildHostMetricsCommand()).not.toContain('ps -eo');
    expect(buildHostMetricsCommand({ processLimit: 0 })).not.toContain('ps -eo');
  });

  it('요청하면 상위 N개만 CPU 내림차순으로 가져온다', () => {
    const command = buildHostMetricsCommand({ processLimit: 40 });
    expect(command).toContain('--sort=-pcpu');
    expect(command).toContain('head -n 40');
    expect(command).toContain('|| true');
  });

  it('args 의 공백을 명령으로 붙여 읽는다', () => {
    const rows = parseHostProcesses(
      [
        ' 1234 ubuntu 12.5  3.1 204800 /usr/bin/node --max-old-space-size=4096 server.js',
        ' 5678 root    0.0  0.2   4096 sshd: ubuntu [priv]',
      ].join('\n'),
    );
    expect(rows).toEqual([
      {
        pid: 1234,
        user: 'ubuntu',
        cpuPercent: 12.5,
        memPercent: 3.1,
        rssKb: 204800,
        command: '/usr/bin/node --max-old-space-size=4096 server.js',
      },
      {
        pid: 5678,
        user: 'root',
        cpuPercent: 0,
        memPercent: 0.2,
        rssKb: 4096,
        command: 'sshd: ubuntu [priv]',
      },
    ]);
  });

  it('칸이 모자라거나 pid 가 없는 줄은 버린다', () => {
    expect(parseHostProcesses('garbage\n\n  x y z\n')).toEqual([]);
  });

  it('섹션이 아예 없으면 null — 못 읽은 것과 빈 것을 구분한다', () => {
    // busybox ps 처럼 옵션을 모르는 호스트에서는 빈 섹션이 되고, 그때 UI 가 안내를 바꾼다.
    expect(parseHostProcessesFromOutput('@@dolgate:mem\nMemTotal: 1 kB\n')).toBeNull();
    expect(parseHostProcessesFromOutput('@@dolgate:ps\n')).toEqual([]);
  });
});

describe('시스템 정보', () => {
  it('요청하면 명령에 sys 섹션이 붙고, 아니면 붙지 않는다', () => {
    expect(buildHostMetricsCommand({ system: true })).toContain('uname -srm');
    expect(buildHostMetricsCommand()).not.toContain('uname');
  });

  it('uname·호스트명·CPU 종류를 읽는다', () => {
    const info = parseHostSystemInfo(
      ['Linux 5.15.0-91-generic x86_64', 'web-01', ' Intel(R) Xeon(R)  E5-2686 v4 @ 2.30GHz'].join(
        '\n',
      ),
    );
    expect(info).toEqual({
      hostname: 'web-01',
      kernel: 'Linux 5.15.0-91-generic',
      arch: 'x86_64',
      cpuModel: 'Intel(R) Xeon(R) E5-2686 v4 @ 2.30GHz',
    });
  });

  it('읽을 것이 없으면 null 이다 — 빈 줄을 그리지 않게', () => {
    expect(parseHostSystemInfo('')).toBeNull();
    expect(parseHostSystemInfo('\n  \n')).toBeNull();
  });

  it('sys 섹션이 없는 왕복에서는 null 이다(캐시를 지우지 않게)', () => {
    expect(parseHostSystemInfoFromOutput('@@dolgate:mem\nMemTotal: 1 kB\n')).toBeNull();
  });
})
