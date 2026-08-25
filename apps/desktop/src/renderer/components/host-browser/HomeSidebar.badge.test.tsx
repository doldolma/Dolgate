// 사이드바 푸터의 포트 포워딩 배지. 실행 중 포워딩이 포트 화면에 가야만 보였던 것을 상시
// 보이게 한다 — 밀지 않고, 볼 때 있다.

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeSidebar } from './HomeSidebar';
import type { HostBrowserModel } from './useHostBrowser';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// 푸터만 검사한다. 목록·그룹 트리는 이 테스트의 관심이 아니라 비워 둔다.
const model = () =>
  ({
    hosts: [],
    groupTreeRows: [],
    visibleGroupTreeRows: [],
    collapsedTreeGroupPathSet: new Set<string>(),
    currentGroupPath: [],
    selectedGroupPathSet: new Set<string>(),
    selectedGroupPaths: [],
    favoriteHostIds: new Set<string>(),
    favoritesFilterActive: false,
    toggleFavoritesFilter: vi.fn(),
    tagCounts: [],
    activeTagFilter: [],
    toggleTagFilter: vi.fn(),
    isRootDragTarget: false,
    dragTargetGroupPath: null,
    draggedGroupPath: null,
    onSelectSection: vi.fn(),
    groupSortKey: 'manual',
    setGroupSortKey: vi.fn(),
    hideEmptyGroups: false,
    setHideEmptyGroups: vi.fn(),
    expandAllGroups: vi.fn(),
    collapseAllGroups: vi.fn(),
  }) as unknown as HostBrowserModel;

describe('HomeSidebar 의 포트 포워딩 배지', () => {
  it('켜진 것이 없으면 배지를 그리지 않는다', () => {
    render(<HomeSidebar hb={model()} activePortForwardEntryCount={0} />);
    // 이름이 그대로면 배지도 없다.
    expect(screen.getByRole('button', { name: 'Port Forwarding' })).toBeTruthy();
  });

  it('개수를 아이콘 위에 얹고 이름에도 붙인다', () => {
    // 아이콘만 있는 버튼이라 숫자만 읽히면 뜻이 없다.
    render(<HomeSidebar hb={model()} activePortForwardEntryCount={3} />);
    const button = screen.getByRole('button', { name: 'Port Forwarding (3 active)' });
    expect(button.textContent).toContain('3');
  });

  it('두 자리를 넘으면 잘라서 아이콘을 가리지 않는다', () => {
    render(<HomeSidebar hb={model()} activePortForwardEntryCount={12} />);
    const button = screen.getByRole('button', { name: 'Port Forwarding (12 active)' });
    expect(button.textContent).toContain('9+');
  });

  it('다른 섹션에는 배지가 붙지 않는다', () => {
    render(<HomeSidebar hb={model()} activePortForwardEntryCount={3} />);
    for (const name of ['Snippets', 'Logs', 'Settings']) {
      expect(screen.getByRole('button', { name }).textContent).toBe('');
    }
  });
});
