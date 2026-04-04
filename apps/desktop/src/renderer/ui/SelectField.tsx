import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export const SelectField = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function SelectField({ className, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        'w-full min-h-11 rounded-[16px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] px-4 py-[0.9rem] text-[var(--text)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-[border-color,box-shadow,background-color] duration-150 focus:border-[color-mix(in_srgb,var(--accent-strong)_42%,var(--border)_58%)] focus:outline-none focus:ring-4 focus:ring-[color-mix(in_srgb,var(--accent-strong)_12%,transparent)]',
        className,
      )}
      {...props}
    />
  );
});
