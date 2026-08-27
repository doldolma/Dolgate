// 그려진 것을 본다. 좌표 계산은 lib/host-metrics-history.test.ts 가 덮으므로 여기서는 그 좌표가
// 실제로 SVG 로 나가는지, 판마다 축 규칙이 다른 것이 화면에 그대로 나타나는지만 본다.

import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearHostMetricsHistory,
  recordHostMetricsSample,
} from '../../../lib/host-metrics-history';
import type { HostMetrics } from '../../../lib/host-metrics';
import { SessionPanelResourceCharts } from './SessionPanelResourceCharts';

const SESSION = 'session-charts';
const NOW = Date.now();

function metrics(overrides: Partial<HostMetrics> = {}): HostMetrics {
  return {
    cpuPercent: 0,
    memUsedKb: 0,
    memTotalKb: 4 * 1024 * 1024,
    rxBytesPerSec: 0,
    txBytesPerSec: 0,
    diskReadBytesPerSec: 0,
    diskWriteBytesPerSec: 0,
    loadAvg1: null,
    cpuCount: 4,
    uptimeSeconds: 60,
    disks: [],
    ...overrides,
  };
}

/**
 * 축이 딱 1분이 되도록 60초를 네 점으로. x 가 0 · 33.33 · 66.67 · 100 으로 떨어진다.
 *
 * 간격이 20초인 이유: 그보다 벌어지면 "폴링이 멈췄던 구간" 으로 보고 이력을 버린다
 * (host-metrics-history 의 GAP_RESET). 실제 주기도 10초(패널이 열려 있으면 3초)라 이쪽이
 * 진짜 데이터에 가깝다.
 */
function seed(): HostMetrics {
  recordHostMetricsSample(SESSION, metrics({ cpuPercent: 0 }), NOW - 60_000);
  recordHostMetricsSample(SESSION, metrics({ cpuPercent: 25 }), NOW - 40_000);
  recordHostMetricsSample(
    SESSION,
    metrics({ cpuPercent: 50, memUsedKb: 1024 * 1024, txBytesPerSec: 1024 * 1024 }),
    NOW - 20_000,
  );
  const latest = metrics({
    cpuPercent: 100,
    memUsedKb: 2 * 1024 * 1024,
    rxBytesPerSec: 2 * 1024 * 1024,
    diskReadBytesPerSec: 512 * 1024,
  });
  recordHostMetricsSample(SESSION, latest, NOW);
  return latest;
}

beforeEach(() => {
  clearHostMetricsHistory(SESSION);
});

afterEach(() => {
  clearHostMetricsHistory(SESSION);
});

describe('자원 차트', () => {
  it('CPU 는 0~100 고정 눈금 위에 그려진다', () => {
    const latest = seed();
    const { container } = render(
      <SessionPanelResourceCharts sessionId={SESSION} metrics={latest} />,
    );
    const cpu = container.querySelectorAll('svg')[0];
    expect(cpu.querySelector('polyline')?.getAttribute('points')).toBe(
      '0,100 33.33,75 66.67,50 100,0',
    );
  });

  it('네 판을 값과 함께 그린다', () => {
    const latest = seed();
    const { getByText, queryAllByText } = render(
      <SessionPanelResourceCharts sessionId={SESSION} metrics={latest} />,
    );
    for (const label of ['CPU', 'RAM', 'NET', 'DISK']) {
      expect(getByText(label)).toBeTruthy();
    }
    expect(getByText('100%', { selector: 'span.text-right' })).toBeTruthy();
    expect(getByText('2.0 GiB / 4.0 GiB')).toBeTruthy();
    // 고정 축(0~100%)에는 꼭대기 값을 적지 않는다 — 머리글의 현재값과 부딪힌다.
    expect(queryAllByText('100%')).toHaveLength(1);
  });

  it('두 방향은 기준선을 사이에 두고 갈라진다 — 받음은 위, 보냄은 아래', () => {
    const latest = seed();
    const { container } = render(
      <SessionPanelResourceCharts sessionId={SESSION} metrics={latest} />,
    );
    const net = container.querySelectorAll('svg')[2];
    const [rx, tx] = [...net.querySelectorAll('polyline')].map((line) =>
      (line.getAttribute('points') ?? '')
        .split(' ')
        .map((point) => Number(point.split(',')[1])),
    );
    expect(Math.min(...rx)).toBeLessThan(50);
    expect(Math.max(...rx)).toBe(50);
    expect(Math.max(...tx)).toBeGreaterThan(50);
    expect(Math.min(...tx)).toBe(50);
  });

  it('자동 눈금은 꼭대기 값을 적는다 — 안 적으면 읽을 수 없는 그림이 된다', () => {
    const latest = seed();
    const { getByText } = render(
      <SessionPanelResourceCharts sessionId={SESSION} metrics={latest} />,
    );
    // 받음 2 M/s · 보냄 1 M/s 를 한 눈금이 나눠 쓰므로 꼭대기는 둘 중 큰 쪽이다.
    expect(getByText('최대 2.0 M/s', { selector: 'span.absolute' })).toBeTruthy();
    // 디스크는 읽기 512 K/s 하나뿐이라 그 위 칸으로 올라간다.
    expect(getByText('최대 512 K/s', { selector: 'span.absolute' })).toBeTruthy();
  });

  it('네 판이 같은 점에서 시작한다 — 차분이 없는 첫 표본은 그리지 않는다', () => {
    // RAM 은 그 순간 값이라 첫 표본부터 그릴 수 있지만 나머지 셋은 차분이라 한 틱 뒤부터다.
    // 그대로 두면 RAM 곡선만 한 칸 먼저 나간다. 그래서 **첫 표본에는 차분으로 나오는 값이
    // 하나도 없다** — 초당 값도, (리눅스라면) CPU 도 없다.
    recordHostMetricsSample(
      SESSION,
      metrics({
        cpuPercent: null,
        rxBytesPerSec: null,
        txBytesPerSec: null,
        diskReadBytesPerSec: null,
        diskWriteBytesPerSec: null,
        memUsedKb: 512 * 1024,
      }),
      NOW - 80_000,
    );
    const latest = seed();
    const { container } = render(
      <SessionPanelResourceCharts sessionId={SESSION} metrics={latest} />,
    );
    const [cpu, mem] = [...container.querySelectorAll('svg')].map(
      (svg) => svg.querySelector('polyline')?.getAttribute('points') ?? '',
    );
    // 두 곡선의 첫 x 가 같다 = 같은 점에서 시작한다.
    expect(mem.split(' ')[0].split(',')[0]).toBe(cpu.split(' ')[0].split(',')[0]);
    expect(cpu.startsWith('0,')).toBe(true);
  });

  it('macOS 처럼 CPU 가 첫 표본부터 있어도 같은 점에서 시작한다', () => {
    // macOS 의 CPU 는 차분이 아니라 프로세스 %cpu 의 합이라 **첫 표본부터 값이 있다**. 시작점을
    // CPU 로 재면 여기서 어긋난다 — 초당 값으로 재야 네 판이 함께 시작한다.
    recordHostMetricsSample(
      SESSION,
      metrics({
        cpuPercent: 40,
        rxBytesPerSec: null,
        txBytesPerSec: null,
        diskReadBytesPerSec: null,
        diskWriteBytesPerSec: null,
        memUsedKb: 512 * 1024,
      }),
      NOW - 80_000,
    );
    const latest = seed();
    const { container } = render(
      <SessionPanelResourceCharts sessionId={SESSION} metrics={latest} />,
    );
    const [cpu, mem] = [...container.querySelectorAll('svg')].map(
      (svg) => svg.querySelector('polyline')?.getAttribute('points') ?? '',
    );
    // 왼쪽 끝이 잘린 첫 점(40%)이 아니라 초당 값이 나오는 두 번째 표본(0% → y=100)이다.
    expect(cpu.split(' ')[0]).toBe('0,100');
    expect(mem.split(' ')[0].split(',')[0]).toBe('0');
  });

  it('이력이 한 점뿐이면 곡선 없이 최신 값만 보여 준다', () => {
    const latest = metrics({ cpuPercent: 7 });
    recordHostMetricsSample(SESSION, latest, NOW);
    const { container, getByText } = render(
      <SessionPanelResourceCharts sessionId={SESSION} metrics={latest} />,
    );
    expect(container.querySelectorAll('polyline')).toHaveLength(0);
    expect(getByText('7%')).toBeTruthy();
  });

  it('차트 위를 지나면 그 시점 값과 시각을 읽는다', () => {
    const latest = seed();
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function fake() {
      return { left: 0, top: 0, width: 200, height: 44, right: 200, bottom: 44, x: 0, y: 0 } as DOMRect;
    };
    try {
      const { container, getAllByText, getByText, queryByText } = render(
        <SessionPanelResourceCharts sessionId={SESSION} metrics={latest} />,
      );
      const plot = container.querySelectorAll('svg')[0].parentElement as HTMLElement;
      // 가리킨 지점은 네 판이 함께 쓴다 — CPU 위를 지나면 RAM 값도 그때 것으로 바뀐다.
      // 폭 200px 의 66.67% = 20초 전 점(네 점 중 셋째).
      // jsdom 에는 PointerEvent 가 없어 fireEvent.pointerMove 가 clientX 를 흘린다 —
      // MouseEvent 로 같은 타입을 직접 쏜다(React 는 타입만 보고 onPointerMove 를 부른다).
      fireEvent(plot, new MouseEvent('pointermove', { clientX: 133, bubbles: true }));
      expect(getByText('50%')).toBeTruthy();
      expect(getByText('1.0 GiB / 4.0 GiB')).toBeTruthy();
      expect(container.querySelectorAll('line[stroke-dasharray="2 2"]')).toHaveLength(4);
      // 시각은 커서가 있는 판에만 적는다 — 네 번 적으면 읽을 값이 그 사이에 묻힌다.
      const clock = new Date(NOW - 20_000).toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      expect(getAllByText(clock)).toHaveLength(1);
      // React 는 leave 를 pointerout 에서 합성한다 — pointerleave 를 직접 쏘면 닿지 않는다.
      fireEvent(plot, new MouseEvent('pointerout', { bubbles: true }));
      expect(queryByText(clock)).toBeNull();
    } finally {
      Element.prototype.getBoundingClientRect = rect;
    }
  });
});
