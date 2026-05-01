import { describe, expect, it } from "vitest";
import { formatConnectionProgressStageLabel } from "./connection-progress";

describe("formatConnectionProgressStageLabel", () => {
  it("formats ECS loading stages", () => {
    expect(formatConnectionProgressStageLabel("loading-ecs-cluster")).toBe(
      "ECS 클러스터 조회",
    );
    expect(formatConnectionProgressStageLabel("loading-ecs-metrics")).toBe(
      "사용량 지표 조회",
    );
  });
});
