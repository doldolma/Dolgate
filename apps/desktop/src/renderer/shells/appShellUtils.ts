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
  // SSH 호스트의 값을 묻거나, VNC·RDP 호스트 자신의 계정·비밀번호(RDP 는 도메인까지)를 묻는다(vncFailure·rdpFailure).
  if (
    !host ||
    !(
      host.kind === 'ssh' ||
      (pending.vncFailure && host.kind === 'vnc') ||
      (pending.rdpFailure && host.kind === 'rdp')
    )
  ) {
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
