import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export function Tabs({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_90%,transparent_10%)] p-[0.32rem] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]',
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
          ? 'active border-[color-mix(in_srgb,var(--accent-strong)_34%,var(--border)_66%)] bg-[color-mix(in_srgb,var(--accent-strong)_13%,var(--surface-elevated)_87%)] text-[var(--accent-strong)] shadow-[0_8px_20px_rgba(15,23,38,0.08)]'
          : 'border-transparent bg-transparent text-[var(--text-soft)] hover:text-[var(--text)]',
        className,
      )}
      {...props}
    />
  );
}
