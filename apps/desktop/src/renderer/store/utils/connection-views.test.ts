import { describe, expect, it } from "vitest";
import {
  CONNECTION_VIEW_LIMIT,
  clearConnectionView,
  updateConnectionView,
  upsertConnectionHop,
} from "./connection-views";
import type { ConnectionView } from "../types";

function hop(index: number, stage: "connecting" | "connected" | "failed") {
  return { index, count: 2, label: `hop-${index}`, stage };
}

describe("연결 진행 뷰", () => {
  it("같은 홉이 다시 오면 갈아 끼운다", () => {
    const first = upsertConnectionHop(undefined, hop(1, "connecting"));
    const done = upsertConnectionHop(first, hop(1, "connected"));

    expect(done).toHaveLength(1);
    expect(done[0]?.stage).toBe("connected");
  });

  // 재시도는 1 번 홉의 connecting 으로 시작한다. 앞 시도의 홉을 남기면 실패한 경로가 그대로
  // 붙어 있어서 "어디까지 갔나" 를 잘못 읽게 된다.
  it("새 시도가 시작되면 앞 시도의 홉을 버린다", () => {
    const previous = [hop(1, "connected"), hop(2, "failed")];
    const restarted = upsertConnectionHop(previous, hop(1, "connecting"));

    expect(restarted).toHaveLength(1);
    expect(restarted[0]?.stage).toBe("connecting");
  });

  it("없던 열쇠는 만들고, 있던 것은 부분 갱신한다", () => {
    const created = updateConnectionView({}, "rule-1", { stage: "connecting" });
    expect(created["rule-1"]).toMatchObject({
      key: "rule-1",
      status: "connecting",
      stage: "connecting",
    });

    const updated = updateConnectionView(created, "rule-1", { status: "error" });
    expect(updated["rule-1"]).toMatchObject({
      status: "error",
      // 앞서 넣은 값은 남아야 한다 — 부분 갱신이다.
      stage: "connecting",
    });
  });

  it("끝난 연결은 지운다", () => {
    const views = updateConnectionView({}, "rule-1", {});
    expect(clearConnectionView(views, "rule-1")).toEqual({});
    // 없는 것을 지워도 같은 객체를 돌려준다(불필요한 렌더를 만들지 않는다).
    expect(clearConnectionView(views, "nope")).toBe(views);
  });

  // 끝을 알리는 이벤트 없이 사라지는 실패가 있다(코어가 죽는 경우). 그것이 누적되면 오래 켜 둔
  // 앱에서 메모리가 계속 는다.
  it("뷰가 무한히 쌓이지 않는다", () => {
    let views: Record<string, ConnectionView> = {};
    for (let index = 0; index < CONNECTION_VIEW_LIMIT + 10; index += 1) {
      views = updateConnectionView(views, `rule-${index}`, {});
    }
    expect(Object.keys(views)).toHaveLength(CONNECTION_VIEW_LIMIT);
    // 최근 것이 남아야 한다.
    expect(views[`rule-${CONNECTION_VIEW_LIMIT + 9}`]).toBeDefined();
  });
});
