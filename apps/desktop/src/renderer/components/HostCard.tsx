import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Star } from '../ui/icons';
import { useTranslation } from 'react-i18next';

interface HostCardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  badgeLabel: ReactNode;
  badgeMarker?: string;
  title: ReactNode;
  subtitle: ReactNode;
  groupLabel: ReactNode;
  hint?: ReactNode;
  /** Tighter fixed height (no hint line) — used by the host browser list. */
  compact?: boolean;
  selected?: boolean;
  /** Single-focused card (drives the detail panel) — stronger emphasis than `selected`. */
  focused?: boolean;
  disabled?: boolean;
  busy?: boolean;
  expanded?: boolean;
  favorite?: boolean;
  onToggleFavorite?: () => void;
  favoriteLabel?: string;
  actions?: ReactNode;
  footer?: ReactNode;
}

export function HostCard({
  badgeLabel,
  badgeMarker,
  title,
  subtitle,
  groupLabel,
  hint,
  compact = false,
  selected = false,
  focused = false,
  disabled = false,
  busy = false,
  expanded = false,
  favorite = false,
  onToggleFavorite,
  favoriteLabel,
  actions,
  footer,
  className,
  children,
  ...props
}: HostCardProps) {
  const { t: translate } = useTranslation();
  return (
    <article
      data-host-card="true"
      data-host-card-state={busy ? 'busy' : disabled ? 'disabled' : selected ? 'selected' : 'idle'}
      aria-busy={busy || undefined}
      className={cn(
        'grid cursor-pointer grid-cols-[2.3rem_minmax(0,1fr)_auto] items-center gap-[0.55rem] overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--surface-elevated)] px-[0.9rem] py-[0.7rem] text-left shadow-none transition-[background-color,border-color,opacity] duration-150',
        expanded ? 'h-auto min-h-[90px] items-start' : compact ? 'h-[80px] min-h-[80px]' : 'h-[90px] min-h-[90px]',
        selected || busy
          ? 'border-[var(--selection-border)] bg-[var(--selection-tint)]'
          : 'hover:border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] hover:bg-[color-mix(in_srgb,var(--surface-elevated)_92%,var(--accent-strong)_8%)]',
        busy && 'bg-[var(--selection-tint-strong)]',
        focused &&
          'border-[var(--selection-border)] ring-2 ring-[color-mix(in_srgb,var(--accent-strong)_30%,transparent)]',
        disabled && 'opacity-70',
        className,
      )}
      {...props}
    >
      <div
        data-host-card-badge={badgeMarker}
        className={cn(
          'inline-grid h-[2.3rem] w-[2.3rem] shrink-0 place-items-center rounded-[10px] bg-[color-mix(in_srgb,var(--accent-strong)_68%,var(--chrome-bg)_32%)] text-[0.9rem] font-bold text-white',
          typeof badgeLabel === 'string' &&
            badgeLabel.length > 3 &&
            'text-[0.82rem] tracking-[-0.02em]',
        )}
      >
        {badgeLabel}
      </div>
      <div className="min-w-0">
        <strong className="mb-[0.25rem] block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[0.9rem] text-[var(--text)]">
          {title}
        </strong>
        <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[0.76rem] text-[var(--text-soft)]">
          {subtitle}
        </span>
        <small className="mt-[0.25rem] block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[0.7rem] text-[var(--text-soft)]">
          {groupLabel}
        </small>
        {hint ? (
          <small className="mt-[0.25rem] block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[0.7rem] text-[var(--text-soft)]">
            {hint}
          </small>
        ) : null}
      </div>
      {actions || onToggleFavorite ? (
        <div className="flex items-start justify-self-end gap-[0.25rem]">
          {onToggleFavorite ? (
            <button
              type="button"
              aria-label={favoriteLabel}
              aria-pressed={favorite}
              className={cn(
                'inline-grid h-[1.75rem] w-[1.75rem] shrink-0 place-items-center rounded-[10px] text-[0.9rem] transition-colors duration-140 hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)]',
                favorite
                  ? 'text-[#d8901f]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-soft)]',
              )}
              onClick={(event) => {
                event.stopPropagation();
                onToggleFavorite();
              }}
            >
              <Star
                className="h-[0.95rem] w-[0.95rem]"
                fill={favorite ? 'currentColor' : 'none'}
                aria-hidden="true"
              />
            </button>
          ) : null}
          {actions}
        </div>
      ) : (
        <div aria-hidden="true" />
      )}
      {footer ? (
        <div className="col-span-full mt-[0.25rem] flex w-full flex-wrap items-center gap-[0.4rem] pl-[2.4rem]">
          {footer}
        </div>
      ) : null}
      {children}
    </article>
  );
}
