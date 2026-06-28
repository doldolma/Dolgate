import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';

interface TooltipProps {
  label: string;
  children: ReactNode;
  /** 래퍼 span에 적용할 클래스(예: flex 레이아웃에서 flex-1). */
  className?: string;
}

/**
 * hover/focus 즉시(지연 없이) 뜨는 툴팁. 트리거 위 중앙에 portal + fixed로 띄워
 * overflow-hidden 컨테이너(사이드바 등)의 클리핑을 피하고, 뷰포트 가장자리에선
 * 화면 안에 들어오도록 위치를 보정한다.
 */
export function Tooltip({ label, children, className }: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<{ cx: number; top: number } | null>(null);
  const [left, setLeft] = useState(0);

  // 페인트 전에 툴팁 너비를 재서 중앙 정렬하되 화면 밖으로 나가지 않게 보정한다.
  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) {
      return;
    }
    const width = tipRef.current.offsetWidth;
    const margin = 8;
    setLeft(
      Math.min(
        Math.max(anchor.cx - width / 2, margin),
        window.innerWidth - width - margin,
      ),
    );
  }, [anchor]);

  const reveal = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({ cx: rect.left + rect.width / 2, top: rect.top });
    }
  };
  const hide = () => setAnchor(null);

  return (
    <span
      ref={triggerRef}
      className={cn('inline-flex', className)}
      onMouseEnter={reveal}
      onMouseLeave={hide}
      onFocus={reveal}
      onBlur={hide}
    >
      {children}
      {anchor
        ? createPortal(
            <span
              ref={tipRef}
              role="tooltip"
              style={{ left, top: anchor.top - 8 }}
              className="pointer-events-none fixed z-[200] -translate-y-full whitespace-nowrap rounded-[8px] border border-[var(--border)] bg-[var(--surface-strong)] px-[0.5rem] py-[0.3rem] text-[0.72rem] font-medium text-[var(--text)] shadow-[var(--shadow-floating)]"
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
