export type RendererWindowMode =
  | {
      kind: 'main';
    }
  | {
      kind: 'session-share-chat';
      sessionId: string;
    }
  | {
      kind: 'session-replay';
      recordingId: string;
    };

export function resolveRendererWindowMode(search: string): RendererWindowMode {
  const params = new URLSearchParams(search);
  const windowKind = params.get('window');
  if (windowKind === 'session-share-chat') {
    const sessionId = params.get('sessionId')?.trim() ?? '';
    if (!sessionId) {
      return { kind: 'main' };
    }

    return {
      kind: 'session-share-chat',
      sessionId,
    };
  }

  if (windowKind === 'session-replay') {
    const recordingId = params.get('recordingId')?.trim() ?? '';
    if (!recordingId) {
      return { kind: 'main' };
    }

    return {
      kind: 'session-replay',
      recordingId,
    };
  }

  if (windowKind !== 'session-share-chat') {
    return { kind: 'main' };
  }

  return { kind: 'main' };
}
