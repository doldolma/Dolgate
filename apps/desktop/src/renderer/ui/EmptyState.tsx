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
        'grid-column-[1/-1] rounded-[12px] border border-dashed border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] bg-[color-mix(in_srgb,var(--surface-muted)_94%,transparent_6%)] px-[0.9rem] py-[0.9rem] shadow-none',
        className,
      )}
      {...props}
    >
      <strong className="mb-[0.4rem] block text-[1rem]">{title}</strong>
      {description ? <p className="text-[var(--text-soft)]">{description}</p> : null}
    </div>
  );
}
