import type { HTMLAttributes } from 'react';
import { getHostBadgeLabel, normalizeGroupPath, type HostRecord } from '@shared';
import { cn } from '../../lib/cn';
import { MoreVertical, Star } from '../../ui/icons';
import {
  formatLastUsed,
  getHostAddress,
  getHostBadgeTone,
  getHostRegion,
  getHostShortType,
} from './hostDisplay';

const MAX_VISIBLE_TAGS = 3;

interface HostListCardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  host: HostRecord;
  selected?: boolean;
  /** Single-focused card (drives the detail panel) — stronger emphasis than `selected`. */
  focused?: boolean;
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
  favorite = false,
  favoriteLabel = '즐겨찾기',
  onToggleFavorite,
  lastUsedAt,
  onOpenMenu,
  className,
  ...props
}: HostListCardProps) {
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
      data-host-card-state={selected ? 'selected' : 'idle'}
      className={cn(
        'flex h-full min-h-[7.75rem] cursor-pointer flex-col gap-[0.4rem] overflow-hidden rounded-[10px] border bg-[var(--surface-elevated)] px-[0.9rem] py-[0.7rem] text-left transition-[background-color,border-color,box-shadow] duration-150',
        focused
          ? 'border-[color-mix(in_srgb,var(--accent-strong)_55%,var(--border)_45%)] bg-[var(--selection-tint)]'
          : selected
            ? 'border-[var(--selection-border)] bg-[var(--selection-tint)]'
            : 'border-[var(--border)] hover:border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] hover:bg-[color-mix(in_srgb,var(--surface-elevated)_92%,var(--accent-strong)_8%)]',
        className,
      )}
      {...props}
    >
      {/* Top row: badge + name + star + menu */}
      <div className="flex items-center gap-[0.55rem]">
        <span
          aria-hidden="true"
          className={cn(
            'inline-grid h-[1.9rem] min-w-[2.3rem] shrink-0 place-items-center rounded-[8px] px-[0.25rem] text-[0.7rem] font-bold tracking-[-0.01em]',
            getHostBadgeTone(host),
          )}
        >
          {getHostBadgeLabel(host)}
        </span>
        <strong className="min-w-0 flex-1 truncate text-[0.9rem] text-[var(--text)]">
          {host.label}
        </strong>
        {onToggleFavorite ? (
          <button
            type="button"
            aria-label={favoriteLabel}
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
            aria-label={`${host.label} 작업 메뉴`}
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
