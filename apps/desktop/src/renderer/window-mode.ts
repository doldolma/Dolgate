export type RendererWindowMode =
  | {
      kind: 'main';
    }
  | {
      kind: 'session-share-chat';
      sessionId: string;
    };

export function resolveRendererWindowMode(search: string): RendererWindowMode {
  const params = new URLSearchParams(search);
  if (params.get('window') !== 'session-share-chat') {
    return { kind: 'main' };
  }

  const sessionId = params.get('sessionId')?.trim() ?? '';
  if (!sessionId) {
    return { kind: 'main' };
  }

  return {
    kind: 'session-share-chat',
    sessionId,
  };
}
