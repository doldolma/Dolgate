import type { ReactNode } from 'react';
import { Tooltip } from '../../ui';

/**
 * 팀 레코드에서 사람마다 다른 칸(즐겨찾기·agent forwarding·터미널 테마) — 자리는 그대로 두고 툴팁으로만 알린다.
 * hint 가 없으면(개인 것) 감싸지 않는다 — 지금 화면 그대로다.
 */
export function PerPersonHint({
  hint,
  className,
  children,
}: {
  hint: string | null | undefined;
  className?: string;
  children: ReactNode;
}) {
  if (!hint) {
    return <>{children}</>;
  }
  return (
    <Tooltip label={hint} className={className}>
      {children}
    </Tooltip>
  );
}
