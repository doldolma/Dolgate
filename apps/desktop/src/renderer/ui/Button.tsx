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
    'border-[color-mix(in_srgb,var(--accent-strong)_76%,black_24%)] bg-[var(--accent-strong)] text-[var(--accent-contrast)] shadow-none hover:bg-[color-mix(in_srgb,var(--accent-strong)_92%,white_8%)]',
  secondary:
    'border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text)] shadow-none hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,var(--surface-elevated)_12%)]',
  ghost:
    'border-transparent bg-transparent text-[var(--text-soft)] shadow-none hover:bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] hover:text-[var(--text)]',
  danger:
    'border-[color-mix(in_srgb,var(--danger-text)_24%,var(--border))] bg-[var(--danger-bg)] text-[var(--danger-text)] shadow-none hover:bg-[color-mix(in_srgb,var(--danger-bg)_90%,var(--surface)_10%)]',
};

const activeVariantClasses: Partial<Record<ButtonVariant, string>> = {
  secondary:
    'border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)]',
  ghost:
    'bg-[var(--selection-tint)] text-[var(--accent-strong)]',
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
        'inline-flex items-center justify-center gap-2 border font-semibold tracking-[-0.01em] transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_14%,transparent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-bg)] disabled:cursor-default disabled:opacity-70 disabled:shadow-none',
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
