// 재생 스냅샷이 SerializeAddon 만으로는 잃는 터미널 상태를 읽어, 스냅샷 뒤에 덧붙일 이스케이프로 만든다.
//
// SerializeAddon(0.13)은 화면 글자와 모드 몇 개만 쓴다. 스크롤 영역(DECSTBM)·커서 숨김·문자셋(G0~G3)·
// 저장 커서(DECSC)·탭 위치는 쓰지 않아서, 스냅샷에서 이어 그리면 그 뒤 출력이 원래와 다르게 그려졌다(실측:
// tmux 상태줄이 사라지고, 선 문자가 `lqqk` 로, 저장 커서 복원 위치가 틀어짐).
//
// 이 값들은 xterm 공개 API 에 없어 내부에서 읽는다(xterm 5.5.0 으로 고정). 하나라도 못 읽으면 null 을
// 돌려주고, 부르는 쪽은 그 스냅샷을 뜨지 않는다 — 앞 스냅샷이나 처음부터 그려 예전처럼 맞는다.

import { Terminal } from '@xterm/headless';

/** xterm 내부의 글자 속성(AttributeData). 쓰는 메서드만 적는다. */
interface AttributeDataLike {
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
  getFgColorMode(): number;
  getBgColorMode(): number;
  getFgColor(): number;
  getBgColor(): number;
  hasExtendedAttrs(): number;
  getUnderlineStyle(): number;
  getUnderlineColorMode(): number;
  getUnderlineColor(): number;
  isUnderlineColorDefault(): boolean;
}

interface TerminalInternals {
  buffer: {
    x: number;
    y: number;
    ybase: number;
    scrollTop: number;
    scrollBottom: number;
    tabs: Record<number, boolean>;
    savedX: number;
    savedY: number;
    savedCurAttrData: AttributeDataLike;
    savedCharset: unknown;
  };
  coreService: {
    isCursorHidden: boolean;
    decPrivateModes: { origin: boolean };
  };
  inputHandler: {
    parserState: number;
    utf8Pending: number;
    curAttrData: AttributeDataLike;
    charsets: unknown[];
    glevel: number;
  };
}

// AttributeData 의 색 모드(xterm Attributes.CM_*).
const COLOR_MODE_P16 = 0x1000000;
const COLOR_MODE_P256 = 0x2000000;
const COLOR_MODE_RGB = 0x3000000;
/** 파서가 쉬는 상태(ParserState.GROUND). */
const PARSER_GROUND = 0;
/** xterm 이 아는 문자셋 지정 문자. 같은 문자셋을 가리키는 문자가 여럿이면 처음 것을 쓴다. */
const CHARSET_DESIGNATORS = ['B', '0', 'A', '4', 'C', '5', 'R', 'Q', 'K', 'Y', 'E', '6', 'Z', 'H', '7', '='];

function readInternals(terminal: Terminal): TerminalInternals | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const core = (terminal as any)._core;
    const buffer = core?.buffer;
    const coreService = core?.coreService;
    const inputHandler = core?._inputHandler;
    const charsetService = inputHandler?._charsetService;
    const parser = inputHandler?._parser;
    const utf8Decoder = inputHandler?._utf8Decoder;
    if (
      !buffer ||
      typeof buffer.scrollTop !== 'number' ||
      typeof buffer.scrollBottom !== 'number' ||
      typeof buffer.savedX !== 'number' ||
      typeof buffer.savedY !== 'number' ||
      !buffer.savedCurAttrData ||
      !buffer.tabs ||
      typeof coreService?.isCursorHidden !== 'boolean' ||
      typeof coreService?.decPrivateModes?.origin !== 'boolean' ||
      !Array.isArray(charsetService?._charsets) ||
      typeof charsetService?.glevel !== 'number' ||
      typeof parser?.currentState !== 'number' ||
      !utf8Decoder?.interim ||
      !inputHandler?._curAttrData
    ) {
      return null;
    }
    return {
      buffer,
      coreService,
      inputHandler: {
        parserState: parser.currentState,
        utf8Pending: utf8Decoder.interim[0],
        curAttrData: inputHandler._curAttrData,
        charsets: charsetService._charsets,
        glevel: charsetService.glevel,
      },
    };
  } catch {
    return null;
  }
}

/**
 * 스냅샷을 떠도 되는 경계인가. 이스케이프나 UTF-8 글자 중간이면 다음 구간이 그 나머지로 시작해 글자로
 * 찍힌다(실측: `가m나다`). 줄 끝에서 줄바꿈을 기다리는 커서(x === cols)는 덧붙이는 커서 이동이 그 상태를
 * 지운다. 못 읽으면 false.
 */
export function isAtRestBoundary(terminal: Terminal): boolean {
  const internals = readInternals(terminal);
  return (
    internals !== null &&
    internals.inputHandler.parserState === PARSER_GROUND &&
    internals.inputHandler.utf8Pending === 0 &&
    internals.buffer.x < terminal.cols
  );
}

/** 문자셋 객체 → 지정 문자. 빈 터미널에 지정해 보며 만든다(내부 상수 표를 가져오지 않는다). */
export type CharsetDesignators = ReadonlyMap<unknown, string>;

export async function buildCharsetDesignators(): Promise<CharsetDesignators | null> {
  const probe = new Terminal({ allowProposedApi: true });
  try {
    const designators = new Map<unknown, string>();
    for (const designator of CHARSET_DESIGNATORS) {
      await new Promise<void>((resolve) => probe.write(`\x1b(${designator}`, resolve));
      const internals = readInternals(probe);
      if (!internals) {
        return null;
      }
      const charset = internals.inputHandler.charsets[0] ?? null;
      if (!designators.has(charset)) {
        designators.set(charset, designator);
      }
    }
    // 아무것도 지정하지 않은 자리(undefined)는 US 와 같다.
    designators.set(undefined, 'B');
    return designators;
  } finally {
    probe.dispose();
  }
}

function colorParams(mode: number, color: number, base: 30 | 40): string[] {
  switch (mode) {
    case COLOR_MODE_P16:
      return [String(color < 8 ? base + color : base + 60 + color - 8)];
    case COLOR_MODE_P256:
      return [String(base + 8), '5', String(color)];
    case COLOR_MODE_RGB:
      return [String(base + 8), '2', String((color >> 16) & 0xff), String((color >> 8) & 0xff), String(color & 0xff)];
    default:
      return [];
  }
}

/** 글자 속성을 처음부터(0) 다시 거는 SGR. */
function sgrOf(attr: AttributeDataLike): string {
  const params = ['0'];
  if (attr.isBold()) params.push('1');
  if (attr.isDim()) params.push('2');
  if (attr.isItalic()) params.push('3');
  if (attr.isUnderline()) {
    const style = attr.hasExtendedAttrs() ? attr.getUnderlineStyle() : 1;
    params.push(style > 1 ? `4:${style}` : '4');
  }
  if (attr.isBlink()) params.push('5');
  if (attr.isInverse()) params.push('7');
  if (attr.isInvisible()) params.push('8');
  if (attr.isStrikethrough()) params.push('9');
  if (attr.isOverline()) params.push('53');
  params.push(...colorParams(attr.getFgColorMode(), attr.getFgColor(), 30));
  params.push(...colorParams(attr.getBgColorMode(), attr.getBgColor(), 40));
  if (attr.hasExtendedAttrs() && !attr.isUnderlineColorDefault()) {
    const color = attr.getUnderlineColor();
    if (attr.getUnderlineColorMode() === COLOR_MODE_RGB) {
      params.push(`58:2::${(color >> 16) & 0xff}:${(color >> 8) & 0xff}:${color & 0xff}`);
    } else {
      params.push(`58:5:${color}`);
    }
  }
  return `\x1b[${params.join(';')}m`;
}

/**
 * SerializeAddon 결과 뒤에 덧붙일 이스케이프. 지금 화면의 버퍼(일반·대체 가운데 보이는 쪽) 상태를 되살린다.
 * 못 읽으면 null.
 */
export function serializeHiddenState(
  terminal: Terminal,
  designators: CharsetDesignators,
): string | null {
  const internals = readInternals(terminal);
  if (!internals) {
    return null;
  }
  const { buffer, coreService, inputHandler } = internals;
  const cols = terminal.cols;
  const rows = terminal.rows;
  const designatorOf = (charset: unknown) => designators.get(charset ?? undefined);

  // 아래 커서 이동은 모두 화면 기준으로 한다. 원점 모드는 마지막에 건다.
  let out = '\x1b[?6l';

  // 1) 탭 위치. 기본(tabStopWidth 마다)과 다를 때만.
  const width = terminal.options.tabStopWidth ?? 8;
  const tabs = Object.keys(buffer.tabs)
    .map(Number)
    .filter((column) => buffer.tabs[column] && column < cols)
    .sort((left, right) => left - right);
  const defaults: number[] = [];
  for (let column = 0; column < cols; column += width) {
    defaults.push(column);
  }
  if (tabs.join() !== defaults.join()) {
    out += '\x1b[3g';
    for (const column of tabs) {
      out += `\x1b[${column + 1}G\x1bH`;
    }
  }

  // 2) 저장 커서(DECSC): 그 자리·펜·문자셋으로 맞춘 뒤 저장한다. 저장한 줄은 버퍼 전체 기준이라 화면
  // 기준으로 바꾼다(스크롤백으로 밀려났으면 맨 위).
  const savedDesignator = designatorOf(buffer.savedCharset);
  if (savedDesignator === undefined) {
    return null;
  }
  const savedRow = Math.min(rows - 1, Math.max(0, buffer.savedY - buffer.ybase));
  const savedColumn = Math.min(cols - 1, Math.max(0, buffer.savedX));
  out += `\x1b[${savedRow + 1};${savedColumn + 1}H${sgrOf(buffer.savedCurAttrData)}\x1b(${savedDesignator}\x0f\x1b7`;

  // 3) 스크롤 영역.
  if (buffer.scrollTop !== 0 || buffer.scrollBottom !== rows - 1) {
    out += `\x1b[${buffer.scrollTop + 1};${buffer.scrollBottom + 1}r`;
  }

  // 4) 원점 모드, 커서 숨김.
  const origin = coreService.decPrivateModes.origin;
  if (origin) {
    out += '\x1b[?6h';
  }
  if (coreService.isCursorHidden) {
    out += '\x1b[?25l';
  }

  // 5) 문자셋 G0~G3 와 지금 쓰는 쪽(SI·SO·LS2·LS3).
  const charsetDesignators = [0, 1, 2, 3].map((index) => designatorOf(inputHandler.charsets[index]));
  if (charsetDesignators.some((designator) => designator === undefined)) {
    return null;
  }
  out += `\x1b(${charsetDesignators[0]}\x1b)${charsetDesignators[1]}\x1b*${charsetDesignators[2]}\x1b+${charsetDesignators[3]}`;
  out += ['\x0f', '\x0e', '\x1bn', '\x1bo'][inputHandler.glevel] ?? '\x0f';

  // 6) 지금 펜. 2)에서 바꿨으므로 되돌린다.
  out += sgrOf(inputHandler.curAttrData);

  // 7) 커서 자리. 원점 모드면 스크롤 영역 기준이다.
  const row = origin ? buffer.y - buffer.scrollTop : buffer.y;
  out += `\x1b[${row + 1};${Math.min(buffer.x, cols - 1) + 1}H`;
  return out;
}
