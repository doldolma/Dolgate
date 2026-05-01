import type { AuthSession } from './api';

export type AuthType = 'password' | 'privateKey' | 'keyboardInteractive' | 'certificate';
export type HostKind = 'ssh' | 'aws-ec2' | 'aws-ecs' | 'warpgate-ssh' | 'serial';
export type SerialTransport = 'local' | 'raw-tcp' | 'rfc2217';
export type SerialDataBits = 5 | 6 | 7 | 8;
export type SerialParity = 'none' | 'odd' | 'even' | 'mark' | 'space';
export type SerialStopBits = 1 | 1.5 | 2;
export type SerialFlowControl = 'none' | 'xon-xoff' | 'rts-cts' | 'dsr-dtr';
export type SerialLineEnding = 'none' | 'cr' | 'lf' | 'crlf';
export type SerialControlAction = 'break' | 'set-dtr' | 'set-rts';
export type AppTheme = 'system' | 'light' | 'dark';
export type TerminalThemeId =
  | 'dolssh-dark'
  | 'dolssh-light'
  | 'kanagawa-wave'
  | 'kanagawa-dragon'
  | 'kanagawa-lotus'
  | 'everforest-dark'
  | 'everforest-light'
  | 'night-owl'
  | 'light-owl'
  | 'rose-pine'
  | 'hacker-green'
  | 'hacker-blue'
  | 'hacker-red';
export type GlobalTerminalThemeId = TerminalThemeId | 'system';
export type TerminalFontFamilyId =
  | 'sf-mono'
  | 'menlo'
  | 'monaco'
  | 'consolas'
  | 'cascadia-mono'
  | 'jetbrains-mono'
  | 'fira-code'
  | 'ibm-plex-mono'
  | 'source-code-pro';
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'upToDate' | 'error';
export type SftpPaneId = 'left' | 'right';
export type SftpEndpointKind = 'local' | 'remote';
export type FileEntryKind = 'folder' | 'file' | 'symlink' | 'unknown';
export type HostContainerRuntime = 'docker' | 'podman';
export type HostContainerAction = 'start' | 'stop' | 'restart' | 'remove';
export type SftpBrowserColumnKey = 'name' | 'dateModified' | 'size' | 'kind';
export type ConflictResolution = 'overwrite' | 'skip' | 'keepBoth';
export type SftpConflictPolicy = 'ask' | ConflictResolution;
export type PortForwardMode = 'local' | 'remote' | 'dynamic';
export type PortForwardTransport = 'ssh' | 'aws-ssm' | 'ecs-task' | 'container';
export type AwsSsmPortForwardTargetKind = 'instance-port' | 'remote-host';
export type PortForwardStatus = 'stopped' | 'starting' | 'running' | 'error';
export type DnsOverrideStatus = 'inactive' | 'active';
export type KnownHostTrustStatus = 'trusted' | 'untrusted' | 'mismatch';
export type ActivityLogLevel = 'info' | 'warn' | 'error';
export type ActivityLogCategory = 'session' | 'audit';
export type ActivityLogKind = 'generic' | 'session-lifecycle' | 'port-forward-lifecycle';
export type AuthStatus = 'loading' | 'unauthenticated' | 'authenticating' | 'authenticated' | 'offline-authenticated' | 'error';
export type SyncBootstrapStatus = 'idle' | 'syncing' | 'ready' | 'paused' | 'error';
export type AwsProfilesServerSupport = 'unknown' | 'supported' | 'unsupported';
export type TermiusProbeStatus = 'ready' | 'unsupported' | 'not-installed' | 'no-data' | 'error';
export type AwsSshMetadataStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SessionConnectionKind = 'ssh' | 'aws-ssm' | 'warpgate' | 'aws-ecs-exec' | 'serial';
export type SessionLifecycleStatus = 'connected' | 'closed' | 'error';
export type PortForwardLifecycleStatus = 'running' | 'closed' | 'error';
export type SftpConnectionStage =
  | 'loading-instance-metadata'
  | 'checking-profile'
  | 'browser-login'
  | 'checking-ssm'
  | 'probing-host-key'
  | 'generating-key'
  | 'sending-public-key'
  | 'opening-tunnel'
  | 'connecting-sftp';
export type AwsSftpDiagnosticReasonCode =
  | 'missing-username'
  | 'missing-availability-zone'
  | 'host-key-missing'
  | 'ssm-plugin-missing'
  | 'not-managed-instance'
  | 'eic-access-denied'
  | 'eic-invalid-os-user'
  | 'eic-az-mismatch'
  | 'tunnel-open-failed'
  | 'ssh-auth-failed'
  | 'sftp-subsystem-failed'
  | 'unknown';
export type AwsSftpDiagnosticDetails = Record<
  string,
  string | number | boolean | null
>;
export type ConnectionProgressStage =
  | SftpConnectionStage
  | 'connecting-containers'
  | 'loading-ecs-cluster'
  | 'loading-ecs-metrics';

export const AWS_SFTP_DEFAULT_PORT = 22;
export const DEFAULT_SESSION_REPLAY_RETENTION_COUNT = 100;
export const MIN_SESSION_REPLAY_RETENTION_COUNT = 10;
export const MAX_SESSION_REPLAY_RETENTION_COUNT = 1000;

interface HostBaseRecord {
  id: string;
  kind: HostKind;
  label: string;
  groupName?: string | null;
  tags?: string[];
  terminalThemeId?: TerminalThemeId | null;
  createdAt: string;
  updatedAt: string;
}

interface HostBaseDraft {
  kind: HostKind;
  label: string;
  groupName?: string | null;
  tags?: string[];
  terminalThemeId?: TerminalThemeId | null;
}

export interface SshHostRecord extends HostBaseRecord {
  kind: 'ssh';
  hostname: string;
  port: number;
  username: string;
  authType: AuthType;
  privateKeyPath?: string | null;
  certificatePath?: string | null;
  secretRef?: string | null;
}

export interface SshHostDraft extends HostBaseDraft {
  kind: 'ssh';
  hostname: string;
  port: number;
  username: string;
  authType: AuthType;
  privateKeyPath?: string | null;
  certificatePath?: string | null;
  secretRef?: string | null;
}

export interface AwsEc2HostRecord extends HostBaseRecord {
  kind: 'aws-ec2';
  awsProfileId?: string | null;
  awsProfileName: string;
  awsRegion: string;
  awsInstanceId: string;
  awsAvailabilityZone?: string | null;
  awsInstanceName?: string | null;
  awsPlatform?: string | null;
  awsPrivateIp?: string | null;
  awsState?: string | null;
  awsSshUsername?: string | null;
  awsSshPort?: number | null;
  awsSshMetadataStatus?: AwsSshMetadataStatus | null;
  awsSshMetadataError?: string | null;
}

export interface AwsEc2HostDraft extends HostBaseDraft {
  kind: 'aws-ec2';
  awsProfileId?: string | null;
  awsProfileName: string;
  awsRegion: string;
  awsInstanceId: string;
  awsAvailabilityZone?: string | null;
  awsInstanceName?: string | null;
  awsPlatform?: string | null;
  awsPrivateIp?: string | null;
  awsState?: string | null;
  awsSshUsername?: string | null;
  awsSshPort?: number | null;
  awsSshMetadataStatus?: AwsSshMetadataStatus | null;
  awsSshMetadataError?: string | null;
}

export interface AwsEcsHostRecord extends HostBaseRecord {
  kind: 'aws-ecs';
  awsProfileId?: string | null;
  awsProfileName: string;
  awsRegion: string;
  awsEcsClusterArn: string;
  awsEcsClusterName: string;
}

export interface AwsEcsHostDraft extends HostBaseDraft {
  kind: 'aws-ecs';
  awsProfileId?: string | null;
  awsProfileName: string;
  awsRegion: string;
  awsEcsClusterArn: string;
  awsEcsClusterName: string;
}

export interface WarpgateSshHostRecord extends HostBaseRecord {
  kind: 'warpgate-ssh';
  warpgateBaseUrl: string;
  warpgateSshHost: string;
  warpgateSshPort: number;
  warpgateTargetId: string;
  warpgateTargetName: string;
  warpgateUsername: string;
}

export interface WarpgateSshHostDraft extends HostBaseDraft {
  kind: 'warpgate-ssh';
  warpgateBaseUrl: string;
  warpgateSshHost: string;
  warpgateSshPort: number;
  warpgateTargetId: string;
  warpgateTargetName: string;
  warpgateUsername: string;
}

export interface SerialHostRecord extends HostBaseRecord {
  kind: 'serial';
  transport: SerialTransport;
  devicePath?: string | null;
  host?: string | null;
  port?: number | null;
  baudRate: number;
  dataBits: SerialDataBits;
  parity: SerialParity;
  stopBits: SerialStopBits;
  flowControl: SerialFlowControl;
  transmitLineEnding: SerialLineEnding;
  localEcho: boolean;
  localLineEditing: boolean;
}

export interface SerialHostDraft extends HostBaseDraft {
  kind: 'serial';
  transport: SerialTransport;
  devicePath?: string | null;
  host?: string | null;
  port?: number | null;
  baudRate: number;
  dataBits: SerialDataBits;
  parity: SerialParity;
  stopBits: SerialStopBits;
  flowControl: SerialFlowControl;
  transmitLineEnding: SerialLineEnding;
  localEcho: boolean;
  localLineEditing: boolean;
}

export interface SerialPortSummary {
  path: string;
  displayName: string;
  manufacturer?: string | null;
}

// HostRecord는 로컬 스토리지와 sync payload가 공유하는 정규화된 호스트 모델이다.
export type HostRecord =
  | SshHostRecord
  | AwsEc2HostRecord
  | AwsEcsHostRecord
  | WarpgateSshHostRecord
  | SerialHostRecord;

// HostDraft는 생성/수정 폼에서 사용하는 입력 전용 모델이다.
export type HostDraft =
  | SshHostDraft
  | AwsEc2HostDraft
  | AwsEcsHostDraft
  | WarpgateSshHostDraft
  | SerialHostDraft;

export function isSshHostRecord(host: HostRecord): host is SshHostRecord {
  return host.kind === 'ssh';
}

export function isAwsEc2HostRecord(host: HostRecord): host is AwsEc2HostRecord {
  return host.kind === 'aws-ec2';
}

export function isAwsEcsHostRecord(host: HostRecord): host is AwsEcsHostRecord {
  return host.kind === 'aws-ecs';
}

export function isWarpgateSshHostRecord(host: HostRecord): host is WarpgateSshHostRecord {
  return host.kind === 'warpgate-ssh';
}

export function isSerialHostRecord(host: HostRecord): host is SerialHostRecord {
  return host.kind === 'serial';
}

export function isSshHostDraft(host: HostDraft): host is SshHostDraft {
  return host.kind === 'ssh';
}

export function isAwsEc2HostDraft(host: HostDraft): host is AwsEc2HostDraft {
  return host.kind === 'aws-ec2';
}

export function isAwsEcsHostDraft(host: HostDraft): host is AwsEcsHostDraft {
  return host.kind === 'aws-ecs';
}

export function isWarpgateSshHostDraft(host: HostDraft): host is WarpgateSshHostDraft {
  return host.kind === 'warpgate-ssh';
}

export function isSerialHostDraft(host: HostDraft): host is SerialHostDraft {
  return host.kind === 'serial';
}

export function getHostSearchText(host: HostRecord): string[] {
  if (host.kind === 'aws-ec2') {
    return [
      host.label,
      host.awsInstanceName ?? '',
      host.awsInstanceId,
      host.awsRegion,
      host.awsAvailabilityZone ?? '',
      host.awsProfileName,
      host.awsPrivateIp ?? '',
      host.awsSshUsername ?? '',
      host.groupName ?? '',
      ...(host.tags ?? [])
    ];
  }
  if (host.kind === 'warpgate-ssh') {
    return [
      host.label,
      host.warpgateTargetName,
      host.warpgateTargetId,
      host.warpgateUsername,
      host.warpgateBaseUrl,
      host.groupName ?? '',
      ...(host.tags ?? [])
    ];
  }
  if (host.kind === 'aws-ecs') {
    return [
      host.label,
      host.awsEcsClusterName,
      host.awsEcsClusterArn,
      host.awsRegion,
      host.awsProfileName,
      host.groupName ?? '',
      ...(host.tags ?? []),
    ];
  }
  if (host.kind === 'serial') {
    return [
      host.label,
      host.transport,
      host.devicePath ?? '',
      host.host ?? '',
      typeof host.port === 'number' ? String(host.port) : '',
      host.groupName ?? '',
      ...(host.tags ?? []),
    ];
  }
  return [host.label, host.hostname, host.username, host.groupName ?? '', ...(host.tags ?? [])];
}

export function getHostSubtitle(host: HostRecord): string {
  if (host.kind === 'aws-ec2') {
    const parts = ['AWS', host.awsRegion, host.awsPrivateIp || host.awsInstanceId].filter(Boolean);
    return parts.join(' • ');
  }
  if (host.kind === 'warpgate-ssh') {
    const target = host.warpgateTargetName || host.warpgateTargetId;
    return ['Warpgate', host.warpgateUsername, target].filter(Boolean).join(' • ');
  }
  if (host.kind === 'aws-ecs') {
    return [host.awsProfileName, host.awsRegion, host.awsEcsClusterName]
      .filter(Boolean)
      .join(' • ');
  }
  if (host.kind === 'serial') {
    if (host.transport === 'local') {
      return ['Serial', host.devicePath ?? '장치 경로 미설정'].join(' • ');
    }
    return [
      'Serial',
      host.transport,
      host.host && host.port ? `${host.host}:${host.port}` : '원격 주소 미설정',
    ]
      .filter(Boolean)
      .join(' • ');
  }
  return host.username.trim()
    ? `${host.username}@${host.hostname}:${host.port}`
    : `${host.hostname}:${host.port} • 사용자명 미설정`;
}

export function getHostBadgeLabel(host: HostRecord): string {
  if (host.kind === 'aws-ec2') {
    return 'AWS';
  }
  if (host.kind === 'warpgate-ssh') {
    return 'WARP';
  }
  if (host.kind === 'aws-ecs') {
    return 'ECS';
  }
  if (host.kind === 'serial') {
    return 'SER';
  }
  if (host.authType === 'privateKey') {
    return 'K';
  }
  if (host.authType === 'certificate') {
    return 'C';
  }
  return 'S';
}

export function getHostSecretRef(host: HostRecord): string | null {
  return host.kind === 'ssh' ? (host.secretRef ?? null) : null;
}

function normalizeAwsPlatform(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

export function isAwsEc2WindowsPlatform(value?: string | null): boolean {
  const normalized = normalizeAwsPlatform(value);
  return normalized.includes('windows');
}

export function getAwsEc2HostSftpDisabledReason(input: {
  awsPlatform?: string | null;
  awsSshUsername?: string | null;
}): string | null {
  if (isAwsEc2WindowsPlatform(input.awsPlatform)) {
    return 'Windows 인스턴스는 아직 지원하지 않습니다.';
  }
  return null;
}

export function getAwsEc2HostSshMetadataStatusLabel(status?: AwsSshMetadataStatus | null): string | null {
  switch (status) {
    case 'loading':
      return 'SSH 설정 확인 중';
    case 'ready':
      return 'SSH 설정 자동 확인됨';
    case 'error':
      return 'SSH 설정 확인 실패';
    default:
      return null;
  }
}

export const AWS_SFTP_DIAGNOSTIC_REASON_CODES: readonly AwsSftpDiagnosticReasonCode[] = [
  'missing-username',
  'missing-availability-zone',
  'host-key-missing',
  'ssm-plugin-missing',
  'not-managed-instance',
  'eic-access-denied',
  'eic-invalid-os-user',
  'eic-az-mismatch',
  'tunnel-open-failed',
  'ssh-auth-failed',
  'sftp-subsystem-failed',
  'unknown',
];

export function isAwsSftpDiagnosticReasonCode(
  value: unknown,
): value is AwsSftpDiagnosticReasonCode {
  return (
    typeof value === 'string' &&
    AWS_SFTP_DIAGNOSTIC_REASON_CODES.includes(
      value as AwsSftpDiagnosticReasonCode,
    )
  );
}

export function inferAwsSftpDiagnosticReasonCode(
  stage: SftpConnectionStage | null | undefined,
  message: string,
): AwsSftpDiagnosticReasonCode {
  const normalized = message.toLowerCase();
  if (/session manager plugin|session-manager-plugin/.test(normalized)) {
    return 'ssm-plugin-missing';
  }
  if (/host key is not trusted|host key.+trusted|호스트 키/.test(normalized)) {
    return 'host-key-missing';
  }
  if (/managed instance|ssm managed|ssm 관리/.test(normalized)) {
    return 'not-managed-instance';
  }
  if (/availability zone|\baz\b/.test(normalized)) {
    return 'missing-availability-zone';
  }
  if (
    /instanceosuser|instance os user|os user|ssh username|사용자명|username/.test(
      normalized,
    )
  ) {
    return stage === 'sending-public-key'
      ? 'eic-invalid-os-user'
      : 'missing-username';
  }
  if (
    /accessdenied|unauthorizedoperation|not authorized|is not authorized|권한|거부/.test(
      normalized,
    )
  ) {
    return stage === 'sending-public-key' ? 'eic-access-denied' : 'unknown';
  }
  if (/availability zone.+match|az.+match|zone.+mismatch/.test(normalized)) {
    return 'eic-az-mismatch';
  }
  if (stage === 'opening-tunnel') {
    return 'tunnel-open-failed';
  }
  if (
    stage === 'connecting-sftp' &&
    /subsystem|sftp server|filexfer|sftp subsystem/.test(normalized)
  ) {
    return 'sftp-subsystem-failed';
  }
  if (
    stage === 'connecting-sftp' &&
    /authentication failed|unable to authenticate|permission denied|ssh handshake|unexpected message type 51|connection refused|timed out/.test(
      normalized,
    )
  ) {
    return 'ssh-auth-failed';
  }
  return 'unknown';
}

export function getAwsSftpDiagnosticTitle(
  reasonCode?: AwsSftpDiagnosticReasonCode | null,
): string {
  switch (reasonCode) {
    case 'missing-username':
      return 'SSH 사용자명을 확인하지 못했습니다.';
    case 'missing-availability-zone':
      return 'Availability Zone을 확인하지 못했습니다.';
    case 'host-key-missing':
      return '호스트 키 확인이 필요합니다.';
    case 'ssm-plugin-missing':
      return 'Session Manager Plugin이 필요합니다.';
    case 'not-managed-instance':
      return 'SSM managed instance가 아닙니다.';
    case 'eic-access-denied':
      return 'Instance Connect 권한이 부족합니다.';
    case 'eic-invalid-os-user':
      return 'Instance Connect 사용자명이 맞지 않습니다.';
    case 'eic-az-mismatch':
      return 'Instance Connect AZ 정보가 맞지 않습니다.';
    case 'tunnel-open-failed':
      return 'SSM 터널을 열지 못했습니다.';
    case 'ssh-auth-failed':
      return 'SSH 인증에 실패했습니다.';
    case 'sftp-subsystem-failed':
      return 'SFTP subsystem을 시작하지 못했습니다.';
    default:
      return 'AWS SFTP 연결을 완료하지 못했습니다.';
  }
}

export function getAwsSftpDiagnosticMessage(
  reasonCode?: AwsSftpDiagnosticReasonCode | null,
): string {
  switch (reasonCode) {
    case 'missing-username':
      return '인스턴스에 접속할 SSH 사용자명을 자동으로 찾지 못했습니다.';
    case 'missing-availability-zone':
      return 'Instance Connect 요청에 필요한 Availability Zone 정보가 없습니다.';
    case 'host-key-missing':
      return '이 AWS SSM 대상의 SSH 호스트 키가 아직 신뢰되지 않았습니다.';
    case 'ssm-plugin-missing':
      return '로컬 환경에서 AWS Session Manager Plugin을 실행할 수 없습니다.';
    case 'not-managed-instance':
      return '선택한 EC2 인스턴스가 현재 SSM managed instance로 확인되지 않습니다.';
    case 'eic-access-denied':
      return 'EC2 Instance Connect 공개 키 전송 요청이 권한 문제로 거부되었습니다.';
    case 'eic-invalid-os-user':
      return 'EC2 Instance Connect가 현재 SSH 사용자명을 대상 OS 사용자로 받아들이지 않았습니다.';
    case 'eic-az-mismatch':
      return 'EC2 Instance Connect 요청의 Availability Zone 정보가 인스턴스와 맞지 않습니다.';
    case 'tunnel-open-failed':
      return 'SFTP용 AWS SSM 내부 터널을 열지 못했습니다.';
    case 'ssh-auth-failed':
      return 'SSM 터널은 열렸지만 SSH 인증을 완료하지 못했습니다.';
    case 'sftp-subsystem-failed':
      return 'SSH 연결 후 SFTP subsystem을 시작하지 못했습니다.';
    default:
      return 'AWS SFTP 연결 중 확인되지 않은 오류가 발생했습니다.';
  }
}

export function getAwsSftpDiagnosticAction(
  reasonCode?: AwsSftpDiagnosticReasonCode | null,
): string {
  switch (reasonCode) {
    case 'missing-username':
      return '이 인스턴스의 SSH 사용자명을 입력한 뒤 다시 시도하세요.';
    case 'missing-availability-zone':
      return 'EC2 인스턴스 정보를 새로 확인하거나 호스트를 다시 가져온 뒤 다시 시도하세요.';
    case 'host-key-missing':
      return '호스트 키를 신뢰 목록에 추가한 뒤 SFTP 연결을 다시 시도하세요.';
    case 'ssm-plugin-missing':
      return 'AWS Session Manager Plugin 설치를 확인한 뒤 다시 시도하세요.';
    case 'not-managed-instance':
      return 'SSM Agent, 인스턴스 IAM role, 온라인 상태를 확인한 뒤 다시 시도하세요.';
    case 'eic-access-denied':
      return 'IAM 권한에 ec2-instance-connect:SendSSHPublicKey가 허용되어 있는지 확인하세요.';
    case 'eic-invalid-os-user':
      return 'ubuntu, ec2-user 같은 실제 OS 사용자명으로 SSH 설정을 수정하세요.';
    case 'eic-az-mismatch':
      return 'EC2 metadata를 새로고침해서 현재 Availability Zone을 다시 저장하세요.';
    case 'tunnel-open-failed':
      return 'SSM 연결 상태와 로컬 Session Manager Plugin 실행 가능 여부를 확인하세요.';
    case 'ssh-auth-failed':
      return 'SSH username, port, EC2 Instance Connect 지원 여부를 확인하세요.';
    case 'sftp-subsystem-failed':
      return '원격 SSH 서버의 SFTP subsystem 설정을 확인하세요.';
    default:
      return 'AWS 프로필, SSM 상태, SSH 설정을 확인한 뒤 다시 시도하세요.';
  }
}

export function getAwsEc2HostSshPort(input: {
  awsSshPort?: number | null;
}): number {
  const value = input.awsSshPort;
  if (!Number.isInteger(value) || !value || value < 1 || value > 65535) {
    return AWS_SFTP_DEFAULT_PORT;
  }
  return value;
}

export function buildAwsSsmKnownHostIdentity(input: {
  profileName: string;
  region: string;
  instanceId: string;
}): string {
  return `aws-ssm:${input.profileName}:${input.region}:${input.instanceId}`;
}

// GroupRecord는 홈 화면의 그룹 브라우징이 쓰는 계층형 그룹 메타데이터다.
export interface GroupRecord {
  id: string;
  name: string;
  path: string;
  parentPath?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GroupRemoveMode = 'delete-subtree' | 'reparent-descendants';

export interface GroupRemoveResult {
  groups: GroupRecord[];
  hosts: HostRecord[];
}

export interface GroupPathMutationResult {
  groups: GroupRecord[];
  hosts: HostRecord[];
  nextPath: string;
}

export interface TermiusImportCounts {
  groups: number;
  hosts: number;
  keys: number;
  multiKeys: number;
  sshConfigs: number;
  sshConfigIdentities: number;
  identities: number;
}

export interface TermiusImportWarning {
  code?: string | null;
  message: string;
}

export interface TermiusImportGroupPreview {
  path: string;
  name: string;
  parentPath?: string | null;
  hostCount: number;
}

export interface TermiusImportHostPreview {
  key: string;
  name: string;
  address: string | null;
  groupPath?: string | null;
  port: number | null;
  username: string | null;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  identityName: string | null;
}

export interface TermiusProbeResult {
  status: TermiusProbeStatus;
  snapshotId?: string | null;
  message?: string | null;
  meta?: {
    counts: TermiusImportCounts;
    warnings: TermiusImportWarning[];
    termiusDataDir?: string | null;
    exportedAt?: string | null;
  } | null;
  groups: TermiusImportGroupPreview[];
  hosts: TermiusImportHostPreview[];
}

export interface TermiusImportSelectionInput {
  snapshotId: string;
  selectedGroupPaths: string[];
  selectedHostKeys: string[];
}

export interface TermiusImportResult {
  createdGroupCount: number;
  createdHostCount: number;
  createdSecretCount: number;
  skippedHostCount: number;
  warnings: TermiusImportWarning[];
}

export interface OpenSshImportWarning {
  code?: string | null;
  message: string;
  filePath?: string | null;
  lineNumber?: number | null;
}

export interface OpenSshHostPreview {
  key: string;
  alias: string;
  hostname: string;
  port: number;
  username: string;
  authType: 'password' | 'privateKey';
  identityFilePath?: string | null;
  sourceFilePath: string;
  sourceLine: number;
}

export type OpenSshSourceOrigin = 'default-ssh-dir' | 'manual-file';

export interface OpenSshSourceSummary {
  id: string;
  filePath: string;
  origin: OpenSshSourceOrigin;
  label: string;
}

export interface OpenSshProbeResult {
  snapshotId: string;
  sources: OpenSshSourceSummary[];
  hosts: OpenSshHostPreview[];
  warnings: OpenSshImportWarning[];
  skippedExistingHostCount: number;
  skippedDuplicateHostCount: number;
}

export interface OpenSshSnapshotFileInput {
  snapshotId: string;
  filePath: string;
}

export interface OpenSshImportSelectionInput {
  snapshotId: string;
  selectedHostKeys: string[];
  groupPath?: string | null;
}

export interface OpenSshImportResult {
  createdHostCount: number;
  createdSecretCount: number;
  skippedHostCount: number;
  warnings: OpenSshImportWarning[];
}

export interface XshellImportWarning {
  code?: string | null;
  message: string;
  filePath?: string | null;
}

export type XshellSourceOrigin = 'default-session-dir' | 'manual-folder';

export interface XshellSourceSummary {
  id: string;
  folderPath: string;
  origin: XshellSourceOrigin;
  label: string;
}

export interface XshellImportGroupPreview {
  path: string;
  name: string;
  parentPath?: string | null;
  hostCount: number;
}

export interface XshellImportHostPreview {
  key: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  authType: 'password' | 'privateKey';
  groupPath?: string | null;
  privateKeyPath?: string | null;
  sourceFilePath: string;
  hasPasswordHint: boolean;
  hasAuthProfile: boolean;
}

export interface XshellProbeResult {
  snapshotId: string;
  sources: XshellSourceSummary[];
  groups: XshellImportGroupPreview[];
  hosts: XshellImportHostPreview[];
  warnings: XshellImportWarning[];
  skippedExistingHostCount: number;
  skippedDuplicateHostCount: number;
}

export interface XshellSnapshotFolderInput {
  snapshotId: string;
  folderPath: string;
}

export interface XshellImportSelectionInput {
  snapshotId: string;
  selectedGroupPaths: string[];
  selectedHostKeys: string[];
}

export interface XshellImportResult {
  createdGroupCount: number;
  createdHostCount: number;
  createdSecretCount: number;
  skippedHostCount: number;
  warnings: XshellImportWarning[];
}

export interface TerminalAppearanceSettings {
  globalTerminalThemeId: GlobalTerminalThemeId;
  terminalFontFamily: TerminalFontFamilyId;
  terminalFontSize: number;
  terminalScrollbackLines: number;
  terminalLineHeight: number;
  terminalLetterSpacing: number;
  terminalMinimumContrastRatio: number;
  terminalAltIsMeta: boolean;
  terminalWebglEnabled: boolean;
}

// AppSettings는 사용자의 로컬 환경 설정을 표현한다.
export interface SftpBrowserColumnWidths {
  name: number;
  dateModified: number;
  size: number;
  kind: number;
}

export const DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS: SftpBrowserColumnWidths = {
  name: 360,
  dateModified: 168,
  size: 96,
  kind: 96
};

export const MIN_SFTP_BROWSER_COLUMN_WIDTHS: SftpBrowserColumnWidths = {
  name: 180,
  dateModified: 140,
  size: 72,
  kind: 72
};

const SFTP_BROWSER_COLUMN_KEYS: SftpBrowserColumnKey[] = ['name', 'dateModified', 'size', 'kind'];

export function normalizeSftpBrowserColumnWidths(
  value: Partial<Record<SftpBrowserColumnKey, unknown>> | null | undefined
): SftpBrowserColumnWidths {
  const source = value ?? {};
  return SFTP_BROWSER_COLUMN_KEYS.reduce<SftpBrowserColumnWidths>(
    (result, key) => {
      const nextValue = source[key];
      if (typeof nextValue !== 'number' || !Number.isFinite(nextValue)) {
        result[key] = DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS[key];
        return result;
      }
      result[key] = Math.max(MIN_SFTP_BROWSER_COLUMN_WIDTHS[key], Math.round(nextValue));
      return result;
    },
    { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS }
  );
}

export interface AppSettings extends TerminalAppearanceSettings {
  theme: AppTheme;
  sftpBrowserColumnWidths: SftpBrowserColumnWidths;
  sftpConflictPolicy?: SftpConflictPolicy;
  sftpPreserveMtime?: boolean;
  sftpPreservePermissions?: boolean;
  sessionReplayRetentionCount: number;
  serverUrl: string;
  serverUrlOverride?: string | null;
  dismissedUpdateVersion?: string | null;
  updatedAt: string;
}

export interface DesktopBootstrapSnapshot {
  hosts: HostRecord[];
  groups: GroupRecord[];
  tabs: TerminalTab[];
  settings: AppSettings;
  localHomePath: string;
  localHomeListing: DirectoryListing;
  portForwardSnapshot: PortForwardListSnapshot;
  dnsOverrides: DnsOverrideResolvedRecord[];
  knownHosts: KnownHostRecord[];
  activityLogs: ActivityLogRecord[];
  keychainEntries: SecretMetadataRecord[];
}

export interface DesktopSyncedWorkspaceSnapshot {
  hosts: HostRecord[];
  groups: GroupRecord[];
  settings: AppSettings;
  portForwardSnapshot: PortForwardListSnapshot;
  dnsOverrides: DnsOverrideResolvedRecord[];
  knownHosts: KnownHostRecord[];
  keychainEntries: SecretMetadataRecord[];
}

export interface TerminalPreferencesRecord {
  id: 'global-terminal';
  globalTerminalThemeId: GlobalTerminalThemeId;
  updatedAt: string;
}

// AuthState는 desktop 로그인 게이트와 세션 복구가 읽는 최소 상태다.
export interface AuthState {
  status: AuthStatus;
  session?: AuthSession | null;
  offline?: {
    expiresAt: string;
    lastOnlineAt: string;
    reason: string;
  } | null;
  errorMessage?: string | null;
}

// SyncStatus는 초기 hydrate와 이후 push 재시도를 UI/서비스가 추적하기 위한 상태다.
export interface SyncStatus {
  status: SyncBootstrapStatus;
  lastSuccessfulSyncAt?: string | null;
  pendingPush: boolean;
  errorMessage?: string | null;
  awsProfilesServerSupport?: AwsProfilesServerSupport;
}

// UpdateReleaseInfo는 GitHub Releases에서 읽어온 배포 메타데이터를 정규화한 형태다.
export interface UpdateReleaseInfo {
  version: string;
  releaseName?: string | null;
  releaseNotes?: string | null;
  publishedAt?: string | null;
}

// UpdateProgressInfo는 다운로드 진행률을 UI가 그대로 렌더링하기 위한 뷰 모델이다.
export interface UpdateProgressInfo {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

// UpdateState는 메인 프로세스 auto updater의 현재 상태 스냅샷이다.
export interface UpdateState {
  enabled: boolean;
  status: UpdateStatus;
  currentVersion: string;
  release?: UpdateReleaseInfo | null;
  progress?: UpdateProgressInfo | null;
  checkedAt?: string | null;
  dismissedVersion?: string | null;
  errorMessage?: string | null;
}

export interface UpdateEvent {
  state: UpdateState;
}

export interface DesktopWindowState {
  isMaximized: boolean;
}

export interface TerminalThemePreset {
  id: TerminalThemeId;
  title: string;
}

export type ManagedAwsProfileKind = 'static' | 'sso' | 'role';

export interface AwsProfileMetadataRecord {
  id: string;
  name: string;
  kind: ManagedAwsProfileKind;
  updatedAt: string;
}

interface ManagedAwsProfileBase {
  id: string;
  name: string;
  kind: ManagedAwsProfileKind;
  region?: string | null;
  updatedAt: string;
}

export interface ManagedAwsStaticProfilePayload extends ManagedAwsProfileBase {
  kind: 'static';
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ManagedAwsSsoProfilePayload extends ManagedAwsProfileBase {
  kind: 'sso';
  ssoStartUrl: string;
  ssoRegion: string;
  ssoAccountId: string;
  ssoRoleName: string;
}

export interface ManagedAwsRoleProfilePayload extends ManagedAwsProfileBase {
  kind: 'role';
  sourceProfileId: string;
  roleArn: string;
}

export type ManagedAwsProfilePayload =
  | ManagedAwsStaticProfilePayload
  | ManagedAwsSsoProfilePayload
  | ManagedAwsRoleProfilePayload;

export interface AwsProfileSummary {
  id: string | null;
  name: string;
}

export interface AwsExternalProfileImportInput {
  profileNames: string[];
}

export interface AwsExternalProfileImportResult {
  importedProfileNames: string[];
  skippedProfileNames: string[];
}

export interface AwsStaticProfileDraft {
  profileName: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string | null;
}

export interface AwsStaticProfileCreateInput extends AwsStaticProfileDraft {
  kind: "static";
}

export interface AwsSsoProfilePrepareInput {
  profileName: string;
  ssoStartUrl: string;
  ssoRegion: string;
  region?: string | null;
}

export interface AwsSsoProfileAccountOption {
  accountId: string;
  accountName: string;
  emailAddress?: string | null;
}

export interface AwsSsoProfileRoleOption {
  accountId: string;
  roleName: string;
}

export interface AwsSsoProfilePrepareResult {
  preparationToken: string;
  profileName: string;
  ssoSessionName: string;
  ssoStartUrl: string;
  ssoRegion: string;
  region?: string | null;
  accounts: AwsSsoProfileAccountOption[];
  rolesByAccountId: Record<string, AwsSsoProfileRoleOption[]>;
  defaultAccountId?: string | null;
  defaultRoleName?: string | null;
}

export interface AwsSsoProfileCreateInput extends AwsSsoProfilePrepareInput {
  kind: "sso";
  preparationToken: string;
  ssoSessionName: string;
  ssoAccountId: string;
  ssoRoleName: string;
}

export interface AwsRoleProfileCreateInput {
  kind: "role";
  profileName: string;
  sourceProfileId?: string | null;
  sourceProfileName: string;
  roleArn: string;
  region?: string | null;
}

export type AwsProfileCreateInput =
  | AwsStaticProfileCreateInput
  | AwsSsoProfileCreateInput
  | AwsRoleProfileCreateInput;

export interface AwsProfileUpdateInput extends AwsStaticProfileDraft {
  profileName: string;
}

export interface AwsProfileRenameInput {
  profileName: string;
  nextProfileName: string;
}

export type AwsProfileKind =
  | "static"
  | "sso"
  | "role"
  | "credential-process"
  | "unknown";

export const AWS_PROFILE_REGION_OPTIONS = [
  "af-south-1",
  "ap-east-1",
  "ap-east-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-6",
  "ap-southeast-7",
  "ca-central-1",
  "ca-west-1",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "il-central-1",
  "me-central-1",
  "me-south-1",
  "mx-central-1",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
] as const;

export interface AwsProfileStatus {
  id: string | null;
  profileName: string;
  available: boolean;
  isSsoProfile: boolean;
  isAuthenticated: boolean;
  configuredRegion?: string | null;
  accountId?: string | null;
  arn?: string | null;
  errorMessage?: string | null;
  missingTools?: string[];
}

export interface AwsProfileDetails extends AwsProfileStatus {
  kind: AwsProfileKind;
  maskedAccessKeyId?: string | null;
  hasSecretAccessKey: boolean;
  hasSessionToken: boolean;
  roleArn?: string | null;
  sourceProfileId?: string | null;
  sourceProfile?: string | null;
  credentialProcess?: string | null;
  ssoSession?: string | null;
  ssoStartUrl?: string | null;
  ssoRegion?: string | null;
  ssoAccountId?: string | null;
  ssoRoleName?: string | null;
  referencedByProfileNames: string[];
  orphanedSsoSessionName?: string | null;
}

export interface AwsEc2InstanceSummary {
  instanceId: string;
  name: string;
  availabilityZone?: string | null;
  platform?: string | null;
  privateIp?: string | null;
  state?: string | null;
  ssmAvailability: "ready" | "unavailable" | "unknown";
  ssmAvailabilityReason?: string | null;
}

export interface AwsEcsClusterSummary {
  clusterArn: string;
  clusterName: string;
  status: string;
  activeServicesCount: number;
  runningTasksCount: number;
  pendingTasksCount: number;
}

export interface AwsEcsClusterListItem {
  clusterArn: string;
  clusterName: string;
  status: string;
  activeServicesCount: number;
  runningTasksCount: number;
  pendingTasksCount: number;
}

export interface AwsEcsServicePortSummary {
  port: number;
  protocol: string;
}

export type AwsEcsServiceExposureKind = "alb" | "nlb" | "service-connect";

export interface AwsMetricHistoryPoint {
  timestamp: string;
  value: number | null;
}

export interface AwsEcsServiceSummary {
  serviceArn: string;
  serviceName: string;
  status: string;
  rolloutState?: string | null;
  rolloutStateReason?: string | null;
  desiredCount: number;
  runningCount: number;
  pendingCount: number;
  launchType?: string | null;
  capacityProviderSummary?: string | null;
  servicePorts: AwsEcsServicePortSummary[];
  exposureKinds: AwsEcsServiceExposureKind[];
  cpuUtilizationPercent?: number | null;
  memoryUtilizationPercent?: number | null;
  configuredCpu?: string | null;
  configuredMemory?: string | null;
  taskDefinitionArn?: string | null;
  taskDefinitionRevision?: number | null;
  latestEventMessage?: string | null;
  deployments?: AwsEcsDeploymentSummary[];
  events?: AwsEcsEventSummary[];
}

export interface AwsEcsDeploymentSummary {
  id: string;
  status: string;
  rolloutState?: string | null;
  rolloutStateReason?: string | null;
  desiredCount?: number | null;
  runningCount?: number | null;
  pendingCount?: number | null;
  taskDefinitionArn?: string | null;
  taskDefinitionRevision?: number | null;
  updatedAt?: string | null;
}

export interface AwsEcsEventSummary {
  id: string;
  message: string;
  createdAt?: string | null;
}

export interface AwsEcsServiceUtilizationSummary {
  serviceName: string;
  cpuUtilizationPercent: number | null;
  memoryUtilizationPercent: number | null;
  cpuHistory: AwsMetricHistoryPoint[];
  memoryHistory: AwsMetricHistoryPoint[];
}

export interface AwsEcsClusterSnapshot {
  profileName: string;
  region: string;
  cluster: AwsEcsClusterSummary;
  services: AwsEcsServiceSummary[];
  metricsWarning?: string | null;
  loadedAt: string;
}

export interface AwsEcsClusterUtilizationSnapshot {
  loadedAt: string;
  warning?: string | null;
  services: AwsEcsServiceUtilizationSummary[];
}

export interface AwsEcsTaskTunnelServiceSummary {
  serviceName: string;
  status: string;
  desiredCount: number;
  runningCount: number;
  pendingCount: number;
}

export interface AwsEcsTaskTunnelContainerSummary {
  containerName: string;
  ports: AwsEcsServicePortSummary[];
}

export interface AwsEcsTaskTunnelServiceDetails {
  serviceName: string;
  containers: AwsEcsTaskTunnelContainerSummary[];
}

export interface AwsEcsServiceTaskContainerSummary {
  containerName: string;
  lastStatus: string | null;
  runtimeId?: string | null;
}

export interface AwsEcsServiceTaskSummary {
  taskArn: string;
  taskId: string;
  lastStatus: string | null;
  enableExecuteCommand: boolean;
  containers: AwsEcsServiceTaskContainerSummary[];
}

export interface AwsEcsServiceLogSupport {
  containerName: string;
  supported: boolean;
  reason?: string | null;
  logGroupName?: string | null;
  logRegion?: string | null;
  logStreamPrefix?: string | null;
}

export interface AwsEcsServiceActionContainerSummary {
  containerName: string;
  ports: AwsEcsServicePortSummary[];
  execEnabled: boolean;
  logSupport: AwsEcsServiceLogSupport;
}

export interface AwsEcsServiceActionContext {
  serviceName: string;
  serviceArn: string;
  taskDefinitionArn?: string | null;
  taskDefinitionRevision?: number | null;
  containers: AwsEcsServiceActionContainerSummary[];
  runningTasks: AwsEcsServiceTaskSummary[];
  deployments: AwsEcsDeploymentSummary[];
  events: AwsEcsEventSummary[];
}

export interface AwsEcsServiceLogEntry {
  id: string;
  timestamp: string;
  message: string;
  ingestionTime?: string | null;
  logStreamName?: string | null;
  taskId?: string | null;
  containerName?: string | null;
}

export interface AwsEcsServiceLogsSnapshot {
  serviceName: string;
  entries: AwsEcsServiceLogEntry[];
  taskOptions: Array<{ taskArn: string; taskId: string }>;
  containerOptions: string[];
  followCursor?: string | null;
  loadedAt: string;
  unsupportedReason?: string | null;
}

export interface AwsHostSshInspectionInput {
  profileName: string;
  region: string;
  instanceId: string;
  availabilityZone?: string | null;
}

export interface AwsHostSshInspectionResult {
  sshPort: number | null;
  recommendedUsername: string | null;
  usernameCandidates: string[];
  status: 'ready' | 'error';
  errorMessage: string | null;
}

export interface WarpgateTargetSummary {
  id: string;
  name: string;
  kind: 'ssh';
}

export interface WarpgateConnectionInfo {
  baseUrl: string;
  sshHost: string;
  sshPort: number;
  username?: string | null;
}

export type WarpgateImportStatus =
  | 'opening-browser'
  | 'waiting-for-login'
  | 'loading-targets'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface WarpgateImportEvent {
  attemptId: string;
  status: WarpgateImportStatus;
  connectionInfo?: WarpgateConnectionInfo | null;
  targets?: WarpgateTargetSummary[] | null;
  errorMessage?: string | null;
}

export interface KeyboardInteractivePrompt {
  label: string;
  echo: boolean;
}

export interface KeyboardInteractiveChallenge {
  sessionId?: string;
  endpointId?: string;
  challengeId: string;
  attempt: number;
  name?: string | null;
  instruction: string;
  prompts: KeyboardInteractivePrompt[];
}

interface PortForwardRuleBaseRecord {
  id: string;
  label: string;
  hostId: string;
  transport: PortForwardTransport;
  bindAddress: string;
  bindPort: number;
  createdAt: string;
  updatedAt: string;
}

export interface SshPortForwardRuleRecord extends PortForwardRuleBaseRecord {
  transport: 'ssh';
  mode: PortForwardMode;
  targetHost?: string | null;
  targetPort?: number | null;
}

export interface AwsSsmPortForwardRuleRecord extends PortForwardRuleBaseRecord {
  transport: 'aws-ssm';
  targetKind: AwsSsmPortForwardTargetKind;
  targetPort: number;
  remoteHost?: string | null;
}

export interface EcsTaskPortForwardRuleRecord extends PortForwardRuleBaseRecord {
  transport: 'ecs-task';
  bindAddress: '127.0.0.1';
  serviceName: string;
  containerName: string;
  targetPort: number;
}

export interface ContainerPortForwardRuleRecord extends PortForwardRuleBaseRecord {
  transport: 'container';
  bindAddress: '127.0.0.1';
  containerId: string;
  containerName: string;
  containerRuntime: HostContainerRuntime;
  networkName: string;
  targetPort: number;
}

// PortForwardRuleRecord는 사용자가 저장한 포워딩 규칙 자체를 표현한다.
export type PortForwardRuleRecord =
  | SshPortForwardRuleRecord
  | AwsSsmPortForwardRuleRecord
  | EcsTaskPortForwardRuleRecord
  | ContainerPortForwardRuleRecord;

interface PortForwardDraftBase {
  label: string;
  hostId: string;
  transport: PortForwardTransport;
  bindAddress: string;
  bindPort: number;
}

export interface SshPortForwardDraft extends PortForwardDraftBase {
  transport: 'ssh';
  mode: PortForwardMode;
  targetHost?: string | null;
  targetPort?: number | null;
}

export interface AwsSsmPortForwardDraft extends PortForwardDraftBase {
  transport: 'aws-ssm';
  targetKind: AwsSsmPortForwardTargetKind;
  targetPort: number;
  remoteHost?: string | null;
}

export interface EcsTaskPortForwardDraft extends PortForwardDraftBase {
  transport: 'ecs-task';
  bindAddress: '127.0.0.1';
  serviceName: string;
  containerName: string;
  targetPort: number;
}

export interface ContainerPortForwardDraft extends PortForwardDraftBase {
  transport: 'container';
  bindAddress: '127.0.0.1';
  containerId: string;
  containerName: string;
  containerRuntime: HostContainerRuntime;
  networkName: string;
  targetPort: number;
}

// PortForwardDraft는 생성/수정 폼에서 사용하는 입력 전용 모델이다.
export type PortForwardDraft =
  | SshPortForwardDraft
  | AwsSsmPortForwardDraft
  | EcsTaskPortForwardDraft
  | ContainerPortForwardDraft;

// PortForwardRuntimeRecord는 현재 메모리에서 살아 있는 실행 상태 스냅샷이다.
export interface PortForwardRuntimeRecord {
  ruleId: string;
  hostId: string;
  transport: PortForwardTransport;
  mode?: PortForwardMode;
  method?: 'ssh-native' | 'ssh-session-proxy' | 'ssm-remote-host';
  bindAddress: string;
  bindPort: number;
  status: PortForwardStatus;
  message?: string;
  updatedAt: string;
  startedAt?: string;
}

export interface PortForwardRuntimeEvent {
  runtime: PortForwardRuntimeRecord;
}

export interface PortForwardListSnapshot {
  rules: PortForwardRuleRecord[];
  runtimes: PortForwardRuntimeRecord[];
}

export type DnsOverrideType = 'linked' | 'static';

interface DnsOverrideRecordBase {
  id: string;
  type: DnsOverrideType;
  hostname: string;
  createdAt: string;
  updatedAt: string;
}

export interface LinkedDnsOverrideRecord extends DnsOverrideRecordBase {
  type: 'linked';
  portForwardRuleId: string;
}

export interface StaticDnsOverrideRecord extends DnsOverrideRecordBase {
  type: 'static';
  address: string;
}

export type DnsOverrideRecord = LinkedDnsOverrideRecord | StaticDnsOverrideRecord;

interface DnsOverrideDraftBase {
  type: DnsOverrideType;
  hostname: string;
}

export interface LinkedDnsOverrideDraft extends DnsOverrideDraftBase {
  type: 'linked';
  portForwardRuleId: string;
}

export interface StaticDnsOverrideDraft extends DnsOverrideDraftBase {
  type: 'static';
  address: string;
}

export type DnsOverrideDraft = LinkedDnsOverrideDraft | StaticDnsOverrideDraft;

export type DnsOverrideResolvedRecord = (DnsOverrideRecord & {
  status: DnsOverrideStatus;
});

export function isLinkedDnsOverrideRecord(value: DnsOverrideRecord): value is LinkedDnsOverrideRecord {
  return value.type === 'linked';
}

export function isStaticDnsOverrideRecord(value: DnsOverrideRecord): value is StaticDnsOverrideRecord {
  return value.type === 'static';
}

export function isLinkedDnsOverrideDraft(value: DnsOverrideDraft): value is LinkedDnsOverrideDraft {
  return value.type === 'linked';
}

export function isStaticDnsOverrideDraft(value: DnsOverrideDraft): value is StaticDnsOverrideDraft {
  return value.type === 'static';
}

export function isSshPortForwardRuleRecord(rule: PortForwardRuleRecord): rule is SshPortForwardRuleRecord {
  return rule.transport === 'ssh';
}

export function isAwsSsmPortForwardRuleRecord(rule: PortForwardRuleRecord): rule is AwsSsmPortForwardRuleRecord {
  return rule.transport === 'aws-ssm';
}

export function isEcsTaskPortForwardRuleRecord(rule: PortForwardRuleRecord): rule is EcsTaskPortForwardRuleRecord {
  return rule.transport === 'ecs-task';
}

export function isContainerPortForwardRuleRecord(rule: PortForwardRuleRecord): rule is ContainerPortForwardRuleRecord {
  return rule.transport === 'container';
}

export function isSshPortForwardDraft(rule: PortForwardDraft): rule is SshPortForwardDraft {
  return rule.transport === 'ssh';
}

export function isAwsSsmPortForwardDraft(rule: PortForwardDraft): rule is AwsSsmPortForwardDraft {
  return rule.transport === 'aws-ssm';
}

export function isEcsTaskPortForwardDraft(rule: PortForwardDraft): rule is EcsTaskPortForwardDraft {
  return rule.transport === 'ecs-task';
}

export function isContainerPortForwardDraft(rule: PortForwardDraft): rule is ContainerPortForwardDraft {
  return rule.transport === 'container';
}

export function isLoopbackBindAddress(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1' || normalized.startsWith('127.');
}

export function isDnsOverrideEligiblePortForwardRule(rule: PortForwardRuleRecord): boolean {
  if (rule.transport === 'aws-ssm') {
    return isLoopbackBindAddress(rule.bindAddress);
  }
  if (rule.transport === 'ssh') {
    return rule.mode === 'local' && isLoopbackBindAddress(rule.bindAddress);
  }
  return false;
}

// KnownHostRecord는 신뢰된 호스트 키 한 건을 나타낸다.
export interface KnownHostRecord {
  id: string;
  host: string;
  port: number;
  algorithm: string;
  publicKeyBase64: string;
  fingerprintSha256: string;
  createdAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

// HostKeyProbeResult는 연결 전 서버에서 읽어온 실제 호스트 키와 저장된 신뢰 레코드 비교 결과다.
export interface HostKeyProbeResult {
  hostId: string;
  hostLabel: string;
  host: string;
  port: number;
  targetDescription?: string | null;
  algorithm: string;
  publicKeyBase64: string;
  fingerprintSha256: string;
  status: KnownHostTrustStatus;
  existing?: KnownHostRecord | null;
}

// KnownHostTrustInput은 probe 결과에서 저장에 필요한 필드만 추려낸 형태다.
export interface KnownHostTrustInput {
  hostId: string;
  hostLabel: string;
  host: string;
  port: number;
  algorithm: string;
  publicKeyBase64: string;
  fingerprintSha256: string;
}

// ActivityLogRecord는 앱 활동 로그 화면이 그대로 렌더링하는 구조다.
export interface SessionLifecycleLogMetadata {
  sessionId: string;
  hostId: string;
  hostLabel: string;
  title: string;
  connectionDetails?: string | null;
  connectionKind: SessionConnectionKind;
  connectedAt: string;
  disconnectedAt?: string | null;
  durationMs?: number | null;
  status: SessionLifecycleStatus;
  disconnectReason?: string | null;
  recordingId?: string | null;
  hasReplay?: boolean | null;
}

export interface PortForwardLifecycleLogMetadata {
  ruleId: string;
  ruleLabel: string;
  hostId: string;
  hostLabel: string;
  transport: PortForwardTransport;
  mode: PortForwardMode;
  bindAddress: string;
  bindPort: number;
  targetSummary: string;
  startedAt: string;
  stoppedAt?: string | null;
  durationMs?: number | null;
  status: PortForwardLifecycleStatus;
  endReason?: string | null;
}

export interface SessionReplayOutputEntry {
  type: 'output';
  atMs: number;
  dataBase64: string;
}

export interface SessionReplayResizeEntry {
  type: 'resize';
  atMs: number;
  cols: number;
  rows: number;
}

export type SessionReplayEntry =
  | SessionReplayOutputEntry
  | SessionReplayResizeEntry;

export interface SessionReplayRecording {
  recordingId: string;
  sessionId: string;
  hostId: string;
  hostLabel: string;
  title: string;
  connectionDetails?: string | null;
  connectionKind: SessionConnectionKind;
  connectedAt: string;
  disconnectedAt: string;
  durationMs: number;
  initialCols: number;
  initialRows: number;
  entries: SessionReplayEntry[];
}

export interface ActivityLogRecord {
  id: string;
  level: ActivityLogLevel;
  category: ActivityLogCategory;
  kind?: ActivityLogKind;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt?: string;
}

// SecretMetadataRecord는 원문 secret 없이 저장 위치와 존재 여부만 표현한다.
export interface SecretMetadataRecord {
  secretRef: string;
  label: string;
  hasPassword: boolean;
  hasPassphrase: boolean;
  hasManagedPrivateKey: boolean;
  hasCertificate: boolean;
  linkedHostCount: number;
  updatedAt: string;
}

export type SshCertificateValidityStatus =
  | 'valid'
  | 'expired'
  | 'not_yet_valid'
  | 'invalid';

export interface SshCertificateInfo {
  status: SshCertificateValidityStatus;
  validAfter?: string | null;
  validBefore?: string | null;
  principals?: string[];
  keyId?: string | null;
  serial?: string | null;
}

// ManagedSecretPayload는 서버 sync와 로컬 keychain이 공유하는 실제 secret 본문이다.
// privateKeyPem은 새 기기에서도 바로 SSH 접속이 가능하도록 PEM 전체를 저장한다.
export interface ManagedSecretPayload {
  secretRef: string;
  label: string;
  password?: string;
  passphrase?: string;
  privateKeyPem?: string;
  certificateText?: string;
  updatedAt: string;
}

export interface LoadedManagedSecretPayload extends ManagedSecretPayload {
  certificateInfo?: SshCertificateInfo;
}

export interface LinkedHostSummary {
  id: string;
  label: string;
  hostname: string;
  username: string;
}

// FileEntry는 local/remote 파일 브라우저가 공통으로 쓰는 단일 파일 메타데이터 모델이다.
export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: string;
  kind: FileEntryKind;
  permissions?: string;
  uid?: number;
  gid?: number;
  owner?: string;
  group?: string;
}

// DirectoryListing은 특정 경로의 목록 응답을 표현한다.
export interface DirectoryListing {
  path: string;
  entries: FileEntry[];
  warnings?: string[];
}

export interface FileSystemRoot {
  label: string;
  path: string;
}

// SftpEndpointSummary는 현재 패널이 붙어 있는 remote endpoint 정보를 표현한다.
export interface SftpEndpointSummary {
  id: string;
  kind: 'remote';
  hostId: string;
  title: string;
  path: string;
  connectedAt: string;
  sudoStatus?: SftpSudoStatus;
}

export type SftpSudoStatus =
  | 'unknown'
  | 'probing'
  | 'root'
  | 'passwordless'
  | 'passwordRequired'
  | 'unavailable';

export interface SftpPrincipal {
  kind: 'user' | 'group';
  name: string;
  id: number;
  displayName?: string;
}

export interface SftpHostSelectionState {
  query: string;
  selectedHostId?: string | null;
}

export interface SftpPaneState {
  id: SftpPaneId;
  sourceKind: SftpEndpointKind;
  currentPath: string;
  listing?: DirectoryListing | null;
  endpoint?: SftpEndpointSummary | null;
  isLoading: boolean;
  filterQuery: string;
  history: string[];
  historyIndex: number;
  selectedPaths: string[];
  hostSelection: SftpHostSelectionState;
  errorMessage?: string | null;
}

export interface TransferJob {
  id: string;
  sourceLabel: string;
  targetLabel: string;
  itemCount: number;
  bytesTotal: number;
  bytesCompleted: number;
  speedBytesPerSecond?: number | null;
  etaSeconds?: number | null;
  status: 'queued' | 'running' | 'paused' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  activeItemName?: string | null;
  errorMessage?: string | null;
  errorCode?: 'permission_denied' | 'not_found' | 'operation_unsupported' | 'connection_lost' | 'unknown';
  errorOperation?: string | null;
  errorPath?: string | null;
  errorItemName?: string | null;
  detailMessage?: string | null;
  completedItemCount?: number;
  failedItemCount?: number;
  failedItems?: TransferFailedItem[];
  updatedAt: string;
  request?: TransferStartInput;
}

export interface TransferFailedItem {
  item: TransferItemInput;
  errorMessage: string;
  errorCode?: TransferJob['errorCode'];
  errorOperation?: string | null;
  errorPath?: string | null;
}

export interface TransferJobEvent {
  job: TransferJob;
}

export interface SftpConnectionProgressEvent {
  endpointId: string;
  hostId: string;
  stage: SftpConnectionStage;
  message: string;
  reasonCode?: AwsSftpDiagnosticReasonCode;
  diagnosticId?: string;
  details?: AwsSftpDiagnosticDetails;
}

export interface ContainerConnectionProgressEvent {
  endpointId: string;
  hostId: string;
  stage: ConnectionProgressStage;
  message: string;
}

export interface HostContainerSummary {
  id: string;
  name: string;
  runtime: HostContainerRuntime;
  image: string;
  status: string;
  createdAt: string;
  ports: string;
}

export interface HostContainerListResult {
  hostId: string;
  runtime: HostContainerRuntime | null;
  unsupportedReason?: string | null;
  containers: HostContainerSummary[];
}

export interface HostContainerMountSummary {
  type: string;
  source: string;
  destination: string;
  mode?: string | null;
  readOnly: boolean;
}

export interface HostContainerNetworkSummary {
  name: string;
  ipAddress?: string | null;
  aliases: string[];
}

export interface HostContainerPortBinding {
  hostIp?: string | null;
  hostPort?: number | null;
}

export interface HostContainerPortOption {
  containerPort: number;
  protocol: string;
  publishedBindings: HostContainerPortBinding[];
}

export interface HostContainerDetails {
  id: string;
  name: string;
  runtime: HostContainerRuntime;
  image: string;
  status: string;
  createdAt: string;
  command: string;
  entrypoint: string;
  mounts: HostContainerMountSummary[];
  networks: HostContainerNetworkSummary[];
  ports: HostContainerPortOption[];
  environment: Array<{ key: string; value: string }>;
  labels: Array<{ key: string; value: string }>;
}

export interface HostContainerLogsSnapshot {
  hostId: string;
  containerId: string;
  runtime: HostContainerRuntime;
  lines: string[];
  cursor: string | null;
}

export interface HostContainerStatsSample {
  hostId: string;
  containerId: string;
  runtime: HostContainerRuntime;
  recordedAt: string;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
}

export interface HostContainerStatsSeries {
  hostId: string;
  containerId: string;
  samples: HostContainerStatsSample[];
}

export interface HostContainerLogSearchResult {
  hostId: string;
  containerId: string;
  runtime: HostContainerRuntime;
  query: string;
  lines: string[];
  matchCount: number;
}

export type TransferEndpointRef =
  | {
      kind: 'local';
      path: string;
    }
  | {
      kind: 'remote';
      path: string;
      endpointId: string;
    };

export interface TransferItemInput {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

export interface TransferStartInput {
  source: TransferEndpointRef;
  target: TransferEndpointRef;
  items: TransferItemInput[];
  conflictResolution: ConflictResolution;
  preserveMetadata?: {
    mtime?: boolean;
    permissions?: boolean;
  };
  retryOfJobId?: string;
}

export type TerminalConnectionStage =
  | ConnectionProgressStage
  | 'host-key-check'
  | 'awaiting-host-trust'
  | 'retrying-session'
  | 'connecting'
  | 'awaiting-credentials'
  | 'waiting-interactive-auth'
  | 'waiting-shell';

export type TerminalConnectionBlockingKind = 'none' | 'dialog' | 'panel' | 'browser';
export type TerminalSessionSource = 'host' | 'local';
export type SessionShareStatus = 'inactive' | 'starting' | 'active' | 'error';
export type SessionShareSnapshotKind = 'refresh' | 'resync';

export interface SessionShareTerminalAppearance {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
}

export interface SessionShareViewportPx {
  width: number;
  height: number;
}

export interface SessionShareState {
  status: SessionShareStatus;
  shareUrl: string | null;
  inputEnabled: boolean;
  viewerCount: number;
  errorMessage?: string | null;
}

export interface SessionShareStartInput {
  sessionId: string;
  title: string;
  transport: PortForwardTransport;
  snapshot: string;
  cols: number;
  rows: number;
  terminalAppearance: SessionShareTerminalAppearance;
  viewportPx: SessionShareViewportPx | null;
}

export interface SessionShareSnapshotInput {
  sessionId: string;
  snapshot: string;
  cols: number;
  rows: number;
  kind: SessionShareSnapshotKind;
  terminalAppearance: SessionShareTerminalAppearance;
  viewportPx: SessionShareViewportPx | null;
}

export interface SessionShareInputToggleInput {
  sessionId: string;
  inputEnabled: boolean;
}

export interface SessionShareEvent {
  sessionId: string;
  state: SessionShareState;
}

export type SessionShareChatSenderRole = 'owner' | 'viewer';

export interface SessionShareChatMessage {
  id: string;
  nickname: string;
  senderRole: SessionShareChatSenderRole;
  text: string;
  sentAt: string;
}

export const SESSION_SHARE_CHAT_HISTORY_LIMIT = 50;

export interface SessionShareChatEvent {
  sessionId: string;
  message: SessionShareChatMessage;
}

export interface SessionShareOwnerChatSnapshot {
  sessionId: string;
  title: string;
  ownerNickname: string;
  state: SessionShareState;
  messages: SessionShareChatMessage[];
}

export type SessionShareControlSignal = 'interrupt' | 'suspend' | 'quit';

export type SessionShareOwnerMessage =
  | {
      type: 'hello';
      title: string;
      hostLabel: string;
      transport: PortForwardTransport;
      cols: number;
      rows: number;
      snapshot: string;
      terminalAppearance: SessionShareTerminalAppearance;
      viewportPx: SessionShareViewportPx | null;
    }
  | {
      type: 'output';
      data: string;
    }
  | {
      type: 'resize';
      cols: number;
      rows: number;
      terminalAppearance: SessionShareTerminalAppearance;
      viewportPx: SessionShareViewportPx | null;
    }
  | {
      type: 'snapshot';
      snapshot: string;
      cols: number;
      rows: number;
      snapshotKind: SessionShareSnapshotKind;
      terminalAppearance: SessionShareTerminalAppearance;
      viewportPx: SessionShareViewportPx | null;
    }
  | {
      type: 'input-enabled';
      inputEnabled: boolean;
    }
  | {
      type: 'chat-send';
      text: string;
    }
  | {
      type: 'chat-message';
      message: SessionShareChatMessage;
    }
  | {
      type: 'session-ended';
    };

export type SessionShareViewerMessage =
  | {
      type: 'init';
      title: string;
      hostLabel: string;
      transport: PortForwardTransport;
      cols: number;
      rows: number;
      inputEnabled: boolean;
      viewerCount: number;
      terminalAppearance: SessionShareTerminalAppearance;
      viewportPx: SessionShareViewportPx | null;
    }
  | {
      type: 'snapshot-init';
      snapshot: string;
      cols: number;
      rows: number;
      terminalAppearance: SessionShareTerminalAppearance;
      viewportPx: SessionShareViewportPx | null;
    }
  | {
      type: 'snapshot-resync';
      snapshot: string;
      cols: number;
      rows: number;
      terminalAppearance: SessionShareTerminalAppearance;
      viewportPx: SessionShareViewportPx | null;
    }
  | {
      type: 'replay';
      entries: string[];
    }
  | {
      type: 'output';
      data: string;
    }
  | {
      type: 'chat-history';
      messages: SessionShareChatMessage[];
    }
  | {
      type: 'chat-message';
      message: SessionShareChatMessage;
    }
  | {
      type: 'resize';
      cols: number;
      rows: number;
      terminalAppearance: SessionShareTerminalAppearance;
      viewportPx: SessionShareViewportPx | null;
    }
  | {
      type: 'input-enabled';
      inputEnabled: boolean;
    }
  | {
      type: 'viewer-count';
      viewerCount: number;
    }
  | {
      type: 'share-ended';
      message: string;
    };

export type SessionShareViewerClientMessage =
  | {
      type: 'input';
      encoding: 'utf8' | 'binary';
      data: string;
    }
  | {
      type: 'control-signal';
      signal: SessionShareControlSignal;
    }
  | {
      type: 'chat-profile';
      nickname: string;
    }
  | {
      type: 'chat-send';
      text: string;
    };

export interface TerminalConnectionProgress {
  stage: TerminalConnectionStage;
  message: string;
  blockingKind: TerminalConnectionBlockingKind;
  retryable: boolean;
}

export interface TerminalTab {
  id: string;
  sessionId: string;
  source: TerminalSessionSource;
  hostId: string | null;
  title: string;
  shellKind?: string;
  status: 'pending' | 'connecting' | 'connected' | 'disconnecting' | 'closed' | 'error';
  errorMessage?: string;
  connectionProgress?: TerminalConnectionProgress | null;
  sessionShare?: SessionShareState | null;
  hasReceivedOutput?: boolean;
  lastEventAt: string;
}
