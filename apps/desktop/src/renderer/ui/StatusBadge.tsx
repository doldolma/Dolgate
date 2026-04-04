import type { ComponentProps, ReactNode } from 'react';
import { Badge } from './Badge';

export type StatusBadgeTone =
  | 'neutral'
  | 'running'
  | 'starting'
  | 'paused'
  | 'error'
  | 'stopped';

interface StatusBadgeProps extends Omit<ComponentProps<typeof Badge>, 'tone' | 'children'> {
  children: ReactNode;
  tone?: StatusBadgeTone;
}

export function StatusBadge({
  children,
  tone = 'neutral',
  className,
  ...props
}: StatusBadgeProps) {
  return (
    <Badge tone={tone} className={className} {...props}>
      {children}
    </Badge>
  );
}
