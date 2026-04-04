import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
  fullWidth?: boolean;
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'min-h-9 rounded-[14px] px-3 py-2 text-sm',
  md: 'min-h-11 rounded-[16px] px-4 py-3 text-[0.95rem]',
  lg: 'min-h-12 rounded-[20px] px-5 py-3.5 text-[1rem]',
};

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'border-[color-mix(in_srgb,var(--accent-strong)_80%,black_20%)] bg-[var(--accent-strong)] text-[var(--accent-contrast)] shadow-[0_16px_30px_color-mix(in_srgb,var(--accent-strong)_20%,transparent)] hover:-translate-y-[1px] hover:brightness-[1.03] active:translate-y-0 disabled:brightness-100',
  secondary:
    'border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] text-[var(--text)] shadow-[0_8px_20px_rgba(15,23,38,0.08)] hover:bg-[color-mix(in_srgb,var(--surface-elevated)_92%,var(--surface-muted)_8%)]',
  ghost:
    'border-transparent bg-transparent text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)]',
  danger:
    'border-[color-mix(in_srgb,var(--danger-text)_26%,var(--border))] bg-[var(--danger-bg)] text-[var(--danger-text)] shadow-[0_10px_20px_color-mix(in_srgb,var(--danger-text)_10%,transparent)] hover:-translate-y-[1px] hover:brightness-[1.02] active:translate-y-0',
};

const activeVariantClasses: Partial<Record<ButtonVariant, string>> = {
  secondary:
    'border-[color-mix(in_srgb,var(--accent-strong)_34%,var(--border)_66%)] bg-[color-mix(in_srgb,var(--accent-strong)_14%,var(--surface))] text-[var(--accent-strong)]',
  ghost:
    'bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] text-[var(--text)]',
};

export function Button({
  children,
  className,
  variant = 'secondary',
  size = 'md',
  active = false,
  fullWidth = false,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 border font-semibold tracking-[-0.01em] transition-[transform,box-shadow,background-color,border-color,color,filter] duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_16%,transparent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-bg)] disabled:cursor-default disabled:opacity-70 disabled:shadow-none',
        sizeClasses[size],
        variantClasses[variant],
        active ? activeVariantClasses[variant] : null,
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
