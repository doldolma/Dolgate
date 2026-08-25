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
  reinjectShellIntegration: vi.fn().mockResolvedValue(undefined),
  runtimeRecords: [] as any[],
  schedulerRecords: [] as Array<{
    scheduler: { request: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> };
    options: any;
  }>,
  sessionDataListeners: new Map<string, (chunk: Uint8Array) => void>(),
}));

// 서브셸 재주입만 가로챈다 — 나머지 터미널 서비스는 원본 그대로 쓴다.
vi.mock('../services/desktop/terminal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reinjectTerminalShellIntegration: (sessionId: string, shell?: string) =>
    mocks.reinjectShellIntegration(sessionId, shell),
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
        // 명령 블록 점프(Cmd/Ctrl+↑↓)용 키 핸들러를 컨트롤러가 등록한다.
        attachCustomKeyEventHandler: vi.fn(),
        // 블록 오버레이가 스크롤/렌더에 맞춰 위치를 다시 계산하려고 구독한다.
        onRender: vi.fn(() => ({ dispose: vi.fn() })),
        onScroll: vi.fn(() => ({ dispose: vi.fn() })),
        buffer: {
          active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0 },
        },
      };
      const runtime = {
        terminal,
        fitAddon: { fit: vi.fn() },
        write: vi.fn(),
        scheduleAfterWriteDrain: vi.fn((callback: () => void) => {
          callback();
        }),
        captureSnapshot: vi.fn(() => 'snapshot'),
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
  stableId: 'tab-1',
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
    terminalAutocompleteEnabled: false,
    tmuxPrefixKey: 'C-b',
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
    Object.defineProperty(window, 'dolssh', {
      configurable: true,
      value: {
        ssh: {
          onData: vi.fn(() => () => undefined),
          write: vi.fn().mockResolvedValue(undefined),
          writeBinary: vi.fn().mockResolvedValue(undefined),
          resize: vi.fn().mockResolvedValue(undefined),
          installShellIntegration: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
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

  // 분할선을 끄는 동안 layoutKey(pane 사각형)는 mousemove 마다 바뀐다. 그때 뷰포트를 다시
  // 그리면 격자가 그대로여도 화면이 초당 60번 재도색돼 깜빡인다 — 자리 이동은 CSS 가 하는
  // 일이므로 xterm 이 다시 그릴 이유가 없다. 격자가 실제로 바뀌면 스케줄러가 정착 뒤 한 번
  // 맞추고, 그 경로의 afterResize 가 그때 다시 그린다.
  it('pane 자리만 바뀌면 리사이즈만 요청하고 뷰포트를 다시 그리지 않는다', async () => {
    const props = createProps();
    const { rerenderWithProps } = renderController(props);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const record = mocks.schedulerRecords[0];
    const runtime = mocks.runtimeRecords[0];
    expect(record).toBeTruthy();
    expect(runtime).toBeTruthy();

    // 드래그 중에는 격자가 그대로다 — 스케줄러가 아무 것도 적용하지 않는 상태를 만든다.
    record.scheduler.request.mockImplementation(() => {});
    runtime.terminal.refresh.mockClear();

    for (const width of ['0.9', '0.8', '0.7']) {
      rerenderWithProps({ ...props, layoutKey: `0:0:${width}:1` });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
    }

    expect(record.scheduler.request).toHaveBeenCalled();
    expect(runtime.terminal.refresh).not.toHaveBeenCalled();
  });

  // 배관 검증: 서브셸 진입은 렌더러가 **입력을 보고** 판정해 코어에 재주입을 시킨다. 이 경로가
  // 끊기면 서브셸 안에서 통합이 조용히 사라진다(단위 테스트가 다 초록이어도 그렇다 — 실제로
  // 그 상태를 앱에 붙어 계측해서야 찾았다).
  it('서브셸 진입 명령을 실행하면 그 셸 이름과 함께 재주입을 부른다', async () => {
    renderController(createProps());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const runtime = mocks.runtimeRecords[0];
    mocks.reinjectShellIntegration.mockClear();

    await act(async () => {
      runtime.emitData('bash');
      runtime.emitData('\r');
    });

    expect(mocks.reinjectShellIntegration).toHaveBeenCalledWith('session-1', 'bash');
  });

  it('평범한 명령에는 재주입을 부르지 않는다', async () => {
    renderController(createProps());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const runtime = mocks.runtimeRecords[0];
    mocks.reinjectShellIntegration.mockClear();

    await act(async () => {
      runtime.emitData('ls -al');
      runtime.emitData('\r');
    });

    expect(mocks.reinjectShellIntegration).not.toHaveBeenCalled();
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
          stableId: 'tab-2',
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
    const serializedSnapshot = '\u001b[?1049h\u001b[H\tfoo\r\n\t\tbar';
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
    mocks.runtimeRecords[0].captureSnapshot.mockReturnValue(serializedSnapshot);
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
        snapshot: serializedSnapshot,
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

  it('preserves the terminal instance across reconnect (sessionId changes, stableId stable)', async () => {
    const { rerenderWithProps } = renderController(createProps());

    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.runtimeRecords).toHaveLength(1);
    const runtime = mocks.runtimeRecords[0];

    // 재연결: sessionId만 바뀌고 stableId('tab-1')는 유지된다.
    rerenderWithProps(
      createProps({
        sessionId: 'session-1-reconnected',
        tab: { ...baseTab, sessionId: 'session-1-reconnected' },
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    // 터미널을 dispose/recreate 하지 않아 스크롤백이 보존된다.
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect(mocks.runtimeRecords).toHaveLength(1);

    // 새 sessionId의 출력이 동일 터미널에 append된다(데이터 구독은 sessionId 기준 재구독).
    await act(async () => {
      mocks.sessionDataListeners
        .get('session-1-reconnected')
        ?.(new Uint8Array([120]));
    });
    expect(runtime.write).toHaveBeenCalledWith(new Uint8Array([120]));
  });

  it('disposes and recreates the terminal when switching to a different tab (stableId changes)', async () => {
    const { rerenderWithProps } = renderController(createProps());

    await act(async () => {
      await Promise.resolve();
    });
    const firstRuntime = mocks.runtimeRecords[0];

    // 다른 탭으로 전환: stableId가 바뀌면 터미널은 새로 만들어진다.
    rerenderWithProps(
      createProps({
        sessionId: 'session-2',
        tab: { ...baseTab, id: 'tab-2', stableId: 'tab-2', sessionId: 'session-2' },
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(firstRuntime.dispose).toHaveBeenCalled();
    expect(mocks.runtimeRecords).toHaveLength(2);
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

  // 붙기 전에 보낸 크기는 버려진다 — 코어의 리사이즈 라우팅이 아직 등록되지 않은 세션을 어느
  // 매니저도 모르므로 ssh 로 떨어뜨린다. 스케줄러는 같은 크기를 두 번 보내지 않으니, 붙은 뒤에
  // 다시 요청하지 않으면 셸은 연결 시점의 기본값(120x32)을 끝까지 믿는다. 실제로 로컬 PowerShell
  // 이 그 폭으로 줄바꿈·커서를 계산해 화면이 깨졌다.
  it('clears the dedupe and re-requests the size once the session connects', async () => {
    const view = renderController(
      createProps({ tab: { ...baseTab, status: 'connecting' } }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    const record = mocks.schedulerRecords.at(-1);
    if (!record) {
      throw new Error('resize scheduler was not created');
    }
    const resetsBefore = record.scheduler.reset.mock.calls.length;
    const requestsBefore = record.scheduler.request.mock.calls.length;

    await act(async () => {
      view.rerenderWithProps(
        createProps({ tab: { ...baseTab, status: 'connected' } }),
      );
      await Promise.resolve();
    });

    expect(record.scheduler.reset.mock.calls.length).toBeGreaterThan(resetsBefore);
    expect(record.scheduler.request.mock.calls.length).toBeGreaterThan(requestsBefore);
  });
});
