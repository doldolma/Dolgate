import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { teamMarkOf } from './team-format';

type TeamMarkSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
type TeamMarkTone = 'accent' | 'warning' | 'muted';

const sizeClasses: Record<TeamMarkSize, string> = {
  // 볼트가 섞인 목록의 줄 안 — 글줄 높이에 맞춘다.
  xs: 'h-[14px] w-[14px] rounded-[4px] text-[0.4rem]',
  sm: 'h-[22px] w-[22px] rounded-[6px] text-[0.66rem]',
  md: 'h-[30px] w-[30px] rounded-[8px] text-[0.75rem]',
  lg: 'h-10 w-10 rounded-[10px] text-[0.88rem]',
  xl: 'h-14 w-14 rounded-[14px] text-[1.15rem]',
};

const toneClasses: Record<TeamMarkTone, string> = {
  accent:
    'border-[color-mix(in_srgb,var(--accent-strong)_26%,var(--border))] bg-[color-mix(in_srgb,var(--accent-strong)_14%,transparent)] text-[var(--accent-strong)]',
  warning: 'border-transparent bg-[var(--warning-bg)] text-[var(--warning-text)]',
  muted:
    'border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_70%,var(--border))] text-[var(--text-soft)]',
};

interface MarkSquareProps {
  size?: TeamMarkSize;
  tone?: TeamMarkTone;
  className?: string;
  children: ReactNode;
}

/** 머리글자나 아이콘을 담는 네모. 팀 표시·멤버 표시·참여 카드의 상태 표시가 같이 쓴다. */
export function MarkSquare({ size = 'md', tone = 'accent', className, children }: MarkSquareProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center border font-semibold leading-none [&_svg]:h-[55%] [&_svg]:w-[55%]',
        sizeClasses[size],
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 팀 표시 — 팀 이름의 머리글자 네모. */
export function TeamMark({ name, size = 'md', className }: { name: string; size?: TeamMarkSize; className?: string }) {
  return (
    <MarkSquare size={size} className={className}>
      {teamMarkOf(name)}
    </MarkSquare>
  );
}
