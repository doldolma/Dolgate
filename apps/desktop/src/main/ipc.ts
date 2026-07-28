import type { AuthService } from "./auth-service";
import type { AwsSsmTunnelService } from "./aws-ssm-tunnel-service";
import type { AwsService } from "./aws-service";
import type { CoreManager } from "./core-manager";
import type {
  ActivityLogRepository,
  DnsOverrideRepository,
  GroupRepository,
  HostRepository,
  KnownHostRepository,
  PortForwardRepository,
  SecretMetadataRepository,
  SettingsRepository,
  TailnetRepository,
  SnippetRepository,
  SyncOutboxRepository,
} from "./database";
import type { HostsOverrideManager } from "./hosts-override-manager";
import type { OpenSshImportService } from "./openssh-import-service";
import type { SecretStore } from "./secret-store";
import type { SessionReplayService } from "./session-replay-service";
import type { SessionShareService } from "./session-share-service";
import type { SyncService } from "./sync-service";
import type { TermiusImportService } from "./termius-import-service";
import type { UpdateService } from "./update-service";
import type { WarpgateService } from "./warpgate-service";
import type { XshellImportService } from "./xshell-import-service";
import { createMainIpcContext } from "./ipc-context-factory";
import { registerAiIpcHandlers } from "./ipc/ai";
import { registerAuthIpcHandlers } from "./ipc/auth";
import { registerAwsIpcHandlers } from "./ipc/aws";
import { registerContainersIpcHandlers } from "./ipc/containers";
import { registerHostsGroupsIpcHandlers } from "./ipc/hosts-groups";
import { registerImportIpcHandlers } from "./ipc/imports";
import { registerKnownHostsLogsKeychainIpcHandlers } from "./ipc/known-hosts-logs-keychain";
import { registerTailnetIpcHandlers } from "./ipc/tailnet";
import { registerPortForwardAndDnsIpcHandlers } from "./ipc/port-forwards-dns";
import { registerSessionShareIpcHandlers } from "./ipc/session-shares";
import { registerSnippetsIpcHandlers } from "./ipc/snippets";
import { registerSerialIpcHandlers } from "./ipc/serial";
import { registerSftpIpcHandlers } from "./ipc/sftp";
import { registerSshKeyIpcHandlers } from "./ipc/ssh-keys";
import { registerSshIpcHandlers } from "./ipc/ssh";
import { registerSyncIpcHandlers } from "./ipc/sync";
import {
  registerWindowUpdaterSettingsFilesIpcHandlers,
  type DesktopWindowIpcRuntime,
} from "./ipc/window-updater-settings-files";

export function registerIpcHandlers(
  hosts: HostRepository,
  groups: GroupRepository,
  settings: SettingsRepository,
  portForwards: PortForwardRepository,
  dnsOverrides: DnsOverrideRepository,
  snippets: SnippetRepository,
  knownHosts: KnownHostRepository,
  activityLogs: ActivityLogRepository,
  secretMetadata: SecretMetadataRepository,
  syncOutbox: SyncOutboxRepository,
  secretStore: SecretStore,
  awsService: AwsService,
  awsSsmTunnelService: AwsSsmTunnelService,
  warpgateService: WarpgateService,
  coreManager: CoreManager,
  hostsOverrideManager: HostsOverrideManager,
  updater: UpdateService,
  authService: AuthService,
  syncService: SyncService,
  termiusImportService: TermiusImportService,
  opensshImportService: OpenSshImportService,
  xshellImportService: XshellImportService,
  sessionShareService: SessionShareService,
  sessionReplayService: SessionReplayService,
  tailnets: TailnetRepository,
  windowRuntime?: DesktopWindowIpcRuntime,
): void {
  const ctx = createMainIpcContext({
    hosts,
    groups,
    settings,
    tailnets,
    portForwards,
    dnsOverrides,
    snippets,
    knownHosts,
    activityLogs,
    secretMetadata,
    syncOutbox,
    secretStore,
    awsService,
    awsSsmTunnelService,
    warpgateService,
    coreManager,
    hostsOverrideManager,
    updater,
    authService,
    syncService,
    termiusImportService,
    opensshImportService,
    xshellImportService,
    sessionShareService,
    sessionReplayService,
  });

  registerAiIpcHandlers(ctx);
  registerAuthIpcHandlers(ctx);
  registerSyncIpcHandlers(ctx);
  registerSessionShareIpcHandlers(ctx);
  registerHostsGroupsIpcHandlers(ctx);
  registerAwsIpcHandlers(ctx);
  registerImportIpcHandlers(ctx);
  registerSshIpcHandlers(ctx);
  registerSerialIpcHandlers(ctx);
  registerContainersIpcHandlers(ctx);
  registerSftpIpcHandlers(ctx);
  registerPortForwardAndDnsIpcHandlers(ctx);
  registerSnippetsIpcHandlers(ctx);
  registerKnownHostsLogsKeychainIpcHandlers(ctx);
  registerTailnetIpcHandlers(ctx);
  registerSshKeyIpcHandlers(ctx);
  registerWindowUpdaterSettingsFilesIpcHandlers(ctx, windowRuntime);
}
