import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
}

export function EmptyState({
  title,
  description,
  children,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'grid-column-[1/-1] rounded-[12px] border border-dashed border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] bg-[color-mix(in_srgb,var(--surface-muted)_94%,transparent_6%)] px-[0.9rem] py-[0.9rem] shadow-none',
        className,
      )}
      {...props}
    >
      <strong className="mb-[0.4rem] block text-[1rem]">{title}</strong>
      {description ? <p className="text-[var(--text-soft)]">{description}</p> : null}
      {/* 선택: 설명 아래 액션(예: New … CTA). 전달 안 하면 렌더되지 않아 기존 사용처엔 영향 없음. */}
      {children ? <div className="mt-[0.9rem]">{children}</div> : null}
    </div>
  );
}
