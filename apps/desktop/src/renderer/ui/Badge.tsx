import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

type BadgeTone = 'neutral' | 'running' | 'starting' | 'paused' | 'error' | 'stopped';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  tone?: BadgeTone;
}

const toneClasses: Record<BadgeTone, string> = {
  neutral:
    'border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] text-[var(--text-soft)]',
  running:
    'border-[color-mix(in_srgb,var(--success-text)_24%,var(--border))] bg-[color-mix(in_srgb,var(--success-bg)_70%,transparent_30%)] text-[var(--success-text)]',
  starting:
    'border-[color-mix(in_srgb,var(--accent-strong)_26%,var(--border))] bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent_88%)] text-[var(--accent-strong)]',
  paused:
    'border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] text-[var(--text-soft)]',
  error:
    'border-[color-mix(in_srgb,var(--danger-text)_26%,var(--border))] bg-[var(--danger-bg)] text-[var(--danger-text)]',
  stopped:
    'border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] text-[var(--text-soft)]',
};

export function Badge({
  children,
  className,
  tone = 'neutral',
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex min-h-[1.85rem] items-center justify-center rounded-full border px-[0.72rem] py-[0.32rem] text-[0.79rem] font-semibold tracking-[0.01em]',
        toneClasses[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
