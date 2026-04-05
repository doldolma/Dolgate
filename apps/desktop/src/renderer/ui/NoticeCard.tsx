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
    'border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] text-[var(--text-soft)]',
  info:
    'border-[color-mix(in_srgb,var(--accent-strong)_20%,var(--border))] bg-[color-mix(in_srgb,var(--accent-strong)_8%,var(--surface-muted)_92%)] text-[var(--text-soft)]',
  warning:
    'border-[color-mix(in_srgb,var(--warning,#d9a441)_28%,var(--border))] bg-[color-mix(in_srgb,var(--warning,#d9a441)_10%,var(--surface-muted)_90%)] text-[var(--text)]',
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
        'rounded-[20px] border px-4 py-3.5 shadow-[0_10px_22px_rgba(12,21,35,0.06)]',
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
