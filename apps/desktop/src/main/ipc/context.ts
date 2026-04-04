import type {
  AppSettings,
  DesktopBootstrapSnapshot,
  DesktopConnectInput,
  DesktopLocalConnectInput,
  DesktopSftpConnectInput,
  DesktopSyncedWorkspaceSnapshot,
  DesktopWindowState,
  DnsOverrideDraft,
  HostContainerRuntime,
  HostDraft,
  HostKeyProbeResult,
  HostRecord,
  HostSecretInput,
  KeyboardInteractiveRespondInput,
  KnownHostProbeInput,
  ManagedSecretPayload,
  PortForwardDraft,
  PortForwardRuntimeRecord,
} from "@shared";
import type { BrowserWindow, WebContents } from "electron";
import type { AuthService } from "../auth-service";
import type { AwsSsmTunnelService } from "../aws-ssm-tunnel-service";
import type { AwsService } from "../aws-service";
import type { CoreManager } from "../core-manager";
import type {
  ActivityLogRepository,
  DnsOverrideRepository,
  GroupRepository,
  HostRepository,
  KnownHostRepository,
  PortForwardRepository,
  SecretMetadataRepository,
  SettingsRepository,
  SyncOutboxRepository,
} from "../database";
import type { LocalFileService } from "../file-service";
import type { HostsOverrideManager } from "../hosts-override-manager";
import type { OpenSshImportService } from "../openssh-import-service";
import type { PortForwardLifecycleLogger } from "../port-forward-lifecycle-logger";
import type { SecretStore } from "../secret-store";
import type { SessionReplayService } from "../session-replay-service";
import type { SessionShareService } from "../session-share-service";
import type { SyncService } from "../sync-service";
import type { TermiusImportService } from "../termius-import-service";
import type { UpdateService } from "../update-service";
import type { WarpgateService } from "../warpgate-service";
import type { XshellImportService } from "../xshell-import-service";

export type SshHostRecord = Extract<HostRecord, { kind: "ssh" }>;
export type SftpCompatibleHostRecord = Extract<
  HostRecord,
  { kind: "ssh" | "warpgate-ssh" | "aws-ec2" }
>;
export type AwsEc2HostRecord = Extract<HostRecord, { kind: "aws-ec2" }>;
export type AwsEcsHostRecord = Extract<HostRecord, { kind: "aws-ecs" }>;

export type AwsSftpProgressStage =
  | "loading-instance-metadata"
  | "checking-profile"
  | "browser-login"
  | "checking-ssm"
  | "probing-host-key"
  | "generating-key"
  | "sending-public-key"
  | "opening-tunnel"
  | "connecting-sftp";

export type AwsConnectionProgressStage =
  | AwsSftpProgressStage
  | "connecting-containers";

export type AwsConnectionProgressEmitter = (event: {
  endpointId: string;
  hostId: string;
  stage: AwsConnectionProgressStage;
  message: string;
}) => void;

export interface MainIpcContext {
  hosts: HostRepository;
  groups: GroupRepository;
  settings: SettingsRepository;
  portForwards: PortForwardRepository;
  dnsOverrides: DnsOverrideRepository;
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
  localFiles: LocalFileService;
  portForwardLifecycleLogger: PortForwardLifecycleLogger;
  queueSync: () => void;
  getInitialBootstrapSnapshot: () => Promise<DesktopBootstrapSnapshot>;
  getSyncedWorkspaceSnapshot: () => Promise<DesktopSyncedWorkspaceSnapshot>;
  listPortForwardSnapshot: () => {
    rules: ReturnType<PortForwardRepository["list"]>;
    runtimes: ReturnType<CoreManager["listPortForwardRuntimes"]>;
  };
  listResolvedDnsOverrides: () => any[];
  emitSftpConnectionProgress: AwsConnectionProgressEmitter;
  emitContainersConnectionProgress: AwsConnectionProgressEmitter;
  pendingSessionSecrets: Map<
    string,
    {
      hostId: string;
      label: string;
      secrets: HostSecretInput;
    }
  >;
  trackAwsSftpTunnelRuntime: (endpointId: string, runtimeId: string) => void;
  trackAwsContainerShellTunnelRuntime: (
    sessionId: string,
    runtimeId: string,
  ) => void;
  stopAwsSftpTunnelForEndpoint: (endpointId: string) => Promise<void>;
  buildContainersEndpointId: (hostId: string) => string;
  buildContainerPortForwardEndpointId: (
    hostId: string,
    ruleId: string,
  ) => string;
  stopAwsContainersTunnelForEndpoint: (endpointId: string) => Promise<void>;
  moveAwsContainersTunnelRuntime: (
    sourceKey: string,
    nextKey: string,
  ) => void;
  stopAwsContainerShellTunnelForSession: (sessionId: string) => Promise<void>;
  storeAwsSftpPreflight: (
    endpointId: string,
    hydratedHost: AwsEc2HostRecord,
  ) => void;
  clearAwsSftpPreflight: (endpointId: string) => void;
  consumeAwsSftpPreflight: (
    endpointId: string,
    hostId: string,
  ) => AwsEc2HostRecord | null;
  rewriteActiveDnsOverrides: (
    runtimeOverride?: PortForwardRuntimeRecord[],
  ) => Promise<void>;
  stopPortForwardWithDnsOverrideCleanup: (ruleId: string) => Promise<void>;
  persistHostSpecificSecret: (
    hostId: string,
    label: string,
    secrets: HostSecretInput,
  ) => Promise<string | null>;
  resolveAwsSftpPreflight: (input: {
    endpointId: string;
    host: AwsEc2HostRecord;
    allowBrowserLogin: boolean;
    emitProgress?: AwsConnectionProgressEmitter;
  }) => Promise<AwsEc2HostRecord>;
  ensureContainersEndpoint: (
    host: SftpCompatibleHostRecord,
    endpointId?: string,
  ) => Promise<{
    endpointId: string;
    runtime: HostContainerRuntime | null;
    runtimeCommand: string | null;
    unsupportedReason: string | null;
  }>;
  startContainerTunnelRuntime: (input: {
    ruleId: string;
    host: SftpCompatibleHostRecord;
    containerId: string;
    networkName: string;
    targetPort: number;
    bindAddress: string;
    bindPort: number;
  }) => Promise<unknown>;
  resolveWindowFromSender: (sender: WebContents) => BrowserWindow;
  buildWindowState: (window: BrowserWindow) => DesktopWindowState;
  persistSecret: (
    label: string,
    secrets?: HostSecretInput,
  ) => Promise<string | null>;
  persistImportedSecret: (
    label: string,
    secrets: HostSecretInput,
  ) => Promise<string | null>;
  loadSecrets: (secretRef?: string | null) => Promise<HostSecretInput>;
  hasSecretValue: (secrets: HostSecretInput) => boolean;
  mergeSecrets: (
    current: HostSecretInput,
    patch: HostSecretInput,
  ) => HostSecretInput;
  resolveManagedPrivateKeyPem: (
    draft: HostDraft,
    currentSecretRef: string | null,
  ) => Promise<string | undefined>;
  requireTrustedHostKey: (host: { hostname: string; port: number }) => string;
  requireConfiguredSshUsername: (host: SshHostRecord) => string;
  buildKnownSshDuplicateKeys: () => Set<string>;
  assertSshHost: (host: ReturnType<HostRepository["getById"]>) => void;
  assertSftpCompatibleHost: (
    host: ReturnType<HostRepository["getById"]>,
  ) => void;
  assertAwsEc2Host: (host: ReturnType<HostRepository["getById"]>) => void;
  assertAwsEcsHost: (host: ReturnType<HostRepository["getById"]>) => void;
  describeHostLabel: (host: HostDraft | HostRecord) => string;
  describeHostTarget: (
    host: HostDraft | ReturnType<HostRepository["getById"]>,
  ) => string | null;
  buildHostKeyProbeResult: (
    emitProgress: AwsConnectionProgressEmitter,
    input: KnownHostProbeInput,
  ) => Promise<HostKeyProbeResult>;
  loadAwsHostSshMetadataRecord: (
    host: AwsEc2HostRecord,
  ) => Promise<AwsEc2HostRecord>;
  normalizeEcsExecPermissionError: (error: unknown) => Error;
  createEphemeralAwsSftpKeyPair: () => {
    privateKeyPem: string;
    publicKey: string;
  };
  reserveLoopbackPort: () => Promise<number>;
  buildContainerShellCommand: (
    runtimeCommand: string,
    containerId: string,
  ) => string;
  formatSftpStageError: (
    stage: AwsSftpProgressStage,
    error: unknown,
  ) => Error;
}

export interface DesktopSessionShellInput {
  connectInput: DesktopConnectInput;
  localConnectInput: DesktopLocalConnectInput;
  sftpConnectInput: DesktopSftpConnectInput;
  keyboardInteractiveInput: KeyboardInteractiveRespondInput;
  portForwardDraft: PortForwardDraft;
  dnsOverrideDraft: DnsOverrideDraft;
  keychainPayload: ManagedSecretPayload;
  appSettings: AppSettings;
}
