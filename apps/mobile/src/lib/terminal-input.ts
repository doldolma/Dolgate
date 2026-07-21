export type TerminalSpecialKey =
  | "escape"
  | "tab"
  | "enter"
  | "backspace"
  | "delete"
  | "arrowUp"
  | "arrowDown"
  | "arrowLeft"
  | "arrowRight"
  | "home"
  | "end"
  | "pageUp"
  | "pageDown"
  | "c"
  | "d"
  | "l"
  | "z";

export type NativeTerminalInputEvent =
  | {
      kind: "text-delta";
      deleteCount: number;
      insertText: string;
    }
  | {
      kind: "special-key";
      key: TerminalSpecialKey;
      ctrl?: boolean;
    };

const TERMINAL_BACKSPACE = "\u007f";

// xterm.js가 원격의 터미널 질의(DA/DSR/OSC 색상 등)에 자동 생성하는 응답 시퀀스들.
// 질의를 보낸 프로세스(vi 등)가 이미 종료됐으면 응답이 셸 프롬프트에 명령어처럼 꽂히고,
// 셸이 이를 에코하면 xterm이 자기 DA 응답(ESC[>0;276;0c)을 새 질의로 재해석해 또 응답
// → 무한 핑퐁이 된다. 세션 히스토리 리플레이가 과거 질의를 재생할 때도 같은 문제가
// 나므로, 터미널의 자동 응답은 SSH 로 보내기 전에 전부 걸러낸다. 사용자 키 입력(화살표
// ESC[A, 펑션키 ESC[15~, SGR 마우스 ESC[<...M, bracketed paste)은 패턴이 달라 걸리지
// 않는다. 부작용: 원격 앱이 터미널 기능 질의 응답을 못 받는데, vim 등은 짧은 타임아웃
// 후 정상 진행한다.
const TERMINAL_QUERY_REPLY_PATTERN = new RegExp(
  [
    "\\u001b\\[\\??\\d+(?:;\\d+)*R", // CPR/DECXCPR 커서 위치 응답
    "\\u001b\\[\\?\\d+(?:;\\d+)*c", // DA1 응답
    "\\u001b\\[>\\d+(?:;\\d+)*c", // DA2 응답 (xterm 버전)
    "\\u001b\\[\\d+n", // DSR 상태 응답
    "\\u001b\\]\\d+;[^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)", // OSC 응답 (rgb: 색상 등)
    "\\u001bP[\\s\\S]*?\\u001b\\\\", // DCS 응답 (XTGETTCAP/DECRQSS)
  ].join("|"),
  "g",
);

// 터미널(xterm)이 만들어낸 질의 응답 시퀀스를 제거한다. 위 패턴 주석 참고.
export function stripTerminalQueryReplies(value: string): string {
  if (!value.includes("\u001b")) {
    return value;
  }
  return value.replace(TERMINAL_QUERY_REPLY_PATTERN, "");
}

const TERMINAL_SPECIAL_KEY_SEQUENCES: Record<TerminalSpecialKey, string> = {
  escape: "\u001b",
  tab: "\t",
  enter: "\r",
  backspace: TERMINAL_BACKSPACE,
  delete: "\u001b[3~",
  arrowUp: "\u001b[A",
  arrowDown: "\u001b[B",
  arrowLeft: "\u001b[D",
  arrowRight: "\u001b[C",
  // home/end 는 모드 무관 VT220 시퀀스 — ESC[H/ESC[F 는 커서키 애플리케이션
  // 모드(DECCKM, vi 등이 켬)에서 인식되지 않는다.
  home: "\u001b[1~",
  end: "\u001b[4~",
  pageUp: "\u001b[5~",
  pageDown: "\u001b[6~",
  c: "c",
  d: "d",
  l: "l",
  z: "z",
};

const TERMINAL_CTRL_SEQUENCES: Partial<Record<TerminalSpecialKey, string>> = {
  c: "\u0003",
  d: "\u0004",
  l: "\u000c",
  z: "\u001a",
};

export function translateTerminalInputEventToSequence(
  event: NativeTerminalInputEvent,
): string {
  if (event.kind === "text-delta") {
    return `${TERMINAL_BACKSPACE.repeat(event.deleteCount)}${event.insertText}`;
  }

  if (event.ctrl) {
    return TERMINAL_CTRL_SEQUENCES[event.key] ?? "";
  }

  return TERMINAL_SPECIAL_KEY_SEQUENCES[event.key] ?? "";
}

export type TerminalShortcutItem = {
  label: string;
  event: NativeTerminalInputEvent;
};

function createTextShortcut(
  label: string,
  insertText: string,
): TerminalShortcutItem {
  return {
    label,
    event: {
      kind: "text-delta",
      deleteCount: 0,
      insertText,
    } satisfies NativeTerminalInputEvent,
  };
}

export const TERMINAL_PRIMARY_SHORTCUTS: readonly TerminalShortcutItem[] = [
  {
    label: "ESC",
    event: { kind: "special-key", key: "escape" } satisfies NativeTerminalInputEvent,
  },
  {
    label: "TAB",
    event: { kind: "special-key", key: "tab" } satisfies NativeTerminalInputEvent,
  },
  {
    label: "Ctrl+C",
    event: {
      kind: "special-key",
      key: "c",
      ctrl: true,
    } satisfies NativeTerminalInputEvent,
  },
  {
    label: "Left",
    event: {
      kind: "special-key",
      key: "arrowLeft",
    } satisfies NativeTerminalInputEvent,
  },
  {
    label: "Right",
    event: {
      kind: "special-key",
      key: "arrowRight",
    } satisfies NativeTerminalInputEvent,
  },
  {
    label: "Up",
    event: {
      kind: "special-key",
      key: "arrowUp",
    } satisfies NativeTerminalInputEvent,
  },
  {
    label: "Down",
    event: {
      kind: "special-key",
      key: "arrowDown",
    } satisfies NativeTerminalInputEvent,
  },
  {
    label: "Enter",
    event: {
      kind: "special-key",
      key: "enter",
    } satisfies NativeTerminalInputEvent,
  },
];

export const TERMINAL_SECONDARY_SHORTCUTS: readonly TerminalShortcutItem[] = [
  {
    label: "Backspace",
    event: {
      kind: "special-key",
      key: "backspace",
    } satisfies NativeTerminalInputEvent,
  },
  {
    label: "Delete",
    event: {
      kind: "special-key",
      key: "delete",
    } satisfies NativeTerminalInputEvent,
  },
  {
    label: "Home",
    event: {
      kind: "special-key",
      key: "home",
    } satisfies NativeTerminalInputEvent,
  },
  {
    label: "End",
    event: {
      kind: "special-key",
      key: "end",
    } satisfies NativeTerminalInputEvent,
  },
  {
    label: "PageUp",
    event: {
      kind: "special-key",
      key: "pageUp",
    } satisfies NativeTerminalInputEvent,
  },
  {
    label: "PageDown",
    event: {
      kind: "special-key",
      key: "pageDown",
    } satisfies NativeTerminalInputEvent,
  },
  createTextShortcut(":", ":"),
  createTextShortcut("!", "!"),
  createTextShortcut("/", "/"),
  createTextShortcut("?", "?"),
  {
    label: "Ctrl+D",
    event: {
      kind: "special-key",
      key: "d",
      ctrl: true,
    } satisfies NativeTerminalInputEvent,
  },
  {
    label: "Ctrl+L",
    event: {
      kind: "special-key",
      key: "l",
      ctrl: true,
    } satisfies NativeTerminalInputEvent,
  },
  {
    label: "Ctrl+Z",
    event: {
      kind: "special-key",
      key: "z",
      ctrl: true,
    } satisfies NativeTerminalInputEvent,
  },
] as const;
