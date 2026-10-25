import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

type MarkTone = 'accent' | 'warning' | 'muted';

const toneClasses: Record<MarkTone, string> = {
  accent:
    'border-[color-mix(in_srgb,var(--accent-strong)_26%,var(--border))] bg-[color-mix(in_srgb,var(--accent-strong)_14%,transparent)] text-[var(--accent-strong)]',
  warning: 'border-transparent bg-[var(--warning-bg)] text-[var(--warning-text)]',
  muted:
    'border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_70%,var(--border))] text-[var(--text-soft)]',
};

/** 참여 카드 맨 위의 아이콘 네모 — 팀·링크·잠금·경고 상태를 보인다. */
export function MarkSquare({ tone = 'accent', children }: { tone?: MarkTone; children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-[14px] border text-[1.15rem] font-semibold leading-none [&_svg]:h-[55%] [&_svg]:w-[55%]',
        toneClasses[tone],
      )}
    >
      {children}
    </span>
  );
}
