import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'w-full min-h-11 rounded-[16px] border border-[var(--border)] bg-[var(--surface-strong)] px-4 py-[0.9rem] text-[var(--text)] shadow-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--text-soft)] focus:border-[var(--selection-border)] focus:outline-none focus:ring-4 focus:ring-[color-mix(in_srgb,var(--accent-strong)_10%,transparent)]',
          className,
        )}
        {...props}
      />
    );
  },
);
