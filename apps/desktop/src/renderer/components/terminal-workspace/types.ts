import type { CSSProperties, DragEventHandler, ReactNode } from 'react';
import type {
  AppSettings,
  HostRecord,
  SessionShareChatMessage,
  SessionShareSnapshotInput,
  SessionShareStartInput,
  TerminalTab,
} from '@shared';
import type {
  PendingSessionInteractiveAuth,
  WorkspaceDropDirection,
  WorkspaceLayoutNode,
} from '../../store/createAppStore';
import type { TerminalThemeDefinition } from '../../lib/terminal-presets';

export interface DraggedSessionPayload {
  sessionId: string;
  source: 'standalone-tab' | 'workspace-pane';
  workspaceId?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SessionPlacement {
  sessionId: string;
  rect: Rect;
}

export interface SplitHandlePlacement {
  splitId: string;
  axis: 'horizontal' | 'vertical';
  rect: Rect;
  ratio: number;
}

export interface DropPreview {
  direction: WorkspaceDropDirection;
  targetSessionId?: string;
  rect: Rect;
}

export interface TerminalSessionAppearance {
  theme: TerminalThemeDefinition['theme'];
  fontFamily: string;
  fontSize: number;
  scrollbackLines: number;
  lineHeight: number;
  letterSpacing: number;
  minimumContrastRatio: number;
  macOptionIsMeta?: boolean;
}

export interface TerminalSessionPaneProps {
  sessionId: string;
  /**
   * 이 pane 이 화면을 혼자 쓰는가(스탠드얼론 · pane 하나짜리 워크스페이스).
   *
   * 하단 상태바를 여기서만 그린다 — 분할하면 pane 마다 바가 하나씩 붙어 화면 아래가 줄로
   * 가득 찬다. 분할에서는 종류·대상·지연을 pane 헤더가 이미 들고 있다.
   */
  soloView?: boolean;
  title: string;
  visible: boolean;
  active: boolean;
  viewActivationKey: string | null;
  layoutKey: string;
  appearance: TerminalSessionAppearance;
  terminalWebglEnabled: boolean;
  terminalAutocompleteEnabled: boolean;
  /** prefix 키 토큰("C-b"/"C-a"/"C-Space" …). control mode pane 에서만 의미가 있다. */
  tmuxPrefixKey: string;
  /**
   * control mode tmux pane이면 tmux 레이아웃이 지정한 정확한 칸 수. 이 값이 있으면
   * pane의 xterm을 컨테이너에 fit하지 않고 이 크기로 고정한다(tmux와 1:1 → 셰이크 제거).
   */
  tmuxCell?: { cols: number; rows: number };
  style?: CSSProperties;
  showHeader?: boolean;
  draggingDisabled?: boolean;
  interactiveAuth: PendingSessionInteractiveAuth | null;
  onFocus?: () => void;
  onClose?: () => Promise<void>;
  onRetry?: () => Promise<void>;
  /** 자동 재연결 중 사용자가 취소할 때 호출. */
  onCancelReconnect?: () => Promise<void> | void;
  /**
   * tmux 그룹 재연결 시 그룹 내 모든 pane 이 reconnecting 이 되는데, 재연결/에러
   * 오버레이는 그룹당 하나만 보이도록 "대표 pane" 에서만 렌더한다. tmux 가 아닌
   * 일반 세션은 항상 true(기본값).
   */
  isPrimaryTmuxOverlayPane?: boolean;
  onStartSessionShare?: (input: SessionShareStartInput) => Promise<void>;
  onUpdateSessionShareSnapshot?: (input: SessionShareSnapshotInput) => Promise<void>;
  onSetSessionShareInputEnabled?: (
    sessionId: string,
    inputEnabled: boolean,
  ) => Promise<void>;
  onStopSessionShare?: (sessionId: string) => Promise<void>;
  onOpenSessionShareChatWindow?: (sessionId: string) => Promise<void>;
  onSendInput?: (sessionId: string, data: string) => void;
  onSendBinaryInput?: (sessionId: string, data: Uint8Array) => void;
  onStartDrag?: () => void;
  onEndDrag?: () => void;
  tab?: TerminalTab;
  host?: HostRecord;
  /** 이 pane 이 워크스페이스 전체로 확대돼 있는가. */
  zoomed?: boolean;
  /** 확대 토글. 없으면 아이콘이 뜨지 않는다. */
  onToggleZoom?: () => void;
  /** 분할에서 빼내 독립 탭으로. 없으면 아이콘이 뜨지 않는다. */
  onDetachToTab?: () => void;
  /** 이 pane 이 브로드캐스트에 참여 중인가. */
  broadcastActive?: boolean;
  /** 연결된 pane 이 부족해 지금은 켤 수 없음. */
  broadcastDisabled?: boolean;
  /** 브로드캐스트 토글. 없으면 헤더에 아이콘이 뜨지 않는다. */
  onToggleBroadcast?: () => void;
  sessionShareChatNotifications: SessionShareChatMessage[];
  onDismissSessionShareChatNotification: (
    sessionId: string,
    notificationId: string,
  ) => void;
  onRespondInteractiveAuth: (
    challengeId: string,
    responses: string[],
    /** 저장된 비밀번호로 채울 칸(프롬프트 인덱스). 값은 코어에만 있으므로 지목만 넘긴다. */
    storedPasswordIndexes?: number[],
  ) => Promise<void>;
  onReopenInteractiveAuthUrl: () => Promise<void> | void;
  /** 카드를 내린다. 어느 것인지 반드시 지목한다 — 인자가 없으면 스토어가 전부 비운다. */
  onClearPendingInteractiveAuth: (
    challengeId?: string,
  ) => Promise<void> | void;
  onSessionData: (
    sessionId: string,
    listener: (chunk: Uint8Array) => void,
  ) => () => void;
  onResizeSession: (
    sessionId: string,
    cols: number,
    rows: number,
  ) => Promise<void>;
}

export interface TerminalWorkspacePaneSlot {
  key: string;
  className?: string;
  style?: CSSProperties;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  content: ReactNode;
}

export interface ResolveTerminalAppearanceInput {
  settings: AppSettings;
  hosts: HostRecord[];
  tab: TerminalTab;
  prefersDark: boolean;
  isMacPlatform: boolean;
}

export type WorkspaceLayoutInput = WorkspaceLayoutNode;
