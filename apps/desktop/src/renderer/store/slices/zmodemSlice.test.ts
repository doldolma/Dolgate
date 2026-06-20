import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferJob } from "@shared";
import type { SliceDeps } from "../types";
import {
  clearZmodemAbort,
  createZmodemSlice,
  registerZmodemAbort,
} from "./zmodemSlice";

function makeJob(
  id: string,
  status: TransferJob["status"] = "running",
): TransferJob {
  return {
    id,
    sourceLabel: "host",
    targetLabel: "Downloads",
    itemCount: 1,
    bytesTotal: 10,
    bytesCompleted: 0,
    status,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createHarness() {
  let state: { zmodemTransfers: TransferJob[] } = { zmodemTransfers: [] };
  const set = ((updater: unknown) => {
    const partial =
      typeof updater === "function"
        ? (updater as (s: typeof state) => Partial<typeof state>)(state)
        : (updater as Partial<typeof state>);
    state = { ...state, ...partial };
  }) as SliceDeps["set"];
  const get = (() => state) as unknown as SliceDeps["get"];
  const slice = createZmodemSlice({ set, get, api: {} } as SliceDeps);
  return { slice, getState: () => state };
}

describe("zmodemSlice", () => {
  beforeEach(() => {
    clearZmodemAbort("job-1");
  });

  it("inserts and then updates a transfer by id", () => {
    const { slice, getState } = createHarness();
    slice.upsertZmodemTransfer(makeJob("job-1"));
    expect(getState().zmodemTransfers).toHaveLength(1);

    slice.upsertZmodemTransfer({
      ...makeJob("job-1"),
      bytesCompleted: 5,
      status: "completed",
    });
    expect(getState().zmodemTransfers).toHaveLength(1);
    expect(getState().zmodemTransfers[0].status).toBe("completed");
    expect(getState().zmodemTransfers[0].bytesCompleted).toBe(5);
  });

  it("invokes the registered abort and sets status to cancelling", () => {
    const { slice, getState } = createHarness();
    slice.upsertZmodemTransfer(makeJob("job-1", "running"));
    const abort = vi.fn();
    registerZmodemAbort("job-1", abort);

    slice.cancelZmodemTransfer("job-1");

    expect(abort).toHaveBeenCalledTimes(1);
    expect(getState().zmodemTransfers[0].status).toBe("cancelling");
  });

  it("dismisses a transfer", () => {
    const { slice, getState } = createHarness();
    slice.upsertZmodemTransfer(makeJob("job-1"));
    slice.dismissZmodemTransfer("job-1");
    expect(getState().zmodemTransfers).toHaveLength(0);
  });
});
