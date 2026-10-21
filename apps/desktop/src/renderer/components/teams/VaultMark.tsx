import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import type { VaultSectionTeam } from '../../lib/vault-groups';
import { IconButton, Tooltip } from '../../ui';
import { Plus, User } from '../../ui/icons';
import { TeamMark } from './TeamMark';

/** 볼트 표시 — 개인은 사람 아이콘 네모, 팀은 머리글자 네모. 사이드바 볼트 줄과 같은 모양이다. */
export function VaultMark({ team, size = 'sm' }: { team: VaultSectionTeam | null; size?: 'xs' | 'sm' }) {
  if (team) {
    return <TeamMark name={team.name} size={size} />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-grid shrink-0 place-items-center bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent_88%)] text-[var(--accent-strong)]',
        size === 'xs' ? 'h-[14px] w-[14px] rounded-[4px]' : 'h-[1.4rem] w-[1.4rem] rounded-[7px]',
      )}
    >
      <User className={size === 'xs' ? 'h-[0.55rem] w-[0.55rem]' : 'h-[0.85rem] w-[0.85rem]'} />
    </span>
  );
}

/** 편집 창 머리에 붙는 "어느 볼트에" 칩(후보 N2). */
export function VaultChip({ team }: { team: VaultSectionTeam | null }) {
  const { t: translate } = useTranslation();
  return (
    <span
      data-vault-chip={team?.id ?? 'personal'}
      className="inline-flex min-h-[1.85rem] items-center gap-[0.35rem] rounded-[8px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_94%,transparent_6%)] px-[0.6rem] py-[0.2rem] align-middle text-[0.82rem] font-semibold text-[var(--text-soft)]"
    >
      <VaultMark team={team} size="xs" />
      {team?.name ?? translate('sidebar.personalVault')}
    </span>
  );
}

interface VaultSectionHeaderProps {
  team: VaultSectionTeam | null;
  count: number;
  /** + 의 이름(툴팁·스크린리더). null 이면(막힌 팀, 만들 것이 없는 목록) + 를 그리지 않는다. */
  addLabel: string | null;
  onAdd?: () => void;
  /** 개수 옆 ⓘ — 그 묶음에만 해당하는 설명(팀 Saved Credentials 의 "멤버 모두에게" 등). */
  hint?: ReactNode;
}

/** 볼트별 목록의 묶음 머리(후보 L2) — 표시·이름·개수, 오른쪽 + 가 그 볼트에 만든다. */
export function VaultSectionHeader({ team, count, addLabel, onAdd, hint }: VaultSectionHeaderProps) {
  const { t: translate } = useTranslation();
  return (
    <div data-vault-section={team?.id ?? 'personal'} className="flex items-center justify-between gap-4">
      <span className="inline-flex min-w-0 items-center gap-2">
        <VaultMark team={team} />
        <strong className="truncate text-[0.95rem] text-[var(--text)]">
          {team?.name ?? translate('sidebar.personalVault')}
        </strong>
        <span className="text-[0.82rem] text-[var(--text-soft)]">{count}</span>
        {hint}
      </span>
      {addLabel && onAdd ? (
        <Tooltip label={addLabel}>
          <IconButton size="sm" aria-label={addLabel} onClick={onAdd}>
            <Plus className="h-4 w-4" aria-hidden />
          </IconButton>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** 빈 볼트의 점선 한 줄(L2e). EmptyState 와 같은 테두리. */
export function VaultEmptyLine({ children }: { children: string }) {
  return (
    <div className="rounded-[12px] border border-dashed border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] bg-[color-mix(in_srgb,var(--surface-muted)_94%,transparent_6%)] px-[0.9rem] py-[0.9rem] text-[0.9rem] text-[var(--text-soft)] shadow-none">
      {children}
    </div>
  );
}
