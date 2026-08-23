// 배관 검증. 무엇을 접을지의 판정은 lib/session-status-bar.test.ts 가 덮으므로, 여기서는
// "그 판정대로 그려지는가"와 "누르면 패널의 그 섹션이 열리는가" 만 본다.

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostMetrics } from '../../lib/host-metrics';
import { clearRttHistory, recordRtt } from '../../lib/rtt-history';
import { TerminalSessionStatusBar } from './TerminalSessionStatusBar';

const selectSection = vi.fn();

vi.mock('../../store/appStore', () => ({
  useAppStore: (selector: (state: any) => unknown) =>
    selector({ selectSessionPanelSection: selectSection }),
}));

function metrics(overrides: Partial<HostMetrics> = {}): HostMetrics {
  return {
    cpuPercent: 12,
    cpuCount: 4,
    memUsedKb: 1258291,
    memTotalKb: 8070840,
    rxBytesPerSec: 1258291,
    txBytesPerSec: 49152,
    diskReadBytesPerSec: 0,
    diskWriteBytesPerSec: 131072,
    loadAvg1: 0.4,
    uptimeSeconds: 86400,
    disks: [],
    ...overrides,
  } as HostMetrics;
}

function renderBar(overrides: Record<string, unknown> = {}) {
  return render(
    <TerminalSessionStatusBar
      sessionId="session-1"
      status="ready"
      metrics={metrics()}
      onRetry={vi.fn()}
      rttMs={11}
      kindChip={null}
      hopRows={[]}
      tmuxLabel={null}
      width={760}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  selectSection.mockClear();
  clearRttHistory('stable-1');
});

describe('세션 상태바', () => {
  it('지표를 못 읽는 연결에서도 바가 남고 지연이 보인다', () => {
    // 예전 자원 바는 이때 null 을 반환해 바 자체가 사라졌다 — 지연이 여기로 왔으니 그럴 수 없다.
    renderBar({ status: 'unsupported', metrics: null });
    expect(screen.getByText('11ms')).toBeTruthy();
    expect(screen.queryByText('CPU')).toBeNull();
  });

  it('넓으면 NET·DISK 까지 그린다', () => {
    renderBar();
    expect(screen.getByText('CPU')).toBeTruthy();
    expect(screen.getByText('RAM')).toBeTruthy();
    expect(screen.getByText('NET ↓')).toBeTruthy();
    expect(screen.getByText('DISK R')).toBeTruthy();
  });

  it('좁아지면 초당 값부터 사라지고 CPU 는 남는다', () => {
    renderBar({ width: 560 });
    expect(screen.queryByText('DISK R')).toBeNull();
    expect(screen.queryByText('NET ↓')).toBeNull();
    expect(screen.getByText('CPU')).toBeTruthy();
  });

  it('더 좁아지면 라벨을 떼고 RAM·지연을 버린다', () => {
    renderBar({ width: 200 });
    expect(screen.queryByText('CPU')).toBeNull();
    expect(screen.queryByText('RAM')).toBeNull();
    expect(screen.queryByText('11ms')).toBeNull();
    // 숫자는 남는다 — 마지막까지 남기는 값이다.
    expect(screen.getByText('12%')).toBeTruthy();
  });

  it('지표를 누르면 자원 섹션이 열린다', () => {
    renderBar();
    fireEvent.click(screen.getByTitle('자원 자세히 보기'));
    expect(selectSection).toHaveBeenCalledWith('session-1', 'resources');
  });

  it('tmux 칩을 누르면 tmux 섹션이 열린다', () => {
    renderBar({ tmuxLabel: 'tmux · 3.4' });
    fireEvent.click(screen.getByRole('button', { name: 'tmux 세션 관리' }));
    expect(selectSection).toHaveBeenCalledWith('session-1', 'tmux');
  });

  it('칩이 먼저 아이콘만 남는다 — 라벨은 사라지고 이름은 남는다', () => {
    renderBar({ tmuxLabel: 'tmux · 3.4', width: 500 });
    expect(screen.queryByText('tmux · 3.4')).toBeNull();
    expect(screen.getByRole('button', { name: 'tmux 세션 관리' })).toBeTruthy();
  });

  it('지연을 아직 못 쟀으면 그리지 않는다', () => {
    renderBar({ rttMs: null });
    expect(screen.queryByText(/ms$/)).toBeNull();
  });

  it('점프 칩에 마우스를 올리면 홉 목록이 뜬다', () => {
    renderBar({
      kindChip: { kind: 'jump', hopCount: 1, hopName: 'Bastion' },
      hopRows: [
        {
          index: 0,
          name: 'Bastion',
          label: 'ubuntu@bastion.example.com:22',
          destination: false,
          failed: false,
        },
        {
          index: 1,
          name: null,
          label: 'ubuntu@10.0.3.14:22',
          destination: true,
          failed: false,
        },
      ],
    });
    const chip = screen.getByLabelText('점프 · Bastion');
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(chip);
    expect(screen.getByText('ubuntu@bastion.example.com:22')).toBeTruthy();
    expect(screen.getByText('ubuntu@10.0.3.14:22')).toBeTruthy();
    expect(screen.getByText('목적지')).toBeTruthy();
    fireEvent.mouseLeave(chip);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('점프가 아닌 종류는 툴팁만 두고 홉 패널을 만들지 않는다', () => {
    renderBar({ kindChip: { kind: 'ssm', hopCount: 0, hopName: null } });
    expect(screen.getByLabelText('SSM')).toBeTruthy();
  });

  it('담을 것이 하나도 없으면 아예 그리지 않는다', () => {
    // 로컬 터미널: 지표도 지연도 tmux 도 없다. 빈 줄이 26px 을 먹고 앉아 있으면 고장으로 보인다.
    const { container } = renderBar({
      status: 'off',
      metrics: null,
      rttMs: null,
      tmuxLabel: null,
      kindChip: null,
    });
    expect(container.firstChild).toBeNull();
  });

  it('지연에 마우스를 올리면 min·avg·max 가 뜬다', () => {
    const now = Date.now();
    recordRtt('stable-1', 2, now - 180_000);
    recordRtt('stable-1', 7, now - 20_000);
    recordRtt('stable-1', 44, now - 10_000);
    renderBar({ historyKey: 'stable-1' });

    fireEvent.mouseEnter(screen.getByText('11ms').closest('span')!);
    expect(screen.getByText('2ms')).toBeTruthy();
    expect(screen.getByText('18ms')).toBeTruthy();
    expect(screen.getByText('44ms')).toBeTruthy();
  });

  it('이력이 없으면 hover 해도 아무것도 띄우지 않는다', () => {
    renderBar({ historyKey: 'stable-1' });
    fireEvent.mouseEnter(screen.getByText('11ms').closest('span')!);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('멈춘 상태에서는 다시 시도를 준다', () => {
    const onRetry = vi.fn();
    renderBar({ status: 'paused', onRetry });
    fireEvent.click(screen.getByText('연결이 불안정해 멈췄습니다 · 다시 시도'));
    expect(onRetry).toHaveBeenCalled();
  });
});
