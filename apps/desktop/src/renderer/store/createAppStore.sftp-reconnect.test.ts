import { describe, expect, it } from "vitest";
import type { Mock } from "vitest";
import type { TransferJob } from "@shared";
import { createAppStore } from "./createAppStore";
import { registerTerminalUploadJob } from "./services/sftp";
import { markTerminalUploadJob } from "../lib/terminal-upload-registry";
import {
  createAwsEc2Host,
  createMockApi,
  flushMicrotasks,
} from "./createAppStore.test-support";

// 복구 체인(재수립→로컬 항목 해석→재전송)이 여러 await를 거치므로 넉넉히 settle.
async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await flushMicrotasks();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function failedConnectionLostJob(jobId: string): TransferJob {
  const item = {
    name: "Desktop",
    path: "/Users/tester/Desktop",
    isDirectory: true,
    size: 0,
  };
  return {
    id: jobId,
    sourceLabel: "Local",
    targetLabel: "Prod",
    itemCount: 1,
    bytesTotal: 12,
    bytesCompleted: 0,
    status: "failed",
    errorCode: "connection_lost",
    startedAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:01.000Z",
    failedItems: [
      { item, errorMessage: "connection lost", errorCode: "connection_lost" },
    ],
    request: {
      source: { kind: "local", path: "" },
      target: {
        kind: "remote",
        endpointId: "dead-endpoint",
        path: "/home/ubuntu",
      },
      items: [item],
      conflictResolution: "overwrite",
    },
  } as unknown as TransferJob;
}

async function setupStore(autoReconnectEnabled: boolean) {
  const api = createMockApi();
  const store = createAppStore(api);
  await store.getState().bootstrap();
  store.setState(
    (state) =>
      ({
        hosts: [...state.hosts, createAwsEc2Host()],
        settings: { ...state.settings, autoReconnectEnabled },
        sftp: {
          ...state.sftp,
          terminalUploadEndpoints: {
            "aws-host-1": {
              id: "dead-endpoint",
              hostId: "aws-host-1",
              title: "Prod",
              path: "/home/ubuntu",
            },
          },
        },
      }) as never,
  );
  return { api, store };
}

describe("SFTP terminal upload auto-recovery on connection_lost", () => {
  it("rebuilds the endpoint and re-uploads failed items against a fresh endpoint", async () => {
    const { api, store } = await setupStore(true);
    const jobId = "failed-job-recover";
    registerTerminalUploadJob("aws-host-1", jobId);
    markTerminalUploadJob(jobId);
    (api.sftp.connect as Mock).mockClear();
    (api.sftp.startTransfer as Mock).mockClear();

    store
      .getState()
      .handleTransferEvent({ job: failedConnectionLostJob(jobId) } as never);
    await settle();

    // 죽은 캐시 엔드포인트가 아니라 새 엔드포인트(새 SSM 세션)를 맺고,
    expect(api.sftp.connect).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "aws-host-1" }),
    );
    // 실패 항목을 그 새 엔드포인트로 재업로드한다.
    expect(api.sftp.startTransfer).toHaveBeenCalledTimes(1);
    const startArg = (api.sftp.startTransfer as Mock).mock.calls.at(-1)?.[0];
    expect(startArg.target.endpointId).not.toBe("dead-endpoint");
  });

  it("does nothing when auto-reconnect is disabled", async () => {
    const { api, store } = await setupStore(false);
    const jobId = "failed-job-disabled";
    registerTerminalUploadJob("aws-host-1", jobId);
    markTerminalUploadJob(jobId);
    (api.sftp.connect as Mock).mockClear();
    (api.sftp.startTransfer as Mock).mockClear();

    store
      .getState()
      .handleTransferEvent({ job: failedConnectionLostJob(jobId) } as never);
    await settle();

    expect(api.sftp.connect).not.toHaveBeenCalled();
    expect(api.sftp.startTransfer).not.toHaveBeenCalled();
  });

  it("auto-recovers a given failed job only once (no retry loop)", async () => {
    const { api, store } = await setupStore(true);
    const jobId = "failed-job-once";
    registerTerminalUploadJob("aws-host-1", jobId);
    markTerminalUploadJob(jobId);
    (api.sftp.startTransfer as Mock).mockClear();

    const event = { job: failedConnectionLostJob(jobId) } as never;
    store.getState().handleTransferEvent(event);
    await settle();
    // 같은 실패 잡의 이벤트가 다시 와도 두 번째 복구는 트리거되지 않아야 한다.
    store.getState().handleTransferEvent(event);
    await settle();

    expect(api.sftp.startTransfer).toHaveBeenCalledTimes(1);
  });
});
