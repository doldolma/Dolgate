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
  home: "\u001b[H",
  end: "\u001b[F",
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
