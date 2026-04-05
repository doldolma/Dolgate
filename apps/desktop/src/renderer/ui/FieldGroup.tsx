import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

interface FieldGroupProps extends HTMLAttributes<HTMLLabelElement> {
  label: ReactNode;
  compact?: boolean;
  children: ReactNode;
}

export function FieldGroup({
  label,
  compact = false,
  className,
  children,
  ...props
}: FieldGroupProps) {
  return (
    <label
      className={cn(
        'flex min-w-0 flex-col gap-[0.55rem] text-[0.95rem] font-medium text-[var(--text)]',
        compact ? 'max-w-[16rem]' : '',
        className,
      )}
      {...props}
    >
      <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">
        {label}
      </span>
      {children}
    </label>
  );
}
