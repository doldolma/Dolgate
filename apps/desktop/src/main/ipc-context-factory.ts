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
import { LocalFileService } from "./file-service";
import type { HostsOverrideManager } from "./hosts-override-manager";
import type { OpenSshImportService } from "./openssh-import-service";
import { PortForwardLifecycleLogger } from "./port-forward-lifecycle-logger";
import type { SecretStore } from "./secret-store";
import type { SessionReplayService } from "./session-replay-service";
import type { SessionShareService } from "./session-share-service";
import type { SyncService } from "./sync-service";
import type { TermiusImportService } from "./termius-import-service";
import type { UpdateService } from "./update-service";
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
  knownHosts: KnownHostRepository;
  activityLogs: ActivityLogRepository;
  secretMetadata: SecretMetadataRepository;
  syncOutbox: SyncOutboxRepository;
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
  } = deps;

  const localFiles = new LocalFileService();
  const aiService = new AiService(
    settings,
    secretStore,
    buildAiToolHelpers({ coreManager, hosts, activityLogs }),
  );
  const queueSync = () => {
    void syncService.pushDirty().catch(() => undefined);
  };
  const portForwardLifecycleLogger = new PortForwardLifecycleLogger(
    activityLogs,
    portForwards,
    hosts,
  );

  const secretCoordinator = createSecretCoordinator({
    secretStore,
    secretMetadata,
    hosts,
    activityLogs,
    queueSync,
    inspectCertificate: (certificateText) =>
      coreManager.inspectCertificate(certificateText),
  });
  const tunnelRegistry = createTunnelRegistry({ awsSsmTunnelService });
  const dnsPortForwardCoordinator = createDnsPortForwardCoordinator({
    dnsOverrides,
    portForwards,
    coreManager,
    hostsOverrideManager,
  });

  let emitSftpConnectionProgress: AwsConnectionProgressEmitter = () => undefined;
  const awsSftpCoordinator = createAwsSftpCoordinator({
    hosts,
    awsService,
    queueSync,
    emitSftpConnectionProgress: (event) => emitSftpConnectionProgress(event),
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
    hosts,
    knownHosts,
    coreManager,
    awsService,
    authService,
    awsSsmTunnelService,
    awsSftpCoordinator,
    tailnets,
    resolveRuntimeSshSecrets: secretCoordinator.resolveRuntimeSshSecrets,
    ensureCertificateAuthReady: secretCoordinator.ensureCertificateAuthReady,
  });

  const containerRuntimeCoordinator = createContainerRuntimeCoordinator({
    coreManager,
    knownHosts,
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
    hosts,
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
    persistSecret: secretCoordinator.persistSecret,
    loadSecrets: secretCoordinator.loadSecrets,
    // 원격 키 설치는 코어가 신뢰를 묻지 못한다(대화형 세션이 아니다) — 신뢰된 키를 요구하는
    // 쪽을 그대로 쓴다.
    requireTrustedHostKeys: hostCoordinator.requireTrustedHostKeys,
    requireConfiguredSshUsername: hostCoordinator.requireConfiguredSshUsername,
    resolveJumpHostTarget: hostCoordinator.resolveJumpHostTarget,
    ensureCertificateAuthReady: secretCoordinator.ensureCertificateAuthReady,
    generatePrivateKey: (payload) => coreManager.generatePrivateKey(payload),
    inspectPrivateKey: (privateKeyPem, passphrase) =>
      coreManager.inspectPrivateKey(privateKeyPem, passphrase),
    installAuthorizedKey: (payload) =>
      coreManager.installAuthorizedKey(payload),
    queueSync,
  });

  return {
    resolveJumpHostTarget: hostCoordinator.resolveJumpHostTarget,
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
    hasSecretValue: secretCoordinator.hasSecretValue,
    mergeSecrets: secretCoordinator.mergeSecrets,
    resolveRuntimeSshSecrets: secretCoordinator.resolveRuntimeSshSecrets,
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
    requireConfiguredSshUsername: hostCoordinator.requireConfiguredSshUsername,
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
