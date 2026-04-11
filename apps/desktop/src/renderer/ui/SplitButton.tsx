import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button, type ButtonProps } from './Button';

interface SplitButtonProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export const SplitButton = forwardRef<HTMLDivElement, SplitButtonProps>(
  function SplitButton({ className, children, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn('relative inline-flex items-stretch rounded-2xl shadow-none', className)}
        {...props}
      >
        {children}
      </div>
    );
  },
);

type SplitButtonActionProps = Omit<ButtonProps, 'variant'>;

export function SplitButtonMain({
  className,
  ...props
}: SplitButtonActionProps) {
  return (
    <Button
      variant="primary"
      className={cn('rounded-r-none pr-4 shadow-none', className)}
      {...props}
    />
  );
}

export function SplitButtonToggle({
  className,
  children,
  ...props
}: SplitButtonActionProps) {
  return (
    <Button
      variant="primary"
      className={cn('min-w-11 rounded-l-none border-l border-l-[color-mix(in_srgb,var(--accent-contrast)_18%,transparent)] px-3 shadow-none', className)}
      {...props}
    >
      {children}
    </Button>
  );
}

export function SplitButtonMenu({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'absolute right-0 top-[calc(100%+0.45rem)] z-[3] min-w-[14rem] rounded-[18px] border border-[var(--border)] bg-[var(--dialog-surface)] p-2 shadow-[var(--shadow-floating)]',
        className,
      )}
      {...props}
    />
  );
}

export function SplitButtonMenuItem({
  className,
  ...props
}: ButtonProps) {
  return (
    <Button
      variant="ghost"
      fullWidth
      className={cn('justify-start rounded-[14px] px-3 py-2.5 font-medium text-[var(--text)]', className)}
      {...props}
    />
  );
}
