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

describe('rdp-monitor windows', () => {
  it('carries the session and monitor number', () => {
    expect(
      resolveRendererWindowMode('?window=rdp-monitor&sessionId=s1&monitorIndex=2'),
    ).toEqual({ kind: 'rdp-monitor', sessionId: 's1', monitorIndex: 2 });
  });

  it('accepts the first monitor', () => {
    // 0 은 falsy 라 검사에서 흘리기 쉽다.
    expect(
      resolveRendererWindowMode('?window=rdp-monitor&sessionId=s1&monitorIndex=0'),
    ).toEqual({ kind: 'rdp-monitor', sessionId: 's1', monitorIndex: 0 });
  });

  it('falls back to the main window when the number is unusable', () => {
    // 잘못된 번호로 열면 빈 화면만 남는다 — 그럴 바에는 평소 창을 띄운다.
    for (const search of [
      '?window=rdp-monitor&sessionId=s1',
      '?window=rdp-monitor&sessionId=s1&monitorIndex=x',
      '?window=rdp-monitor&sessionId=s1&monitorIndex=-1',
      '?window=rdp-monitor&sessionId=s1&monitorIndex=1.5',
      '?window=rdp-monitor&monitorIndex=0',
    ]) {
      expect(resolveRendererWindowMode(search)).toEqual({ kind: 'main' });
    }
  });
});
