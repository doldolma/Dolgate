// tmux prefix(Ctrl-b) 단축키 상태머신.
//
// control mode pane 입력 경로(useTerminalSessionViewController 의 onData)에서, prefix
// 토글이 켜져 있을 때 Ctrl-b(0x02) 다음 키 한 개를 가로채 네이티브 동작으로 매핑한다.
// 토글이 꺼져 있거나 tmux pane 이 아니면 이 모듈은 관여하지 않는다(평소대로 send-keys).
//
// 동작은 의도적으로 "최소 안전 집합"만 매핑한다. 미지원 키(z=zoom 등)는 tmux 의
// 평소 동작을 보존하기 위해 Ctrl-b + 키를 그대로 흘려보낸다(passthrough).

export const TMUX_PREFIX_BYTE = '\x02'; // Ctrl-b (기본)

// 설정에서 고를 수 있는 prefix 키 목록. value 는 저장 토큰("C-<letter>"/"C-Space").
export const TMUX_PREFIX_KEY_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: 'C-b', label: 'Ctrl-B (기본)' },
  { value: 'C-a', label: 'Ctrl-A' },
  { value: 'C-Space', label: 'Ctrl-Space' },
  { value: 'C-g', label: 'Ctrl-G' },
  { value: 'C-o', label: 'Ctrl-O' },
  { value: 'C-q', label: 'Ctrl-Q' },
];

export const DEFAULT_TMUX_PREFIX_KEY = 'C-b';

/**
 * tmuxPrefixByteFromKey 는 설정 토큰("C-b"/"C-Space")을 실제 입력 바이트로 바꾼다.
 * Ctrl-<letter> = (letter - 'a' + 1) 제어바이트, Ctrl-Space = NUL. 미인식이면 기본(Ctrl-b).
 */
export function tmuxPrefixByteFromKey(key: string | undefined): string {
  if (key === 'C-Space') {
    return '\x00';
  }
  const match = /^C-([a-z])$/.exec(key ?? '');
  if (match) {
    return String.fromCharCode(match[1].charCodeAt(0) - 96);
  }
  return TMUX_PREFIX_BYTE;
}

/**
 * tmuxPrefixKeyLabels 는 설정 토큰("C-b"/"C-Space")을 단축키 안내에 찍을 키 조합으로 바꾼다.
 * 파싱 규칙은 tmuxPrefixByteFromKey 와 같게 유지한다(미인식이면 기본 Ctrl-B).
 */
export function tmuxPrefixKeyLabels(key: string | undefined): string[] {
  if (key === 'C-Space') {
    return ['Ctrl', 'Space'];
  }
  const match = /^C-([a-z])$/.exec(key ?? '');
  return match ? ['Ctrl', match[1].toUpperCase()] : ['Ctrl', 'B'];
}

export type TmuxPrefixAction =
  | { kind: 'newWindow' }
  | { kind: 'splitPane'; direction: 'h' | 'v' }
  // windowNav: 윈도우 전환(다음/이전/직전/인덱스). dispatch 가 로컬 뷰 전환 + select-window 처리.
  | { kind: 'windowNav'; target: 'next' | 'prev' | 'last' | number }
  | { kind: 'killWindow' }
  // prompt: 텍스트 입력이 필요한 명령(rename/명령 프롬프트). dispatch 가 입력 오버레이를 연다.
  | { kind: 'prompt'; mode: 'raw' | 'rename-window' | 'rename-session' }
  | { kind: 'detach' }
  | { kind: 'killPane' }
  // command: 타깃까지 포함한 완전한 tmux 명령을 control 채널로 그대로 보낸다(단축키 확장).
  | { kind: 'command'; command: string }
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
  /** 이 pane 이 속한 window id(@N). */
  currentWindowId: string;
  /** 현재 포커스된 pane id(%N) — pane 대상 명령(select-pane/resize-pane 등)에 쓴다. */
  currentPaneId: string;
  /** prefix 입력 바이트(설정값). 미지정 시 Ctrl-b. 더블 prefix·passthrough 구성에 쓴다. */
  prefixByte?: string;
}

/**
 * mapPrefixKey 는 prefix(Ctrl-b) 직후의 데이터 청크를 받아 (액션, 소비한 길이) 를 돌려준다.
 * 첫 문자만 해석하고 나머지는 호출부가 일반 입력으로 다시 처리하도록 length 로 알린다.
 * 매핑 없는 키는 passthrough(Ctrl-b+키)로 돌려 tmux 평소 동작을 보존한다.
 */
// 방향키 escape 시퀀스 → tmux 방향 플래그.
const ARROW_DIR: Record<string, 'U' | 'D' | 'L' | 'R'> = {
  A: 'U',
  B: 'D',
  C: 'R',
  D: 'L',
};

export function mapPrefixKey(
  data: string,
  context: TmuxPrefixResolverContext,
): { action: TmuxPrefixAction; consumed: number } | null {
  if (data.length === 0) {
    return null;
  }
  const pane = context.currentPaneId;
  const win = context.currentWindowId;
  const prefixByte = context.prefixByte ?? TMUX_PREFIX_BYTE;
  const pass = (
    seq: string,
    consumed: number,
  ): { action: TmuxPrefixAction; consumed: number } => ({
    action: { kind: 'passthrough', data: prefixByte + seq },
    consumed,
  });
  const cmd = (
    command: string,
  ): { action: TmuxPrefixAction; consumed: number } => ({
    action: { kind: 'command', command },
    consumed: 1,
  });

  // 방향키(pane 이동) / Ctrl+방향키(pane 리사이즈) 등 escape 시퀀스.
  if (data[0] === '\x1b') {
    const ctrlArrow = /^\x1b\[1;5([ABCD])/.exec(data);
    if (ctrlArrow && pane) {
      return {
        action: {
          kind: 'command',
          command: `resize-pane -${ARROW_DIR[ctrlArrow[1]]} -t ${pane} 5`,
        },
        consumed: 6,
      };
    }
    const arrow = /^\x1b\[([ABCD])/.exec(data);
    if (arrow && pane) {
      return {
        action: {
          kind: 'command',
          command: `select-pane -${ARROW_DIR[arrow[1]]} -t ${pane}`,
        },
        consumed: 3,
      };
    }
    // 미지원 escape 시퀀스 → Ctrl-b + 시퀀스를 그대로 흘림.
    return pass(data, data.length);
  }

  const key = data[0];

  // tmux 관례: prefix 를 두 번 누르면 리터럴 prefix 한 개를 보낸다(설정된 키 기준).
  if (key === prefixByte) {
    return {
      action: { kind: 'passthrough', data: prefixByte },
      consumed: 1,
    };
  }

  // 숫자: 해당 index 윈도우로 전환.
  if (key >= '0' && key <= '9') {
    return { action: { kind: 'windowNav', target: Number(key) }, consumed: 1 };
  }

  switch (key) {
    case 'c':
      return { action: { kind: 'newWindow' }, consumed: 1 };
    case '%':
      // tmux: % = 좌우 분할(horizontal split = -h).
      return { action: { kind: 'splitPane', direction: 'h' }, consumed: 1 };
    case '"':
      // tmux: " = 상하 분할(vertical split = -v).
      return { action: { kind: 'splitPane', direction: 'v' }, consumed: 1 };
    case 'n':
      return { action: { kind: 'windowNav', target: 'next' }, consumed: 1 };
    case 'p':
      return { action: { kind: 'windowNav', target: 'prev' }, consumed: 1 };
    case 'l':
      return { action: { kind: 'windowNav', target: 'last' }, consumed: 1 };
    case 'd':
      return { action: { kind: 'detach' }, consumed: 1 };
    case 'x':
      return { action: { kind: 'killPane' }, consumed: 1 };
    case '&':
      return { action: { kind: 'killWindow' }, consumed: 1 };
    case ',':
      return { action: { kind: 'prompt', mode: 'rename-window' }, consumed: 1 };
    case '$':
      return { action: { kind: 'prompt', mode: 'rename-session' }, consumed: 1 };
    case ':':
      return { action: { kind: 'prompt', mode: 'raw' }, consumed: 1 };
    case 'z':
      return pane ? cmd(`resize-pane -Z -t ${pane}`) : pass(key, 1);
    case 'w':
      // 윈도우 목록(choose-tree). control mode 에선 pane 안에 트리가 렌더되고
      // 방향키/Enter 로 선택한다(copy-mode 와 동일한 방식).
      return cmd('choose-tree -w');
    case 'o':
      // 다음 pane 순환(현재 윈도우 활성 pane 기준).
      return cmd('select-pane -t :.+');
    case ';':
      return cmd('last-pane');
    case '{':
      return pane ? cmd(`swap-pane -U -t ${pane}`) : pass(key, 1);
    case '}':
      return pane ? cmd(`swap-pane -D -t ${pane}`) : pass(key, 1);
    case '!':
      return pane ? cmd(`break-pane -t ${pane}`) : pass(key, 1);
    case ' ':
      return win ? cmd(`next-layout -t ${win}`) : pass(key, 1);
    case '[':
      return pane ? cmd(`copy-mode -t ${pane}`) : pass(key, 1);
    case ']':
      return pane ? cmd(`paste-buffer -t ${pane}`) : pass(key, 1);
    default:
      // 미매핑 키는 Ctrl-b+키를 그대로 흘려보낸다(tmux 평소 동작 보존).
      return pass(key, 1);
  }
}
