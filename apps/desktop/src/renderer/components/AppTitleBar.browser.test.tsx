import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '@shared';
import { AppTitleBar } from './AppTitleBar';

type AppTitleBarPropsForTest = Parameters<typeof AppTitleBar>[0];

function createUpdateState(): UpdateState {
  return {
    enabled: true,
    status: 'idle',
    currentVersion: '1.0.0',
    release: null,
    progress: null,
    checkedAt: null,
    dismissedVersion: null,
    errorMessage: null
  };
}

function createSessionTab(id = 'session-1') {
  return {
    id: `tab-${id}`,
    stableId: `tab-${id}`,
    sessionId: id,
    source: 'host' as const,
    hostId: 'host-1',
    title: 'mqtt/evo-parser',
    status: 'connected' as const,
    lastEventAt: new Date().toISOString(),
  };
}

function renderTitleBar(overrides: Partial<AppTitleBarPropsForTest> = {}) {
  const props: AppTitleBarPropsForTest = {
    desktopPlatform: 'darwin',
    tabs: [],
    workspaces: [],
    tabStrip: [],
    activeWorkspaceTab: 'home',
    draggedSession: null,
    updateState: createUpdateState(),
    windowState: { isMaximized: false },
    tmuxGroups: [],
    hosts: [],
    onSelectTmuxGroup: vi.fn(),
    onCloseTmuxGroup: vi.fn(),
    onSelectHome: vi.fn(),
    onSelectSftp: vi.fn(),
    onSelectContainers: vi.fn(),
    onSelectSession: vi.fn(),
    onSelectWorkspace: vi.fn(),
    onCloseSession: vi.fn().mockResolvedValue(undefined),
    onCloseWorkspace: vi.fn().mockResolvedValue(undefined),
    onStartSessionDrag: vi.fn(),
    onEndSessionDrag: vi.fn(),
    onDetachSessionToStandalone: vi.fn(),
    onReorderDynamicTab: vi.fn(),
    onCheckForUpdates: vi.fn().mockResolvedValue(undefined),
    onDownloadUpdate: vi.fn().mockResolvedValue(undefined),
    onInstallUpdate: vi.fn().mockResolvedValue(undefined),
    onDismissUpdate: vi.fn().mockResolvedValue(undefined),
    onOpenReleasePage: vi.fn().mockResolvedValue(undefined),
    onMinimizeWindow: vi.fn().mockResolvedValue(undefined),
    onMaximizeWindow: vi.fn().mockResolvedValue(undefined),
    onRestoreWindow: vi.fn().mockResolvedValue(undefined),
    onCloseWindow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  return render(<AppTitleBar {...props} />);
}

describe('AppTitleBar update popover', () => {
  it('closes when clicking outside the update menu', () => {
    renderTitleBar();

    fireEvent.click(screen.getByRole('button', { name: '업데이트 상태 보기' }));

    expect(screen.getByTestId('update-popover')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByTestId('update-popover')).not.toBeInTheDocument();
  });

  it('renders the fixed containers tab and routes select actions', async () => {
    const onSelectContainers = vi.fn();

    render(
      <AppTitleBar
        desktopPlatform="darwin"
        tabs={[]}
        workspaces={[]}
        tabStrip={[]}
        activeWorkspaceTab="containers"
        draggedSession={null}
        updateState={createUpdateState()}
        windowState={{ isMaximized: false }}
      tmuxGroups={[]}
      hosts={[]}
      onSelectTmuxGroup={vi.fn()}
      onCloseTmuxGroup={vi.fn()}
        onSelectHome={vi.fn()}
        onSelectSftp={vi.fn()}
        onSelectContainers={onSelectContainers}
        onSelectSession={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onCloseWorkspace={vi.fn().mockResolvedValue(undefined)}
        onStartSessionDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onReorderDynamicTab={vi.fn()}
        onCheckForUpdates={vi.fn().mockResolvedValue(undefined)}
        onDownloadUpdate={vi.fn().mockResolvedValue(undefined)}
        onInstallUpdate={vi.fn().mockResolvedValue(undefined)}
        onDismissUpdate={vi.fn().mockResolvedValue(undefined)}
        onOpenReleasePage={vi.fn().mockResolvedValue(undefined)}
        onMinimizeWindow={vi.fn().mockResolvedValue(undefined)}
        onMaximizeWindow={vi.fn().mockResolvedValue(undefined)}
        onRestoreWindow={vi.fn().mockResolvedValue(undefined)}
        onCloseWindow={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const selectButton = screen.getByText('Containers').closest('button');
    expect(selectButton).not.toBeNull();

    fireEvent.click(selectButton!);
    expect(onSelectContainers).toHaveBeenCalledTimes(1);
  });

  it('keeps inactive top-level tabs readable on the dark title bar', () => {
    renderTitleBar();

    const sftpButton = screen.getByRole('button', { name: 'SFTP' });
    // 비활성 고정탭은 바에 녹아들도록 투명 배경 + 가독성 있는 밝은 글자.
    expect(sftpButton.className).toContain('bg-transparent');
    expect(sftpButton.className).toContain('text-[rgba(243,247,251,0.74)]');
  });

  it('keeps titlebar chrome draggable while idle on macOS', () => {
    const { container } = renderTitleBar();

    const tabRegion = screen.getByTestId('titlebar-tab-region');
    const tabStrip = container.querySelector('[data-titlebar-tab-strip="true"]');

    expect(tabRegion.className).toContain('[-webkit-app-region:drag]');
    expect(tabStrip?.className).toContain('[-webkit-app-region:drag]');
  });

  it('keeps titlebar chrome draggable but session tabs no-drag while idle on Windows', () => {
    const tab = createSessionTab();
    const { container } = renderTitleBar({
      desktopPlatform: 'win32',
      tabs: [tab],
      tabStrip: [{ kind: 'session', sessionId: tab.sessionId }],
    });

    const header = container.querySelector('header');
    const tabRegion = screen.getByTestId('titlebar-tab-region');
    const tabStrip = container.querySelector('[data-titlebar-tab-strip="true"]');

    // 세션 탭 외의 상단바 chrome은 Windows에서도 창 드래그 영역이어야 한다(macOS 패리티).
    expect(header?.className).toContain('[-webkit-app-region:drag]');
    expect(tabRegion.className).toContain('[-webkit-app-region:drag]');
    expect(tabStrip?.className).toContain('[-webkit-app-region:drag]');

    // 세션 탭 pill 자체는 창 드래그 대상이 아니어야 한다(클릭·재정렬 유지).
    const pill = screen
      .getByRole('button', { name: 'mqtt/evo-parser' })
      .closest('.group');
    expect(pill?.className).toContain('[-webkit-app-region:no-drag]');
  });

  it('keeps fixed workspace tabs outside the scrollable session strip', () => {
    const tab = createSessionTab();
    const { container } = renderTitleBar({
      tabs: [tab],
      tabStrip: [{ kind: 'session', sessionId: tab.sessionId }],
    });

    const fixedTabs = screen.getByTestId('titlebar-fixed-tabs');
    const tabStrip = container.querySelector('[data-titlebar-tab-strip="true"]');
    const homeButton = screen.getByRole('button', { name: 'Home' });
    const sftpButton = screen.getByRole('button', { name: 'SFTP' });
    const sessionButton = screen.getByRole('button', { name: 'mqtt/evo-parser' });

    expect(fixedTabs).toContainElement(homeButton);
    expect(fixedTabs).toContainElement(sftpButton);
    expect(tabStrip).not.toContainElement(homeButton);
    expect(tabStrip).not.toContainElement(sftpButton);
    expect(tabStrip).toContainElement(sessionButton);
  });

  it('renders dynamic session tabs as a single pill with the close affordance inside', () => {
    const { container } = render(
      <AppTitleBar
        desktopPlatform="darwin"
        tabs={[
          {
            id: 'tab-1',
            stableId: 'tab-1',
            sessionId: 'session-1',
            source: 'host',
            hostId: 'host-1',
            title: 'mqtt/evo-parser',
            status: 'connected',
            lastEventAt: new Date().toISOString(),
          },
        ]}
        workspaces={[]}
        tabStrip={[{ kind: 'session', sessionId: 'session-1' }]}
        activeWorkspaceTab="home"
        draggedSession={null}
        updateState={createUpdateState()}
        windowState={{ isMaximized: false }}
      tmuxGroups={[]}
      hosts={[]}
      onSelectTmuxGroup={vi.fn()}
      onCloseTmuxGroup={vi.fn()}
        onSelectHome={vi.fn()}
        onSelectSftp={vi.fn()}
        onSelectContainers={vi.fn()}
        onSelectSession={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onCloseWorkspace={vi.fn().mockResolvedValue(undefined)}
        onStartSessionDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onReorderDynamicTab={vi.fn()}
        onCheckForUpdates={vi.fn().mockResolvedValue(undefined)}
        onDownloadUpdate={vi.fn().mockResolvedValue(undefined)}
        onInstallUpdate={vi.fn().mockResolvedValue(undefined)}
        onDismissUpdate={vi.fn().mockResolvedValue(undefined)}
        onOpenReleasePage={vi.fn().mockResolvedValue(undefined)}
        onMinimizeWindow={vi.fn().mockResolvedValue(undefined)}
        onMaximizeWindow={vi.fn().mockResolvedValue(undefined)}
        onRestoreWindow={vi.fn().mockResolvedValue(undefined)}
        onCloseWindow={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const sessionButton = screen.getByRole('button', { name: 'mqtt/evo-parser' });
    const closeButton = screen.getByRole('button', { name: 'mqtt/evo-parser 세션 종료' });
    const pill = sessionButton.closest('.group');

    expect(pill).toBeTruthy();
    // 비활성 세션탭도 옅은 배경+테두리로 경계가 보인다(어디까지 탭인지 알 수 있게).
    expect(pill?.className).toContain('bg-[rgba(255,255,255,0.07)]');
    expect(pill?.className).toContain('[-webkit-app-region:no-drag]');
    expect(pill?.contains(closeButton)).toBe(true);
    expect(container.querySelectorAll('.group').length).toBeGreaterThan(0);
  });

  it('temporarily marks the tab region no-drag while reordering a tab', () => {
    const tab = createSessionTab();
    const dataTransfer = {
      effectAllowed: 'move',
      setData: vi.fn(),
      getData: vi.fn(),
    };

    const { container } = renderTitleBar({
      tabs: [tab],
      tabStrip: [{ kind: 'session', sessionId: tab.sessionId }],
    });

    const sessionButton = screen.getByRole('button', { name: 'mqtt/evo-parser' });
    const pill = sessionButton.closest('.group');
    expect(pill).toBeTruthy();

    fireEvent.dragStart(pill!, { dataTransfer });

    const tabRegion = screen.getByTestId('titlebar-tab-region');
    const tabStrip = container.querySelector('[data-titlebar-tab-strip="true"]');

    expect(tabRegion.className).toContain('[-webkit-app-region:no-drag]');
    expect(tabStrip?.className).toContain('[-webkit-app-region:no-drag]');
  });

  it('marks the tab region no-drag while a workspace pane can be detached to tabs', () => {
    const { container } = renderTitleBar({
      draggedSession: {
        sessionId: 'session-1',
        source: 'workspace-pane',
        workspaceId: 'workspace-1',
      },
    });

    const tabRegion = screen.getByTestId('titlebar-tab-region');
    const tabStrip = container.querySelector('[data-titlebar-tab-strip="true"]');

    expect(tabRegion.className).toContain('[-webkit-app-region:no-drag]');
    expect(tabStrip?.className).toContain('[-webkit-app-region:no-drag]');
  });

  it('makes the active dynamic session tab visually distinct from inactive pills', () => {
    render(
      <AppTitleBar
        desktopPlatform="darwin"
        tabs={[
          {
            id: 'tab-1',
            stableId: 'tab-1',
            sessionId: 'session-1',
            source: 'host',
            hostId: 'host-1',
            title: 'mqtt/evo-parser',
            status: 'connected',
            lastEventAt: new Date().toISOString(),
          },
        ]}
        workspaces={[]}
        tabStrip={[{ kind: 'session', sessionId: 'session-1' }]}
        activeWorkspaceTab="session:session-1"
        draggedSession={null}
        updateState={createUpdateState()}
        windowState={{ isMaximized: false }}
      tmuxGroups={[]}
      hosts={[]}
      onSelectTmuxGroup={vi.fn()}
      onCloseTmuxGroup={vi.fn()}
        onSelectHome={vi.fn()}
        onSelectSftp={vi.fn()}
        onSelectContainers={vi.fn()}
        onSelectSession={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onCloseWorkspace={vi.fn().mockResolvedValue(undefined)}
        onStartSessionDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onReorderDynamicTab={vi.fn()}
        onCheckForUpdates={vi.fn().mockResolvedValue(undefined)}
        onDownloadUpdate={vi.fn().mockResolvedValue(undefined)}
        onInstallUpdate={vi.fn().mockResolvedValue(undefined)}
        onDismissUpdate={vi.fn().mockResolvedValue(undefined)}
        onOpenReleasePage={vi.fn().mockResolvedValue(undefined)}
        onMinimizeWindow={vi.fn().mockResolvedValue(undefined)}
        onMaximizeWindow={vi.fn().mockResolvedValue(undefined)}
        onRestoreWindow={vi.fn().mockResolvedValue(undefined)}
        onCloseWindow={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const sessionButton = screen.getByRole('button', { name: 'mqtt/evo-parser' });
    const pill = sessionButton.closest('.group');

    expect(pill).toBeTruthy();
    // 활성 세션탭은 흰 배경 + 어두운 글자로 비활성(옅은 배경/밝은 글자)과 또렷이 구분된다.
    expect(pill?.className).toContain('bg-[rgba(255,255,255,0.96)]');
    expect(sessionButton.className).toContain('text-[var(--chrome-bg)]');
  });

  it('hides the native scrollbar and shows edge fades when the titlebar tab strip overflows', () => {
    const tabs = Array.from({ length: 4 }, (_, index) => ({
      id: `tab-${index + 1}`,
      stableId: `tab-${index + 1}`,
      sessionId: `session-${index + 1}`,
      source: 'host' as const,
      hostId: `host-${index + 1}`,
      title: `Session ${index + 1}`,
      status: 'connected' as const,
      lastEventAt: new Date().toISOString(),
    }));

    const { container } = render(
      <AppTitleBar
        desktopPlatform="darwin"
        tabs={tabs}
        workspaces={[]}
        tabStrip={tabs.map((tab) => ({ kind: 'session' as const, sessionId: tab.sessionId }))}
        activeWorkspaceTab="session:session-4"
        draggedSession={null}
        updateState={createUpdateState()}
        windowState={{ isMaximized: false }}
      tmuxGroups={[]}
      hosts={[]}
      onSelectTmuxGroup={vi.fn()}
      onCloseTmuxGroup={vi.fn()}
        onSelectHome={vi.fn()}
        onSelectSftp={vi.fn()}
        onSelectContainers={vi.fn()}
        onSelectSession={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onCloseWorkspace={vi.fn().mockResolvedValue(undefined)}
        onStartSessionDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onReorderDynamicTab={vi.fn()}
        onCheckForUpdates={vi.fn().mockResolvedValue(undefined)}
        onDownloadUpdate={vi.fn().mockResolvedValue(undefined)}
        onInstallUpdate={vi.fn().mockResolvedValue(undefined)}
        onDismissUpdate={vi.fn().mockResolvedValue(undefined)}
        onOpenReleasePage={vi.fn().mockResolvedValue(undefined)}
        onMinimizeWindow={vi.fn().mockResolvedValue(undefined)}
        onMaximizeWindow={vi.fn().mockResolvedValue(undefined)}
        onRestoreWindow={vi.fn().mockResolvedValue(undefined)}
        onCloseWindow={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const tabStrip = container.querySelector(
      '[data-titlebar-tab-strip="true"]',
    ) as HTMLDivElement | null;
    expect(tabStrip).not.toBeNull();
    if (!tabStrip) {
      throw new Error('expected titlebar tab strip');
    }

    let scrollLeft = 0;
    Object.defineProperty(tabStrip, 'clientWidth', {
      configurable: true,
      get: () => 260,
    });
    Object.defineProperty(tabStrip, 'scrollWidth', {
      configurable: true,
      get: () => 720,
    });
    Object.defineProperty(tabStrip, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
    });

    fireEvent.scroll(tabStrip);
    expect(screen.queryByTestId('titlebar-tab-strip-fade-left')).not.toBeInTheDocument();
    expect(screen.getByTestId('titlebar-tab-strip-fade-right')).toBeInTheDocument();

    scrollLeft = 180;
    fireEvent.scroll(tabStrip);
    expect(screen.getByTestId('titlebar-tab-strip-fade-left')).toBeInTheDocument();
    expect(screen.getByTestId('titlebar-tab-strip-fade-right')).toBeInTheDocument();
  });
});
