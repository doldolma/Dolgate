import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

interface OptionCardProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> {
  title: ReactNode;
  description?: ReactNode;
  preview?: ReactNode;
  active?: boolean;
}

export function OptionCard({
  title,
  description,
  preview,
  active = false,
  className,
  type = 'button',
  ...props
}: OptionCardProps) {
  return (
    <button
      type={type}
      className={cn(
        'flex min-h-[150px] w-full flex-col items-start gap-3 rounded-[22px] border px-4 py-4 text-left transition-[border-color,box-shadow,background-color] duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_14%,transparent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-bg)]',
        active
          ? 'border-[var(--selection-border)] bg-[var(--selection-tint)] shadow-none'
          : 'border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] hover:bg-[color-mix(in_srgb,var(--surface-muted)_96%,transparent_4%)]',
        className,
      )}
      {...props}
    >
      {preview ? <div className="w-full">{preview}</div> : null}
      <div className="grid gap-1.5">
        <strong className="text-[var(--text)]">{title}</strong>
        {description ? (
          <span className="text-sm leading-[1.5] text-[var(--text-soft)]">
            {description}
          </span>
        ) : null}
      </div>
    </button>
  );
}
