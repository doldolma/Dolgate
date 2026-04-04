import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
}

export function EmptyState({
  title,
  description,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'grid-column-[1/-1] rounded-[24px] border border-dashed border-[color-mix(in_srgb,var(--accent-strong)_26%,var(--border)_74%)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-[1.25rem] py-[1.2rem] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]',
        className,
      )}
      {...props}
    >
      <strong className="mb-[0.45rem] block text-[0.98rem]">{title}</strong>
      {description ? <p className="text-[var(--text-soft)]">{description}</p> : null}
    </div>
  );
}
