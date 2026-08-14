/** 우클릭 메뉴를 화면 안에 놓기 위한 입력. 크기는 **실측값**이다(항목 수가 대상마다 다르다). */
export interface ContextMenuPositionInput {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  /** 화면 가장자리와의 최소 여백. */
  margin?: number;
}

export interface ContextMenuPosition {
  left: number;
  top: number;
  /** 위아래 어디에도 다 들어가지 않을 때만 의미가 있다(그때는 메뉴가 스크롤된다). */
  maxHeight: number;
}

/**
 * 커서 자리에 띄우되, 화면 밖으로 나가면 접어 넣는다.
 *
 * 규칙은 네이티브 메뉴와 같다:
 *   1. 아래에 들어가면 커서 아래로 펼친다.
 *   2. 안 들어가고 위에 들어가면 커서 **위로** 펼친다.
 *   3. 위아래 다 안 되면 화면에 맞춰 앉히고 스크롤한다.
 *
 * 3번을 잘라 버리면 마지막 항목(삭제 등)을 누를 방법이 없다 — 목록 아래쪽 호스트를 우클릭했을 때
 * 실제로 그 상태였다. 예전 코드는 높이를 72px 로 어림했는데(항목 하나 크기) 호스트 메뉴는 연결·
 * 새 창·SFTP·tmux·컨테이너·편집·복제·삭제까지 열 개가 넘는다. 대상 종류와 선택 개수에 따라 항목이
 * 달라지므로 상수 추정은 맞을 수가 없다.
 */
export function resolveContextMenuPosition(
  input: ContextMenuPositionInput,
): ContextMenuPosition {
  const margin = input.margin ?? 12;
  const roomBelow = input.viewportHeight - input.y - margin;
  const roomAbove = input.y - margin;

  let top: number;
  if (input.height <= roomBelow) {
    top = input.y;
  } else if (input.height <= roomAbove) {
    top = input.y - input.height;
  } else {
    // 화면보다 큰 메뉴. 위에서 시작해 아래 여백까지 쓰고, 넘치는 만큼은 스크롤에 맡긴다.
    top = Math.max(margin, Math.min(input.y, input.viewportHeight - input.height - margin));
  }

  return {
    left: Math.max(
      margin,
      Math.min(input.x, input.viewportWidth - input.width - margin),
    ),
    top,
    // 아무리 좁은 창이어도 몇 항목은 보이게 한다.
    maxHeight: Math.max(120, input.viewportHeight - margin * 2),
  };
}
