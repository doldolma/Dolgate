import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostRecord,
  SessionShareChatMessage,
  TerminalTab,
} from '@shared';
import type { PendingSessionInteractiveAuth } from '../store/createAppStore';
import type { TerminalSessionPaneProps } from '../components/terminal-workspace/types';
import { terminalThemePresets } from '../lib/terminal-presets';
import { useTerminalSessionViewController } from './useTerminalSessionViewController';

const mocks = vi.hoisted(() => ({
  runtimeRecords: [] as any[],
  schedulerRecords: [] as Array<{
    scheduler: { request: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> };
    options: any;
  }>,
  sessionDataListeners: new Map<string, (chunk: Uint8Array) => void>(),
}));

vi.mock('../lib/terminal-runtime', () => ({
  createTerminalRuntime: vi.fn(
    ({
      container,
      onData,
      onBinary,
    }: {
      container: HTMLElement;
      onData: (value: string) => void;
      onBinary: (value: string) => void;
    }) => {
      const terminal = {
        rows: 24,
        cols: 80,
        refresh: vi.fn(),
        focus: vi.fn(),
      };
      const runtime = {
        terminal,
        fitAddon: { fit: vi.fn() },
        write: vi.fn(),
        scheduleAfterWriteDrain: vi.fn((callback: () => void) => {
          callback();
        }),
        captureSnapshot: vi.fn(() => 'snapshot'),
        setAppearance: vi.fn(),
        setWebglEnabled: vi.fn().mockResolvedValue(undefined),
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
        dispose: vi.fn(),
      };
      mocks.runtimeRecords.push(runtime);
      return runtime;
    },
  ),
}));

vi.mock('../components/terminal-resize', () => ({
  createTerminalResizeScheduler: vi.fn((options: any) => {
    const scheduler = {
      request: vi.fn(() => {
        void options.sendResize({ cols: 80, rows: 24 });
        options.afterResize();
      }),
      reset: vi.fn(),
    };
    mocks.schedulerRecords.push({ scheduler, options });
    return scheduler;
  }),
}));

const host: HostRecord = {
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
  createdAt: '2026-04-04T00:00:00.000Z',
  updatedAt: '2026-04-04T00:00:00.000Z',
};

const baseTab: TerminalTab = {
  id: 'tab-1',
  sessionId: 'session-1',
  source: 'host',
  hostId: 'host-1',
  title: 'Session 1',
  status: 'connected',
  sessionShare: null,
  hasReceivedOutput: true,
  lastEventAt: '2026-04-04T00:00:00.000Z',
};

const baseInteractiveAuth: PendingSessionInteractiveAuth = {
  source: 'ssh',
  sessionId: 'session-1',
  challengeId: 'challenge-1',
  instruction: '코드를 입력하세요.',
  prompts: [{ label: 'Code', echo: true }],
  provider: 'generic',
  autoSubmitted: false,
};

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

function createProps(
  overrides: Partial<TerminalSessionPaneProps> = {},
): TerminalSessionPaneProps {
  return {
    sessionId: 'session-1',
    title: 'Session 1',
    visible: true,
    active: true,
    viewActivationKey: 'workspace:1',
    layoutKey: '0:0:1:1',
    appearance: {
      theme: terminalThemePresets[0].theme,
      fontFamily: 'Menlo',
      fontSize: 13,
      scrollbackLines: 5000,
      lineHeight: 1,
      letterSpacing: 0,
      minimumContrastRatio: 1,
    },
    terminalWebglEnabled: true,
    interactiveAuth: null,
    onStartSessionShare: vi.fn().mockResolvedValue(undefined),
    onUpdateSessionShareSnapshot: vi.fn().mockResolvedValue(undefined),
    onSetSessionShareInputEnabled: vi.fn().mockResolvedValue(undefined),
    onStopSessionShare: vi.fn().mockResolvedValue(undefined),
    onOpenSessionShareChatWindow: vi.fn().mockResolvedValue(undefined),
    onSendInput: vi.fn(),
    onSendBinaryInput: vi.fn(),
    tab: baseTab,
    host,
    sessionShareChatNotifications: [],
    onDismissSessionShareChatNotification: vi.fn(),
    onRespondInteractiveAuth: vi.fn().mockResolvedValue(undefined),
    onReopenInteractiveAuthUrl: vi.fn(),
    onClearPendingInteractiveAuth: vi.fn(),
    onSessionData: vi.fn((sessionId: string, listener: (chunk: Uint8Array) => void) => {
      mocks.sessionDataListeners.set(sessionId, listener);
      return () => {
        mocks.sessionDataListeners.delete(sessionId);
      };
    }),
    onResizeSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderController(props: TerminalSessionPaneProps) {
  let controller: ReturnType<typeof useTerminalSessionViewController> | null = null;
  let latestProps = props;

  function Harness(input: TerminalSessionPaneProps) {
    controller = useTerminalSessionViewController(input);

    return (
      <>
        <div
          ref={(node) => {
            controller!.containerRef.current = node;
            if (node) {
              node.getBoundingClientRect = () =>
                ({
                  left: 0,
                  top: 0,
                  width: 400,
                  height: 240,
                  right: 400,
                  bottom: 240,
                  x: 0,
                  y: 0,
                  toJSON: () => ({}),
                }) as DOMRect;
            }
          }}
        />
        <div ref={controller.sharePopoverRef} />
        {controller.searchOpen ? <input ref={controller.searchInputRef} /> : null}
      </>
    );
  }

  const rendered = render(<Harness {...props} />);

  return {
    ...rendered,
    getController: () => controller!,
    rerenderWithProps: (nextProps: TerminalSessionPaneProps) => {
      latestProps = nextProps;
      rendered.rerender(<Harness {...latestProps} />);
    },
  };
}

describe('useTerminalSessionViewController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.runtimeRecords.length = 0;
    mocks.schedulerRecords.length = 0;
    mocks.sessionDataListeners.clear();
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets prompt, search, and share state when the session changes', async () => {
    const { getController, rerenderWithProps } = renderController(
      createProps({
        interactiveAuth: baseInteractiveAuth,
      }),
    );

    await act(async () => {
      getController().handleInteractiveAuthPromptChange(0, '123456');
      getController().toggleSharePopover();
      getController().handlePaneKeyDownCapture({
        key: 'f',
        ctrlKey: true,
        metaKey: false,
        preventDefault: vi.fn(),
      } as any);
    });

    expect(getController().promptResponses).toEqual(['123456']);
    expect(getController().sharePopoverOpen).toBe(true);
    expect(getController().searchOpen).toBe(true);

    rerenderWithProps(
      createProps({
        sessionId: 'session-2',
        title: 'Session 2',
        tab: {
          ...baseTab,
          id: 'tab-2',
          sessionId: 'session-2',
          title: 'Session 2',
        },
        interactiveAuth: null,
      }),
    );

    expect(getController().promptResponses).toEqual([]);
    expect(getController().sharePopoverOpen).toBe(false);
    expect(getController().searchOpen).toBe(false);
  });

  it('marks share snapshots dirty on incoming chunks and flushes refresh snapshots on the interval', async () => {
    const onUpdateSessionShareSnapshot = vi.fn().mockResolvedValue(undefined);
    renderController(
      createProps({
        tab: {
          ...baseTab,
          sessionShare: {
            status: 'active',
            shareUrl: 'https://share.test/session-1',
            viewerCount: 2,
            inputEnabled: false,
            errorMessage: null,
          },
        },
        onUpdateSessionShareSnapshot,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    onUpdateSessionShareSnapshot.mockClear();

    await act(async () => {
      mocks.sessionDataListeners.get('session-1')?.(new Uint8Array([104, 105]));
      vi.advanceTimersByTime(2000);
    });

    expect(mocks.runtimeRecords[0].write).toHaveBeenCalledWith(
      new Uint8Array([104, 105]),
    );
    expect(onUpdateSessionShareSnapshot).toHaveBeenCalled();
    expect(onUpdateSessionShareSnapshot.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        snapshot: 'snapshot',
      }),
    );
  });

  it('cleans up chat toast timers on unmount', async () => {
    const onDismissSessionShareChatNotification = vi.fn();
    const notifications: SessionShareChatMessage[] = [
      {
        id: 'chat-1',
        nickname: 'pair',
        senderRole: 'viewer',
        text: 'hello',
        sentAt: '2026-04-04T00:00:00.000Z',
      },
    ];

    const { unmount } = renderController(
      createProps({
        sessionShareChatNotifications: notifications,
        onDismissSessionShareChatNotification,
      }),
    );

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(8000);
    });

    expect(onDismissSessionShareChatNotification).not.toHaveBeenCalled();
  });

  it('routes resize scheduling through the session controller boundary', async () => {
    const onResizeSession = vi.fn().mockResolvedValue(undefined);

    renderController(
      createProps({
        onResizeSession,
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(onResizeSession).toHaveBeenCalledWith('session-1', 80, 24);
  });
});
