import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

interface ToggleSwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  checked: boolean;
  label: ReactNode;
  description?: ReactNode;
}

export function ToggleSwitch({
  checked,
  label,
  description,
  className,
  type = 'button',
  ...props
}: ToggleSwitchProps) {
  return (
    <button
      type={type}
      role="switch"
      aria-checked={checked}
      className={cn(
        'flex w-full items-center gap-[0.9rem] rounded-[16px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_88%,transparent_12%)] px-[0.85rem] py-[0.7rem] text-left text-[var(--text)] transition-[border-color,box-shadow,background] duration-150 hover:border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--accent-strong)_50%,white_50%)] focus-visible:outline-offset-2',
        checked
          ? 'border-[color-mix(in_srgb,var(--accent-strong)_32%,var(--border))] bg-[color-mix(in_srgb,var(--accent-strong)_11%,var(--surface-strong)_89%)]'
          : '',
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'relative h-[1.8rem] w-12 shrink-0 rounded-full bg-[color-mix(in_srgb,var(--text-soft)_22%,transparent_78%)] transition-colors duration-150',
          checked
            ? 'bg-[color-mix(in_srgb,var(--accent-strong)_72%,transparent_28%)]'
            : '',
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            'absolute left-[0.18rem] top-[0.18rem] h-[1.44rem] w-[1.44rem] rounded-full bg-white shadow-[0_6px_14px_rgba(16,26,40,0.2)] transition-transform duration-150',
            checked ? 'translate-x-[1.18rem]' : '',
          )}
        />
      </span>
      <span className="grid gap-[0.18rem]">
        <strong className="text-[0.88rem] text-[var(--text)]">{label}</strong>
        {description ? (
          <span className="text-[0.78rem] leading-[1.45] text-[var(--text-soft)]">
            {description}
          </span>
        ) : null}
      </span>
    </button>
  );
}
