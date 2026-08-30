import React from 'react';
import renderer, { act } from 'react-test-renderer';

const autocompleteResult = {
  capability: {
    status: 'ready' as const,
    shell: 'bash' as const,
    sources: ['history', 'executable', 'session-history'] as const,
  },
  snapshot: {
    shell: 'bash' as const,
    revision: 1,
    history: ['git status'],
    executables: [{ name: 'git', path: '/usr/bin/git' }],
    truncated: false,
  },
};
const degradedAutocompleteResult = {
  capability: {
    status: 'degraded' as const,
    shell: 'bash' as const,
    sources: ['session-history'] as const,
    reasonCode: 'metadata-unavailable' as const,
  },
  snapshot: null,
};
const mockPrepareSessionAutocomplete = jest.fn(
  async (
    _sessionId: string,
  ): Promise<typeof autocompleteResult | typeof degradedAutocompleteResult> =>
    autocompleteResult,
);
const mockRunSessionCompletion = jest.fn(
  async (_sessionId: string, _command: string) => ({
    stdout: '',
    truncated: false,
  }),
);

jest.mock('../src/store/useMobileAppStore', () => ({
  prepareSessionAutocomplete: (sessionId: string) =>
    mockPrepareSessionAutocomplete(sessionId),
  runSessionCompletion: (sessionId: string, command: string) =>
    mockRunSessionCompletion(sessionId, command),
}));

import { useTerminalAutocomplete } from '../src/hooks/useTerminalAutocomplete';

type HookResult = ReturnType<typeof useTerminalAutocomplete>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

function Harness({
  connected,
  onResult,
  sessionId = 'session-1',
}: {
  connected: boolean;
  onResult: (result: HookResult) => void;
  sessionId?: string;
}) {
  const result = useTerminalAutocomplete({
    sessionId,
    enabled: true,
    connected,
    sendInput: jest.fn(),
  });
  onResult(result);
  return null;
}

describe('useTerminalAutocomplete', () => {
  beforeEach(() => {
    mockPrepareSessionAutocomplete.mockReset();
    mockPrepareSessionAutocomplete.mockResolvedValue(autocompleteResult);
    mockRunSessionCompletion.mockReset();
    mockRunSessionCompletion.mockResolvedValue({
      stdout: '',
      truncated: false,
    });
  });

  it('keeps the first line buffer when a continuation prompt starts', async () => {
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      current!.handleShellIntegration('B');
    });
    act(() => {
      current!.send('echo first');
      current!.handleShellIntegration('B;2');
    });
    expect(current!.command).toBe('echo first');
    expect(current!.suggestions).toEqual([]);
  });

  it('keeps the typed buffer when a prompt redraw marker arrives without a completed command', async () => {
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      // 진짜 첫 프롬프트 경계: D(완료) → A 순으로 온다.
      current!.handleShellIntegration('D;0');
      current!.handleShellIntegration('A');
    });
    act(() => {
      current!.send('git s');
    });
    expect(current!.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ insertText: 'git status' }),
      ]),
    );

    // SIGWINCH 재드로잉(키보드 개폐 → PTY 리사이즈 → 프롬프트 재그리기)은
    // D 없이 A·B 만 재발행한다 — 타이핑 중인 버퍼와 추천이 그대로여야 한다.
    act(() => {
      current!.handleShellIntegration('A');
    });
    expect(current!.command).toBe('git s');
    expect(current!.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ insertText: 'git status' }),
      ]),
    );
    act(() => {
      current!.handleShellIntegration('B');
    });
    expect(current!.command).toBe('git s');

    // 진짜 경계(D → A)에서는 여전히 초기화한다.
    act(() => {
      current!.handleShellIntegration('D;0');
      current!.handleShellIntegration('A');
    });
    expect(current!.command).toBe('');
  });

  it('keeps history-navigation input ambiguous across a prompt redraw', async () => {
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      current!.handleShellIntegration('D;0');
      current!.handleShellIntegration('A');
    });

    act(() => {
      current!.send('\x1b[A');
      current!.handleShellIntegration('A');
      current!.handleShellIntegration('B');
      current!.send('g');
    });

    // The remote readline buffer contains a recalled history entry, while JS
    // intentionally does not know its text. A resize redraw must not turn that
    // unknown state into an exact empty buffer and offer a stale completion.
    expect(current!.command).toBe('g');
    expect(current!.suggestions).toEqual([]);
  });

  it('prepares again after reconnecting the same session record', async () => {
    let current: HookResult | null = null;
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      current!.handleShellIntegration('B');
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree!.update(
        <Harness connected={false} onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      tree!.update(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      current!.handleShellIntegration('B');
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(2);
  });

  it('shows history suggestions after the shell integration prompt marker', async () => {
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });

    await act(async () => {
      current!.handleShellIntegration('B');
    });
    act(() => {
      current!.send('git s');
    });

    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(1);
    expect(current!.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          insertText: 'git status',
          source: 'history',
        }),
      ]),
    );
  });

  it('uses session history when exec metadata is degraded after PTY shell detection', async () => {
    const prepared = deferred<typeof degradedAutocompleteResult>();
    mockPrepareSessionAutocomplete.mockImplementationOnce(
      () => prepared.promise,
    );
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      current!.handleShellIntegration('B');
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(1);
    await act(async () => {
      prepared.resolve(degradedAutocompleteResult);
      await prepared.promise;
    });

    act(() => {
      current!.handleShellIntegration('C', 'git status');
      current!.handleShellIntegration('D;0');
      current!.handleShellIntegration('A');
      current!.send('git s');
    });

    expect(current!.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          insertText: 'git status',
          source: 'history',
        }),
      ]),
    );
  });

  it("does not let an old prepare clear the new connection's in-flight work", async () => {
    const first = deferred<typeof autocompleteResult>();
    const second = deferred<typeof autocompleteResult>();
    mockPrepareSessionAutocomplete
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    let current: HookResult | null = null;
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    act(() => {
      current!.handleShellIntegration('B');
    });
    await act(async () => {
      tree!.update(
        <Harness connected={false} onResult={result => (current = result)} />,
      );
    });
    await act(async () => {
      tree!.update(
        <Harness connected onResult={result => (current = result)} />,
      );
    });
    act(() => {
      current!.handleShellIntegration('B');
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(autocompleteResult);
      await first.promise;
    });
    act(() => {
      current!.handleShellIntegration('B');
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(autocompleteResult);
      await second.promise;
    });
  });

  it('does not cache a dynamic completion from the previous session', async () => {
    jest.useFakeTimers();
    const first = deferred<{ stdout: string; truncated: boolean }>();
    mockRunSessionCompletion
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ stdout: 'new-session/\n', truncated: false });

    let current: HookResult | null = null;
    let tree: renderer.ReactTestRenderer | null = null;
    try {
      await act(async () => {
        tree = renderer.create(
          <Harness
            connected
            sessionId="session-1"
            onResult={result => (current = result)}
          />,
        );
      });
      await act(async () => {
        current!.handleShellIntegration('B');
      });
      act(() => {
        current!.send('cd s');
      });
      await act(async () => {
        jest.advanceTimersByTime(141);
        await Promise.resolve();
      });
      expect(mockRunSessionCompletion).toHaveBeenCalledTimes(1);
      expect(mockRunSessionCompletion.mock.calls[0][0]).toBe('session-1');

      await act(async () => {
        tree!.update(
          <Harness
            connected
            sessionId="session-2"
            onResult={result => (current = result)}
          />,
        );
      });
      await act(async () => {
        first.resolve({ stdout: 'old-session/\n', truncated: false });
        await first.promise;
      });
      await act(async () => {
        current!.handleShellIntegration('B');
      });
      act(() => {
        current!.send('cd s');
      });
      await act(async () => {
        jest.advanceTimersByTime(141);
        await Promise.resolve();
      });

      expect(mockRunSessionCompletion).toHaveBeenCalledTimes(2);
      expect(mockRunSessionCompletion.mock.calls[1][0]).toBe('session-2');
    } finally {
      if (tree) {
        act(() => tree!.unmount());
      }
      jest.useRealTimers();
    }
  });
});
