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
    }
  | {
      /** 원격 모니터 하나만 띄우는 전체화면 창. */
      kind: 'rdp-monitor';
      sessionId: string;
      monitorIndex: number;
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

  if (windowKind === 'rdp-monitor') {
    const sessionId = params.get('sessionId')?.trim() ?? '';
    // Number(null) 은 0 이라 파라미터가 통째로 빠진 경우가 "0번 모니터"로 통과한다. 원문을
    // 먼저 확인해야 한다.
    const rawIndex = params.get('monitorIndex')?.trim() ?? '';
    const monitorIndex = Number(rawIndex);
    // 번호가 없거나 이상하면 메인 창으로 떨어뜨린다 — 잘못된 인덱스로 열면 빈 화면만 남는다.
    if (
      !sessionId ||
      rawIndex === '' ||
      !Number.isInteger(monitorIndex) ||
      monitorIndex < 0
    ) {
      return { kind: 'main' };
    }

    return {
      kind: 'rdp-monitor',
      sessionId,
      monitorIndex,
    };
  }

  return { kind: 'main' };
}
