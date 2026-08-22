/**
 * Remote Desktop (RDP/VNC) state slice for the mobile app store.
 *
 * This module defines the state shape and pure actions for managing remote desktop
 * sessions. It is designed to be composed into the main Zustand store via the
 * standard StateCreator pattern — the returned object is spread into the
 * store's initial state and actions.
 *
 * **Design constraints:**
 * - No native handles or framebuffer references in Zustand state (those live in a
 *   module-level Map outside the store, same pattern as `runtimeSessions` for SSH).
 * - Pure state transitions only — no async I/O or engine calls in this file.
 * - The slice does NOT define its own `create()` — it's merged into the single store.
 *
 * **Typing approach:**
 * Uses a generic-constrained factory that accepts the outer store's `set` and `get`
 * narrowed to the fields this slice reads/writes. No `as unknown as` casts needed.
 */

import type {
  MobileRemoteDesktopSessionRecord,
  RemoteDesktopProtocol,
} from '@dolssh/shared-core';

// ---------------------------------------------------------------------------
// Slice State
// ---------------------------------------------------------------------------

export interface RemoteDesktopSliceState {
  remoteDesktopSessions: MobileRemoteDesktopSessionRecord[];
  /**
   * 전체화면(몰입) 보기. 세션 탭 줄과 하단 탭 바를 숨겨 원격 화면이 창을 꽉 채운다.
   *
   * **세션별이 아니라 화면 단위 상태다.** 한 번에 한 RD 세션만 보이고, 탭을 옮기거나 세션이
   * 끊기면 빠져나와야 하므로 세션 레코드에 얹지 않는다. persist 대상도 아니다 — 앱을 다시 열면
   * 탭이 보이는 평소 화면에서 시작하는 편이 안전하다(나가는 버튼을 못 찾는 상태로 부팅되지 않게).
   */
  remoteDesktopImmersive: boolean;
}

export interface RemoteDesktopSliceActions {
  createRemoteDesktopSession: (params: {
    id: string;
    hostId: string;
    protocol: RemoteDesktopProtocol;
    title: string;
  }) => void;
  updateRemoteDesktopSession: (
    id: string,
    patch: Partial<
      Pick<
        MobileRemoteDesktopSessionRecord,
        | 'status'
        | 'inputMode'
        | 'scaleMode'
        | 'connectionStatusMessage'
        | 'errorMessage'
        | 'lastConnectedAt'
        | 'lastDisconnectedAt'
        | 'desktopWidth'
        | 'desktopHeight'
        | 'desktopName'
      >
    >,
  ) => void;
  removeRemoteDesktopSession: (id: string) => void;
  activateRemoteDesktopSession: (id: string) => void;
  setRemoteDesktopImmersive: (immersive: boolean) => void;
}

export type RemoteDesktopSlice = RemoteDesktopSliceState &
  RemoteDesktopSliceActions;

// ---------------------------------------------------------------------------
// Error type for engine-not-ready guard
// ---------------------------------------------------------------------------

/**
 * Structured error returned when a remote desktop connection is attempted but the
 * native engine is not available. Callers should display this without falling
 * through to SSH/terminal paths.
 */
export class RemoteDesktopEngineNotReadyError extends Error {
  public readonly protocol: RemoteDesktopProtocol;

  constructor(protocol: RemoteDesktopProtocol) {
    super(
      `Native ${protocol.toUpperCase()} engine is not available on this build.`,
    );
    this.name = 'RemoteDesktopEngineNotReadyError';
    this.protocol = protocol;
  }
}

// ---------------------------------------------------------------------------
// Native runtime handle map (outside Zustand, module-level)
// ---------------------------------------------------------------------------

export interface RemoteDesktopSsmForwardHandle {
  stop(): Promise<void>;
}

export interface RemoteDesktopRuntimeHandle {
  sessionId: string;
  /** Set as soon as disconnect/logout wins ownership of this runtime. */
  cancelled?: boolean;
  /** Whether nativeConnect completed for this generation. */
  nativeStarted?: boolean;
  /** In-flight idempotent disposal shared by every terminal path. */
  disposePromise?: Promise<void> | null;
  /** Unified disposal entry point used by account-boundary cleanup. */
  dispose?: (() => Promise<void>) | null;
  /** Go loopback tunnel ID, when a Tailnet/SSH route was opened. */
  tunnelId?: string | null;
  /** In-flight SSH dial ID used while an SSH-backed tunnel is opening. */
  sshConnectId?: string | null;
  /** Direct AWS SSM forward owned by this remote desktop session. */
  ssmForward?: RemoteDesktopSsmForwardHandle | null;
  /** Unsubscribe function for native event listener. */
  eventUnsubscribe?: (() => void) | null;
}

/**
 * Module-level map of active native runtime handles.
 * Zustand state stores the UI-visible record; this map stores native subscriptions
 * and tunnel references that must not be serialized.
 */
const remoteDesktopHandles = new Map<string, RemoteDesktopRuntimeHandle>();

export function getRemoteDesktopHandle(
  sessionId: string,
): RemoteDesktopRuntimeHandle | undefined {
  return remoteDesktopHandles.get(sessionId);
}

export function setRemoteDesktopHandle(
  sessionId: string,
  handle: RemoteDesktopRuntimeHandle,
): void {
  remoteDesktopHandles.set(sessionId, handle);
}

export function removeRemoteDesktopHandle(sessionId: string): void {
  remoteDesktopHandles.delete(sessionId);
}

export function getAllRemoteDesktopHandles(): Map<
  string,
  RemoteDesktopRuntimeHandle
> {
  return remoteDesktopHandles;
}

/** Reset for tests only. */
export function _resetHandlesForTests(): void {
  remoteDesktopHandles.clear();
}

// ---------------------------------------------------------------------------
// Slice Set/Get type (generic-compatible with any store containing our state)
// ---------------------------------------------------------------------------

/**
 * The `set` function narrowed to what this slice writes.
 * Compatible with Zustand's `StoreApi<T>['setState']` when T includes
 * RemoteDesktopSliceState.
 */
type SliceSet = (
  updater:
    | Partial<RemoteDesktopSliceState>
    | ((state: RemoteDesktopSliceState) => Partial<RemoteDesktopSliceState>),
) => void;

/**
 * The `get` function narrowed to what this slice reads.
 */
type SliceGet = () => RemoteDesktopSliceState;

// ---------------------------------------------------------------------------
// Slice Factory
// ---------------------------------------------------------------------------

/**
 * Creates the remote desktop slice to be spread into the Zustand store.
 *
 * Both `set` and `get` are standard Zustand parameters narrowed through type
 * constraints — no `as unknown as` cast is needed at the call site because
 * Zustand's full-store set/get is structurally compatible with these narrower
 * types (contravariant parameter, covariant return).
 */
export function createRemoteDesktopSlice(
  set: SliceSet,
  _get: SliceGet,
): RemoteDesktopSlice {
  return {
    // --- Initial state ---
    remoteDesktopSessions: [],
    remoteDesktopImmersive: false,

    // --- Actions ---
    createRemoteDesktopSession: ({ id, hostId, protocol, title }) => {
      const now = new Date().toISOString();
      const record: MobileRemoteDesktopSessionRecord = {
        id,
        hostId,
        protocol,
        title,
        status: 'connecting',
        inputMode: 'trackpad',
        scaleMode: 'fit',
        connectionStatusMessage: null,
        errorMessage: null,
        openedAt: now,
        lastEventAt: now,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
      };
      set(state => ({
        // 같은 호스트·프로토콜의 **닫힌** 기록은 여기서 걷어낸다. 최근 목록에 남기려고
        // 기록을 지우지 않게 됐으니(끊을 때 closed 로 둔다), 붙었다 끊기를 반복하면 같은
        // 이름이 계속 쌓인다. 호스트마다 가장 최근 하나만 의미가 있다.
        remoteDesktopSessions: [
          ...state.remoteDesktopSessions.filter(
            session =>
              session.status !== 'closed' ||
              session.hostId !== hostId ||
              session.protocol !== protocol,
          ),
          record,
        ],
      }));
    },

    updateRemoteDesktopSession: (id, patch) => {
      set(state => {
        const next = state.remoteDesktopSessions.map(session =>
          session.id === id
            ? {
                ...session,
                ...patch,
                lastEventAt: new Date().toISOString(),
              }
            : session,
        );
        return {
          remoteDesktopSessions: next,
          // 살아 있는 세션이 하나도 남지 않으면 전체화면을 끝낸다 — 탭 바가 숨겨진 채로
          // 다른 화면으로 돌아가면 나갈 길이 없어진다.
          //
          // **개수로 세지 않는다.** 닫힌 기록은 최근 목록용으로 남으므로 목록은 비지 않는다.
          ...(getLiveRemoteDesktopSessions(next).length === 0
            ? { remoteDesktopImmersive: false }
            : {}),
        };
      });
    },

    removeRemoteDesktopSession: (id: string) => {
      set(state => {
        const remaining = state.remoteDesktopSessions.filter(
          session => session.id !== id,
        );
        return {
          remoteDesktopSessions: remaining,
          // 마지막 RD 세션이 사라지면 전체화면도 함께 끝낸다. 그러지 않으면 탭 바가 숨겨진
          // 채로 터미널·설정 화면으로 돌아가 나갈 길이 없어진다.
          ...(getLiveRemoteDesktopSessions(remaining).length === 0
            ? { remoteDesktopImmersive: false }
            : {}),
        };
      });
    },

    activateRemoteDesktopSession: (_id: string) => {
      // Tab activation is handled by the main store's setActiveConnectionTab.
      // This is a placeholder for any session-specific activation logic (e.g.
      // resuming a paused framebuffer) that native layers will hook into.
    },

    setRemoteDesktopImmersive: (immersive: boolean) => {
      set({ remoteDesktopImmersive: immersive });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns live (non-closed) remote desktop sessions. */
export function getLiveRemoteDesktopSessions(
  sessions: MobileRemoteDesktopSessionRecord[],
): MobileRemoteDesktopSessionRecord[] {
  return sessions.filter(session => session.status !== 'closed');
}

/** 최근 목록에 남길 닫힌 RD 세션의 최대 개수. 목록은 5개만 보여주므로 그 이상은 무게만 된다. */
const MAX_PERSISTED_REMOTE_DESKTOP_SESSIONS = 10;

/**
 * 다시 켰을 때 "최근 세션" 에 RDP/VNC 가 남도록 저장할 목록을 고른다.
 *
 * **살아 있는 세션은 저장하지 않는다.** 앱이 죽으면 네이티브 세션도 같이 죽으므로, 켤 때
 * 되살릴 수 있는 것이 없다. 닫힌 기록만 남겨 재연결 버튼의 근거로 쓴다.
 */
export function compactPersistedRemoteDesktopSessions(
  sessions: MobileRemoteDesktopSessionRecord[],
): MobileRemoteDesktopSessionRecord[] {
  return [...sessions]
    .map(session =>
      session.status === 'closed'
        ? session
        : {
            ...session,
            status: 'closed' as const,
            connectionStatusMessage: null,
            lastDisconnectedAt: session.lastDisconnectedAt ?? session.lastEventAt,
          },
    )
    .sort((left, right) => right.lastEventAt.localeCompare(left.lastEventAt))
    .slice(0, MAX_PERSISTED_REMOTE_DESKTOP_SESSIONS);
}

/**
 * Guard: checks whether connecting to a host of the given protocol is supported.
 * Returns the structured error if the engine is not ready, or null if safe to proceed.
 *
 * This prevents RDP/VNC hosts from accidentally falling into the SSH connection path.
 */
export function guardRemoteDesktopEngine(
  _protocol: RemoteDesktopProtocol,
): RemoteDesktopEngineNotReadyError | null {
  // Both protocols are wired natively. Availability is still checked
  // asynchronously immediately before each connection attempt.
  return null;
}
