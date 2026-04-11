import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

type NoticeTone = 'neutral' | 'info' | 'warning' | 'danger';

interface NoticeCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  children?: ReactNode;
  tone?: NoticeTone;
}

const toneClasses: Record<NoticeTone, string> = {
  neutral:
    'border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_94%,transparent_6%)] text-[var(--text-soft)]',
  info:
    'border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--text-soft)]',
  warning:
    'border-[color-mix(in_srgb,var(--warning,#d9a441)_24%,var(--border))] bg-[color-mix(in_srgb,var(--warning,#d9a441)_8%,var(--surface-muted)_92%)] text-[var(--text)]',
  danger:
    'border-[color-mix(in_srgb,var(--danger-text)_22%,var(--border))] bg-[var(--danger-bg)] text-[var(--danger-text)]',
};

export function NoticeCard({
  title,
  children,
  tone = 'neutral',
  className,
  ...props
}: NoticeCardProps) {
  return (
    <div
      className={cn(
        'rounded-[20px] border px-4 py-3.5 shadow-none',
        toneClasses[tone],
        className,
      )}
      {...props}
    >
      {title ? <strong className="mb-1.5 block text-[0.96rem] text-[var(--text)]">{title}</strong> : null}
      {children ? <div className="grid gap-1.5 text-sm leading-6">{children}</div> : null}
    </div>
  );
}
