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

/** 축이 딱 1분이 되도록 60초를 세 점으로. x 가 0 · 50 · 100 으로 떨어진다. */
function seed(): HostMetrics {
  recordHostMetricsSample(SESSION, metrics({ cpuPercent: 0 }), NOW - 60_000);
  recordHostMetricsSample(
    SESSION,
    metrics({ cpuPercent: 50, memUsedKb: 1024 * 1024, txBytesPerSec: 1024 * 1024 }),
    NOW - 30_000,
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
    expect(cpu.querySelector('polyline')?.getAttribute('points')).toBe('0,100 50,50 100,0');
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
      // 폭 200px 의 한가운데 = 축의 50% = 30초 전 점.
      // jsdom 에는 PointerEvent 가 없어 fireEvent.pointerMove 가 clientX 를 흘린다 —
      // MouseEvent 로 같은 타입을 직접 쏜다(React 는 타입만 보고 onPointerMove 를 부른다).
      fireEvent(plot, new MouseEvent('pointermove', { clientX: 100, bubbles: true }));
      expect(getByText('50%')).toBeTruthy();
      expect(getByText('1.0 GiB / 4.0 GiB')).toBeTruthy();
      expect(container.querySelectorAll('line[stroke-dasharray="2 2"]')).toHaveLength(4);
      // 시각은 커서가 있는 판에만 적는다 — 네 번 적으면 읽을 값이 그 사이에 묻힌다.
      const clock = new Date(NOW - 30_000).toLocaleTimeString('ko-KR', {
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
