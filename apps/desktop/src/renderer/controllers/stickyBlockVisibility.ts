/** 스티키 헤더를 붙일지 판단하기 위한 사실들. 모두 절대 버퍼 행 번호다. */
export interface StickyBlockVisibilityInput {
  /** 명령 줄(블록의 시작). */
  blockStart: number;
  /** 블록이 끝난 행. 아직 실행 중이면 null. */
  blockEnd: number | null;
  /** 지금 화면 맨 위 행. */
  viewportY: number;
  /** 셸이 지금 쓰고 있는 행(baseY + cursorY). */
  cursorLine: number;
}

/**
 * 이 블록의 스티키 헤더를 지금 보여 줘야 하는가.
 *
 * 두 가지를 본다:
 *
 *  1. **명령 줄이 화면 위로 사라졌는가.** 아직 보이면 붙일 이유가 없다 — 사용자가 이미 보고 있다.
 *
 *  2. **그 블록의 출력이 아직 화면에 남아 있는가.** 이것이 없으면 `Ctrl+L` 로 화면을 지운 뒤에도
 *     헤더가 남는다. 실기기에서 그랬다: 화면은 텅 비었는데 맨 위에 `ls -al 34ms` 가 계속 붙어
 *     있었고, 그 헤더가 방금 그려진 새 프롬프트를 덮고 있었다.
 *
 *     판정은 커서로 한다. 끝난 블록의 출력은 **커서보다 위**에 있는 것이 정상이다(그 아래는 다음
 *     프롬프트다). 커서가 그 블록 범위 안으로 돌아왔다면 화면이 다시 쓰인 것이다 — `Ctrl+L`(ESC[2J)
 *     은 스크롤백을 남기고 보이는 화면만 지우므로 블록의 행 번호는 그대로 남고, 셸은 그 자리에 새
 *     프롬프트를 그린다. 그 상태에서 헤더가 말하는 출력은 화면에 없다.
 *
 *     실행 중인 블록(blockEnd === null)은 예외다 — 커서가 그 안에 있는 것이 당연하다.
 */
export function shouldShowStickyBlockHeader(
  input: StickyBlockVisibilityInput,
): boolean {
  if (input.blockStart < 0 || input.blockStart >= input.viewportY) {
    return false;
  }
  if (input.blockEnd === null) {
    return true;
  }
  if (input.blockEnd < input.viewportY) {
    // 블록이 화면 위에서 이미 끝났다. 지금 보이는 것은 이 블록의 출력이 아니다.
    return false;
  }
  // blockEnd 는 블록의 마지막 행(포함)이고, 셸은 그 **다음** 행에 프롬프트를 그리므로 정상이면
  // 커서가 blockEnd 아래에 있다. 커서가 blockEnd 보다 **위로** 올라갔을 때만 화면이 다시 쓰인
  // 것이다(Ctrl+L 뒤 프롬프트가 화면 위쪽에 다시 그려진 경우).
  return input.cursorLine >= input.blockEnd;
}
