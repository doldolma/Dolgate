import { describe, expect, it } from 'vitest';

import { shouldShowStickyBlockHeader } from './stickyBlockVisibility';

describe('shouldShowStickyBlockHeader', () => {
  // 출력 안으로 스크롤해 들어간 상태. 이것이 이 헤더의 존재 이유다.
  it('명령 줄이 화면 위로 사라졌고 출력이 남아 있으면 붙인다', () => {
    expect(
      shouldShowStickyBlockHeader({
        blockStart: 100,
        blockEnd: 180,
        viewportY: 120,
        // 다음 프롬프트는 블록 아래에 있다.
        cursorLine: 181,
      }),
    ).toBe(true);
  });

  // 셸은 명령이 끝난 **그 행**에 다음 프롬프트를 그린다(실측: cursorLine=15, blockEnd=15).
  // 이 경계를 배타적으로 잡으면 평범한 스크롤에서 헤더가 아예 안 뜬다.
  it('다음 프롬프트가 끝 행과 같은 줄이어도 붙인다', () => {
    expect(
      shouldShowStickyBlockHeader({
        blockStart: 100,
        blockEnd: 180,
        viewportY: 120,
        cursorLine: 180,
      }),
    ).toBe(true);
  });

  it('명령 줄이 아직 보이면 붙이지 않는다', () => {
    expect(
      shouldShowStickyBlockHeader({
        blockStart: 120,
        blockEnd: 180,
        viewportY: 120,
        cursorLine: 181,
      }),
    ).toBe(false);
  });

  // 실행 중인 블록은 끝을 모른다. 커서가 그 안에 있는 것이 정상이다.
  it('실행 중인 블록은 커서가 안에 있어도 붙인다', () => {
    expect(
      shouldShowStickyBlockHeader({
        blockStart: 100,
        blockEnd: null,
        viewportY: 120,
        cursorLine: 130,
      }),
    ).toBe(true);
  });

  // Ctrl+L. ESC[2J 는 스크롤백을 남기고 보이는 화면만 지우므로 블록의 행 번호는 그대로 남고,
  // 셸은 그 자리에 새 프롬프트를 그린다 — 커서가 블록 범위 안으로 돌아온다.
  //
  // 예전에는 이 경우에도 헤더가 남아서, 텅 빈 화면 맨 위에 `ls -al 34ms` 가 붙어 있었고 그것이
  // 방금 그려진 프롬프트를 덮었다.
  it('화면을 지우면(커서가 블록 안으로 돌아오면) 내린다', () => {
    expect(
      shouldShowStickyBlockHeader({
        // 실측값 그대로다(rows=10, ls 출력 14줄, Ctrl+L 뒤): 스크롤 위치와 블록 범위는 그대로인데
        // 커서만 지워진 화면 맨 위로 돌아온다.
        blockStart: 0,
        blockEnd: 15,
        viewportY: 6,
        cursorLine: 6,
      }),
    ).toBe(false);
  });

  it('블록이 화면 위에서 이미 끝났으면 내린다', () => {
    expect(
      shouldShowStickyBlockHeader({
        blockStart: 100,
        blockEnd: 140,
        viewportY: 150,
        cursorLine: 200,
      }),
    ).toBe(false);
  });

  // 마커가 스크롤백 절삭으로 폐기된 블록(line = -1)은 가리킬 곳이 없다.
  it('폐기된 마커는 붙이지 않는다', () => {
    expect(
      shouldShowStickyBlockHeader({
        blockStart: -1,
        blockEnd: 180,
        viewportY: 120,
        cursorLine: 200,
      }),
    ).toBe(false);
  });
});
