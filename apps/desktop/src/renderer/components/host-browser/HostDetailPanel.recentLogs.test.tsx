import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ActivityLogRecord, HostRecord, SshHostRecord } from '@shared';
import { HostDetailPanel } from './HostDetailPanel';
import type { HostBrowserModel } from './useHostBrowser';

// 최근 로그의 범위 규칙은 recentLogScope 가 순수 함수로 검증한다. 여기서는 **패널이 그 범위를
// 실제로 쓰는지**(모델의 favoritesFilterActive·selectedGroupPaths 를 읽어 목록을 좁히는지)를 본다 —
// 규칙이 맞아도 배관이 빠지면 화면에서는 전체 로그가 그대로 나온다.

function makeHost(id: string, label: string, groupName: string | null, favorite = false) {
  return {
    id,
    kind: 'ssh',
    label,
    hostname: `${id}.example.com`,
    port: 22,
    username: 'ops',
    authType: 'agent',
    groupName,
    favorite,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as SshHostRecord;
}

const hosts: HostRecord[] = [
  makeHost('h-fav', 'favorite box', 'Servers', true),
  makeHost('h-plain', 'plain box', 'Servers'),
  makeHost('h-lab', 'lab box', 'Lab'),
];

function makeLog(hostId: string, createdAt: string): ActivityLogRecord {
  return {
    id: `log-${hostId}`,
    kind: 'session-lifecycle',
    level: 'info',
    message: 'session.connected',
    metadata: { hostId, connectionKind: 'ssh' },
    createdAt,
  } as unknown as ActivityLogRecord;
}

function makeTmuxLog(hostId: string, createdAt: string): ActivityLogRecord {
  return {
    id: `log-tmux-${hostId}`,
    kind: 'session-lifecycle',
    level: 'info',
    message: 'session.connected',
    metadata: { hostId, connectionKind: 'ssh', tmux: true },
    createdAt,
  } as unknown as ActivityLogRecord;
}

const activityLogs: ActivityLogRecord[] = [
  makeLog('h-fav', '2026-01-03T00:00:00.000Z'),
  makeLog('h-plain', '2026-01-02T00:00:00.000Z'),
  makeLog('h-lab', '2026-01-01T00:00:00.000Z'),
];

function renderEmptyDetail(scope: Partial<HostBrowserModel>) {
  const hb = {
    hosts,
    activityLogs,
    selectedHostId: null,
    favoriteHostIdSet: new Set(['h-fav']),
    keychainEntries: [],
    detailTab: 'overview',
    onCreateHost: vi.fn(),
    onOpenOpenSshImport: vi.fn(),
    onOpenLocalTerminal: vi.fn(),
    openCreateGroupModal: vi.fn(),
    onSelectSection: vi.fn(),
    ...scope,
  } as unknown as HostBrowserModel;
  return render(<HostDetailPanel hb={hb} />);
}

/** 유지시간·명령 수를 실은 세션 기록. 둘 다 세션이 닫힐 때에야 값이 생긴다. */
function makeFinishedLog(
  hostId: string,
  createdAt: string,
  extra: { durationMs?: number | null; commandCount?: number | null },
): ActivityLogRecord {
  return {
    id: `log-done-${hostId}`,
    kind: 'session-lifecycle',
    level: 'info',
    message: 'session.connected',
    metadata: { hostId, connectionKind: 'ssh', status: 'closed', ...extra },
    createdAt,
  } as unknown as ActivityLogRecord;
}

describe('HostDetailPanel — 연결 시간과 명령 수', () => {
  it('연결이 이어진 시간을 오른쪽에 적는다', () => {
    renderEmptyDetail({
      activityLogs: [
        makeFinishedLog('h-fav', '2026-01-03T00:00:00.000Z', {
          durationMs: 72 * 60 * 1000,
          commandCount: 34,
        }),
      ],
    });

    expect(screen.getByText('1시간 12분')).toBeInTheDocument();
    expect(screen.getByText(/명령 34개/)).toBeInTheDocument();
  });

  /**
   * 셀 수 없었던 것(셸 통합 없음)과 정말 0회는 다른 말이다. 없는 값을 "명령 0개" 로 적으면
   * 아무것도 안 한 세션처럼 보인다.
   */
  it('명령 수를 못 받았으면 그 조각을 아예 빼고, 0 이면 0 이라고 적는다', () => {
    renderEmptyDetail({
      activityLogs: [
        makeFinishedLog('h-fav', '2026-01-03T00:00:00.000Z', {
          durationMs: 30 * 1000,
        }),
      ],
    });
    expect(screen.queryByText(/명령/)).not.toBeInTheDocument();
    expect(screen.getByText('30초')).toBeInTheDocument();

    renderEmptyDetail({
      activityLogs: [
        makeFinishedLog('h-lab', '2026-01-03T00:00:00.000Z', {
          durationMs: 30 * 1000,
          commandCount: 0,
        }),
      ],
    });
    expect(screen.getByText(/명령 0개/)).toBeInTheDocument();
  });

  /**
   * 7일이 넘어도 상대 표기를 이어 간다. 절대 일시로 넘어가면 오른쪽 열이 꽉 차서
   * 유지시간을 놓을 자리가 없어진다 — 정확한 일시는 툴팁이 맡는다.
   */
  it('오래된 기록도 주·개월·년으로 적는다', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-09T12:00:00.000Z'));
    onTestFinished(() => clock.mockRestore());

    renderEmptyDetail({
      activityLogs: [
        makeFinishedLog('h-fav', '2026-08-02T03:10:00.000Z', { durationMs: 60 * 1000 }),
      ],
    });
    expect(screen.getByText('1개월 전')).toBeInTheDocument();

    renderEmptyDetail({
      activityLogs: [
        makeFinishedLog('h-lab', '2025-04-11T22:05:00.000Z', { durationMs: 60 * 1000 }),
      ],
    });
    expect(screen.getByText('1년 전')).toBeInTheDocument();
  });

  /**
   * 목록이 상대 표기만 보여 주므로 정확한 일시의 유일한 출처가 툴팁이다. 이 배선이 끊기면
   * 화면 어디에서도 "정확히 언제"를 알 수 없다.
   */
  it('날짜에 마우스를 올리면 정확한 일시가 뜬다', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-09T12:00:00.000Z'));
    onTestFinished(() => clock.mockRestore());

    renderEmptyDetail({
      activityLogs: [
        makeFinishedLog('h-fav', '2026-08-02T03:10:00.000Z', { durationMs: 60 * 1000 }),
      ],
    });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByText('1개월 전').parentElement as HTMLElement);

    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toMatch(/2026/);
    expect(tip.textContent).not.toBe('1개월 전');
  });

  /** 아직 살아 있는 세션은 종료 때 유지시간이 계산되므로 그 줄이 없어야 한다. */
  it('아직 안 끝난 세션에는 유지시간을 적지 않는다', () => {
    renderEmptyDetail({
      activityLogs: [makeLog('h-fav', '2026-01-03T00:00:00.000Z')],
    });

    expect(screen.queryByText(/시간|분$|초$/)).not.toBeInTheDocument();
  });
});

describe('HostDetailPanel — 최근 로그 범위', () => {
  it('최근 로그에서 tmux SSH 연결을 구분해 표시한다', () => {
    renderEmptyDetail({
      activityLogs: [makeTmuxLog('h-fav', '2026-01-03T00:00:00.000Z')],
    });

    expect(screen.getByText('SSH (tmux)')).toBeInTheDocument();
  });

  it('범위가 없으면 모든 호스트의 로그를 보여준다', () => {
    renderEmptyDetail({});

    expect(screen.getByText('favorite box')).toBeTruthy();
    expect(screen.getByText('plain box')).toBeTruthy();
    expect(screen.getByText('lab box')).toBeTruthy();
  });

  it('즐겨찾기를 보고 있으면 즐겨찾기한 호스트만 남긴다', () => {
    renderEmptyDetail({ favoritesFilterActive: true });

    expect(screen.getByText('favorite box')).toBeTruthy();
    expect(screen.queryByText('plain box')).toBeNull();
    expect(screen.queryByText('lab box')).toBeNull();
    // 제목이 왜 짧아졌는지 말해 준다.
    expect(screen.getByText(/즐겨찾기/)).toBeTruthy();
  });

  it('그룹을 보고 있으면 그 그룹만 남긴다', () => {
    renderEmptyDetail({ selectedGroupPaths: ['Servers'] });

    expect(screen.getByText('favorite box')).toBeTruthy();
    expect(screen.getByText('plain box')).toBeTruthy();
    expect(screen.queryByText('lab box')).toBeNull();
  });
});
