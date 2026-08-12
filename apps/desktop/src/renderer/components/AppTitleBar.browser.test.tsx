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
    onSetRdpMonitors: vi.fn(),
    resolveRdpMonitors: () => null,
    desktopPlatform: 'darwin',
    tabs: [],
    workspaces: [],
    tabStrip: [],
    activeWorkspaceTab: 'home',
    draggedSession: null,
    updateState: createUpdateState(),
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
    onToggleFullScreenWindow: vi.fn().mockResolvedValue(undefined),
    onCloseWindow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  return render(<AppTitleBar {...props} />);
}

describe('AppTitleBar update popover', () => {
  it('keeps update details while downloading and shows a direct install button when ready', () => {
    const onDownloadUpdate = vi.fn().mockResolvedValue(undefined);
    const onInstallUpdate = vi.fn().mockResolvedValue(undefined);
    const release = {
      version: '1.1.0',
      releaseName: 'Dolgate 1.1.0',
      releaseNotes: null,
      publishedAt: null,
    };
    const { unmount } = renderTitleBar({
      updateState: {
        ...createUpdateState(),
        status: 'available',
        release,
      },
      onDownloadUpdate,
      onInstallUpdate,
    });

    fireEvent.click(screen.getByRole('button', { name: '업데이트 상태 보기' }));

    expect(screen.getByText(/백그라운드 다운로드를 준비/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '다운로드' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '나중에' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '업데이트 확인' })).not.toBeInTheDocument();
    expect(onDownloadUpdate).not.toHaveBeenCalled();

    unmount();
    renderTitleBar({
      updateState: {
        ...createUpdateState(),
        status: 'downloaded',
        release,
      },
      onDownloadUpdate,
      onInstallUpdate,
    });
    expect(screen.queryByRole('button', { name: '업데이트 상태 보기' })).not.toBeInTheDocument();
    const installButton = screen.getByRole('button', { name: '업데이트' });
    expect(installButton).toHaveTextContent('업데이트');

    fireEvent.mouseEnter(installButton);
    expect(screen.getByRole('tooltip')).toHaveTextContent('v1.1.0 업데이트 준비됨');

    fireEvent.click(installButton);
    expect(onInstallUpdate).toHaveBeenCalledTimes(1);
  });

  // Installing quits and relaunches, so the button has to say it is working or
  // the wait before the window disappears looks like a dropped click.
  it('shows progress on the install button and ignores further clicks', async () => {
    const onInstallUpdate = vi.fn(() => new Promise<void>(() => {}));
    renderTitleBar({
      updateState: {
        ...createUpdateState(),
        status: 'downloaded',
        release: { version: 'v1.1.0', publishedAt: '2026-04-13T00:00:00.000Z' },
      },
      onInstallUpdate,
    });

    fireEvent.click(screen.getByRole('button', { name: '업데이트' }));

    const installing = await screen.findByRole('button', { name: '업데이트' });
    expect(installing).toHaveTextContent('설치 중…');
    expect(installing).toBeDisabled();
    expect(installing).toHaveAttribute('aria-busy', 'true');

    fireEvent.click(installing);
    expect(onInstallUpdate).toHaveBeenCalledTimes(1);
  });

  // The updater reports failure through updateState rather than by rejecting, so
  // that is what has to bring the button back.
  it('restores the install button when the update fails', async () => {
    const onInstallUpdate = vi.fn(() => new Promise<void>(() => {}));
    const downloaded = {
      ...createUpdateState(),
      status: 'downloaded' as const,
      release: { version: 'v1.1.0', publishedAt: '2026-04-13T00:00:00.000Z' },
    };
    const { unmount } = renderTitleBar({ updateState: downloaded, onInstallUpdate });

    fireEvent.click(screen.getByRole('button', { name: '업데이트' }));
    expect(await screen.findByRole('button', { name: '업데이트' })).toBeDisabled();

    unmount();
    renderTitleBar({
      updateState: { ...downloaded, status: 'error', errorMessage: '설치 실패' },
      onInstallUpdate,
    });

    expect(
      screen.queryByRole('button', { name: '업데이트 상태 보기' }),
    ).toBeInTheDocument();
  });

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
        windowState={{ isMaximized: false, isFullScreen: false }}
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
        onToggleFullScreenWindow={vi.fn().mockResolvedValue(undefined)}
        onSetRdpMonitors={vi.fn()}
        resolveRdpMonitors={() => null}
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

  it('renders custom window controls on Linux', () => {
    const onMinimizeWindow = vi.fn().mockResolvedValue(undefined);
    const onToggleFullScreenWindow = vi.fn().mockResolvedValue(undefined);
    const onCloseWindow = vi.fn().mockResolvedValue(undefined);

    renderTitleBar({
      desktopPlatform: 'linux',
      onMinimizeWindow,
      onToggleFullScreenWindow,
      onCloseWindow,
    });

    fireEvent.click(screen.getByRole('button', { name: '최소화' }));
    // 가운데 버튼은 최대화가 아니라 전체화면이다. 최대화는 드래그 영역 더블클릭으로 OS 가 해 준다.
    fireEvent.click(screen.getByRole('button', { name: '전체화면 (F11)' }));
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));

    expect(onMinimizeWindow).toHaveBeenCalledTimes(1);
    expect(onToggleFullScreenWindow).toHaveBeenCalledTimes(1);
    expect(onCloseWindow).toHaveBeenCalledTimes(1);
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
        windowState={{ isMaximized: false, isFullScreen: false }}
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
        onToggleFullScreenWindow={vi.fn().mockResolvedValue(undefined)}
        onSetRdpMonitors={vi.fn()}
        resolveRdpMonitors={() => null}
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
        windowState={{ isMaximized: false, isFullScreen: false }}
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
        onToggleFullScreenWindow={vi.fn().mockResolvedValue(undefined)}
        onSetRdpMonitors={vi.fn()}
        resolveRdpMonitors={() => null}
        onCloseWindow={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const sessionButton = screen.getByRole('button', { name: 'mqtt/evo-parser' });
    const pill = sessionButton.closest('.group');

    expect(pill).toBeTruthy();
    // 활성 세션탭은 콘텐츠 배경(--app-bg)에 도킹된 색 + 본문 글자색으로 비활성(옅은
    // 배경/밝은 글자)과 구분된다 — 다크 테마에서 흰 알약이 튀지 않게 테마 토큰 사용.
    expect(pill?.className).toContain('bg-[var(--app-bg)]');
    expect(sessionButton.className).toContain('text-[var(--text)]');
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
        windowState={{ isMaximized: false, isFullScreen: false }}
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
        onToggleFullScreenWindow={vi.fn().mockResolvedValue(undefined)}
        onSetRdpMonitors={vi.fn()}
        resolveRdpMonitors={() => null}
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
      set: (value: number) => {
        scrollLeft = value;
      },
    });

    fireEvent.wheel(tabStrip, { deltaX: 0, deltaY: 120 });
    expect(scrollLeft).toBe(120);

    scrollLeft = 0;
    fireEvent.scroll(tabStrip);
    expect(screen.queryByTestId('titlebar-tab-strip-fade-left')).not.toBeInTheDocument();
    expect(screen.getByTestId('titlebar-tab-strip-fade-right')).toBeInTheDocument();

    scrollLeft = 180;
    fireEvent.scroll(tabStrip);
    expect(screen.getByTestId('titlebar-tab-strip-fade-left')).toBeInTheDocument();
    expect(screen.getByTestId('titlebar-tab-strip-fade-right')).toBeInTheDocument();
  });
});

// 전체화면에서 이 바는 상단 가장자리에 마우스를 올려야 내려온다. 그렇게 불러낸 바에서 나가는 길이
// 버튼 하나뿐이면 F11 을 모르는 사용자는 갇힌다. 창 모드의 캡션 더블클릭(최대화)과 같은 자리·같은
// 동작이라 배우지 않아도 짚인다.
describe('AppTitleBar full-screen exit by double click', () => {
  // 배경은 헤더·탭 영역·스트립·여백이 겹쳐 만드는 면이다. 어디를 더블클릭하든 한 번만 먹어야 한다 —
  // 처음에는 요소마다 핸들러를 붙여서 버블링으로 두 번 불렸고, 전체화면이 나갔다 다시 들어왔다.
  it.each([
    ['tab region', 'titlebar-tab-region'],
    ['tab strip', null],
  ])('leaves full screen once when the %s background is double clicked', (_label, testId) => {
    const onToggleFullScreenWindow = vi.fn().mockResolvedValue(undefined);
    const { container } = renderTitleBar({
      desktopPlatform: 'win32',
      windowState: { isMaximized: false, isFullScreen: true },
      onToggleFullScreenWindow,
    });

    const target = testId
      ? screen.getByTestId(testId)
      : container.querySelector('[data-titlebar-tab-strip="true"]');
    expect(target).not.toBeNull();
    fireEvent.doubleClick(target as Element);

    expect(onToggleFullScreenWindow).toHaveBeenCalledTimes(1);
  });

  // 탭은 div 라서 button 검사만으로는 걸리지 않는다. 탭을 두 번 눌러 전체화면이 꺼지면, 탭을 빠르게
  // 두 번 고르는 평범한 조작이 화면 모드를 바꿔 버린다.
  it('ignores a double click on a tab', () => {
    const onToggleFullScreenWindow = vi.fn().mockResolvedValue(undefined);
    const { container } = renderTitleBar({
      desktopPlatform: 'win32',
      windowState: { isMaximized: false, isFullScreen: true },
      tabs: [createSessionTab()],
      tabStrip: [{ kind: 'session', sessionId: 'session-1' }],
      onToggleFullScreenWindow,
    });

    const tab = container.querySelector('[data-titlebar-tab-item]');
    expect(tab).not.toBeNull();
    fireEvent.doubleClick(tab as Element);

    expect(onToggleFullScreenWindow).not.toHaveBeenCalled();
  });

  // 창 모드에서는 그 자리가 OS 캡션이다(드래그·더블클릭 최대화를 Windows 가 처리한다). 우리가
  // 가로채면 최대화가 전체화면으로 바뀌어, 사용자가 기대한 것과 다른 일이 일어난다.
  it('leaves the windowed double click to the OS', () => {
    const onToggleFullScreenWindow = vi.fn().mockResolvedValue(undefined);
    renderTitleBar({
      desktopPlatform: 'win32',
      windowState: { isMaximized: false, isFullScreen: false },
      onToggleFullScreenWindow,
    });

    fireEvent.doubleClick(screen.getByTestId('titlebar-tab-region'));

    expect(onToggleFullScreenWindow).not.toHaveBeenCalled();
  });

  // 드래그 영역이 켜져 있으면 그 배경은 OS 캡션으로 취급돼 더블클릭이 페이지까지 오지 않는다.
  // 전체화면에서는 창을 옮길 수 없으므로 드래그를 끄고 더블클릭을 받는다 — 이 클래스가 되돌아가면
  // 위 동작이 조용히 죽는다.
  it('drops the drag region while full screen so the double click reaches us', () => {
    const { container } = renderTitleBar({
      desktopPlatform: 'win32',
      windowState: { isMaximized: false, isFullScreen: true },
    });

    const header = container.querySelector('header');
    expect(header?.className).toContain('[-webkit-app-region:no-drag]');
    expect(header?.className).not.toContain('[-webkit-app-region:drag]');
  });

  it('keeps the drag region in windowed mode', () => {
    const { container } = renderTitleBar({
      desktopPlatform: 'win32',
      windowState: { isMaximized: false, isFullScreen: false },
    });

    expect(container.querySelector('header')?.className).toContain(
      '[-webkit-app-region:drag]',
    );
  });
});
