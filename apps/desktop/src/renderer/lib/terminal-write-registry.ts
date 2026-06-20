// stableId 기준으로 살아 있는 터미널에 접근하기 위한 경량 레지스트리.
//
// 터미널 런타임은 pane 컨트롤러의 ref에 있어 store/오케스트레이터에서 직접 접근할 수
// 없다. 컨트롤러가 자신의 훅(write/refresh)을 등록해 두면:
//  - 자동 재연결 흐름(runtimeEventSlice, reconnect-handlers)이 "재연결 중…/재연결됨/
//    실패" 안내선을 해당 터미널에 출력하고(write),
//  - 절전/깨우기 복귀(NetworkBridge)에서 모든 터미널을 강제 재렌더(refresh)해
//    GPU/WebGL 컨텍스트 손실로 인한 빈 화면을 복구한다.
// B1b 덕분에 터미널이 재연결 동안 보존되므로 안내선이 스크롤백에 남는다.

export interface TerminalHooks {
  write: (text: string) => void;
  /** 화면을 강제 재렌더한다(WebGL 컨텍스트 손실/GPU 절전 복귀 후 빈 화면 복구용). */
  refresh: () => void;
  /** 스크롤백 포함 직렬화(리로드 대비 sessionStorage 저장용). */
  serialize: () => string;
  /** 현재 live sessionId. 리로드 후에도 main이 세션을 유지하므로 복원 키로 쓴다. */
  getSessionId: () => string;
}

const hooksByStableId = new Map<string, TerminalHooks>();

export function registerTerminalHooks(
  stableId: string,
  hooks: TerminalHooks,
): void {
  hooksByStableId.set(stableId, hooks);
}

export function unregisterTerminalHooks(
  stableId: string,
  hooks: TerminalHooks,
): void {
  // 다른 인스턴스가 이미 덮어쓴 경우(드묾)엔 지우지 않는다.
  if (hooksByStableId.get(stableId) === hooks) {
    hooksByStableId.delete(stableId);
  }
}

export function writeTerminalNotice(stableId: string, text: string): void {
  hooksByStableId.get(stableId)?.write(text);
}

/** 절전/잠금 복귀 시 모든 살아 있는 터미널을 강제 재렌더한다. */
export function refreshAllTerminals(): void {
  for (const hooks of hooksByStableId.values()) {
    try {
      hooks.refresh();
    } catch {
      // 한 pane의 실패가 나머지를 막지 않게 한다.
    }
  }
}

// --- 스크롤백 스냅샷 안전망 ---
// 터미널이 (어떤 이유로든) 재생성될 때 이전 버퍼를 잃지 않도록, 파괴 직전 스크롤백을
// stableId 기준으로 저장하고 같은 stableId의 새 터미널이 만들어질 때 복원한다.
// B1b로 보존되는 일반 재연결에선 파괴 자체가 없어 사용되지 않고, 잠자기/깨우기처럼
// 터미널이 새로 만들어지는 경우에만 복원이 일어난다.
const SCROLLBACK_CACHE_LIMIT = 30;
const scrollbackByStableId = new Map<string, string>();

export function saveScrollbackSnapshot(stableId: string, snapshot: string): void {
  if (!snapshot) {
    return;
  }
  // 닫힌 탭의 스냅샷이 쌓이지 않도록 오래된 항목을 정리한다.
  if (
    scrollbackByStableId.size >= SCROLLBACK_CACHE_LIMIT &&
    !scrollbackByStableId.has(stableId)
  ) {
    const oldest = scrollbackByStableId.keys().next().value;
    if (oldest !== undefined) {
      scrollbackByStableId.delete(oldest);
    }
  }
  scrollbackByStableId.set(stableId, snapshot);
}

/** 저장된 스크롤백 스냅샷을 꺼내고(소비) 캐시에서 제거한다. */
export function takeScrollbackSnapshot(stableId: string): string | null {
  const snapshot = scrollbackByStableId.get(stableId);
  if (snapshot === undefined) {
    return null;
  }
  scrollbackByStableId.delete(stableId);
  return snapshot;
}

export function clearScrollbackSnapshot(stableId: string): void {
  scrollbackByStableId.delete(stableId);
}

// --- 리로드 생존 스크롤백(sessionStorage) ---
// dev에서 잠자기 후 vite가 페이지를 풀 리로드하면 모듈 메모리(위 Map)가 날아간다.
// sessionStorage는 location.reload()에도 살아남고(창이 닫힐 때만 비워짐) sessionId는
// 리로드 후에도 main이 세션을 유지하므로, sessionId를 키로 저장/복원하면 리로드를
// 건너뛰고 스크롤백을 되살릴 수 있다. 앱 완전 종료 시엔 자동으로 비워져 stale 복원이 없다.
const SESSION_SCROLLBACK_PREFIX = "dolssh.scrollback.";
// 개별 스냅샷이 너무 크면 sessionStorage quota를 넘기므로 상한을 둔다.
const SESSION_SCROLLBACK_MAX_CHARS = 512 * 1024;

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** 살아 있는 모든 터미널의 스크롤백을 sessionStorage에 저장한다(beforeunload에서 호출). */
export function persistAllScrollbackToSession(): void {
  const store = safeSessionStorage();
  if (!store) {
    return;
  }
  for (const hooks of hooksByStableId.values()) {
    try {
      const sessionId = hooks.getSessionId();
      if (!sessionId) {
        continue;
      }
      const snapshot = hooks.serialize();
      if (!snapshot || snapshot.length > SESSION_SCROLLBACK_MAX_CHARS) {
        continue;
      }
      store.setItem(`${SESSION_SCROLLBACK_PREFIX}${sessionId}`, snapshot);
    } catch {
      // quota 초과 등은 무시하고 나머지를 계속 저장한다.
    }
  }
}

/** sessionStorage에서 해당 sessionId의 스크롤백을 꺼내고(소비) 제거한다. */
export function loadScrollbackFromSession(sessionId: string): string | null {
  const store = safeSessionStorage();
  if (!store || !sessionId) {
    return null;
  }
  try {
    const key = `${SESSION_SCROLLBACK_PREFIX}${sessionId}`;
    const snapshot = store.getItem(key);
    if (snapshot !== null) {
      store.removeItem(key);
    }
    return snapshot;
  } catch {
    return null;
  }
}

