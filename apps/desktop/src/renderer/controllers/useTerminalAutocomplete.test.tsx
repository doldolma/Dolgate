import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreEvent } from '@shared';
import { parseCwdFromOsc7, useTerminalAutocomplete } from './useTerminalAutocomplete';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  query: vi.fn(async (_sessionId: string, _command: string) => ''),
  listener: null as ((event: CoreEvent) => void) | null,
}));

vi.mock('../services/desktop/terminal', () => ({
  prepareTerminalAutocomplete: mocks.prepare,
  stopTerminalAutocomplete: mocks.stop,
  // 픽스처는 stdout 문자열이다 — 결과 객체로 감싼다.
  queryTerminalCompletion: async (sessionId: string, command: string) => {
    const answer = await mocks.query(sessionId, command);
    return typeof answer === 'string' ? { stdout: answer, exitCode: 0, stderr: '' } : answer;
  },
  subscribeToTerminalEvents: vi.fn((listener: (event: CoreEvent) => void) => {
    mocks.listener = listener;
    return () => {
      mocks.listener = null;
    };
  }),
}));

describe('useTerminalAutocomplete', () => {
  beforeEach(() => {
    mocks.prepare.mockClear();
    mocks.stop.mockClear();
    mocks.query.mockClear();
    mocks.query.mockImplementation(async () => '');
    mocks.listener = null;
  });

  it('parses OSC 7 cwd payloads for Unix, Windows, and fallback values', () => {
    expect(parseCwdFromOsc7('file://host/home/u')).toBe('/home/u');
    expect(parseCwdFromOsc7('file:///C:/Users/Computer/My%20Folder')).toBe(
      'C:\\Users\\Computer\\My Folder',
    );
    expect(parseCwdFromOsc7('C:\\raw\\path')).toBe('C:\\raw\\path');
    expect(parseCwdFromOsc7('')).toBeNull();
  });

  it('does not probe or subscribe while the setting is disabled', () => {
    const sendInput = vi.fn();
    renderHook(() =>
      useTerminalAutocomplete({
        sessionId: 'session-1',
        enabled: false,
        connected: true,
        lazyPrepare: false,
        sendInput,
      }),
    );

    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.listener).toBeNull();
  });

  it('loads a snapshot, ranks candidates, and sends only the accepted suffix', async () => {
    const sendInput = vi.fn();
    const { result } = renderHook(() =>
      useTerminalAutocomplete({
        sessionId: 'session-1',
        enabled: true,
        connected: true,
        lazyPrepare: false,
        sendInput,
      }),
    );

    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('session-1'));
    act(() => {
      mocks.listener?.({
        type: 'terminalAutocompleteSnapshot',
        sessionId: 'session-1',
        payload: {
          shell: 'bash',
          revision: 1,
          history: ['git status'],
          executables: [{ name: 'git', path: '/usr/bin/git' }],
          truncated: false,
        },
      });
      mocks.listener?.({
        type: 'terminalAutocompleteCapability',
        sessionId: 'session-1',
        payload: {
          status: 'ready',
          shell: 'bash',
          sources: ['history', 'executable', 'session-history'],
        },
      });
      // The OSC 133 prompt marker confirms the shell-integration handshake,
      // which gates the suggestions on.
      result.current.handleShellMarker('A');
      result.current.handleInput('git');
    });

    await waitFor(() => expect(result.current.suggestions[0]?.insertText).toBe('git status'));
    act(() => result.current.handleInput('\t'));

    expect(sendInput).toHaveBeenNthCalledWith(1, 'git');
    expect(sendInput).toHaveBeenNthCalledWith(2, ' status');
  });

  it('suppresses suggestions until the OSC 133 handshake confirms integration', async () => {
    const sendInput = vi.fn();
    const { result } = renderHook(() =>
      useTerminalAutocomplete({
        sessionId: 'session-1',
        enabled: true,
        connected: true,
        lazyPrepare: false,
        sendInput,
      }),
    );

    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('session-1'));
    act(() => {
      mocks.listener?.({
        type: 'terminalAutocompleteSnapshot',
        sessionId: 'session-1',
        payload: {
          shell: 'bash',
          revision: 1,
          history: ['git status'],
          executables: [],
          truncated: false,
        },
      });
      result.current.handleInput('git');
    });

    // A snapshot exists and the 3-char prefix matches, but without an OSC 133
    // prompt marker the shell integration is unconfirmed, so nothing is shown.
    expect(result.current.suggestions).toEqual([]);

    // The marker resets the command buffer, so re-type the prefix afterwards.
    act(() => result.current.handleShellMarker('A'));
    act(() => result.current.handleInput('git'));
    await waitFor(() =>
      expect(result.current.suggestions[0]?.insertText).toBe('git status'),
    );
  });

  it.each(['before typing', 'after typing'])('restores tmux completion %s without Enter or clearing input', async (timing) => {
    const sessionId = 'tmux:reattached:0';
    const sendInput = vi.fn();
    const { result } = renderHook(() =>
      useTerminalAutocomplete({ sessionId, enabled: true, connected: true, lazyPrepare: false, sendInput }),
    );
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith(sessionId));
    act(() => mocks.listener?.({
      type: 'terminalAutocompleteSnapshot', sessionId,
      payload: { shell: 'bash', revision: 1, history: ['git status'], executables: [], truncated: false },
    }));
    const restore = () => mocks.listener?.({
      type: 'terminalAutocompleteShellState', sessionId,
      payload: { kind: 'integrationRestored', shell: 'bash', cwd: '/srv/project' },
    });
    if (timing === 'before typing') act(restore);
    act(() => result.current.handleInput('git'));
    if (timing === 'after typing') {
      expect(result.current.suggestions).toEqual([]);
      act(restore);
    }
    expect(result.current.command.value).toBe('git');
    await waitFor(() => expect(result.current.suggestions[0]?.insertText).toBe('git status'));
    act(() => result.current.handleInput('\t'));
    expect(sendInput.mock.calls).toEqual([['git'], [' status']]);
  });

  it('requires integration confirmation for the current session, including when accepting with Tab', async () => {
    const sendInput = vi.fn();
    const { result } = renderHook(() =>
      useTerminalAutocomplete({ sessionId: 'tmux:reattached:0', enabled: true, connected: true, lazyPrepare: false, sendInput }),
    );
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalled());
    act(() => {
      mocks.listener?.({
        type: 'terminalAutocompleteSnapshot', sessionId: 'tmux:reattached:0',
        payload: { shell: 'bash', revision: 1, history: ['git status'], executables: [], truncated: false },
      });
      mocks.listener?.({
        type: 'terminalAutocompleteShellState', sessionId: 'tmux:reattached:0',
        payload: { kind: 'shellReady', shell: 'bash' },
      });
      mocks.listener?.({
        type: 'terminalAutocompleteShellState', sessionId: 'tmux:reattached:1',
        payload: { kind: 'integrationRestored', shell: 'bash' },
      });
      result.current.handleInput('git');
    });
    expect(result.current.suggestions).toEqual([]);
    act(() => result.current.handleInput('\t'));
    expect(sendInput.mock.calls).toEqual([['git'], ['\t']]);
  });

  it.each([false, true])('uses the restored tmux cwd unless a live OSC 7 already supplied it (live=%s)', async (live) => {
    const sessionId = 'tmux:reattached:0';
    mocks.query.mockResolvedValue('hosts\n');
    const { result } = renderHook(() =>
      useTerminalAutocomplete({ sessionId, enabled: true, connected: true, lazyPrepare: false, sendInput: vi.fn() }),
    );
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalled());
    act(() => {
      if (live) result.current.handleCwd('file:///srv/newer');
      mocks.listener?.({
        type: 'terminalAutocompleteSnapshot', sessionId,
        payload: { shell: 'bash', revision: 1, history: [], executables: [], truncated: false },
      });
      mocks.listener?.({
        type: 'terminalAutocompleteShellState', sessionId,
        payload: { kind: 'integrationRestored', shell: 'bash', cwd: '/srv/my project' },
      });
      result.current.handleInput('cat ./hos');
    });
    await waitFor(() => expect(mocks.query).toHaveBeenCalled());
    expect(mocks.query.mock.calls[0]?.[1]).toContain(live ? '/srv/newer' : '/srv/my project');
    await waitFor(() => expect(result.current.suggestions.some((item) => item.insertText === 'cat ./hosts')).toBe(true));
  });

  it('keeps autocomplete disabled for unsupported shells even after shell integration', async () => {
    const sendInput = vi.fn();
    const { result } = renderHook(() =>
      useTerminalAutocomplete({
        sessionId: 'session-1',
        enabled: true,
        connected: true,
        lazyPrepare: false,
        sendInput,
      }),
    );

    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('session-1'));
    act(() => {
      mocks.listener?.({
        type: 'terminalAutocompleteSnapshot',
        sessionId: 'session-1',
        payload: {
          shell: 'bash',
          revision: 1,
          history: ['git status'],
          executables: [],
          truncated: false,
        },
      });
      mocks.listener?.({
        type: 'terminalAutocompleteCapability',
        sessionId: 'session-1',
        payload: {
          status: 'unsupported',
          reasonCode: 'unsupported-shell',
        },
      });
      result.current.handleShellMarker('A');
      result.current.handleInput('git');
    });

    expect(result.current.suggestions).toEqual([]);
  });

  it('waits for the lazy AWS probe before replaying the first input', async () => {
    let release: (() => void) | undefined;
    mocks.prepare.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      }),
    );
    const sendInput = vi.fn();
    const { result } = renderHook(() =>
      useTerminalAutocomplete({
        sessionId: 'session-aws',
        enabled: true,
        connected: true,
        lazyPrepare: true,
        sendInput,
      }),
    );

    act(() => result.current.handleInput('l'));
    expect(sendInput).not.toHaveBeenCalled();

    await act(async () => release?.());
    expect(sendInput).toHaveBeenCalledWith('l');
  });

  async function mountReadySession() {
    const sendInput = vi.fn();
    const hook = renderHook(() =>
      useTerminalAutocomplete({
        sessionId: 'session-1',
        enabled: true,
        connected: true,
        lazyPrepare: false,
        sendInput,
      }),
    );
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('session-1'));
    act(() => {
      mocks.listener?.({
        type: 'terminalAutocompleteSnapshot',
        sessionId: 'session-1',
        payload: {
          shell: 'bash',
          revision: 1,
          history: [],
          executables: [],
          truncated: false,
        },
      });
      hook.result.current.handleShellMarker('A');
    });
    return hook;
  }

  it('merges host path completions and caches the directory listing', async () => {
    mocks.query.mockResolvedValue('hostname\nhosts\nhost.conf\npasswd\n');
    const { result } = await mountReadySession();

    act(() => result.current.handleInput('cat /etc/ho'));

    await waitFor(() =>
      expect(
        result.current.suggestions.some(
          (entry) => entry.insertText === 'cat /etc/hostname',
        ),
      ).toBe(true),
    );
    // One `ls` per directory; the basename prefix is filtered client-side.
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith('session-1', "ls -1Ap -- '/etc/'");
    const paths = result.current.suggestions.filter(
      (entry) => entry.source === 'path',
    );
    expect(new Set(paths.map((entry) => entry.insertText))).toEqual(
      new Set(['cat /etc/hostname', 'cat /etc/hosts', 'cat /etc/host.conf']),
    );

    // Typing more of the basename in the same directory is a cache hit.
    act(() => result.current.handleInput('s'));
    await waitFor(() =>
      expect(
        result.current.suggestions.some(
          (entry) => entry.insertText === 'cat /etc/hosts',
        ),
      ).toBe(true),
    );
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('invalidates the dynamic cache on the OSC 133 command boundary', async () => {
    mocks.query.mockResolvedValue('alpha\nbeta\n');
    const { result } = await mountReadySession();

    act(() => result.current.handleInput('ls /tmp/a'));
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));

    // A command ran (D marker) — host state may have changed, so the cache is
    // dropped and the same directory is re-listed on the next keystroke.
    act(() => result.current.handleShellMarker('D'));
    act(() => result.current.handleInput('l'));
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2));
    expect(mocks.query).toHaveBeenLastCalledWith(
      'session-1',
      "ls -1Ap -- '/tmp/'",
    );
  });

  it('does not query the host for a non-path argument', async () => {
    const { result } = await mountReadySession();

    act(() => result.current.handleInput('git commit -m hel'));
    // Give the debounce window a chance to (not) fire.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('runs a Fig generator and merges its values (git branches)', async () => {
    // git checkout accepts branches AND tags — its arg has multiple generators,
    // each running its own command. The bundled spec's postProcess turns each
    // into clean names.
    mocks.query.mockImplementation(async (_sessionId: string, cmd: string) => {
      if (cmd.includes(' tag ') || cmd.includes("'tag'")) {
        return 'v1.0\nv2.0\n';
      }
      if (cmd.includes('branch')) {
        return '  main\n* feature/login\n  develop\n';
      }
      return '';
    });
    const { result } = await mountReadySession();
    act(() => result.current.handleCwd('file://host/home/u/proj'));
    act(() => result.current.handleInput('git checkout '));

    await waitFor(
      () =>
        expect(
          result.current.suggestions.some(
            (entry) => entry.insertText === 'git checkout main',
          ),
        ).toBe(true),
      { timeout: 3000 },
    );
    const generated = result.current.suggestions.filter(
      (entry) => entry.source === 'generator',
    );
    const texts = generated.map((entry) => entry.insertText);
    // Clean branch names surface (postProcess stripped the "* " / leading spaces).
    expect(texts).toContain('git checkout main');
    expect(texts).toContain('git checkout feature/login');
    // No unshaped garbage (raw "  branch" / "* branch" lines).
    expect(
      texts.every((text) => !/^git checkout (\s|\*)/.test(text)),
    ).toBe(true);
    // It ran `git branch` on the host, cd'd into the session cwd.
    expect(
      mocks.query.mock.calls.some(
        ([, cmd]) => cmd.includes('branch') && cmd.includes('/home/u/proj'),
      ),
    ).toBe(true);
  });

  it('caches generator output — typing a prefix filters client-side, no re-query', async () => {
    mocks.query.mockImplementation(async (_sessionId: string, cmd: string) => {
      if (cmd.includes(' tag ') || cmd.includes("'tag'")) {
        return 'v1.0\nv2.0\n';
      }
      if (cmd.includes('branch')) {
        return '  main\n* feature\n  master\n';
      }
      return '';
    });
    const { result } = await mountReadySession();
    act(() => result.current.handleCwd('file://host/home/u/proj'));
    act(() => result.current.handleInput('git checkout '));
    await waitFor(
      () =>
        expect(
          result.current.suggestions.some((e) => e.insertText === 'git checkout main'),
        ).toBe(true),
      { timeout: 3000 },
    );
    const callsAfterList = mocks.query.mock.calls.length;

    // Typing a prefix must filter the already-fetched list, not re-run the host
    // commands (the bug: generator path ignored the cache and re-queried).
    act(() => result.current.handleInput('ma'));
    await waitFor(
      () =>
        expect(
          result.current.suggestions.some((e) => e.insertText === 'git checkout master'),
        ).toBe(true),
    );
    expect(result.current.suggestions.some((e) => e.insertText === 'git checkout main')).toBe(
      true,
    );
    // 'feature' no longer matches 'ma'.
    expect(
      result.current.suggestions.some((e) => e.insertText === 'git checkout feature'),
    ).toBe(false);
    // No new host calls — served from cache.
    expect(mocks.query.mock.calls.length).toBe(callsAfterList);
  });

  it('uses the docker generator override and filters cached container names', async () => {
    mocks.query.mockImplementation(async (_sessionId: string, cmd: string) => {
      if (cmd.includes("'docker'") && cmd.includes("'ps'")) {
        return 'web\tnginx\napi\trepo/app:1\n';
      }
      return '';
    });
    const { result } = await mountReadySession();
    act(() => result.current.handleCwd('file://host/home/u/proj'));
    act(() => result.current.handleInput('docker logs '));

    await waitFor(
      () =>
        expect(
          result.current.suggestions.some((entry) => entry.insertText === 'docker logs web'),
        ).toBe(true),
      { timeout: 3000 },
    );
    const hostCommand = mocks.query.mock.calls[0]?.[1] ?? '';
    expect(hostCommand).toContain("'docker' 'ps' '--format'");
    expect(hostCommand).toContain('{{.Names}}\t{{.Image}}');
    expect(hostCommand).not.toContain('{{ json . }}');
    const callsAfterList = mocks.query.mock.calls.length;

    act(() => result.current.handleInput('we'));

    await waitFor(() =>
      expect(
        result.current.suggestions.some((entry) => entry.insertText === 'docker logs web'),
      ).toBe(true),
    );
    expect(
      result.current.suggestions.some((entry) => entry.insertText === 'docker logs api'),
    ).toBe(false);
    expect(mocks.query.mock.calls.length).toBe(callsAfterList);
  });

  it('moves the highlight with arrow keys and Tab accepts the highlighted one', async () => {
    const sendInput = vi.fn();
    const { result } = renderHook(() =>
      useTerminalAutocomplete({
        sessionId: 'session-1',
        enabled: true,
        connected: true,
        lazyPrepare: false,
        sendInput,
      }),
    );
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('session-1'));
    act(() => {
      mocks.listener?.({
        type: 'terminalAutocompleteSnapshot',
        sessionId: 'session-1',
        payload: {
          shell: 'bash',
          revision: 1,
          history: ['git stash', 'git status'],
          executables: [],
          truncated: false,
        },
      });
      result.current.handleShellMarker('A');
      result.current.handleInput('git st');
    });
    await waitFor(() =>
      expect(result.current.suggestions.length).toBeGreaterThanOrEqual(2),
    );
    expect(result.current.selectedIndex).toBe(0);

    act(() => result.current.handleInput('\x1b[B')); // ↓
    expect(result.current.selectedIndex).toBe(1);
    act(() => result.current.handleInput('\x1b[A')); // ↑
    expect(result.current.selectedIndex).toBe(0);

    act(() => result.current.handleInput('\x1b[B')); // ↓ to the second item
    const second = result.current.suggestions[1].insertText;
    sendInput.mockClear();
    act(() => result.current.handleInput('\t')); // accept the highlighted one
    expect(sendInput).toHaveBeenCalledWith(second.slice('git st'.length));
  });

  it('passes ↑ through to the shell when the top suggestion is highlighted', async () => {
    const sendInput = vi.fn();
    const { result } = renderHook(() =>
      useTerminalAutocomplete({
        sessionId: 'session-1',
        enabled: true,
        connected: true,
        lazyPrepare: false,
        sendInput,
      }),
    );
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('session-1'));
    act(() => {
      mocks.listener?.({
        type: 'terminalAutocompleteSnapshot',
        sessionId: 'session-1',
        payload: {
          shell: 'bash',
          revision: 1,
          history: ['git status'],
          executables: [],
          truncated: false,
        },
      });
      result.current.handleShellMarker('A');
      result.current.handleInput('git st');
    });
    await waitFor(() =>
      expect(result.current.suggestions.length).toBeGreaterThanOrEqual(1),
    );
    expect(result.current.selectedIndex).toBe(0);
    sendInput.mockClear();
    // ↑ at the top falls through so the shell still gets history recall.
    act(() => result.current.handleInput('\x1b[A'));
    expect(sendInput).toHaveBeenCalledWith('\x1b[A');
  });

  it('Enter accepts the highlighted suggestion after navigating, without running', async () => {
    const sendInput = vi.fn();
    const { result } = renderHook(() =>
      useTerminalAutocomplete({
        sessionId: 'session-1',
        enabled: true,
        connected: true,
        lazyPrepare: false,
        sendInput,
      }),
    );
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('session-1'));
    act(() => {
      mocks.listener?.({
        type: 'terminalAutocompleteSnapshot',
        sessionId: 'session-1',
        payload: {
          shell: 'bash',
          revision: 1,
          history: ['git stash', 'git status'],
          executables: [],
          truncated: false,
        },
      });
      result.current.handleShellMarker('A');
      result.current.handleInput('git st');
    });
    await waitFor(() =>
      expect(result.current.suggestions.length).toBeGreaterThanOrEqual(2),
    );
    act(() => result.current.handleInput('\x1b[B')); // ↓ to a non-top item
    const second = result.current.suggestions[1].insertText;
    sendInput.mockClear();
    act(() => result.current.handleInput('\r')); // Enter accepts (does not run)
    expect(sendInput).toHaveBeenCalledWith(second.slice('git st'.length));
    expect(sendInput).not.toHaveBeenCalledWith('\r');
  });

  it('Enter at the top runs the command (passes through)', async () => {
    const sendInput = vi.fn();
    const { result } = renderHook(() =>
      useTerminalAutocomplete({
        sessionId: 'session-1',
        enabled: true,
        connected: true,
        lazyPrepare: false,
        sendInput,
      }),
    );
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('session-1'));
    act(() => {
      mocks.listener?.({
        type: 'terminalAutocompleteSnapshot',
        sessionId: 'session-1',
        payload: {
          shell: 'bash',
          revision: 1,
          history: ['git status'],
          executables: [],
          truncated: false,
        },
      });
      result.current.handleShellMarker('A');
      result.current.handleInput('git st');
    });
    await waitFor(() =>
      expect(result.current.suggestions.length).toBeGreaterThanOrEqual(1),
    );
    expect(result.current.selectedIndex).toBe(0);
    sendInput.mockClear();
    act(() => result.current.handleInput('\r')); // top selected → Enter runs
    expect(sendInput).toHaveBeenCalledWith('\r');
  });

  it('never suggests our own shell-integration injection from history', async () => {
    const sendInput = vi.fn();
    const { result } = renderHook(() =>
      useTerminalAutocomplete({
        sessionId: 'session-1',
        enabled: true,
        connected: true,
        lazyPrepare: false,
        sendInput,
      }),
    );
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith('session-1'));
    act(() => {
      mocks.listener?.({
        type: 'terminalAutocompleteSnapshot',
        sessionId: 'session-1',
        payload: {
          shell: 'bash',
          revision: 1,
          // The OSC 133 init can leak into history concatenated onto a line.
          history: [
            "git status __ds_o(){ printf '\\033]133;%s\\007' \"$1\"; }",
            'git stash',
          ],
          executables: [],
          truncated: false,
        },
      });
      result.current.handleShellMarker('A');
      result.current.handleInput('git ');
    });
    await waitFor(() =>
      expect(result.current.suggestions.length).toBeGreaterThan(0),
    );
    expect(
      result.current.suggestions.some((e) => e.insertText.includes('__ds_')),
    ).toBe(false);
    // Legitimate history is still suggested.
    expect(
      result.current.suggestions.some((e) => e.insertText === 'git stash'),
    ).toBe(true);
  });
});
