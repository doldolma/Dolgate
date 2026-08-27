import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';

interface TooltipProps {
  label: string;
  children: ReactNode;
  /** 래퍼 span에 적용할 클래스(예: flex 레이아웃에서 flex-1). */
  className?: string;
  /**
   * 여러 줄로 풀어 쓴다(`\n` 이 줄바꿈이 되고, 긴 문자열은 접힌다).
   *
   * 기본값은 한 줄이다 — 아이콘 이름 같은 짧은 말이 대부분이라 접히면 오히려 읽기 나쁘다.
   * 파일 경로처럼 끊을 자리가 없는 긴 값에만 켠다. 그때는 화면 밖으로 나가는 대신 접힌다.
   */
  multiline?: boolean;
}

/**
 * hover/focus 즉시(지연 없이) 뜨는 툴팁. 트리거 위 중앙에 portal + fixed로 띄워
 * overflow-hidden 컨테이너(사이드바 등)의 클리핑을 피하고, 뷰포트 가장자리에선
 * 화면 안에 들어오도록 위치를 보정한다.
 */
export function Tooltip({
  label,
  children,
  className,
  multiline = false,
}: TooltipProps) {
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
              className={cn(
                'pointer-events-none fixed z-[200] -translate-y-full rounded-[8px] border border-[var(--border)] bg-[var(--surface-strong)] px-[0.5rem] py-[0.3rem] text-[0.72rem] font-medium text-[var(--text)] shadow-[var(--shadow-floating)]',
                multiline
                  // 경로에는 끊을 자리가 없어 break-all 이 있어야 접힌다(break-words 로는
                  // 한 줄이 그대로 화면을 넘는다).
                  ? 'max-w-[min(30rem,calc(100vw-2rem))] whitespace-pre-line break-all text-left leading-[1.45]'
                  : 'whitespace-nowrap',
              )}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
