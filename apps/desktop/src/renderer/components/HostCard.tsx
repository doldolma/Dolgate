import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

interface HostCardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  badgeLabel: ReactNode;
  badgeMarker?: string;
  title: ReactNode;
  subtitle: ReactNode;
  groupLabel: ReactNode;
  hint?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  busy?: boolean;
  expanded?: boolean;
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
  selected = false,
  disabled = false,
  busy = false,
  expanded = false,
  actions,
  footer,
  className,
  children,
  ...props
}: HostCardProps) {
  return (
    <article
      data-host-card="true"
      data-host-card-state={busy ? 'busy' : disabled ? 'disabled' : selected ? 'selected' : 'idle'}
      aria-busy={busy || undefined}
      className={cn(
        'grid min-h-[96px] cursor-pointer grid-cols-[2.45rem_minmax(0,1fr)_auto] items-center gap-[0.7rem] overflow-hidden rounded-[20px] border border-[var(--border)] bg-[var(--surface-elevated)] px-[0.9rem] py-[0.82rem] text-left shadow-none transition-[background-color,border-color,opacity] duration-150',
        expanded ? 'h-auto items-start' : 'h-[96px]',
        selected || busy
          ? 'border-[var(--selection-border)] bg-[var(--selection-tint)]'
          : 'hover:border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] hover:bg-[color-mix(in_srgb,var(--surface-elevated)_92%,var(--accent-strong)_8%)]',
        busy && 'bg-[var(--selection-tint-strong)]',
        disabled && 'opacity-70',
        className,
      )}
      {...props}
    >
      <div
        data-host-card-badge={badgeMarker}
        className={cn(
          'inline-grid h-[2.45rem] w-[2.45rem] shrink-0 place-items-center rounded-[14px] bg-[color-mix(in_srgb,var(--accent-strong)_68%,var(--chrome-bg)_32%)] text-[0.9rem] font-bold text-white',
          typeof badgeLabel === 'string' &&
            badgeLabel.length > 3 &&
            'text-[0.8rem] tracking-[-0.02em]',
        )}
      >
        {badgeLabel}
      </div>
      <div className="min-w-0">
        <strong className="mb-[0.12rem] block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[0.9rem] text-[var(--text)]">
          {title}
        </strong>
        <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[0.76rem] text-[var(--text-soft)]">
          {subtitle}
        </span>
        <small className="mt-[0.06rem] block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[0.68rem] text-[var(--text-soft)]">
          {groupLabel}
        </small>
        {hint ? (
          <small className="mt-[0.06rem] block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[0.68rem] text-[var(--text-soft)]">
            {hint}
          </small>
        ) : null}
      </div>
      {actions ? (
        <div className="flex justify-self-end">{actions}</div>
      ) : (
        <div aria-hidden="true" />
      )}
      {footer ? (
        <div className="col-span-full mt-[0.15rem] flex w-full flex-wrap items-center gap-[0.4rem] pl-16">
          {footer}
        </div>
      ) : null}
      {children}
    </article>
  );
}
