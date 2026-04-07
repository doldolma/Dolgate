import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../common/ipc-channels";
import { registerAwsIpcHandlers } from "./aws";

const electronSpies = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: electronSpies.ipcMainHandle,
  },
}));

describe("registerAwsIpcHandlers", () => {
  beforeEach(() => {
    electronSpies.ipcMainHandle.mockReset();
  });

  it("records an awsProfiles tombstone when deleting a managed AWS profile", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const getProfileDetails = vi.fn().mockResolvedValue({
      id: "profile-default",
      profileName: "default",
    });
    const deleteProfile = vi.fn().mockResolvedValue(undefined);
    const upsertDeletion = vi.fn();
    const queueSync = vi.fn();

    registerAwsIpcHandlers({
      awsService: {
        listProfiles: vi.fn(),
        listExternalProfiles: vi.fn(),
        createProfile: vi.fn(),
        prepareSsoProfile: vi.fn(),
        getProfileDetails,
        getExternalProfileDetails: vi.fn(),
        importExternalProfiles: vi.fn(),
        updateProfile: vi.fn(),
        renameProfile: vi.fn(),
        deleteProfile,
        getProfileStatus: vi.fn(),
        login: vi.fn(),
        listRegions: vi.fn(),
        listEc2Instances: vi.fn(),
        listEcsClusters: vi.fn(),
        resolveManagedProfileNameOrFallback: vi.fn(),
        describeEcsClusterSnapshot: vi.fn(),
        describeEcsClusterUtilization: vi.fn(),
        describeEcsServiceActionContext: vi.fn(),
        loadEcsServiceLogs: vi.fn(),
        openEcsExecShell: vi.fn(),
        inspectHostSshMetadata: vi.fn(),
      },
      syncOutbox: {
        upsertDeletion,
      },
      queueSync,
      hosts: {
        backfillAwsProfileReferences: vi.fn(() => []),
        getById: vi.fn(),
      },
      assertAwsEcsHost: vi.fn(),
      coreManager: {
        connectAwsSession: vi.fn(),
      },
    } as any);

    const handler = handlers.get(ipcChannels.aws.deleteProfile);
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("expected aws.deleteProfile handler to be registered");
    }

    await handler({}, "default");

    expect(getProfileDetails).toHaveBeenCalledWith("default");
    expect(deleteProfile).toHaveBeenCalledWith("default");
    expect(upsertDeletion).toHaveBeenCalledWith("awsProfiles", "profile-default");
    expect(queueSync).toHaveBeenCalledTimes(1);
  });
});
