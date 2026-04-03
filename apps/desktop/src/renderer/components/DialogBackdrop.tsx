import type { MouseEvent, PointerEvent, ReactNode } from "react";
import { useRef } from "react";

interface DialogBackdropProps {
  children: ReactNode;
  className?: string;
  dismissOnBackdrop?: boolean;
  dismissDisabled?: boolean;
  onDismiss?: () => void;
}

export function DialogBackdrop({
  children,
  className = "modal-backdrop",
  dismissOnBackdrop = true,
  dismissDisabled = false,
  onDismiss,
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
    <div className={className} role="presentation" onPointerDownCapture={handlePointerDownCapture} onClick={handleClick}>
      {children}
    </div>
  );
}
