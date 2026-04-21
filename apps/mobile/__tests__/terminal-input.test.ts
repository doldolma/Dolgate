import {
  translateTerminalInputEventToSequence,
  type NativeTerminalInputEvent,
} from "../src/lib/terminal-input";

describe("translateTerminalInputEventToSequence", () => {
  it("translates text deltas into terminal backspace and insert payloads", () => {
    const payload = translateTerminalInputEventToSequence({
      kind: "text-delta",
      deleteCount: 1,
      insertText: "간",
    });

    expect(payload).toBe("\u007f간");
  });

  it("translates special keys into terminal control sequences", () => {
    const cases: Array<[NativeTerminalInputEvent, string]> = [
      [{ kind: "special-key", key: "escape" }, "\u001b"],
      [{ kind: "special-key", key: "tab" }, "\t"],
      [{ kind: "special-key", key: "enter" }, "\r"],
      [{ kind: "special-key", key: "arrowUp" }, "\u001b[A"],
      [{ kind: "special-key", key: "home" }, "\u001b[H"],
      [{ kind: "special-key", key: "pageDown" }, "\u001b[6~"],
      [{ kind: "special-key", key: "c", ctrl: true }, "\u0003"],
      [{ kind: "special-key", key: "d", ctrl: true }, "\u0004"],
      [{ kind: "special-key", key: "l", ctrl: true }, "\u000c"],
      [{ kind: "special-key", key: "z", ctrl: true }, "\u001a"],
    ];

    for (const [event, expected] of cases) {
      expect(translateTerminalInputEventToSequence(event)).toBe(expected);
    }
  });
});
