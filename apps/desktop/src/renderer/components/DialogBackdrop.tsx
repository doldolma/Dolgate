import type { HTMLAttributes, MouseEvent, PointerEvent, ReactNode } from 'react';
import { useRef } from 'react';
import { cn } from '../lib/cn';

interface DialogBackdropProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children: ReactNode;
  className?: string;
  dismissOnBackdrop?: boolean;
  dismissDisabled?: boolean;
  onDismiss?: () => void;
}

export function DialogBackdrop({
  children,
  className,
  dismissOnBackdrop = true,
  dismissDisabled = false,
  onDismiss,
  ...props
}: DialogBackdropProps) {
  const pointerStartedOnBackdropRef = useRef(false);

  function handlePointerDownCapture(event: PointerEvent<HTMLDivElement>) {
    pointerStartedOnBackdropRef.current = event.target === event.currentTarget;
  }

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    if (!dismissOnBackdrop || dismissDisabled) {
      pointerStartedOnBackdropRef.current = false;
      return;
    }
    if (event.target !== event.currentTarget) {
      pointerStartedOnBackdropRef.current = false;
      return;
    }
    if (!pointerStartedOnBackdropRef.current) {
      pointerStartedOnBackdropRef.current = false;
      return;
    }
    pointerStartedOnBackdropRef.current = false;
    onDismiss?.();
  }

  return (
    <div
      className={cn(
        'modal-backdrop fixed inset-0 z-[8] grid place-items-center bg-[rgba(12,20,32,0.32)]',
        className,
      )}
      role="presentation"
      onPointerDownCapture={handlePointerDownCapture}
      onClick={handleClick}
      {...props}
    >
      {children}
    </div>
  );
}
