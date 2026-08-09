import { describe, expect, it } from "vitest";
import {
  describeSelection,
  resolveSelectedDisplays,
  type LocalDisplay,
} from "./rdp-monitor-selection";

function display(
  id: number,
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
): LocalDisplay {
  return { id, label, bounds: { x, y, width, height } };
}

const BUILTIN = display(1, "Built-in Retina Display", 0, 0, 1512, 982);
const LG = display(2, "LG HDR 4K", 1512, 0, 3840, 2160);
const DELL = display(3, "DELL U2720Q", -2560, 0, 2560, 1440);

describe("resolveSelectedDisplays", () => {
  it("returns nothing when there is no selection", () => {
    expect(resolveSelectedDisplays([BUILTIN, LG], null)).toEqual([]);
    expect(resolveSelectedDisplays([BUILTIN, LG], [])).toEqual([]);
  });

  it("matches on display id", () => {
    const picked = resolveSelectedDisplays(
      [BUILTIN, LG, DELL],
      describeSelection([BUILTIN, LG]),
    );

    expect(picked.map((d) => d.id)).toEqual([BUILTIN.id, LG.id]);
  });

  it("falls back to label and size when the id changed", () => {
    // 재부팅·재연결이면 흔한 일이다. id 만 보면 저장한 선택이 통째로 날아간다.
    const rebooted = [
      { ...BUILTIN, id: 77 },
      { ...LG, id: 88 },
    ];

    const picked = resolveSelectedDisplays(
      rebooted,
      describeSelection([BUILTIN, LG]),
    );

    expect(picked.map((d) => d.id)).toEqual([77, 88]);
  });

  it("does not let a label match steal a display an id match needs", () => {
    // 같은 모델 두 대. LG 를 이름으로 먼저 채가면 id 가 맞는 항목이 빈손이 된다.
    const twin = display(9, "LG HDR 4K", 1512, 2160, 3840, 2160);
    const selection = [
      { id: 9, label: "LG HDR 4K", width: 3840, height: 2160 },
      { id: 2, label: "LG HDR 4K", width: 3840, height: 2160 },
    ];

    const picked = resolveSelectedDisplays([LG, twin], selection);

    expect(picked.map((d) => d.id).sort()).toEqual([2, 9]);
  });

  it("drops a display that is no longer attached", () => {
    const picked = resolveSelectedDisplays(
      [BUILTIN],
      describeSelection([BUILTIN, LG]),
    );

    expect(picked.map((d) => d.id)).toEqual([BUILTIN.id]);
  });

  it("returns nothing when the whole selection is gone", () => {
    // 호출부가 기본 동작으로 되돌리라는 신호. 아무 화면이나 골라 주면 사용자는 이유를 알 수 없다.
    expect(resolveSelectedDisplays([BUILTIN], describeSelection([LG]))).toEqual(
      [],
    );
  });

  it("orders by layout, not by the order it was saved in", () => {
    // 선언 순서가 원격의 모니터 번호가 된다. 저장 순서를 그대로 쓰면 화면을 재배치했을 때
    // 원격 번호가 뒤엉킨다.
    const picked = resolveSelectedDisplays(
      [BUILTIN, LG, DELL],
      describeSelection([LG, DELL, BUILTIN]),
    );

    expect(picked.map((d) => d.id)).toEqual([DELL.id, BUILTIN.id, LG.id]);
  });
});
