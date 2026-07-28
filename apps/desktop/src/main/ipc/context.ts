import type {
  AppSettings,
  AwsSftpDiagnosticDetails,
  AwsSftpDiagnosticReasonCode,
  DesktopBootstrapSnapshot,
  DesktopConnectInput,
  DesktopLocalConnectInput,
  DesktopSftpConnectInput,
  DesktopSyncedWorkspaceSnapshot,
  DesktopWindowState,
  DnsOverrideDraft,
  DnsOverrideResolvedRecord,
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
  ResolvedJumpHost,
  SshKeyGenerateInput,
  SshKeyInstallInput,
  SshKeyInstallResult,
  SshKeyMaterialResult,
  SshCertificateInfo,
} from "@shared";
import type { BrowserWindow, WebContents } from "electron";
import type { AuthService } from "../auth-service";
import type { AwsSsmTunnelService } from "../aws-ssm-tunnel-service";
import type { AiService } from "../ai-service";
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
  TailnetRepository,
  SnippetRepository,
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
  reasonCode?: AwsSftpDiagnosticReasonCode;
  diagnosticId?: string;
  details?: AwsSftpDiagnosticDetails;
}) => void;

export interface MainIpcContext {
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
  aiService: AiService;
  localFiles: LocalFileService;
  portForwardLifecycleLogger: PortForwardLifecycleLogger;
  queueSync: () => void;
  getInitialBootstrapSnapshot: (
    ownerWebContentsId?: number,
  ) => Promise<DesktopBootstrapSnapshot>;
  getSyncedWorkspaceSnapshot: () => Promise<DesktopSyncedWorkspaceSnapshot>;
  listPortForwardSnapshot: () => {
    rules: ReturnType<PortForwardRepository["list"]>;
    runtimes: ReturnType<CoreManager["listPortForwardRuntimes"]>;
  };
  listResolvedDnsOverrides: () => DnsOverrideResolvedRecord[];
  emitSftpConnectionProgress: AwsConnectionProgressEmitter;
  emitSftpConnectionFailureProgress: (input: {
    endpointId: string;
    host: AwsEc2HostRecord;
    stage: AwsSftpProgressStage;
    error: unknown;
    reasonCode?: AwsSftpDiagnosticReasonCode;
    details?: AwsSftpDiagnosticDetails;
    emitProgress?: AwsConnectionProgressEmitter;
  }) => Error;
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
    hydratedHost?: AwsEc2HostRecord | null;
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
  emitWorkspaceChanged: (sender?: WebContents) => void;
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
  resolveRuntimeSshSecrets: (
    host: SshHostRecord,
    secrets?: HostSecretInput,
  ) => Promise<{
    secrets: HostSecretInput;
    shouldPersistHostSecret: boolean;
  }>;
  // host.jumpHostId가 있으면 그 점프 호스트를 해석한 ResolvedJumpHost, 없으면
  // undefined를 돌려준다. 4개 connect 핸들러가 payload.jump로 실어 보낸다.
  resolveJumpHostTarget: (
    host: SshHostRecord,
  ) => Promise<ResolvedJumpHost | undefined>;
  resolveManagedPrivateKeyPem: (
    draft: HostDraft,
    nextSecrets: HostSecretInput | undefined,
    currentSecretRef: string | null,
  ) => Promise<string | undefined>;
  resolveManagedCertificateText: (
    draft: HostDraft,
    nextSecrets: HostSecretInput | undefined,
    currentSecretRef: string | null,
  ) => Promise<string | undefined>;
  inspectCertificate: (certificateText: string) => Promise<SshCertificateInfo>;
  generateSshKey: (input: SshKeyGenerateInput) => Promise<SshKeyMaterialResult>;
  resolveSshPublicKey: (
    secretRef: string,
    passphraseOverride?: string | null,
  ) => Promise<SshKeyMaterialResult>;
  installSshPublicKey: (
    input: SshKeyInstallInput,
  ) => Promise<SshKeyInstallResult>;
  inspectStoredCertificate: (input: {
    secretRef?: string | null;
    certificateText?: string | undefined;
  }) => Promise<SshCertificateInfo | null>;
  ensureCertificateAuthReady: (
    host: SshHostRecord,
    secrets: HostSecretInput,
  ) => Promise<SshCertificateInfo | null>;
  requireTrustedHostKey: (host: { hostname: string; port: number }) => string;
  requireTrustedHostKeys: (host: {
    hostname: string;
    port: number;
    tailnetId?: string | null;
  }) => string[];
  /**
   * 이 호스트를 어느 tailnet 으로 보낼지. tailnet 이 없으면 빈 객체다.
   *
   * 기대 이름(tailnetName)까지 함께 넘기는 이유는, 코어가 실제로 붙은 tailnet 과 대조해
   * 다르면 연결을 거부해야 하기 때문이다 — 다른 계정으로 로그인해 엉뚱한 tailnet 의 동명
   * 머신에 붙는 것을 막는다. 그 이름은 tailnet 설정에만 있으므로 여기서 읽어 넣는다.
   */
  resolveTailnetRoute: (host: { tailnetId?: string | null }) => {
    tailnetId?: string;
    tailnetName?: string;
  };
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
    jump?: ResolvedJumpHost,
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
    options?: {
      reasonCode?: AwsSftpDiagnosticReasonCode;
      diagnosticId?: string;
      details?: AwsSftpDiagnosticDetails;
    },
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
