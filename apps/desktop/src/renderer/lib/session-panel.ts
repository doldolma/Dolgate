// 세션 패널의 판단 로직. 컴포넌트에서 떼어 둔 이유는 여기서 틀리면 **사용자가 친 적 없는
// 명령이 원격에서 실행**되기 때문이다 — 화면 없이 검증할 수 있어야 한다.
//
// 패널이 보내는 것은 두 갈래다.
//  - 히스토리: 화면 버퍼에서 읽어 낸 텍스트. 셸 통합은 명령 텍스트를 보고하지 않으므로
//    (133;E 없음) 여러 줄 입력에는 화면에 찍힌 보조 프롬프트(bash `> `, zsh `heredoc> `)가
//    섞여 있다. 그대로 실행하면 heredoc 종료어가 안 맞아 셸이 멈춘다.
//  - 스니펫: 사용자가 저장해 둔 원문. 여러 줄이어도 정확하다.
// 그래서 같은 세 버튼을 두면서도 판정은 출처에 따라 갈린다.

/** 줄 비우기(Ctrl-U). 입력줄에 남아 있던 것을 지우고 넣는다 — 셸과 우리 버퍼가 함께 비워진다. */
const CLEAR_LINE = '\x15';
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

export type SessionPanelSectionId =
  | 'snippets'
  | 'history'
  | 'ai'
  | 'resources'
  | 'processes'
  | 'ports'
  | 'tmux'
  | 'theme';

export interface SessionPanelHistoryItem {
  id: number;
  /** 화면에서 읽어 낸 명령. 읽지 못했으면 null. */
  command: string | null;
  /** 읽은 값이 실제 입력과 다를 수 있다(여러 줄·행 예산 초과). */
  commandUnreliable: boolean;
  state: 'running' | 'ok' | 'failed';
  exitCode: number | null;
  durationMs: number | null;
  cwd: string | null;
  startedAt: number;
  /** 스크롤백에서 이 명령의 위치. 마커가 폐기됐으면 음수. */
  line: number;
}

export interface SessionPanelSendContext {
  /** 지금 프롬프트에 있는가(실행 중인 명령이 없는가). */
  atPrompt: boolean;
  /** 셸이 괄호 붙여넣기를 켰는가(`ESC[?2004h`). */
  bracketedPaste: boolean;
}

export interface SessionPanelActions {
  canCopy: boolean;
  canInsert: boolean;
  canRun: boolean;
  /** 입력·실행이 막힌 이유. 버튼을 감추는 대신 왜인지 말해 주기 위한 것. */
  blockedReason: 'unreadable' | 'busy' | 'needsBracketedPaste' | 'unreliable' | null;
}

const NO_ACTIONS: SessionPanelActions = {
  canCopy: false,
  canInsert: false,
  canRun: false,
  blockedReason: 'unreadable',
};

export function isMultilineCommand(command: string): boolean {
  return command.includes('\n');
}

/**
 * 히스토리 항목으로 할 수 있는 일.
 *
 * 복사는 언제나 된다. 입력은 여러 줄일 때만 괄호 붙여넣기를 요구한다 — 줄바꿈이 없으면
 * 엔터가 될 것도 없어서 그냥 안전하다. 실행은 믿을 수 있는 항목만 — `commandUnreliable` 이
 * 곧 "보조 프롬프트가 섞였거나 뒤가 잘렸다" 는 표시다.
 */
export function resolveHistoryActions(
  item: Pick<SessionPanelHistoryItem, 'command' | 'commandUnreliable' | 'state'>,
  context: SessionPanelSendContext,
): SessionPanelActions {
  if (!item.command) {
    return NO_ACTIONS;
  }
  // 실행 중인 명령은 보낼 수 없다 — 그 프로그램의 stdin 으로 들어간다.
  if (!context.atPrompt || item.state === 'running') {
    return { canCopy: true, canInsert: false, canRun: false, blockedReason: 'busy' };
  }
  const multiline = isMultilineCommand(item.command);
  // 여러 줄인데 화면에서 읽은 값이면 **넣기도 막는다.**
  //
  // 예전에는 "사용자가 섞여 든 것을 보고 고칠 것" 이라고 두었는데, 섞이는 것이 PS2("> ")여서
  // 셸의 연결 프롬프트와 똑같이 보인다 — 알아챌 수가 없다. 실제로 `cat \` + `> test.txt` 를
  // 넣고 엔터를 치면 `cat > test.txt`(리다이렉트)가 되어 파일이 비고 셸이 멈췄다.
  //
  // 셸이 PS2 폭을 알려주는 세션(B;2)에서는 오염이 없어 unreliable 이 아니므로 그대로 넣을 수
  // 있다. 이 조건은 그 마커가 없는 셸·예전 세션에만 걸린다.
  const canInsert = multiline
    ? context.bracketedPaste && !item.commandUnreliable
    : true;
  return {
    canCopy: true,
    canInsert,
    canRun: !item.commandUnreliable,
    blockedReason: !canInsert
      ? multiline && item.commandUnreliable
        ? 'unreliable'
        : 'needsBracketedPaste'
      : item.commandUnreliable
        ? 'unreliable'
        : null,
  };
}

/**
 * 스니펫으로 할 수 있는 일.
 *
 * 히스토리와 다른 점 하나: **실행은 여러 줄이어도 된다.** 스니펫 텍스트는 사용자가 저장한
 * 원문이라 화면에서 읽어 낸 것과 달리 보조 프롬프트가 섞일 일이 없다. 반대로 입력(엔터 없이
 * 넣기)은 여러 줄이면 여전히 괄호 붙여넣기가 필요하다 — 없으면 줄바꿈이 엔터로 작동해
 * "넣기만" 이 성립하지 않는다.
 */
export function resolveSnippetActions(
  command: string,
  context: SessionPanelSendContext,
): SessionPanelActions {
  if (command.length === 0) {
    return NO_ACTIONS;
  }
  if (!context.atPrompt) {
    return { canCopy: true, canInsert: false, canRun: false, blockedReason: 'busy' };
  }
  const canInsert = !isMultilineCommand(command) || context.bracketedPaste;
  return {
    canCopy: true,
    canInsert,
    canRun: true,
    blockedReason: canInsert ? null : 'needsBracketedPaste',
  };
}

/**
 * 입력줄에 넣기만 하는 페이로드. 엔터는 붙이지 않는다.
 *
 * 여러 줄은 괄호 붙여넣기로 감싼다 — 그래야 라인 에디터가 중간 줄바꿈을 엔터가 아니라 글자로
 * 넣어 명령이 프롬프트에 그대로 앉는다. 감쌀 수 없으면(셸이 그 모드를 안 켰으면) null 을
 * 돌려준다. 여기서 그냥 보내면 줄 단위로 실행돼 버린다.
 */
export function buildInsertPayload(
  command: string,
  context: Pick<SessionPanelSendContext, 'bracketedPaste'>,
): string | null {
  if (!isMultilineCommand(command)) {
    return CLEAR_LINE + command;
  }
  if (!context.bracketedPaste) {
    return null;
  }
  return CLEAR_LINE + BRACKETED_PASTE_START + command + BRACKETED_PASTE_END;
}

/** 넣고 엔터까지. 호출 전에 `canRun` 을 확인한다. */
export function buildRunPayload(command: string): string {
  return CLEAR_LINE + command + '\r';
}

/**
 * 목록 필터. 원격에 아무것도 보내지 않는다 — 메모리에 있는 것을 거른다.
 *
 * 공백으로 나눈 토큰이 순서 상관없이 모두 들어 있으면 통과한다(명령 팔레트와 같은 규칙).
 * 여러 줄 명령도 한 항목이므로 두 번째 줄에 있는 낱말로도 찾힌다.
 */
export function filterByQuery<T>(
  items: readonly T[],
  query: string,
  readText: (item: T) => string,
): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return [...items];
  }
  return items.filter((item) => {
    const haystack = readText(item).toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/**
 * 최신 항목이 위로 오는 히스토리 목록. 레지스트리는 오래된 → 최신 순으로 쌓으므로 뒤집는다.
 *
 * 명령을 읽지 못한 블록(대체화면 진입 등)은 목록에서 뺀다 — 할 수 있는 일이 없는 줄이
 * 목록을 채우면 검색이 흐려진다.
 */
export function buildHistoryItems(
  blocks: readonly SessionPanelHistoryItem[],
): SessionPanelHistoryItem[] {
  return blocks.filter((block) => Boolean(block.command)).reverse();
}

/**
 * 목록에 한 번에 그리는 최대 줄 수.
 *
 * 셸 히스토리 스냅샷은 마지막 2000줄까지 온다. 그걸 다 그리면 행마다 버튼 세 개가 붙어
 * 요소가 수천 개가 되고, 히스토리가 많은 호스트에서 패널을 열면 앱 전체가 버벅인다
 * (실측: 리스너가 5초에 6천 개 늘었다). 검색은 전체를 훑으므로 오래된 명령도 검색으로 닿는다.
 */
export const SESSION_PANEL_LIST_LIMIT = 200;

/** 상한을 넘긴 만큼을 함께 돌려준다 — 목록 끝에 "몇 개 생략" 을 적기 위해. */
export function limitListItems<T>(
  items: readonly T[],
  limit = SESSION_PANEL_LIST_LIMIT,
): { shown: T[]; hidden: number } {
  if (items.length <= limit) {
    return { shown: [...items], hidden: 0 };
  }
  return { shown: items.slice(0, limit), hidden: items.length - limit };
}

/**
 * 셸 히스토리 파일에서 온 항목. 이번 세션 것과 한 목록에 섞이므로 같은 모양을 쓰되, 그 출처를
 * 스스로 밝힌다.
 */
export interface ShellHistoryItem {
  /** 목록 안에서만 쓰는 키. 같은 명령이 여러 번 있을 수 있어 위치를 함께 넣는다. */
  key: string;
  command: string;
}

/**
 * 이번 세션 목록과 겹치지 않는 이전 명령들. 최신이 위로 온다.
 *
 * **중복 걱정이 없다** — 이 히스토리는 연결 시점에 뜬 스냅샷이라 이번 세션에 친 명령이 들어
 * 있을 수 없다. 다만 같은 명령을 예전에 여러 번 쳤으면 파일에도 여러 번 있으므로, 연달아
 * 같은 줄만 접는다(`ls` 를 스무 번 친 기록이 목록의 스무 줄을 먹지 않게).
 */
export function buildShellHistoryItems(
  history: readonly string[],
): ShellHistoryItem[] {
  const items: ShellHistoryItem[] = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const command = history[index].trim();
    if (command.length === 0) {
      continue;
    }
    if (items.length > 0 && items[items.length - 1].command === command) {
      continue;
    }
    items.push({ key: `${index}:${command}`, command });
  }
  return items;
}

/** 실행 중인 명령이 하나라도 있으면 프롬프트가 아니다. */
export function isAtPrompt(blocks: readonly Pick<SessionPanelHistoryItem, 'state'>[]): boolean {
  return !blocks.some((block) => block.state === 'running');
}
