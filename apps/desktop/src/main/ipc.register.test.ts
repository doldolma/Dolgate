import { beforeEach, describe, expect, it, vi } from "vitest";

const moduleSpies = vi.hoisted(() => ({
  auth: vi.fn(),
  sync: vi.fn(),
  sessionShares: vi.fn(),
  hostsGroups: vi.fn(),
  aws: vi.fn(),
  imports: vi.fn(),
  ssh: vi.fn(),
  containers: vi.fn(),
  sftp: vi.fn(),
  portForwardsDns: vi.fn(),
  knownHostsLogsKeychain: vi.fn(),
  windowUpdaterSettingsFiles: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    fromWebContents: vi.fn(() => null),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

vi.mock("./ipc/auth", () => ({
  registerAuthIpcHandlers: moduleSpies.auth,
}));
vi.mock("./ipc/sync", () => ({
  registerSyncIpcHandlers: moduleSpies.sync,
}));
vi.mock("./ipc/session-shares", () => ({
  registerSessionShareIpcHandlers: moduleSpies.sessionShares,
}));
vi.mock("./ipc/hosts-groups", () => ({
  registerHostsGroupsIpcHandlers: moduleSpies.hostsGroups,
}));
vi.mock("./ipc/aws", () => ({
  registerAwsIpcHandlers: moduleSpies.aws,
}));
vi.mock("./ipc/imports", () => ({
  registerImportIpcHandlers: moduleSpies.imports,
}));
vi.mock("./ipc/ssh", () => ({
  registerSshIpcHandlers: moduleSpies.ssh,
}));
vi.mock("./ipc/containers", () => ({
  registerContainersIpcHandlers: moduleSpies.containers,
}));
vi.mock("./ipc/sftp", () => ({
  registerSftpIpcHandlers: moduleSpies.sftp,
}));
vi.mock("./ipc/port-forwards-dns", () => ({
  registerPortForwardAndDnsIpcHandlers: moduleSpies.portForwardsDns,
}));
vi.mock("./ipc/known-hosts-logs-keychain", () => ({
  registerKnownHostsLogsKeychainIpcHandlers:
    moduleSpies.knownHostsLogsKeychain,
}));
vi.mock("./ipc/window-updater-settings-files", () => ({
  registerWindowUpdaterSettingsFilesIpcHandlers:
    moduleSpies.windowUpdaterSettingsFiles,
}));

import { registerIpcHandlers } from "./ipc";

function createDependencySet() {
  const coreManager = {
    setTerminalEventHandler: vi.fn(),
    setPortForwardEventHandler: vi.fn(),
    setTerminalStreamHandler: vi.fn(),
    listPortForwardRuntimes: vi.fn(() => []),
  };

  return {
    hosts: {} as any,
    groups: {} as any,
    settings: {} as any,
    portForwards: {} as any,
    dnsOverrides: {} as any,
    knownHosts: {} as any,
    activityLogs: {} as any,
    secretMetadata: {} as any,
    syncOutbox: {} as any,
    secretStore: {} as any,
    awsService: {} as any,
    awsSsmTunnelService: {} as any,
    warpgateService: {} as any,
    coreManager,
    hostsOverrideManager: {} as any,
    updater: {} as any,
    authService: {} as any,
    syncService: {} as any,
    termiusImportService: {} as any,
    opensshImportService: {} as any,
    xshellImportService: {} as any,
    sessionShareService: {} as any,
    sessionReplayService: {} as any,
  };
}

describe("registerIpcHandlers", () => {
  beforeEach(() => {
    Object.values(moduleSpies).forEach((spy) => spy.mockReset());
  });

  it("builds the IPC composition root by delegating to every feature module", () => {
    const deps = createDependencySet();

    registerIpcHandlers(
      deps.hosts,
      deps.groups,
      deps.settings,
      deps.portForwards,
      deps.dnsOverrides,
      deps.knownHosts,
      deps.activityLogs,
      deps.secretMetadata,
      deps.syncOutbox,
      deps.secretStore,
      deps.awsService,
      deps.awsSsmTunnelService,
      deps.warpgateService,
      deps.coreManager as any,
      deps.hostsOverrideManager,
      deps.updater,
      deps.authService,
      deps.syncService,
      deps.termiusImportService,
      deps.opensshImportService,
      deps.xshellImportService,
      deps.sessionShareService,
      deps.sessionReplayService,
    );

    expect(deps.coreManager.setTerminalEventHandler).toHaveBeenCalledTimes(1);
    expect(deps.coreManager.setPortForwardEventHandler).toHaveBeenCalledTimes(1);
    expect(deps.coreManager.setTerminalStreamHandler).toHaveBeenCalledTimes(1);

    expect(moduleSpies.auth).toHaveBeenCalledTimes(1);
    expect(moduleSpies.sync).toHaveBeenCalledTimes(1);
    expect(moduleSpies.sessionShares).toHaveBeenCalledTimes(1);
    expect(moduleSpies.hostsGroups).toHaveBeenCalledTimes(1);
    expect(moduleSpies.aws).toHaveBeenCalledTimes(1);
    expect(moduleSpies.imports).toHaveBeenCalledTimes(1);
    expect(moduleSpies.ssh).toHaveBeenCalledTimes(1);
    expect(moduleSpies.containers).toHaveBeenCalledTimes(1);
    expect(moduleSpies.sftp).toHaveBeenCalledTimes(1);
    expect(moduleSpies.portForwardsDns).toHaveBeenCalledTimes(1);
    expect(moduleSpies.knownHostsLogsKeychain).toHaveBeenCalledTimes(1);
    expect(moduleSpies.windowUpdaterSettingsFiles).toHaveBeenCalledTimes(1);
  });
});

