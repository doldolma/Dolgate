import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
