import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

interface ModalShellProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  size?: ModalSize;
}

const sizeClasses: Record<ModalSize, string> = {
  sm: 'w-[min(32rem,calc(100vw-2rem))]',
  md: 'w-[min(35rem,calc(100vw-2rem))]',
  lg: 'w-[min(45rem,calc(100vw-2rem))]',
  xl: 'w-[min(60rem,calc(100vw-2rem))]',
};

export function ModalShell({
  children,
  className,
  size = 'md',
  ...props
}: ModalShellProps) {
  return (
    <div
      className={cn(
        'flex max-h-[calc(100vh-7rem)] flex-col overflow-hidden rounded-[28px] border border-[var(--border)] bg-[var(--dialog-surface)] shadow-[var(--shadow-floating)]',
        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function ModalHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'shrink-0 flex items-center justify-between gap-4 border-b border-[var(--border)] px-6 py-[1.2rem]',
        className,
      )}
      {...props}
    />
  );
}

export function ModalBody({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 pb-[1.35rem] pt-[1.15rem]', className)} {...props} />;
}

export function ModalFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'shrink-0 flex items-center justify-end gap-4 border-t border-[var(--border)] px-6 py-[1.15rem]',
        className,
      )}
      {...props}
    />
  );
}
