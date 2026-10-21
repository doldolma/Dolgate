import type { HostRecord, LinkedHostSummary } from '@shared';
import type { WorkspaceTab } from '../store/createAppStore';
import type { PendingCredentialRetry } from '../store/types';
import type { CredentialRetryDialogRequest } from '../components/CredentialRetryDialog';
import { t } from '../i18n';

export interface DraggedSessionPayload {
  sessionId: string;
  source: 'standalone-tab' | 'workspace-pane';
  workspaceId?: string;
}

export function findHost(hosts: HostRecord[], hostId: string | null): HostRecord | null {
  return hostId ? hosts.find((host) => host.id === hostId) ?? null : null;
}

/**
 * 요청 창이 보일 것 — 묻는 호스트의 이름과 저장된 비밀값. 점프 홉에서 막혔으면 대상이 아니라 그 점프 호스트다
 * (promptHostId).
 */
export function credentialRetryDialogRequest(
  hosts: HostRecord[],
  pending: PendingCredentialRetry | null,
): CredentialRetryDialogRequest | null {
  if (!pending) {
    return null;
  }
  const host = findHost(hosts, pending.promptHostId ?? pending.hostId);
  if (!host || host.kind !== 'ssh') {
    return null;
  }
  return {
    ...pending,
    hostLabel: host.label,
    hasStoredSecret: Boolean(host.secretRef),
    secretRef: host.secretRef ?? null,
  };
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
  return `${t('appShell.xshellImported', {
    hosts: result.createdHostCount,
    groups: result.createdGroupCount,
  })}${
    result.createdSecretCount > 0
      ? t('appShell.xshellSecrets', { count: result.createdSecretCount })
      : ''
  }${
    result.skippedHostCount > 0
      ? t('appShell.xshellSkipped', { count: result.skippedHostCount })
      : ''
  }`;
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
