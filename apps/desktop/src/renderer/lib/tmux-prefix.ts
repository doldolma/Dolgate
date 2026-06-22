// tmux prefix(Ctrl-b) 단축키 상태머신.
//
// control mode pane 입력 경로(useTerminalSessionViewController 의 onData)에서, prefix
// 토글이 켜져 있을 때 Ctrl-b(0x02) 다음 키 한 개를 가로채 네이티브 동작으로 매핑한다.
// 토글이 꺼져 있거나 tmux pane 이 아니면 이 모듈은 관여하지 않는다(평소대로 send-keys).
//
// 동작은 의도적으로 "최소 안전 집합"만 매핑한다. 미지원 키(z=zoom 등)는 tmux 의
// 평소 동작을 보존하기 위해 Ctrl-b + 키를 그대로 흘려보낸다(passthrough).

export const TMUX_PREFIX_BYTE = '\x02'; // Ctrl-b

export type TmuxPrefixAction =
  | { kind: 'newWindow' }
  | { kind: 'splitPane'; direction: 'h' | 'v' }
  | { kind: 'selectWindow'; windowId: string }
  | { kind: 'detach' }
  | { kind: 'killPane' }
  // passthrough: 매핑하지 않고 이 문자열을 그대로 send-keys 로 보낸다(미지원 키/리터럴 Ctrl-b 등).
  | { kind: 'passthrough'; data: string };

/**
 * resolveSiblingWindowId 는 현재 window 기준 다음/이전 tmux window id 를 돌려준다.
 * 같은 control 세션의 window 목록은 호출부(store)가 정렬해 넘긴다. 1개뿐이면 자기 자신.
 */
export function resolveSiblingWindowId(
  orderedWindowIds: readonly string[],
  currentWindowId: string,
  step: 1 | -1,
): string | null {
  if (orderedWindowIds.length === 0) {
    return null;
  }
  const index = orderedWindowIds.indexOf(currentWindowId);
  if (index < 0) {
    return orderedWindowIds[0] ?? null;
  }
  const nextIndex =
    (index + step + orderedWindowIds.length) % orderedWindowIds.length;
  return orderedWindowIds[nextIndex] ?? null;
}

export interface TmuxPrefixResolverContext {
  /** 같은 control 세션의 window id 목록(탭 순서대로). n/p 윈도우 전환에 쓴다. */
  orderedWindowIds: readonly string[];
  /** 이 pane 이 속한 window id. */
  currentWindowId: string;
}

/**
 * mapPrefixKey 는 prefix(Ctrl-b) 직후의 데이터 청크를 받아 (액션, 소비한 길이) 를 돌려준다.
 * 첫 문자만 해석하고 나머지는 호출부가 일반 입력으로 다시 처리하도록 length 로 알린다.
 * 매핑 없는 키는 passthrough(Ctrl-b+키)로 돌려 tmux 평소 동작을 보존한다.
 */
export function mapPrefixKey(
  data: string,
  context: TmuxPrefixResolverContext,
): { action: TmuxPrefixAction; consumed: number } | null {
  if (data.length === 0) {
    return null;
  }
  const key = data[0];
  switch (key) {
    case 'c':
      return { action: { kind: 'newWindow' }, consumed: 1 };
    case '%':
      // tmux: % = 좌우 분할(horizontal split = -h).
      return { action: { kind: 'splitPane', direction: 'h' }, consumed: 1 };
    case '"':
      // tmux: " = 상하 분할(vertical split = -v).
      return { action: { kind: 'splitPane', direction: 'v' }, consumed: 1 };
    case 'n': {
      const windowId = resolveSiblingWindowId(
        context.orderedWindowIds,
        context.currentWindowId,
        1,
      );
      return windowId
        ? { action: { kind: 'selectWindow', windowId }, consumed: 1 }
        : { action: { kind: 'passthrough', data: TMUX_PREFIX_BYTE + key }, consumed: 1 };
    }
    case 'p': {
      const windowId = resolveSiblingWindowId(
        context.orderedWindowIds,
        context.currentWindowId,
        -1,
      );
      return windowId
        ? { action: { kind: 'selectWindow', windowId }, consumed: 1 }
        : { action: { kind: 'passthrough', data: TMUX_PREFIX_BYTE + key }, consumed: 1 };
    }
    case 'd':
      return { action: { kind: 'detach' }, consumed: 1 };
    case 'x':
      return { action: { kind: 'killPane' }, consumed: 1 };
    case TMUX_PREFIX_BYTE:
      // tmux 관례: prefix 를 두 번 누르면 리터럴 Ctrl-b 한 개를 보낸다.
      return {
        action: { kind: 'passthrough', data: TMUX_PREFIX_BYTE },
        consumed: 1,
      };
    default:
      // z(zoom) 를 포함한 미매핑 키는 Ctrl-b+키를 그대로 흘려보낸다(tmux 평소 동작 보존).
      return {
        action: { kind: 'passthrough', data: TMUX_PREFIX_BYTE + key },
        consumed: 1,
      };
  }
}
