import { useMemo } from 'react';
import type { SnippetRecord } from '@shared';
import { orderByVault, vaultIdOf } from '../../lib/vault-groups';
import { useAppStore } from '../../store/appStore';
import { PERSONAL_VAULT_ID } from '../../store/utils';

/**
 * 이 세션에서 고를 스니펫 — 모든 볼트 것을 보이되, 세션이 붙은 호스트의 볼트 것을 먼저(S1). 세션 패널의 목록과
 * 자동완성이 같이 쓴다(같은 키워드면 앞의 것이 이긴다). 넣기는 참조를 남기지 않아 어느 볼트 것이든 쓸 수 있다.
 * 팀이 없거나 개인 호스트·로컬 세션이면 스토어의 목록 그대로다.
 */
export function useSessionSnippets(hostId: string | null | undefined): readonly SnippetRecord[] {
  const snippets = useAppStore((state) => state.snippets);
  const teamIdBySnippetId = useAppStore((state) => state.vaultIndex?.teamIdBySnippetId);
  const sessionVaultId = useAppStore((state) =>
    hostId ? vaultIdOf(state.vaultIndex?.teamIdByHostId, hostId) : PERSONAL_VAULT_ID,
  );
  return useMemo(
    () => (snippets ? orderByVault(snippets, teamIdBySnippetId, sessionVaultId) : snippets),
    [snippets, teamIdBySnippetId, sessionVaultId],
  );
}
