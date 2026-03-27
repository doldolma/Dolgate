import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, TerminalTab } from '@shared';
import type { WorkspaceTab } from '../store/createAppStore';
import { SESSION_SHARE_CHAT_TOAST_TTL_MS, TerminalWorkspace } from './TerminalWorkspace';

const mocks = vi.hoisted(() => ({
  storeState: {} as any,
  runtimeRecords: [] as any[],
  schedulerRecords: [] as any[]
}));

vi.mock('../store/appStore', () => ({
  useAppStore: (selector: (state: any) => unknown) => selector(mocks.storeState)
}));

vi.mock('../lib/terminal-runtime', () => ({
  createTerminalRuntime: vi.fn(({ container }: { container: HTMLElement }) => {
    const terminal = {
      rows: 24,
      cols: 80,
      refresh: vi.fn(),
      focus: vi.fn()
    };
    const runtime = {
      terminal,
      fitAddon: { fit: vi.fn() },
      write: vi.fn(),
      scheduleAfterWriteDrain: vi.fn(),
      captureSnapshot: vi.fn(() => ''),
      setAppearance: vi.fn(),
      setWebglEnabled: vi.fn().mockResolvedValue(undefined),
      syncDisplayMetrics: vi.fn(),
      focus: vi.fn(() => {
        container.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      }),
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
  globalTerminalThemeId: 'dolssh-dark',
  terminalFontFamily: 'sf-mono',
  terminalFontSize: 13,
  terminalScrollbackLines: 5000,
  terminalLineHeight: 1,
  terminalLetterSpacing: 0,
  terminalMinimumContrastRatio: 1,
  terminalAltIsMeta: false,
  terminalWebglEnabled: true,
  sftpBrowserColumnWidths: {
    name: 360,
    dateModified: 168,
    size: 96,
    kind: 96
  },
  serverUrl: 'https://example.test',
  serverUrlOverride: null,
  updatedAt: '2025-01-01T00:00:00.000Z'
};

const tabs: TerminalTab[] = [
  {
    id: 'tab-1',
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

const workspaceA: WorkspaceTab = {
  id: 'workspace-a',
  title: 'Workspace A',
  layout: {
    id: 'leaf-a',
    kind: 'leaf',
    sessionId: 'session-1'
  },
  activeSessionId: 'session-1'
};

const workspaceB: WorkspaceTab = {
  id: 'workspace-b',
  title: 'Workspace B',
  layout: {
    id: 'leaf-b',
    kind: 'leaf',
    sessionId: 'session-2'
  },
  activeSessionId: 'session-2'
};

const sharedSessionWorkspaceA: WorkspaceTab = {
  id: 'workspace-a',
  title: 'Workspace A',
  layout: {
    id: 'leaf-shared-a',
    kind: 'leaf',
    sessionId: 'session-1'
  },
  activeSessionId: 'session-1'
};

const sharedSessionWorkspaceB: WorkspaceTab = {
  id: 'workspace-b',
  title: 'Workspace B',
  layout: {
    id: 'leaf-shared-b',
    kind: 'leaf',
    sessionId: 'session-1'
  },
  activeSessionId: 'session-1'
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
  activeSessionId: 'session-1'
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
    pendingInteractiveAuth: null,
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
  draggedSession?: { sessionId: string; source: 'standalone-tab' | 'workspace-pane'; workspaceId?: string } | null;
  canDropDraggedSession?: boolean;
  onSplitSessionDrop?: (sessionId: string, direction: any, targetSessionId?: string) => boolean;
  onMoveWorkspaceSession?: (workspaceId: string, sessionId: string, direction: any, targetSessionId: string) => boolean;
  onFocusWorkspaceSession?: (workspaceId: string, sessionId: string) => void;
}) {
  return render(
    <TerminalWorkspace
      tabs={tabs}
      hosts={[]}
      settings={settings}
      prefersDark={false}
      activeSessionId={input.activeSessionId ?? null}
      activeWorkspace={input.activeWorkspace}
      viewActivationKey={input.viewActivationKey}
      draggedSession={input.draggedSession ?? null}
      canDropDraggedSession={input.canDropDraggedSession ?? false}
      onCloseSession={vi.fn().mockResolvedValue(undefined)}
      onRetryConnection={vi.fn().mockResolvedValue(undefined)}
      onStartSessionShare={vi.fn().mockResolvedValue(undefined)}
      onUpdateSessionShareSnapshot={vi.fn().mockResolvedValue(undefined)}
      onSetSessionShareInputEnabled={vi.fn().mockResolvedValue(undefined)}
      onStopSessionShare={vi.fn().mockResolvedValue(undefined)}
      onStartPaneDrag={vi.fn()}
      onEndSessionDrag={vi.fn()}
      onSplitSessionDrop={input.onSplitSessionDrop ?? vi.fn(() => false)}
      onMoveWorkspaceSession={input.onMoveWorkspaceSession ?? vi.fn(() => false)}
      onFocusWorkspaceSession={input.onFocusWorkspaceSession ?? vi.fn()}
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
          write: vi.fn(),
          writeBinary: vi.fn(),
          resize: vi.fn().mockResolvedValue(undefined)
        }
      }
    });
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
        onStartSessionShare={vi.fn().mockResolvedValue(undefined)}
        onUpdateSessionShareSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSetSessionShareInputEnabled={vi.fn().mockResolvedValue(undefined)}
        onStopSessionShare={vi.fn().mockResolvedValue(undefined)}
        onStartPaneDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onSplitSessionDrop={vi.fn(() => false)}
        onMoveWorkspaceSession={vi.fn(() => false)}
        onFocusWorkspaceSession={onFocusWorkspaceSession}
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
        onStartSessionShare={vi.fn().mockResolvedValue(undefined)}
        onUpdateSessionShareSnapshot={vi.fn().mockResolvedValue(undefined)}
        onSetSessionShareInputEnabled={vi.fn().mockResolvedValue(undefined)}
        onStopSessionShare={vi.fn().mockResolvedValue(undefined)}
        onStartPaneDrag={vi.fn()}
        onEndSessionDrag={vi.fn()}
        onSplitSessionDrop={vi.fn(() => false)}
        onMoveWorkspaceSession={vi.fn(() => false)}
        onFocusWorkspaceSession={vi.fn()}
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
      expect(container.querySelectorAll('.terminal-pane-slot')).toHaveLength(2);
    });

    const targetPane = screen.getByText('Session 2').closest('.terminal-pane-slot') as HTMLElement;
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
      expect(container.querySelector('.workspace-drop-preview')).toBeTruthy();
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
      expect(container.querySelectorAll('.terminal-pane-slot')).toHaveLength(2);
    });

    const targetPane = screen.getByText('Session 2').closest('.terminal-pane-slot') as HTMLElement;
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
      expect(container.querySelectorAll('.terminal-pane-slot')).toHaveLength(2);
    });

    const ownPane = screen.getByText('Session 1').closest('.terminal-pane-slot') as HTMLElement;
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

    expect(container.querySelector('.workspace-drop-preview')).toBeFalsy();
    expect(onMoveWorkspaceSession).not.toHaveBeenCalled();
  });

  it('shows the latest three owner chat toasts and auto-dismisses them', async () => {
    vi.useFakeTimers();
    try {
      const dismissSessionShareChatNotification = vi.fn();
      const hostTabs: TerminalTab[] = [
        {
          id: 'tab-host',
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

      const { container } = render(
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
          onStartSessionShare={vi.fn().mockResolvedValue(undefined)}
          onUpdateSessionShareSnapshot={vi.fn().mockResolvedValue(undefined)}
          onSetSessionShareInputEnabled={vi.fn().mockResolvedValue(undefined)}
          onStopSessionShare={vi.fn().mockResolvedValue(undefined)}
          onStartPaneDrag={vi.fn()}
          onEndSessionDrag={vi.fn()}
          onSplitSessionDrop={vi.fn(() => false)}
          onMoveWorkspaceSession={vi.fn(() => false)}
          onFocusWorkspaceSession={vi.fn()}
          onResizeWorkspaceSplit={vi.fn()}
        />
      );

      expect(container.querySelectorAll('.terminal-share-chat-toast')).toHaveLength(3);
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

  it('opens the detached owner chat window from the share popover', async () => {
    const onOpenSessionShareChatWindow = vi.fn().mockResolvedValue(undefined);
    const hostTabs: TerminalTab[] = [
      {
        id: 'tab-host',
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
        activeWorkspace={null}
        viewActivationKey="session:session-1"
        draggedSession={null}
        canDropDraggedSession={false}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onRetryConnection={vi.fn().mockResolvedValue(undefined)}
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
        activeWorkspace={null}
        viewActivationKey="session:session-1"
        draggedSession={null}
        canDropDraggedSession={false}
        onCloseSession={vi.fn().mockResolvedValue(undefined)}
        onRetryConnection={vi.fn().mockResolvedValue(undefined)}
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
      pendingInteractiveAuth: null,
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
          onStartSessionShare={vi.fn().mockResolvedValue(undefined)}
          onUpdateSessionShareSnapshot={vi.fn().mockResolvedValue(undefined)}
          onSetSessionShareInputEnabled={vi.fn().mockResolvedValue(undefined)}
          onStopSessionShare={vi.fn().mockResolvedValue(undefined)}
          onStartPaneDrag={vi.fn()}
          onEndSessionDrag={vi.fn()}
          onSplitSessionDrop={vi.fn(() => false)}
          onMoveWorkspaceSession={vi.fn(() => false)}
          onFocusWorkspaceSession={vi.fn()}
          onResizeWorkspaceSplit={vi.fn()}
        />
      )
    ).not.toThrow();
  });
});
