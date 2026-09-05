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
import { createTerminalRuntime } from '../lib/terminal-runtime';
import { saveScrollbackSnapshot } from '../lib/terminal-write-registry';

const mocks = vi.hoisted(() => ({
  reinjectShellIntegration: vi.fn().mockResolvedValue(undefined),
  // 화면에서 읽은 명령을 돌려주는 자리. 서브셸 진입 판정이 이 값을 쓴다.
  beginCommandBlock: vi.fn<(...args: unknown[]) => string | null>(() => null),
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

vi.mock('../lib/terminal-command-blocks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginCommandBlock: (...args: unknown[]) => mocks.beginCommandBlock(...args),
}));

vi.mock('../lib/terminal-runtime', () => ({
  createTerminalRuntime: vi.fn(
    ({
      container,
      onData,
      onBinary,
      onShellIntegration,
    }: {
      container: HTMLElement;
      onData: (value: string) => void;
      onBinary: (value: string) => void;
      onShellIntegration?: (marker: string) => void;
    }) => {
      const terminal = {
        rows: 24,
        cols: 80,
        refresh: vi.fn(),
        focus: vi.fn(),
        // tmux pane 은 컨테이너에 fit 하지 않고 이 함수로 tmux 칸 수를 받는다.
        resize: vi.fn(),
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
        // 셸이 보낸 OSC 133 마커를 흉내 낸다(서브셸 진입 판정이 여기로 들어온다).
        emitShellIntegration: (marker: string) => onShellIntegration?.(marker),
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
  // 서브셸 진입 판정은 **화면에서 읽은 명령**으로 한다. 예전에는 사용자가 친 키를 모아
  // 재구성했는데, ↑ 로 부른 명령이나 붙여넣기는 글자가 입력으로 오지 않아 판정이 아예 안 걸렸다
  // (`ssh host` 를 두 번째에 ↑ 로 실행하면 통합이 안 붙었다).
  it('명령 블록이 시작되면 그 명령으로 서브셸 진입을 판정한다', async () => {
    mocks.beginCommandBlock.mockReturnValue('docker exec -it web sh');
    renderController(createProps());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const runtime = mocks.runtimeRecords[0];
    mocks.reinjectShellIntegration.mockClear();

    await act(async () => {
      runtime.emitShellIntegration('C');
    });

    expect(mocks.reinjectShellIntegration).toHaveBeenCalledWith('session-1', undefined);
  });

  it('PowerShell에서 전체 경로로 실행한 Git Bash에는 bash 힌트를 보낸다', async () => {
    mocks.beginCommandBlock.mockReturnValue(
      '& "C:\\Program Files\\Git\\bin\\bash.exe"',
    );
    renderController(createProps());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const runtime = mocks.runtimeRecords[0];
    mocks.reinjectShellIntegration.mockClear();

    await act(async () => {
      runtime.emitShellIntegration('C');
    });

    expect(mocks.reinjectShellIntegration).toHaveBeenCalledWith(
      'session-1',
      'bash',
    );
  });

  it('평범한 명령에는 재주입을 부르지 않는다', async () => {
    mocks.beginCommandBlock.mockReturnValue('ls -al');
    renderController(createProps());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const runtime = mocks.runtimeRecords[0];
    mocks.reinjectShellIntegration.mockClear();

    await act(async () => {
      runtime.emitShellIntegration('C');
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

  // tmux pane 의 xterm 은 **tmux 가 방금 보낸 레이아웃 칸 수 그대로** 만들어져야 한다. 마운트되면
  // 백로그(재연결 복원 바이트 포함)가 같은 커밋에서 즉시 재생되는데, 칸 수로 맞추는 resize 는
  // 다음 애니메이션 프레임에 온다 — 기본 80x24 로 만들면 그 사이 들어온 줄이 80칸에서 잘리고,
  // 나중에 101칸으로 늘어나도 잘린 칸은 돌아오지 않는다(실기기에서 `tmux delete-i` 로 끊긴 줄).
  // 기억이 아니다: 값은 현재 레이아웃(%layout-change)에서 오고 어디에도 저장하지 않는다.
  describe('tmux pane 의 xterm 초기 크기', () => {
    const tmuxTab: TerminalTab = {
      ...baseTab,
      tmux: { controlSessionId: 'ctl-1', paneId: '%0', windowId: '@0' },
    };

    beforeEach(() => {
      vi.mocked(createTerminalRuntime).mockClear();
    });

    it('tmux 레이아웃 칸 수로 만든다', async () => {
      renderController(createProps({ tab: tmuxTab, tmuxCell: { cols: 101, rows: 52 } }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      const [options] = vi.mocked(createTerminalRuntime).mock.calls[0] ?? [];
      expect(options?.initialSize).toEqual({ cols: 101, rows: 52 });
    });

    // 실기기에서 vi 가 깨진 순서 그대로: pane 이 **레이아웃보다 먼저** 마운트되고, 재연결 복원
    // 바이트(백로그)가 들어온 뒤에야 %layout-change 로 tmuxCell 이 온다. 이때 xterm 이 80x24 로
    // 이미 만들어져 있으면 그 위에 50행이 쓰여 26행이 밀려 사라진다(대체화면은 스크롤백이 없다).
    // 옳은 동작: tmux pane 은 칸 수를 알기 전엔 xterm 을 만들지 않고, 그 사이 온 바이트는
    // 버리지 않고 들고 있다가 셀 크기로 만든 xterm 에 그대로 쓴다.
    it('레이아웃이 마운트보다 늦어도 xterm 은 셀 크기로 만들어지고 바이트는 안 잃는다', async () => {
      const props = createProps({ tab: tmuxTab }); // tmuxCell 없음 = 레이아웃 아직 안 옴
      const { rerenderWithProps } = renderController(props);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      // 아직 만들면 안 된다 — 만들면 80x24 다.
      expect(vi.mocked(createTerminalRuntime)).not.toHaveBeenCalled();

      // 복원 바이트가 레이아웃보다 먼저 도착한다(백로그).
      const restore = new TextEncoder().encode('\x1b[?1049hHELLO-VI-LINE1\r\n~');
      await act(async () => {
        mocks.sessionDataListeners.get('session-1')?.(restore);
      });

      // 이제 레이아웃이 온다.
      rerenderWithProps({ ...props, tmuxCell: { cols: 100, rows: 50 } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      const [options] = vi.mocked(createTerminalRuntime).mock.calls[0] ?? [];
      expect(options?.initialSize).toEqual({ cols: 100, rows: 50 });
      // 먼저 온 바이트가 셀 크기 xterm 에 그대로 쓰였다(버려지지 않았다).
      const runtime = mocks.runtimeRecords[0];
      const written = runtime.write.mock.calls.map(([b]: [Uint8Array]) => new TextDecoder().decode(b)).join('');
      expect(written).toContain('HELLO-VI-LINE1');
    });

    // 실기기에서 두 번째 창으로 갔다가 돌아오면 전체화면(vi·htop)이 빈 화면이 된 원인. 창을 전환해 이
    // pane 이 숨으면 활성 창 레이아웃에서 빠져 tmuxCell 이 undefined 가 되는데, 그것이 마운트 게이트를
    // false 로 되돌리면 xterm 이 dispose 되고(tmux pane 은 스크롤백을 저장하지 않는다) 다시 켤 때 복원
    // 없이 빈 화면이 된다(복원은 연결당 1회라 다시 오지 않는다). 숨겼다 다시 보여도 xterm 은 하나여야
    // 하고, hide 에서 dispose 되면 안 된다.
    it('창 전환으로 숨었다 다시 보여도 xterm 을 다시 만들지 않는다', async () => {
      const props = createProps({ tab: tmuxTab, tmuxCell: { cols: 100, rows: 50 } });
      const { rerenderWithProps } = renderController(props);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(vi.mocked(createTerminalRuntime)).toHaveBeenCalledTimes(1);
      const runtime = mocks.runtimeRecords.at(-1);

      // 다른 창으로 전환 → 이 pane 은 숨고 활성 레이아웃에서 빠져 tmuxCell 이 사라진다.
      rerenderWithProps({ ...props, tmuxCell: undefined, visible: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(runtime.dispose, '숨겼다고 xterm 을 없애면 안 된다').not.toHaveBeenCalled();

      // 다시 그 창으로 → tmuxCell 이 돌아온다. 새 xterm 을 만들면 이전 화면(대체화면=스크롤백 없음)을 잃는다.
      rerenderWithProps({ ...props, tmuxCell: { cols: 100, rows: 50 }, visible: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(vi.mocked(createTerminalRuntime), '다시 보일 때 새 xterm 을 만들면 안 된다').toHaveBeenCalledTimes(1);
    });

    it('tmux pane 이 아니면 크기를 정하지 않는다(fit 이 맞춘다)', async () => {
      renderController(createProps());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      const [options] = vi.mocked(createTerminalRuntime).mock.calls[0] ?? [];
      expect(options?.initialSize).toBeUndefined();
    });

    // 실기기에서 두 번째 tmux 창으로 전환하면 vi·htop 이 깨진 순서. 숨은 창의 pane 은 활성 레이아웃에
    // 없어 tmuxCell 이 비고, 그동안 fit 이 컨테이너에 맞추면 tmux 와 한두 칸 어긋난 격자로 내용이
    // 다시 흐른다 — 창이 돌아와 칸 수를 되찾아도 감긴 줄은 되돌아오지 않는다. tmux pane 은 칸 수를
    // 모르면 아무 것도 하지 않아야 한다.
    it('tmux pane 은 칸 수를 모르는 동안 컨테이너에 fit 하지 않는다', async () => {
      const props = createProps({ tab: tmuxTab, tmuxCell: { cols: 100, rows: 50 } });
      const { rerenderWithProps } = renderController(props);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      const runtime = mocks.runtimeRecords.at(-1);
      const { options } = mocks.schedulerRecords.at(-1)!;

      // 창이 숨는다: 활성 레이아웃에서 빠져 tmuxCell 이 사라진다.
      rerenderWithProps({ ...props, tmuxCell: undefined, visible: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      runtime.fitAddon.fit.mockClear();
      runtime.terminal.resize.mockClear();

      options.fit();

      expect(runtime.fitAddon.fit).not.toHaveBeenCalled();
      expect(runtime.terminal.resize).not.toHaveBeenCalled();
    });

    // 분할선을 끌어 pane 을 **넓힐 때** 실기기에서 vi 가 깨진 원인. 원격 출력은 xterm 에 즉시 쓰이는데
    // 격자 변경만 스케줄러(rAF·정착)를 거치면, 새 폭으로 그려진 재그리기가 아직 좁은 격자에서 감기며
    // 행이 늘어나 화면이 위로 밀린다 — 뒤늦게 넓혀도 감긴 줄은 돌아오지 않는다(vi 는 스스로 안 그린다).
    // 그래서 칸 수가 오면 **그 자리에서** 격자를 맞춰야 한다.
    it('tmux 칸 수가 바뀌면 스케줄러를 기다리지 않고 즉시 격자를 맞춘다', async () => {
      const props = createProps({ tab: tmuxTab, tmuxCell: { cols: 44, rows: 59 } });
      const { rerenderWithProps, getController } = renderController(props);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      const runtime = mocks.runtimeRecords.at(-1);
      const container = getController().containerRef.current!;
      Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
      Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
      runtime.terminal.cols = 44;
      runtime.terminal.rows = 59;
      runtime.terminal.resize.mockClear();

      // pane 을 넓힌다. 타이머·프레임을 전혀 진행시키지 않는다 — 그래도 이미 맞춰져 있어야 한다.
      await act(async () => {
        rerenderWithProps({ ...props, tmuxCell: { cols: 52, rows: 59 } });
      });

      expect(
        runtime.terminal.resize,
        '늦게 적용하면 새 폭 화면이 좁은 격자에서 감겨 화면이 밀린다',
      ).toHaveBeenCalledWith(52, 59);
    });

    it('tmux pane 은 칸 수를 알면 컨테이너가 아니라 그 칸 수로 맞춘다', async () => {
      const props = createProps({ tab: tmuxTab, tmuxCell: { cols: 100, rows: 50 } });
      const { getController } = renderController(props);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      const runtime = mocks.runtimeRecords.at(-1);
      const { options } = mocks.schedulerRecords.at(-1)!;
      // 보이는 pane(jsdom 은 크기가 0 이라 숨김으로 보이므로 직접 준다).
      const container = getController().containerRef.current!;
      Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
      Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
      runtime.fitAddon.fit.mockClear();
      runtime.terminal.resize.mockClear();

      options.fit();

      expect(runtime.terminal.resize).toHaveBeenCalledWith(100, 50);
      expect(runtime.fitAddon.fit).not.toHaveBeenCalled();
    });

    // 밀어둔 바이트는 이전 터미널의 스냅샷(과거) **뒤**에 와야 한다. 앞에 쓰면 방금 복원한 화면 위에
    // 옛 화면이 덧그려진다.
    it('xterm 이 늦게 만들어질 때 이전 스크롤백 스냅샷은 밀어둔 바이트보다 먼저 쓴다', async () => {
      saveScrollbackSnapshot(tmuxTab.stableId, 'OLD-SCREEN');
      const props = createProps({ tab: tmuxTab }); // 레이아웃 아직 안 옴
      const { rerenderWithProps } = renderController(props);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      await act(async () => {
        mocks.sessionDataListeners.get('session-1')?.(new TextEncoder().encode('RESTORE'));
      });

      rerenderWithProps({ ...props, tmuxCell: { cols: 100, rows: 50 } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      const runtime = mocks.runtimeRecords.at(-1);
      const written = runtime.write.mock.calls.map(([value]: [Uint8Array | string]) =>
        typeof value === 'string' ? value : new TextDecoder().decode(value),
      );
      expect(written.indexOf('OLD-SCREEN')).toBeGreaterThanOrEqual(0);
      expect(written.indexOf('RESTORE')).toBeGreaterThan(written.indexOf('OLD-SCREEN'));
    });
  });
});
