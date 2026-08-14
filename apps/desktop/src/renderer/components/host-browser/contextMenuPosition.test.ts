import { describe, expect, it } from 'vitest';

import { resolveContextMenuPosition } from './contextMenuPosition';

// 창을 좁게 잡는다 — 잘림은 아래쪽에서만 생긴다.
const viewport = { viewportWidth: 520, viewportHeight: 300 };
// 호스트 메뉴 실측에 가까운 크기(연결·새 창·SFTP·tmux·컨테이너·편집·복제·삭제…).
const menu = { width: 196, height: 340 };

describe('resolveContextMenuPosition', () => {
  it('아래에 자리가 있으면 커서 자리에 그대로 펼친다', () => {
    const placement = resolveContextMenuPosition({
      x: 120,
      y: 40,
      width: 196,
      height: 180,
      ...viewport,
    });

    expect(placement).toMatchObject({ left: 120, top: 40 });
  });

  // 목록 아래쪽 호스트를 우클릭한 경우. 예전에는 커서 자리에 그대로 펼쳐서 아래가 잘렸다.
  it('아래가 부족하면 커서 위로 펼친다', () => {
    const placement = resolveContextMenuPosition({
      x: 120,
      y: 250,
      width: 196,
      height: 180,
      ...viewport,
    });

    expect(placement.top).toBe(70);
    // 아래 끝이 커서에 닿는다 — 화면 밖으로 나가지 않는다.
    expect(placement.top + 180).toBeLessThanOrEqual(viewport.viewportHeight);
  });

  it('위아래 어디에도 안 들어가면 화면에 맞추고 스크롤에 맡긴다', () => {
    const placement = resolveContextMenuPosition({
      x: 120,
      y: 250,
      ...menu,
      ...viewport,
    });

    // 잘라 버리면 마지막 항목(삭제 등)을 누를 방법이 없다.
    expect(placement.top).toBe(12);
    expect(placement.maxHeight).toBe(276);
    expect(placement.maxHeight).toBeLessThan(menu.height);
  });

  it('오른쪽으로 넘치면 왼쪽으로 당긴다', () => {
    const placement = resolveContextMenuPosition({
      x: 500,
      y: 40,
      width: 196,
      height: 120,
      ...viewport,
    });

    expect(placement.left).toBe(312);
    expect(placement.left + 196).toBeLessThanOrEqual(viewport.viewportWidth);
  });

  it('아주 좁은 창에서도 최소 높이는 남긴다', () => {
    const placement = resolveContextMenuPosition({
      x: 10,
      y: 10,
      ...menu,
      viewportWidth: 200,
      viewportHeight: 80,
    });

    expect(placement.left).toBe(12);
    expect(placement.top).toBe(12);
    expect(placement.maxHeight).toBe(120);
  });
});
