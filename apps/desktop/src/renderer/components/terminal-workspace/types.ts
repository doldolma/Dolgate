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
  title: string;
  visible: boolean;
  active: boolean;
  viewActivationKey: string | null;
  layoutKey: string;
  appearance: TerminalSessionAppearance;
  terminalWebglEnabled: boolean;
  style?: CSSProperties;
  showHeader?: boolean;
  draggingDisabled?: boolean;
  interactiveAuth: PendingSessionInteractiveAuth | null;
  onFocus?: () => void;
  onClose?: () => Promise<void>;
  onRetry?: () => Promise<void>;
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
  sessionShareChatNotifications: SessionShareChatMessage[];
  onDismissSessionShareChatNotification: (
    sessionId: string,
    notificationId: string,
  ) => void;
  onRespondInteractiveAuth: (
    challengeId: string,
    responses: string[],
  ) => Promise<void>;
  onReopenInteractiveAuthUrl: () => Promise<void> | void;
  onClearPendingInteractiveAuth: () => Promise<void> | void;
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
