import { afterEach, describe, expect, it } from "vitest";
import { rdpViewportSize } from "./rdp-viewport";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("rdpViewportSize", () => {
  it("measures the area the remote screen will fill", () => {
    // 접속할 때 이 크기로 붙어야 화면이 뜨는 순간부터 창에 맞는다. 캔버스가 붙은 뒤에 크기를
    // 요청하면 그때까지 어긋난 화면이 보인다.
    const area = document.createElement("div");
    area.dataset.rdpViewport = "";
    area.getBoundingClientRect = () =>
      ({ width: 1440, height: 856 }) as DOMRect;
    document.body.append(area);

    expect(rdpViewportSize()).toEqual({ width: 1440, height: 856 });
  });

  it("gives nothing when the area is not on screen yet", () => {
    // 잴 수 없으면 메인이 창 크기로 대신한다. 0 을 보내면 원격이 그 크기로 붙어 버린다.
    const area = document.createElement("div");
    area.dataset.rdpViewport = "";
    area.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    document.body.append(area);

    expect(rdpViewportSize()).toBeUndefined();
  });

  it("gives nothing when the marker is missing", () => {
    // 표식이 사라지면 조용히 창 크기로 돌아가고, 화면이 다시 창에 안 맞게 된다. 이 테스트가
    // 그때 알려 준다.
    expect(rdpViewportSize()).toBeUndefined();
  });
});
