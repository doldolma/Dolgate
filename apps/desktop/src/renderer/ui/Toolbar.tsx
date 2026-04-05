import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export function Toolbar({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-wrap items-end gap-[0.9rem]', className)}
      {...props}
    />
  );
}
