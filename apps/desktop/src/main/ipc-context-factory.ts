import type { AuthService } from "./auth-service";
import type { AwsSsmTunnelService } from "./aws-ssm-tunnel-service";
import type { AwsService } from "./aws-service";
import type { CoreManager } from "./core-manager";
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
import { LocalFileService } from "./file-service";
import type { HostsOverrideManager } from "./hosts-override-manager";
import type { OpenSshImportService } from "./openssh-import-service";
import { PortForwardLifecycleLogger } from "./port-forward-lifecycle-logger";
import type { SecretStore } from "./secret-store";
import type { SessionReplayService } from "./session-replay-service";
import type { SessionShareService } from "./session-share-service";
import type { SyncService } from "./sync-service";
import type { TeamService } from "./team-service";
import type { TeamSyncService } from "./team-sync-service";
import type { TermiusImportService } from "./termius-import-service";
import type { UpdateService } from "./update-service";
import {
  createVaultCatalog,
  pickVaultRepositories,
  type TeamVaultSource,
} from "./vault-catalog";
import type { WarpgateService } from "./warpgate-service";
import type { XshellImportService } from "./xshell-import-service";
import type { AwsConnectionProgressEmitter, MainIpcContext } from "./ipc/context";
import { createAwsSftpCoordinator } from "./ipc/coordinators/aws-sftp-coordinator";
import { createContainerRuntimeCoordinator } from "./ipc/coordinators/container-runtime-coordinator";
import { createCoreEventBridge } from "./ipc/coordinators/core-event-bridge";
import { createDnsPortForwardCoordinator } from "./ipc/coordinators/dns-port-forward-coordinator";
import { createHostCoordinator } from "./ipc/coordinators/host-coordinator";
import { createSecretCoordinator } from "./ipc/coordinators/secret-coordinator";
import { createSnapshotCoordinator } from "./ipc/coordinators/snapshot-coordinator";
import { createSshKeyCoordinator } from "./ipc/coordinators/ssh-key-coordinator";
import { createTunnelRegistry } from "./ipc/coordinators/tunnel-registry";
import { AiService } from "./ai-service";
import { buildAiToolHelpers } from "./ai/host-exec-helpers";

export interface RegisterIpcDependencies {
  hosts: HostRepository;
  groups: GroupRepository;
  settings: SettingsRepository;
  tailnets: TailnetRepository;
  portForwards: PortForwardRepository;
  dnsOverrides: DnsOverrideRepository;
  snippets: SnippetRepository;
  savedWorkspaces: SavedWorkspaceRepository;
  knownHosts: KnownHostRepository;
  activityLogs: ActivityLogRepository;
  secretMetadata: SecretMetadataRepository;
  syncOutbox: SyncOutboxRepository;
  awsProfiles: AwsProfileRepository;
  /** 이 기기의 팀 볼트들. 없으면 개인 볼트만 본다(시험). */
  teamVaults?: TeamVaultSource;
  teamSync: TeamSyncService;
  teams: TeamService;
  secretStore: SecretStore;
  awsService: AwsService;
  awsSsmTunnelService: AwsSsmTunnelService;
  warpgateService: WarpgateService;
  coreManager: CoreManager;
  hostsOverrideManager: HostsOverrideManager;
  updater: UpdateService;
  authService: AuthService;
  syncService: SyncService;
  termiusImportService: TermiusImportService;
  opensshImportService: OpenSshImportService;
  xshellImportService: XshellImportService;
  sessionShareService: SessionShareService;
  sessionReplayService: SessionReplayService;
}

export function createMainIpcContext(
  deps: RegisterIpcDependencies,
): MainIpcContext {
  const {
    hosts,
    groups,
    settings,
    portForwards,
    dnsOverrides,
    snippets,
    savedWorkspaces,
    knownHosts,
    activityLogs,
    secretMetadata,
    syncOutbox,
    teamVaults,
    teamSync,
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
  } = deps;

  const vaults = createVaultCatalog(
    pickVaultRepositories(deps, secretStore),
    teamVaults,
  );
  const localFiles = new LocalFileService();
  const aiService = new AiService(
    settings,
    secretStore,
    buildAiToolHelpers({ coreManager, hosts, activityLogs }),
  );
  const queueSync = () => {
    void syncService.pushDirty().catch(() => undefined);
    // 팀 볼트에 쓴 것(팀 호스트 편집·팀 호스트의 내 즐겨찾기 등)은 그 팀으로 올린다.
    void teamSync.pushDirty();
  };
  const portForwardLifecycleLogger = new PortForwardLifecycleLogger(
    activityLogs,
    portForwards,
    vaults,
  );

  const secretCoordinator = createSecretCoordinator({
    secretStore,
    secretMetadata,
    hosts,
    vaults,
    activityLogs,
    queueSync,
    inspectCertificate: (certificateText) =>
      coreManager.inspectCertificate(certificateText),
  });
  const tunnelRegistry = createTunnelRegistry({ awsSsmTunnelService });
  const dnsPortForwardCoordinator = createDnsPortForwardCoordinator({
    vaults,
    coreManager,
    hostsOverrideManager,
  });

  let emitSftpConnectionProgress: AwsConnectionProgressEmitter = () => undefined;
  const awsSftpCoordinator = createAwsSftpCoordinator({
    hosts,
    vaults,
    awsService,
    queueSync,
    emitSftpConnectionProgress: (event) => emitSftpConnectionProgress(event),
    isLocalOnly: () => authService.getState().status === "local-only",
  });
  coreManager.setSsmPortForwardTokenIssuer(awsService.ssmPortForwardTokenIssuer);
  const coreEventBridge = createCoreEventBridge({
    coreManager,
    sessionShareService,
    sessionReplayService,
    portForwardLifecycleLogger,
    secretCoordinator,
    tunnelRegistry,
    awsSftpCoordinator,
  });
  emitSftpConnectionProgress = coreEventBridge.emitSftpConnectionProgress;

  const hostCoordinator = createHostCoordinator({
    vaults,
    coreManager,
    awsService,
    authService,
    awsSsmTunnelService,
    awsSftpCoordinator,
    resolveSshAuth: secretCoordinator.resolveSshAuth,
    ensureCertificateAuthReady: secretCoordinator.ensureCertificateAuthReady,
  });

  const containerRuntimeCoordinator = createContainerRuntimeCoordinator({
    coreManager,
    awsService,
    authService,
    awsSsmTunnelService,
    awsSftpCoordinator,
    tunnelRegistry,
    secretCoordinator,
    hostCoordinator,
    resolveJumpHostTarget: hostCoordinator.resolveJumpHostTarget,
    emitContainersConnectionProgress:
      coreEventBridge.emitContainersConnectionProgress,
  });
  const snapshotCoordinator = createSnapshotCoordinator({
    vaults,
    groups,
    settings,
    knownHosts,
    activityLogs,
    secretMetadata,
    coreManager,
    localFiles,
    dnsPortForwardCoordinator,
  });
  const sshKeyCoordinator = createSshKeyCoordinator({
    hosts,
    vaults,
    persistSecret: secretCoordinator.persistSecret,
    loadSecrets: secretCoordinator.loadSecrets,
    resolveTrustedHostKeys: hostCoordinator.resolveTrustedHostKeys,
    resolveTailnetRoute: hostCoordinator.resolveTailnetRoute,
    resolveSshAuth: secretCoordinator.resolveSshAuth,
    resolveJumpHostTarget: hostCoordinator.resolveJumpHostTarget,
    ensureCertificateAuthReady: secretCoordinator.ensureCertificateAuthReady,
    generatePrivateKey: (payload) => coreManager.generatePrivateKey(payload),
    inspectPrivateKey: (privateKeyPem, passphrase) =>
      coreManager.inspectPrivateKey(privateKeyPem, passphrase),
    // 인자를 줄여 감싸지 말 것 — 타입 검사가 못 잡고, 상관 ID 가 사라지면 코어는 인증을
    // 시도조차 하지 않는다("responder is not configured"). 실제로 그렇게 깨졌다.
    installAuthorizedKey: (payload, correlationId) =>
      coreManager.installAuthorizedKey(payload, correlationId),
    queueSync,
  });

  return {
    ...deps,
    vaults,
    resolveJumpHostTarget: hostCoordinator.resolveJumpHostTarget,
    localFiles,
    aiService,
    portForwardLifecycleLogger,
    queueSync,
    getInitialBootstrapSnapshot:
      snapshotCoordinator.getInitialBootstrapSnapshot,
    getSyncedWorkspaceSnapshot: snapshotCoordinator.getSyncedWorkspaceSnapshot,
    listPortForwardSnapshot: dnsPortForwardCoordinator.listPortForwardSnapshot,
    listResolvedDnsOverrides:
      dnsPortForwardCoordinator.listResolvedDnsOverrides,
    emitSftpConnectionProgress: coreEventBridge.emitSftpConnectionProgress,
    emitSftpConnectionFailureProgress:
      awsSftpCoordinator.emitConnectionFailureProgress,
    emitContainersConnectionProgress:
      coreEventBridge.emitContainersConnectionProgress,
    pendingSessionSecrets: coreEventBridge.pendingSessionSecrets,
    trackAwsSftpTunnelRuntime: tunnelRegistry.trackSftpTunnelRuntime,
    trackAwsContainerShellTunnelRuntime:
      tunnelRegistry.trackContainerShellTunnelRuntime,
    stopAwsSftpTunnelForEndpoint: tunnelRegistry.stopSftpTunnelForEndpoint,
    buildContainersEndpointId:
      containerRuntimeCoordinator.buildContainersEndpointId,
    buildContainerPortForwardEndpointId:
      containerRuntimeCoordinator.buildContainerPortForwardEndpointId,
    stopAwsContainersTunnelForEndpoint:
      tunnelRegistry.stopContainersTunnelForEndpoint,
    moveAwsContainersTunnelRuntime: tunnelRegistry.moveContainersTunnelRuntime,
    stopAwsContainerShellTunnelForSession:
      tunnelRegistry.stopContainerShellTunnelForSession,
    storeAwsSftpPreflight: awsSftpCoordinator.storePreflight,
    clearAwsSftpPreflight: awsSftpCoordinator.clearPreflight,
    consumeAwsSftpPreflight: awsSftpCoordinator.consumePreflight,
    rewriteActiveDnsOverrides:
      dnsPortForwardCoordinator.rewriteActiveDnsOverrides,
    stopPortForwardWithDnsOverrideCleanup:
      dnsPortForwardCoordinator.stopPortForwardWithDnsOverrideCleanup,
    persistHostSpecificSecret: secretCoordinator.persistHostSpecificSecret,
    resolveAwsSftpPreflight: awsSftpCoordinator.resolvePreflight,
    ensureContainersEndpoint: containerRuntimeCoordinator.ensureContainersEndpoint,
    startContainerTunnelRuntime:
      containerRuntimeCoordinator.startContainerTunnelRuntime,
    resolveWindowFromSender: coreEventBridge.resolveWindowFromSender,
    buildWindowState: coreEventBridge.buildWindowState,
    emitWorkspaceChanged: coreEventBridge.emitWorkspaceChanged,
    persistSecret: secretCoordinator.persistSecret,
    persistImportedSecret: secretCoordinator.persistImportedSecret,
    loadSecrets: secretCoordinator.loadSecrets,
    loadHostSecrets: secretCoordinator.loadHostSecrets,
    hasSecretValue: secretCoordinator.hasSecretValue,
    mergeSecrets: secretCoordinator.mergeSecrets,
    resolveSshAuth: secretCoordinator.resolveSshAuth,
    resolveManagedPrivateKeyPem: secretCoordinator.resolveManagedPrivateKeyPem,
    resolveManagedCertificateText:
      secretCoordinator.resolveManagedCertificateText,
    inspectCertificate: secretCoordinator.inspectCertificate,
    generateSshKey: sshKeyCoordinator.generateSshKey,
    resolveSshPublicKey: sshKeyCoordinator.resolveSshPublicKey,
    installSshPublicKey: sshKeyCoordinator.installSshPublicKey,
    inspectStoredCertificate: secretCoordinator.inspectStoredCertificate,
    ensureCertificateAuthReady: secretCoordinator.ensureCertificateAuthReady,
    requireTrustedHostKey: hostCoordinator.requireTrustedHostKey,
    requireTrustedHostKeys: hostCoordinator.requireTrustedHostKeys,
    resolveTrustedHostKeys: hostCoordinator.resolveTrustedHostKeys,
    resolveTailnetRoute: hostCoordinator.resolveTailnetRoute,
    buildKnownSshDuplicateKeys: hostCoordinator.buildKnownSshDuplicateKeys,
    assertSshHost: hostCoordinator.assertSshHost,
    assertSftpCompatibleHost: hostCoordinator.assertSftpCompatibleHost,
    assertAwsEc2Host: hostCoordinator.assertAwsEc2Host,
    assertAwsEcsHost: hostCoordinator.assertAwsEcsHost,
    describeHostLabel: hostCoordinator.describeHostLabel,
    describeHostTarget: hostCoordinator.describeHostTarget,
    buildHostKeyProbeResult: hostCoordinator.buildHostKeyProbeResult,
    loadAwsHostSshMetadataRecord: awsSftpCoordinator.loadHostSshMetadataRecord,
    normalizeEcsExecPermissionError:
      awsSftpCoordinator.normalizeEcsExecPermissionError,
    createEphemeralAwsSftpKeyPair:
      awsSftpCoordinator.createEphemeralAwsSftpKeyPair,
    reserveLoopbackPort: awsSftpCoordinator.reserveLoopbackPort,
    buildContainerShellCommand:
      containerRuntimeCoordinator.buildContainerShellCommand,
    formatSftpStageError: awsSftpCoordinator.formatSftpStageError,
  };
}
