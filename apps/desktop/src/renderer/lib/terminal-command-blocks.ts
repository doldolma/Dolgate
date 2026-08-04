// 셸 통합(OSC 133)으로 관측한 "명령 블록"을 세션별로 보관하는 경량 레지스트리.
//
// 터미널 렌더링은 그대로 두고 그 위에 얇은 표시만 얹는 방식이다(Warp 처럼 출력을 카드로
// 재구성하지 않는다). xterm 의 marker/decoration API 가 스크롤·스크롤백 절삭에 따른 위치
// 추적을 대신 해 주므로, 우리는 "어느 명령이 어느 행에서 시작했는지"만 기록하면 된다.
//
// store 에 두지 않는 이유는 terminal-cwd-registry 와 같다 — 컨트롤러는 refs 기반이고,
// 명령마다 전역 리렌더를 유발할 이유가 없다.

import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';

export type TerminalCommandBlockState = 'running' | 'ok' | 'failed';

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
  /** 명령 줄에 고정된 마커. 스크롤백에서 밀려나면 dispose 되고 블록도 제거된다. */
  readonly marker: IMarker;
  /** 명령이 끝난 시점의 절대 버퍼 행(출력의 끝). 완료 전에는 null. */
  endLine: number | null;
  decoration: IDecoration | null;
}

interface PendingPrompt {
  marker: IMarker;
  /** OSC 133;B 시점의 커서 X = 프롬프트가 끝나고 명령 텍스트가 시작되는 열. */
  promptEndX: number;
}

interface SessionBlocks {
  seq: number;
  pendingPrompt: PendingPrompt | null;
  blocks: TerminalCommandBlock[];
}

/** 세션당 보관할 최대 블록 수. 초과하면 오래된 것부터 버린다(메모리 상한). */
const MAX_BLOCKS_PER_SESSION = 400;
/** 명령 텍스트를 읽을 때 훑을 최대 행 수(비정상적으로 긴 입력 방어). */
const MAX_COMMAND_ROWS = 20;
/** 거터 폭(px). TerminalSessionPane 의 컨테이너 pl-[10px] 과 맞춰야 한다. */
const GUTTER_WIDTH_PX = 10;
/** 점 마커 지름(px). */
const DOT_SIZE_PX = 6;

const ACCENT_COLORS: Record<TerminalCommandBlockState, string> = {
  // 터미널 배경 위에 얹히므로 앱 테마 토큰 대신 밝기가 보장된 고정색을 쓴다.
  running: '#7aa2ff',
  // 성공은 화면이 시끄러워지지 않도록 낮은 채도로 잔잔하게.
  ok: 'rgba(122, 200, 160, 0.45)',
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
    session = { seq: 0, pendingPrompt: null, blocks: [] };
    sessions.set(sessionId, session);
  }
  return session;
}

/**
 * 대체화면(vim·htop·tmux 등)에서는 마커가 의미를 잃고 화면 복귀 시 사라지므로 기록하지 않는다.
 */
function isNormalBuffer(terminal: Terminal): boolean {
  return terminal.buffer.active.type === 'normal';
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

function disposeBlock(block: TerminalCommandBlock): void {
  block.decoration?.dispose();
  block.decoration = null;
  block.marker.dispose();
}

function removeBlock(session: SessionBlocks, block: TerminalCommandBlock): void {
  const index = session.blocks.indexOf(block);
  if (index >= 0) {
    session.blocks.splice(index, 1);
  }
}

/**
 * 버퍼의 최소 표면만 요구한다 — 라이브(xterm)와 리플레이 사전 스캔(xterm-headless)이
 * 서로 다른 Terminal 타입을 쓰지만 명령 텍스트를 읽는 방식은 같아야 하기 때문이다.
 */
export interface CommandTextBuffer {
  getLine(line: number):
    | {
        translateToString(
          trimRight: boolean,
          startColumn?: number,
          endColumn?: number,
        ): string;
        isWrapped: boolean;
        length: number;
        getCell(x: number): { getCode(): number } | undefined;
      }
    | undefined;
}

type CommandTextLine = NonNullable<ReturnType<CommandTextBuffer['getLine']>>;

/**
 * 한 행에서 "실제로 쓰인 칸"까지만 읽는다.
 *
 * translateToString(true) 는 명령에 속한 후행 공백까지 지워 접합부에서 단어를 붙여 버리고,
 * (false) 는 반대로 한 번도 쓰이지 않은 칸까지 공백으로 내보낸다. 후자가 특히 문제인 게,
 * 넓은 글자(한글·CJK·이모지)가 행 끝에 못 들어가면 xterm 이 남은 칸을 코드 0 으로 채우고
 * 다음 행으로 접는데, 그 채움 칸이 공백이 되어 "안녕하세요반 갑습니다" 처럼 없던 공백이
 * 명령 한가운데 생긴다. 사용자가 친 공백(코드 32)과 쓰인 적 없는 칸(코드 0)은 다르므로
 * 후자만 잘라낸다.
 */
function readLineText(line: CommandTextLine): string {
  let end = line.length;
  while (end > 0 && (line.getCell(end - 1)?.getCode() ?? 0) === 0) {
    end -= 1;
  }
  return line.translateToString(false, 0, end);
}

export interface CommandText {
  text: string;
  /**
   * 화면에서 읽은 값이 사용자가 실제로 친 것과 다를 수 있으면 true. 표시는 하되 재실행은
   * 막는다 — 조용히 다른 명령을 실행하는 것보다 버튼이 비활성인 편이 낫다.
   */
  unreliable: boolean;
}

/**
 * 프롬프트 라인에서 명령 텍스트를 읽어낸다. 키 입력 재구성과 달리 히스토리 호출(↑)·붙여넣기
 * 에서도 화면에 실제로 보이는 값을 그대로 얻는다.
 *
 * 화면에서 읽는 방식의 한계 두 가지를 여기서 표시한다.
 *  - 행 예산(MAX_COMMAND_ROWS)을 다 쓰면 뒤가 잘린다. 잘린 앞부분도 유효한 명령일 수 있어
 *    ("rsync … --dry-run" 에서 --dry-run 이 날아가는 식) 그대로 재실행하면 위험하다.
 *  - 접힘(isWrapped)이 아닌 새 줄은 여러 줄 입력(\ 연장·heredoc)이다. 이어 붙이면 사용자가
 *    친 적 없는 한 줄이 된다.
 *
 * RPROMPT(zsh 오른쪽 프롬프트)가 같은 행에 그려지면 명령 뒤에 섞이는데, 화면만 보고
 * 경계를 알 방법이 없어 걸러내지 못한다(VS Code 도 같은 한계).
 */
export function readCommandTextFromBuffer(
  buffer: CommandTextBuffer,
  promptLine: number,
  promptEndX: number,
  endLineExclusive: number,
): CommandText | null {
  const budgetLine = promptLine + MAX_COMMAND_ROWS;
  const lastLine = Math.min(endLineExclusive, budgetLine);
  // 예산 때문에 잘렸으면 읽은 값이 명령의 앞부분일 뿐이다.
  let unreliable = endLineExclusive > budgetLine;
  let text = '';
  for (let line = promptLine; line < lastLine; line += 1) {
    const bufferLine = buffer.getLine(line);
    if (!bufferLine) {
      break;
    }
    const raw = readLineText(bufferLine);
    if (line === promptLine) {
      text = raw.slice(promptEndX);
      continue;
    }
    if (bufferLine.isWrapped) {
      text += raw;
      continue;
    }
    // 접힘이 아닌 새 줄. 빈 줄이면 셸 훅(preexec·PS0)이 명령과 133;C 사이에 무언가를
    // 출력했다 사라진 것뿐이라 명령 자체는 온전하다 — 그걸로 재실행을 막지 않는다.
    if (raw.trim().length === 0) {
      continue;
    }
    text += `\n${raw}`;
    unreliable = true;
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? { text: trimmed, unreliable } : null;
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
    const marker = terminal.registerMarker(0);
    session.pendingPrompt = marker
      ? { marker, promptEndX: terminal.buffer.active.cursorX }
      : null;
  });
}

/**
 * OSC 133;C — 명령 실행 시작. 여기서 블록을 만들고 명령 줄에 액센트를 붙인다.
 */
export function beginCommandBlock(
  sessionId: string,
  terminal: Terminal,
  cwd: string | null,
): void {
  safely(sessionId, undefined, () => {
    beginCommandBlockUnsafe(sessionId, terminal, cwd);
  });
}

function beginCommandBlockUnsafe(
  sessionId: string,
  terminal: Terminal,
  cwd: string | null,
): void {
  if (!sessionId || !isNormalBuffer(terminal)) {
    return;
  }
  const session = getSession(sessionId);
  const pending = session.pendingPrompt;
  session.pendingPrompt = null;

  // B 를 못 받은 셸(통합이 부분 적용된 경우)에서는 현재 행을 명령 줄로 본다.
  const marker = pending?.marker ?? terminal.registerMarker(0);
  if (!marker) {
    return;
  }

  const buffer = terminal.buffer.active;
  const outputStartLine = buffer.baseY + buffer.cursorY;
  const commandText = pending
    ? readCommandTextFromBuffer(
        buffer,
        marker.line,
        pending.promptEndX,
        outputStartLine,
      )
    : null;
  session.seq += 1;
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
    endLine: null,
    decoration: null,
  };
  // 스크롤백에서 밀려나 마커가 사라지면 블록도 같이 정리한다.
  marker.onDispose(() => {
    block.decoration?.dispose();
    block.decoration = null;
    removeBlock(session, block);
  });
  attachDecoration(terminal, block);

  session.blocks.push(block);
  while (session.blocks.length > MAX_BLOCKS_PER_SESSION) {
    const oldest = session.blocks.shift();
    if (oldest) {
      disposeBlock(oldest);
    }
  }
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
  for (let index = session.blocks.length - 1; index >= 0; index -= 1) {
    const block = session.blocks[index];
    if (block.state !== 'running') {
      continue;
    }
    block.state = exitCode === null || exitCode === 0 ? 'ok' : 'failed';
    block.exitCode = exitCode;
    block.durationMs = Date.now() - block.startedAt;
    // 출력 끝 행은 UI 로는 안 쓰지만(점은 명령 줄에만 찍는다) "출력 복사·블록 선택" 같은
    // 후속 기능에 필요한 범위 정보라 기록해 둔다.
    block.endLine = terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
    if (block.decoration?.element) {
      applyDecorationStyle(block, block.decoration.element);
    }
    return;
  }
}

/** 최근 순서(오래된 → 최신)로 이 세션의 명령 블록을 돌려준다. */
export function getCommandBlocks(sessionId: string): readonly TerminalCommandBlock[] {
  return sessions.get(sessionId)?.blocks ?? [];
}

/**
 * 블록이 차지하는 절대 버퍼 행 범위. 아직 실행 중이면 끝을 모르므로 endLine 은 null 이다.
 * 마커가 폐기됐으면 null.
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
    const end = block.endLine ?? buffer.baseY + buffer.cursorY;
    const lines: string[] = [];
    for (let line = start + 1; line < end; line += 1) {
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

/** 세션 종료·재연결 시 마커와 데코레이션을 모두 정리한다. */
export function clearCommandBlocks(sessionId: string): void {
  // 세션이 끝나면 비활성화 기록도 같이 버린다 — 안 그러면 맵에 영원히 남는다.
  disabledSessions.delete(sessionId);
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  session.pendingPrompt?.marker.dispose();
  // 복사본을 돈다 — disposeBlock 이 marker.onDispose 를 동기로 발화시켜 원본 배열에서
  // 자신을 splice 하므로, 원본을 그대로 순회하면 한 칸씩 건너뛰어 절반이 안 지워진다.
  for (const block of [...session.blocks]) {
    disposeBlock(block);
  }
  sessions.delete(sessionId);
}
