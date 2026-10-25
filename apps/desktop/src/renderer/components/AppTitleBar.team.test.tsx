// 팀 호스트 세션 탭 — 접속 기록과 녹화가 팀에 남는다는 것은 탭 hover 에서 알 수 있어야 한다(탭에는 표시하지 않는다).

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord, TerminalTab, UpdateState } from '@shared';
import { appStore } from '../store/appStore';
import { createEmptyVaultIndex } from '../store/utils';
import { AppTitleBar, buildTabHoverInfo } from './AppTitleBar';

vi.mock('../services/desktop/tailnet', () => ({
  listTailnets: vi.fn(async () => []),
  listTeamTailnets: vi.fn(async (teamId: string) => (teamId === 'team-1' ? [{ id: 'tn-team', label: '팀망' }] : [])),
  snapshotTailnets: vi.fn(async () => ({ statuses: [] })),
}));

const sessionTab = (sessionId: string, hostId: string, title: string) =>
  ({
    id: `tab-${sessionId}`,
    stableId: `tab-${sessionId}`,
    sessionId,
    source: 'host',
    hostId,
    title,
    status: 'connected',
    lastEventAt: '2026-10-21T01:00:00.000Z',
  }) as TerminalTab;

const updateState: UpdateState = {
  enabled: true,
  status: 'idle',
  currentVersion: '1.0.0',
  release: null,
  progress: null,
  checkedAt: null,
  dismissedVersion: null,
  errorMessage: null,
};

function renderTabs(tabs: TerminalTab[], hosts: HostRecord[] = []) {
  const noop = vi.fn().mockResolvedValue(undefined);
  return render(
    <AppTitleBar
      {...({
        onSetRdpMonitors: vi.fn(),
        resolveRdpMonitors: () => null,
        desktopPlatform: 'darwin',
        tabs,
        workspaces: [],
        tabStrip: tabs.map((tab) => ({ kind: 'session', sessionId: tab.sessionId })),
        activeWorkspaceTab: 'home',
        sessionPanelOpen: false,
        onToggleSessionPanel: vi.fn(),
        draggedSession: null,
        updateState,
        windowState: { isMaximized: false, isFullScreen: false },
        tmuxGroups: [],
        hosts,
        onSelectTmuxGroup: vi.fn(),
        onCloseTmuxGroup: vi.fn(),
        onSelectHome: vi.fn(),
        onSelectSftp: vi.fn(),
        onSelectContainers: vi.fn(),
        onSelectSession: vi.fn(),
        onSelectWorkspace: vi.fn(),
        onCloseSession: noop,
        onCloseWorkspace: noop,
        onStartSessionDrag: vi.fn(),
        onEndSessionDrag: vi.fn(),
        onDetachSessionToStandalone: vi.fn(),
        onReorderDynamicTab: vi.fn(),
        onCheckForUpdates: noop,
        onDownloadUpdate: noop,
        onInstallUpdate: noop,
        onDismissUpdate: noop,
        onOpenReleasePage: noop,
        onMinimizeWindow: noop,
        onToggleFullScreenWindow: noop,
        onCloseWindow: noop,
      } as Parameters<typeof AppTitleBar>[0])}
    />,
  );
}

afterEach(() => {
  appStore.setState({ vaultIndex: createEmptyVaultIndex() });
});

function setTeamIndex() {
  appStore.setState({
    vaultIndex: {
      ...createEmptyVaultIndex(),
      teams: [{ id: 'team-1', name: 'Acme Infra', role: 'member', syncState: 'ready', syncError: null, groups: [] }],
      teamIdByHostId: { 'team-host': 'team-1' },
    },
  });
}

const tabItemOf = (title: string) =>
  screen.getByRole('button', { name: `${title} 세션으로 이동` }).closest<HTMLElement>('[data-titlebar-tab-item="true"]')!;

describe('팀 호스트 세션 탭', () => {
  it('탭에는 팀 표시를 붙이지 않고, hover 에서 팀을 말한다', () => {
    setTeamIndex();
    renderTabs([sessionTab('s1', 'team-host', 'team-web'), sessionTab('s2', 'my-host', 'my-web')]);

    expect(within(screen.getByRole('button', { name: 'team-web 세션으로 이동' })).queryByText('AI')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'team-web 세션으로 이동' })).toHaveTextContent(/^team-web$/);
    fireEvent.mouseEnter(tabItemOf('team-web'));
    expect(screen.getByText('Acme Infra')).toBeInTheDocument();
  });

  // 팀 볼트로 공유한 호스트의 tailnet 은 그 팀 볼트에 있다 — 개인 목록만 읽으면 이름 대신 id 가 보였다.
  it('팀 호스트 탭 hover 에 그 팀 볼트의 tailnet 이름을 보인다', async () => {
    setTeamIndex();
    const teamHost = {
      id: 'team-host',
      kind: 'ssh',
      label: 'team-web',
      hostname: 'nas',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      groupName: null,
      tags: [],
      terminalThemeId: null,
      tailnetId: 'tn-team',
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
    } as unknown as HostRecord;
    renderTabs([sessionTab('s1', 'team-host', 'team-web')], [teamHost]);

    fireEvent.mouseEnter(tabItemOf('team-web'));
    expect(await screen.findByText(/^팀망 · /)).toBeInTheDocument();
    expect(screen.queryByText(/^tn-team · /)).toBeNull();
  });

  // 팀 줄에는 팀 볼트 이름만 — 기록·녹화에 남는다는 말은 붙이지 않는다(줄이 길기만 했다).
  it('탭 hover 의 팀 줄에 팀 볼트 이름만 적는다', () => {
    const rowsOf = (item: unknown) =>
      Object.fromEntries(
        buildTabHoverInfo(item as never, [sessionTab('s1', 'team-host', 'team-web')], [] as HostRecord[], [], [], () => null).rows.map(
          (row) => [row.label, row.value],
        ),
      );
    expect(rowsOf({ kind: 'session', sessionId: 's1', active: true, team: { id: 'team-1', name: 'Acme Infra' } })['팀']).toBe(
      'Acme Infra',
    );
    expect(rowsOf({ kind: 'session', sessionId: 's1', active: true, team: null })['팀']).toBeUndefined();
  });
});
