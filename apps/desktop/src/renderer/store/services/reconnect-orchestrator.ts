// 자동 재연결 오케스트레이터 (코어 엔진).
//
// 책임: 백오프 스케줄링, 오프라인/절전 게이팅, 동시 재연결 상한, 최대 시도 횟수.
// "무엇을 어떻게 재연결할지"(터미널/SFTP/포워딩)는 ReconnectHandler로 분리해
// 각 기능 슬라이스가 등록한다. 모든 휘발 상태는 store 밖 이 모듈의 Map에 둔다.
//
// 동작 흐름:
//  1) runtimeEventSlice가 예기치 않은 끊김을 감지 → scheduleReconnect() 호출.
//  2) 엔진이 백오프 후 handler.perform()으로 실제 재연결을 시작.
//  3) 성공(connected 등)/사용자 종료 → cancelReconnect()로 정리.
//     실패(또 다른 closed/error) → runtimeEventSlice가 scheduleReconnect() 재호출
//     → attempt 증가, maxAttempts 초과 시 handler.renderGaveUp().

export type ReconnectKind = "session" | "sftp" | "portForward" | "tmux";

export type ReconnectMeta = Record<string, unknown>;

export interface ReconnectAttemptInfo {
  /** 이번에 실행될(1-based) 시도 번호. */
  attempt: number;
  maxAttempts: number;
  /** 다음 시도 예정 시각(epoch ms). 오프라인이면 0. */
  nextAttemptAt: number;
  delayMs: number;
  /** 네트워크 대기 중(오프라인)이라 타이머 없이 대기 상태인지. */
  waitingForNetwork: boolean;
}

export interface ReconnectHandler {
  /** 백오프 대기/실행 직전 UI를 'reconnecting'으로 표시. */
  renderScheduled(key: string, info: ReconnectAttemptInfo, meta: ReconnectMeta): void;
  /** 실제 재연결 시작. 성공/실패 판정은 이후 core-event가 한다. */
  perform(key: string, meta: ReconnectMeta): Promise<void>;
  /** 최대 시도 초과로 포기. */
  renderGaveUp(
    key: string,
    info: { attempts: number; reason: string },
    meta: ReconnectMeta,
  ): void;
  /** 대상(탭/pane/규칙)이 아직 존재하는지. false면 재연결을 취소. */
  isStillPresent?(key: string, meta: ReconnectMeta): boolean;
}

interface AutoReconnectConfig {
  autoReconnectEnabled: boolean;
  autoReconnectMaxAttempts: number;
  autoReconnectBaseDelayMs: number;
  autoReconnectMaxDelayMs: number;
}

interface ReconnectState {
  kind: ReconnectKind;
  key: string;
  /** 지금까지 실행한 시도 횟수. */
  attempt: number;
  timerId: ReturnType<typeof setTimeout> | null;
  watchdogId: ReturnType<typeof setTimeout> | null;
  nextAttemptAt: number;
  meta: ReconnectMeta;
  inFlight: boolean;
}

const MAX_CONCURRENT_RECONNECTS = 3;
const WATCHDOG_MS = 30_000;
const CONCURRENCY_REQUEUE_MS = 400;

const reconnectStates = new Map<string, ReconnectState>();
const handlers = new Map<ReconnectKind, ReconnectHandler>();

let configProvider: (() => AutoReconnectConfig) | null = null;
let isOffline = false;
let inFlightCount = 0;

const DEFAULT_CONFIG: AutoReconnectConfig = {
  autoReconnectEnabled: true,
  autoReconnectMaxAttempts: 10,
  autoReconnectBaseDelayMs: 1000,
  // 상한 8초(@shared DEFAULT_AUTO_RECONNECT_SETTINGS 와 동일). configProvider 미초기화 시 fallback.
  autoReconnectMaxDelayMs: 8000,
};

export function initReconnectOrchestrator(
  provider: () => AutoReconnectConfig,
): void {
  configProvider = provider;
}

export function registerReconnectHandler(
  kind: ReconnectKind,
  handler: ReconnectHandler,
): void {
  handlers.set(kind, handler);
}

function getConfig(): AutoReconnectConfig {
  return configProvider?.() ?? DEFAULT_CONFIG;
}

export function isAutoReconnectEnabled(): boolean {
  return getConfig().autoReconnectEnabled;
}

export function computeBackoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  const exponential = baseMs * 2 ** Math.max(0, attempt);
  const capped = Math.min(maxMs, exponential);
  // 동시 다발 재연결의 동기화를 깨기 위한 0.8~1.2 지터.
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(capped * jitter);
}

export function isReconnecting(key: string): boolean {
  return reconnectStates.has(key);
}

/**
 * 예기치 않은 끊김에 대해 재연결을 예약한다.
 * 같은 key로 반복 호출되면 attempt가 누적되어 백오프가 늘어난다.
 */
export function scheduleReconnect(input: {
  kind: ReconnectKind;
  key: string;
  meta?: ReconnectMeta;
}): boolean {
  const config = getConfig();
  if (!config.autoReconnectEnabled) {
    return false;
  }
  const handler = handlers.get(input.kind);
  if (!handler) {
    return false;
  }

  const existing = reconnectStates.get(input.key);
  const attempt = existing?.attempt ?? 0;
  const meta = input.meta ?? existing?.meta ?? {};

  if (existing) {
    clearTimers(existing);
  }

  if (attempt >= config.autoReconnectMaxAttempts) {
    reconnectStates.delete(input.key);
    handler.renderGaveUp(
      input.key,
      { attempts: attempt, reason: "max-attempts" },
      meta,
    );
    return false;
  }

  const delayMs = computeBackoffDelay(
    attempt,
    config.autoReconnectBaseDelayMs,
    config.autoReconnectMaxDelayMs,
  );
  const nextAttemptAt = isOffline ? 0 : Date.now() + delayMs;

  const state: ReconnectState = {
    kind: input.kind,
    key: input.key,
    attempt,
    timerId: null,
    watchdogId: null,
    nextAttemptAt,
    meta,
    inFlight: false,
  };
  reconnectStates.set(input.key, state);

  handler.renderScheduled(
    input.key,
    {
      attempt: attempt + 1,
      maxAttempts: config.autoReconnectMaxAttempts,
      nextAttemptAt,
      delayMs,
      waitingForNetwork: isOffline,
    },
    meta,
  );

  if (!isOffline) {
    state.timerId = setTimeout(() => {
      void runExecute(input.key);
    }, delayMs);
  }
  return true;
}

async function runExecute(key: string): Promise<void> {
  const state = reconnectStates.get(key);
  if (!state) {
    return;
  }
  state.timerId = null;

  // 오프라인이면 타이머를 잡지 않고 대기(online/resume에서 재발화).
  if (isOffline) {
    return;
  }

  const handler = handlers.get(state.kind);
  if (!handler) {
    reconnectStates.delete(key);
    return;
  }

  if (handler.isStillPresent && !handler.isStillPresent(key, state.meta)) {
    cancelReconnect(key, "target-gone");
    return;
  }

  // 동시 재연결 상한 초과 시 잠시 후 재시도(시도 횟수 소비 안 함).
  if (inFlightCount >= MAX_CONCURRENT_RECONNECTS) {
    state.timerId = setTimeout(() => {
      void runExecute(key);
    }, CONCURRENCY_REQUEUE_MS);
    return;
  }

  state.attempt += 1;
  state.inFlight = true;
  inFlightCount += 1;

  // 워치독: perform 후에도 성공(cancel)/실패(reschedule) 어느 이벤트도
  // 오지 않으면 다음 백오프로 재시도.
  state.watchdogId = setTimeout(() => {
    const current = reconnectStates.get(key);
    if (!current || current.inFlight) {
      // 아직 in-flight면(perform 미완료) 다음 워치독은 reschedule이 잡는다.
      return;
    }
    scheduleReconnect({ kind: current.kind, key, meta: current.meta });
  }, WATCHDOG_MS);

  try {
    await handler.perform(key, state.meta);
  } catch {
    // perform 자체가 던지면 실패로 간주하고 다음 백오프 예약.
    if (reconnectStates.has(key)) {
      scheduleReconnect({ kind: state.kind, key, meta: state.meta });
    }
  } finally {
    inFlightCount = Math.max(0, inFlightCount - 1);
    const current = reconnectStates.get(key);
    if (current) {
      current.inFlight = false;
    }
  }
}

/** 재연결 예약을 취소하고 정리한다(성공/사용자 종료/대상 소멸 시). */
export function cancelReconnect(key: string, _reason: string): void {
  const state = reconnectStates.get(key);
  if (!state) {
    return;
  }
  clearTimers(state);
  reconnectStates.delete(key);
}

/** 모든 재연결 예약을 취소(앱 종료/전체 정리). */
export function cancelAllReconnects(reason: string): void {
  for (const key of Array.from(reconnectStates.keys())) {
    cancelReconnect(key, reason);
  }
}

function clearTimers(state: ReconnectState): void {
  if (state.timerId !== null) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }
  if (state.watchdogId !== null) {
    clearTimeout(state.watchdogId);
    state.watchdogId = null;
  }
}

/** 네트워크 연결 상태 변화. 오프라인이면 대기, 복귀하면 즉시 전부 재시도. */
export function onConnectivityChange(online: boolean): void {
  const wasOffline = isOffline;
  isOffline = !online;

  if (!online) {
    // 오프라인: 타이머만 중단(상태/시도횟수 유지), 대기 UI 갱신.
    for (const state of reconnectStates.values()) {
      if (state.timerId !== null) {
        clearTimeout(state.timerId);
        state.timerId = null;
      }
      const handler = handlers.get(state.kind);
      const config = getConfig();
      handler?.renderScheduled(
        state.key,
        {
          attempt: state.attempt + 1,
          maxAttempts: config.autoReconnectMaxAttempts,
          nextAttemptAt: 0,
          delayMs: 0,
          waitingForNetwork: true,
        },
        state.meta,
      );
    }
    return;
  }

  if (wasOffline) {
    fireAllImmediately();
  }
}

/** OS 절전 복귀. navigator.onLine이 true여도 소켓이 죽었을 수 있어 전부 재검증. */
export function onSystemResume(): void {
  if (isOffline) {
    return;
  }
  fireAllImmediately();
}

function fireAllImmediately(): void {
  let index = 0;
  for (const state of reconnectStates.values()) {
    if (state.inFlight) {
      continue;
    }
    if (state.timerId !== null) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
    // 약간의 스태거로 herd 완화.
    const key = state.key;
    const stagger = index * 150;
    index += 1;
    state.timerId = setTimeout(() => {
      void runExecute(key);
    }, stagger);
  }
}

// --- 테스트 전용 ---
export function __resetReconnectOrchestratorForTest(): void {
  for (const state of reconnectStates.values()) {
    clearTimers(state);
  }
  reconnectStates.clear();
  handlers.clear();
  configProvider = null;
  isOffline = false;
  inFlightCount = 0;
}

export function __getReconnectStateForTest(
  key: string,
): { attempt: number; nextAttemptAt: number; waitingForNetwork: boolean } | null {
  const state = reconnectStates.get(key);
  if (!state) {
    return null;
  }
  return {
    attempt: state.attempt,
    nextAttemptAt: state.nextAttemptAt,
    waitingForNetwork: isOffline,
  };
}
