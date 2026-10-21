// 팀 호스트 세션 탭 — 접속 기록과 녹화가 팀에 남는다는 것을 탭에서 알 수 있어야 한다.

import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord, TerminalTab, UpdateState } from '@shared';
import { appStore } from '../store/appStore';
import { createEmptyVaultIndex } from '../store/utils';
import { AppTitleBar, buildTabHoverInfo } from './AppTitleBar';

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

function renderTabs(tabs: TerminalTab[]) {
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
        hosts: [],
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

describe('팀 호스트 세션 탭', () => {
  it('팀 호스트 세션 탭에만 팀 표시를 붙인다', () => {
    appStore.setState({
      vaultIndex: {
        ...createEmptyVaultIndex(),
        teams: [{ id: 'team-1', name: 'Acme Infra', role: 'member', syncState: 'ready', syncError: null, groups: [] }],
        teamIdByHostId: { 'team-host': 'team-1' },
      },
    });
    renderTabs([sessionTab('s1', 'team-host', 'team-web'), sessionTab('s2', 'my-host', 'my-web')]);

    expect(within(screen.getByRole('button', { name: 'team-web 세션으로 이동' })).getByText('AI')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: 'my-web 세션으로 이동' })).queryByText('AI')).not.toBeInTheDocument();
  });

  it('탭 hover 에서 팀 기록·녹화에 남는다고 말한다', () => {
    const rowsOf = (item: unknown) =>
      Object.fromEntries(
        buildTabHoverInfo(item as never, [sessionTab('s1', 'team-host', 'team-web')], [] as HostRecord[], [], [], () => null).rows.map(
          (row) => [row.label, row.value],
        ),
      );
    expect(rowsOf({ kind: 'session', sessionId: 's1', active: true, team: { id: 'team-1', name: 'Acme Infra' } })['팀']).toBe(
      'Acme Infra · 팀 기록·녹화에 남습니다',
    );
    expect(rowsOf({ kind: 'session', sessionId: 's1', active: true, team: null })['팀']).toBeUndefined();
  });
});
