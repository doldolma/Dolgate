// 셸 자체의 히스토리(`~/.bash_history` · `~/.zsh_history`)를 세션별로 보관하는 경량 레지스트리.
//
// **새로 가져오는 것이 아니다.** 자동완성이 연결할 때 스냅샷으로 이미 그 파일의 마지막
// 2000줄을 받아 온다(ssh-core 의 `RemoteSnapshotCommand`). 그 값을 세션 패널의 히스토리
// 섹션도 보게 하려고 여기 둔다 — 원격에 명령을 한 번 더 보내지 않는다.
//
// Go 쪽에서 이미 정리해서 올린다: zsh 확장 히스토리 접두사(`: 1690000000:0;`)를 떼고, 우리가
// 주입한 셸 통합·스냅샷 명령을 걸러내고, 제어문자가 든 줄은 버린다. 그래서 여기 있는 것은
// **한 줄짜리 깨끗한 명령**뿐이고, 화면에서 읽어 낸 명령(terminal-command-blocks)과 달리
// 보조 프롬프트가 섞일 일이 없다 — 그대로 실행해도 안전하다.
//
// 스토어에 두지 않는 이유는 terminal-command-blocks 와 같다 — 연결마다 한 번 오는 값이고,
// 보는 쪽은 구독으로 충분하다.

interface Entry {
  history: readonly string[];
  version: number;
  listeners: Set<() => void>;
}

const entries = new Map<string, Entry>();

function entryFor(sessionId: string): Entry {
  let entry = entries.get(sessionId);
  if (!entry) {
    entry = { history: [], version: 0, listeners: new Set() };
    entries.set(sessionId, entry);
  }
  return entry;
}

/** 자동완성 스냅샷이 도착하면 그 히스토리를 넘겨 준다. null 이면 비운다. */
export function setShellHistory(
  sessionId: string,
  history: readonly string[] | null,
): void {
  if (!sessionId) {
    return;
  }
  const entry = entryFor(sessionId);
  const next = history ?? [];
  // 같은 값이 다시 와도(스냅샷 재요청) 구독자를 깨우지 않는다.
  if (entry.history.length === next.length && entry.history.every((line, index) => line === next[index])) {
    return;
  }
  entry.history = next;
  entry.version += 1;
  for (const listener of [...entry.listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[shell-history] listener threw', error);
    }
  }
}

/** 오래된 → 최신 순. 파일에 append 되는 순서 그대로다. */
export function getShellHistory(sessionId: string): readonly string[] {
  return entries.get(sessionId)?.history ?? [];
}

export function getShellHistoryVersion(sessionId: string): number {
  return entries.get(sessionId)?.version ?? 0;
}

export function subscribeToShellHistory(
  sessionId: string,
  listener: () => void,
): () => void {
  const entry = entryFor(sessionId);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && entry.history.length === 0) {
      entries.delete(sessionId);
    }
  };
}
