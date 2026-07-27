import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export function Tabs({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] p-[0.25rem] shadow-none',
        className,
      )}
      {...props}
    />
  );
}

interface TabButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function TabButton({
  active = false,
  className,
  type = 'button',
  ...props
}: TabButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        // justify-center: 폭이 내용에 맞을 때는 아무 차이가 없지만, 호출부가 min-w 로
        // 여유 폭을 주면(컨테이너 상세 탭) 그 여유가 오른쪽에만 생겨 짧은 라벨이 왼쪽으로
        // 붙는다 — 같은 줄의 긴 라벨은 폭을 채워 중앙처럼 보이니 정렬이 라벨 길이마다
        // 어긋난다. 왼쪽 정렬이 필요한 곳(타이틀바 세션 탭)은 justify-start 를 직접 지정하고
        // 있고 cn 이 twMerge 라 그쪽이 이긴다.
        'inline-flex items-center justify-center whitespace-nowrap rounded-full border px-[0.9rem] py-[0.55rem] text-[0.9rem] font-semibold tracking-[-0.01em] transition-[background-color,border-color,color,box-shadow] duration-150',
        active
          ? 'active border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)] shadow-none'
          : 'border-transparent bg-transparent text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface)_44%,transparent_56%)] hover:text-[var(--text)]',
        className,
      )}
      {...props}
    />
  );
}
