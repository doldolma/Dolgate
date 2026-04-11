import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export function Tabs({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] p-[0.32rem] shadow-none',
        className,
      )}
      {...props}
    />
  );
}

interface TabButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function TabButton({
  active = false,
  className,
  type = 'button',
  ...props
}: TabButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'rounded-full border px-[0.95rem] py-[0.58rem] text-[0.92rem] font-semibold tracking-[-0.01em] transition-[background-color,border-color,color,box-shadow] duration-150',
        active
          ? 'active border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)] shadow-none'
          : 'border-transparent bg-transparent text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface)_44%,transparent_56%)] hover:text-[var(--text)]',
        className,
      )}
      {...props}
    />
  );
}
