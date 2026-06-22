import { describe, expect, it } from 'vitest';
import {
  TMUX_PREFIX_BYTE,
  mapPrefixKey,
  resolveSiblingWindowId,
  type TmuxPrefixResolverContext,
} from './tmux-prefix';

const baseContext: TmuxPrefixResolverContext = {
  orderedWindowIds: ['@1', '@2', '@3'],
  currentWindowId: '@2',
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

  it('maps n/p to the resolved sibling window', () => {
    expect(mapPrefixKey('n', baseContext)?.action).toEqual({
      kind: 'selectWindow',
      windowId: '@3',
    });
    expect(mapPrefixKey('p', baseContext)?.action).toEqual({
      kind: 'selectWindow',
      windowId: '@1',
    });
  });

  it('maps d to detach and x to killPane', () => {
    expect(mapPrefixKey('d', baseContext)?.action).toEqual({ kind: 'detach' });
    expect(mapPrefixKey('x', baseContext)?.action).toEqual({ kind: 'killPane' });
  });

  it('passes a doubled prefix through as a single literal Ctrl-b', () => {
    expect(mapPrefixKey(TMUX_PREFIX_BYTE, baseContext)?.action).toEqual({
      kind: 'passthrough',
      data: TMUX_PREFIX_BYTE,
    });
  });

  it('passes unmapped keys (e.g. z=zoom) through as Ctrl-b + key', () => {
    expect(mapPrefixKey('z', baseContext)?.action).toEqual({
      kind: 'passthrough',
      data: `${TMUX_PREFIX_BYTE}z`,
    });
  });

  it('falls back to passthrough for n/p when no sibling windows are known', () => {
    expect(
      mapPrefixKey('n', { orderedWindowIds: [], currentWindowId: '@2' })?.action,
    ).toEqual({ kind: 'passthrough', data: `${TMUX_PREFIX_BYTE}n` });
  });

  it('consumes only the first character of a multi-char chunk', () => {
    const result = mapPrefixKey('cls', baseContext);
    expect(result?.consumed).toBe(1);
    expect(result?.action).toEqual({ kind: 'newWindow' });
  });
});
