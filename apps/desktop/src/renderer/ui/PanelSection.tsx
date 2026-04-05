import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export function PanelSection({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-[0.9rem]', className)} {...props} />;
}
