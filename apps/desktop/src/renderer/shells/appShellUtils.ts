import type { HostRecord, LinkedHostSummary } from '@shared';
import type { DynamicTabStripItem, WorkspaceTab } from '../store/createAppStore';

export interface DraggedSessionPayload {
  sessionId: string;
  source: 'standalone-tab' | 'workspace-pane';
  workspaceId?: string;
}

export function findHost(hosts: HostRecord[], hostId: string | null): HostRecord | null {
  return hostId ? hosts.find((host) => host.id === hostId) ?? null : null;
}

export function toLinkedHostSummary(
  host: Extract<HostRecord, { kind: 'ssh' }>,
): LinkedHostSummary {
  return {
    id: host.id,
    label: host.label,
    hostname: host.hostname,
    username: host.username,
  };
}

export function buildXshellImportStatusMessage(result: {
  createdGroupCount: number;
  createdHostCount: number;
  createdSecretCount: number;
  skippedHostCount: number;
}): string {
  return `Xshell에서 호스트 ${result.createdHostCount}개와 그룹 ${result.createdGroupCount}개를 가져왔습니다.${
    result.createdSecretCount > 0 ? ` 저장된 비밀번호 ${result.createdSecretCount}개를 함께 가져왔습니다.` : ''
  }${
    result.skippedHostCount > 0 ? ` 호스트 ${result.skippedHostCount}개는 건너뛰었습니다.` : ''
  }`;
}

export function countWorkspacePanes(workspace: WorkspaceTab): number {
  const stack = [workspace.layout];
  let count = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.kind === 'leaf') {
      count += 1;
      continue;
    }
    stack.push(node.first, node.second);
  }
  return count;
}

export function resolveAdjacentTabCandidate(
  tabStrip: DynamicTabStripItem[],
  workspaces: WorkspaceTab[],
  sessionId: string,
): DynamicTabStripItem | null {
  const currentIndex = tabStrip.findIndex(
    (item) => item.kind === 'session' && item.sessionId === sessionId,
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
    if (candidate.kind === 'workspace') {
      const workspace = workspaces.find((item) => item.id === candidate.workspaceId);
      if (!workspace) {
        continue;
      }
      const paneCount = workspace.layout.kind === 'leaf' ? 1 : undefined;
      const sessionCount = paneCount ?? countWorkspacePanes(workspace);
      if (sessionCount >= 4) {
        continue;
      }
    }
    return candidate;
  }

  return null;
}

export function workspaceContainsSession(
  workspace: WorkspaceTab,
  sessionId: string,
): boolean {
  const stack = [workspace.layout];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.kind === 'leaf') {
      if (node.sessionId === sessionId) {
        return true;
      }
      continue;
    }
    stack.push(node.first, node.second);
  }
  return false;
}
