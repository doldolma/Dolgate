import type { HTMLAttributes } from 'react';
import { normalizeGroupPath, type HostRecord } from '@shared';
import { cn } from '../../lib/cn';
import { MoreVertical, Star } from '../../ui/icons';
import {
  formatLastUsed,
  getHostAddress,
  getHostRegion,
  getHostShortType,
} from './hostDisplay';
import { useTranslation } from 'react-i18next';
import { HostBadge } from './HostBadge';

const MAX_VISIBLE_TAGS = 3;

interface HostListCardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  host: HostRecord;
  selected?: boolean;
  /** Single-focused card (drives the detail panel) — stronger emphasis than `selected`. */
  focused?: boolean;
  /**
   * 지금 열린 컨텍스트 메뉴가 이 카드를 대상으로 하는가.
   *
   * 선택과 **다른 표시**여야 한다 — 같은 색으로 칠하면 "선택된 건가?" 를 다시 묻게 된다. 편집
   * 중에는 우클릭이 선택을 옮기지 않으므로(HomeShell 의 menu 예외), 이 표시가 유일한 단서다.
   */
  menuTarget?: boolean;
  favorite?: boolean;
  favoriteLabel?: string;
  onToggleFavorite?: () => void;
  /** 최근 사용(연결) 시각 ms — 그룹 라인 우측에 상대시간으로 표시(없으면 생략). */
  lastUsedAt?: number;
  /** Opens the host action menu at the given viewport coords (the ⋮ button). */
  onOpenMenu?: (coords: { x: number; y: number }) => void;
}

export function HostListCard({
  host,
  selected = false,
  focused = false,
  menuTarget = false,
  favorite = false,
  favoriteLabel,
  onToggleFavorite,
  lastUsedAt,
  onOpenMenu,
  className,
  ...props
}: HostListCardProps) {
  const { t: translate } = useTranslation();
  const shortType = getHostShortType(host);
  const region = getHostRegion(host);
  const address = getHostAddress(host);
  const group = normalizeGroupPath(host.groupName);
  const tags = host.tags ?? [];
  const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS);
  const overflowTagCount = tags.length - visibleTags.length;
  const typeLine = [shortType, region].filter(Boolean).join(' · ');

  return (
    <article
      data-host-card="true"
      data-host-id={host.id}
      data-host-card-state={selected ? 'selected' : 'idle'}
      data-host-menu-target={menuTarget ? 'true' : undefined}
      className={cn(
        'flex h-full min-h-[7.75rem] cursor-pointer flex-col gap-[0.4rem] overflow-hidden rounded-[10px] border bg-[var(--surface-elevated)] px-[0.9rem] py-[0.7rem] text-left transition-[background-color,border-color,box-shadow] duration-150',
        focused
          ? 'border-[color-mix(in_srgb,var(--accent-strong)_55%,var(--border)_45%)] bg-[var(--selection-tint)]'
          : selected
            ? 'border-[var(--selection-border)] bg-[var(--selection-tint)]'
            : 'border-[var(--border)] hover:border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] hover:bg-[color-mix(in_srgb,var(--surface-elevated)_92%,var(--accent-strong)_8%)]',
        // 링은 테두리(선택)와 겹치지 않는 층이라, 선택 여부와 무관하게 대상을 알려 준다.
        menuTarget &&
          'ring-2 ring-[color-mix(in_srgb,var(--accent-strong)_45%,transparent)]',
        className,
      )}
      {...props}
    >
      {/* Top row: badge + name + star + menu */}
      <div className="flex items-center gap-[0.55rem]">
        <HostBadge host={host} />
        <strong className="min-w-0 flex-1 truncate text-[0.9rem] text-[var(--text)]">
          {host.label}
        </strong>
        {onToggleFavorite ? (
          <button
            type="button"
            aria-label={favoriteLabel ?? translate('hostCard.favorite')}
            aria-pressed={favorite}
            className={cn(
              'inline-grid h-[1.7rem] w-[1.7rem] shrink-0 place-items-center rounded-[8px] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)]',
              favorite ? 'text-[#e0a23a]' : 'text-[var(--text-muted)] hover:text-[var(--text-soft)]',
            )}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite();
            }}
          >
            <Star className="h-[1rem] w-[1rem]" fill={favorite ? 'currentColor' : 'none'} />
          </button>
        ) : null}
        {onOpenMenu ? (
          <button
            type="button"
            aria-label={translate('hostCard.menuFor', { label: host.label })}
            className="inline-grid h-[1.7rem] w-[1.7rem] shrink-0 place-items-center rounded-[8px] text-[var(--text-muted)] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] hover:text-[var(--text)]"
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              onOpenMenu({ x: rect.right, y: rect.bottom });
            }}
          >
            <MoreVertical className="h-[1.05rem] w-[1.05rem]" />
          </button>
        ) : null}
      </div>

      {/* Type · region */}
      {typeLine ? (
        <span className="truncate text-[0.76rem] font-medium text-[var(--text-soft)]">
          {typeLine}
        </span>
      ) : null}

      {/* Address / IP */}
      {address ? (
        <span className="truncate text-[0.76rem] text-[var(--text)]">{address}</span>
      ) : null}

      {/* Tags (always visible, capped) */}
      {visibleTags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-[0.25rem]">
          {visibleTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center rounded-full border border-[color-mix(in_srgb,var(--accent-strong)_16%,var(--border)_84%)] bg-[color-mix(in_srgb,var(--accent-strong)_9%,transparent_91%)] px-[0.4rem] py-[0.25rem] text-[0.7rem] font-medium text-[var(--accent-strong)]"
            >
              {tag}
            </span>
          ))}
          {overflowTagCount > 0 ? (
            <span className="text-[0.7rem] font-medium text-[var(--text-muted)]">
              +{overflowTagCount}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Group footer + 최근 사용시간(우측) */}
      <div className="mt-auto flex items-center gap-2 border-t border-[var(--border)] pt-[0.4rem] text-[0.7rem] text-[var(--text-muted)]">
        <span className="min-w-0 flex-1 truncate">
          {group ? group.split('/').join(' / ') : 'Ungrouped'}
        </span>
        {lastUsedAt ? (
          <span className="shrink-0 tabular-nums">{formatLastUsed(lastUsedAt)}</span>
        ) : null}
      </div>
    </article>
  );
}
