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

export const TERMINAL_SHORTCUTS = [
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
    label: "Enter",
    event: {
      kind: "special-key",
      key: "enter",
    } satisfies NativeTerminalInputEvent,
  },
] as const;
