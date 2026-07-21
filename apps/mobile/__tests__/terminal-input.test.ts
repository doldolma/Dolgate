import {
  stripTerminalQueryReplies,
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

  it("passes punctuation text shortcuts through unchanged", () => {
    const cases: Array<[string, string]> = [
      [":", ":"],
      ["!", "!"],
      ["/", "/"],
      ["?", "?"],
    ];

    for (const [insertText, expected] of cases) {
      expect(
        translateTerminalInputEventToSequence({
          kind: "text-delta",
          deleteCount: 0,
          insertText,
        }),
      ).toBe(expected);
    }
  });

  it("translates special keys into terminal control sequences", () => {
    const cases: Array<[NativeTerminalInputEvent, string]> = [
      [{ kind: "special-key", key: "escape" }, "\u001b"],
      [{ kind: "special-key", key: "tab" }, "\t"],
      [{ kind: "special-key", key: "enter" }, "\r"],
      [{ kind: "special-key", key: "arrowUp" }, "\u001b[A"],
      [{ kind: "special-key", key: "home" }, "\u001b[1~"],
      [{ kind: "special-key", key: "end" }, "\u001b[4~"],
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

describe("stripTerminalQueryReplies", () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const ST = `${ESC}${String.fromCharCode(0x5c)}`;

  it("removes terminal-generated query replies", () => {
    const cases: Array<[string, string]> = [
      [`${ESC}[>0;276;0c`, ""], // DA2 (xterm 버전)
      [`${ESC}[?1;2c`, ""], // DA1
      [`${ESC}[24;80R`, ""], // CPR
      [`${ESC}[?24;80;1R`, ""], // DECXCPR
      [`${ESC}[0n`, ""], // DSR ok
      [`${ESC}]11;rgb:fefe/fefe/ffff${ST}`, ""], // OSC 배경색 (ST 종단)
      [`${ESC}]10;rgb:0000/0000/0000${BEL}`, ""], // OSC 전경색 (BEL 종단)
      [`${ESC}P1+r626365${ST}`, ""], // DCS (XTGETTCAP)
      [`${ESC}[>0;276;0cls -al`, "ls -al"], // 응답+사용자 입력 혼합
      [`pwd${ESC}[2;1R${ESC}]11;rgb:aaaa/bbbb/cccc${BEL}`, "pwd"],
    ];

    for (const [input, expected] of cases) {
      expect(stripTerminalQueryReplies(input)).toBe(expected);
    }
  });

  it("keeps user input sequences untouched", () => {
    const cases = [
      "ls -al\r",
      "\u0003", // Ctrl+C
      `${ESC}[A`, // 화살표 위
      `${ESC}[15~`, // F5
      `${ESC}[<0;10;10M`, // SGR 마우스
      `${ESC}[200~pasted text${ESC}[201~`, // bracketed paste
      "한글 입력",
    ];

    for (const input of cases) {
      expect(stripTerminalQueryReplies(input)).toBe(input);
    }
  });
});
