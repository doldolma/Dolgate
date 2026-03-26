import type { MouseEvent, ReactNode } from "react";

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
  function handleClick(event: MouseEvent<HTMLDivElement>) {
    if (!dismissOnBackdrop || dismissDisabled) {
      return;
    }
    if (event.target !== event.currentTarget) {
      return;
    }
    onDismiss?.();
  }

  return (
    <div className={className} role="presentation" onClick={handleClick}>
      {children}
    </div>
  );
}
