import type { TerminalConnectionProgress, TerminalTab } from "@shared";
import type {
  AppState,
  DynamicTabStripItem,
  PendingConnectionAttempt,
  SessionReturnTarget,
  SessionWorkspaceTabId,
  SplitWorkspaceTabId,
  WorkspaceDropDirection,
  WorkspaceLayoutNode,
  WorkspaceLeafNode,
  WorkspaceSplitNode,
  WorkspaceTab,
  WorkspaceTabId,
} from "../types";
import { isPendingSessionInteractiveAuth } from "./interactive-auth";
import {
  clearSessionShareChatNotifications,
  createInactiveSessionShareState,
} from "./session-share";

export function asSessionTabId(sessionId: string): SessionWorkspaceTabId {
  return `session:${sessionId}`;
}

export function asWorkspaceTabId(workspaceId: string): SplitWorkspaceTabId {
  return `workspace:${workspaceId}`;
}

export function captureSessionReturnTarget(
  state: Pick<
    AppState,
    | "activeWorkspaceTab"
    | "homeSection"
    | "settingsSection"
    | "activeContainerHostId"
  >,
): SessionReturnTarget {
  if (state.activeWorkspaceTab === "home") {
    return {
      activeWorkspaceTab: "home",
      homeSection: state.homeSection,
      settingsSection:
        state.homeSection === "settings" ? state.settingsSection : undefined,
    };
  }

  if (state.activeWorkspaceTab === "containers") {
    return {
      activeWorkspaceTab: "containers",
      activeContainerHostId: state.activeContainerHostId,
    };
  }

  return { activeWorkspaceTab: state.activeWorkspaceTab };
}

export function resolveSessionReturnTarget(
  state: Pick<
    AppState,
    | "activeContainerHostId"
    | "containerTabs"
    | "homeSection"
    | "settingsSection"
    | "tabStrip"
    | "workspaces"
  >,
  target: SessionReturnTarget,
): SessionReturnTarget | null {
  if (target.activeWorkspaceTab === "home") {
    const homeSection = target.homeSection ?? "hosts";
    return {
      activeWorkspaceTab: "home",
      homeSection,
      settingsSection:
        homeSection === "settings"
          ? (target.settingsSection ?? state.settingsSection)
          : undefined,
    };
  }

  if (target.activeWorkspaceTab === "sftp") {
    return { activeWorkspaceTab: "sftp" };
  }

  if (target.activeWorkspaceTab === "containers") {
    if (state.containerTabs.length === 0) {
      return null;
    }

    const availableHostIds = new Set(state.containerTabs.map((tab) => tab.hostId));
    const activeContainerHostId = availableHostIds.has(
      target.activeContainerHostId ?? "",
    )
      ? (target.activeContainerHostId ?? null)
      : availableHostIds.has(state.activeContainerHostId ?? "")
        ? (state.activeContainerHostId ?? null)
        : (state.containerTabs[0]?.hostId ?? null);

    if (!activeContainerHostId) {
      return null;
    }

    return {
      activeWorkspaceTab: "containers",
      activeContainerHostId,
    };
  }

  if (target.activeWorkspaceTab.startsWith("session:")) {
    const sessionId = target.activeWorkspaceTab.slice("session:".length);
    return state.tabStrip.some(
      (item) => item.kind === "session" && item.sessionId === sessionId,
    )
      ? { activeWorkspaceTab: asSessionTabId(sessionId) }
      : null;
  }

  if (target.activeWorkspaceTab.startsWith("workspace:")) {
    const workspaceId = target.activeWorkspaceTab.slice("workspace:".length);
    return state.workspaces.some((workspace) => workspace.id === workspaceId)
      ? { activeWorkspaceTab: asWorkspaceTabId(workspaceId) }
      : null;
  }

  return null;
}

export function createWorkspaceLeaf(sessionId: string): WorkspaceLeafNode {
  return {
    id: globalThis.crypto.randomUUID(),
    kind: "leaf",
    sessionId,
  };
}

export function directionAxis(
  direction: WorkspaceDropDirection,
): WorkspaceSplitNode["axis"] {
  return direction === "left" || direction === "right"
    ? "horizontal"
    : "vertical";
}

export function createWorkspaceSplit(
  existingSessionId: string,
  incomingSessionId: string,
  direction: WorkspaceDropDirection,
): WorkspaceLayoutNode {
  const existingLeaf = createWorkspaceLeaf(existingSessionId);
  const incomingLeaf = createWorkspaceLeaf(incomingSessionId);
  const prependIncoming = direction === "left" || direction === "top";
  return {
    id: globalThis.crypto.randomUUID(),
    kind: "split",
    axis: directionAxis(direction),
    ratio: 0.5,
    first: prependIncoming ? incomingLeaf : existingLeaf,
    second: prependIncoming ? existingLeaf : incomingLeaf,
  };
}

export function listWorkspaceSessionIds(node: WorkspaceLayoutNode): string[] {
  if (node.kind === "leaf") {
    return [node.sessionId];
  }
  return [
    ...listWorkspaceSessionIds(node.first),
    ...listWorkspaceSessionIds(node.second),
  ];
}

export function countWorkspaceSessions(node: WorkspaceLayoutNode): number {
  return listWorkspaceSessionIds(node).length;
}

export function findFirstWorkspaceSessionId(node: WorkspaceLayoutNode): string {
  return node.kind === "leaf"
    ? node.sessionId
    : findFirstWorkspaceSessionId(node.first);
}

export function insertSessionIntoWorkspaceLayout(
  node: WorkspaceLayoutNode,
  targetSessionId: string,
  incomingSessionId: string,
  direction: WorkspaceDropDirection,
): { layout: WorkspaceLayoutNode; inserted: boolean } {
  if (node.kind === "leaf") {
    if (node.sessionId !== targetSessionId) {
      return { layout: node, inserted: false };
    }
    return {
      layout: createWorkspaceSplit(
        targetSessionId,
        incomingSessionId,
        direction,
      ),
      inserted: true,
    };
  }

  const nextFirst = insertSessionIntoWorkspaceLayout(
    node.first,
    targetSessionId,
    incomingSessionId,
    direction,
  );
  if (nextFirst.inserted) {
    return {
      layout: {
        ...node,
        first: nextFirst.layout,
      },
      inserted: true,
    };
  }

  const nextSecond = insertSessionIntoWorkspaceLayout(
    node.second,
    targetSessionId,
    incomingSessionId,
    direction,
  );
  if (nextSecond.inserted) {
    return {
      layout: {
        ...node,
        second: nextSecond.layout,
      },
      inserted: true,
    };
  }

  return { layout: node, inserted: false };
}

export function removeSessionFromWorkspaceLayout(
  node: WorkspaceLayoutNode,
  sessionId: string,
): WorkspaceLayoutNode | null {
  if (node.kind === "leaf") {
    return node.sessionId === sessionId ? null : node;
  }

  const nextFirst = removeSessionFromWorkspaceLayout(node.first, sessionId);
  const nextSecond = removeSessionFromWorkspaceLayout(node.second, sessionId);

  if (!nextFirst && !nextSecond) {
    return null;
  }
  if (!nextFirst) {
    return nextSecond;
  }
  if (!nextSecond) {
    return nextFirst;
  }

  return {
    ...node,
    first: nextFirst,
    second: nextSecond,
  };
}

export function moveSessionWithinWorkspaceLayout(
  node: WorkspaceLayoutNode,
  sessionId: string,
  targetSessionId: string,
  direction: WorkspaceDropDirection,
): { layout: WorkspaceLayoutNode; moved: boolean } {
  if (sessionId === targetSessionId) {
    return { layout: node, moved: false };
  }

  const sessionIds = listWorkspaceSessionIds(node);
  if (
    !sessionIds.includes(sessionId) ||
    !sessionIds.includes(targetSessionId)
  ) {
    return { layout: node, moved: false };
  }

  const reducedLayout = removeSessionFromWorkspaceLayout(node, sessionId);
  if (!reducedLayout) {
    return { layout: node, moved: false };
  }

  const nextLayout = insertSessionIntoWorkspaceLayout(
    reducedLayout,
    targetSessionId,
    sessionId,
    direction,
  );
  if (!nextLayout.inserted) {
    return { layout: node, moved: false };
  }

  return {
    layout: nextLayout.layout,
    moved: true,
  };
}

export function updateWorkspaceSplitRatio(
  node: WorkspaceLayoutNode,
  splitId: string,
  ratio: number,
): WorkspaceLayoutNode {
  if (node.kind === "leaf") {
    return node;
  }

  const clampedRatio = Math.min(0.8, Math.max(0.2, ratio));
  if (node.id === splitId) {
    return {
      ...node,
      ratio: clampedRatio,
    };
  }

  return {
    ...node,
    first: updateWorkspaceSplitRatio(node.first, splitId, clampedRatio),
    second: updateWorkspaceSplitRatio(node.second, splitId, clampedRatio),
  };
}

export function buildSessionTitle(
  label: string,
  scope: { source: "host"; hostId: string } | { source: "local" },
  tabs: TerminalTab[],
): string {
  const existingTitles = new Set(
    tabs
      .filter((tab) =>
        scope.source === "local"
          ? tab.source === "local"
          : tab.source === "host" && tab.hostId === scope.hostId,
      )
      .map((tab) => tab.title),
  );
  if (!existingTitles.has(label)) {
    return label;
  }

  let suffix = 1;
  while (existingTitles.has(`${label} (${suffix})`)) {
    suffix += 1;
  }
  return `${label} (${suffix})`;
}

export const PENDING_SESSION_PREFIX = "pending:";

export function createPendingSessionId(): string {
  return `${PENDING_SESSION_PREFIX}${globalThis.crypto.randomUUID()}`;
}

export function isPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith(PENDING_SESSION_PREFIX);
}

export function createPendingSessionTab(input: {
  sessionId: string;
  source: "host" | "local";
  hostId: string | null;
  title: string;
  shellKind?: string;
  progress: TerminalConnectionProgress;
}): TerminalTab {
  return {
    id: input.sessionId,
    sessionId: input.sessionId,
    source: input.source,
    hostId: input.hostId,
    title: input.title,
    shellKind: input.shellKind,
    status: "pending",
    connectionProgress: input.progress,
    sessionShare: createInactiveSessionShareState(),
    hasReceivedOutput: false,
    lastEventAt: new Date().toISOString(),
  };
}

export function findPendingConnectionAttempt(
  state: AppState,
  sessionId: string,
): PendingConnectionAttempt | null {
  return (
    state.pendingConnectionAttempts.find(
      (attempt) => attempt.sessionId === sessionId,
    ) ?? null
  );
}

export function findPendingConnectionAttemptByHost(
  state: AppState,
  hostId: string,
): PendingConnectionAttempt | null {
  return (
    state.pendingConnectionAttempts.find(
      (attempt) => attempt.source === "host" && attempt.hostId === hostId,
    ) ?? null
  );
}

export function isPendingEcsShellAttempt(
  attempt: PendingConnectionAttempt | null,
): attempt is PendingConnectionAttempt & {
  source: "ecs-shell";
  hostId: string;
  serviceName: string;
  taskArn: string;
  containerName: string;
} {
  return Boolean(
    attempt &&
      attempt.source === "ecs-shell" &&
      typeof attempt.hostId === "string" &&
      typeof attempt.serviceName === "string" &&
      typeof attempt.taskArn === "string" &&
      typeof attempt.containerName === "string",
  );
}

export function normalizeEcsExecShellPermissionMessage(
  message?: string | null,
): string | null {
  const normalized = message?.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("cloudshell:ApproveCommand")) {
    return "AWS Console에서 CloudShell로 ECS Exec를 테스트하려면 `cloudshell:ApproveCommand` 권한이 필요합니다. Dolgate 앱 자체에는 필수 권한이 아닙니다.";
  }
  if (normalized.includes("ecs:ExecuteCommand")) {
    return `ECS Exec 권한이 없습니다. 사용자/역할에 \`ecs:ExecuteCommand\`와 보통 \`ecs:DescribeTasks\` 권한이 필요합니다. 원본 오류: ${normalized}`;
  }
  if (normalized.includes("ecs:DescribeTasks")) {
    return `ECS task 조회 권한이 없습니다. 사용자/역할에 \`ecs:DescribeTasks\` 권한이 필요합니다. 원본 오류: ${normalized}`;
  }
  if (normalized.includes("ssm:StartSession")) {
    return `Session Manager 권한이 없습니다. 사용자/역할에 \`ssm:StartSession\` 권한이 필요한지 확인해 주세요. 원본 오류: ${normalized}`;
  }
  return normalized;
}


export function replaceSessionIdInLayout(
  node: WorkspaceLayoutNode,
  previousSessionId: string,
  nextSessionId: string,
): WorkspaceLayoutNode {
  if (node.kind === "leaf") {
    return node.sessionId === previousSessionId
      ? {
          ...node,
          sessionId: nextSessionId,
        }
      : node;
  }

  return {
    ...node,
    first: replaceSessionIdInLayout(
      node.first,
      previousSessionId,
      nextSessionId,
    ),
    second: replaceSessionIdInLayout(
      node.second,
      previousSessionId,
      nextSessionId,
    ),
  };
}

export function replaceSessionReferencesInState(
  state: AppState,
  previousSessionId: string,
  nextSessionId: string,
  transformTab?: (tab: TerminalTab) => TerminalTab,
): Partial<AppState> {
  const nextSessionReturnTargets = { ...state.sessionReturnTargets };
  const existingSessionReturnTarget = nextSessionReturnTargets[previousSessionId];
  if (existingSessionReturnTarget) {
    delete nextSessionReturnTargets[previousSessionId];
    nextSessionReturnTargets[nextSessionId] = existingSessionReturnTarget;
  }
  const nextResolvedStartupCommands = {
    ...state.resolvedStartupCommandsBySessionId,
  };
  const resolvedStartupCommand = nextResolvedStartupCommands[previousSessionId];
  delete nextResolvedStartupCommands[previousSessionId];
  if (resolvedStartupCommand !== undefined) {
    nextResolvedStartupCommands[nextSessionId] = resolvedStartupCommand;
  }

  return {
    tabs: state.tabs.map((tab) => {
      if (tab.sessionId !== previousSessionId) {
        return tab;
      }
      const nextTab: TerminalTab = {
        ...tab,
        id: nextSessionId,
        sessionId: nextSessionId,
      };
      return transformTab ? transformTab(nextTab) : nextTab;
    }),
    tabStrip: state.tabStrip.map((item) =>
      item.kind === "session" && item.sessionId === previousSessionId
        ? { kind: "session", sessionId: nextSessionId }
        : item,
    ),
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      layout: replaceSessionIdInLayout(
        workspace.layout,
        previousSessionId,
        nextSessionId,
      ),
      activeSessionId:
        workspace.activeSessionId === previousSessionId
          ? nextSessionId
          : workspace.activeSessionId,
    })),
    activeWorkspaceTab:
      state.activeWorkspaceTab === asSessionTabId(previousSessionId)
        ? asSessionTabId(nextSessionId)
        : state.activeWorkspaceTab,
    pendingHostKeyPrompt:
      state.pendingHostKeyPrompt?.sessionId === previousSessionId
        ? {
            ...state.pendingHostKeyPrompt,
            sessionId: nextSessionId,
          }
        : state.pendingHostKeyPrompt,
    pendingCredentialRetry:
      state.pendingCredentialRetry?.sessionId === previousSessionId
        ? {
            ...state.pendingCredentialRetry,
            sessionId: nextSessionId,
          }
        : state.pendingCredentialRetry,
    activeCredentialRetryAttempt:
      state.activeCredentialRetryAttempt?.sessionId === previousSessionId
        ? {
            ...state.activeCredentialRetryAttempt,
            sessionId: nextSessionId,
          }
        : state.activeCredentialRetryAttempt,
    pendingInteractiveAuth:
      isPendingSessionInteractiveAuth(state.pendingInteractiveAuth) &&
      state.pendingInteractiveAuth.sessionId === previousSessionId
        ? {
            ...state.pendingInteractiveAuth,
            sessionId: nextSessionId,
          }
        : state.pendingInteractiveAuth,
    sessionReturnTargets: nextSessionReturnTargets,
    resolvedStartupCommandsBySessionId: nextResolvedStartupCommands,
  };
}

export function removeSessionFromState(
  state: AppState,
  sessionId: string,
): Partial<AppState> {
  const tabs = state.tabs.filter((tab) => tab.sessionId !== sessionId);
  const standaloneIndex = state.tabStrip.findIndex(
    (item) => item.kind === "session" && item.sessionId === sessionId,
  );
  let nextTabStrip = state.tabStrip.filter(
    (item) => !(item.kind === "session" && item.sessionId === sessionId),
  );
  let nextWorkspaces = state.workspaces;
  let nextActive = state.activeWorkspaceTab;
  let nextHomeSection = state.homeSection;
  let nextSettingsSection = state.settingsSection;
  let nextActiveContainerHostId = state.activeContainerHostId;
  const nextSessionReturnTargets = { ...state.sessionReturnTargets };
  const nextResolvedStartupCommands = {
    ...state.resolvedStartupCommandsBySessionId,
  };
  const shouldRestoreReturnTarget =
    state.activeWorkspaceTab === asSessionTabId(sessionId);
  const storedReturnTarget = shouldRestoreReturnTarget
    ? nextSessionReturnTargets[sessionId] ?? null
    : null;
  delete nextSessionReturnTargets[sessionId];
  delete nextResolvedStartupCommands[sessionId];

  const owningWorkspace = state.workspaces.find((workspace) =>
    listWorkspaceSessionIds(workspace.layout).includes(sessionId),
  );
  if (owningWorkspace) {
    const reducedLayout = removeSessionFromWorkspaceLayout(
      owningWorkspace.layout,
      sessionId,
    );
    if (!reducedLayout) {
      nextWorkspaces = state.workspaces.filter(
        (workspace) => workspace.id !== owningWorkspace.id,
      );
      const workspaceIndex = state.tabStrip.findIndex(
        (item) =>
          item.kind === "workspace" && item.workspaceId === owningWorkspace.id,
      );
      nextTabStrip = state.tabStrip.filter(
        (item) =>
          !(
            item.kind === "workspace" && item.workspaceId === owningWorkspace.id
          ),
      );
      if (nextActive === asWorkspaceTabId(owningWorkspace.id)) {
        nextActive = resolveNextVisibleTab(
          nextTabStrip,
          workspaceIndex >= 0 ? workspaceIndex : nextTabStrip.length,
        );
      }
    } else if (reducedLayout.kind === "leaf") {
      const workspaceIndex = state.tabStrip.findIndex(
        (item) =>
          item.kind === "workspace" && item.workspaceId === owningWorkspace.id,
      );
      nextWorkspaces = state.workspaces.filter(
        (workspace) => workspace.id !== owningWorkspace.id,
      );
      nextTabStrip = state.tabStrip.filter(
        (item) =>
          !(
            item.kind === "workspace" && item.workspaceId === owningWorkspace.id
          ),
      );
      nextTabStrip.splice(
        workspaceIndex >= 0 ? workspaceIndex : nextTabStrip.length,
        0,
        {
          kind: "session",
          sessionId: reducedLayout.sessionId,
        },
      );
      if (nextActive === asWorkspaceTabId(owningWorkspace.id)) {
        nextActive = asSessionTabId(reducedLayout.sessionId);
      }
    } else {
      nextWorkspaces = state.workspaces.map((workspace) =>
        workspace.id === owningWorkspace.id
          ? {
              ...workspace,
              layout: reducedLayout,
              activeSessionId:
                workspace.activeSessionId === sessionId
                  ? findFirstWorkspaceSessionId(reducedLayout)
                  : workspace.activeSessionId,
            }
          : workspace,
      );
    }
  } else if (nextActive === asSessionTabId(sessionId)) {
    nextActive = resolveNextVisibleTab(
      nextTabStrip,
      standaloneIndex >= 0 ? standaloneIndex : nextTabStrip.length,
    );
  }

  if (storedReturnTarget) {
    const resolvedReturnTarget = resolveSessionReturnTarget(
      {
        activeContainerHostId: nextActiveContainerHostId,
        containerTabs: state.containerTabs,
        homeSection: nextHomeSection,
        settingsSection: nextSettingsSection,
        tabStrip: nextTabStrip,
        workspaces: nextWorkspaces,
      },
      storedReturnTarget,
    );
    if (resolvedReturnTarget) {
      nextActive = resolvedReturnTarget.activeWorkspaceTab;
      if (resolvedReturnTarget.homeSection) {
        nextHomeSection = resolvedReturnTarget.homeSection;
      }
      if (resolvedReturnTarget.settingsSection) {
        nextSettingsSection = resolvedReturnTarget.settingsSection;
      }
      if ("activeContainerHostId" in resolvedReturnTarget) {
        nextActiveContainerHostId =
          resolvedReturnTarget.activeContainerHostId ?? null;
      }
    }
  }

  return {
    tabs,
    sessionShareChatNotifications: clearSessionShareChatNotifications(
      state.sessionShareChatNotifications,
      sessionId,
    ),
    workspaces: nextWorkspaces,
    tabStrip: nextTabStrip,
    activeWorkspaceTab: nextActive,
    homeSection: nextHomeSection,
    settingsSection: nextSettingsSection,
    activeContainerHostId: nextActiveContainerHostId,
    pendingHostKeyPrompt:
      state.pendingHostKeyPrompt?.sessionId === sessionId
        ? null
        : state.pendingHostKeyPrompt,
    pendingCredentialRetry:
      state.pendingCredentialRetry?.sessionId === sessionId
        ? null
        : state.pendingCredentialRetry,
    activeCredentialRetryAttempt:
      state.activeCredentialRetryAttempt?.sessionId === sessionId
        ? null
        : state.activeCredentialRetryAttempt,
    pendingInteractiveAuth:
      isPendingSessionInteractiveAuth(state.pendingInteractiveAuth) &&
      state.pendingInteractiveAuth.sessionId === sessionId
        ? null
        : state.pendingInteractiveAuth,
    pendingConnectionAttempts: state.pendingConnectionAttempts.filter(
      (attempt) => attempt.sessionId !== sessionId,
    ),
    sessionReturnTargets: nextSessionReturnTargets,
    resolvedStartupCommandsBySessionId: nextResolvedStartupCommands,
  };
}

export function activateSessionContextInState(
  state: AppState,
  sessionId: string,
): Partial<AppState> {
  const owningWorkspace = state.workspaces.find((workspace) =>
    listWorkspaceSessionIds(workspace.layout).includes(sessionId),
  );
  if (!owningWorkspace) {
    return {
      activeWorkspaceTab: asSessionTabId(sessionId),
    };
  }

  return {
    workspaces: state.workspaces.map((workspace) =>
      workspace.id === owningWorkspace.id
        ? {
            ...workspace,
            activeSessionId: sessionId,
          }
        : workspace,
    ),
    activeWorkspaceTab: asWorkspaceTabId(owningWorkspace.id),
  };
}

export function buildWorkspaceTitle(workspaces: WorkspaceTab[]): string {
  const existingTitles = new Set(
    workspaces.map((workspace) => workspace.title),
  );
  if (!existingTitles.has("Workspace")) {
    return "Workspace";
  }

  let suffix = 1;
  while (existingTitles.has(`Workspace (${suffix})`)) {
    suffix += 1;
  }
  return `Workspace (${suffix})`;
}

export function resolveNextVisibleTab(
  tabStrip: DynamicTabStripItem[],
  removedIndex: number,
): WorkspaceTabId {
  const nextItem = tabStrip[removedIndex] ?? tabStrip[removedIndex - 1];
  if (!nextItem) {
    return "home";
  }
  if (nextItem.kind === "session") {
    return asSessionTabId(nextItem.sessionId);
  }
  if (nextItem.kind === "workspace") {
    return asWorkspaceTabId(nextItem.workspaceId);
  }
  return "home";
}

export function resolveAdjacentTarget(
  tabStrip: DynamicTabStripItem[],
  workspaces: WorkspaceTab[],
  sessionId: string,
): DynamicTabStripItem | null {
  const currentIndex = tabStrip.findIndex(
    (item) => item.kind === "session" && item.sessionId === sessionId,
  );
  if (currentIndex < 0) {
    return null;
  }

  const candidateIndexes = [currentIndex + 1, currentIndex - 1];
  for (const index of candidateIndexes) {
    const candidate = tabStrip[index];
    if (!candidate) {
      continue;
    }
    if (candidate.kind === "workspace") {
      const workspace = workspaces.find(
        (item) => item.id === candidate.workspaceId,
      );
      if (!workspace) {
        continue;
      }
      if (countWorkspaceSessions(workspace.layout) >= 4) {
        continue;
      }
    }
    return candidate;
  }

  return null;
}

export function dynamicTabMatches(
  left: DynamicTabStripItem,
  right: DynamicTabStripItem,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "session" && right.kind === "session") {
    return left.sessionId === right.sessionId;
  }
  if (left.kind === "workspace" && right.kind === "workspace") {
    return left.workspaceId === right.workspaceId;
  }
  return false;
}
