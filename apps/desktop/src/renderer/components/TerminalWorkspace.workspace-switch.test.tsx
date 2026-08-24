import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, HostRecord, TerminalTab } from '@shared';
import type { WorkspaceTab } from '../store/createAppStore';
import { SESSION_SHARE_CHAT_TOAST_TTL_MS, TerminalWorkspace } from './TerminalWorkspace';

const mocks = vi.hoisted(() => ({
  storeState: {} as any,
  desktopApi: null as any,
  runtimeRecords: [] as any[],
  schedulerRecords: [] as any[]
}));

vi.mock('../store/appStore', () => ({
  useAppStore: (selector: (state: any) => unknown) => selector(mocks.storeState),
  appStore: { getState: () => mocks.storeState },
  get desktopApi() {
    return mocks.desktopApi;
  }
}));

vi.mock('../lib/terminal-runtime', () => ({
  createTerminalRuntime: vi.fn(
    ({ container, onData, onBinary }: { container: HTMLElement; onData: (value: string) => void; onBinary: (value: string) => void }) => {
    const terminal = {
      rows: 24,
      cols: 80,
      refresh: vi.fn(),
      focus: vi.fn(),
      // 명령 블록 점프(Cmd/Ctrl+↑↓)용 키 핸들러를 컨트롤러가 등록한다.
      attachCustomKeyEventHandler: vi.fn(),
      // 블록 오버레이가 스크롤/렌더에 맞춰 위치를 다시 계산하려고 구독한다.
      onRender: vi.fn(() => ({ dispose: vi.fn() })),
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      buffer: {
        active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0 }
      }
    };
    const runtime = {
      terminal,
      fitAddon: { fit: vi.fn() },
      write: vi.fn(),
      scheduleAfterWriteDrain: vi.fn(),
      captureSnapshot: vi.fn(() => ''),
      captureRestoreSnapshot: vi.fn(() => ''),
      setAppearance: vi.fn(),
      setWebglEnabled: vi.fn().mockResolvedValue(undefined),
      repaint: vi.fn(),
      syncDisplayMetrics: vi.fn(),
      focus: vi.fn(() => {
        container.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      }),
      emitData: onData,
      emitBinary: onBinary,
      findNext: vi.fn(() => false),
      findPrevious: vi.fn(() => false),
      clearSearch: vi.fn(),
      blurSearch: vi.fn(),
      dispose: vi.fn()
    };
    mocks.runtimeRecords.push(runtime);
    return runtime;
  })
}));

vi.mock('./terminal-resize', () => ({
  createTerminalResizeScheduler: vi.fn(() => {
    const scheduler = {
      request: vi.fn(),
      reset: vi.fn()
    };
    mocks.schedulerRecords.push(scheduler);
    return scheduler;
  })
}));

const settings: AppSettings = {
  theme: 'system',
  tailnetHostname: null,
  rdpMonitorsByHostId: {},
  globalTerminalThemeId: 'dolssh-dark',
  terminalFontFamily: 'sf-mono',
  terminalFontSize: 13,
  terminalScrollbackLines: 5000,
  terminalLineHeight: 1,
  terminalLetterSpacing: 0,
  terminalMinimumContrastRatio: 1,
  terminalAltIsMeta: false,
  terminalWebglEnabled: true,
  terminalAutocompleteEnabled: false,
  sftpBrowserColumnWidths: {
    name: 360,
    dateModified: 168,
    size: 96,
    kind: 96
  },
  sessionReplayRetentionCount: 100,
  commandNotificationsEnabled: true,
  commandNotificationThresholdSeconds: 30,
  commandNotificationOnlyWhenUnfocused: true,
  commandNotificationOnFailure: true,
  commandNotificationSound: false,
  hostMetricsEnabled: false,
  autoReconnectEnabled: true,
  autoReconnectMaxAttempts: 10,
  autoReconnectBaseDelayMs: 1000,
  autoReconnectMaxDelayMs: 30000,
  serverUrl: 'https://example.test',
  serverUrlOverride: null,
  updatedAt: '2025-01-01T00:00:00.000Z'
};

const tabs: TerminalTab[] = [
  {
    id: 'tab-1',
    stableId: 'tab-1',
    sessionId: 'session-1',
    source: 'local',
    hostId: null,
    title: 'Session 1',
    status: 'connected',
    sessionShare: null,
    hasReceivedOutput: true,
    lastEventAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'tab-2',
    stableId: 'tab-2',
    sessionId: 'session-2',
    source: 'local',
    hostId: null,
    title: 'Session 2',
    status: 'connected',
    sessionShare: null,
    hasReceivedOutput: true,
    lastEventAt: '2025-01-01T00:00:00.000Z'
  }
];

const splitHostTabs: TerminalTab[] = [
  {
    id: 'tab-1',
    stableId: 'tab-1',
    sessionId: 'session-1',
    source: 'host',
    hostId: 'host-1',
    title: 'Session 1',
    status: 'connected',
    sessionShare: null,
    hasReceivedOutput: true,
    lastEventAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'tab-2',
    stableId: 'tab-2',
    sessionId: 'session-2',
    source: 'host',
    hostId: 'host-2',
    title: 'Session 2',
    status: 'connected',
    sessionShare: null,
    hasReceivedOutput: true,
    lastEventAt: '2025-01-01T00:00:00.000Z'
  }
];

const hostRecords: HostRecord[] = [
  {
    id: 'host-1',
    kind: 'ssh',
    label: 'Prod 1',
    hostname: 'prod-1.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: 'host:host-1',
    groupName: 'Servers',
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'host-2',
    kind: 'ssh',
    label: 'Prod 2',
    hostname: 'prod-2.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: 'host:host-2',
    groupName: 'Servers',
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  }
];

const workspaceA: WorkspaceTab = {
  id: 'workspace-a',
  title: 'Workspace A',
  layout: {
    id: 'leaf-a',
    kind: 'leaf',
    sessionId: 'session-1'
  },
  activeSessionId: 'session-1',
  broadcastEnabled: false
};

const workspaceB: WorkspaceTab = {
  id: 'workspace-b',
  title: 'Workspace B',
  layout: {
    id: 'leaf-b',
    kind: 'leaf',
    sessionId: 'session-2'
  },
  activeSessionId: 'session-2',
  broadcastEnabled: false
};

const sharedSessionWorkspaceA: WorkspaceTab = {
  id: 'workspace-a',
  title: 'Workspace A',
  layout: {
    id: 'leaf-shared-a',
    kind: 'leaf',
    sessionId: 'session-1'
  },
  activeSessionId: 'session-1',
  broadcastEnabled: false
};

const sharedSessionWorkspaceB: WorkspaceTab = {
  id: 'workspace-b',
  title: 'Workspace B',
  layout: {
    id: 'leaf-shared-b',
    kind: 'leaf',
    sessionId: 'session-1'
  },
  activeSessionId: 'session-1',
  broadcastEnabled: false
};

const splitWorkspace: WorkspaceTab = {
  id: 'workspace-split',
  title: 'Workspace Split',
  layout: {
    id: 'split-1',
    kind: 'split',
    axis: 'horizontal',
    ratio: 0.5,
    first: {
      id: 'leaf-left',
      kind: 'leaf',
      sessionId: 'session-1'
    },
    second: {
      id: 'leaf-right',
      kind: 'leaf',
      sessionId: 'session-2'
    }
  },
  activeSessionId: 'session-1',
  broadcastEnabled: false
};

// 공유 팝오버는 **pane 헤더 안에만** 있다 — 단독 화면에 떠 있던 알약은 세션 패널의 `공유`
// 섹션으로 갔다(SessionPanelShare). 그래서 팝오버를 보려면 워크스페이스 pane 으로 그린다.
// 잎 하나짜리도 헤더가 붙는다(showHeader = activeWorkspace && placement).
const sharePaneWorkspace: WorkspaceTab = {
  id: 'workspace-share',
  title: 'Workspace Share',
  layout: {
    id: 'leaf-share',
    kind: 'leaf',
    sessionId: 'session-1'
  },
  activeSessionId: 'session-1',
  broadcastEnabled: false
};

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

function createMockStoreState() {
  return {
    tabs,
    hosts: [],
    sessionShareChatNotifications: {},
    dismissSessionShareChatNotification: vi.fn(),
    pendingInteractiveAuths: [],
    respondInteractiveAuth: vi.fn(),
    reopenInteractiveAuthUrl: vi.fn(),
    clearPendingInteractiveAuth: vi.fn(),
    updatePendingConnectionSize: vi.fn(),
    markSessionOutput: vi.fn()
  };
}

function dispatchDragEvent(
  target: HTMLElement,
  type: 'dragover' | 'drop',
  point: { clientX: number; clientY: number }
) {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true
  });
  Object.defineProperty(event, 'clientX', {
    configurable: true,
    value: point.clientX
  });
  Object.defineProperty(event, 'clientY', {
    configurable: true,
    value: point.clientY
  });
  fireEvent(target, event);
}

function renderWorkspace(input: {
  activeWorkspace: WorkspaceTab | null;
  activeSessionId?: string | null;
  viewActivationKey: string | null;
  tabs?: TerminalTab[];
  hosts?: HostRecord[];
  draggedSession?: { sessionId: string; source: 'standalone-tab' | 'workspace-pane'; workspaceId?: string } | null;
  canDropDraggedSession?: boolean;
  onSplitSessionDrop?: (sessionId: string, direction: any, targetSessionId?: string) => boolean;
  onMoveWorkspaceSession?: (workspaceId: string, sessionId: string, direction: any, targetSessionId: string) => boolean;
  onFocusWorkspaceSession?: (workspaceId: string, sessionId: string) => void;
  onToggleSessionBroadcast?: (workspaceId: string, sessionId: string) => void;
  onToggleWorkspaceZoom?: (workspaceId: string, sessionId: string) => void;
  onDetachSessionToStandalone?: (workspaceId: string, sessionId: string) => void;
}) {
  const renderTabs = input.tabs ?? tabs;
  const renderHosts = input.hosts ?? [];
  mocks.storeState = {
    ...createMockStoreState(),
    ...mocks.storeState,
    tabs: renderTabs,
    hosts: renderHosts
  };
  return render(
    <TerminalWorkspace
      tabs={renderTabs}
      hosts={renderHosts}
      settings={settings}
      prefersDark={false}
      activeSessionId={input.activeSessionId ?? null}
      activeWorkspace={input.activeWorkspace}
      viewActivationKey={input.viewActivationKey}
      draggedSession={input.draggedSession ?? null}
      canDropDraggedSession={input.canDropDraggedSession ?? false}
      onCloseSession={vi.fn().mockResolvedValue(undefined)}
      onRetryConnection={vi.fn().mockResolvedValue(undefined)}
      onCancelReconnect={vi.fn()}
      onStartSessionShare={vi.fn().mockResolvedValue(undefined)}
      onUpdateSessionShareSnapshot={vi.fn().mockResolvedValue(undefined)}
      onSetSessionShareInputEnabled={vi.fn().mockResolvedValue(undefined)}
      onStopSessionShare={vi.fn().mockResolvedValue(undefined)}
      onStartPaneDrag={vi.fn()}
      onEndSessionDrag={vi.fn()}
      onSplitSessionDrop={input.onSplitSessionDrop ?? vi.fn(() => false)}
      onMoveWorkspaceSession={input.onMoveWorkspaceSession ?? vi.fn(() => false)}
      onFocusWorkspaceSession={input.onFocusWorkspaceSession ?? vi.fn()}
      onToggleSessionBroadcast={input.onToggleSessionBroadcast ?? vi.fn()}
      onToggleWorkspaceZoom={input.onToggleWorkspaceZoom ?? vi.fn()}
      onDetachSessionToStandalone={input.onDetachSessionToStandalone ?? vi.fn()}
      onResizeWorkspaceSplit={vi.fn()}
    />
  );
}

describe('TerminalWorkspace workspace switching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeRecords.length = 0;
    mocks.schedulerRecords.length = 0;
    mocks.storeState = createMockStoreState();
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      value: {
        ssh: {
          onData: vi.fn(() => () => undefined),
          write: vi.fn().mockResolvedValue(undefined),
          writeBinary: vi.fn().mockResolvedValue(undefined),
          resize: vi.fn().mockResolvedValue(undefined),
          installShellIntegration: vi.fn().mockResolvedValue(undefined)
        }
      }
    });
    mocks.desktopApi = window.dolssh;
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    });
  });

  it('uses the latest workspace focus callback after switching workspaces', async () => {
    const onFocusWorkspaceSession = vi.fn();
    const { rerender } = renderWorkspace({
      activeWorkspace: workspaceA,
      viewActivationKey: 'workspace:workspace-a',
      onFocusWorkspaceSession
    });

    await waitFor(() => {
      expect(mocks.runtimeRecords).toHaveLength(2);
    });

    onFocusWorkspaceSession.mockClear();

    rerender(
      <TerminalWorkspace
        tabs={tabs}
        hosts={[]}
        settings={settings}
        prefersDark={false}
        activeSessionId={null}
        activeWorkspace={workspaceB}
        viewActivationKey="workspace:workspace-b"
        draggedSession={null}
        canDropDraggedSession={false}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onRetryConnection={vi.fn().mockResolvedValue(undefined)}
        onCancelReconnect={vi.fn()}
        onStartSessionShare={vi.fn().mockResolvedValue(undefined)}
        onUpdateSessionShareSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSetSessionShareInputEnabled={vi.fn().mockResolvedValue(undefined)}
        onStopSessionShare={vi.fn().mockResolvedValue(undefined)}
        onStartPaneDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onSplitSessionDrop={vi.fn(() => false)}
        onMoveWorkspaceSession={vi.fn(() => false)}
        onFocusWorkspaceSession={onFocusWorkspaceSession}
        onToggleSessionBroadcast={vi.fn()}
        onToggleWorkspaceZoom={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onResizeWorkspaceSplit={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(onFocusWorkspaceSession).toHaveBeenLastCalledWith('workspace-b', 'session-2');
    });
  });

  it('treats view activation changes as a display refresh signal', async () => {
    const { rerender } = renderWorkspace({
      activeWorkspace: sharedSessionWorkspaceA,
      viewActivationKey: 'workspace:workspace-a'
    });

    await waitFor(() => {
      expect(mocks.runtimeRecords).toHaveLength(2);
    });

    const firstRuntime = mocks.runtimeRecords[0];
    firstRuntime.focus.mockClear();
    firstRuntime.syncDisplayMetrics.mockClear();

    rerender(
      <TerminalWorkspace
        tabs={tabs}
        hosts={[]}
        settings={settings}
        prefersDark={false}
        activeSessionId={null}
        activeWorkspace={sharedSessionWorkspaceB}
        viewActivationKey="workspace:workspace-b"
        draggedSession={null}
        canDropDraggedSession={false}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onRetryConnection={vi.fn().mockResolvedValue(undefined)}
        onCancelReconnect={vi.fn()}
        onStartSessionShare={vi.fn().mockResolvedValue(undefined)}
        onUpdateSessionShareSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSetSessionShareInputEnabled={vi.fn().mockResolvedValue(undefined)}
        onStopSessionShare={vi.fn().mockResolvedValue(undefined)}
        onStartPaneDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onSplitSessionDrop={vi.fn(() => false)}
        onMoveWorkspaceSession={vi.fn(() => false)}
        onFocusWorkspaceSession={vi.fn()}
        onToggleSessionBroadcast={vi.fn()}
        onToggleWorkspaceZoom={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onResizeWorkspaceSplit={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(firstRuntime.syncDisplayMetrics).toHaveBeenCalled();
      expect(firstRuntime.focus).toHaveBeenCalled();
    });
  });

  it('routes same-workspace pane drops to moveWorkspaceSession and shows a preview', async () => {
    const onMoveWorkspaceSession = vi.fn(() => true);
    const onSplitSessionDrop = vi.fn(() => false);
    const { container } = renderWorkspace({
      activeWorkspace: splitWorkspace,
      viewActivationKey: 'workspace:workspace-split',
      draggedSession: {
        sessionId: 'session-1',
        source: 'workspace-pane',
        workspaceId: 'workspace-split'
      },
      onMoveWorkspaceSession,
      onSplitSessionDrop
    });

    await waitFor(() => {
      expect(container.querySelectorAll('[data-terminal-pane-slot="true"]')).toHaveLength(2);
    });

    const targetPane = screen.getByText('Session 2').closest('[data-terminal-pane-slot="true"]') as HTMLElement;
    targetPane.getBoundingClientRect = () =>
      ({
        left: 50,
        top: 0,
        width: 50,
        height: 100,
        right: 100,
        bottom: 100,
        x: 50,
        y: 0,
        toJSON: () => ({})
      }) as DOMRect;

    dispatchDragEvent(targetPane, 'dragover', { clientX: 52, clientY: 50 });
    await waitFor(() => {
      expect(container.querySelector('[data-workspace-drop-preview="true"]')).toBeTruthy();
    });

    dispatchDragEvent(targetPane, 'drop', { clientX: 52, clientY: 50 });

    expect(onMoveWorkspaceSession).toHaveBeenCalledWith('workspace-split', 'session-1', 'left', 'session-2');
    expect(onSplitSessionDrop).not.toHaveBeenCalled();
  });

  it('keeps standalone-tab drops on the existing splitSessionDrop path', async () => {
    const onMoveWorkspaceSession = vi.fn(() => false);
    const onSplitSessionDrop = vi.fn(() => true);
    const { container } = renderWorkspace({
      activeWorkspace: splitWorkspace,
      viewActivationKey: 'workspace:workspace-split',
      draggedSession: {
        sessionId: 'session-3',
        source: 'standalone-tab'
      },
      canDropDraggedSession: true,
      onMoveWorkspaceSession,
      onSplitSessionDrop
    });

    await waitFor(() => {
      expect(container.querySelectorAll('[data-terminal-pane-slot="true"]')).toHaveLength(2);
    });

    const targetPane = screen.getByText('Session 2').closest('[data-terminal-pane-slot="true"]') as HTMLElement;
    targetPane.getBoundingClientRect = () =>
      ({
        left: 50,
        top: 0,
        width: 50,
        height: 100,
        right: 100,
        bottom: 100,
        x: 50,
        y: 0,
        toJSON: () => ({})
      }) as DOMRect;

    dispatchDragEvent(targetPane, 'dragover', { clientX: 98, clientY: 50 });
    dispatchDragEvent(targetPane, 'drop', { clientX: 98, clientY: 50 });

    expect(onSplitSessionDrop).toHaveBeenCalledWith('session-3', 'right', 'session-2');
    expect(onMoveWorkspaceSession).not.toHaveBeenCalled();
  });

  it('ignores self-drops for workspace pane reordering', async () => {
    const onMoveWorkspaceSession = vi.fn(() => true);
    const { container } = renderWorkspace({
      activeWorkspace: splitWorkspace,
      viewActivationKey: 'workspace:workspace-split',
      draggedSession: {
        sessionId: 'session-1',
        source: 'workspace-pane',
        workspaceId: 'workspace-split'
      },
      onMoveWorkspaceSession
    });

    await waitFor(() => {
      expect(container.querySelectorAll('[data-terminal-pane-slot="true"]')).toHaveLength(2);
    });

    const ownPane = screen.getByText('Session 1').closest('[data-terminal-pane-slot="true"]') as HTMLElement;
    ownPane.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 50,
        height: 100,
        right: 50,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => ({})
      }) as DOMRect;

    dispatchDragEvent(ownPane, 'dragover', { clientX: 2, clientY: 50 });

    expect(container.querySelector('[data-workspace-drop-preview="true"]')).toBeFalsy();
    expect(onMoveWorkspaceSession).not.toHaveBeenCalled();
  });

  it('does not render the broadcast control for standalone sessions', () => {
    renderWorkspace({
      activeWorkspace: null,
      activeSessionId: 'session-1',
      viewActivationKey: 'session:session-1'
    });

    expect(screen.queryByRole('button', { name: '브로드캐스트 켜기' })).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows the broadcast control for split workspaces and keeps it unavailable without two connected remote panes', () => {
    const onToggleSessionBroadcast = vi.fn();
    renderWorkspace({
      activeWorkspace: splitWorkspace,
      viewActivationKey: 'workspace:workspace-split',
      onToggleSessionBroadcast
    });

    // 아이콘은 pane 헤더마다 하나씩 뜬다(예전에는 워크스페이스에 떠 있는 버튼 하나였다).
    const toggleButtons = screen.getAllByRole('button', { name: '브로드캐스트 켜기' });
    expect(toggleButtons).toHaveLength(2);

    for (const button of toggleButtons) {
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).toHaveAttribute('aria-pressed', 'false');
      // 왜 눌리지 않는지는 title 로만 알린다 — 헤더는 좁아서 툴팁 상자를 띄울 자리가 없다.
      expect(button).toHaveAttribute('title', '원격 pane 2개 이상 연결 시 사용 가능');
    }

    fireEvent.click(toggleButtons[0]!);
    expect(onToggleSessionBroadcast).not.toHaveBeenCalled();
  });

  it('toggles broadcast button state and tooltip copy for split host workspaces', () => {
    const hostTabs: TerminalTab[] = [
      {
        id: 'tab-1',
        stableId: 'tab-1',
        sessionId: 'session-1',
        source: 'host',
        hostId: 'host-1',
        title: 'Session 1',
        status: 'connected',
        sessionShare: null,
        hasReceivedOutput: true,
        lastEventAt: '2025-01-01T00:00:00.000Z'
      },
      {
        id: 'tab-2',
        stableId: 'tab-2',
        sessionId: 'session-2',
        source: 'host',
        hostId: 'host-2',
        title: 'Session 2',
        status: 'connected',
        sessionShare: null,
        hasReceivedOutput: true,
        lastEventAt: '2025-01-01T00:00:00.000Z'
      }
    ];
    const onToggleSessionBroadcast = vi.fn();
    const { rerender } = renderWorkspace({
      activeWorkspace: splitWorkspace,
      tabs: hostTabs,
      hosts: hostRecords,
      viewActivationKey: 'workspace:workspace-split',
      onToggleSessionBroadcast
    });

    const enableButtons = screen.getAllByRole('button', { name: '브로드캐스트 켜기' });
    expect(enableButtons).toHaveLength(2);
    expect(enableButtons[0]).toHaveAttribute('aria-pressed', 'false');
    expect(enableButtons[0]).toHaveAttribute('aria-disabled', 'false');
    expect(enableButtons[0]).toHaveAttribute('title', '브로드캐스트 켜기');

    // 어느 pane 을 눌렀는지가 스토어까지 가야 한다 — 참여를 pane 단위로 관리하므로
    // 워크스페이스 id 만으로는 어느 pane 을 뺄지 알 수 없다.
    fireEvent.click(enableButtons[0]!);
    expect(onToggleSessionBroadcast).toHaveBeenCalledWith(
      'workspace-split',
      'session-1',
    );

    rerender(
      <TerminalWorkspace
        tabs={hostTabs}
        hosts={hostRecords}
        settings={settings}
        prefersDark={false}
        activeSessionId={null}
        activeWorkspace={{ ...splitWorkspace, broadcastEnabled: true }}
        viewActivationKey="workspace:workspace-split"
        draggedSession={null}
        canDropDraggedSession={false}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onRetryConnection={vi.fn().mockResolvedValue(undefined)}
        onCancelReconnect={vi.fn()}
        onStartSessionShare={vi.fn().mockResolvedValue(undefined)}
        onUpdateSessionShareSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSetSessionShareInputEnabled={vi.fn().mockResolvedValue(undefined)}
        onStopSessionShare={vi.fn().mockResolvedValue(undefined)}
        onStartPaneDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onSplitSessionDrop={vi.fn(() => false)}
        onMoveWorkspaceSession={vi.fn(() => false)}
        onFocusWorkspaceSession={vi.fn()}
        onToggleSessionBroadcast={onToggleSessionBroadcast}
        onToggleWorkspaceZoom={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onResizeWorkspaceSplit={vi.fn()}
      />
    );

    // 켜면 두 pane 이 모두 참여 상태가 된다(제외 목록이 비어 있으므로).
    const disableButtons = screen.getAllByRole('button', { name: '브로드캐스트 끄기' });
    expect(disableButtons).toHaveLength(2);
    for (const button of disableButtons) {
      expect(button).toHaveAttribute('aria-pressed', 'true');
      expect(button).toHaveAttribute('title', '브로드캐스트 활성 상태');
    }
  });

  // 헤더와 터미널은 위아래로 맞붙어 한 상자로 읽혀야 한다 — 헤더가 border-b-0, 터미널이
  // border-t-0 이라 둘이 붙어야 테두리가 이어진다. pane 루트에 flex gap 이 남아 있으면 그
  // 사이가 벌어져 테두리가 끊긴 것처럼 보였다(실제로 그렇게 보였고 이 테스트가 그 재발을 막는다).
  it('keeps the pane header flush with the terminal so the border reads as one box', () => {
    renderWorkspace({
      activeWorkspace: splitWorkspace,
      viewActivationKey: 'workspace:workspace-split'
    });

    const headerTitle = screen.getAllByRole('button', { name: 'Session 1' })[0]!;
    const header = headerTitle.closest('[draggable]');
    expect(header).not.toBeNull();
    expect(header!.className).toContain('border-b-0');

    const paneRoot = header!.parentElement!;
    expect(paneRoot.className).toContain('gap-0');
  });

  it('asks to zoom the pane that was clicked', () => {
    const onToggleWorkspaceZoom = vi.fn();
    renderWorkspace({
      activeWorkspace: splitWorkspace,
      viewActivationKey: 'workspace:workspace-split',
      onToggleWorkspaceZoom
    });

    const zoomButtons = screen.getAllByRole('button', { name: '이 pane 만 크게 보기' });
    expect(zoomButtons).toHaveLength(2);

    fireEvent.click(zoomButtons[0]!);
    expect(onToggleWorkspaceZoom).toHaveBeenCalledWith('workspace-split', 'session-1');
  });

  // 확대는 레이아웃 트리를 고치지 않고 배치만 갈아끼운다. 그래서 확인할 것은 두 가지다 —
  // 확대한 pane 이 전체를 차지하는가, 그리고 나눌 경계가 없으니 크기 조절 핸들이 사라지는가.
  it('gives the zoomed pane the whole workspace and drops the resize handles', () => {
    const { container } = renderWorkspace({
      activeWorkspace: { ...splitWorkspace, zoomedSessionId: 'session-2' },
      viewActivationKey: 'workspace:workspace-split'
    });

    expect(
      container.querySelectorAll('[data-workspace-split-handle="true"]'),
    ).toHaveLength(0);

    const slots = container.querySelectorAll('[data-terminal-pane-slot="true"]');
    expect(slots).toHaveLength(1);
    expect((slots[0] as HTMLElement).style.width).toBe('100%');
    expect((slots[0] as HTMLElement).style.height).toBe('100%');

    // 확대 중에는 그 pane 의 헤더만 남고, 아이콘이 되돌리기로 바뀐다.
    expect(
      screen.getByRole('button', { name: '분할로 되돌리기' }),
    ).toBeTruthy();
  });

  // 분할에서 빼내 독립 탭으로 되돌리는 기능은 원래 있었지만 진입 경로가 드래그뿐이라
  // 발견하기 어려웠다. 헤더 버튼이 같은 액션으로 이어지는지 고정한다.
  it('detaches the pane to its own tab from the header button', () => {
    const onDetachSessionToStandalone = vi.fn();
    renderWorkspace({
      activeWorkspace: splitWorkspace,
      viewActivationKey: 'workspace:workspace-split',
      onDetachSessionToStandalone
    });

    const detachButtons = screen.getAllByRole('button', { name: '독립 탭으로 빼내기' });
    fireEvent.click(detachButtons[1]!);
    expect(onDetachSessionToStandalone).toHaveBeenCalledWith(
      'workspace-split',
      'session-2',
    );
  });

  // 쿼리를 배치된 pane(`data-terminal-pane-slot`)으로 좁히는 이유: 배치되지 않은 pane 도
  // DOM 에는 남고(display:none), 헤더가 없어 플로팅 버튼을 그린다. 실제 화면에서는 안 보이지만
  // jsdom 은 Tailwind 를 적용하지 않아 그대로 잡힌다.
  function placedPanes(container: HTMLElement) {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[data-terminal-pane-slot="true"]'),
    );
  }

  // AI 토글은 pane 헤더에서 세션 패널의 섹션으로 옮겼다(상단 바 토글 · ⌘I). 그래서 pane 위에
  // 뜨는 버튼은 Share 뿐이다 — 공유를 시작하는 경로가 그 팝오버뿐이라 좁은 pane 에서도 남긴다.
  it('keeps Share reachable in split panes and no longer draws an AI toggle', () => {
    const { container } = renderWorkspace({
      activeWorkspace: splitWorkspace,
      tabs: splitHostTabs,
      hosts: hostRecords,
      viewActivationKey: 'workspace:workspace-split'
    });

    const panes = placedPanes(container);
    expect(panes).toHaveLength(2);
    for (const pane of panes) {
      expect(
        within(pane).queryByRole('button', { name: 'AI 어시스턴트 열기' }),
      ).toBeNull();
      expect(within(pane).getByRole('button', { name: 'Share' })).toBeTruthy();
    }
  });

  it('분할에서는 하단 상태바를 그리지 않는다 — 화면을 혼자 쓸 때만 둔다', () => {
    // pane 마다 바가 하나씩 붙으면 화면 아래가 줄로 가득 찬다. 분할에서는 종류·대상·지연을
    // pane 헤더가 이미 들고 있다.
    //
    // 지표가 꺼진 설정이라 바는 담을 것이 없으면 스스로 사라진다 — 그래서 tmux 감지를 넣어
    // **그릴 것이 있는** 상태로 만든다(그러지 않으면 "안 그린다" 가 저절로 참이 된다).
    const tmuxTabs = splitHostTabs.map((tab) => ({
      ...tab,
      tmuxAvailable: { version: '3.4', sessions: [] }
    })) as TerminalTab[];

    const split = renderWorkspace({
      activeWorkspace: splitWorkspace,
      tabs: tmuxTabs,
      hosts: hostRecords,
      viewActivationKey: 'workspace:workspace-split'
    });
    for (const pane of placedPanes(split.container)) {
      expect(within(pane).queryByRole('status')).toBeNull();
    }
    split.unmount();

    const solo = renderWorkspace({
      activeWorkspace: null,
      activeSessionId: 'session-1',
      tabs: tmuxTabs,
      hosts: hostRecords,
      viewActivationKey: 'session:session-1'
    });
    // 스탠드얼론은 pane 슬롯 표시가 없다(워크스페이스 배치가 아니다) — 컨테이너에서 센다.
    expect(solo.container.querySelectorAll('[role="status"]').length).toBeGreaterThan(0);
  });

  it('브로드캐스트 참여 pane 에 링을 두른다 — 포커스 테두리와 따로', () => {
    // 버튼 하나만 켜지면 "입력이 어디로 나가는지" 가 안 보인다. 카드 테두리는 포커스를 뜻하니
    // 겹쳐 쓰지 않고 슬롯 안쪽에 링을 한 겹 더 두른다.
    const { container } = renderWorkspace({
      activeWorkspace: { ...splitWorkspace, broadcastEnabled: true },
      activeSessionId: 'session-1',
      tabs: splitHostTabs,
      hosts: hostRecords,
      viewActivationKey: 'workspace:workspace-split'
    });

    const ringed = (root: HTMLElement) =>
      Array.from(
        root.querySelectorAll<HTMLElement>('[data-terminal-pane-slot="true"] > div'),
        // 실선(포커스) 과 갈리는 점선 링이다 — 클래스로 그것을 확인한다.
      ).filter((node) => node.className.includes('outline-dashed'));

    expect(ringed(container)).toHaveLength(2);

    // 꺼져 있으면 링이 없다(위 단정이 저절로 참이 되지 않게 함께 본다).
    const off = renderWorkspace({
      activeWorkspace: splitWorkspace,
      activeSessionId: 'session-1',
      tabs: splitHostTabs,
      hosts: hostRecords,
      viewActivationKey: 'workspace:workspace-split'
    });
    expect(ringed(off.container)).toHaveLength(0);
  });

  it('shows a pane excluded from broadcast as not participating', () => {
    const hostTabs: TerminalTab[] = [
      {
        id: 'tab-1',
        stableId: 'tab-1',
        sessionId: 'session-1',
        source: 'host',
        hostId: 'host-1',
        title: 'Session 1',
        status: 'connected',
        sessionShare: null,
        hasReceivedOutput: true,
        lastEventAt: '2025-01-01T00:00:00.000Z'
      },
      {
        id: 'tab-2',
        stableId: 'tab-2',
        sessionId: 'session-2',
        source: 'host',
        hostId: 'host-2',
        title: 'Session 2',
        status: 'connected',
        sessionShare: null,
        hasReceivedOutput: true,
        lastEventAt: '2025-01-01T00:00:00.000Z'
      }
    ];

    renderWorkspace({
      activeWorkspace: {
        ...splitWorkspace,
        broadcastEnabled: true,
        broadcastExcludedSessionIds: ['session-2']
      },
      tabs: hostTabs,
      hosts: hostRecords,
      viewActivationKey: 'workspace:workspace-split',
      onToggleSessionBroadcast: vi.fn()
    });

    // 참여 pane 은 "끄기", 빠진 pane 은 "켜기" 로 갈린다 — 켜져 있어도 pane 마다 다르다.
    expect(
      screen.getAllByRole('button', { name: '브로드캐스트 끄기' }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole('button', { name: '브로드캐스트 켜기' }),
    ).toHaveLength(1);
  });

  it('fans out text input only when broadcast is enabled for the active connected host pane', async () => {
    const hostTabs: TerminalTab[] = [
      {
        id: 'tab-1',
        stableId: 'tab-1',
        sessionId: 'session-1',
        source: 'host',
        hostId: 'host-1',
        title: 'Session 1',
        status: 'connected',
        sessionShare: null,
        hasReceivedOutput: true,
        lastEventAt: '2025-01-01T00:00:00.000Z'
      },
      {
        id: 'tab-2',
        stableId: 'tab-2',
        sessionId: 'session-2',
        source: 'host',
        hostId: 'host-2',
        title: 'Session 2',
        status: 'connected',
        sessionShare: null,
        hasReceivedOutput: true,
        lastEventAt: '2025-01-01T00:00:00.000Z'
      }
    ];
    const writeMock = window.dolssh.ssh.write as ReturnType<typeof vi.fn>;

    const { rerender } = renderWorkspace({
      activeWorkspace: splitWorkspace,
      tabs: hostTabs,
      hosts: hostRecords,
      viewActivationKey: 'workspace:workspace-split'
    });

    await waitFor(() => {
      expect(mocks.runtimeRecords).toHaveLength(2);
    });

    writeMock.mockClear();
    mocks.runtimeRecords[0].emitData('ls\n');
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith('session-1', 'ls\n');

    writeMock.mockClear();
    rerender(
      <TerminalWorkspace
        tabs={hostTabs}
        hosts={hostRecords}
        settings={settings}
        prefersDark={false}
        activeSessionId={null}
        activeWorkspace={{ ...splitWorkspace, broadcastEnabled: true }}
        viewActivationKey="workspace:workspace-split"
        draggedSession={null}
        canDropDraggedSession={false}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onRetryConnection={vi.fn().mockResolvedValue(undefined)}
        onCancelReconnect={vi.fn()}
        onStartSessionShare={vi.fn().mockResolvedValue(undefined)}
        onUpdateSessionShareSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSetSessionShareInputEnabled={vi.fn().mockResolvedValue(undefined)}
        onStopSessionShare={vi.fn().mockResolvedValue(undefined)}
        onStartPaneDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onSplitSessionDrop={vi.fn(() => false)}
        onMoveWorkspaceSession={vi.fn(() => false)}
        onFocusWorkspaceSession={vi.fn()}
        onToggleSessionBroadcast={vi.fn()}
        onToggleWorkspaceZoom={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onResizeWorkspaceSplit={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: '브로드캐스트 끄기' }).length,
      ).toBeGreaterThan(0);
    });

    writeMock.mockClear();
    mocks.runtimeRecords[0].emitData('whoami\n');
    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(writeMock).toHaveBeenNthCalledWith(1, 'session-1', 'whoami\n');
    expect(writeMock).toHaveBeenNthCalledWith(2, 'session-2', 'whoami\n');
  });

  it('does not fan out input from local panes even when broadcast is enabled', async () => {
    const localAndHostTabs: TerminalTab[] = [
      {
        id: 'tab-1',
        stableId: 'tab-1',
        sessionId: 'session-1',
        source: 'local',
        hostId: null,
        title: 'Session 1',
        status: 'connected',
        sessionShare: null,
        hasReceivedOutput: true,
        lastEventAt: '2025-01-01T00:00:00.000Z'
      },
      {
        id: 'tab-2',
        stableId: 'tab-2',
        sessionId: 'session-2',
        source: 'host',
        hostId: 'host-2',
        title: 'Session 2',
        status: 'connected',
        sessionShare: null,
        hasReceivedOutput: true,
        lastEventAt: '2025-01-01T00:00:00.000Z'
      }
    ];
    const localWorkspace: WorkspaceTab = {
      id: 'workspace-local',
      title: 'Workspace Local',
      layout: {
        id: 'split-local',
        kind: 'split',
        axis: 'horizontal',
        ratio: 0.5,
        first: {
          id: 'leaf-local',
          kind: 'leaf',
          sessionId: 'session-1'
        },
        second: {
          id: 'leaf-remote',
          kind: 'leaf',
          sessionId: 'session-2'
        }
      },
      activeSessionId: 'session-1',
      broadcastEnabled: true
    };
    const writeMock = window.dolssh.ssh.write as ReturnType<typeof vi.fn>;

    renderWorkspace({
      activeWorkspace: localWorkspace,
      tabs: localAndHostTabs,
      hosts: hostRecords,
      viewActivationKey: 'workspace:workspace-local'
    });

    await waitFor(() => {
      expect(mocks.runtimeRecords).toHaveLength(2);
    });

    writeMock.mockClear();
    mocks.runtimeRecords[0].emitData('pwd\n');
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith('session-1', 'pwd\n');
  });

  it('skips non-connected host targets for binary broadcast input', async () => {
    const threePaneWorkspace: WorkspaceTab = {
      id: 'workspace-broadcast',
      title: 'Workspace Broadcast',
      layout: {
        id: 'split-root',
        kind: 'split',
        axis: 'horizontal',
        ratio: 0.5,
        first: {
          id: 'leaf-source',
          kind: 'leaf',
          sessionId: 'session-1'
        },
        second: {
          id: 'split-nested',
          kind: 'split',
          axis: 'vertical',
          ratio: 0.5,
          first: {
            id: 'leaf-target',
            kind: 'leaf',
            sessionId: 'session-2'
          },
          second: {
            id: 'leaf-skipped',
            kind: 'leaf',
            sessionId: 'session-3'
          }
        }
      },
      activeSessionId: 'session-1',
      broadcastEnabled: true
    };
    const threePaneTabs: TerminalTab[] = [
      {
        id: 'tab-1',
        stableId: 'tab-1',
        sessionId: 'session-1',
        source: 'host',
        hostId: 'host-1',
        title: 'Session 1',
        status: 'connected',
        sessionShare: null,
        hasReceivedOutput: true,
        lastEventAt: '2025-01-01T00:00:00.000Z'
      },
      {
        id: 'tab-2',
        stableId: 'tab-2',
        sessionId: 'session-2',
        source: 'host',
        hostId: 'host-2',
        title: 'Session 2',
        status: 'connected',
        sessionShare: null,
        hasReceivedOutput: true,
        lastEventAt: '2025-01-01T00:00:00.000Z'
      },
      {
        id: 'tab-3',
        stableId: 'tab-3',
        sessionId: 'session-3',
        source: 'host',
        hostId: 'host-1',
        title: 'Session 3',
        status: 'error',
        sessionShare: null,
        hasReceivedOutput: true,
        lastEventAt: '2025-01-01T00:00:00.000Z'
      }
    ];
    const writeBinaryMock = window.dolssh.ssh.writeBinary as ReturnType<typeof vi.fn>;

    renderWorkspace({
      activeWorkspace: threePaneWorkspace,
      tabs: threePaneTabs,
      hosts: hostRecords,
      viewActivationKey: 'workspace:workspace-broadcast'
    });

    await waitFor(() => {
      expect(mocks.runtimeRecords).toHaveLength(3);
    });

    writeBinaryMock.mockClear();
    mocks.runtimeRecords[0].emitBinary('AB');
    expect(writeBinaryMock).toHaveBeenCalledTimes(2);
    expect(writeBinaryMock.mock.calls[0]?.[0]).toBe('session-1');
    expect(writeBinaryMock.mock.calls[1]?.[0]).toBe('session-2');
    expect(Array.from(writeBinaryMock.mock.calls[0]?.[1] as Uint8Array)).toEqual([65, 66]);
    expect(Array.from(writeBinaryMock.mock.calls[1]?.[1] as Uint8Array)).toEqual([65, 66]);
  });

  it('shows the latest three owner chat toasts and auto-dismisses them', async () => {
    vi.useFakeTimers();
    try {
      const dismissSessionShareChatNotification = vi.fn();
      const hostTabs: TerminalTab[] = [
        {
          id: 'tab-host',
          stableId: 'tab-host',
          sessionId: 'session-1',
          source: 'host',
          hostId: 'host-1',
          title: 'Host Session',
          status: 'connected',
          sessionShare: {
            status: 'active',
            shareUrl: 'https://sync.example.com/share/share-1/token-1',
            inputEnabled: false,
            viewerCount: 4,
            errorMessage: null
          },
          hasReceivedOutput: true,
          lastEventAt: '2025-01-01T00:00:00.000Z'
        }
      ];

      mocks.storeState = {
        ...createMockStoreState(),
        tabs: hostTabs,
        hosts: [
          {
            id: 'host-1',
            kind: 'ssh',
            label: 'Prod',
            hostname: 'prod.example.com',
            port: 22,
            username: 'ubuntu',
            authType: 'password',
            privateKeyPath: null,
            secretRef: 'host:host-1',
            groupName: 'Servers',
            terminalThemeId: null,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z'
          }
        ],
        sessionShareChatNotifications: {
          'session-1': [
            { id: 'chat-1', nickname: '하나', text: '첫 번째', sentAt: '2026-03-27T00:00:00.000Z' },
            { id: 'chat-2', nickname: '둘', text: '두 번째', sentAt: '2026-03-27T00:01:00.000Z' },
            { id: 'chat-3', nickname: '셋', text: '세 번째', sentAt: '2026-03-27T00:02:00.000Z' },
            { id: 'chat-4', nickname: '넷', text: '네 번째', sentAt: '2026-03-27T00:03:00.000Z' }
          ]
        },
        dismissSessionShareChatNotification
      };

      render(
        <TerminalWorkspace
          tabs={hostTabs}
          hosts={mocks.storeState.hosts}
          settings={settings}
          prefersDark={false}
          activeSessionId="session-1"
          activeWorkspace={null}
          viewActivationKey="session:session-1"
          draggedSession={null}
          canDropDraggedSession={false}
          onCloseSession={vi.fn().mockResolvedValue(undefined)}
          onRetryConnection={vi.fn().mockResolvedValue(undefined)}
          onCancelReconnect={vi.fn()}
          onStartSessionShare={vi.fn().mockResolvedValue(undefined)}
          onUpdateSessionShareSnapshot={vi.fn().mockResolvedValue(undefined)}
          onSetSessionShareInputEnabled={vi.fn().mockResolvedValue(undefined)}
          onStopSessionShare={vi.fn().mockResolvedValue(undefined)}
          onStartPaneDrag={vi.fn()}
          onEndSessionDrag={vi.fn()}
          onSplitSessionDrop={vi.fn(() => false)}
          onMoveWorkspaceSession={vi.fn(() => false)}
          onFocusWorkspaceSession={vi.fn()}
          onToggleSessionBroadcast={vi.fn()}
          onToggleWorkspaceZoom={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onResizeWorkspaceSplit={vi.fn()}
        />
      );

      expect(screen.getAllByTestId('terminal-share-toast')).toHaveLength(3);
      expect(screen.queryByText('첫 번째')).toBeNull();
      expect(screen.getByText('두 번째')).toBeTruthy();
      expect(screen.getByText('세 번째')).toBeTruthy();
      expect(screen.getByText('네 번째')).toBeTruthy();

      vi.advanceTimersByTime(SESSION_SHARE_CHAT_TOAST_TTL_MS);

      expect(dismissSessionShareChatNotification).toHaveBeenCalledWith('session-1', 'chat-1');
      expect(dismissSessionShareChatNotification).toHaveBeenCalledWith('session-1', 'chat-2');
      expect(dismissSessionShareChatNotification).toHaveBeenCalledWith('session-1', 'chat-3');
      expect(dismissSessionShareChatNotification).toHaveBeenCalledWith('session-1', 'chat-4');
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the detached owner chat window from the pane header share popover', async () => {
    const onOpenSessionShareChatWindow = vi.fn().mockResolvedValue(undefined);
    const hostTabs: TerminalTab[] = [
      {
        id: 'tab-host',
        stableId: 'tab-host',
        sessionId: 'session-1',
        source: 'host',
        hostId: 'host-1',
        title: 'Host Session',
        status: 'connected',
        sessionShare: {
          status: 'active',
          shareUrl: 'https://sync.example.com/share/share-1/token-1',
          inputEnabled: false,
          viewerCount: 2,
          errorMessage: null
        },
        hasReceivedOutput: true,
        lastEventAt: '2025-01-01T00:00:00.000Z'
      }
    ];

    mocks.storeState = {
      ...createMockStoreState(),
      tabs: hostTabs,
      hosts: [
        {
          id: 'host-1',
          kind: 'ssh',
          label: 'Prod',
          hostname: 'prod.example.com',
          port: 22,
          username: 'ubuntu',
          authType: 'password',
          privateKeyPath: null,
          secretRef: 'host:host-1',
          groupName: 'Servers',
          terminalThemeId: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ]
    };

    render(
      <TerminalWorkspace
        tabs={hostTabs}
        hosts={mocks.storeState.hosts}
        settings={settings}
        prefersDark={false}
        activeSessionId="session-1"
        activeWorkspace={sharePaneWorkspace}
        viewActivationKey="workspace:workspace-share"
        draggedSession={null}
        canDropDraggedSession={false}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onRetryConnection={vi.fn().mockResolvedValue(undefined)}
        onCancelReconnect={vi.fn()}
        onStartSessionShare={vi.fn().mockResolvedValue(undefined)}
        onUpdateSessionShareSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSetSessionShareInputEnabled={vi.fn().mockResolvedValue(undefined)}
        onStopSessionShare={vi.fn().mockResolvedValue(undefined)}
        onOpenSessionShareChatWindow={onOpenSessionShareChatWindow}
        onStartPaneDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onSplitSessionDrop={vi.fn(() => false)}
        onMoveWorkspaceSession={vi.fn(() => false)}
        onFocusWorkspaceSession={vi.fn()}
        onToggleSessionBroadcast={vi.fn()}
        onToggleWorkspaceZoom={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onResizeWorkspaceSplit={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(await screen.findByRole('button', { name: '채팅 기록' }));

    expect(onOpenSessionShareChatWindow).toHaveBeenCalledWith('session-1');
  });

  it('copies the share url from the link card and removes the separate copy button', async () => {
    const hostTabs: TerminalTab[] = [
      {
        id: 'tab-host',
        stableId: 'tab-host',
        sessionId: 'session-1',
        source: 'host',
        hostId: 'host-1',
        title: 'Host Session',
        status: 'connected',
        sessionShare: {
          status: 'active',
          shareUrl: 'https://sync.example.com/share/share-1/token-1',
          inputEnabled: false,
          viewerCount: 2,
          errorMessage: null
        },
        hasReceivedOutput: true,
        lastEventAt: '2025-01-01T00:00:00.000Z'
      }
    ];

    mocks.storeState = {
      ...createMockStoreState(),
      tabs: hostTabs,
      hosts: [
        {
          id: 'host-1',
          kind: 'ssh',
          label: 'Prod',
          hostname: 'prod.example.com',
          port: 22,
          username: 'ubuntu',
          authType: 'password',
          privateKeyPath: null,
          secretRef: 'host:host-1',
          groupName: 'Servers',
          terminalThemeId: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ]
    };

    render(
      <TerminalWorkspace
        tabs={hostTabs}
        hosts={mocks.storeState.hosts}
        settings={settings}
        prefersDark={false}
        activeSessionId="session-1"
        activeWorkspace={sharePaneWorkspace}
        viewActivationKey="workspace:workspace-share"
        draggedSession={null}
        canDropDraggedSession={false}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onRetryConnection={vi.fn().mockResolvedValue(undefined)}
        onCancelReconnect={vi.fn()}
        onStartSessionShare={vi.fn().mockResolvedValue(undefined)}
        onUpdateSessionShareSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSetSessionShareInputEnabled={vi.fn().mockResolvedValue(undefined)}
        onStopSessionShare={vi.fn().mockResolvedValue(undefined)}
        onOpenSessionShareChatWindow={vi.fn().mockResolvedValue(undefined)}
        onStartPaneDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onSplitSessionDrop={vi.fn(() => false)}
        onMoveWorkspaceSession={vi.fn(() => false)}
        onFocusWorkspaceSession={vi.fn()}
        onToggleSessionBroadcast={vi.fn()}
        onToggleWorkspaceZoom={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onResizeWorkspaceSplit={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(await screen.findByRole('button', { name: '공유 링크 복사' }));

    expect(window.navigator.clipboard.writeText).toHaveBeenCalledWith('https://sync.example.com/share/share-1/token-1');
    expect(screen.queryByRole('button', { name: '링크 복사' })).toBeNull();
    expect(await screen.findByText('링크를 복사했습니다.')).toBeTruthy();
  });

  it('renders host sessions safely even when legacy store state has no chat notification map', async () => {
    const hostTabs: TerminalTab[] = [
      {
        id: 'tab-host',
        stableId: 'tab-host',
        sessionId: 'session-1',
        source: 'host',
        hostId: 'host-1',
        title: 'Host Session',
        status: 'connected',
        sessionShare: null,
        hasReceivedOutput: true,
        lastEventAt: '2025-01-01T00:00:00.000Z'
      }
    ];

    mocks.storeState = {
      tabs: hostTabs,
      hosts: [
        {
          id: 'host-1',
          kind: 'ssh',
          label: 'Prod',
          hostname: 'prod.example.com',
          port: 22,
          username: 'ubuntu',
          authType: 'password',
          privateKeyPath: null,
          secretRef: 'host:host-1',
          groupName: 'Servers',
          terminalThemeId: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ],
      dismissSessionShareChatNotification: vi.fn(),
      pendingInteractiveAuths: [],
      respondInteractiveAuth: vi.fn(),
      reopenInteractiveAuthUrl: vi.fn(),
      clearPendingInteractiveAuth: vi.fn(),
      updatePendingConnectionSize: vi.fn(),
      markSessionOutput: vi.fn()
    };

    expect(() =>
      render(
        <TerminalWorkspace
          tabs={hostTabs}
          hosts={mocks.storeState.hosts}
          settings={settings}
          prefersDark={false}
          activeSessionId="session-1"
          activeWorkspace={null}
          viewActivationKey="session:session-1"
          draggedSession={null}
          canDropDraggedSession={false}
          onCloseSession={vi.fn().mockResolvedValue(undefined)}
          onRetryConnection={vi.fn().mockResolvedValue(undefined)}
          onCancelReconnect={vi.fn()}
          onStartSessionShare={vi.fn().mockResolvedValue(undefined)}
          onUpdateSessionShareSnapshot={vi.fn().mockResolvedValue(undefined)}
          onSetSessionShareInputEnabled={vi.fn().mockResolvedValue(undefined)}
          onStopSessionShare={vi.fn().mockResolvedValue(undefined)}
          onStartPaneDrag={vi.fn()}
          onEndSessionDrag={vi.fn()}
          onSplitSessionDrop={vi.fn(() => false)}
          onMoveWorkspaceSession={vi.fn(() => false)}
          onFocusWorkspaceSession={vi.fn()}
          onToggleSessionBroadcast={vi.fn()}
          onToggleWorkspaceZoom={vi.fn()}
        onDetachSessionToStandalone={vi.fn()}
        onResizeWorkspaceSplit={vi.fn()}
        />
      )
    ).not.toThrow();
  });
});
