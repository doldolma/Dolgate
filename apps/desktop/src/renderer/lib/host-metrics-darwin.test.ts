import { describe, expect, it } from 'vitest';
import {
  buildHostMetricsCommand,
  computeHostMetrics,
  diskUsedRatio,
  isHostMetricAlarming,
  parseHostMetricsSample,
} from './host-metrics';

// macOS 실측 출력이다(이 저장소를 만든 기기에서 그대로 떠 왔다). 형식을 손으로 지어내면
// 필드 순서·구두점이 틀리고, 그러면 파서가 아니라 픽스처를 맞추는 테스트가 된다.
const SECTION = '@@dolgate';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   116938.
Pages active:                                 246541.
Pages inactive:                               244079.
Pages speculative:                               963.
Pages wired down:                             224385.
Pages purgeable:                                6343.
File-backed pages:                            121693.
17179869184`;

const NETSTAT = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                      48059589     0 92165674273 48059589     0 92165674273     0
gif0*      1280  <Link#2>                             0     0          0        0     0          0     0
en5        1500  <Link#8>    de:48:0c:8f:15:2e        0     0          0        0     0          0     0
en0        1500  <Link#14>   a2:3a:62:c8:e6:4a 502068038     0 618103336625 156829482     0 134121911476     0`;

const BOOTTIME = `{ sec = 1783705689, usec = 235739 } Sat Jul 11 02:48:09 2026
1787828738`;

/**
 * ioreg 의 블록 장치 토큰. 실측 그대로다 — SD 카드 리더(빈 슬롯), 내장 SSD, 그리고 마운트된
 * 시뮬레이터 런타임 이미지 셋이다. 이미지는 `Virtual Interface` 라 세지 않는다.
 */
const IOREG = `+-o
Physical Interconnect"="Secure Digital"
Bytes (Read)"=0
Bytes (Write)"=0
+-o
Physical Interconnect"="Apple Fabric"
Bytes (Read)"=12191403245568
Bytes (Write)"=5401191211008
+-o
Physical Interconnect"="Virtual Interface"
Bytes (Read)"=206263188480
Bytes (Write)"=0
+-o
Physical Interconnect"="Virtual Interface"
Bytes (Read)"=200732462080
Bytes (Write)"=0
+-o
Physical Interconnect"="Virtual Interface"
Bytes (Read)"=466615296
Bytes (Write)"=0`;

/**
 * `df -Pk` 실측. APFS 라 **한 컨테이너가 여러 줄로 나온다** — disk3s{1s1,6,2,4,5} 가 모두
 * 같은 total·available 을 되풀이하고 Used 만 제 볼륨 몫이라, `/` 줄의 Used(12 GB) 는 이 디스크가
 * 얼마나 찼는지와 아무 상관이 없다(실제로 찬 것은 Data 볼륨의 556 GB 다).
 */
const DF = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   971350180  12277488 385080668     4%    /
devfs                  215       215         0   100%    /dev
/dev/disk3s6     971350180   7340052 385080668     2%    /System/Volumes/VM
/dev/disk3s2     971350180   8778836 385080668     3%    /System/Volumes/Preboot
/dev/disk3s4     971350180      7308 385080668     1%    /System/Volumes/Update
/dev/disk1s2        512000      6164    493008     2%    /System/Volumes/xarts
/dev/disk1s1        512000      5692    493008     2%    /System/Volumes/iSCPreboot
/dev/disk1s3        512000      2276    493008     1%    /System/Volumes/Hardware
/dev/disk3s5     971350180 556391796 385080668    60%    /System/Volumes/Data
map auto_home            0         0         0   100%    /System/Volumes/Data/home
/dev/disk7s1      17639424  17136884    457296    98%    /Library/Developer/CoreSimulator/Volumes/iOS_23E244
/dev/disk9s1      17659904  17159516    455144    98%    /Library/Developer/CoreSimulator/Volumes/iOS_23F77`;

function darwinOutput(overrides: { stat?: string } = {}): string {
  return [
    `${SECTION}:stat`,
    overrides.stat ?? 'cpusum 485',
    `${SECTION}:mem`,
    VM_STAT,
    `${SECTION}:net`,
    NETSTAT,
    `${SECTION}:netdev`,
    '',
    `${SECTION}:load`,
    '{ 3.98 6.49 7.77 }',
    `${SECTION}:uptime`,
    BOOTTIME,
    `${SECTION}:cpus`,
    '10',
    `${SECTION}:diskio`,
    IOREG,
    `${SECTION}:disk`,
    DF,
  ].join('\n');
}

describe('macOS 호스트 지표', () => {
  it('명령이 /proc 이 없을 때 BSD 소스로 떨어진다', () => {
    const command = buildHostMetricsCommand({ processLimit: 20 });
    // 리눅스 경로는 그대로 남고, 없을 때의 대안이 같은 명령 안에 있다 — 왕복은 한 번이다.
    expect(command).toContain('/proc/meminfo');
    expect(command).toContain('vm_stat');
    expect(command).toContain('netstat -ibn');
    expect(command).toContain('sysctl -n vm.loadavg');
    expect(command).toContain('kern.boottime');
    expect(command).toContain('hw.ncpu');
    expect(command).toContain('ioreg -rlc IOBlockStorageDevice');
    // /proc 이 있으면 ps 폴백을 타지 않는다 — 리눅스의 %cpu 는 프로세스 수명 평균이라 그걸
    // CPU 사용률로 내보내면 그럴듯하게 틀린다.
    expect(command).toContain('|| [ -d /proc ] || ps -A -o %cpu=');
    // 프로세스 정렬 옵션은 GNU·BSD 가 다르지만 열 구성은 같다.
    expect(command).toContain('--sort=-pcpu');
    expect(command).toContain('ps -A -o pid=,user=,pcpu=,pmem=,rss=,args= -r');
  });

  it('메모리를 vm_stat 과 hw.memsize 로 읽는다', () => {
    const sample = parseHostMetricsSample(darwinOutput(), 0);
    // 17179869184 바이트 = 16 GiB.
    expect(sample.memTotalKb).toBe(16777216);
    // 여유는 free 만이 아니라 회수 가능한 페이지까지 센다 — free 만 보면 macOS 는 늘
    // "거의 가득" 으로 보인다.
    expect(sample.memAvailableKb).not.toBeNull();
    expect(sample.memAvailableKb!).toBeGreaterThan(0);
    expect(sample.memAvailableKb!).toBeLessThan(sample.memTotalKb!);
  });

  it('네트워크는 Link 줄만 세고 루프백·가상 장치를 뺀다', () => {
    const sample = parseHostMetricsSample(darwinOutput(), 0);
    expect(sample.net).not.toBeNull();
    const names = Object.keys(sample.net!);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('lo0');
    expect(names).toContain('en0');
    expect(names.some((name) => /^utun/.test(name))).toBe(false);
  });

  it('부하·업타임·코어 수를 읽는다', () => {
    const sample = parseHostMetricsSample(darwinOutput(), 0);
    expect(sample.loadAvg1).toBe(3.98);
    expect(sample.cpuCount).toBe(10);
    // 부팅 시각과 지금 시각의 차 — 양수여야 한다.
    expect(sample.uptimeSeconds).not.toBeNull();
    expect(sample.uptimeSeconds!).toBeGreaterThan(0);
  });

  it('CPU 는 프로세스 %cpu 합을 코어 수로 나눈다', () => {
    const sample = parseHostMetricsSample(darwinOutput(), 0);
    expect(sample.cpu).toEqual({ kind: 'coreSum', percent: 485 });
    // 485% 를 10코어로 나누면 48.5% 다. **나누지 않으면 485% 가 나가고** 100 으로 잘려
    // 유휴에 가까운 장비도 늘 꽉 찬 것으로 보인다.
    const first = computeHostMetrics(sample, null);
    expect(first.cpuPercent).toBeCloseTo(48.5, 5);
  });

  it('CPU 는 차분이 아니라서 첫 표본부터 값이 있다', () => {
    // 리눅스(누적 틱)는 두 표본이 있어야 값이 나오는데 이 갈래는 이미 비율이다 — 자원 패널이
    // 열린 직후 한 틱을 비우지 않는다.
    const metrics = computeHostMetrics(parseHostMetricsSample(darwinOutput(), 0), null);
    expect(metrics.cpuPercent).not.toBeNull();
  });

  it('ps 가 아무것도 못 내면 CPU 를 비운다 — 0% 로 두지 않는다', () => {
    // awk 는 입력이 없어도 END 를 돌려 `cpusum ` 만 찍는다. 그걸 0 으로 읽으면 지표를 못 읽는
    // 호스트가 "완전히 유휴" 로 보인다.
    const sample = parseHostMetricsSample(darwinOutput({ stat: 'cpusum ' }), 0);
    expect(sample.cpu).toBeNull();
    expect(computeHostMetrics(sample, null).cpuPercent).toBeNull();
    // 그래도 지표를 쓸 수 있는 호스트로 판정돼야 한다(메모리·부하가 있다).
    expect(sample.memTotalKb).not.toBeNull();
  });

  it('코어 수를 못 읽으면 CPU 를 비운다 — 나누지 못한 값을 내보내지 않는다', () => {
    const output = darwinOutput().replace(`${SECTION}:cpus\n10`, `${SECTION}:cpus\n`);
    const sample = parseHostMetricsSample(output, 0);
    expect(sample.cpuCount).toBeNull();
    expect(computeHostMetrics(sample, null).cpuPercent).toBeNull();
  });

  it('디스크 I/O 는 실제 디스크만 센다 — 마운트한 이미지는 중복이다', () => {
    const sample = parseHostMetricsSample(darwinOutput(), 0);
    // 디스크 이미지의 읽기(206 GB + 200 GB + 466 MB)는 그 이미지 파일을 담은 SSD 에도 이미
    // 쌓여 있다. 다 더하면 시뮬레이터를 켜는 동안 읽기가 두 배로 나간다.
    expect(sample.diskIo).toEqual({
      block: { readBytes: 12191403245568, writeBytes: 5401191211008 },
    });
  });

  it('상호연결 방식을 못 읽으면 실제 디스크로 본다 — 값을 잃지 않는다', () => {
    // 예전 macOS 나 낯선 장치라 그 속성이 없을 수 있다. 그때 빼 버리면 디스크 I/O 가 통째로
    // 사라지므로, 가상이라고 확인된 것만 뺀다.
    const output = darwinOutput().replace(/^Physical Interconnect.*\n/gm, '');
    expect(parseHostMetricsSample(output, 0).diskIo).toEqual({
      block: {
        readBytes: 12191403245568 + 206263188480 + 200732462080 + 466615296,
        writeBytes: 5401191211008,
      },
    });
  });

  it('디스크 I/O 초당 값이 두 표본에서 나온다', () => {
    const before = parseHostMetricsSample(darwinOutput(), 0);
    const after = parseHostMetricsSample(
      darwinOutput().replace('Bytes (Write)"=5401191211008', 'Bytes (Write)"=5401201211008'),
      2_000,
    );
    // 업타임이 같아 벽시계(atMs)로 물러선다 — 2초에 10 MB 를 썼으니 5 MB/s 다.
    const metrics = computeHostMetrics(after, before);
    expect(metrics.diskWriteBytesPerSec).toBeCloseTo(10_000_000 / 2, 0);
    expect(metrics.diskReadBytesPerSec).toBe(0);
  });

  it('APFS 컨테이너를 한 줄로 모으고 사용량을 total - available 로 센다', () => {
    const sample = parseHostMetricsSample(darwinOutput(), 0);
    // 같은 컨테이너의 다섯 줄이 `/` 하나가 된다.
    expect(sample.disks.map((disk) => disk.mount)).toEqual(['/']);
    const root = sample.disks[0];
    expect(root.totalKb).toBe(971350180);
    // df 의 Used(12 GB) 가 아니라 971350180 - 385080668 = 586 GB 다.
    expect(root.usedKb).toBe(971350180 - 385080668);
    expect(diskUsedRatio(root)).toBeCloseTo(0.6036, 4);
  });

  it('읽기 전용 시뮬레이터 이미지가 디스크 경고를 켜지 않는다', () => {
    // 98% 인 두 줄이 남아 있으면 Xcode 를 깐 맥에서는 상태바가 늘 빨갛다.
    const metrics = computeHostMetrics(parseHostMetricsSample(darwinOutput(), 0), null);
    expect(metrics.disks.some((disk) => disk.mount.includes('CoreSimulator'))).toBe(false);
    expect(isHostMetricAlarming(metrics).disk).toBe(false);
  });
});
