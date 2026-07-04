import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SftpEndpointSummary, TransferJob } from "@shared";
import {
  createSftpServices,
  registerTerminalUploadJob,
  releaseTerminalUploadEndpoints,
  TERMINAL_UPLOAD_IDLE_TIMEOUT_MS,
} from "./sftp";
import type { SliceDeps } from "./context";

function createEndpoint(hostId: string): SftpEndpointSummary {
  return {
    id: `endpoint-${hostId}`,
    hostId,
    title: `host ${hostId}`,
    path: "/home/ubuntu",
  } as SftpEndpointSummary;
}

function createJob(id: string, status: TransferJob["status"]): TransferJob {
  return {
    id,
    sourceLabel: "local",
    targetLabel: "remote",
    itemCount: 1,
    bytesTotal: 100,
    bytesCompleted: 0,
    status,
    startedAt: new Date(0).toISOString(),
  } as TransferJob;
}

function createHarness() {
  let state: Record<string, unknown> & {
    sftp: {
      leftPane: { sourceKind: string; endpoint?: SftpEndpointSummary };
      rightPane: { sourceKind: string; endpoint?: SftpEndpointSummary };
      transfers: TransferJob[];
      terminalUploadEndpoints: Record<string, SftpEndpointSummary>;
    };
  } = {
    hosts: [],
    settings: {},
    sftp: {
      leftPane: { sourceKind: "local" },
      rightPane: { sourceKind: "local" },
      transfers: [],
      terminalUploadEndpoints: {},
    },
  };

  const get = (() => state) as unknown as SliceDeps["get"];
  const set = ((updater: unknown) => {
    const patch =
      typeof updater === "function"
        ? (updater as (current: typeof state) => Partial<typeof state>)(state)
        : (updater as Partial<typeof state>);
    state = { ...state, ...patch };
  }) as SliceDeps["set"];

  const api = {
    sftp: {
      list: vi.fn().mockResolvedValue({ path: "/home/ubuntu", entries: [] }),
      connect: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      startTransfer: vi.fn(),
      onConnectionProgress: vi.fn(() => () => undefined),
    },
  } as unknown as SliceDeps["api"];

  const services = createSftpServices({ api, set, get } as SliceDeps);
  return {
    api,
    set,
    get,
    services,
    getState: () => state,
    setTransfers: (transfers: TransferJob[]) => {
      state = { ...state, sftp: { ...state.sftp, transfers } };
    },
  };
}

describe("terminal upload endpoint idle lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("disconnects the cached endpoint after the idle timeout", async () => {
    const harness = createHarness();
    const hostId = "host-idle-basic";
    const endpoint = createEndpoint(hostId);
    (harness.api.sftp.connect as ReturnType<typeof vi.fn>).mockResolvedValue(
      endpoint,
    );

    await harness.services.ensureSftpEndpointForHost(
      harness.set,
      harness.get,
      hostId,
    );
    expect(harness.getState().sftp.terminalUploadEndpoints[hostId]).toEqual(
      endpoint,
    );

    await vi.advanceTimersByTimeAsync(TERMINAL_UPLOAD_IDLE_TIMEOUT_MS);

    expect(harness.api.sftp.disconnect).toHaveBeenCalledWith(endpoint.id);
    expect(
      harness.getState().sftp.terminalUploadEndpoints[hostId],
    ).toBeUndefined();
  });

  it("resets the idle timer when the endpoint is reused", async () => {
    const harness = createHarness();
    const hostId = "host-idle-reuse";
    const endpoint = createEndpoint(hostId);
    (harness.api.sftp.connect as ReturnType<typeof vi.fn>).mockResolvedValue(
      endpoint,
    );

    await harness.services.ensureSftpEndpointForHost(
      harness.set,
      harness.get,
      hostId,
    );

    // 만료 직전에 다시 사용하면 (캐시 히트) 타이머가 리셋되어야 한다.
    await vi.advanceTimersByTimeAsync(TERMINAL_UPLOAD_IDLE_TIMEOUT_MS - 1_000);
    await harness.services.ensureSftpEndpointForHost(
      harness.set,
      harness.get,
      hostId,
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.api.sftp.disconnect).not.toHaveBeenCalled();
    expect(harness.getState().sftp.terminalUploadEndpoints[hostId]).toEqual(
      endpoint,
    );

    await vi.advanceTimersByTimeAsync(TERMINAL_UPLOAD_IDLE_TIMEOUT_MS);
    expect(harness.api.sftp.disconnect).toHaveBeenCalledWith(endpoint.id);
  });

  it("defers disconnect while a terminal upload job is still active", async () => {
    const harness = createHarness();
    const hostId = "host-idle-active-job";
    const endpoint = createEndpoint(hostId);
    (harness.api.sftp.connect as ReturnType<typeof vi.fn>).mockResolvedValue(
      endpoint,
    );

    await harness.services.ensureSftpEndpointForHost(
      harness.set,
      harness.get,
      hostId,
    );
    registerTerminalUploadJob(hostId, "job-1");
    harness.setTransfers([createJob("job-1", "running")]);

    await vi.advanceTimersByTimeAsync(TERMINAL_UPLOAD_IDLE_TIMEOUT_MS);
    expect(harness.api.sftp.disconnect).not.toHaveBeenCalled();
    expect(harness.getState().sftp.terminalUploadEndpoints[hostId]).toEqual(
      endpoint,
    );

    harness.setTransfers([createJob("job-1", "completed")]);
    await vi.advanceTimersByTimeAsync(TERMINAL_UPLOAD_IDLE_TIMEOUT_MS);
    expect(harness.api.sftp.disconnect).toHaveBeenCalledWith(endpoint.id);
    expect(
      harness.getState().sftp.terminalUploadEndpoints[hostId],
    ).toBeUndefined();
  });

  it("releaseTerminalUploadEndpoints disconnects everything and cancels timers", async () => {
    const harness = createHarness();
    const hostId = "host-idle-release";
    const endpoint = createEndpoint(hostId);
    (harness.api.sftp.connect as ReturnType<typeof vi.fn>).mockResolvedValue(
      endpoint,
    );

    await harness.services.ensureSftpEndpointForHost(
      harness.set,
      harness.get,
      hostId,
    );

    releaseTerminalUploadEndpoints(harness.api, {
      [hostId]: endpoint,
    });
    expect(harness.api.sftp.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.api.sftp.disconnect).toHaveBeenCalledWith(endpoint.id);

    // 타이머가 해제되었으므로 시간이 더 지나도 중복 disconnect가 없어야 한다.
    await vi.advanceTimersByTimeAsync(TERMINAL_UPLOAD_IDLE_TIMEOUT_MS * 2);
    expect(harness.api.sftp.disconnect).toHaveBeenCalledTimes(1);
  });
});
