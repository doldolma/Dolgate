import type { AuthService } from "./auth-service";
import type { AwsSsmTunnelService } from "./aws-ssm-tunnel-service";
import type { AwsService } from "./aws-service";
import type { CoreManager } from "./core-manager";
import type { RdpManager } from "./rdp-manager";
import type { VncManager } from "./vnc-manager";
import type {
  ActivityLogRepository,
  AwsProfileRepository,
  DnsOverrideRepository,
  GroupRepository,
  HostRepository,
  KnownHostRepository,
  PortForwardRepository,
  SecretMetadataRepository,
  SettingsRepository,
  TailnetRepository,
  SnippetRepository,
  SavedWorkspaceRepository,
  SyncOutboxRepository,
} from "./database";
import type { HostsOverrideManager } from "./hosts-override-manager";
import type { OpenSshImportService } from "./openssh-import-service";
import type { SecretStore } from "./secret-store";
import type { SessionReplayService } from "./session-replay-service";
import type { SessionShareService } from "./session-share-service";
import type { SyncService } from "./sync-service";
import { TeamService } from "./team-service";
import type { TeamSyncService } from "./team-sync-service";
import { resolveLogTeamId, type TeamHistoryService } from "./team-history-service";
import { TeamRestoreService } from "./team-restore-service";
import { logMessage } from "./activity-log-message";
import { TeamApi } from "./team-api";
import { PERSONAL_VAULT_ID } from "./vault-root";
import { createStoredTeamVaults } from "./team-vault-scope";
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
import { registerLogsExportIpcHandlers } from "./ipc/logs-export";
import { registerTailnetIpcHandlers } from "./ipc/tailnet";
import { registerPortForwardAndDnsIpcHandlers } from "./ipc/port-forwards-dns";
import { registerSessionShareIpcHandlers } from "./ipc/session-shares";
import { registerSnippetsIpcHandlers } from "./ipc/snippets";
import { registerSavedWorkspacesIpcHandlers } from "./ipc/saved-workspaces";
import { registerSerialIpcHandlers } from "./ipc/serial";
import { createCertificatePromptBridge, registerRdpIpcHandlers } from "./ipc/rdp";
import { registerVncIpcHandlers } from "./ipc/vnc";
import { registerSftpIpcHandlers } from "./ipc/sftp";
import { registerSshKeyIpcHandlers } from "./ipc/ssh-keys";
import { registerSshIpcHandlers } from "./ipc/ssh";
import { registerSyncIpcHandlers } from "./ipc/sync";
import { registerTeamsIpcHandlers } from "./ipc/teams";
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
  savedWorkspaces: SavedWorkspaceRepository,
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
  rdpManager: RdpManager,
  vncManager: VncManager,
  awsProfiles: AwsProfileRepository,
  teamSync: TeamSyncService,
  windowRuntime?: DesktopWindowIpcRuntime,
  teamHistory?: TeamHistoryService,
): void {
  const baseCtx = createMainIpcContext({
    hosts,
    groups,
    settings,
    tailnets,
    portForwards,
    dnsOverrides,
    snippets,
    savedWorkspaces,
    knownHosts,
    activityLogs,
    secretMetadata,
    syncOutbox,
    awsProfiles,
    teamVaults: createStoredTeamVaults(),
    teamSync,
    teams: new TeamService({ auth: authService, teamSync }),
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
  // 팀 볼트 복원 — 이전 판을 팀 키로 풀어 묶어 보이고, 되살린 것은 보통 올리기로 올린다. 기록은 팀 기록에도 간다.
  const teamRestore = new TeamRestoreService({
    api: new TeamApi(authService),
    openTeamAccess: (teamId) => teamSync.openTeamAccess(teamId),
    writeTime: (teamId, records) => teamSync.writeTimeAfterServer(teamId, records),
    onRestored: async (teamId, outcome) => {
      baseCtx.activityLogs.append(
        "info",
        "audit",
        logMessage("teams.restored", { count: outcome.restored.length + outcome.dependencies.length }),
        {
          vaultId: teamId,
          restored: outcome.restored.length,
          dependencies: outcome.dependencies.length,
          skipped: outcome.skipped.length,
        },
      );
      // 팀 볼트만 바뀌었다 — 그 팀에 올리고 기다린다(실패해도 던지지 않는다. 남은 것은 다음 올리기가 가져간다).
      await teamSync.pushDirty();
    },
  });
  // 팀 기록은 기록의 볼트를 여기서 만든 카탈로그로 찾는다.
  const ctx = { ...baseCtx, teamHistory, teamRestore };
  teamHistory?.setTeamResolver((metadata) => resolveLogTeamId(ctx.vaults, metadata));
  // 팀 호스트 세션의 녹화는 그 팀으로도 간다(team-replay-uploads).
  sessionReplayService.setTeamOfHost((hostId) => {
    const vaultId = ctx.vaults.scopeOfHost(hostId).id;
    return vaultId === PERSONAL_VAULT_ID ? null : vaultId;
  });
  // 다이얼 직전 마지막 확인 — 기다리는 사이 팀에서 빠진(지운) 호스트에는 붙지 않는다(core-manager 의 assertHostStillPresent).
  coreManager.setHostPresence((hostId) => Boolean(ctx.vaults.getHost(hostId)));

  registerAiIpcHandlers(ctx);
  registerAuthIpcHandlers(ctx);
  registerSyncIpcHandlers(ctx);
  registerTeamsIpcHandlers(ctx);
  registerSessionShareIpcHandlers(ctx);
  registerHostsGroupsIpcHandlers(ctx);
  registerAwsIpcHandlers(ctx);
  registerImportIpcHandlers(ctx);
  registerSshIpcHandlers(ctx);
  registerSerialIpcHandlers(ctx);
  // 프롬프트는 렌더러가 띄우고 응답을 되돌려 준다. 그 왕복을 rdpManager 의 이벤트 채널
  // 위에 얹어, RDP 관련 신호가 한 경로로만 흐르게 한다.
  const certificatePrompts = createCertificatePromptBridge((event) =>
    rdpManager.emitSessionEvent(event),
  );
  registerRdpIpcHandlers(ctx, rdpManager, {
    askCertificate: certificatePrompts.ask,
    cancelCertificate: certificatePrompts.cancel,
  });
  registerVncIpcHandlers(ctx, vncManager);
  registerContainersIpcHandlers(ctx);
  registerSftpIpcHandlers(ctx);
  registerPortForwardAndDnsIpcHandlers(ctx);
  registerSnippetsIpcHandlers(ctx);
  registerSavedWorkspacesIpcHandlers(ctx);
  registerKnownHostsLogsKeychainIpcHandlers(ctx);
  registerLogsExportIpcHandlers(ctx);
  registerTailnetIpcHandlers(ctx);
  registerSshKeyIpcHandlers(ctx);
  registerWindowUpdaterSettingsFilesIpcHandlers(ctx, windowRuntime);
}
