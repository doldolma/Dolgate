import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

type IconButtonTone = 'default' | 'ghost' | 'danger';
type IconButtonSize = 'sm' | 'md';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  tone?: IconButtonTone;
  size?: IconButtonSize;
  active?: boolean;
}

const sizeClasses: Record<IconButtonSize, string> = {
  sm: 'h-9 w-9 rounded-[14px] text-sm',
  md: 'h-11 w-11 rounded-[18px] text-base',
};

const toneClasses: Record<IconButtonTone, string> = {
  default:
    'border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text)] shadow-none hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,var(--surface-elevated)_12%)]',
  ghost:
    'border-transparent bg-transparent text-[var(--text-soft)] shadow-none hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] hover:text-[var(--text)]',
  danger:
    'border-[color-mix(in_srgb,var(--danger-text)_26%,var(--border))] bg-[var(--danger-bg)] text-[var(--danger-text)]',
};

export function IconButton({
  children,
  className,
  tone = 'default',
  size = 'md',
  active = false,
  type = 'button',
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-grid place-items-center border transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_16%,transparent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-bg)] disabled:cursor-default disabled:opacity-70',
        sizeClasses[size],
        toneClasses[tone],
        active &&
          tone === 'default' &&
          'border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
