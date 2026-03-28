import { describe, expect, it } from 'vitest';
import { resolveRendererWindowMode } from './window-mode';

describe('resolveRendererWindowMode', () => {
  it('returns the detached chat mode when query params are present', () => {
    expect(
      resolveRendererWindowMode('?window=session-share-chat&sessionId=session-1'),
    ).toEqual({
      kind: 'session-share-chat',
      sessionId: 'session-1',
    });
  });

  it('falls back to the main app mode when the session id is missing', () => {
    expect(resolveRendererWindowMode('?window=session-share-chat')).toEqual({
      kind: 'main',
    });
  });

  it('falls back to the main app mode for unrelated windows', () => {
    expect(resolveRendererWindowMode('?window=main')).toEqual({
      kind: 'main',
    });
  });

  it('returns the session replay mode when a recording id is present', () => {
    expect(
      resolveRendererWindowMode('?window=session-replay&recordingId=recording-1'),
    ).toEqual({
      kind: 'session-replay',
      recordingId: 'recording-1',
    });
  });
});
