// 프롬프트 줄에서 명령 텍스트를 읽는 규칙. 라이브 터미널(terminal-command-blocks)과 녹화 훑기
// (replay-command-scan — 화면의 재생 창과 메인의 팀 녹화 훑기)가 같은 규칙을 쓴다.

/** 명령 텍스트를 읽을 때 훑을 최대 행 수(비정상적으로 긴 입력 방어). */
const MAX_COMMAND_ROWS = 20;

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
function readLineText(line: CommandTextLine, startColumn = 0): string {
  let end = line.length;
  while (end > 0 && (line.getCell(end - 1)?.getCode() ?? 0) === 0) {
    end -= 1;
  }
  if (startColumn >= end) {
    return '';
  }
  return line.translateToString(false, startColumn, end);
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
  /** 이어지는 줄의 텍스트 시작 열(셸이 알려 준 PS2 폭). 없으면 그 줄은 믿을 수 없다고 본다. */
  continuationEndX?: ReadonlyMap<number, number>,
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
      // **열 번호로 문자열을 자르면 안 된다.** 넓은 글자(한글·CJK·이모지)는 2칸을 쓰지만
      // 문자열에서는 1글자라, 한글이 든 프롬프트에서는 두 값이 어긋난다 — `~/문서$ ` 프롬프트
      // 뒤의 `docker ps` 가 `cker ps` 로 읽혔다. 자르는 일은 열을 아는 xterm 에게 맡긴다.
      text = readLineText(bufferLine, promptEndX);
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
    // 셸이 이 줄의 프롬프트 폭을 알려줬으면 그만큼 잘라낸다 — 오염이 없으니 믿을 수 있다.
    const continuationStart = continuationEndX?.get(line);
    if (continuationStart !== undefined) {
      text += `\n${readLineText(bufferLine, continuationStart)}`;
      continue;
    }
    text += `\n${raw}`;
    unreliable = true;
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? { text: trimmed, unreliable } : null;
}

/**
 * OSC 133;E 의 이스케이프를 되돌린다(셸이 역슬래시를 두 배로 만든 뒤 개행을 `\\n` 으로 바꿔 보낸다).
 */
export function unescapeReportedCommand(escaped: string): string {
  let out = '';
  for (let index = 0; index < escaped.length; index += 1) {
    const char = escaped[index];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = escaped[index + 1];
    if (next === 'n') {
      out += '\n';
      index += 1;
    } else if (next === '\\') {
      out += '\\';
      index += 1;
    } else {
      // 우리가 만들지 않은 조합은 그대로 둔다 — 해석하려 들면 원문이 바뀐다.
      out += char;
    }
  }
  return out;
}
