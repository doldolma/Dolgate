import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

interface ToggleSwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  checked: boolean;
  label: ReactNode;
  description?: ReactNode;
}

/**
 * 심플한 토글: 테두리·배경 없이 [라벨 + 설명(왼쪽) / 스위치(오른쪽)] 한 줄.
 * 모든 화면에서 같은 모양으로 쓰인다.
 */
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
      aria-label={typeof label === 'string' ? label : undefined}
      className={cn(
        'flex w-full items-center justify-between gap-4 self-stretch rounded-[10px] py-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--accent-strong)_50%,white_50%)] focus-visible:outline-offset-2',
        className,
      )}
      {...props}
    >
      <span className="flex min-w-0 flex-col gap-[0.25rem]">
        <span className="text-[0.9rem] font-medium text-[var(--text)]">
          {label}
        </span>
        {description ? (
          <span className="text-[0.76rem] leading-[1.45] text-[var(--text-soft)]">
            {description}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          'relative h-[1.6rem] w-[2.7rem] shrink-0 rounded-full bg-[color-mix(in_srgb,var(--text-soft)_24%,transparent_76%)] transition-colors duration-150',
          checked
            ? 'bg-[color-mix(in_srgb,var(--accent-strong)_78%,transparent_22%)]'
            : '',
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            'absolute left-[0.16rem] top-[0.16rem] h-[1.28rem] w-[1.28rem] rounded-full bg-white shadow-[0_2px_6px_rgba(16,26,40,0.18)] transition-transform duration-150',
            checked ? 'translate-x-[1.1rem]' : '',
          )}
        />
      </span>
    </button>
  );
}
