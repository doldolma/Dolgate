import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

interface SectionLabelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function SectionLabel({
  children,
  className,
  ...props
}: SectionLabelProps) {
  return (
    <div
      className={cn(
        'mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-[var(--text-soft)]',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
