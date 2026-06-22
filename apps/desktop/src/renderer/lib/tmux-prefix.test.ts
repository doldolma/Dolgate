import { describe, expect, it } from 'vitest';
import {
  TMUX_PREFIX_BYTE,
  mapPrefixKey,
  resolveSiblingWindowId,
  tmuxPrefixByteFromKey,
  type TmuxPrefixResolverContext,
} from './tmux-prefix';

const baseContext: TmuxPrefixResolverContext = {
  orderedWindowIds: ['@1', '@2', '@3'],
  currentWindowId: '@2',
  currentPaneId: '%5',
};

describe('resolveSiblingWindowId', () => {
  it('wraps forward and backward across the window list', () => {
    expect(resolveSiblingWindowId(['@1', '@2', '@3'], '@2', 1)).toBe('@3');
    expect(resolveSiblingWindowId(['@1', '@2', '@3'], '@3', 1)).toBe('@1');
    expect(resolveSiblingWindowId(['@1', '@2', '@3'], '@1', -1)).toBe('@3');
  });

  it('returns the only window when there is a single one', () => {
    expect(resolveSiblingWindowId(['@1'], '@1', 1)).toBe('@1');
  });

  it('returns null for an empty list', () => {
    expect(resolveSiblingWindowId([], '@1', 1)).toBeNull();
  });
});

describe('mapPrefixKey', () => {
  it('maps c to a new window', () => {
    expect(mapPrefixKey('c', baseContext)).toEqual({
      action: { kind: 'newWindow' },
      consumed: 1,
    });
  });

  it('maps % to a horizontal split and " to a vertical split', () => {
    expect(mapPrefixKey('%', baseContext)?.action).toEqual({
      kind: 'splitPane',
      direction: 'h',
    });
    expect(mapPrefixKey('"', baseContext)?.action).toEqual({
      kind: 'splitPane',
      direction: 'v',
    });
  });

  it('maps n/p/l to window navigation', () => {
    expect(mapPrefixKey('n', baseContext)?.action).toEqual({
      kind: 'windowNav',
      target: 'next',
    });
    expect(mapPrefixKey('p', baseContext)?.action).toEqual({
      kind: 'windowNav',
      target: 'prev',
    });
    expect(mapPrefixKey('l', baseContext)?.action).toEqual({
      kind: 'windowNav',
      target: 'last',
    });
  });

  it('maps digits to window navigation by index', () => {
    expect(mapPrefixKey('0', baseContext)?.action).toEqual({
      kind: 'windowNav',
      target: 0,
    });
    expect(mapPrefixKey('3', baseContext)?.action).toEqual({
      kind: 'windowNav',
      target: 3,
    });
  });

  it('maps d to detach, x to killPane, & to killWindow', () => {
    expect(mapPrefixKey('d', baseContext)?.action).toEqual({ kind: 'detach' });
    expect(mapPrefixKey('x', baseContext)?.action).toEqual({ kind: 'killPane' });
    expect(mapPrefixKey('&', baseContext)?.action).toEqual({
      kind: 'killWindow',
    });
  });

  it('maps arrow keys to directional select-pane on the focused pane', () => {
    expect(mapPrefixKey('\x1b[D', baseContext)).toEqual({
      action: { kind: 'command', command: 'select-pane -L -t %5' },
      consumed: 3,
    });
    expect(mapPrefixKey('\x1b[C', baseContext)?.action).toEqual({
      kind: 'command',
      command: 'select-pane -R -t %5',
    });
    expect(mapPrefixKey('\x1b[A', baseContext)?.action).toEqual({
      kind: 'command',
      command: 'select-pane -U -t %5',
    });
    expect(mapPrefixKey('\x1b[B', baseContext)?.action).toEqual({
      kind: 'command',
      command: 'select-pane -D -t %5',
    });
  });

  it('maps Ctrl+arrow keys to resize-pane (consuming 6 bytes)', () => {
    expect(mapPrefixKey('\x1b[1;5D', baseContext)).toEqual({
      action: { kind: 'command', command: 'resize-pane -L -t %5 5' },
      consumed: 6,
    });
    expect(mapPrefixKey('\x1b[1;5A', baseContext)?.action).toEqual({
      kind: 'command',
      command: 'resize-pane -U -t %5 5',
    });
  });

  it('maps pane-management keys to tmux commands targeting the focused pane', () => {
    expect(mapPrefixKey('z', baseContext)?.action).toEqual({
      kind: 'command',
      command: 'resize-pane -Z -t %5',
    });
    expect(mapPrefixKey('{', baseContext)?.action).toEqual({
      kind: 'command',
      command: 'swap-pane -U -t %5',
    });
    expect(mapPrefixKey('}', baseContext)?.action).toEqual({
      kind: 'command',
      command: 'swap-pane -D -t %5',
    });
    expect(mapPrefixKey('!', baseContext)?.action).toEqual({
      kind: 'command',
      command: 'break-pane -t %5',
    });
    expect(mapPrefixKey('[', baseContext)?.action).toEqual({
      kind: 'command',
      command: 'copy-mode -t %5',
    });
    expect(mapPrefixKey(']', baseContext)?.action).toEqual({
      kind: 'command',
      command: 'paste-buffer -t %5',
    });
  });

  it('maps Space to next-layout (window-targeted), o/; to pane cycling', () => {
    expect(mapPrefixKey(' ', baseContext)?.action).toEqual({
      kind: 'command',
      command: 'next-layout -t @2',
    });
    expect(mapPrefixKey('o', baseContext)?.action).toEqual({
      kind: 'command',
      command: 'select-pane -t :.+',
    });
    expect(mapPrefixKey(';', baseContext)?.action).toEqual({
      kind: 'command',
      command: 'last-pane',
    });
    expect(mapPrefixKey('w', baseContext)?.action).toEqual({
      kind: 'command',
      command: 'choose-tree -w',
    });
  });

  it('maps text-input keys (, $ :) to prompt actions', () => {
    expect(mapPrefixKey(',', baseContext)?.action).toEqual({
      kind: 'prompt',
      mode: 'rename-window',
    });
    expect(mapPrefixKey('$', baseContext)?.action).toEqual({
      kind: 'prompt',
      mode: 'rename-session',
    });
    expect(mapPrefixKey(':', baseContext)?.action).toEqual({
      kind: 'prompt',
      mode: 'raw',
    });
  });

  it('passes a doubled prefix through as a single literal Ctrl-b', () => {
    expect(mapPrefixKey(TMUX_PREFIX_BYTE, baseContext)?.action).toEqual({
      kind: 'passthrough',
      data: TMUX_PREFIX_BYTE,
    });
  });

  it('passes truly unmapped keys (e.g. q) through as Ctrl-b + key', () => {
    expect(mapPrefixKey('q', baseContext)?.action).toEqual({
      kind: 'passthrough',
      data: `${TMUX_PREFIX_BYTE}q`,
    });
  });

  it('consumes only the first character of a multi-char chunk', () => {
    const result = mapPrefixKey('cls', baseContext);
    expect(result?.consumed).toBe(1);
    expect(result?.action).toEqual({ kind: 'newWindow' });
  });

  it('uses the configured prefix byte for doubled-prefix and passthrough', () => {
    const ctx: TmuxPrefixResolverContext = { ...baseContext, prefixByte: '\x01' }; // Ctrl-a
    // 더블 prefix → 리터럴 prefix 한 개(설정된 키 기준).
    expect(mapPrefixKey('\x01', ctx)?.action).toEqual({
      kind: 'passthrough',
      data: '\x01',
    });
    // 미매핑 키 → 설정된 prefix + 키.
    expect(mapPrefixKey('q', ctx)?.action).toEqual({
      kind: 'passthrough',
      data: '\x01q',
    });
  });
});

describe('tmuxPrefixByteFromKey', () => {
  it('maps prefix key tokens to control bytes', () => {
    expect(tmuxPrefixByteFromKey('C-b')).toBe('\x02');
    expect(tmuxPrefixByteFromKey('C-a')).toBe('\x01');
    expect(tmuxPrefixByteFromKey('C-Space')).toBe('\x00');
    expect(tmuxPrefixByteFromKey('C-q')).toBe('\x11');
  });

  it('falls back to Ctrl-b for unknown/empty tokens', () => {
    expect(tmuxPrefixByteFromKey(undefined)).toBe('\x02');
    expect(tmuxPrefixByteFromKey('nonsense')).toBe('\x02');
  });
});
