import { describe, expect, it, vi } from "vitest";
import type {
  DesktopApi,
  HostContainerLogsSnapshot,
  HostDraft,
  HostRecord,
} from "@shared";
import { DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS, isSshHostRecord } from "@shared";
import type { HostContainersTabState } from "./createAppStore";
import { createAppStore, upsertTransferJob } from "./createAppStore";
import {
  createAwsEc2Host,
  createContainerDetails,
  createContainerSummary,
  createContainerTab,
  createDeferred,
  createEcsHost,
  createMockApi,
  createUntrustedHostProbe,
  flushMicrotasks,
} from "./createAppStore.test-support";

describe("upsertTransferJob", () => {
  it("keeps an existing transfer in place when progress updates arrive", () => {
    const olderJob = {
      id: "job-1",
      status: "running",
      sourceLabel: "Local",
      targetLabel: "nas",
      activeItemName: "older.bin",
      bytesCompleted: 10,
      bytesTotal: 100,
      startedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:01.000Z",
      speedBytesPerSecond: 100,
      etaSeconds: 1,
    } as const;
    const newerJob = {
      id: "job-2",
      status: "running",
      sourceLabel: "Local",
      targetLabel: "nas",
      activeItemName: "newer.bin",
      bytesCompleted: 20,
      bytesTotal: 100,
      startedAt: "2025-01-01T00:00:10.000Z",
      updatedAt: "2025-01-01T00:00:11.000Z",
      speedBytesPerSecond: 100,
      etaSeconds: 1,
    } as const;

    const transfers = upsertTransferJob([], olderJob as never);
    const orderedTransfers = upsertTransferJob(transfers, newerJob as never);
    const updatedOlderJob = {
      ...olderJob,
      bytesCompleted: 80,
      updatedAt: "2025-01-01T00:00:20.000Z",
    };

    const nextTransfers = upsertTransferJob(
      orderedTransfers,
      updatedOlderJob as never,
    );

    expect(nextTransfers.map((job) => job.id)).toEqual(["job-2", "job-1"]);
    expect(nextTransfers[1]).toMatchObject({ id: "job-1", bytesCompleted: 80 });
  });

  it("removes a dismissed transfer card by id", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();

    store.getState().handleTransferEvent({
      job: {
        id: "job-1",
        sourceLabel: "Local",
        targetLabel: "nas",
        itemCount: 1,
        bytesTotal: 100,
        bytesCompleted: 100,
        status: "completed",
        startedAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:10.000Z",
      },
    });
    store.getState().handleTransferEvent({
      job: {
        id: "job-2",
        sourceLabel: "Local",
        targetLabel: "nas",
        itemCount: 1,
        bytesTotal: 200,
        bytesCompleted: 100,
        status: "running",
        startedAt: "2025-01-01T00:00:20.000Z",
        updatedAt: "2025-01-01T00:00:21.000Z",
      },
    });

    store.getState().dismissTransfer("job-1");

    expect(store.getState().sftp.transfers.map((job) => job.id)).toEqual([
      "job-2",
    ]);
  });

  it("marks running transfers as cancelling immediately when cancel is requested", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.getState().handleTransferEvent({
      job: {
        id: "job-1",
        sourceLabel: "Local",
        targetLabel: "nas",
        itemCount: 1,
        bytesTotal: 100,
        bytesCompleted: 40,
        status: "running",
        startedAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:10.000Z",
        etaSeconds: 3,
      },
    });

    await store.getState().cancelTransfer("job-1");

    expect(api.sftp.cancelTransfer).toHaveBeenCalledWith("job-1");
    expect(store.getState().sftp.transfers[0]).toMatchObject({
      id: "job-1",
      status: "cancelling",
      etaSeconds: null,
    });
  });

  it("pauses and resumes running transfers optimistically", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.getState().handleTransferEvent({
      job: {
        id: "job-1",
        sourceLabel: "Local",
        targetLabel: "nas",
        itemCount: 1,
        bytesTotal: 100,
        bytesCompleted: 40,
        status: "running",
        startedAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:10.000Z",
        etaSeconds: 3,
      },
    });

    await store.getState().pauseTransfer("job-1");

    expect(api.sftp.pauseTransfer).toHaveBeenCalledWith("job-1");
    expect(store.getState().sftp.transfers[0]).toMatchObject({
      id: "job-1",
      status: "paused",
      etaSeconds: null,
    });

    await store.getState().resumeTransfer("job-1");

    expect(api.sftp.resumeTransfer).toHaveBeenCalledWith("job-1");
    expect(store.getState().sftp.transfers[0]).toMatchObject({
      id: "job-1",
      status: "running",
    });
  });

  it("retries only failed transfer items when failed item details are available", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.getState().handleTransferEvent({
      job: {
        id: "job-1",
        sourceLabel: "Local",
        targetLabel: "nas",
        itemCount: 2,
        bytesTotal: 100,
        bytesCompleted: 50,
        status: "failed",
        startedAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:10.000Z",
        request: {
          source: { kind: "local", path: "/source" },
          target: { kind: "remote", endpointId: "endpoint-1", path: "/target" },
          items: [
            { name: "ok.txt", path: "/source/ok.txt", isDirectory: false, size: 2 },
            { name: "bad.txt", path: "/source/bad.txt", isDirectory: false, size: 3 },
          ],
          conflictResolution: "overwrite",
        },
        failedItems: [
          {
            item: { name: "bad.txt", path: "/source/bad.txt", isDirectory: false, size: 3 },
            errorMessage: "permission denied",
            errorCode: "permission_denied",
          },
        ],
      },
    });

    await store.getState().retryTransfer("job-1");

    expect(api.sftp.startTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        retryOfJobId: "job-1",
        items: [
          { name: "bad.txt", path: "/source/bad.txt", isDirectory: false, size: 3 },
        ],
      }),
    );
  });
});
