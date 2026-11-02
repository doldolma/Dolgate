import { useState } from 'react';
import type { ImportVaultTarget } from '@shared';
import { isTeamVaultId, PERSONAL_VAULT_ID } from '../store/utils/vaults';
import { ShareSecretsToggle, VaultSelect, type VaultChoice } from './teams/VaultMark';

/** 가져오기 창이 받는 볼트 — HomeShell 이 새 호스트 서랍과 같은 기준으로 고른다. */
export interface ImportVaultProps {
  /** 가져올 수 있는 볼트(읽기 전용·다시 들어와야 하는 팀은 없다). 둘 이상일 때만 Vault 칸이 보인다. */
  vaultChoices?: VaultChoice[];
  /** 처음 고른 볼트 — 지금 보고 있는 볼트(쓸 수 없으면 개인). */
  defaultVaultId?: string;
}

/**
 * 가져올 볼트와 '함께 공유' — 창이 열릴 때마다 처음 볼트·켬으로 돌아간다. 열린 첫 화면부터 맞도록 효과가 아니라 렌더
 * 중에 돌린다. isDefaultVault 는 처음 볼트 그대로인가다(보고 있는 그룹은 그때만 따라간다).
 */
export function useImportVault(open: boolean, defaultVaultId: string = PERSONAL_VAULT_ID) {
  const [vaultId, setVaultId] = useState(defaultVaultId);
  const [shareSecrets, setShareSecrets] = useState(true);
  const [openSeen, setOpenSeen] = useState(open);
  if (openSeen !== open) {
    setOpenSeen(open);
    if (open) {
      setVaultId(defaultVaultId);
      setShareSecrets(true);
    }
  }
  return { vaultId, setVaultId, shareSecrets, setShareSecrets, isDefaultVault: vaultId === defaultVaultId };
}

/** 가져오기 요청에 싣는 볼트. 개인이면 아무것도 싣지 않는다 — 지금까지의 요청 그대로다. */
export function importVaultRequest(vaultId: string, shareSecrets: boolean): ImportVaultTarget {
  return isTeamVaultId(vaultId) ? { vaultId, shareSecrets } : {};
}

interface ImportVaultFieldsProps {
  choices: VaultChoice[];
  vaultId: string;
  onVaultChange: (vaultId: string) => void;
  /** 고른 호스트가 가져올 비밀번호·SSH 키 수(같은 키는 하나). 0 이면 공유 줄이 없다. */
  secretCount: number;
  shareSecrets: boolean;
  onShareSecretsChange: (share: boolean) => void;
  disabled?: boolean;
}

/**
 * 가져오기 창 본문 맨 위(후보 A) — 새 호스트 서랍과 같은 Vault 칸, 팀을 고르면 그 바로 아래 복사 창과 같은 '함께 공유'.
 * 본문 grid 의 칸으로 그대로 들어간다.
 */
export function ImportVaultFields({
  choices,
  vaultId,
  onVaultChange,
  secretCount,
  shareSecrets,
  onShareSecretsChange,
  disabled,
}: ImportVaultFieldsProps) {
  return (
    <>
      {choices.length > 1 ? (
        <VaultSelect choices={choices} value={vaultId} onChange={onVaultChange} disabled={disabled} />
      ) : null}
      {isTeamVaultId(vaultId) && secretCount > 0 ? (
        <ShareSecretsToggle
          count={secretCount}
          checked={shareSecrets}
          onChange={onShareSecretsChange}
          disabled={disabled}
        />
      ) : null}
    </>
  );
}
