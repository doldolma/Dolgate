// 이미 탭으로 열려 있는 tmux 세션을 찾는다.
//
// 왜 필요한가. 세션 목록에서 세션을 고르면 늘 새 control 클라이언트를 붙였다. 그래서 같은
// 세션에 붙은 탭이 둘이 되고, 두 탭이 같은 화면을 비추니 '셸이 2개 뜬다' 로 보인다. 게다가
// tmux 3.1 미만은 창 크기를 붙어 있는 클라이언트 중 **가장 작은 것**에 맞추므로, 잊고 둔 탭
// 하나가 보고 있는 창을 좁혀 버린다.
//
// 붙기 전에 여기로 물어보고, 이미 있으면 새로 붙이지 말고 그 탭으로 간다. `tmux attach -d` 로
// 남을 떼어내는 방법도 있지만 그것은 사용자의 다른 탭과 진짜 터미널의 tmux 까지 쫓아낸다 —
// 재연결은 이 기본 명령을 다시 쓰기 때문에 재연결마다 그렇게 된다.

/** 이 함수가 보는 tmux 그룹의 최소 모양(TmuxSessionGroup 의 부분집합). */
export interface OpenTmuxSessionCandidate {
  id: string;
  sessionName: string;
  hostId?: string | null;
}

/**
 * 같은 호스트의 같은 이름 세션을 이미 들고 있는 그룹을 돌려준다(없으면 null).
 *
 * 이름은 tmux 가 준 그대로 비교한다(tmux 세션 이름은 대소문자를 구분한다). 세션 이름이 아직
 * 비어 있는 그룹(%session-changed 도착 전)은 후보가 아니다 — 무엇에 붙었는지 모르는 그룹으로
 * 보내면 엉뚱한 세션을 보여 준다.
 */
export function findOpenTmuxSession<T extends OpenTmuxSessionCandidate>(
  groups: readonly T[],
  hostId: string | null | undefined,
  sessionName: string,
): T | null {
  if (!hostId || !sessionName) {
    return null;
  }
  return (
    groups.find(
      (group) => group.hostId === hostId && group.sessionName === sessionName,
    ) ?? null
  );
}
