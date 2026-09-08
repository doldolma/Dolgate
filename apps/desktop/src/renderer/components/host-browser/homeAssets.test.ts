import { describe, expect, it } from "vitest";
import type { HostRecord, SavedWorkspaceRecord } from "@shared";
import {
  buildHomeAssets,
  orderHomeAssetKeys,
  type HomeAssetKey,
} from "./homeAssets";

function host(id: string, label = id): HostRecord {
  return { id, label, kind: "ssh", groupName: null } as unknown as HostRecord;
}

function workspace(id: string, name = id): SavedWorkspaceRecord {
  return {
    id,
    name,
    groupName: null,
    favorite: false,
  } as unknown as SavedWorkspaceRecord;
}

describe("orderHomeAssetKeys", () => {
  it("화면 순서로 정렬한다", () => {
    const visible = buildHomeAssets([workspace("w1")], [host("h1"), host("h2")]);

    expect(
      orderHomeAssetKeys(["host:h2", "host:h1", "workspace:w1"], visible),
    ).toEqual(["workspace:w1", "host:h1", "host:h2"]);
  });

  // 그룹 컨텍스트 메뉴는 화면 범위를 넘어 하위 트리 전체를 모아 넘긴다. 보이는 목록과 교집합을
  // 취하던 동안 그 키들이 조용히 사라져, 메뉴는 "3개 내보내기" 라고 세어 놓고 1개만 넘어갔다 —
  // 백업·이관이 말없이 일부만 처리하는 것은 실패보다 나쁘다.
  it("보이는 목록에 없는 키도 버리지 않고 뒤에 붙인다", () => {
    const visible = buildHomeAssets([], [host("h2")]);

    expect(
      orderHomeAssetKeys(["host:h1", "host:h2", "workspace:w9"], visible),
    ).toEqual(["host:h2", "host:h1", "workspace:w9"]);
  });

  it("아무것도 보이지 않아도 받은 키를 그대로 돌려준다", () => {
    expect(orderHomeAssetKeys(["host:h1", "workspace:w1"], [])).toEqual([
      "host:h1",
      "workspace:w1",
    ]);
  });

  it("중복된 키는 한 번만 돌려준다", () => {
    const visible = buildHomeAssets([], [host("h1")]);
    const keys: HomeAssetKey[] = ["host:h1", "host:h1", "host:h9", "host:h9"];

    expect(orderHomeAssetKeys(keys, visible)).toEqual(["host:h1", "host:h9"]);
  });
});
