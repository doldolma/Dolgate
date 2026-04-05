import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export function FilterRow({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-end gap-[0.9rem] rounded-[22px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] p-[0.9rem]',
        className,
      )}
      {...props}
    />
  );
}
