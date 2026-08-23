// 섹션이 빌 때 보여 주는 안내. 하우스 `EmptyState` 를 쓰되 패널 폭(340px)에 맞게 글자만
// 줄인다 — 맨 텍스트를 가운데 띄우면 "아직 안 만든 화면" 처럼 보인다.

import type { ReactNode } from 'react';
import { EmptyState } from '../../../ui';

interface SessionPanelEmptyProps {
  title: string;
  description: string;
  children?: ReactNode;
}

export function SessionPanelEmpty({
  title,
  description,
  children,
}: SessionPanelEmptyProps) {
  return (
    <EmptyState
      className="mx-1 mt-1.5 px-3 py-3 [&>p]:text-[0.75rem] [&>p]:leading-[1.5] [&>strong]:text-[0.8rem]"
      title={title}
      description={description}
    >
      {children}
    </EmptyState>
  );
}
