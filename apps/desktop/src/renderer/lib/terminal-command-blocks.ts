// 셸 통합(OSC 133)으로 관측한 "명령 블록"을 세션별로 보관하는 경량 레지스트리.
//
// 터미널 렌더링은 그대로 두고 그 위에 얇은 표시만 얹는 방식이다(Warp 처럼 출력을 카드로
// 재구성하지 않는다). xterm 의 marker/decoration API 가 스크롤·스크롤백 절삭에 따른 위치
// 추적을 대신 해 주므로, 우리는 "어느 명령이 어느 행에서 시작했는지"만 기록하면 된다.
//
// store 에 두지 않는 이유는 terminal-cwd-registry 와 같다 — 컨트롤러는 refs 기반이고,
// 명령마다 전역 리렌더를 유발할 이유가 없다.

import type { IBuffer, IDecoration, IMarker, Terminal } from '@xterm/xterm';
import {
  readCommandTextFromBuffer,
  unescapeReportedCommand,
  type CommandText,
} from '../../common/replay/command-text';

export {
  readCommandTextFromBuffer,
  unescapeReportedCommand,
  type CommandText,
  type CommandTextBuffer,
} from '../../common/replay/command-text';
import { classifyCommandExit } from '@shared';

/**
 * interrupted 는 Ctrl+C(130)·SIGPIPE(141)로 끝난 명령이다 — 0 이 아니어도 실패로 치지 않는다
 * (판정은 shared-core classifyCommandExit 한 곳).
 */
export type TerminalCommandBlockState = 'running' | 'ok' | 'interrupted' | 'failed';

export interface TerminalCommandBlock {
  /** 세션 내 증가 시퀀스(표시·정렬용). */
  readonly id: number;
  state: TerminalCommandBlockState;
  /** 프롬프트 뒤에서 읽어낸 명령 텍스트. 읽지 못하면 null. */
  command: string | null;
  /** 읽은 텍스트가 실제 입력과 다를 수 있음(행 예산 초과로 잘림, 여러 줄 입력) — 재실행 금지. */
  commandUnreliable: boolean;
  exitCode: number | null;
  /** OSC 133;C 시각(epoch ms). */
  startedAt: number;
  durationMs: number | null;
  cwd: string | null;
  /**
   * 명령 줄에 고정된 마커. 스크롤백에서 밀려나면 dispose 되고 위치를 잃는다.
   *
   * 갈아 끼울 수 있다 — ConPTY 가 리사이즈 뒤 화면을 다시 그려 명령 줄이 옮겨 가면
   * realignCommandBlocks 가 그 줄에 새 마커를 붙인다.
   */
  marker: IMarker;
  /**
   * 블록을 만들 때 명령 줄(마커 행)에 보이던 텍스트. ConPTY 가 다시 그린 뒤 그 줄을 다시 찾는 데
   * 쓴다(realignCommandBlocks). 마커 행이 비어 있었으면 null — 빈 줄로는 찾을 수 없다.
   */
  commandLineText: string | null;
  /** 명령이 끝난 시점의 절대 버퍼 행(출력의 끝). 완료 전에는 null. */
  endLine: number | null;
  decoration: IDecoration | null;
}

interface PendingPrompt {
  marker: IMarker;
  /** OSC 133;B 시점의 커서 X = 프롬프트가 끝나고 명령 텍스트가 시작되는 열. */
  promptEndX: number;
  /** 그때 프롬프트(promptEndX 앞까지)의 텍스트. ConPTY 가 다시 그린 뒤 프롬프트 줄을 다시 찾는 데 쓴다. */
  promptText: string;
  /**
   * 이어지는 줄(PS2)의 텍스트 시작 열. 절대 버퍼 행 → 열.
   *
   * bash 는 명령 원문을 알려줄 수 없어(133;E 불가) 화면을 읽어야 하는데, 그러면 화면에 찍힌
   * PS2("> ")가 명령에 섞인다 — `cat \` 다음 줄을 `> test.txt` 로 읽어 이어 붙이면
   * `cat > test.txt`(리다이렉트)가 된다. 그래서 PS2 에도 마커를 붙여(`B;2`) 셸이 매 줄마다
   * 프롬프트 폭을 알려주게 했다. 추측하지 않는다.
   */
  continuationEndX: Map<number, number>;
}

interface SessionBlocks {
  seq: number;
  pendingPrompt: PendingPrompt | null;
  /**
   * 셸이 알려 준 명령 원문(OSC 133;E). 있으면 화면에서 읽지 않고 이것을 쓴다.
   *
   * zsh 의 `preexec` 이 받는 `$1` 이라 **셸이 받아들인 그대로**다 — 화면에 찍힌 보조
   * 프롬프트(PS2: `heredoc> `)가 섞이지 않고, 행 예산에 잘리지도 않는다. bash 는 이것을
   * 주지 못해(전체 입력을 알 방법이 없다) 그쪽은 여전히 화면을 읽는다.
   */
  reportedCommand: string | null;
  /**
   * 앱이 이 세션의 입력줄에 방금 넣은 원문(패널의 넣기·실행).
   *
   * 화면에서 읽은 값이 이것과 같으면 **믿을 수 있다.** 왜 필요한가: 우리가 여러 줄을 괄호
   * 붙여넣기로 넣으면 bash 는 PS2 를 찍지 않는다(readline 버퍼 안의 개행이라 한 줄 편집이다).
   * 그러면 화면에는 오염 없는 값이 그대로 있는데도 "접힘이 아닌 새 줄 + 프롬프트 폭 미보고"
   * 라서 재실행이 막혔다 — 방금 우리가 넣은 그 문자열인데도.
   *
   * 사용자가 넣은 뒤 줄을 고쳐서 실행하면 값이 달라지므로 그때는 그대로 막힌다.
   */
  insertedCommand: string | null;
  blocks: TerminalCommandBlock[];
  /**
   * 블록 목록이 바뀔 때마다 오르는 카운터. 목록을 보는 UI(세션 패널 히스토리)가 구독으로
   * 갱신을 받기 위한 것이다.
   *
   * 왜 배열 대신 숫자인가: blocks 는 제자리에서 바뀌는(push·splice·필드 수정) 배열이라
   * 참조가 그대로다. useSyncExternalStore 는 스냅샷이 달라져야 다시 그리므로 배열을 주면
   * 아무 일도 일어나지 않는다. 그렇다고 매번 복사해 새 배열을 만들면 이 모듈이 refs 기반인
   * 이유(명령마다 전역 리렌더를 만들지 않기)를 스스로 깨뜨린다.
   */
  version: number;
}

/** 세션당 보관할 최대 블록 수. 초과하면 오래된 것부터 버린다(메모리 상한). */
const MAX_BLOCKS_PER_SESSION = 400;
/** 거터 폭(px). TerminalSessionPane 의 컨테이너 pl-[10px] 과 맞춰야 한다. */
const GUTTER_WIDTH_PX = 10;
/** 점 마커 지름(px). */
const DOT_SIZE_PX = 6;

const ACCENT_COLORS: Record<TerminalCommandBlockState, string> = {
  // 터미널 배경 위에 얹히므로 앱 테마 토큰 대신 밝기가 보장된 고정색을 쓴다.
  running: '#7aa2ff',
  // 성공은 화면이 시끄러워지지 않도록 낮은 채도로 잔잔하게.
  ok: 'rgba(122, 200, 160, 0.45)',
  // Ctrl+C·SIGPIPE 로 끝난 명령 — 실패가 아니므로 성공과 같은 무게의 회색.
  interrupted: 'rgba(160, 174, 192, 0.55)',
  failed: '#ef6f6c',
};

const sessions = new Map<string, SessionBlocks>();

/**
 * 이 모듈의 진입점은 xterm 파서(OSC 핸들러)와 키 핸들러 안에서 호출된다. 거기서 예외가 나면
 * 파싱/입력 루프가 끊겨 터미널 자체가 멈춰 버리므로, 블록 추적 실패는 절대 밖으로 던지지
 * 않는다. 한 번 실패하면 그 세션의 추적을 포기해 같은 예외가 매 명령마다 반복되지 않게 한다.
 *
 * 비활성화는 세션 단위다 — 전역으로 두면 탭 하나에서 난 예외가 그 창의 모든 탭과 이후
 * 모든 세션에서 기능을 죽인다(앱을 다시 켤 때까지, 사용자에게는 아무 표시도 없이).
 */
const disabledSessions = new Map<string, unknown>();

function safely<T>(sessionId: string, fallback: T, run: () => T): T {
  if (disabledSessions.has(sessionId)) {
    return fallback;
  }
  try {
    return run();
  } catch (error) {
    disabledSessions.set(sessionId, error);
    console.error(
      `[command-blocks] session ${sessionId} disabled — error while tracking command blocks`,
      error,
    );
    return fallback;
  }
}

function getSession(sessionId: string): SessionBlocks {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      seq: 0,
      pendingPrompt: null,
      reportedCommand: null,
      insertedCommand: null,
      blocks: [],
      version: 0,
    };
    sessions.set(sessionId, session);
  }
  return session;
}

type CommandBlocksListener = () => void;

const listeners = new Map<string, Set<CommandBlocksListener>>();

/**
 * 이 세션의 블록 목록이 바뀔 때 알림을 받는다. 반환값을 호출하면 구독을 끊는다.
 *
 * 알림은 블록이 생기고(C) 닫히고(D) 스크롤백에서 밀려날 때 나간다 — 출력 한 줄마다가 아니다.
 */
export function subscribeToCommandBlocks(
  sessionId: string,
  listener: CommandBlocksListener,
): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(sessionId);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(sessionId);
    }
  };
}

/** 목록이 바뀐 횟수. 구독자의 스냅샷 값으로 쓴다. */
/**
 * 이 세션에서 지금까지 시작된 명령 수.
 *
 * `blocks.length` 가 아니라 `seq` 다 — 블록 배열은 상한(400)에서 오래된 것부터 버리므로
 * 길이는 "보관 중인 수"지 "실행한 수"가 아니다. `seq` 는 블록마다 한 번 오르고 줄지 않는다.
 *
 * 추적 중이 아니면(셸 통합이 안 붙었거나 꺼진 세션) null 이다. **0 과 구분해야 한다** —
 * 0 은 "아무것도 안 했다"고, null 은 "셀 수 없었다"다.
 */
export function getCommandCount(sessionId: string): number | null {
  return sessions.get(sessionId)?.seq ?? null;
}

export function getCommandBlocksVersion(sessionId: string): number {
  return sessions.get(sessionId)?.version ?? 0;
}

function notifyCommandBlocksChanged(session: SessionBlocks, sessionId: string): void {
  session.version += 1;
  const set = listeners.get(sessionId);
  if (!set) {
    return;
  }
  for (const listener of [...set]) {
    // 구독자 하나가 던져도 나머지 구독자와 호출한 OSC 핸들러를 멈추지 않는다.
    try {
      listener();
    } catch (error) {
      console.error('[command-blocks] listener threw', error);
    }
  }
}

/**
 * 대체화면(vim·htop·tmux 등)에서는 마커가 의미를 잃고 화면 복귀 시 사라지므로 기록하지 않는다.
 */
function isNormalBuffer(terminal: Terminal): boolean {
  return terminal.buffer.active.type === 'normal';
}

/**
 * 줄을 다시 찾을 때 비교하는 텍스트. 줄 끝 공백은 뗀다.
 *
 * 같은 줄도 줄 끝이 달라진다: 셸이 쓴 프롬프트 뒤 공백은 글자지만, ConPTY 가 다시 그릴 때는 그
 * 자리를 `\e[K` 로 지우고 커서만 옮긴다. 게다가 xterm 의 translateToString(true, 0, n) 은 범위
 * 끝의 공백을 떼지 않는다(줄 전체의 마지막 글자 기준으로만 자른다). 그대로 비교하면 다시 그려진
 * 지금 프롬프트는 안 맞고, 공백이 그대로 남은 예전 명령 줄이 맞아 버렸다(실측).
 */
function lineTextForMatch(buffer: IBuffer, line: number, endColumn?: number): string | null {
  const text = buffer.getLine(line)?.translateToString(true, 0, endColumn);
  return text === undefined ? null : text.trimEnd();
}

/**
 * VS Code 처럼 명령 줄 옆 거터에 작은 점 하나만 찍는다. 출력 범위를 덮는 세로 바는 쓰지 않는다
 * — 글자와 겹치고, 데코레이션 높이가 생성 시 고정이며, 마커 행이 화면 밖으로 나가면 xterm 이
 * 아예 그리지 않아 긴 출력에서 사라지기 때문이다.
 *
 * 점은 셀 영역 바깥(컨테이너의 왼쪽 거터)에 놓는다. xterm 이 열 0 기준으로 left=0 을 잡아 주므로
 * 거터 폭만큼 음수로 민다. height 는 건드리지 않는다 — xterm 이 행 높이에 맞춰 지정해 주고,
 * 그 안에서 점을 flex 로 가운데 정렬한다.
 */
function applyDecorationStyle(
  block: TerminalCommandBlock,
  element: HTMLElement,
): void {
  // display 는 절대 건드리지 않는다. xterm 이 이걸로 (1) 뷰포트 밖 데코레이션 숨김,
  // (2) 대체화면(vim 등) 숨김을 처리하는데, 숨긴 뒤에도 onRender 를 발화하기 때문에
  // 여기서 display 를 되돌리면 스크롤로 밀려난 점이 화면에 남고 vim 위에도 점이 뜬다.
  // (xterm BufferDecorationRenderer._refreshStyle 참고)
  element.style.left = `-${GUTTER_WIDTH_PX}px`;
  element.style.width = `${GUTTER_WIDTH_PX}px`;
  element.style.backgroundColor = 'transparent';
  element.style.pointerEvents = 'none';

  // onRender 는 여러 번 불릴 수 있으므로 점 요소는 한 번만 만들고 재사용한다.
  // 세로 가운데 정렬은 flex 대신 absolute 로 한다(부모의 display 를 쓰지 않기 위해).
  let dot = element.firstElementChild as HTMLElement | null;
  if (!dot) {
    dot = document.createElement('div');
    element.appendChild(dot);
  }
  dot.style.position = 'absolute';
  dot.style.top = '50%';
  dot.style.left = '50%';
  dot.style.transform = 'translate(-50%, -50%)';
  dot.style.width = `${DOT_SIZE_PX}px`;
  dot.style.height = `${DOT_SIZE_PX}px`;
  dot.style.borderRadius = '50%';
  dot.style.backgroundColor = ACCENT_COLORS[block.state];
}

function attachDecoration(terminal: Terminal, block: TerminalCommandBlock): void {
  if (block.marker.line < 0) {
    return;
  }
  const decoration = terminal.registerDecoration({ marker: block.marker, x: 0, width: 1 });
  if (!decoration) {
    return;
  }
  block.decoration = decoration;
  // onRender 는 재렌더마다 불릴 수 있고 요소가 새로 만들어질 수도 있어 매번 다시 칠한다.
  decoration.onRender((element) => {
    applyDecorationStyle(block, element);
  });
}

/**
 * 블록에 마커를 붙이고 점을 단다.
 *
 * 마커가 사라져도 **기록은 남긴다.** 마커는 스크롤백이 절삭될 때, 그리고 `clear` 로 화면·스크롤백을
 * 지울 때 사라진다. 예전에는 그때 블록을 목록에서 지웠는데, 그러면 `clear` 한 번에 히스토리가 통째로
 * 날아간다 — 셸의 `history` 도 `clear` 로 지워지지 않는다.
 *
 * 그래서 잃는 것은 **위치뿐**이다: 거터의 점과 "이 명령 위치로 이동" 이 사라지고(그 행이 실제로
 * 없어졌으므로 맞다), 명령·종료 코드·소요 시간·작업 디렉터리는 남는다. 위치를 쓰는 쪽은 모두
 * `marker.line < 0` 을 건너뛴다.
 */
function bindBlockMarker(
  session: SessionBlocks,
  sessionId: string,
  terminal: Terminal,
  block: TerminalCommandBlock,
  marker: IMarker,
): void {
  block.marker = marker;
  marker.onDispose(() => {
    // 위치를 다시 맞추느라 갈아 끼운 옛 마커다 — 블록은 새 마커로 살아 있다.
    if (block.marker !== marker) {
      return;
    }
    block.decoration?.dispose();
    block.decoration = null;
    notifyCommandBlocksChanged(session, sessionId);
  });
  attachDecoration(terminal, block);
}

function disposeBlock(block: TerminalCommandBlock): void {
  block.decoration?.dispose();
  block.decoration = null;
  block.marker.dispose();
}

/**
 * OSC 133;E — 셸이 알려 준 명령 원문. C 보다 먼저 온다.
 *
 * 이스케이프를 되돌린다: 셸이 역슬래시를 두 배로 만든 뒤 개행을 `\n` 으로 바꿔 보낸다(OSC
 * 페이로드에 raw 개행이 들어가면 파서가 시퀀스를 중단한다). 왼쪽에서 오른쪽으로 한 번만
 * 훑어야 `echo back\\nline` 같은 입력이 개행으로 오해되지 않는다.
 */
export function noteReportedCommand(sessionId: string, escaped: string): void {
  safely(sessionId, undefined, () => {
    if (!sessionId) {
      return;
    }
    getSession(sessionId).reportedCommand = unescapeReportedCommand(escaped);
  });
}

/**
 * 앱이 입력줄에 넣은(또는 넣고 실행한) 원문을 기억한다.
 *
 * 다음 블록이 만들어질 때 화면에서 읽은 값과 대조해 "우리가 넣은 그것" 임을 확인하는 데만
 * 쓴다 — 대조에 실패하면 아무 일도 하지 않는다(추측으로 재실행을 열어 주지 않는다).
 */
export function noteInsertedCommand(sessionId: string, command: string): void {
  safely(sessionId, undefined, () => {
    if (!sessionId) {
      return;
    }
    getSession(sessionId).insertedCommand = command;
  });
}

/** 화면에서 읽은 값과 앱이 넣은 원문을 견주기 위한 정규화(줄 끝 공백·양끝 공백만 없앤다). */
function normalizeForCompare(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/**
 * OSC 133;B — 프롬프트가 끝나고 명령 입력이 시작되는 지점. 실제 명령이 실행될지는 아직
 * 모르므로 마커만 확보해 두고, C 가 와야 블록으로 승격한다(빈 Enter·프롬프트 재출력 무시).
 */
export function notePromptCommandStart(sessionId: string, terminal: Terminal): void {
  safely(sessionId, undefined, () => {
    if (!sessionId || !isNormalBuffer(terminal)) {
      return;
    }
    const session = getSession(sessionId);
    session.pendingPrompt?.marker.dispose();
    // 새 프롬프트가 떴으면 직전 명령의 E 는 쓸 데가 없다 — 남겨 두면 다음 블록에 붙는다.
    session.reportedCommand = null;
    const marker = terminal.registerMarker(0);
    const buffer = terminal.buffer.active;
    session.pendingPrompt = marker
      ? {
          marker,
          promptEndX: buffer.cursorX,
          promptText: lineTextForMatch(buffer, marker.line, buffer.cursorX) ?? '',
          continuationEndX: new Map(),
        }
      : null;
  });
}

/**
 * OSC 133;B;2 — 이어지는 줄의 프롬프트(PS2)가 끝난 지점.
 *
 * PS1 의 B 와 구분해서 받는다. 빈 엔터로 프롬프트가 다시 뜨는 것과 한 명령이 여러 줄로 이어지는
 * 것은 다른 일인데, 같은 마커면 구분할 수 없다.
 */
export function noteContinuationPrompt(sessionId: string, terminal: Terminal): void {
  safely(sessionId, undefined, () => {
    if (!sessionId || !isNormalBuffer(terminal)) {
      return;
    }
    const pending = sessions.get(sessionId)?.pendingPrompt;
    if (!pending) {
      // 첫 프롬프트를 못 받은 상태의 이어지는 줄은 기준이 없어 쓸 수 없다.
      return;
    }
    const buffer = terminal.buffer.active;
    pending.continuationEndX.set(buffer.baseY + buffer.cursorY, buffer.cursorX);
  });
}

/**
 * OSC 133;C — 명령 실행 시작. 여기서 블록을 만들고 명령 줄에 액센트를 붙인다.
 */
/**
 * 명령 실행 시작(OSC 133;C). 만들어진 블록의 명령 원문을 돌려준다(못 읽었으면 null).
 *
 * 원문을 돌려주는 이유: 서브셸 진입 판정이 이것을 쓴다. 예전에는 사용자가 **친 키**를 모아
 * 재구성했는데, ↑ 로 부른 명령이나 붙여넣기는 글자가 입력으로 오지 않아 판정 자체가 안 걸렸다
 * (`ssh host` 를 두 번째에 ↑ 로 실행하면 통합이 안 붙었다). 화면에서 읽은 값은 어떻게 입력했든
 * 같다.
 */
export function beginCommandBlock(
  sessionId: string,
  terminal: Terminal,
  cwd: string | null,
): string | null {
  return safely(sessionId, null, () =>
    beginCommandBlockUnsafe(sessionId, terminal, cwd),
  );
}

function beginCommandBlockUnsafe(
  sessionId: string,
  terminal: Terminal,
  cwd: string | null,
): string | null {
  if (!sessionId || !isNormalBuffer(terminal)) {
    return null;
  }
  const session = getSession(sessionId);
  // 실행 중인 블록이 남아 있는데 새 명령이 시작됐다면 앞 블록은 이미 끝난 것이다 — 셸은 앞
  // 명령이 끝나기 전에 다음 명령을 시작하지 못한다.
  //
  // 이것이 필요한 이유: 서브셸(`docker exec`·`bash`)로 들어가면 바깥 셸의 D 는 그 셸을 빠져나올
  // 때까지 오지 않는다. 그동안 안쪽 셸이 자기 블록을 만들면 바깥 블록 안에 안쪽 블록들이
  // 들어앉아 화면이 중첩된 것처럼 보였다. 코어가 진입 시점에 D 를 흘려 닫아 주지만 그 신호는
  // 에코 억제 창과 경합해 간헐적으로 유실됐다 — 여기서 닫으면 타이밍과 무관하게 성립한다.
  closeRunningBlock(session, sessionId, terminal);
  const pending = session.pendingPrompt;
  session.pendingPrompt = null;

  // B 를 못 받은 셸(통합이 부분 적용된 경우)에서는 현재 행을 명령 줄로 본다.
  const marker = pending?.marker ?? terminal.registerMarker(0);
  if (!marker) {
    return null;
  }

  const buffer = terminal.buffer.active;
  const outputStartLine = buffer.baseY + buffer.cursorY;
  // 셸이 알려 준 원문이 있으면 화면을 읽지 않는다 — 보조 프롬프트도, 행 예산도 없다.
  const reported = session.reportedCommand;
  session.reportedCommand = null;
  const inserted = session.insertedCommand;
  session.insertedCommand = null;
  let commandText: CommandText | null = reported
    ? { text: reported, unreliable: false }
    : pending
      ? readCommandTextFromBuffer(
          buffer,
          marker.line,
          pending.promptEndX,
          outputStartLine,
          pending.continuationEndX,
        )
      : null;
  // 화면에서 읽은 값이 앱이 방금 넣은 원문과 같으면 믿을 수 있다 — 증명할 방법이 없어서
  // 막았던 것이고(위 insertedCommand 주석), 이 대조가 그 증명이다.
  if (
    commandText?.unreliable &&
    inserted !== null &&
    normalizeForCompare(commandText.text) === normalizeForCompare(inserted)
  ) {
    commandText = { text: commandText.text, unreliable: false };
  }
  session.seq += 1;
  const commandLineText = lineTextForMatch(buffer, marker.line) ?? '';
  const block: TerminalCommandBlock = {
    id: session.seq,
    state: 'running',
    command: commandText?.text ?? null,
    // 읽은 값이 실제 입력과 다를 수 있으면(잘림·여러 줄) 재실행을 막는다.
    commandUnreliable: commandText?.unreliable ?? false,
    exitCode: null,
    startedAt: Date.now(),
    durationMs: null,
    cwd,
    marker,
    commandLineText: commandLineText.length > 0 ? commandLineText : null,
    endLine: null,
    decoration: null,
  };
  bindBlockMarker(session, sessionId, terminal, block, marker);

  session.blocks.push(block);
  // 상한을 넘으면 오래된 것부터 실제로 버린다 — 마커가 사라지는 것(위치만 잃음)과 달리
  // 이쪽은 기록 자체를 놓는 유일한 경로다(메모리 상한).
  while (session.blocks.length > MAX_BLOCKS_PER_SESSION) {
    const oldest = session.blocks.shift();
    if (oldest) {
      disposeBlock(oldest);
    }
  }
  notifyCommandBlocksChanged(session, sessionId);
  return block.command;
}

/**
 * OSC 133;D;<exit> — 명령 완료. 가장 최근 실행 중 블록의 상태를 확정한다.
 *
 * bash/zsh 는 같은 훅에서 D 다음 A 를 연달아 내보내므로, "직전 명령 종료"와 "다음 프롬프트"가
 * 한 청크로 도착한다. 시간차를 가정하지 않고 running 블록을 뒤에서 찾아 닫는다.
 */
export function finishCommandBlock(
  sessionId: string,
  terminal: Terminal,
  exitCode: number | null,
): void {
  safely(sessionId, undefined, () => {
    finishCommandBlockUnsafe(sessionId, terminal, exitCode);
  });
}

function finishCommandBlockUnsafe(
  sessionId: string,
  terminal: Terminal,
  exitCode: number | null,
): void {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  closeRunningBlock(session, sessionId, terminal, exitCode);
}

/**
 * firstLine~lastLine(절대 행, 포함)이 지워졌을 때 블록을 정리한다. 바뀐 것이 있으면 true.
 *
 * 그 줄에서 시작한 블록은 명령 줄이 사라졌으므로 위치를 잃는다(기록은 남는다 — bindBlockMarker).
 * 그 위에서 시작해 그 줄까지 이어지던 끝난 블록은 firstLine 바로 위에서 끝난다 — 남은 출력은 그대로
 * 그 블록 것이다. 실행 중인 블록의 끝은 건드리지 않는다: 지운 뒤 나오는 출력도 그 명령 것이다.
 */
function releaseErasedLines(session: SessionBlocks, firstLine: number, lastLine: number): boolean {
  let changed = false;
  for (const block of session.blocks) {
    const start = block.marker.line;
    if (start < 0) {
      continue;
    }
    if (start >= firstLine) {
      if (start <= lastLine) {
        block.marker.dispose();
        changed = true;
      }
      continue;
    }
    if (block.endLine !== null && block.endLine >= firstLine) {
      block.endLine = firstLine - 1;
      changed = true;
    }
  }
  return changed;
}

/** 그 줄들(절대 행, 포함)에 글자가 하나도 없는가. */
function linesAreBlank(buffer: IBuffer, firstLine: number, lastLine: number): boolean {
  for (let line = firstLine; line <= lastLine; line += 1) {
    if (buffer.getLine(line)?.translateToString(true)) {
      return false;
    }
  }
  return true;
}

/** 가장 최근 실행 중 블록을 닫는다. 없으면 아무 일도 하지 않는다. */
function closeRunningBlock(
  session: SessionBlocks,
  sessionId: string,
  terminal: Terminal,
  exitCode: number | null = null,
): void {
  for (let index = session.blocks.length - 1; index >= 0; index -= 1) {
    const block = session.blocks[index];
    if (block.state !== 'running') {
      continue;
    }
    block.state = classifyCommandExit(exitCode);
    block.exitCode = exitCode;
    block.durationMs = Date.now() - block.startedAt;
    // endLine 은 **이 블록에 속하는 마지막 행**이다(포함). D 마커가 올 때 커서는 보통 출력 뒤의
    // 새 행 첫 칸에 있고 셸은 바로 그 행에 다음 프롬프트를 그린다 — 그 행을 블록에 넣으면 hover
    // 영역이 다음 프롬프트까지 덮는다(실제로 그렇게 보였다). 그래서 첫 칸이면 한 행 위에서 끝낸다.
    // 출력이 개행 없이 끝나면(`printf hi`) 커서가 그 행 중간에 있고, 그 행은 출력이다.
    // 출력이 하나도 없으면 명령 줄 자체가 끝이다(그 위로는 올라가지 않는다).
    const buffer = terminal.buffer.active;
    const cursorLine = buffer.baseY + buffer.cursorY;
    block.endLine = Math.max(block.marker.line, buffer.cursorX === 0 ? cursorLine - 1 : cursorLine);
    // 끝날 때 커서가 자기 명령 줄보다 **위**에 있고 그 사이가 텅 비었으면 화면이 지워진 것이다.
    // PowerShell 의 `cls` 가 그렇다: ConPTY 는 ESC[2J 없이 맨 위부터 줄마다 지우고(ESC[K) 스크롤백을
    // 지운다(ESC[3J). 줄마다 지우기는 마커를 없애지 않아, 빈 화면에 `cls` 와 그 앞 명령들의 점이 남고
    // 그 줄에 블록이 걸렸다(실측). ESC[2J 때와 같이 정리한다.
    //
    // 비었는지까지 보는 이유: 창 크기를 바꾼 직후 ConPTY 가 화면을 다시 그려 명령 줄이 올라갔는데 위치를
    // 맞추기(realignCommandBlocks) 전에 명령이 끝나면, 커서가 옛 마커보다 위일 수 있다. 그때는 화면에
    // 내용이 그대로 있으므로 건드리지 않는다.
    if (
      block.marker.line >= 0 &&
      cursorLine < block.marker.line &&
      linesAreBlank(buffer, cursorLine, block.marker.line)
    ) {
      releaseErasedLines(session, cursorLine, block.marker.line);
    }
    if (block.decoration?.element) {
      applyDecorationStyle(block, block.decoration.element);
    }
    notifyCommandBlocksChanged(session, sessionId);
    return;
  }
}

/**
 * 화면 전체 지우기(ED2, `ESC[2J`) 직전에 부른다. 지워지는 화면에 걸쳐 있던 끝난 블록을 지워지는
 * 줄 바로 위에서 끝나게 한다.
 *
 * Ctrl+L(PowerShell·bash·zsh 모두)이 이것으로 화면을 지우고 맨 위에 프롬프트를 다시 그린다. xterm 은
 * 보이는 화면을 그 자리에서 지우고(스크롤백으로 밀어 올리지 않는다) 지운 줄의 마커를 없앤다 — 명령
 * 줄이 화면 안에 있던 블록은 그렇게 위치를 잃는다. 그런데 출력이 화면보다 길어 명령 줄은 스크롤백에
 * 있고 출력만 화면에 걸쳐 있던 블록은 마커가 살아 있고, endLine 은 숫자라 그대로다. 그 블록이 텅 빈
 * 화면 전체를 자기 범위로 잡아, 마우스를 올리면 강조와 툴바가 화면 전체에 떴다(실측).
 *
 * 실행 중인 블록은 건드리지 않는다 — 화면을 지운 뒤 나오는 출력도 그 명령의 것이다.
 */
export function noteScreenErased(sessionId: string, terminal: Terminal): void {
  safely(sessionId, undefined, () => {
    if (!sessionId || !isNormalBuffer(terminal)) {
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    // 지워지는 것은 보이는 화면(활성 영역) 전체다. 그 위의 스크롤백은 남는다. 화면에서 시작한 블록의
    // 마커는 xterm 도 지우면서 없애지만, 정리는 한곳(releaseErasedLines)에서 한다.
    const firstErasedLine = terminal.buffer.active.baseY;
    if (releaseErasedLines(session, firstErasedLine, firstErasedLine + terminal.rows - 1)) {
      notifyCommandBlocksChanged(session, sessionId);
    }
  });
}

/** 최근 순서(오래된 → 최신)로 이 세션의 명령 블록을 돌려준다. */
export function getCommandBlocks(sessionId: string): readonly TerminalCommandBlock[] {
  return sessions.get(sessionId)?.blocks ?? [];
}

/**
 * 블록이 차지하는 절대 버퍼 행 범위(둘 다 포함). 아직 실행 중이면 끝을 모르므로 endLine 은
 * null 이다. 마커가 폐기됐으면 null.
 */
export function getCommandBlockRange(
  block: TerminalCommandBlock,
): { startLine: number; endLine: number | null } | null {
  if (block.marker.line < 0) {
    return null;
  }
  return { startLine: block.marker.line, endLine: block.endLine };
}

/**
 * 주어진 절대 버퍼 행을 포함하는 블록을 찾는다(hover 판정용).
 *
 * 실행 중인 블록은 끝이 없으므로 명령 줄 이후 전부를 자기 영역으로 본다. 겹치는 후보가 있으면
 * 가장 나중(아래쪽) 블록이 이긴다 — 프롬프트가 다시 그려진 뒤의 행은 새 블록 소유다.
 */
export function getCommandBlockAtLine(
  sessionId: string,
  line: number,
): TerminalCommandBlock | null {
  return safely(sessionId, null, () => {
    const blocks = sessions.get(sessionId)?.blocks;
    if (!blocks) {
      return null;
    }
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      const start = block.marker.line;
      if (start < 0 || line < start) {
        continue;
      }
      if (block.endLine === null || line <= block.endLine) {
        return block;
      }
    }
    return null;
  });
}

/**
 * 블록의 출력 텍스트를 버퍼에서 읽는다(명령 줄 다음 행부터 출력 끝까지).
 *
 * 줄바꿈은 xterm 의 isWrapped 를 보고 판단한다 — 화면 폭에 걸려 접힌 행은 원래 한 줄이므로
 * 개행을 넣으면 안 된다(넣으면 복사한 로그가 원본과 달라진다).
 */
export function readBlockOutput(
  sessionId: string,
  terminal: Terminal,
  block: TerminalCommandBlock,
): string {
  return safely(sessionId, '', () => {
    const start = block.marker.line;
    if (start < 0) {
      return '';
    }
    const buffer = terminal.buffer.active;
    // 실행 중이면 끝을 모른다 — 커서 행까지가 지금까지의 출력이다.
    const end = block.endLine ?? buffer.baseY + buffer.cursorY;
    const lines: string[] = [];
    for (let line = start + 1; line <= end; line += 1) {
      const bufferLine = buffer.getLine(line);
      if (!bufferLine) {
        break;
      }
      const text = bufferLine.translateToString(true);
      if (bufferLine.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += text;
      } else {
        lines.push(text);
      }
    }
    // 끝쪽 빈 줄은 프롬프트 직전 여백이라 잘라낸다.
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    return lines.join('\n');
  });
}

/**
 * 이전/다음 명령 줄로 뷰포트를 이동한다. 이동했으면 true.
 *
 * 대체화면(TUI)에서는 아무것도 하지 않고 false 를 돌려준다 — 호출자가 키를 셸로 그대로
 * 흘려보내야 vim 등에서 방향키가 죽지 않는다.
 */
export function jumpToAdjacentCommandBlock(
  sessionId: string,
  terminal: Terminal,
  direction: 'previous' | 'next',
  options: { failedOnly?: boolean } = {},
): boolean {
  return safely(sessionId, false, () =>
    jumpToAdjacentCommandBlockUnsafe(sessionId, terminal, direction, options),
  );
}

function jumpToAdjacentCommandBlockUnsafe(
  sessionId: string,
  terminal: Terminal,
  direction: 'previous' | 'next',
  options: { failedOnly?: boolean },
): boolean {
  if (!isNormalBuffer(terminal)) {
    return false;
  }
  const blocks = sessions.get(sessionId)?.blocks;
  if (!blocks || blocks.length === 0) {
    return false;
  }
  // 마커는 절대 버퍼 행을 가리키고, dispose 된 마커는 -1 이다.
  const lines = blocks
    .filter((block) => !options.failedOnly || block.state === 'failed')
    .map((block) => block.marker.line)
    .filter((line) => line >= 0)
    .sort((left, right) => left - right);
  if (lines.length === 0) {
    return false;
  }
  const viewportTop = terminal.buffer.active.viewportY;
  const target =
    direction === 'previous'
      ? [...lines].reverse().find((line) => line < viewportTop)
      : lines.find((line) => line > viewportTop);
  if (target === undefined) {
    return false;
  }
  terminal.scrollToLine(target);
  return true;
}

/**
 * ConPTY 가 리사이즈 뒤 화면을 다시 그려 글자가 옮겨 갔으면, 블록과 입력 중인 프롬프트의 마커를
 * 글자가 있는 줄로 옮긴다. 옮긴 블록 수를 돌려준다.
 *
 * 왜 필요한가: Windows 로컬 셸은 ConPTY 안에서 돈다. ConPTY 는 화면 사본을 따로 들고 있다가
 * 리사이즈 때 그 사본을 다시 접어 위쪽부터 다시 그리는데, 접는 기준이 xterm 과 다르다. 한국어
 * Windows PowerShell 의 표는 줄마다 폭보다 1칸 길어(`오전/오후` 가 2칸) 접혀 있는데, ConPTY 는 그
 * 줄들을 접힘이 아닌 별개의 줄로 보낸다. 창을 넓히면 ConPTY 는 자기 사본에서 그 줄들을 펴지만
 * xterm 은 펼 것이 없다고 보고, 다시 그려진 글자만 펴진 줄 수만큼 위로 올라간다. 마커는 제자리에
 * 남는다(실측: `ls` 뒤 최대화에서 21행). xterm 의 reflow 를 고쳐서는 닿지 않으므로 다시 그려진
 * 결과를 보고 맞춘다.
 *
 * 찾는 법: 가장 최근 블록부터 거꾸로, 블록을 만들 때 적어 둔 명령 줄 텍스트와 같은 줄을 바로 다음
 * (더 최근) 블록 줄의 위에서부터 위로 찾는다. 두 블록 사이에는 이 블록의 출력만 있으므로 처음 만나는
 * 같은 줄이 이 블록이다 — 같은 명령을 연달아 쳐도 섞이지 않는다. 바로 뒤 기준(지금 프롬프트, 그다음은
 * 더 최근 블록)이 제자리였고 마커 줄이 아직 그 명령 줄이면 찾지 않고 제자리로 둔다. 실제로 밀렸을 때
 * 출력에 명령 줄과 똑같은 줄이 있으면 그 줄로 잘못 갈 수 있다. 못 찾으면 옮기지 않는다.
 *
 * 스크롤백에서 제자리가 맞는 블록을 만나면 멈춘다 — ConPTY 는 활성 화면만 다시 그리므로 그보다
 * 오래된 블록은 영향받지 않는다.
 */
export function realignCommandBlocks(sessionId: string, terminal: Terminal): number {
  return safely(sessionId, 0, () => realignCommandBlocksUnsafe(sessionId, terminal));
}

function realignCommandBlocksUnsafe(sessionId: string, terminal: Terminal): number {
  const session = sessions.get(sessionId);
  if (!session || !isNormalBuffer(terminal)) {
    return 0;
  }
  const buffer = terminal.buffer.active;
  const cursorLine = buffer.baseY + buffer.cursorY;
  // 다시 그려지며 옮겨 갈 수 있는 거리. ConPTY 는 활성 화면만 다시 그리므로 그 두 배면 넉넉하다.
  const reach = Math.max(terminal.rows, 1) * 2;

  // 블록의 명령 줄은 이 줄보다 위에 있다. 처음에는 커서 줄(지금 프롬프트)이다.
  let upperBound = cursorLine;
  // 바로 뒤 기준(지금 프롬프트, 그다음은 더 최근 블록)이 옮겨 간 거리. 모르면 null.
  let shift: number | null = null;

  // 입력 중인 프롬프트(B 는 왔고 C 는 아직)도 옮긴다. 안 옮기면 다음 명령의 블록이 엉뚱한 줄에
  // 생기고 명령 텍스트도 그 줄에서 읽는다. 지금 프롬프트는 커서 줄이거나 그 위(여러 줄 입력)이고
  // 그보다 위의 프롬프트는 다 지난 명령이므로, 커서에서 위로 처음 만나는 프롬프트가 이것이다.
  const pending = session.pendingPrompt;
  if (pending && pending.marker.line >= 0 && pending.promptText.length > 0) {
    const promptLine = findLineUpward(
      cursorLine,
      Math.max(0, cursorLine - reach),
      (line) => lineTextForMatch(buffer, line, pending.promptEndX) === pending.promptText,
    );
    if (promptLine >= 0) {
      const delta = promptLine - pending.marker.line;
      shift = delta;
      const moved = delta === 0 ? null : terminal.registerMarker(promptLine - cursorLine);
      if (moved) {
        pending.marker.dispose();
        pending.marker = moved;
        pending.continuationEndX = new Map(
          [...pending.continuationEndX].map(([line, x]) => [line + delta, x]),
        );
      }
      upperBound = promptLine;
    }
  }

  let movedCount = 0;
  for (let index = session.blocks.length - 1; index >= 0; index -= 1) {
    const block = session.blocks[index];
    const current = block.marker.line;
    const expected = block.commandLineText;
    if (current < 0 || expected === null) {
      continue;
    }
    // 바로 뒤 기준이 제자리였고 마커 줄이 아직 그 명령 줄이면 이 블록도 제자리다 — 찾지 않는다. 위로
    // 찾으면 출력 속에 명령 줄과 똑같은 줄이 있을 때 그 줄을 먼저 만나, 아무것도 밀리지 않았는데 블록이
    // 출력으로 옮겨 갔다(맞추기는 리사이즈마다 돌고 대부분은 밀리지 않은 경우다). 기준이 움직였으면
    // 이렇게 보지 않는다: 같은 명령을 연달아 쳤는데 줄이 아래로 밀리면, 마커 줄에 앞 블록의 같은 명령
    // 줄이 와 있다.
    const found =
      shift === 0 && current < upperBound && lineTextForMatch(buffer, current) === expected
        ? current
        : findLineUpward(
            Math.min(upperBound - 1, current + reach),
            Math.max(0, current - reach),
            (line) => lineTextForMatch(buffer, line) === expected,
          );
    if (found < 0) {
      continue;
    }
    shift = found - current;
    if (found === current) {
      if (current < buffer.baseY) {
        break;
      }
      upperBound = found;
      continue;
    }
    const marker = terminal.registerMarker(found - cursorLine);
    if (!marker) {
      continue;
    }
    const previous = block.marker;
    block.decoration?.dispose();
    block.decoration = null;
    if (block.endLine !== null) {
      block.endLine = Math.max(found, block.endLine + found - current);
    }
    bindBlockMarker(session, sessionId, terminal, block, marker);
    previous.dispose();
    movedCount += 1;
    upperBound = found;
  }
  if (movedCount > 0) {
    notifyCommandBlocksChanged(session, sessionId);
  }
  return movedCount;
}

/** from 부터 to 까지(둘 다 포함) 위로 올라가며 처음 맞는 줄. 없으면 -1. */
function findLineUpward(
  from: number,
  to: number,
  matches: (line: number) => boolean,
): number {
  for (let line = from; line >= to; line -= 1) {
    if (matches(line)) {
      return line;
    }
  }
  return -1;
}

/** 리사이즈 뒤 ConPTY 의 재그리기를 기다리는 시간(ms). 실측으로는 수십 ms 안에 온다. */
const CONPTY_REPAINT_WAIT_MS = 2000;
/** 재그리기가 여러 청크로 와도 한 번만 맞추도록, 마지막 출력 뒤 이만큼 조용해지면 맞춘다(ms). */
const CONPTY_REPAINT_SETTLE_MS = 50;

export interface ConptyBlockRealigner {
  /** 리사이즈를 PTY 로 보냈다 — 이어서 오는 재그리기가 끝나면 블록 위치를 맞춘다. */
  noteResize(): void;
  dispose(): void;
}

/**
 * ConPTY 세션에서 리사이즈 뒤 다시 그려진 화면이 들어오면 realignCommandBlocks 를 부른다.
 *
 * 리사이즈 직후에는 맞출 수 없다 — xterm 은 이미 자기 버퍼를 바꿨지만 ConPTY 의 재그리기는 PTY 를
 * 돌아 나중에 온다. 그래서 그 뒤 출력이 파싱될 때마다 미루다가 조용해지면 맞춘다. 기다리는 동안
 * 명령 출력이 섞여 와도 상관없다 — 같은 화면에 여러 번 맞춰도 결과가 같다.
 */
export function createConptyBlockRealigner(
  terminal: Terminal,
  getSessionId: () => string,
): ConptyBlockRealigner {
  let waitUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const subscription = safely(getSessionId(), null, () =>
    terminal.onWriteParsed(() => {
      if (Date.now() > waitUntil) {
        return;
      }
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        realignCommandBlocks(getSessionId(), terminal);
      }, CONPTY_REPAINT_SETTLE_MS);
    }),
  );
  return {
    noteResize() {
      waitUntil = Date.now() + CONPTY_REPAINT_WAIT_MS;
    },
    dispose() {
      subscription?.dispose();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** 세션 종료·재연결 시 마커와 데코레이션을 모두 정리한다. */
export function clearCommandBlocks(sessionId: string): void {
  // 세션이 끝나면 비활성화 기록도 같이 버린다 — 안 그러면 맵에 영원히 남는다.
  disabledSessions.delete(sessionId);
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  session.pendingPrompt?.marker.dispose();
  session.reportedCommand = null;
  session.insertedCommand = null;
  // 복사본을 돈다 — disposeBlock 이 marker.onDispose 를 동기로 발화시켜 원본 배열에서
  // 자신을 splice 하므로, 원본을 그대로 순회하면 한 칸씩 건너뛰어 절반이 안 지워진다.
  for (const block of [...session.blocks]) {
    disposeBlock(block);
  }
  sessions.delete(sessionId);
  // 세션이 사라졌으니 목록은 빈 것이 된다 — 보고 있던 UI 가 그대로 남지 않게 알린다.
  notifyCommandBlocksChanged(session, sessionId);
}
