// 두 섹션이 함께 쓰는 검색 줄. 하우스 `Input` 을 그대로 쓴다 — 손으로 짜면 높이·라운드·포커스
// 링이 앱의 다른 입력과 어긋나 그것만으로 "덧붙인 화면" 처럼 보인다.
//
// 패널은 좁으므로 기본 44px 높이는 줄이고(min-h-9), 나머지 성질(테두리·포커스 링·placeholder
// 색)은 프리미티브 것을 물려받는다.

import type { ReactNode } from 'react';
import { Input } from '../../../ui';
import { Search } from '../../../ui/icons';

interface SessionPanelSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** 검색창 오른쪽 아이콘 버튼(예: 실패만 보기). */
  trailing?: ReactNode;
}

export function SessionPanelSearch({
  value,
  onChange,
  placeholder,
  trailing,
}: SessionPanelSearchProps) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2.5 pb-1.5 pt-2.5">
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-soft)]"
          aria-hidden
        />
        <Input
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-h-9 rounded-[9px] py-1.5 pl-8 pr-2.5 text-[0.78rem]"
        />
      </div>
      {trailing}
    </div>
  );
}
