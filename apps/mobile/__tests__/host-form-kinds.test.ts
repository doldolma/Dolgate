import {
  HOST_FORM_KINDS,
  resolveCreatableHostFormKinds,
} from "../src/lib/host-form-kinds";

describe("resolveCreatableHostFormKinds", () => {
  it("수준을 판정하지 못하는 서버에서는 SSH 만 열어 둔다", () => {
    // 못 막는 서버에서 RDP 를 만들면 같은 계정의 옛 기기가 그 레코드를 받고 조용히 망가진다.
    const resolved = resolveCreatableHostFormKinds({
      serverSupportsDataFloor: false,
    });
    expect(resolved).toEqual([
      { kind: "ssh", disabled: false },
      { kind: "rdp", disabled: true },
      { kind: "vnc", disabled: true },
    ]);
  });

  it("판정하는 서버에서는 전부 열린다", () => {
    expect(
      resolveCreatableHostFormKinds({ serverSupportsDataFloor: true }).every(
        entry => !entry.disabled,
      ),
    ).toBe(true);
  });

  it("종류를 늘려도 기본은 막힌 쪽이다", () => {
    // 이름으로 판정하지 않기 때문에, 새 종류를 넣고 이 함수를 잊어도 보호가 남는다.
    const known = new Set(HOST_FORM_KINDS);
    expect(known.has("ssh")).toBe(true);
    for (const entry of resolveCreatableHostFormKinds({
      serverSupportsDataFloor: false,
    })) {
      if (entry.kind !== "ssh") {
        expect(entry.disabled).toBe(true);
      }
    }
  });
});
