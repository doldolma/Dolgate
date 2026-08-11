import { afterEach, describe, expect, it } from "vitest";
import {
  isRdpKeyboardCaptureFocused,
  rdpKeyboardCaptureAttributes,
} from "./rdp-keyboard-focus";

afterEach(() => {
  document.body.innerHTML = "";
});

/** 캔버스가 실제로 붙이는 속성 그대로 요소를 만든다 — 속성 이름이 갈리면 여기서 걸린다. */
function mountCaptureSurface(): HTMLElement {
  const surface = document.createElement("canvas");
  for (const [name, value] of Object.entries(rdpKeyboardCaptureAttributes)) {
    surface.setAttribute(name, value);
  }
  surface.tabIndex = 0;
  document.body.append(surface);
  return surface;
}

describe("isRdpKeyboardCaptureFocused", () => {
  it("원격 화면에 포커스가 있으면 참", () => {
    mountCaptureSurface().focus();

    expect(isRdpKeyboardCaptureFocused()).toBe(true);
  });

  it("다른 곳에 포커스가 있으면 거짓", () => {
    // 터미널·입력창에 있는 동안에는 우리 단축키가 살아 있어야 한다.
    mountCaptureSurface();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    expect(isRdpKeyboardCaptureFocused()).toBe(false);
  });

  it("포커스가 아무 데도 없으면 거짓", () => {
    mountCaptureSurface();

    expect(isRdpKeyboardCaptureFocused()).toBe(false);
  });

  it("원격 화면 안쪽 요소에 포커스가 있어도 참", () => {
    // 지금 캔버스는 자식이 없지만, 나중에 오버레이를 안에 넣어도 판정이 유지돼야 한다.
    const surface = mountCaptureSurface();
    const inner = document.createElement("button");
    surface.append(inner);
    inner.focus();

    expect(isRdpKeyboardCaptureFocused()).toBe(true);
  });
});
