import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AWS_PROFILE_REGION_OPTIONS } from "@shared";
import type {
  AwsEc2InstanceSummary,
  AwsEcsClusterListItem,
  AwsEcsClusterSnapshot,
  AwsEcsDeploymentSummary,
  AwsEcsEventSummary,
  AwsEcsServiceActionContext,
  AwsEcsServiceActionContainerSummary,
  AwsEcsTaskTunnelContainerSummary,
  AwsEcsTaskTunnelServiceDetails,
  AwsEcsTaskTunnelServiceSummary,
  AwsEcsClusterUtilizationSnapshot,
  AwsEcsServiceLogsSnapshot,
  AwsEcsServiceLogEntry,
  AwsEcsServiceTaskSummary,
  AwsMetricHistoryPoint,
  AwsEcsServiceExposureKind,
  AwsEcsServicePortSummary,
  AwsEcsServiceSummary,
  AwsHostSshInspectionInput,
  AwsHostSshInspectionResult,
  AwsProfileCreateInput,
  AwsProfileDetails,
  AwsExternalProfileImportInput,
  AwsExternalProfileImportResult,
  AwsProfileRegionUpdateInput,
  AwsProfileKind,
  AwsProfileRenameInput,
  AwsSsoProfileAccountOption,
  AwsSsoProfilePrepareInput,
  AwsSsoProfilePrepareResult,
  AwsSsoProfileRoleOption,
  AwsProfileStatus,
  AwsProfileSummary,
  AwsProfileUpdateInput,
  ManagedAwsProfilePayload,
} from "@shared";
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  EC2InstanceConnectClient,
  SendSSHPublicKeyCommand,
} from "@aws-sdk/client-ec2-instance-connect";
import {
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ExecuteCommandCommand,
  ListClustersCommand,
  ListServicesCommand,
  ListTasksCommand,
} from "@aws-sdk/client-ecs";
import {
  DescribeInstanceInformationCommand,
  GetCommandInvocationCommand,
  SendCommandCommand,
  SSMClient,
  StartSessionCommand,
} from "@aws-sdk/client-ssm";
import {
  ListAccountRolesCommand,
  ListAccountsCommand,
  SSOClient,
} from "@aws-sdk/client-sso";
import {
  AssumeRoleCommand,
  GetCallerIdentityCommand,
  STSClient,
} from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { performAwsSsoLogin } from "./aws-sso-login";
import { AwsProfileRepository } from "./database";
import {
  copyAwsProfileConfigSectionBetweenDocuments,
  copyAwsProfileCredentialsSectionBetweenDocuments,
  copyAwsSsoSessionSectionBetweenDocuments,
  deleteAwsProfileFromDocuments,
  getDefaultAwsProfileRootDir,
  getManagedAwsHomeDir,
  getManagedAwsProfileRootDir,
  getAwsSsoSessionValues,
  inspectAwsProfileDocuments,
  listAwsProfileNames,
  loadAwsProfileDocuments,
  removeAwsProfileKeyFromDocuments,
  setAwsProfileKeyValueInDocuments,
  setAwsSsoSessionKeyValueInDocuments,
  writeAwsProfileDocuments,
} from "./aws-profile-files";
import { t } from "./i18n";

const REGION_DISCOVERY_REGION = "us-east-1";
const ECS_LOG_INITIAL_LOOKBACK_MS = 30 * 60 * 1000;
const AWS_SSO_REGISTRATION_SCOPES = "sso:account:access";
const SSO_PREPARATION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_AWS_EC2_REGIONS = [
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
  "us-gov-east-1",
  "us-gov-west-1",
  "us-west-1",
  "us-west-2",
];

function isE2EFakeAwsSessionEnabled(): boolean {
  const mode = process.env.DOLSSH_E2E_FAKE_AWS_SESSION;
  return mode === "1" || mode === "process";
}

interface AwsPendingSsoPreparation {
  preparationToken: string;
  profileName: string;
  ssoSessionName: string;
  ssoStartUrl: string;
  ssoRegion: string;
  region: string | null;
  awsRootDir: string;
  homeDir: string;
  expiresAt: number;
  accounts: AwsSsoProfileAccountOption[];
  rolesByAccountId: Record<string, AwsSsoProfileRoleOption[]>;
}

interface AwsSsoTokenCacheEntry {
  accessToken?: string;
  expiresAt?: string;
}

type AwsEc2SsmAvailability = AwsEc2InstanceSummary["ssmAvailability"];

interface SsmManagedInstanceLookupResult {
  readyInstanceIds: Set<string>;
  unavailableInstanceStatuses: Map<string, string | null>;
  unknownReason: string | null;
}

function resolveSsmLookupUnknownReason(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  // 들어오는 오류 메시지를 판정하는 패턴이라 한국어 문구를 지우면 안 된다 — 예전
  // 메시지와 서버가 보내는 문구까지 잡아야 하므로 두 언어를 모두 유지한다.
  if (/제한 시간을 초과|timed?\s*out|timeout/i.test(message)) {
    return t('aws.ssm.statusTimeout');
  }
  if (/ssm:DescribeInstanceInformation|AccessDenied|UnauthorizedOperation/i.test(message)) {
    return t('aws.ssm.statusForbidden');
  }
  if (
    /Unable to locate credentials|The security token included in the request is invalid|ExpiredToken|SSO login/i.test(
      message,
    )
  ) {
    return t('aws.credentials.checkFailed');
  }
  return t('aws.ssm.statusUnknown');
}

function isDescribeRegionsPermissionDenied(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("unauthorizedoperation") ||
    normalized.includes("accessdenied") ||
    (normalized.includes("not authorized") &&
      normalized.includes("describeregions"))
  );
}

function resolveUnavailableSsmReason(input: {
  state?: string | null;
  pingStatus?: string | null;
}): string {
  const normalizedState = input.state?.trim().toLowerCase() ?? "";
  const pingStatus = input.pingStatus?.trim() ?? "";
  const normalizedPingStatus = pingStatus.toLowerCase();
  if (normalizedState && normalizedState !== "running") {
    return t('aws.instanceState', { state: normalizedState });
  }
  if (normalizedPingStatus === "connectionlost") {
    return t('aws.ssm.connectionLost');
  }
  if (normalizedPingStatus === "inactive") {
    return t('aws.ssm.connectionInactive');
  }
  if (pingStatus) {
    return t('aws.ssm.pingStatus', { status: pingStatus });
  }
  return t('aws.ssm.notManaged');
}

function isSsmPingStatusOnline(status?: string | null): boolean {
  return status?.trim().toLowerCase() === "online";
}

export interface AwsSessionEnvSpec {
  env: Record<string, string>;
  unsetEnv: string[];
}

const DEFAULT_AWS_COMMAND_TIMEOUT_MS = 30_000;
const AWS_PROFILE_DETAILS_STATUS_TIMEOUT_MS = 8_000;
const AWS_EC2_LIST_COMMAND_TIMEOUT_MS = 20_000;
const AWS_SSM_AVAILABILITY_LOOKUP_TIMEOUT_MS = 12_000;
const AWS_SSM_AVAILABILITY_COMMAND_TIMEOUT_MS = 5_000;
const AWS_SSH_METADATA_PROBE_TIMEOUT_MS = 12_000;
const AWS_SSH_METADATA_COMMAND_TIMEOUT_MS = 5_000;
const AWS_SSH_METADATA_POLL_INTERVAL_MS = 1_000;
function splitAwsSessionEnvSpec(
  envPatch: Record<string, string | null | undefined>,
): AwsSessionEnvSpec {
  const env: Record<string, string> = {};
  const unsetEnv: string[] = [];

  for (const [key, value] of Object.entries(envPatch)) {
    if (value === null || value === undefined) {
      unsetEnv.push(key);
      continue;
    }
    env[key] = value;
  }

  return {
    env,
    unsetEnv,
  };
}

function parseJson<T>(raw: string, fallbackMessage: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(fallbackMessage);
  }
}

// GetCommandInvocation can throw InvocationDoesNotExist for a short window after
// SendCommand returns, before the invocation is registered. The CLI's process spawn
// latency used to hide this race; with the SDK the first poll hits it reliably.
class SsmInvocationNotReadyError extends Error {
  constructor() {
    super(t('aws.ssm.invocationPending'));
    this.name = "SsmInvocationNotReadyError";
  }
}

function isSsmInvocationDoesNotExistError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "InvocationDoesNotExist" ||
      error.message.includes("InvocationDoesNotExist"))
  );
}

function normalizeAwsSdkError(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message.trim() : "";
  if (!message) {
    const name = error instanceof Error ? error.name.trim() : "";
    if (name && name !== "Error") {
      return new Error(`${fallback} (${name})`);
    }
    return new Error(fallback);
  }
  if (
    /The SSO session associated with this profile has expired/i.test(message) ||
    /The SSO session associated with this profile is invalid/i.test(message)
  ) {
    return new Error(t('aws.sso.expired'));
  }
  if (/Profile .+ was not found\./i.test(message)) {
    return new Error(
      t('aws.profile.noneManaged'),
    );
  }
  return new Error(message);
}

function parseSsoCacheExpirationTimestamp(raw: string): number | null {
  try {
    const payload = JSON.parse(raw) as AwsSsoTokenCacheEntry;
    const expiresAt = payload.expiresAt ? Date.parse(payload.expiresAt) : Number.NaN;
    return Number.isFinite(expiresAt) ? expiresAt : null;
  } catch {
    return null;
  }
}

async function copyDirectoryRecursive(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  await mkdir(targetDir, { recursive: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

type AwsProfileFlowErrorContext =
  | "static-validation"
  | "role-validation"
  | "sso-login"
  | "sso-account-list"
  | "sso-role-list"
  | "sso-final-validation";

function extractAwsCliErrorCode(message: string): string | null {
  const match = message.match(
    /An error occurred \(([^)]+)\) when calling the [^:]+ operation:/i,
  );
  return match?.[1]?.trim() || null;
}

function isAwsSsoSessionInvalidMessage(message: string): boolean {
  return /sso session associated with this profile has expired|sso token.+expired|aws sso login|token has expired|session has expired|otherwise invalid/iu.test(
    message,
  );
}

// Re-encodes an SDK error into the CLI stderr wire format so the shared
// context-specific mapping below (which parses "(Code)") applies to SDK
// errors too — the SDK error name is the same code the CLI printed.
function normalizeAwsProfileFlowSdkError(
  error: unknown,
  fallback: string,
  context: AwsProfileFlowErrorContext,
): Error {
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return new Error(t('aws.error.requestTimeout', { message: fallback }));
  }
  const name =
    error instanceof Error && error.name.trim() && error.name.trim() !== "Error"
      ? error.name.trim()
      : "";
  const message = error instanceof Error ? error.message.trim() : "";
  const synthesized =
    name && message
      ? `An error occurred (${name}) when calling the ${context} operation: ${message}`
      : message || name;
  return normalizeAwsProfileFlowError(synthesized, fallback, context);
}

function normalizeAwsProfileFlowError(
  stderr: string,
  fallback: string,
  context: AwsProfileFlowErrorContext,
): Error {
  const message = stderr.trim();
  if (!message) {
    return new Error(fallback);
  }

  const errorCode = extractAwsCliErrorCode(message);

  if (context === "static-validation") {
    if (
      errorCode === "SignatureDoesNotMatch" ||
      /signature does not match the signature you provided/i.test(message)
    ) {
      return new Error(
        t('aws.credentials.badSecret'),
      );
    }
    if (
      errorCode === "InvalidClientTokenId" ||
      errorCode === "UnrecognizedClientException" ||
      /The security token included in the request is invalid/i.test(message)
    ) {
      return new Error(
        t('aws.credentials.badAccessKey'),
      );
    }
  }

  if (context === "role-validation") {
    if (
      isAwsSsoSessionInvalidMessage(message) ||
      /retrieving token from sso|refresh failed/i.test(message)
    ) {
      return new Error(
        t('aws.sso.sourceProfileInvalid'),
      );
    }
    if (
      (errorCode === "AccessDenied" || /AccessDenied/i.test(message)) &&
      /(AssumeRole|assume role|sts:AssumeRole)/i.test(message)
    ) {
      return new Error(
        t('aws.role.assumeDenied'),
      );
    }
    if (
      /Parameter validation failed:.*RoleArn/i.test(message) ||
      ((errorCode === "ValidationError" || /ValidationError/i.test(message)) &&
        /(role.?arn|AssumeRole|arn:aws:iam::)/i.test(message)) ||
      /invalid arn/i.test(message)
    ) {
      return new Error(
        t('aws.role.arnInvalid'),
      );
    }
  }

  if (context === "sso-login") {
    if (
      isAwsSsoSessionInvalidMessage(message) ||
      /(InvalidRequest|authorization_pending|device authorization|browser|expired)/i.test(
        message,
      )
    ) {
      return new Error(
        t('aws.sso.loginFailedDetail'),
      );
    }
  }

  if (context === "sso-account-list" || context === "sso-role-list") {
    if (
      isAwsSsoSessionInvalidMessage(message) ||
      /(AccessDenied|Unauthorized|Forbidden|InvalidRequest|expired|token)/i.test(
        message,
      )
    ) {
      return new Error(
        t('aws.sso.listFailed'),
      );
    }
  }

  if (context === "sso-final-validation") {
    if (
      isAwsSsoSessionInvalidMessage(message) ||
      /(AccessDenied|Unauthorized|Forbidden|expired|token|PermissionSet|Role)/i.test(
        message,
      )
    ) {
      return new Error(
        t('aws.sso.authIncomplete'),
      );
    }
  }

  return new Error(message);
}

function maskAwsAccessKeyId(value?: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= 8) {
    return trimmed;
  }
  return `${trimmed.slice(0, 4)}${"*".repeat(trimmed.length - 8)}${trimmed.slice(-4)}`;
}

function normalizeAwsProfileName(
  input: string,
  fieldLabelKey = 'aws.field.profileName',
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(t('aws.field.required', { field: t(fieldLabelKey) }));
  }
  if (/[\r\n\]]/.test(trimmed)) {
    throw new Error(t('aws.field.invalidChars', { field: t(fieldLabelKey) }));
  }
  return trimmed;
}

interface Ec2DescribeInstancesPayload {
  Reservations?: Array<{
    Instances?: Array<{
      InstanceId?: string;
      Platform?: string;
      PlatformDetails?: string;
      PrivateIpAddress?: string;
      Placement?: { AvailabilityZone?: string };
      State?: { Name?: string };
      Tags?: Array<{ Key?: string; Value?: string }>;
    }>;
  }>;
}

interface EcsListClustersPayload {
  clusterArns?: string[];
  nextToken?: string;
}

interface EcsDescribeClustersPayload {
  clusters?: Array<{
    clusterArn?: string;
    clusterName?: string;
    status?: string;
    activeServicesCount?: number;
    runningTasksCount?: number;
    pendingTasksCount?: number;
  }>;
}

interface EcsListServicesPayload {
  serviceArns?: string[];
  nextToken?: string;
}

interface EcsDescribeServicesPayload {
  services?: Array<{
    serviceArn?: string;
    serviceName?: string;
    status?: string;
    desiredCount?: number;
    runningCount?: number;
    pendingCount?: number;
    launchType?: string;
    capacityProviderStrategy?: Array<{
      capacityProvider?: string;
      weight?: number;
      base?: number;
    }>;
    loadBalancers?: Array<{
      loadBalancerName?: string;
      targetGroupArn?: string;
      containerName?: string;
      containerPort?: number;
    }>;
    serviceConnectConfiguration?: {
      enabled?: boolean;
    };
    deployments?: Array<{
      status?: string;
      rolloutState?: string;
      rolloutStateReason?: string;
      desiredCount?: number;
      runningCount?: number;
      pendingCount?: number;
      taskDefinition?: string;
      updatedAt?: string;
      createdAt?: string;
      id?: string;
    }>;
    taskDefinition?: string;
    events?: Array<{
      message?: string;
      createdAt?: string;
    }>;
  }>;
}

interface EcsTaskDefinitionPayload {
  taskDefinition?: {
    taskDefinitionArn?: string;
    revision?: number;
    cpu?: string;
    memory?: string;
    containerDefinitions?: Array<{
      name?: string;
      cpu?: number;
      memory?: number;
      memoryReservation?: number;
      portMappings?: Array<{
        containerPort?: number;
        hostPort?: number;
        protocol?: string;
      }>;
      logConfiguration?: {
        logDriver?: string;
        options?: Record<string, string>;
      };
    }>;
  };
}

interface CloudWatchGetMetricDataPayload {
  MetricDataResults?: Array<{
    Id?: string;
    Timestamps?: string[];
    Values?: number[];
  }>;
}

interface EcsListTasksPayload {
  taskArns?: string[];
  nextToken?: string;
}

interface EcsDescribeTasksPayload {
  tasks?: Array<{
    taskArn?: string;
    lastStatus?: string;
    enableExecuteCommand?: boolean;
    startedAt?: string;
    containers?: Array<{
      name?: string;
      runtimeId?: string;
      lastStatus?: string;
    }>;
  }>;
}

interface CloudWatchLogsFilterEventsPayload {
  events?: Array<{
    eventId?: string;
    timestamp?: number;
    ingestionTime?: number;
    message?: string;
    logStreamName?: string;
  }>;
  nextToken?: string;
}

interface EcsServiceUtilizationMetrics {
  cpuUtilizationPercent: number | null;
  memoryUtilizationPercent: number | null;
  cpuHistory: AwsMetricHistoryPoint[];
  memoryHistory: AwsMetricHistoryPoint[];
}

type EcsContainerDefinition = NonNullable<
  NonNullable<EcsTaskDefinitionPayload["taskDefinition"]>["containerDefinitions"]
>[number];

function toInstanceSummary(
  instance: NonNullable<
    NonNullable<Ec2DescribeInstancesPayload["Reservations"]>[number]["Instances"]
  >[number],
  input?: {
    ssmAvailability?: AwsEc2SsmAvailability;
    ssmAvailabilityReason?: string | null;
  },
): AwsEc2InstanceSummary | null {
  const instanceId = instance.InstanceId?.trim();
  if (!instanceId) {
    return null;
  }
  const nameTag = instance.Tags?.find((tag) => tag.Key === "Name")?.Value?.trim();
  return {
    instanceId,
    name: nameTag || instanceId,
    availabilityZone: instance.Placement?.AvailabilityZone?.trim() || null,
    platform:
      instance.PlatformDetails?.trim() || instance.Platform?.trim() || null,
    privateIp: instance.PrivateIpAddress?.trim() || null,
    state: instance.State?.Name?.trim() || null,
    ssmAvailability: input?.ssmAvailability ?? "unknown",
    ssmAvailabilityReason: input?.ssmAvailabilityReason ?? null,
  };
}

function parseClusterNameFromArn(clusterArn: string): string {
  const trimmed = clusterArn.trim();
  if (!trimmed) {
    return "";
  }
  const segments = trimmed.split("/");
  return segments[segments.length - 1] ?? trimmed;
}

function parseServiceNameFromArn(serviceArn: string): string {
  const trimmed = serviceArn.trim();
  if (!trimmed) {
    return "";
  }
  const segments = trimmed.split("/");
  return segments[segments.length - 1] ?? trimmed;
}

function parseTaskIdFromArn(taskArn: string): string {
  const trimmed = taskArn.trim();
  if (!trimmed) {
    return "";
  }
  const segments = trimmed.split("/");
  return segments[segments.length - 1] ?? trimmed;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function formatCapacityProviderSummary(
  strategy: NonNullable<
    NonNullable<
      NonNullable<EcsDescribeServicesPayload["services"]>[number][
        "capacityProviderStrategy"
      ]
    >
  >,
): string | null {
  if (!strategy.length) {
    return null;
  }
  return strategy
    .map((item) => {
      const name = item.capacityProvider?.trim() ?? "";
      if (!name) {
        return null;
      }
      const parts: string[] = [];
      if (typeof item.base === "number" && item.base > 0) {
        parts.push(`base ${item.base}`);
      }
      if (typeof item.weight === "number" && item.weight > 0) {
        parts.push(`weight ${item.weight}`);
      }
      return parts.length > 0 ? `${name} (${parts.join(", ")})` : name;
    })
    .filter((value): value is string => Boolean(value))
    .join(", ");
}

function normalizeTaskDefinitionCpu(
  payload: EcsTaskDefinitionPayload["taskDefinition"],
): string | null {
  const cpu = payload?.cpu?.trim();
  if (cpu) {
    return cpu;
  }
  const total = (payload?.containerDefinitions ?? []).reduce(
    (sum, container) => sum + (typeof container.cpu === "number" ? container.cpu : 0),
    0,
  );
  return total > 0 ? String(total) : null;
}

function normalizeTaskDefinitionMemory(
  payload: EcsTaskDefinitionPayload["taskDefinition"],
): string | null {
  const memory = payload?.memory?.trim();
  if (memory) {
    return memory;
  }
  const total = (payload?.containerDefinitions ?? []).reduce((sum, container) => {
    if (typeof container.memory === "number" && container.memory > 0) {
      return sum + container.memory;
    }
    if (
      typeof container.memoryReservation === "number" &&
      container.memoryReservation > 0
    ) {
      return sum + container.memoryReservation;
    }
    return sum;
  }, 0);
  return total > 0 ? String(total) : null;
}

function normalizeTaskDefinitionPorts(
  payload: EcsTaskDefinitionPayload["taskDefinition"],
): AwsEcsServicePortSummary[] {
  const ports = new Map<string, AwsEcsServicePortSummary>();
  for (const container of payload?.containerDefinitions ?? []) {
    for (const portMapping of container.portMappings ?? []) {
      const port = portMapping.containerPort;
      if (typeof port !== "number" || port <= 0) {
        continue;
      }
      const protocol = portMapping.protocol?.trim().toLowerCase() || "tcp";
      const key = `${port}/${protocol}`;
      if (!ports.has(key)) {
        ports.set(key, { port, protocol });
      }
    }
  }
  return [...ports.values()].sort(
    (left, right) => left.port - right.port || left.protocol.localeCompare(right.protocol),
  );
}

function normalizeContainerTaskDefinitionPorts(
  containerDefinition?: EcsContainerDefinition,
): AwsEcsServicePortSummary[] {
  const ports = new Map<string, AwsEcsServicePortSummary>();
  for (const portMapping of containerDefinition?.portMappings ?? []) {
    const port = portMapping.containerPort;
    if (typeof port !== "number" || port <= 0) {
      continue;
    }
    const protocol = portMapping.protocol?.trim().toLowerCase() || "tcp";
    ports.set(`${port}/${protocol}`, { port, protocol });
  }
  return [...ports.values()].sort(
    (left, right) => left.port - right.port || left.protocol.localeCompare(right.protocol),
  );
}

function normalizeServiceExposureKinds(
  service: NonNullable<EcsDescribeServicesPayload["services"]>[number],
): AwsEcsServiceExposureKind[] {
  const exposureKinds = new Set<AwsEcsServiceExposureKind>();
  if ((service.loadBalancers ?? []).length > 0) {
    // ECS service payload doesn't reliably distinguish ALB vs NLB here, so v1
    // treats any attached load balancer as a generic ALB/NLB exposure badge.
    exposureKinds.add("alb");
  }
  if (service.serviceConnectConfiguration?.enabled) {
    exposureKinds.add("service-connect");
  }
  return [...exposureKinds];
}

function normalizeEcsDeployments(
  deployments: NonNullable<
    NonNullable<EcsDescribeServicesPayload["services"]>[number]["deployments"]
  >,
): AwsEcsDeploymentSummary[] {
  return deployments
    .map((deployment, index) => {
      const taskDefinitionArn = deployment.taskDefinition?.trim() || null;
      return {
        id:
          deployment.id?.trim() ||
          `${deployment.status?.trim() || "deployment"}:${taskDefinitionArn ?? index}:${index}`,
        status: deployment.status?.trim() || "UNKNOWN",
        rolloutState: deployment.rolloutState?.trim() || null,
        rolloutStateReason: deployment.rolloutStateReason?.trim() || null,
        desiredCount:
          typeof deployment.desiredCount === "number"
            ? deployment.desiredCount
            : null,
        runningCount:
          typeof deployment.runningCount === "number"
            ? deployment.runningCount
            : null,
        pendingCount:
          typeof deployment.pendingCount === "number"
            ? deployment.pendingCount
            : null,
        taskDefinitionArn,
        taskDefinitionRevision: taskDefinitionArn
          ? parseTaskDefinitionRevision(taskDefinitionArn)
          : null,
        updatedAt:
          normalizeAwsTimestamp(
            (deployment.updatedAt as Date | string | null | undefined) ?? null,
          ) ||
          normalizeAwsTimestamp(
            (deployment.createdAt as Date | string | null | undefined) ?? null,
          ) ||
          null,
      } satisfies AwsEcsDeploymentSummary;
    })
    .sort((left, right) => {
      const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
      const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
      return rightTime - leftTime;
    });
}

function normalizeEcsEvents(
  events: NonNullable<
    NonNullable<EcsDescribeServicesPayload["services"]>[number]["events"]
  >,
): AwsEcsEventSummary[] {
  return events
    .map((event, index) => {
      const createdAt =
        normalizeAwsTimestamp(
          (event.createdAt as Date | string | null | undefined) ?? null,
        ) || null;
      return {
        id: `${createdAt || "event"}:${index}`,
      message: event.message?.trim() || "",
        createdAt,
      } satisfies AwsEcsEventSummary;
    })
    .filter((event) => event.message.length > 0)
    .sort((left, right) => {
      const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
      const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
      return rightTime - leftTime;
    });
}

function parseTaskDefinitionRevision(taskDefinitionArn: string): number | null {
  const match = taskDefinitionArn.trim().match(/:(\d+)$/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldHideSteadyStateEvent(message: string): boolean {
  return /steady state/i.test(message);
}

function normalizeAwsLogsConfig(containerDefinition?: EcsContainerDefinition): {
  supported: boolean;
  reason?: string | null;
  logGroupName?: string | null;
  logRegion?: string | null;
  logStreamPrefix?: string | null;
} {
  const logDriver =
    containerDefinition?.logConfiguration?.logDriver?.trim().toLowerCase() ||
    "";
  if (!logDriver) {
    return {
      supported: false,
      reason: t('aws.logs.noCloudWatch'),
    };
  }
  if (logDriver !== "awslogs") {
    return {
      supported: false,
      reason: t('aws.logs.awslogsOnly'),
    };
  }
  const options = containerDefinition?.logConfiguration?.options ?? {};
  const logGroupName = options["awslogs-group"]?.trim() || null;
  const logRegion = options["awslogs-region"]?.trim() || null;
  const logStreamPrefix = options["awslogs-stream-prefix"]?.trim() || null;
  if (!logGroupName || !logStreamPrefix) {
    return {
      supported: false,
      reason: t('aws.logs.noGroupOrPrefix'),
    };
  }
  return {
    supported: true,
    logGroupName,
    logRegion,
    logStreamPrefix,
  };
}

function summarizeEcsActionContainers(
  taskDefinition?: EcsTaskDefinitionPayload["taskDefinition"],
  runningTasks: AwsEcsServiceTaskSummary[] = [],
): AwsEcsServiceActionContainerSummary[] {
  return (taskDefinition?.containerDefinitions ?? [])
    .map((container): AwsEcsServiceActionContainerSummary | null => {
      const containerName = container.name?.trim() || "";
      if (!containerName) {
        return null;
      }
      const logSupport = normalizeAwsLogsConfig(container);
      const execEnabled = runningTasks.some(
        (task) =>
          task.enableExecuteCommand &&
          task.containers.some(
            (taskContainer) =>
              taskContainer.containerName === containerName &&
              (taskContainer.runtimeId?.trim() || "").length > 0,
          ),
      );
      return {
        containerName,
        ports: normalizeContainerTaskDefinitionPorts(container),
        execEnabled,
        logSupport: {
          containerName,
          supported: logSupport.supported,
          reason: logSupport.reason ?? null,
          logGroupName: logSupport.logGroupName ?? null,
          logRegion: logSupport.logRegion ?? null,
          logStreamPrefix: logSupport.logStreamPrefix ?? null,
        },
      };
    })
    .filter((value): value is AwsEcsServiceActionContainerSummary => value !== null)
    .sort((left, right) => left.containerName.localeCompare(right.containerName));
}

function parseTaskIdFromLogStreamName(logStreamName: string): string | null {
  const trimmed = logStreamName.trim();
  if (!trimmed) {
    return null;
  }
  const segments = trimmed.split("/").filter(Boolean);
  return segments.at(-1) ?? null;
}

function normalizeAwsTimestamp(
  value: Date | string | null | undefined,
): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
      return trimmed;
    }
    return new Date(parsed).toISOString();
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  return null;
}

type CloudWatchMetricResultLike = {
  Id?: string | null;
  Timestamps?: Array<Date | string | null | undefined>;
  Values?: Array<number | null | undefined>;
};

function pickLatestMetricValue(
  metricResult: CloudWatchMetricResultLike,
): number | null {
  const values = metricResult.Values ?? [];
  if (values.length === 0) {
    return null;
  }
  const timestamps = metricResult.Timestamps ?? [];
  if (timestamps.length !== values.length || timestamps.length === 0) {
    return typeof values[0] === "number" ? values[0] : null;
  }

  let latestIndex = 0;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < timestamps.length; index += 1) {
    const normalizedTimestamp = normalizeAwsTimestamp(
      (timestamps[index] as Date | string | null | undefined) ?? null,
    );
    const timestampMs = normalizedTimestamp ? Date.parse(normalizedTimestamp) : Number.NaN;
    if (!Number.isNaN(timestampMs) && timestampMs > latestTime) {
      latestTime = timestampMs;
      latestIndex = index;
    }
  }

  const latestValue = values[latestIndex];
  return typeof latestValue === "number" ? latestValue : null;
}

function normalizeMetricHistory(
  metricResult: CloudWatchMetricResultLike,
): AwsMetricHistoryPoint[] {
  const timestamps = metricResult.Timestamps ?? [];
  const values = metricResult.Values ?? [];
  if (timestamps.length === 0 || timestamps.length !== values.length) {
    return [];
  }

  const pointsByTimestamp = new Map<string, AwsMetricHistoryPoint>();
  for (let index = 0; index < timestamps.length; index += 1) {
    const normalizedTimestamp = normalizeAwsTimestamp(
      (timestamps[index] as Date | string | null | undefined) ?? null,
    );
    const value = values[index];
    if (!normalizedTimestamp || typeof value !== "number") {
      continue;
    }
    pointsByTimestamp.set(normalizedTimestamp, {
      timestamp: normalizedTimestamp,
      value,
    });
  }

  return [...pointsByTimestamp.values()].sort(
    (left, right) =>
      Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
}

export interface AwsSendSshPublicKeyInput {
  profileName: string;
  region: string;
  instanceId: string;
  availabilityZone: string;
  osUser: string;
  publicKey: string;
}

interface SendCommandPayload {
  Command?: {
    CommandId?: string;
  };
}

interface CommandInvocationPayload {
  Status?: string;
  ResponseCode?: number;
  StandardOutputContent?: string;
  StandardErrorContent?: string;
}

export interface AwsHostSshMetadataResult {
  sshPort: number;
  recommendedUsername: string | null;
  usernameCandidates: string[];
}

// 단계 식별자는 코드용이고, 사용자에게 보이는 문구는 prefixInspectionError 에서 번역한다.
type AwsHostSshInspectionStage =
  | "send-command"
  | "read-ssh-config"
  | "analyze-users";

const AWS_SSH_INSPECTION_STAGE_KEY: Record<AwsHostSshInspectionStage, string> = {
  "send-command": "aws.stage.sendCommand",
  "read-ssh-config": "aws.stage.readSshConfig",
  "analyze-users": "aws.stage.analyzeUsers",
};

const AWS_SSH_METADATA_SYSTEM_USERS = new Set([
  "",
  "root",
  "ssm-user",
  "nobody",
]);

function normalizeUsernameList(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of value.split(",")) {
    const username = token.trim();
    if (!username) {
      continue;
    }
    const key = username.toLocaleLowerCase();
    if (seen.has(key) || AWS_SSH_METADATA_SYSTEM_USERS.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(username);
  }
  return result;
}

function parseMetadataProbeOutput(stdout: string): {
  osId: string;
  cloudUser: string | null;
  sshPort: number;
  passwdUsers: string[];
  homeUsers: string[];
} {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim().toUpperCase();
    const value = line.slice(separatorIndex + 1).trim();
    values.set(key, value);
  }

  const parsedPort = Number.parseInt(values.get("SSH_PORT") ?? "", 10);
  return {
    osId: (values.get("OS_ID") ?? "").trim().toLocaleLowerCase(),
    cloudUser: (values.get("CLOUD_USER") ?? "").trim() || null,
    sshPort:
      Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
        ? parsedPort
        : 22,
    passwdUsers: normalizeUsernameList(values.get("PASSWD_USERS") ?? ""),
    homeUsers: normalizeUsernameList(values.get("HOME_USERS") ?? ""),
  };
}

function recommendSshUsername(input: {
  osId: string;
  cloudUser: string | null;
  passwdUsers: string[];
  homeUsers: string[];
}): string | null {
  const orderedCandidates = [...input.homeUsers, ...input.passwdUsers];
  const candidateSet = new Set(
    orderedCandidates.map((value) => value.toLocaleLowerCase()),
  );

  const cloudUser = input.cloudUser?.trim();
  if (cloudUser && candidateSet.has(cloudUser.toLocaleLowerCase())) {
    return cloudUser;
  }

  const platformDefaults =
    input.osId === "ubuntu"
      ? ["ubuntu"]
      : input.osId === "amzn" || input.osId === "amazon"
        ? ["ec2-user"]
        : input.osId === "debian"
          ? ["admin", "debian"]
          : input.osId === "centos"
            ? ["centos", "ec2-user"]
            : input.osId === "rhel" || input.osId === "rocky" || input.osId === "almalinux"
              ? ["ec2-user", "centos"]
              : ["ec2-user", "ubuntu", "admin", "debian", "centos"];

  for (const candidate of platformDefaults) {
    if (candidateSet.has(candidate.toLocaleLowerCase())) {
      return candidate;
    }
  }

  if (cloudUser) {
    return cloudUser;
  }
  return orderedCandidates[0] ?? platformDefaults[0] ?? null;
}

function prefixInspectionError(
  stage: AwsHostSshInspectionStage,
  error: unknown,
): Error {
  const message =
    error instanceof Error ? error.message : t('aws.error.unknown');
  return new Error(`[${t(AWS_SSH_INSPECTION_STAGE_KEY[stage])}] ${message}`);
}

export function buildSshMetadataProbeCommands(): string[] {
  return [
    'OS_ID=""',
    'CLOUD_USER=""',
    'SSH_PORT=""',
    'PASSWD_USERS=""',
    'HOME_USERS=""',
    "if [ -r /etc/os-release ]; then OS_ID=$(sed -n 's/^ID=//p' /etc/os-release | head -n 1 | tr -d '\"'); fi",
    'if [ -r /etc/cloud/cloud.cfg ]; then CLOUD_USER=$(awk \'/default_user:/ {flag=1; next} flag && $1 == "name:" {print $2; exit} flag && NF == 0 {flag=0}\' /etc/cloud/cloud.cfg 2>/dev/null); fi',
    'SSH_PORT=$(sshd -T 2>/dev/null | awk \'/^port / { print $2; exit }\')',
    'if [ -z "$SSH_PORT" ] && [ -r /etc/ssh/sshd_config ]; then SSH_PORT=$(awk \'$1 == "Port" { print $2; exit }\' /etc/ssh/sshd_config 2>/dev/null || true); fi',
    'if [ -z "$SSH_PORT" ]; then SSH_PORT=22; fi',
    'PASSWD_USERS=$(getent passwd 2>/dev/null | awk -F: \'$1 != "root" && $1 != "ssm-user" && $1 != "nobody" && $7 !~ /(nologin|false)$/ && ($3 >= 1000 || $1 == "ubuntu" || $1 == "ec2-user" || $1 == "admin" || $1 == "debian" || $1 == "centos") { print $1 }\' | paste -sd, -)',
    'if [ -z "$PASSWD_USERS" ] && [ -r /etc/passwd ]; then PASSWD_USERS=$(awk -F: \'$1 != "root" && $1 != "ssm-user" && $1 != "nobody" && $7 !~ /(nologin|false)$/ && ($3 >= 1000 || $1 == "ubuntu" || $1 == "ec2-user" || $1 == "admin" || $1 == "debian" || $1 == "centos") { print $1 }\' /etc/passwd | paste -sd, - || true); fi',
    'HOME_USERS=$(find /home -mindepth 1 -maxdepth 1 -type d -exec basename {} \\; 2>/dev/null | paste -sd, -)',
    'printf \'OS_ID=%s\\n\' "$OS_ID"',
    'printf \'CLOUD_USER=%s\\n\' "$CLOUD_USER"',
    'printf \'SSH_PORT=%s\\n\' "$SSH_PORT"',
    'printf \'PASSWD_USERS=%s\\n\' "$PASSWD_USERS"',
    'printf \'HOME_USERS=%s\\n\' "$HOME_USERS"',
  ];
}

export class AwsService {
  private static readonly ECS_SERVICE_LIST_CACHE_TTL_MS = 5 * 60_000;
  private static readonly ECS_TASK_DEFINITION_CACHE_TTL_MS = 5 * 60_000;
  private static readonly ECS_SERVICE_ACTION_CONTEXT_CACHE_TTL_MS = 3 * 60_000;

  private readonly pendingSsoPreparations = new Map<
    string,
    AwsPendingSsoPreparation
  >();
  private readonly inFlightSsoPreparationRoots = new Set<string>();
  private managedProfileArtifactsGeneration = 0;
  private readonly ecsServiceListCache = new Map<
    string,
    { expiresAt: number; value: string[] }
  >();
  private readonly ecsServiceListInFlight = new Map<string, Promise<string[]>>();
  private readonly ecsTaskDefinitionCache = new Map<
    string,
    {
      expiresAt: number;
      value: EcsTaskDefinitionPayload["taskDefinition"] | undefined;
    }
  >();
  private readonly ecsTaskDefinitionInFlight = new Map<
    string,
    Promise<EcsTaskDefinitionPayload["taskDefinition"] | undefined>
  >();
  private readonly ecsServiceActionContextCache = new Map<
    string,
    { expiresAt: number; value: AwsEcsServiceActionContext }
  >();
  private readonly ecsServiceActionContextInFlight = new Map<
    string,
    Promise<AwsEcsServiceActionContext>
  >();
  private managedAwsSdkEnvQueue = Promise.resolve();
  private readonly cloudWatchClientCache = new Map<string, CloudWatchClient>();
  private readonly cloudWatchLogsClientCache = new Map<string, CloudWatchLogsClient>();
  private readonly ecsClientCache = new Map<string, ECSClient>();
  private readonly ec2ClientCache = new Map<string, EC2Client>();
  private readonly ssmClientCache = new Map<string, SSMClient>();
  private readonly ec2InstanceConnectClientCache = new Map<
    string,
    EC2InstanceConnectClient
  >();
  private managedProfilesReadyTask: Promise<void> | null = null;
  private hasBackfilledManagedSsoCache = false;
  private readonly profileRepository: AwsProfileRepository;
  private readonly awsProfileRootDir: string;
  private readonly externalAwsProfileRootDir: string;

  constructor();
  constructor(awsProfileRootDir: string, externalAwsProfileRootDir?: string);
  constructor(
    profileRepository: AwsProfileRepository,
    awsProfileRootDir?: string,
    externalAwsProfileRootDir?: string,
  );
  constructor(
    profileRepositoryOrManagedRootDir?: AwsProfileRepository | string,
    awsProfileRootDir = getManagedAwsProfileRootDir(),
    externalAwsProfileRootDir = getDefaultAwsProfileRootDir(),
  ) {
    if (typeof profileRepositoryOrManagedRootDir === "string") {
      this.profileRepository = new AwsProfileRepository();
      this.awsProfileRootDir = profileRepositoryOrManagedRootDir;
      this.externalAwsProfileRootDir = awsProfileRootDir;
      return;
    }

    this.profileRepository =
      profileRepositoryOrManagedRootDir ?? new AwsProfileRepository();
    this.awsProfileRootDir = awsProfileRootDir;
    this.externalAwsProfileRootDir = externalAwsProfileRootDir;
  }

  private getManagedProfilePayloads(): ManagedAwsProfilePayload[] {
    return this.profileRepository.listPayloads();
  }

  private isCacheEntryFresh(expiresAt: number): boolean {
    return expiresAt > Date.now();
  }

  private buildEcsServiceListCacheKey(input: {
    profileName: string;
    region: string;
    clusterArn: string;
  }): string {
    return [input.profileName, input.region, input.clusterArn].join("\u0000");
  }

  private buildEcsActionContextCacheKey(input: {
    profileName: string;
    region: string;
    clusterArn: string;
    serviceName: string;
  }): string {
    return [
      input.profileName,
      input.region,
      input.clusterArn,
      input.serviceName,
    ].join("\u0000");
  }

  private buildEcsClusterCachePrefix(input: {
    profileName: string;
    region: string;
    clusterArn: string;
  }): string {
    return `${this.buildEcsServiceListCacheKey(input)}\u0000`;
  }

  private buildAwsSdkClientCacheKey(profileName: string, region: string): string {
    return [profileName, region].join("\u0000");
  }

  private getAwsSdkCredentialsProvider(profileName: string, region: string) {
    const provider = fromIni({
      profile: profileName,
      configFilepath: path.join(this.awsProfileRootDir, "config"),
      filepath: path.join(this.awsProfileRootDir, "credentials"),
      ignoreCache: true,
    });
    return async () => {
      await this.ensureManagedProfilesReady();
      return this.enqueueManagedAwsSdkEnv(async () =>
        this.withManagedAwsSdkEnv(async () => {
          const credentials = await provider();
          return {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken,
            expiration: credentials.expiration,
          };
        }),
      );
    };
  }

  // Resolves profile credentials from an arbitrary .aws root (managed or a
  // temp preparation root). HOME must point at the root's home while the SSO
  // token provider runs, hence the env-override wrapper + global queue.
  private async resolveProfileCredentialsFromRoot(
    profileName: string,
    awsRootDir: string,
  ) {
    const provider = fromIni({
      profile: profileName,
      configFilepath: path.join(awsRootDir, "config"),
      filepath: path.join(awsRootDir, "credentials"),
      ignoreCache: true,
    });
    return this.enqueueManagedAwsSdkEnv(async () =>
      this.withAwsEnvOverrides(
        this.getManagedAwsEnvOverrides(awsRootDir),
        async () => provider(),
      ),
    );
  }

  private async resolveProfileRegionFromRoot(
    profileName: string,
    awsRootDir: string,
  ): Promise<string | null> {
    try {
      const documents = await loadAwsProfileDocuments(awsRootDir);
      const snapshot = inspectAwsProfileDocuments(documents, profileName);
      return snapshot.mergedValues.region?.trim() || null;
    } catch {
      return null;
    }
  }

  private async stsGetCallerIdentityFromRoot(
    profileName: string,
    awsRootDir: string,
    timeoutMs: number,
  ): Promise<{ account: string | null; arn: string | null }> {
    const credentials = await this.resolveProfileCredentialsFromRoot(
      profileName,
      awsRootDir,
    );
    const region =
      (await this.resolveProfileRegionFromRoot(profileName, awsRootDir)) ??
      "us-east-1";
    const output = await new STSClient({ region, credentials }).send(
      new GetCallerIdentityCommand({}),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
    return { account: output.Account ?? null, arn: output.Arn ?? null };
  }

  // Seam for tests: runs the in-app SSO OIDC browser login and writes the
  // token cache into the given .aws root.
  private async performSsoLoginForRoot(input: {
    startUrl: string;
    ssoRegion: string;
    sessionName?: string | null;
    awsRootDir: string;
  }): Promise<{ accessToken: string }> {
    return performAwsSsoLogin({
      ...input,
      openExternal: (url) => this.openExternalUrl(url),
    });
  }

  private async openExternalUrl(url: string): Promise<void> {
    const { shell } = await import("electron");
    await shell.openExternal(url);
  }

  private async enqueueManagedAwsSdkEnv<T>(task: () => Promise<T>): Promise<T> {
    const next = this.managedAwsSdkEnvQueue.then(task, task);
    this.managedAwsSdkEnvQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async withManagedAwsSdkEnv<T>(task: () => Promise<T>): Promise<T> {
    return this.withAwsEnvOverrides(this.getManagedAwsEnvOverrides(), task);
  }

  private async withAwsEnvOverrides<T>(
    overrides: Record<string, string | null>,
    task: () => Promise<T>,
  ): Promise<T> {
    const previousValues = new Map<string, string | undefined>();

    for (const [key, value] of Object.entries(overrides)) {
      previousValues.set(key, process.env[key]);
      if (value === null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    try {
      return await task();
    } finally {
      for (const [key, value] of previousValues.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  private getCloudWatchClient(profileName: string, region: string): CloudWatchClient {
    const cacheKey = this.buildAwsSdkClientCacheKey(profileName, region);
    const cached = this.cloudWatchClientCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const client = new CloudWatchClient({
      credentials: this.getAwsSdkCredentialsProvider(profileName, region),
      region,
    });
    this.cloudWatchClientCache.set(cacheKey, client);
    return client;
  }

  private getCloudWatchLogsClient(
    profileName: string,
    region: string,
  ): CloudWatchLogsClient {
    const cacheKey = this.buildAwsSdkClientCacheKey(profileName, region);
    const cached = this.cloudWatchLogsClientCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const client = new CloudWatchLogsClient({
      credentials: this.getAwsSdkCredentialsProvider(profileName, region),
      region,
    });
    this.cloudWatchLogsClientCache.set(cacheKey, client);
    return client;
  }

  private getEcsClient(profileName: string, region: string): ECSClient {
    const cacheKey = this.buildAwsSdkClientCacheKey(profileName, region);
    const cached = this.ecsClientCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const client = new ECSClient({
      credentials: this.getAwsSdkCredentialsProvider(profileName, region),
      region,
    });
    this.ecsClientCache.set(cacheKey, client);
    return client;
  }

  private getEc2Client(profileName: string, region: string): EC2Client {
    const cacheKey = this.buildAwsSdkClientCacheKey(profileName, region);
    const cached = this.ec2ClientCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const client = new EC2Client({
      credentials: this.getAwsSdkCredentialsProvider(profileName, region),
      region,
    });
    this.ec2ClientCache.set(cacheKey, client);
    return client;
  }

  private getSsmClient(profileName: string, region: string): SSMClient {
    const cacheKey = this.buildAwsSdkClientCacheKey(profileName, region);
    const cached = this.ssmClientCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const client = new SSMClient({
      credentials: this.getAwsSdkCredentialsProvider(profileName, region),
      region,
    });
    this.ssmClientCache.set(cacheKey, client);
    return client;
  }

  private getEc2InstanceConnectClient(
    profileName: string,
    region: string,
  ): EC2InstanceConnectClient {
    const cacheKey = this.buildAwsSdkClientCacheKey(profileName, region);
    const cached = this.ec2InstanceConnectClientCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const client = new EC2InstanceConnectClient({
      credentials: this.getAwsSdkCredentialsProvider(profileName, region),
      region,
    });
    this.ec2InstanceConnectClientCache.set(cacheKey, client);
    return client;
  }

  private setEcsServiceListCache(
    input: { profileName: string; region: string; clusterArn: string },
    serviceNames: string[],
  ): void {
    this.ecsServiceListCache.set(this.buildEcsServiceListCacheKey(input), {
      expiresAt: Date.now() + AwsService.ECS_SERVICE_LIST_CACHE_TTL_MS,
      value: [...serviceNames],
    });
  }

  private clearEcsServiceActionContextCacheForCluster(input: {
    profileName: string;
    region: string;
    clusterArn: string;
  }): void {
    const clusterPrefix = this.buildEcsClusterCachePrefix(input);
    for (const cacheKey of this.ecsServiceActionContextCache.keys()) {
      if (cacheKey.startsWith(clusterPrefix)) {
        this.ecsServiceActionContextCache.delete(cacheKey);
      }
    }
  }

  invalidateEcsServiceActionContext(
    profileName: string,
    region: string,
    clusterArn: string,
    serviceName: string,
  ): void {
    this.ecsServiceActionContextCache.delete(
      this.buildEcsActionContextCacheKey({
        profileName,
        region,
        clusterArn,
        serviceName,
      }),
    );
  }

  private getCachedEcsTaskContainerContext(input: {
    profileName: string;
    region: string;
    clusterArn: string;
    taskArn: string;
    containerName: string;
  }):
    | {
        enableExecuteCommand: boolean;
        runtimeId: string | null;
      }
    | null {
    const clusterPrefix = this.buildEcsClusterCachePrefix(input);
    for (const [cacheKey, cacheEntry] of this.ecsServiceActionContextCache.entries()) {
      if (!cacheKey.startsWith(clusterPrefix)) {
        continue;
      }
      if (!this.isCacheEntryFresh(cacheEntry.expiresAt)) {
        this.ecsServiceActionContextCache.delete(cacheKey);
        continue;
      }
      const task = cacheEntry.value.runningTasks.find(
        (item) => item.taskArn === input.taskArn,
      );
      const container = task?.containers.find(
        (item) => item.containerName === input.containerName,
      );
      if (task && container) {
        return {
          enableExecuteCommand: task.enableExecuteCommand === true,
          runtimeId: container.runtimeId?.trim() || null,
        };
      }
    }
    return null;
  }

  private async ensureManagedProfilesReady(): Promise<void> {
    await this.initializeManagedProfiles();
    await this.backfillManagedSsoCacheFromExternalRootIfNeeded();
  }

  async initializeManagedProfiles(): Promise<void> {
    if (!this.managedProfilesReadyTask) {
      const task = this.materializeManagedProfiles();
      this.managedProfilesReadyTask = task.catch((error) => {
        this.managedProfilesReadyTask = null;
        throw error;
      });
    }
    await this.managedProfilesReadyTask;
  }

  private getManagedProfileByName(profileName: string): ManagedAwsProfilePayload | null {
    const metadata = this.profileRepository.getMetadataByName(profileName);
    if (!metadata) {
      return null;
    }
    return this.profileRepository.getPayloadById(metadata.id);
  }

  resolveManagedProfileName(profileId: string | null | undefined): string | null {
    return this.profileRepository.resolveNameById(profileId);
  }

  requireManagedProfileName(
    profileId: string | null | undefined,
    displayName: string | null | undefined,
  ): string {
    const profileName = this.resolveManagedProfileName(profileId);
    if (profileName) {
      return profileName;
    }
    const label = displayName?.trim();
    throw new Error(
      label
        ? t('aws.profile.linkedNotFoundNamed', { label })
        : t('aws.profile.linkedNotFound'),
    );
  }

  private buildManagedSsoSessionKey(startUrl: string, ssoRegion: string): string {
    const digest = createHash("sha1")
      .update(`${startUrl.trim()}|${ssoRegion.trim()}`)
      .digest("hex")
      .slice(0, 12);
    return `dolssh-${digest}`;
  }

  async materializeManagedProfiles(): Promise<void> {
    const payloads = this.getManagedProfilePayloads();
    const sortedPayloads = [...payloads].sort((left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );
    const profileNameById = new Map(
      sortedPayloads.map((payload) => [payload.id, payload.name]),
    );
    const configSections: string[] = [];
    const credentialSections: string[] = [];
    const writtenSsoSessions = new Set<string>();

    for (const payload of sortedPayloads) {
      if (payload.kind === "static") {
        credentialSections.push(
          `[${payload.name}]`,
          `aws_access_key_id = ${payload.accessKeyId}`,
          `aws_secret_access_key = ${payload.secretAccessKey}`,
          "",
        );
        if (payload.region?.trim()) {
          configSections.push(
            payload.name === "default" ? "[default]" : `[profile ${payload.name}]`,
            `region = ${payload.region.trim()}`,
            "",
          );
        }
        continue;
      }

      if (payload.kind === "role") {
        const sourceProfileName = profileNameById.get(payload.sourceProfileId);
        if (!sourceProfileName) {
          continue;
        }
        configSections.push(
          payload.name === "default" ? "[default]" : `[profile ${payload.name}]`,
          `role_arn = ${payload.roleArn}`,
          `source_profile = ${sourceProfileName}`,
          ...(payload.region?.trim() ? [`region = ${payload.region.trim()}`] : []),
          "",
        );
        continue;
      }

      const ssoSessionName = this.buildManagedSsoSessionKey(
        payload.ssoStartUrl,
        payload.ssoRegion,
      );
      configSections.push(
        payload.name === "default" ? "[default]" : `[profile ${payload.name}]`,
        `sso_session = ${ssoSessionName}`,
        `sso_account_id = ${payload.ssoAccountId}`,
        `sso_role_name = ${payload.ssoRoleName}`,
        ...(payload.region?.trim() ? [`region = ${payload.region.trim()}`] : []),
        "",
      );
      if (!writtenSsoSessions.has(ssoSessionName)) {
        configSections.push(
          `[sso-session ${ssoSessionName}]`,
          `sso_region = ${payload.ssoRegion}`,
          `sso_start_url = ${payload.ssoStartUrl}`,
          `sso_registration_scopes = ${AWS_SSO_REGISTRATION_SCOPES}`,
          "",
        );
        writtenSsoSessions.add(ssoSessionName);
      }
    }

    await mkdir(this.awsProfileRootDir, { recursive: true });
    await mkdir(path.join(this.awsProfileRootDir, "sso", "cache"), { recursive: true });
    await mkdir(path.join(this.awsProfileRootDir, "cli", "cache"), { recursive: true });
    await writeFile(
      path.join(this.awsProfileRootDir, "config"),
      configSections.length > 0 ? `${configSections.join("\n").trimEnd()}\n` : "",
      "utf8",
    );
    await writeFile(
      path.join(this.awsProfileRootDir, "credentials"),
      credentialSections.length > 0 ? `${credentialSections.join("\n").trimEnd()}\n` : "",
      "utf8",
    );
  }

  async purgeManagedProfileArtifacts(): Promise<void> {
    this.managedProfileArtifactsGeneration += 1;
    const preparationHomeDirs = new Set([
      ...this.inFlightSsoPreparationRoots,
      ...[...this.pendingSsoPreparations.values()].map(
        (preparation) => preparation.homeDir,
      ),
    ]);
    this.profileRepository.replaceAll([]);
    this.pendingSsoPreparations.clear();
    this.inFlightSsoPreparationRoots.clear();
    this.ecsServiceListCache.clear();
    this.ecsServiceListInFlight.clear();
    this.ecsTaskDefinitionCache.clear();
    this.ecsTaskDefinitionInFlight.clear();
    this.ecsServiceActionContextCache.clear();
    this.ecsServiceActionContextInFlight.clear();
    this.cloudWatchClientCache.clear();
    this.cloudWatchLogsClientCache.clear();
    this.ecsClientCache.clear();
    this.ec2ClientCache.clear();
    this.ssmClientCache.clear();
    this.ec2InstanceConnectClientCache.clear();
    this.hasBackfilledManagedSsoCache = false;

    const cleanupResults = await Promise.allSettled([
      ...[...preparationHomeDirs].map((homeDir) =>
        this.destroyTempAwsRoot(homeDir),
      ),
      rm(path.join(this.awsProfileRootDir, "sso", "cache"), {
        recursive: true,
        force: true,
      }),
      rm(path.join(this.awsProfileRootDir, "cli", "cache"), {
        recursive: true,
        force: true,
      }),
    ]);
    await this.materializeManagedProfiles();
    const cleanupFailure = cleanupResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (cleanupFailure) {
      throw cleanupFailure.reason;
    }
  }

  private getAwsRootEnvPatch(
    homeDir: string,
    awsRootDir: string,
  ): Record<string, string> {
    return {
      HOME: homeDir,
      USERPROFILE: homeDir,
      AWS_CONFIG_FILE: path.join(awsRootDir, "config"),
      AWS_SHARED_CREDENTIALS_FILE: path.join(awsRootDir, "credentials"),
    };
  }

  private getHomeDirForAwsRoot(awsRootDir: string): string {
    return path.basename(awsRootDir).toLowerCase() === ".aws"
      ? path.dirname(awsRootDir)
      : getManagedAwsHomeDir();
  }

  private getManagedAwsEnvOverrides(
    awsRootDir = this.awsProfileRootDir,
  ): Record<string, string | null> {
    return {
      ...this.getAwsRootEnvPatch(this.getHomeDirForAwsRoot(awsRootDir), awsRootDir),
      AWS_PROFILE: null,
      AWS_DEFAULT_PROFILE: null,
      AWS_ACCESS_KEY_ID: null,
      AWS_SECRET_ACCESS_KEY: null,
      AWS_SESSION_TOKEN: null,
      AWS_REGION: null,
      AWS_DEFAULT_REGION: null,
    };
  }

  getManagedAwsEnvPatch(): Record<string, string> {
    return this.getAwsRootEnvPatch(
      this.getHomeDirForAwsRoot(this.awsProfileRootDir),
      this.awsProfileRootDir,
    );
  }

  buildManagedSessionEnvSpec(): AwsSessionEnvSpec {
    return splitAwsSessionEnvSpec(this.getManagedAwsEnvOverrides());
  }

  async buildServerProxySessionEnvSpec(
    profileName: string,
    region: string,
  ): Promise<AwsSessionEnvSpec> {
    const resolvedRegion = region.trim();
    if (!resolvedRegion) {
      throw new Error("AWS region is required for server proxy sessions.");
    }
    const resolvedProfileName = profileName.trim();
    if (!resolvedProfileName) {
      throw new Error("AWS profile is required for server proxy sessions.");
    }

    const credentials = await this.getAwsSdkCredentialsProvider(
      resolvedProfileName,
      resolvedRegion,
    )();
    return splitAwsSessionEnvSpec({
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_SESSION_TOKEN: credentials.sessionToken || null,
      AWS_REGION: resolvedRegion,
      AWS_DEFAULT_REGION: resolvedRegion,
      AWS_PROFILE: null,
      AWS_DEFAULT_PROFILE: null,
      AWS_CONFIG_FILE: null,
      AWS_SHARED_CREDENTIALS_FILE: null,
    });
  }

  private async createTempAwsRoot(): Promise<{
    homeDir: string;
    awsRootDir: string;
  }> {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "dolssh-aws-home-"));
    const awsRootDir = path.join(homeDir, ".aws");
    const sourceConfigPath = path.join(this.awsProfileRootDir, "config");
    const sourceCredentialsPath = path.join(this.awsProfileRootDir, "credentials");
    const sourceSsoCacheDir = path.join(this.awsProfileRootDir, "sso", "cache");
    const targetConfigPath = path.join(awsRootDir, "config");
    const targetCredentialsPath = path.join(awsRootDir, "credentials");
    const targetSsoCacheDir = path.join(awsRootDir, "sso", "cache");

    await access(this.awsProfileRootDir, fsConstants.F_OK).catch(() => undefined);
    await access(sourceConfigPath, fsConstants.F_OK)
      .then(async () => {
        await mkdir(path.dirname(targetConfigPath), { recursive: true });
        await copyFile(sourceConfigPath, targetConfigPath);
      })
      .catch(() => undefined);
    await access(sourceCredentialsPath, fsConstants.F_OK)
      .then(async () => {
        await mkdir(path.dirname(targetCredentialsPath), { recursive: true });
        await copyFile(sourceCredentialsPath, targetCredentialsPath);
      })
      .catch(() => undefined);
    await access(sourceSsoCacheDir, fsConstants.F_OK)
      .then(async () => {
        await copyDirectoryRecursive(sourceSsoCacheDir, targetSsoCacheDir);
      })
      .catch(() => undefined);

    return { homeDir, awsRootDir };
  }

  private async syncSsoCacheIntoManagedRoot(
    sourceAwsRootDir: string,
    options: { requireSourceCache?: boolean } = {},
  ): Promise<void> {
    if (sourceAwsRootDir === this.awsProfileRootDir) {
      await mkdir(path.join(this.awsProfileRootDir, "sso", "cache"), {
        recursive: true,
      });
      return;
    }

    const sourceSsoCacheDir = path.join(sourceAwsRootDir, "sso", "cache");
    const targetSsoCacheDir = path.join(this.awsProfileRootDir, "sso", "cache");
    const sourceCacheExists = await access(sourceSsoCacheDir, fsConstants.F_OK)
      .then(() => true)
      .catch(() => false);
    if (!sourceCacheExists) {
      if (options.requireSourceCache) {
        throw new Error(t('aws.sso.noTokenCache'));
      }
      return;
    }

    await this.mergeSsoCacheDirectories(sourceSsoCacheDir, targetSsoCacheDir);
  }

  private async mergeSsoCacheDirectories(
    sourceDir: string,
    targetDir: string,
  ): Promise<void> {
    const entries = await readdir(sourceDir, { withFileTypes: true });
    await mkdir(targetDir, { recursive: true });

    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);

      if (entry.isDirectory()) {
        await this.mergeSsoCacheDirectories(sourcePath, targetPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const shouldCopy = await this.shouldCopySsoCacheFile(sourcePath, targetPath);
      if (shouldCopy) {
        await copyFile(sourcePath, targetPath);
      }
    }
  }

  private async shouldCopySsoCacheFile(
    sourcePath: string,
    targetPath: string,
  ): Promise<boolean> {
    const targetExists = await access(targetPath, fsConstants.F_OK)
      .then(() => true)
      .catch(() => false);
    if (!targetExists) {
      return true;
    }

    const [sourceRaw, targetRaw] = await Promise.all([
      readFile(sourcePath, "utf8").catch(() => ""),
      readFile(targetPath, "utf8").catch(() => ""),
    ]);
    const sourceExpiration = parseSsoCacheExpirationTimestamp(sourceRaw);
    const targetExpiration = parseSsoCacheExpirationTimestamp(targetRaw);

    if (sourceExpiration === null) {
      return false;
    }
    if (targetExpiration === null) {
      return true;
    }
    return sourceExpiration > targetExpiration;
  }

  private async backfillManagedSsoCacheFromExternalRootIfNeeded(): Promise<void> {
    if (this.hasBackfilledManagedSsoCache) {
      return;
    }
    this.hasBackfilledManagedSsoCache = true;
    if (this.externalAwsProfileRootDir === this.awsProfileRootDir) {
      return;
    }
    await this.syncSsoCacheIntoManagedRoot(this.externalAwsProfileRootDir);
  }

  private async destroyTempAwsRoot(homeDir: string): Promise<void> {
    await rm(homeDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }

  private pruneExpiredSsoPreparations(): void {
    const now = Date.now();
    for (const [token, preparation] of this.pendingSsoPreparations.entries()) {
      if (preparation.expiresAt > now) {
        continue;
      }
      this.pendingSsoPreparations.delete(token);
      void this.destroyTempAwsRoot(preparation.homeDir);
    }
  }

  private async consumeSsoPreparation(
    preparationToken: string,
  ): Promise<AwsPendingSsoPreparation> {
    this.pruneExpiredSsoPreparations();
    const preparation = this.pendingSsoPreparations.get(preparationToken);
    if (!preparation) {
      throw new Error(t('aws.sso.prepMissing'));
    }
    if (preparation.expiresAt <= Date.now()) {
      this.pendingSsoPreparations.delete(preparationToken);
      await this.destroyTempAwsRoot(preparation.homeDir);
      throw new Error(t('aws.sso.prepExpired'));
    }
    this.pendingSsoPreparations.delete(preparationToken);
    return preparation;
  }

  private async listSsoAccounts(input: {
    accessToken: string;
    ssoRegion: string;
  }): Promise<AwsSsoProfileAccountOption[]> {
    const collected: AwsSsoProfileAccountOption[] = [];
    try {
      const client = new SSOClient({ region: input.ssoRegion });
      let nextToken: string | undefined;
      do {
        const output = await client.send(
          new ListAccountsCommand({
            accessToken: input.accessToken,
            nextToken,
          }),
          { abortSignal: AbortSignal.timeout(60_000) },
        );
        for (const item of output.accountList ?? []) {
          const accountId = item.accountId?.trim() ?? "";
          if (!accountId) {
            continue;
          }
          collected.push({
            accountId,
            accountName: item.accountName?.trim() || accountId,
            emailAddress: item.emailAddress?.trim() || null,
          });
        }
        nextToken = output.nextToken ?? undefined;
      } while (nextToken);
    } catch (error) {
      throw normalizeAwsProfileFlowSdkError(
        error,
        t('aws.sso.accountListFailed'),
        "sso-account-list",
      );
    }

    return collected.sort(
      (left, right) =>
        left.accountName.localeCompare(right.accountName) ||
        left.accountId.localeCompare(right.accountId),
    );
  }

  private async listSsoRolesForAccount(input: {
    accessToken: string;
    ssoRegion: string;
    accountId: string;
  }): Promise<AwsSsoProfileRoleOption[]> {
    const collected: AwsSsoProfileRoleOption[] = [];
    try {
      const client = new SSOClient({ region: input.ssoRegion });
      let nextToken: string | undefined;
      do {
        const output = await client.send(
          new ListAccountRolesCommand({
            accessToken: input.accessToken,
            accountId: input.accountId,
            nextToken,
          }),
          { abortSignal: AbortSignal.timeout(60_000) },
        );
        for (const item of output.roleList ?? []) {
          const roleName = item.roleName?.trim() ?? "";
          if (!roleName) {
            continue;
          }
          collected.push({ accountId: input.accountId, roleName });
        }
        nextToken = output.nextToken ?? undefined;
      } while (nextToken);
    } catch (error) {
      throw normalizeAwsProfileFlowSdkError(
        error,
        t('aws.sso.roleListFailed'),
        "sso-role-list",
      );
    }

    return collected.sort((left, right) =>
      left.roleName.localeCompare(right.roleName),
    );
  }

  private async assertProfileNameAvailable(profileName: string): Promise<void> {
    if (this.profileRepository.getMetadataByName(profileName)) {
      throw new Error(t('aws.profile.duplicateName'));
    }
  }

  private async saveSsoProfileValues(input: {
    profileName: string;
    ssoSessionName: string;
    ssoStartUrl: string;
    ssoRegion: string;
    ssoAccountId: string;
    ssoRoleName: string;
    region?: string | null;
  }): Promise<void> {
    const existing = this.getManagedProfileByName(input.profileName);
    const payload: ManagedAwsProfilePayload = {
      id: existing?.id ?? randomUUID(),
      kind: "sso",
      name: input.profileName,
      region: input.region?.trim() || null,
      ssoStartUrl: input.ssoStartUrl.trim(),
      ssoRegion: input.ssoRegion.trim(),
      ssoAccountId: input.ssoAccountId.trim(),
      ssoRoleName: input.ssoRoleName.trim(),
      updatedAt: new Date().toISOString(),
    };
    this.profileRepository.upsert(payload);
    await this.materializeManagedProfiles();
  }

  private async saveRoleProfileValues(input: {
    profileName: string;
    sourceProfileId: string;
    roleArn: string;
    region?: string | null;
  }): Promise<void> {
    const existing = this.getManagedProfileByName(input.profileName);
    const payload: ManagedAwsProfilePayload = {
      id: existing?.id ?? randomUUID(),
      kind: "role",
      name: input.profileName,
      region: input.region?.trim() || null,
      roleArn: input.roleArn.trim(),
      sourceProfileId: input.sourceProfileId,
      updatedAt: new Date().toISOString(),
    };
    this.profileRepository.upsert(payload);
    await this.materializeManagedProfiles();
  }

  private async validateProfileWithTempRoot(input: {
    homeDir: string;
    awsRootDir: string;
    profileName: string;
    errorContext: AwsProfileFlowErrorContext;
    fallbackMessage: string;
  }): Promise<void> {
    try {
      await this.stsGetCallerIdentityFromRoot(
        input.profileName,
        input.awsRootDir,
        30_000,
      );
    } catch (error) {
      throw normalizeAwsProfileFlowSdkError(
        error,
        input.fallbackMessage,
        input.errorContext,
      );
    }
  }

  // Raw STS call seam (tests stub this and exercise the error mapping in the
  // validate wrapper).
  private async stsAssumeRoleWithSourceProfile(input: {
    sourceProfileName: string;
    roleArn: string;
    sessionName: string;
  }): Promise<void> {
    const credentials = await this.resolveProfileCredentialsFromRoot(
      input.sourceProfileName,
      this.awsProfileRootDir,
    );
    const region =
      (await this.resolveProfileRegionFromRoot(
        input.sourceProfileName,
        this.awsProfileRootDir,
      )) ?? "us-east-1";
    await new STSClient({ region, credentials }).send(
      new AssumeRoleCommand({
        RoleArn: input.roleArn,
        RoleSessionName: input.sessionName,
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  }

  private async validateAssumeRoleWithSourceProfile(input: {
    sourceProfileName: string;
    roleArn: string;
    errorContext: AwsProfileFlowErrorContext;
    fallbackMessage: string;
  }): Promise<void> {
    try {
      await this.stsAssumeRoleWithSourceProfile({
        sourceProfileName: input.sourceProfileName,
        roleArn: input.roleArn,
        sessionName: `dolssh-validate-${Date.now()}`,
      });
    } catch (error) {
      throw normalizeAwsProfileFlowSdkError(
        error,
        input.fallbackMessage,
        input.errorContext,
      );
    }
  }

  private async buildUniqueSsoSessionName(profileName: string): Promise<string> {
    const documents = await loadAwsProfileDocuments(this.awsProfileRootDir);
    const existingSessionNames = new Set(
      documents.config.lines
        .map((line) => line.match(/^\s*\[sso-session ([^\]]+)\]\s*$/)?.[1]?.trim() ?? "")
        .filter(Boolean),
    );
    let nextSessionName = profileName;
    let suffix = 2;
    while (existingSessionNames.has(nextSessionName)) {
      nextSessionName = `${profileName}-${suffix}`;
      suffix += 1;
    }
    return nextSessionName;
  }

  private buildUniqueSsoSessionNameForDocuments(
    documents: Awaited<ReturnType<typeof loadAwsProfileDocuments>>,
    baseName: string,
  ): string {
    const existingSessionNames = new Set(
      documents.config.lines
        .map((line) => line.match(/^\s*\[sso-session ([^\]]+)\]\s*$/)?.[1]?.trim() ?? "")
        .filter(Boolean),
    );
    let nextSessionName = baseName;
    let suffix = 2;
    while (existingSessionNames.has(nextSessionName)) {
      nextSessionName = `${baseName}-${suffix}`;
      suffix += 1;
    }
    return nextSessionName;
  }

  private hasSameKeyValues(
    left: Record<string, string>,
    right: Record<string, string>,
  ): boolean {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && (left[key] ?? "").trim() === (right[key] ?? "").trim(),
    );
  }

  private importExternalSsoSession(
    sourceDocuments: Awaited<ReturnType<typeof loadAwsProfileDocuments>>,
    targetDocuments: Awaited<ReturnType<typeof loadAwsProfileDocuments>>,
    sourceSessionName: string,
    resolvedSessionNames: Map<string, string>,
  ): string {
    const normalizedSessionName = sourceSessionName.trim();
    if (!normalizedSessionName) {
      return normalizedSessionName;
    }
    const cached = resolvedSessionNames.get(normalizedSessionName);
    if (cached) {
      return cached;
    }

    const sourceValues = getAwsSsoSessionValues(sourceDocuments, normalizedSessionName);
    if (Object.keys(sourceValues).length === 0) {
      resolvedSessionNames.set(normalizedSessionName, normalizedSessionName);
      return normalizedSessionName;
    }

    const targetValues = getAwsSsoSessionValues(targetDocuments, normalizedSessionName);
    let targetSessionName = normalizedSessionName;
    if (
      Object.keys(targetValues).length > 0 &&
      !this.hasSameKeyValues(sourceValues, targetValues)
    ) {
      targetSessionName = this.buildUniqueSsoSessionNameForDocuments(
        targetDocuments,
        normalizedSessionName,
      );
    }

    if (
      Object.keys(targetValues).length === 0 ||
      targetSessionName !== normalizedSessionName
    ) {
      copyAwsSsoSessionSectionBetweenDocuments(
        sourceDocuments,
        targetDocuments,
        normalizedSessionName,
        {
          nextSessionName: targetSessionName,
        },
      );
    }

    resolvedSessionNames.set(normalizedSessionName, targetSessionName);
    return targetSessionName;
  }

  private importExternalProfileRecursive(input: {
    profileName: string;
    sourceDocuments: Awaited<ReturnType<typeof loadAwsProfileDocuments>>;
    targetDocuments: Awaited<ReturnType<typeof loadAwsProfileDocuments>>;
    importedProfileNames: Set<string>;
    skippedProfileNames: Set<string>;
    visitedProfileNames: Set<string>;
    resolvedSessionNames: Map<string, string>;
  }): void {
    const profileName = normalizeAwsProfileName(input.profileName);
    if (input.visitedProfileNames.has(profileName)) {
      return;
    }
    input.visitedProfileNames.add(profileName);

    const sourceSnapshot = inspectAwsProfileDocuments(input.sourceDocuments, profileName);
    if (!sourceSnapshot.hasConfigSection && !sourceSnapshot.hasCredentialsSection) {
      input.skippedProfileNames.add(profileName);
      return;
    }

    const targetSnapshot = inspectAwsProfileDocuments(input.targetDocuments, profileName);
    if (targetSnapshot.hasConfigSection || targetSnapshot.hasCredentialsSection) {
      input.skippedProfileNames.add(profileName);
      return;
    }

    const sourceProfileName = sourceSnapshot.mergedValues.source_profile?.trim();
    if (sourceProfileName) {
      this.importExternalProfileRecursive({
        ...input,
        profileName: sourceProfileName,
      });
    }

    const configOverrides: Record<string, string> = {};
    const sourceSsoSession = sourceSnapshot.mergedValues.sso_session?.trim();
    if (sourceSsoSession) {
      const importedSessionName = this.importExternalSsoSession(
        input.sourceDocuments,
        input.targetDocuments,
        sourceSsoSession,
        input.resolvedSessionNames,
      );
      if (importedSessionName && importedSessionName !== sourceSsoSession) {
        configOverrides.sso_session = importedSessionName;
      }
    }

    copyAwsProfileConfigSectionBetweenDocuments(
      input.sourceDocuments,
      input.targetDocuments,
      profileName,
      Object.keys(configOverrides).length > 0 ? { overrides: configOverrides } : undefined,
    );
    copyAwsProfileCredentialsSectionBetweenDocuments(
      input.sourceDocuments,
      input.targetDocuments,
      profileName,
    );
    input.importedProfileNames.add(profileName);
  }

  private buildImportedPayloadsFromExternalDocuments(input: {
    requestedProfileNames: string[];
    sourceDocuments: Awaited<ReturnType<typeof loadAwsProfileDocuments>>;
  }): {
    payloads: ManagedAwsProfilePayload[];
    importedProfileNames: string[];
    skippedProfileNames: string[];
  } {
    const payloadsByName = new Map<string, ManagedAwsProfilePayload>();
    const importedProfileNames = new Set<string>();
    const skippedProfileNames = new Set<string>();
    const visiting = new Set<string>();

    const resolveProfileId = (profileName: string): string | null => {
      return (
        payloadsByName.get(profileName)?.id ??
        this.profileRepository.getMetadataByName(profileName)?.id ??
        null
      );
    };

    const visitProfile = (requestedProfileName: string, explicit = false): string | null => {
      const profileName = normalizeAwsProfileName(requestedProfileName);
      if (payloadsByName.has(profileName)) {
        return payloadsByName.get(profileName)?.id ?? null;
      }
      const existing = this.profileRepository.getMetadataByName(profileName);
      if (existing) {
        if (explicit) {
          skippedProfileNames.add(profileName);
        }
        return existing.id;
      }
      if (visiting.has(profileName)) {
        return resolveProfileId(profileName);
      }
      visiting.add(profileName);

      try {
        const snapshot = inspectAwsProfileDocuments(input.sourceDocuments, profileName);
        if (!snapshot.hasConfigSection && !snapshot.hasCredentialsSection) {
          if (explicit) {
            skippedProfileNames.add(profileName);
          }
          return null;
        }

        const values = snapshot.mergedValues;
        const region = values.region?.trim() || null;
        const ssoSession = values.sso_session?.trim() || null;
        const ssoSessionValues = ssoSession
          ? getAwsSsoSessionValues(input.sourceDocuments, ssoSession)
          : {};
        const ssoStartUrl =
          values.sso_start_url?.trim() ||
          ssoSessionValues.sso_start_url?.trim() ||
          null;
        const ssoRegion =
          values.sso_region?.trim() ||
          ssoSessionValues.sso_region?.trim() ||
          null;
        const ssoAccountId = values.sso_account_id?.trim() || null;
        const ssoRoleName = values.sso_role_name?.trim() || null;
        const roleArn = values.role_arn?.trim() || null;
        const sourceProfileName = values.source_profile?.trim() || null;
        const accessKeyId = values.aws_access_key_id?.trim() || null;
        const secretAccessKey = values.aws_secret_access_key?.trim() || null;
        const updatedAt = new Date().toISOString();
        const id = randomUUID();

        let payload: ManagedAwsProfilePayload | null = null;
        if (ssoStartUrl && ssoRegion && ssoAccountId && ssoRoleName) {
          payload = {
            id,
            kind: "sso",
            name: profileName,
            region,
            ssoStartUrl,
            ssoRegion,
            ssoAccountId,
            ssoRoleName,
            updatedAt,
          };
        } else if (roleArn && sourceProfileName) {
          const sourceProfileId = visitProfile(sourceProfileName);
          if (!sourceProfileId) {
            if (explicit) {
              skippedProfileNames.add(profileName);
            }
            return null;
          }
          payload = {
            id,
            kind: "role",
            name: profileName,
            region,
            roleArn,
            sourceProfileId,
            updatedAt,
          };
        } else if (accessKeyId && secretAccessKey) {
          payload = {
            id,
            kind: "static",
            name: profileName,
            region,
            accessKeyId,
            secretAccessKey,
            updatedAt,
          };
        }

        if (!payload) {
          if (explicit) {
            skippedProfileNames.add(profileName);
          }
          return null;
        }

        payloadsByName.set(profileName, payload);
        importedProfileNames.add(profileName);
        return payload.id;
      } finally {
        visiting.delete(profileName);
      }
    };

    for (const profileName of input.requestedProfileNames) {
      visitProfile(profileName, true);
    }

    return {
      payloads: [...payloadsByName.values()].sort((left, right) => left.name.localeCompare(right.name)),
      importedProfileNames: [...importedProfileNames].sort((left, right) => left.localeCompare(right)),
      skippedProfileNames: [...skippedProfileNames].sort((left, right) => left.localeCompare(right)),
    };
  }

  // Raw STS call seam (tests stub this and exercise the error mapping in the
  // validate wrapper).
  private async stsGetCallerIdentityWithStaticCredentials(input: {
    accessKeyId: string;
    secretAccessKey: string;
    region?: string | null;
  }): Promise<void> {
    await new STSClient({
      region: input.region?.trim() || "us-east-1",
      credentials: {
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
      },
    }).send(new GetCallerIdentityCommand({}), {
      abortSignal: AbortSignal.timeout(30_000),
    });
  }

  private async validateStaticCredentials(input: {
    accessKeyId: string;
    secretAccessKey: string;
    region?: string | null;
  }): Promise<void> {
    try {
      await this.stsGetCallerIdentityWithStaticCredentials(input);
    } catch (error) {
      throw normalizeAwsProfileFlowSdkError(
        error,
        t('aws.credentials.invalid'),
        "static-validation",
      );
    }
  }

  private async saveStaticProfileValues(input: {
    profileName: string;
    accessKeyId: string;
    secretAccessKey: string;
    region?: string | null;
  }): Promise<void> {
    const existing = this.getManagedProfileByName(input.profileName);
    const payload: ManagedAwsProfilePayload = {
      id: existing?.id ?? randomUUID(),
      kind: "static",
      name: input.profileName,
      region: input.region?.trim() || null,
      accessKeyId: input.accessKeyId.trim(),
      secretAccessKey: input.secretAccessKey.trim(),
      updatedAt: new Date().toISOString(),
    };
    this.profileRepository.upsert(payload);
    await this.materializeManagedProfiles();
  }

  async listProfiles(): Promise<AwsProfileSummary[]> {
    await this.ensureManagedProfilesReady();
    return this.profileRepository.listMetadata().map((profile) => ({
      id: profile.id,
      name: profile.name,
    }));
  }

  private async listProfilesFromRoot(rootDir: string): Promise<AwsProfileSummary[]> {
    const documents = await loadAwsProfileDocuments(rootDir);
    return listAwsProfileNames(documents).map((name) => ({ id: null, name }));
  }

  async importExternalProfiles(
    input: AwsExternalProfileImportInput,
  ): Promise<AwsExternalProfileImportResult> {
    await this.ensureManagedProfilesReady();
    const requestedProfileNames = [...new Set(
      (input.profileNames ?? [])
        .map((profileName) => profileName.trim())
        .filter(Boolean),
    )];
    if (requestedProfileNames.length === 0) {
      return {
        importedProfileNames: [],
        skippedProfileNames: [],
      };
    }

    const sourceDocuments = await loadAwsProfileDocuments(this.externalAwsProfileRootDir);
    const result = this.buildImportedPayloadsFromExternalDocuments({
      requestedProfileNames,
      sourceDocuments,
    });
    for (const payload of result.payloads) {
      this.profileRepository.upsert(payload);
    }
    await this.materializeManagedProfiles();
    if (result.payloads.some((payload) => payload.kind === "sso")) {
      await this.syncSsoCacheIntoManagedRoot(this.externalAwsProfileRootDir);
    }

    return {
      importedProfileNames: result.importedProfileNames,
      skippedProfileNames: result.skippedProfileNames,
    };
  }

  async createProfile(input: AwsProfileCreateInput): Promise<void> {
    if (isE2EFakeAwsSessionEnabled()) {
      return;
    }

    await this.ensureManagedProfilesReady();

    if (input.kind === "static") {
      const profileName = normalizeAwsProfileName(input.profileName);
      const accessKeyId = input.accessKeyId.trim();
      const secretAccessKey = input.secretAccessKey.trim();
      const region = input.region?.trim() || null;

      if (!accessKeyId) {
        throw new Error(t('aws.field.accessKeyRequired'));
      }
      if (!secretAccessKey) {
        throw new Error(t('aws.field.secretRequired'));
      }

      await this.assertProfileNameAvailable(profileName);
      await this.validateStaticCredentials({
        accessKeyId,
        secretAccessKey,
        region,
      });
      await this.saveStaticProfileValues({
        profileName,
        accessKeyId,
        secretAccessKey,
        region,
      });
      return;
    }

    if (input.kind === "role") {
      const profileName = normalizeAwsProfileName(input.profileName);
      const roleArn = input.roleArn.trim();
      const region = input.region?.trim() || null;
      const sourceProfile =
        (input.sourceProfileId
          ? this.profileRepository.getPayloadById(input.sourceProfileId)
          : null) ??
        this.getManagedProfileByName(
          normalizeAwsProfileName(input.sourceProfileName, "source profile"),
        );

      if (!roleArn) {
        throw new Error(t('aws.field.roleArnRequired'));
      }

      await this.assertProfileNameAvailable(profileName);
      if (!sourceProfile) {
        throw new Error(t('aws.profile.sourceNotFound'));
      }

      await this.validateAssumeRoleWithSourceProfile({
        sourceProfileName: sourceProfile.name,
        roleArn,
        errorContext: "role-validation",
        fallbackMessage:
          t('aws.role.verifyFailed'),
      });

      await this.saveRoleProfileValues({
        profileName,
        sourceProfileId: sourceProfile.id,
        roleArn,
        region,
      });
      return;
    }

    const profileName = normalizeAwsProfileName(input.profileName);
    const ssoAccountId = input.ssoAccountId.trim();
    const ssoRoleName = input.ssoRoleName.trim();
    if (!ssoAccountId) {
      throw new Error(t('aws.field.ssoAccountRequired'));
    }
    if (!ssoRoleName) {
      throw new Error(t('aws.field.ssoRoleRequired'));
    }

    await this.assertProfileNameAvailable(profileName);
    const preparation = await this.consumeSsoPreparation(input.preparationToken);
    if (preparation.profileName !== profileName) {
      await this.destroyTempAwsRoot(preparation.homeDir);
      throw new Error(t('aws.sso.prepProfileMismatch'));
    }
    if (
      preparation.ssoSessionName !== input.ssoSessionName ||
      preparation.ssoStartUrl !== input.ssoStartUrl.trim() ||
      preparation.ssoRegion !== input.ssoRegion.trim() ||
      preparation.region !== (input.region?.trim() || null)
    ) {
      await this.destroyTempAwsRoot(preparation.homeDir);
      throw new Error(t('aws.sso.prepInputMismatch'));
    }

    try {
      const documents = await loadAwsProfileDocuments(preparation.awsRootDir);
      setAwsProfileKeyValueInDocuments(
        documents,
        "config",
        profileName,
        "sso_account_id",
        ssoAccountId,
      );
      setAwsProfileKeyValueInDocuments(
        documents,
        "config",
        profileName,
        "sso_role_name",
        ssoRoleName,
      );
      await writeAwsProfileDocuments(documents);
      await this.validateProfileWithTempRoot({
        homeDir: preparation.homeDir,
        awsRootDir: preparation.awsRootDir,
        profileName,
        errorContext: "sso-final-validation",
        fallbackMessage:
          t('aws.sso.authIncompleteShort'),
      });

      await this.syncSsoCacheIntoManagedRoot(preparation.awsRootDir, {
        requireSourceCache: true,
      });

      await this.saveSsoProfileValues({
        profileName,
        ssoSessionName: preparation.ssoSessionName,
        ssoStartUrl: preparation.ssoStartUrl,
        ssoRegion: preparation.ssoRegion,
        ssoAccountId,
        ssoRoleName,
        region: preparation.region,
      });
    } finally {
      await this.destroyTempAwsRoot(preparation.homeDir);
    }
  }

  async prepareSsoProfile(
    input: AwsSsoProfilePrepareInput,
  ): Promise<AwsSsoProfilePrepareResult> {
    if (isE2EFakeAwsSessionEnabled()) {
      return {
        preparationToken: "smoke-token",
        profileName: input.profileName,
        ssoSessionName: input.profileName,
        ssoStartUrl: input.ssoStartUrl,
        ssoRegion: input.ssoRegion,
        region: input.region?.trim() || null,
        accounts: [
          {
            accountId: "000000000000",
            accountName: "dolssh-smoke",
            emailAddress: "smoke@example.com",
          },
        ],
        rolesByAccountId: {
          "000000000000": [{ accountId: "000000000000", roleName: "AdministratorAccess" }],
        },
        defaultAccountId: "000000000000",
        defaultRoleName: "AdministratorAccess",
      };
    }

    const preparationGeneration = this.managedProfileArtifactsGeneration;
    await this.ensureManagedProfilesReady();
    if (preparationGeneration !== this.managedProfileArtifactsGeneration) {
      throw new Error(t('aws.sso.cancelledAccountChanged'));
    }
    this.pruneExpiredSsoPreparations();

    const profileName = normalizeAwsProfileName(input.profileName);
    const ssoStartUrl = input.ssoStartUrl.trim();
    const ssoRegion = input.ssoRegion.trim();
    const region = input.region?.trim() || null;

    if (!ssoStartUrl) {
      throw new Error(t('aws.field.ssoStartUrlRequired'));
    }
    if (!ssoRegion) {
      throw new Error(t('aws.field.ssoRegionRequired'));
    }

    await this.assertProfileNameAvailable(profileName);

    const ssoSessionName = await this.buildUniqueSsoSessionName(profileName);
    const tempRoot = await this.createTempAwsRoot();
    this.inFlightSsoPreparationRoots.add(tempRoot.homeDir);
    try {
      if (preparationGeneration !== this.managedProfileArtifactsGeneration) {
        throw new Error(t('aws.sso.cancelledAccountChanged'));
      }
      const documents = await loadAwsProfileDocuments(tempRoot.awsRootDir);
      setAwsProfileKeyValueInDocuments(
        documents,
        "config",
        profileName,
        "sso_session",
        ssoSessionName,
      );
      if (region) {
        setAwsProfileKeyValueInDocuments(
          documents,
          "config",
          profileName,
          "region",
          region,
        );
      }
      setAwsSsoSessionKeyValueInDocuments(
        documents,
        ssoSessionName,
        "sso_region",
        ssoRegion,
      );
      setAwsSsoSessionKeyValueInDocuments(
        documents,
        ssoSessionName,
        "sso_start_url",
        ssoStartUrl,
      );
      setAwsSsoSessionKeyValueInDocuments(
        documents,
        ssoSessionName,
        "sso_registration_scopes",
        AWS_SSO_REGISTRATION_SCOPES,
      );
      await writeAwsProfileDocuments(documents);

      let accessToken: string;
      try {
        const login = await this.performSsoLoginForRoot({
          startUrl: ssoStartUrl,
          ssoRegion,
          sessionName: ssoSessionName,
          awsRootDir: tempRoot.awsRootDir,
        });
        accessToken = login.accessToken;
      } catch (error) {
        throw normalizeAwsProfileFlowSdkError(
          error,
          t('aws.sso.loginFailed'),
          "sso-login",
        );
      }

      const accounts = await this.listSsoAccounts({
        accessToken,
        ssoRegion,
      });
      if (accounts.length === 0) {
        throw new Error(t('aws.sso.noAccounts'));
      }

      const rolesByAccountId: Record<string, AwsSsoProfileRoleOption[]> = {};
      for (const account of accounts) {
        const roles = await this.listSsoRolesForAccount({
          accessToken,
          ssoRegion,
          accountId: account.accountId,
        });
        if (roles.length > 0) {
          rolesByAccountId[account.accountId] = roles;
        }
      }

      const defaultAccountId =
        accounts.find((account) => (rolesByAccountId[account.accountId] ?? []).length > 0)
          ?.accountId ?? null;
      const defaultRoleName = defaultAccountId
        ? rolesByAccountId[defaultAccountId]?.[0]?.roleName ?? null
        : null;

      if (!defaultAccountId || !defaultRoleName) {
        throw new Error(t('aws.sso.noAccountRolePairs'));
      }
      if (preparationGeneration !== this.managedProfileArtifactsGeneration) {
        throw new Error(t('aws.sso.cancelledAccountChanged'));
      }

      const preparationToken = randomUUID();
      this.inFlightSsoPreparationRoots.delete(tempRoot.homeDir);
      this.pendingSsoPreparations.set(preparationToken, {
        preparationToken,
        profileName,
        ssoSessionName,
        ssoStartUrl,
        ssoRegion,
        region,
        awsRootDir: tempRoot.awsRootDir,
        homeDir: tempRoot.homeDir,
        expiresAt: Date.now() + SSO_PREPARATION_TTL_MS,
        accounts,
        rolesByAccountId,
      });

      return {
        preparationToken,
        profileName,
        ssoSessionName,
        ssoStartUrl,
        ssoRegion,
        region,
        accounts,
        rolesByAccountId,
        defaultAccountId,
        defaultRoleName,
      };
    } catch (error) {
      this.inFlightSsoPreparationRoots.delete(tempRoot.homeDir);
      await this.destroyTempAwsRoot(tempRoot.homeDir);
      throw error;
    }
  }

  private async readConfigValue(
    profileName: string,
    key: string,
    awsRootDir = this.awsProfileRootDir,
  ): Promise<string> {
    try {
      const documents = await loadAwsProfileDocuments(awsRootDir);
      const snapshot = inspectAwsProfileDocuments(documents, profileName);
      return snapshot.mergedValues[key]?.trim() ?? "";
    } catch {
      return "";
    }
  }

  private async getProfileStatusFromRoot(
    profileName: string,
    awsRootDir: string,
    statusTimeoutMs = DEFAULT_AWS_COMMAND_TIMEOUT_MS,
  ): Promise<AwsProfileStatus> {
    const profileId =
      awsRootDir === this.awsProfileRootDir
        ? this.profileRepository.getMetadataByName(profileName)?.id ?? null
        : null;
    if (
      awsRootDir === this.awsProfileRootDir &&
      !profileId &&
      this.profileRepository.listMetadata().length > 0
    ) {
      return {
        id: null,
        profileName,
        available: false,
        isSsoProfile: false,
        isAuthenticated: false,
        configuredRegion: null,
        errorMessage: t('aws.profile.noneManaged'),
      };
    }
    if (isE2EFakeAwsSessionEnabled()) {
      return {
        id: profileId,
        profileName,
        available: true,
        isSsoProfile: false,
        isAuthenticated: true,
        configuredRegion: "ap-northeast-2",
        accountId: "000000000000",
        arn: "arn:aws:iam::000000000000:user/dolssh-smoke",
      };
    }


    const [ssoStartUrl, ssoSession, configuredRegion] = await Promise.all([
      this.readConfigValue(profileName, "sso_start_url", awsRootDir),
      this.readConfigValue(profileName, "sso_session", awsRootDir),
      this.readConfigValue(profileName, "region", awsRootDir),
    ]);
    const isSsoProfile = Boolean(ssoStartUrl || ssoSession);

    try {
      const identity = await this.stsGetCallerIdentityFromRoot(
        profileName,
        awsRootDir,
        statusTimeoutMs,
      );
      return {
        id: profileId,
        profileName,
        available: true,
        isSsoProfile,
        isAuthenticated: true,
        configuredRegion: configuredRegion || null,
        accountId: identity.account,
        arn: identity.arn,
      };
    } catch {
      return {
        id: profileId,
        profileName,
        available: true,
        isSsoProfile,
        isAuthenticated: false,
        configuredRegion: configuredRegion || null,
        errorMessage: isSsoProfile
          ? t('aws.auth.browserLoginRequired')
          : t('aws.auth.storedCredentialsFailed'),
      };
    }
  }

  async getProfileStatus(profileName: string): Promise<AwsProfileStatus> {
    await this.ensureManagedProfilesReady();
    return this.getProfileStatusFromRoot(profileName, this.awsProfileRootDir);
  }

  private async getProfileDetailsFromRoot(
    profileName: string,
    awsRootDir: string,
  ): Promise<AwsProfileDetails> {
    const normalizedProfileName = normalizeAwsProfileName(profileName);

    if (isE2EFakeAwsSessionEnabled()) {
      return {
        id: this.profileRepository.getMetadataByName(normalizedProfileName)?.id ?? null,
        profileName: normalizedProfileName,
        available: true,
        isSsoProfile: false,
        isAuthenticated: true,
        configuredRegion: "ap-northeast-2",
        accountId: "000000000000",
        arn: "arn:aws:iam::000000000000:user/dolssh-smoke",
        kind: "static",
        maskedAccessKeyId: "AKIA****SMOK",
        hasSecretAccessKey: true,
        hasSessionToken: false,
        roleArn: null,
        sourceProfile: null,
        credentialProcess: null,
        ssoSession: null,
        ssoStartUrl: null,
        ssoRegion: null,
        ssoAccountId: null,
        ssoRoleName: null,
        referencedByProfileNames: [],
        orphanedSsoSessionName: null,
      };
    }

    const [status, documents] = await Promise.all([
      this.getProfileStatusFromRoot(
        normalizedProfileName,
        awsRootDir,
        AWS_PROFILE_DETAILS_STATUS_TIMEOUT_MS,
      ),
      loadAwsProfileDocuments(awsRootDir),
    ]);
    const snapshot = inspectAwsProfileDocuments(documents, normalizedProfileName);
    const values = snapshot.mergedValues;
    const managedProfile =
      awsRootDir === this.awsProfileRootDir
        ? this.getManagedProfileByName(normalizedProfileName)
        : null;
    const ssoSession = values.sso_session?.trim() || null;
    const ssoSessionValues = ssoSession
      ? getAwsSsoSessionValues(documents, ssoSession)
      : {};
    const ssoStartUrl =
      values.sso_start_url?.trim() ||
      ssoSessionValues.sso_start_url?.trim() ||
      null;
    const ssoRegion =
      values.sso_region?.trim() ||
      ssoSessionValues.sso_region?.trim() ||
      null;
    const roleArn = values.role_arn?.trim() || null;
    const sourceProfile = values.source_profile?.trim() || null;
    const credentialProcess = values.credential_process?.trim() || null;
    const accessKeyId = values.aws_access_key_id?.trim() || null;
    const secretAccessKey = values.aws_secret_access_key?.trim() || null;
    const sessionToken = values.aws_session_token?.trim() || null;
    const ssoAccountId = values.sso_account_id?.trim() || null;
    const ssoRoleName = values.sso_role_name?.trim() || null;

    let kind: AwsProfileKind = "unknown";
    if (ssoStartUrl || ssoSession) {
      kind = "sso";
    } else if (roleArn || sourceProfile) {
      kind = "role";
    } else if (credentialProcess) {
      kind = "credential-process";
    } else if (accessKeyId || secretAccessKey) {
      kind = "static";
    }

    return {
      ...status,
      kind,
      maskedAccessKeyId: maskAwsAccessKeyId(accessKeyId),
      hasSecretAccessKey: Boolean(secretAccessKey),
      hasSessionToken: Boolean(sessionToken),
      roleArn,
      sourceProfileId:
        managedProfile?.kind === "role" ? managedProfile.sourceProfileId : null,
      sourceProfile,
      credentialProcess,
      ssoSession,
      ssoStartUrl,
      ssoRegion,
      ssoAccountId,
      ssoRoleName,
      referencedByProfileNames: snapshot.referencedByProfileNames,
      orphanedSsoSessionName: snapshot.orphanedSsoSessionName,
    };
  }

  async getProfileDetails(profileName: string): Promise<AwsProfileDetails> {
    await this.ensureManagedProfilesReady();
    return this.getProfileDetailsFromRoot(profileName, this.awsProfileRootDir);
  }

  async listExternalProfiles(): Promise<AwsProfileSummary[]> {
    return this.listProfilesFromRoot(this.externalAwsProfileRootDir);
  }

  async getExternalProfileDetails(profileName: string): Promise<AwsProfileDetails> {
    return this.getProfileDetailsFromRoot(profileName, this.externalAwsProfileRootDir);
  }

  async updateProfile(input: AwsProfileUpdateInput): Promise<void> {
    if (isE2EFakeAwsSessionEnabled()) {
      return;
    }

    await this.ensureManagedProfilesReady();

    const profileName = normalizeAwsProfileName(input.profileName);
    const accessKeyId = input.accessKeyId.trim();
    const secretAccessKey = input.secretAccessKey.trim();
    const region = input.region?.trim() || null;

    if (!accessKeyId) {
      throw new Error(t('aws.field.accessKeyRequired'));
    }
    if (!secretAccessKey) {
      throw new Error(t('aws.field.secretRequired'));
    }

    const currentProfile = this.getManagedProfileByName(profileName);
    if (!currentProfile || currentProfile.kind !== "static") {
      throw new Error(t('aws.profile.accessKeyOnly'));
    }

    await this.validateStaticCredentials({
      accessKeyId,
      secretAccessKey,
      region,
    });
    await this.saveStaticProfileValues({
      profileName,
      accessKeyId,
      secretAccessKey,
      region,
    });
  }

  async updateProfileRegion(input: AwsProfileRegionUpdateInput): Promise<void> {
    if (isE2EFakeAwsSessionEnabled()) {
      return;
    }

    await this.ensureManagedProfilesReady();

    const profileName = normalizeAwsProfileName(input.profileName);
    const region = input.region?.trim() || null;
    if (region && !(AWS_PROFILE_REGION_OPTIONS as readonly string[]).includes(region)) {
      throw new Error(t('aws.region.unsupported'));
    }

    const currentProfile = this.getManagedProfileByName(profileName);
    if (!currentProfile) {
      throw new Error(t('aws.profile.notFound'));
    }

    this.profileRepository.upsert({
      ...currentProfile,
      region,
      updatedAt: new Date().toISOString(),
    });
    await this.materializeManagedProfiles();
  }

  async renameProfile(input: AwsProfileRenameInput): Promise<void> {
    if (isE2EFakeAwsSessionEnabled()) {
      return;
    }

    await this.ensureManagedProfilesReady();

    const profileName = normalizeAwsProfileName(input.profileName);
    const nextProfileName = normalizeAwsProfileName(
      input.nextProfileName,
      'aws.field.newProfileName',
    );
    if (profileName === nextProfileName) {
      throw new Error(t('aws.profile.sameName'));
    }

    const currentProfile = this.getManagedProfileByName(profileName);
    if (!currentProfile) {
      throw new Error(t('aws.profile.notFound'));
    }
    if (this.getManagedProfileByName(nextProfileName)) {
      throw new Error(t('aws.profile.duplicateName'));
    }
    this.profileRepository.upsert({
      ...currentProfile,
      name: nextProfileName,
      updatedAt: new Date().toISOString(),
    });
    await this.materializeManagedProfiles();
  }

  async deleteProfile(profileName: string): Promise<void> {
    if (isE2EFakeAwsSessionEnabled()) {
      return;
    }

    await this.ensureManagedProfilesReady();

    const normalizedProfileName = normalizeAwsProfileName(profileName);
    const existingProfile = this.getManagedProfileByName(normalizedProfileName);
    if (!existingProfile) {
      throw new Error(t('aws.profile.notFound'));
    }
    this.profileRepository.remove(existingProfile.id);
    await this.materializeManagedProfiles();
  }

  async login(profileName: string): Promise<void> {
    if (isE2EFakeAwsSessionEnabled()) {
      return;
    }

    const status = await this.getProfileStatus(profileName);
    if (!status.isSsoProfile) {
      throw new Error(
        t('aws.auth.usesStoredCredentials'),
      );
    }

    const documents = await loadAwsProfileDocuments(this.awsProfileRootDir);
    const values = inspectAwsProfileDocuments(documents, profileName).mergedValues;
    const ssoSession = values.sso_session?.trim() || null;
    const sessionValues = ssoSession
      ? getAwsSsoSessionValues(documents, ssoSession)
      : {};
    const startUrl =
      values.sso_start_url?.trim() || sessionValues.sso_start_url?.trim() || "";
    const ssoRegion =
      values.sso_region?.trim() || sessionValues.sso_region?.trim() || "";
    if (!startUrl || !ssoRegion) {
      throw new Error(t('aws.sso.configMissing'));
    }

    try {
      await this.performSsoLoginForRoot({
        startUrl,
        ssoRegion,
        sessionName: ssoSession,
        awsRootDir: this.awsProfileRootDir,
      });
    } catch (error) {
      throw normalizeAwsProfileFlowSdkError(
        error,
        t('aws.sso.loginFailed'),
        "sso-login",
      );
    }
  }

  async isManagedInstance(
    profileName: string,
    region: string,
    instanceId: string,
  ): Promise<boolean> {
    if (isE2EFakeAwsSessionEnabled()) {
      return true;
    }

    try {
      const output = await this.getSsmClient(profileName, region).send(
        new DescribeInstanceInformationCommand({
          Filters: [{ Key: "InstanceIds", Values: [instanceId] }],
        }),
      );
      return (output.InstanceInformationList ?? []).some(
        (item) =>
          item.InstanceId?.trim() === instanceId &&
          isSsmPingStatusOnline(item.PingStatus),
      );
    } catch (error) {
      throw normalizeAwsSdkError(
        error,
        t('aws.ssm.statusFailed'),
      );
    }
  }

  async listRegions(profileName: string): Promise<string[]> {
    try {
      const output = await this.getEc2Client(
        profileName,
        REGION_DISCOVERY_REGION,
      ).send(new DescribeRegionsCommand({}));
      const regions = (output.Regions ?? [])
        .map((region) => region.RegionName?.trim() ?? "")
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
      return regions.length > 0 ? regions : [...DEFAULT_AWS_EC2_REGIONS];
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name} ${error.message}`
          : String(error);
      if (isDescribeRegionsPermissionDenied(detail)) {
        return [...DEFAULT_AWS_EC2_REGIONS];
      }
      throw normalizeAwsSdkError(error, t('aws.region.listFailed'));
    }
  }

  async listEc2Instances(
    profileName: string,
    region: string,
  ): Promise<AwsEc2InstanceSummary[]> {
    let payload: Ec2DescribeInstancesPayload;
    try {
      const client = this.getEc2Client(profileName, region);
      const reservations: NonNullable<
        Ec2DescribeInstancesPayload["Reservations"]
      > = [];
      let nextToken: string | undefined;
      do {
        const page = await client.send(
          new DescribeInstancesCommand({ NextToken: nextToken }),
          { abortSignal: AbortSignal.timeout(AWS_EC2_LIST_COMMAND_TIMEOUT_MS) },
        );
        reservations.push(...(page.Reservations ?? []));
        nextToken = page.NextToken?.trim() || undefined;
      } while (nextToken);
      payload = { Reservations: reservations };
    } catch (error) {
      throw normalizeAwsSdkError(
        error,
        t('aws.ec2.listFailed'),
      );
    }

    const treatAllAsSsmReady = isE2EFakeAwsSessionEnabled();
    const ssmLookup = treatAllAsSsmReady
      ? null
      : await this.loadSsmManagedInstanceLookup(profileName, region);
    const instances: AwsEc2InstanceSummary[] = [];
    for (const reservation of payload.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        const instanceId = instance.InstanceId?.trim();
        const summary = toInstanceSummary(instance, {
          ssmAvailability: treatAllAsSsmReady
            ? "ready"
            : ssmLookup?.unknownReason
            ? "unknown"
            : instanceId && ssmLookup?.readyInstanceIds.has(instanceId)
              ? "ready"
              : "unavailable",
          ssmAvailabilityReason: treatAllAsSsmReady
            ? null
            : ssmLookup?.unknownReason
            ? ssmLookup.unknownReason
            : instanceId && ssmLookup?.readyInstanceIds.has(instanceId)
              ? null
              : resolveUnavailableSsmReason({
                state: instance.State?.Name?.trim() || null,
                pingStatus:
                  instanceId && ssmLookup?.unavailableInstanceStatuses.has(instanceId)
                    ? ssmLookup.unavailableInstanceStatuses.get(instanceId) ?? null
                    : null,
              }),
        });
        if (summary) {
          instances.push(summary);
        }
      }
    }

    return instances.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.instanceId.localeCompare(right.instanceId),
    );
  }

  private async loadSsmManagedInstanceLookup(
    profileName: string,
    region: string,
  ): Promise<SsmManagedInstanceLookupResult> {
    try {
      const startedAt = Date.now();
      const getRemainingTimeoutMs = () =>
        Math.max(
          0,
          AWS_SSM_AVAILABILITY_LOOKUP_TIMEOUT_MS - (Date.now() - startedAt),
        );
      const getCommandTimeoutMs = () =>
        Math.max(
          1,
          Math.min(AWS_SSM_AVAILABILITY_COMMAND_TIMEOUT_MS, getRemainingTimeoutMs()),
        );
      const buildTimeoutError = () =>
        new Error(
          t('aws.ssm.statusTimeout'),
        );
      const readyInstanceIds = new Set<string>();
      const unavailableInstanceStatuses = new Map<string, string | null>();
      let nextToken: string | undefined;
      do {
        if (getRemainingTimeoutMs() <= 0) {
          throw buildTimeoutError();
        }
        const payload = await this.getSsmClient(profileName, region).send(
          new DescribeInstanceInformationCommand({ NextToken: nextToken }),
          { abortSignal: AbortSignal.timeout(getCommandTimeoutMs()) },
        );

        for (const item of payload.InstanceInformationList ?? []) {
          const instanceId = item.InstanceId?.trim();
          if (!instanceId) {
            continue;
          }
          const pingStatus = item.PingStatus?.trim() || null;
          if (isSsmPingStatusOnline(pingStatus)) {
            readyInstanceIds.add(instanceId);
          } else {
            unavailableInstanceStatuses.set(instanceId, pingStatus);
          }
        }

        nextToken = payload.NextToken?.trim() || undefined;
      } while (nextToken);

      return {
        readyInstanceIds,
        unavailableInstanceStatuses,
        unknownReason: null,
      };
    } catch (error) {
      return {
        readyInstanceIds: new Set<string>(),
        unavailableInstanceStatuses: new Map<string, string | null>(),
        unknownReason: resolveSsmLookupUnknownReason(error),
      };
    }
  }

  async listEcsClusters(
    profileName: string,
    region: string,
  ): Promise<AwsEcsClusterListItem[]> {
    try {
      const client = this.getEcsClient(profileName, region);
      const clusterArns: string[] = [];
      let nextToken: string | undefined;
      do {
        const payload = await client.send(
          new ListClustersCommand({
            nextToken,
          }),
        );
        clusterArns.push(
          ...((payload.clusterArns as EcsListClustersPayload["clusterArns"]) ?? [])
            .map((value) => value.trim())
            .filter(Boolean),
        );
        nextToken = payload.nextToken?.trim() || undefined;
      } while (nextToken);

      if (clusterArns.length === 0) {
        return [];
      }

      const clusters: NonNullable<EcsDescribeClustersPayload["clusters"]> = [];
      for (const clusterChunk of chunk(clusterArns, 100)) {
        const payload = await client.send(
          new DescribeClustersCommand({
            clusters: clusterChunk,
          }),
        );
        clusters.push(
          ...((payload.clusters as EcsDescribeClustersPayload["clusters"]) ?? []),
        );
      }

      return clusters
        .map((cluster) => {
          const clusterArn = cluster.clusterArn?.trim() ?? "";
          if (!clusterArn) {
            return null;
          }
          const clusterName =
            cluster.clusterName?.trim() || parseClusterNameFromArn(clusterArn);
          return {
            clusterArn,
            clusterName,
            status: cluster.status?.trim() || "UNKNOWN",
            activeServicesCount: cluster.activeServicesCount ?? 0,
            runningTasksCount: cluster.runningTasksCount ?? 0,
            pendingTasksCount: cluster.pendingTasksCount ?? 0,
          } satisfies AwsEcsClusterListItem;
        })
        .filter((value): value is AwsEcsClusterListItem => value !== null)
        .sort(
          (left, right) =>
            left.clusterName.localeCompare(right.clusterName) ||
            left.clusterArn.localeCompare(right.clusterArn),
        );
    } catch (error) {
      throw normalizeAwsSdkError(error, t('aws.ecs.clusterListFailed'));
    }
  }

  private async loadEcsServiceUtilizationMetrics(input: {
    profileName: string;
    region: string;
    clusterName: string;
    serviceNames: string[];
  }): Promise<{
    metricsByServiceName: Map<string, EcsServiceUtilizationMetrics>;
    warning: string | null;
  }> {
    const metricsByServiceName = new Map<string, EcsServiceUtilizationMetrics>(
      input.serviceNames.map((serviceName) => [
        serviceName,
        {
          cpuUtilizationPercent: null,
          memoryUtilizationPercent: null,
          cpuHistory: [],
          memoryHistory: [],
        },
      ]),
    );

    if (input.serviceNames.length === 0) {
      return { metricsByServiceName, warning: null };
    }

    try {
      const client = this.getCloudWatchClient(input.profileName, input.region);
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 10 * 60 * 1000);
      let offset = 0;
      for (const serviceChunk of chunk(input.serviceNames, 50)) {
        const idToMetric = new Map<
          string,
          { serviceName: string; kind: "cpu" | "memory" }
        >();
        const metricQueries = serviceChunk.flatMap((serviceName, index) => {
          const queryIndex = offset + index;
          const cpuId = `cpu${queryIndex}`;
          const memoryId = `mem${queryIndex}`;
          idToMetric.set(cpuId, { serviceName, kind: "cpu" });
          idToMetric.set(memoryId, { serviceName, kind: "memory" });
          return [
            {
              Id: cpuId,
              MetricStat: {
                Metric: {
                  Namespace: "AWS/ECS",
                  MetricName: "CPUUtilization",
                  Dimensions: [
                    { Name: "ClusterName", Value: input.clusterName },
                    { Name: "ServiceName", Value: serviceName },
                  ],
                },
                Period: 60,
                Stat: "Average",
              },
              ReturnData: true,
            },
            {
              Id: memoryId,
              MetricStat: {
                Metric: {
                  Namespace: "AWS/ECS",
                  MetricName: "MemoryUtilization",
                  Dimensions: [
                    { Name: "ClusterName", Value: input.clusterName },
                    { Name: "ServiceName", Value: serviceName },
                  ],
                },
                Period: 60,
                Stat: "Average",
              },
              ReturnData: true,
            },
          ];
        });

        const payload = await client.send(
          new GetMetricDataCommand({
            EndTime: endTime,
            MetricDataQueries: metricQueries,
            ScanBy: "TimestampDescending",
            StartTime: startTime,
          }),
        );

        for (const metricResult of payload.MetricDataResults ?? []) {
          const resultId = metricResult.Id?.trim() ?? "";
          const metricInfo = idToMetric.get(resultId);
          if (!metricInfo) {
            continue;
          }
          const existing = metricsByServiceName.get(metricInfo.serviceName);
          if (!existing) {
            continue;
          }
          const history = normalizeMetricHistory(metricResult);
          const value =
            history[history.length - 1]?.value ??
            pickLatestMetricValue(metricResult);
          if (metricInfo.kind === "cpu") {
            existing.cpuUtilizationPercent = value;
            existing.cpuHistory = history;
          } else {
            existing.memoryUtilizationPercent = value;
            existing.memoryHistory = history;
          }
        }

        offset += serviceChunk.length;
      }

      return { metricsByServiceName, warning: null };
    } catch {
      return {
        metricsByServiceName,
        warning:
          t('aws.ecs.metricsPartial'),
      };
    }
  }

  private async loadEcsServiceNames(input: {
    profileName: string;
    region: string;
    clusterArn: string;
  }): Promise<string[]> {
    const client = this.getEcsClient(input.profileName, input.region);
    const serviceArns: string[] = [];
    let nextToken: string | undefined;
    do {
      const payload = await client.send(
        new ListServicesCommand({
          cluster: input.clusterArn,
          nextToken,
        }),
      );
      serviceArns.push(
        ...((payload.serviceArns as EcsListServicesPayload["serviceArns"]) ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
      );
      nextToken = payload.nextToken?.trim() || undefined;
    } while (nextToken);

    return [...new Set(serviceArns.map(parseServiceNameFromArn).filter(Boolean))];
  }

  private async listEcsServiceNames(
    input: {
      profileName: string;
      region: string;
      clusterArn: string;
    },
    options?: {
      forceFresh?: boolean;
    },
  ): Promise<string[]> {
    if (options?.forceFresh) {
      return this.loadEcsServiceNames(input);
    }

    const cacheKey = this.buildEcsServiceListCacheKey(input);
    const cachedEntry = this.ecsServiceListCache.get(cacheKey);
    if (cachedEntry && this.isCacheEntryFresh(cachedEntry.expiresAt)) {
      return [...cachedEntry.value];
    }
    if (cachedEntry) {
      this.ecsServiceListCache.delete(cacheKey);
    }

    const inFlight = this.ecsServiceListInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight.then((serviceNames) => [...serviceNames]);
    }

    const loadPromise = this.loadEcsServiceNames(input)
      .then((serviceNames) => {
        this.setEcsServiceListCache(input, serviceNames);
        return serviceNames;
      })
      .finally(() => {
        this.ecsServiceListInFlight.delete(cacheKey);
      });
    this.ecsServiceListInFlight.set(cacheKey, loadPromise);
    return loadPromise.then((serviceNames) => [...serviceNames]);
  }

  private async describeEcsServices(input: {
    profileName: string;
    region: string;
    clusterArn: string;
    serviceNames: string[];
  }): Promise<NonNullable<EcsDescribeServicesPayload["services"]>> {
    const client = this.getEcsClient(input.profileName, input.region);
    const services: NonNullable<EcsDescribeServicesPayload["services"]> = [];
    for (const serviceChunk of chunk(input.serviceNames, 10)) {
      const payload = await client.send(
        new DescribeServicesCommand({
          cluster: input.clusterArn,
          services: serviceChunk,
        }),
      );
      services.push(...((payload.services as EcsDescribeServicesPayload["services"]) ?? []));
    }
    return services;
  }

  private async describeTaskDefinitions(
    profileName: string,
    region: string,
    taskDefinitionArns: string[],
  ): Promise<Map<string, EcsTaskDefinitionPayload["taskDefinition"]>> {
    const client = this.getEcsClient(profileName, region);
    const taskDefinitionByArn = new Map<
      string,
      EcsTaskDefinitionPayload["taskDefinition"]
    >();
    const uniqueTaskDefinitionArns = [...new Set(taskDefinitionArns.filter(Boolean))];
    await Promise.all(
      uniqueTaskDefinitionArns.map(async (taskDefinitionArn) => {
        const cachedEntry = this.ecsTaskDefinitionCache.get(taskDefinitionArn);
        if (cachedEntry && this.isCacheEntryFresh(cachedEntry.expiresAt)) {
          taskDefinitionByArn.set(taskDefinitionArn, cachedEntry.value);
          return;
        }
        if (cachedEntry) {
          this.ecsTaskDefinitionCache.delete(taskDefinitionArn);
        }

        const inFlight = this.ecsTaskDefinitionInFlight.get(taskDefinitionArn);
        if (inFlight) {
          taskDefinitionByArn.set(taskDefinitionArn, await inFlight);
          return;
        }

        const loadPromise = client
          .send(
            new DescribeTaskDefinitionCommand({
              taskDefinition: taskDefinitionArn,
            }),
          )
          .then((payload) => {
            const taskDefinition =
              (payload.taskDefinition as EcsTaskDefinitionPayload["taskDefinition"]) ??
              undefined;
            this.ecsTaskDefinitionCache.set(taskDefinitionArn, {
              expiresAt:
                Date.now() + AwsService.ECS_TASK_DEFINITION_CACHE_TTL_MS,
              value: taskDefinition,
            });
            return taskDefinition;
          })
          .finally(() => {
            this.ecsTaskDefinitionInFlight.delete(taskDefinitionArn);
          });
        this.ecsTaskDefinitionInFlight.set(taskDefinitionArn, loadPromise);
        taskDefinitionByArn.set(taskDefinitionArn, await loadPromise);
      }),
    );
    return taskDefinitionByArn;
  }

  private async listRunningEcsTaskArns(input: {
    profileName: string;
    region: string;
    clusterArn: string;
    serviceName: string;
  }): Promise<string[]> {
    const client = this.getEcsClient(input.profileName, input.region);
    const taskArns: string[] = [];
    let nextToken: string | undefined;

    do {
      const payload = await client.send(
        new ListTasksCommand({
          cluster: input.clusterArn,
          desiredStatus: "RUNNING",
          nextToken,
          serviceName: input.serviceName,
        }),
      );
      taskArns.push(
        ...((payload.taskArns as EcsListTasksPayload["taskArns"]) ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
      );
      nextToken = payload.nextToken?.trim() || undefined;
    } while (nextToken);

    return [...new Set(taskArns)];
  }

  private async describeEcsTasks(input: {
    profileName: string;
    region: string;
    clusterArn: string;
    taskArns: string[];
  }): Promise<AwsEcsServiceTaskSummary[]> {
    if (input.taskArns.length === 0) {
      return [];
    }
    const client = this.getEcsClient(input.profileName, input.region);
    const tasks: AwsEcsServiceTaskSummary[] = [];
    for (const taskChunk of chunk(input.taskArns, 100)) {
      const payload = await client.send(
        new DescribeTasksCommand({
          cluster: input.clusterArn,
          tasks: taskChunk,
        }),
      );
      tasks.push(
        ...((((payload.tasks as EcsDescribeTasksPayload["tasks"]) ?? []))
          .map((task): AwsEcsServiceTaskSummary | null => {
            const taskArn = task.taskArn?.trim() || "";
            if (!taskArn) {
              return null;
            }
            return {
              taskArn,
              taskId: parseTaskIdFromArn(taskArn),
              lastStatus: task.lastStatus?.trim() || null,
              enableExecuteCommand: task.enableExecuteCommand === true,
              containers: (task.containers ?? []).flatMap((container) => {
                const containerName = container.name?.trim() || "";
                if (!containerName) {
                  return [];
                }
                return [
                  {
                    containerName,
                    lastStatus: container.lastStatus?.trim() || null,
                    runtimeId: container.runtimeId?.trim() || null,
                  },
                ];
              }),
            };
          })
          .filter((value): value is AwsEcsServiceTaskSummary => value !== null)),
      );
    }
    return tasks.sort((left, right) => left.taskId.localeCompare(right.taskId));
  }

  private async loadEcsServiceContext(input: {
    profileName: string;
    region: string;
    clusterArn: string;
    serviceName: string;
  }): Promise<{
    service: NonNullable<EcsDescribeServicesPayload["services"]>[number];
    taskDefinition: EcsTaskDefinitionPayload["taskDefinition"] | undefined;
    runningTasks: AwsEcsServiceTaskSummary[];
  }> {
    const services = await this.describeEcsServices({
      profileName: input.profileName,
      region: input.region,
      clusterArn: input.clusterArn,
      serviceNames: [input.serviceName],
    });
    const service = services.find(
      (item) =>
        (item.serviceName?.trim() ||
          parseServiceNameFromArn(item.serviceArn?.trim() || "")) ===
        input.serviceName,
    );
    if (!service) {
      throw new Error(t('aws.ecs.serviceNotFound'));
    }

    const taskDefinitionArn = service.taskDefinition?.trim() || "";
    const taskDefinitions = await this.describeTaskDefinitions(
      input.profileName,
      input.region,
      taskDefinitionArn ? [taskDefinitionArn] : [],
    );
    const runningTaskArns = await this.listRunningEcsTaskArns(input);
    const runningTasks = await this.describeEcsTasks({
      profileName: input.profileName,
      region: input.region,
      clusterArn: input.clusterArn,
      taskArns: runningTaskArns,
    });

    return {
      service,
      taskDefinition: taskDefinitionArn
        ? taskDefinitions.get(taskDefinitionArn)
        : undefined,
      runningTasks,
    };
  }

  async listEcsTaskTunnelServices(
    profileName: string,
    region: string,
    clusterArn: string,
  ): Promise<AwsEcsTaskTunnelServiceSummary[]> {
    const serviceNames = await this.listEcsServiceNames({
      profileName,
      region,
      clusterArn,
    });
    const services = await this.describeEcsServices({
      profileName,
      region,
      clusterArn,
      serviceNames,
    });
    return services
      .map((service) => {
        const serviceName = service.serviceName?.trim() || service.serviceArn?.trim() || "";
        if (!serviceName) {
          return null;
        }
        return {
          serviceName,
          status: service.status?.trim() || "UNKNOWN",
          desiredCount: service.desiredCount ?? 0,
          runningCount: service.runningCount ?? 0,
          pendingCount: service.pendingCount ?? 0,
        } satisfies AwsEcsTaskTunnelServiceSummary;
      })
      .filter((value): value is AwsEcsTaskTunnelServiceSummary => value !== null)
      .sort((left, right) => left.serviceName.localeCompare(right.serviceName));
  }

  async describeEcsTaskTunnelService(
    profileName: string,
    region: string,
    clusterArn: string,
    serviceName: string,
  ): Promise<AwsEcsTaskTunnelServiceDetails> {
    const services = await this.describeEcsServices({
      profileName,
      region,
      clusterArn,
      serviceNames: [serviceName],
    });
    const service = services.find(
      (item) =>
        (item.serviceName?.trim() || parseServiceNameFromArn(item.serviceArn?.trim() || "")) === serviceName,
    );
    if (!service) {
      throw new Error(t('aws.ecs.serviceNotFound'));
    }

    const taskDefinitionArn = service.taskDefinition?.trim();
    if (!taskDefinitionArn) {
      return {
        serviceName,
        containers: [],
      };
    }
    const taskDefinitions = await this.describeTaskDefinitions(
      profileName,
      region,
      [taskDefinitionArn],
    );
    const taskDefinition = taskDefinitions.get(taskDefinitionArn);
    return {
      serviceName,
      containers: (taskDefinition?.containerDefinitions ?? [])
        .map((container): AwsEcsTaskTunnelContainerSummary | null => {
          const containerName = container.name?.trim() || "";
          if (!containerName) {
            return null;
          }
          return {
            containerName,
            ports: normalizeContainerTaskDefinitionPorts(container),
          };
        })
        .filter((value): value is AwsEcsTaskTunnelContainerSummary => value !== null)
        .sort((left, right) => left.containerName.localeCompare(right.containerName)),
    };
  }

  async describeEcsServiceActionContext(
    profileName: string,
    region: string,
    clusterArn: string,
    serviceName: string,
  ): Promise<AwsEcsServiceActionContext> {
    const cacheKey = this.buildEcsActionContextCacheKey({
      profileName,
      region,
      clusterArn,
      serviceName,
    });
    const cachedEntry = this.ecsServiceActionContextCache.get(cacheKey);
    if (cachedEntry && this.isCacheEntryFresh(cachedEntry.expiresAt)) {
      return cachedEntry.value;
    }
    if (cachedEntry) {
      this.ecsServiceActionContextCache.delete(cacheKey);
    }

    const inFlight = this.ecsServiceActionContextInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const loadPromise = this.loadEcsServiceContext({
      profileName,
      region,
      clusterArn,
      serviceName,
    })
      .then(({ service, taskDefinition, runningTasks }) => {
        const serviceArn = service.serviceArn?.trim() || "";
        if (!serviceArn) {
          throw new Error(t('aws.ecs.serviceNotFound'));
        }
        const context = {
          serviceName,
          serviceArn,
          taskDefinitionArn: service.taskDefinition?.trim() || null,
          taskDefinitionRevision: taskDefinition?.revision ?? null,
          containers: summarizeEcsActionContainers(taskDefinition, runningTasks),
          runningTasks,
          deployments: normalizeEcsDeployments(service.deployments ?? []).slice(0, 3),
          events: normalizeEcsEvents(service.events ?? [])
            .filter((event) => !shouldHideSteadyStateEvent(event.message))
            .slice(0, 5),
        } satisfies AwsEcsServiceActionContext;
        this.ecsServiceActionContextCache.set(cacheKey, {
          expiresAt:
            Date.now() + AwsService.ECS_SERVICE_ACTION_CONTEXT_CACHE_TTL_MS,
          value: context,
        });
        return context;
      })
      .finally(() => {
        this.ecsServiceActionContextInFlight.delete(cacheKey);
      });
    this.ecsServiceActionContextInFlight.set(cacheKey, loadPromise);
    return loadPromise;
  }

  async resolveEcsTaskTunnelTarget(input: {
    profileName: string;
    region: string;
    clusterArn: string;
    serviceName: string;
    containerName: string;
  }): Promise<string> {
    const taskArn = (
      await this.listRunningEcsTaskArns({
        profileName: input.profileName,
        region: input.region,
        clusterArn: input.clusterArn,
        serviceName: input.serviceName,
      })
    ).find(Boolean);
    if (!taskArn) {
      throw new Error(t('aws.ecs.noRunningTask'));
    }

    const tasks = await this.describeEcsTasks({
      profileName: input.profileName,
      region: input.region,
      clusterArn: input.clusterArn,
      taskArns: [taskArn],
    });
    const task = tasks.find(
      (item) => item.taskArn === taskArn,
    );
    if (!task) {
      throw new Error(t('aws.ecs.runningTaskDetailsMissing'));
    }
    if (!task.enableExecuteCommand) {
      throw new Error(
        t('aws.ecs.execDisabled'),
      );
    }

    const container = task.containers.find(
      (item) => item.containerName === input.containerName,
    );
    if (!container) {
      throw new Error(t('aws.ecs.containerNotInTask'));
    }
    const runtimeId = container.runtimeId?.trim() || "";
    if (!runtimeId) {
      throw new Error(t('aws.ecs.runtimeIdMissing'));
    }

    const clusterName = parseClusterNameFromArn(input.clusterArn);
    const taskId = parseTaskIdFromArn(taskArn);
    if (!clusterName || !taskId) {
      throw new Error(t('aws.ecs.targetBuildFailed'));
    }
    return `ecs:${clusterName}_${taskId}_${runtimeId}`;
  }

  async resolveEcsTaskTunnelTargetForTask(input: {
    profileName: string;
    region: string;
    clusterArn: string;
    taskArn: string;
    containerName: string;
  }): Promise<string> {
    const cachedContainerContext = this.getCachedEcsTaskContainerContext(input);
    if (cachedContainerContext && !cachedContainerContext.enableExecuteCommand) {
      throw new Error(
        t('aws.ecs.execDisabled'),
      );
    }

    let resolvedRuntimeId = cachedContainerContext?.runtimeId?.trim() || "";
    if (!resolvedRuntimeId) {
      const tasks = await this.describeEcsTasks({
        profileName: input.profileName,
        region: input.region,
        clusterArn: input.clusterArn,
        taskArns: [input.taskArn],
      });
      const task = tasks.find((item) => item.taskArn === input.taskArn);
      if (!task) {
        throw new Error(t('aws.ecs.taskDetailsMissing'));
      }
      if (!task.enableExecuteCommand) {
        throw new Error(
          t('aws.ecs.execDisabled'),
        );
      }
      const container = task.containers.find(
        (item) => item.containerName === input.containerName,
      );
      if (!container) {
        throw new Error(t('aws.ecs.containerNotInTask'));
      }
      resolvedRuntimeId = container.runtimeId?.trim() || "";
    }
    if (!resolvedRuntimeId) {
      throw new Error(t('aws.ecs.runtimeIdMissing'));
    }

    const clusterName = parseClusterNameFromArn(input.clusterArn);
    const taskId = parseTaskIdFromArn(input.taskArn);
    if (!clusterName || !taskId) {
      throw new Error(t('aws.ecs.targetBuildFailed'));
    }
    return `ecs:${clusterName}_${taskId}_${resolvedRuntimeId}`;
  }

  async loadEcsServiceLogs(input: {
    profileName: string;
    region: string;
    clusterArn: string;
    serviceName: string;
    taskArn?: string | null;
    containerName?: string | null;
    followCursor?: string | null;
    startTime?: string | null;
    endTime?: string | null;
    limit?: number;
  }): Promise<AwsEcsServiceLogsSnapshot> {
    const context = await this.describeEcsServiceActionContext(
      input.profileName,
      input.region,
      input.clusterArn,
      input.serviceName,
    );

    const taskOptions = context.runningTasks.map((task) => ({
      taskArn: task.taskArn,
      taskId: task.taskId,
    }));
    const containerOptions = context.containers.map(
      (container) => container.containerName,
    );
    const matchingTasks = context.runningTasks.filter(
      (task) => !input.taskArn || task.taskArn === input.taskArn,
    );
    const taskIds = new Set(matchingTasks.map((task) => task.taskId));
    const matchingContainers = context.containers.filter(
      (container) =>
        !input.containerName || container.containerName === input.containerName,
    );
    const supportedContainers = matchingContainers.filter(
      (container) =>
        container.logSupport.supported &&
        Boolean(container.logSupport.logGroupName?.trim()) &&
        Boolean(container.logSupport.logStreamPrefix?.trim()),
    );

    if (matchingContainers.length === 0) {
      return {
        serviceName: input.serviceName,
        entries: [],
        taskOptions,
        containerOptions,
        followCursor: input.followCursor ?? null,
        loadedAt: new Date().toISOString(),
        unsupportedReason: t('aws.logs.targetNotFound'),
      };
    }

    if (supportedContainers.length === 0) {
      return {
        serviceName: input.serviceName,
        entries: [],
        taskOptions,
        containerOptions,
        followCursor: input.followCursor ?? null,
        loadedAt: new Date().toISOString(),
        unsupportedReason:
          matchingContainers[0]?.logSupport.reason ??
          t('aws.logs.awslogsOnly'),
      };
    }

    if (input.taskArn && matchingTasks.length === 0) {
      return {
        serviceName: input.serviceName,
        entries: [],
        taskOptions,
        containerOptions,
        followCursor: input.followCursor ?? null,
        loadedAt: new Date().toISOString(),
        unsupportedReason: null,
      };
    }

    const entries: AwsEcsServiceLogEntry[] = [];
    const limit = input.limit ?? 5000;
    const absoluteStartTimestamp = input.startTime
      ? Date.parse(input.startTime)
      : Number.NaN;
    const absoluteEndTimestamp = input.endTime
      ? Date.parse(input.endTime)
      : Number.NaN;
    const followTimestamp = input.followCursor
      ? Date.parse(input.followCursor)
      : Number.NaN;
    const useAbsoluteRange =
      Number.isFinite(absoluteStartTimestamp) &&
      Number.isFinite(absoluteEndTimestamp);
    if (useAbsoluteRange && absoluteEndTimestamp < absoluteStartTimestamp) {
      throw new Error(t('aws.time.endBeforeStart'));
    }
    const startTimeMs = useAbsoluteRange
      ? absoluteStartTimestamp
      : Number.isFinite(followTimestamp)
        ? followTimestamp + 1
        : Date.now() - ECS_LOG_INITIAL_LOOKBACK_MS;
    const endTimeMs = useAbsoluteRange ? absoluteEndTimestamp : null;

    for (const container of supportedContainers) {
      const logGroupName = container.logSupport.logGroupName?.trim();
      const logRegion = container.logSupport.logRegion?.trim() || input.region;
      const logStreamPrefix = container.logSupport.logStreamPrefix?.trim();
      if (!logGroupName || !logStreamPrefix) {
        continue;
      }
      const payload = await this.getCloudWatchLogsClient(
        input.profileName,
        logRegion,
      ).send(
        new FilterLogEventsCommand({
          endTime: typeof endTimeMs === "number" ? endTimeMs : undefined,
          limit: Math.max(25, Math.ceil(limit / supportedContainers.length)),
          logGroupName,
          logStreamNamePrefix: `${logStreamPrefix}/${container.containerName}/`,
          startTime: startTimeMs,
        }),
      );
      for (const event of (payload.events as CloudWatchLogsFilterEventsPayload["events"]) ?? []) {
        if (typeof event.timestamp !== "number") {
          continue;
        }
        const logStreamName = event.logStreamName?.trim() || null;
        const taskId = logStreamName
          ? parseTaskIdFromLogStreamName(logStreamName)
          : null;
        if (taskIds.size > 0 && taskId && !taskIds.has(taskId)) {
          continue;
        }
        entries.push({
          id:
            event.eventId?.trim() ||
            `${event.timestamp}:${container.containerName}:${taskId ?? "task"}`,
          timestamp: new Date(event.timestamp).toISOString(),
          message: event.message ?? "",
          ingestionTime:
            typeof event.ingestionTime === "number"
              ? new Date(event.ingestionTime).toISOString()
              : null,
          logStreamName,
          taskId,
          containerName: container.containerName,
        });
      }
    }

    entries.sort(
      (left, right) =>
        Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
        left.id.localeCompare(right.id),
    );
    const trimmed = entries.slice(-limit);
    return {
      serviceName: input.serviceName,
      entries: trimmed,
      taskOptions,
      containerOptions,
      followCursor:
        trimmed[trimmed.length - 1]?.timestamp ?? input.followCursor ?? null,
      loadedAt: new Date().toISOString(),
      unsupportedReason: null,
    };
  }

  async describeEcsClusterSnapshot(
    profileName: string,
    region: string,
    clusterArn: string,
  ): Promise<AwsEcsClusterSnapshot> {
    const clusterPayload = await this.getEcsClient(profileName, region).send(
      new DescribeClustersCommand({
        clusters: [clusterArn],
      }),
    );
    const cluster = ((clusterPayload.clusters as EcsDescribeClustersPayload["clusters"]) ?? []).find(
      (item) => item.clusterArn?.trim() === clusterArn,
    );
    if (!cluster?.clusterArn?.trim()) {
      throw new Error(t('aws.ecs.clusterNotFound'));
    }

    const serviceNames = await this.listEcsServiceNames(
      {
        profileName,
        region,
        clusterArn,
      },
      { forceFresh: true },
    );

    const servicesPayloads = await this.describeEcsServices({
      profileName,
      region,
      clusterArn,
      serviceNames,
    });

    const uniqueTaskDefinitionArns = [
      ...new Set(
        servicesPayloads
          .map((service) => service.taskDefinition?.trim() ?? "")
          .filter(Boolean),
      ),
    ];
    const taskDefinitionByArn = await this.describeTaskDefinitions(
      profileName,
      region,
      uniqueTaskDefinitionArns,
    );

    const services = servicesPayloads
      .map((service): AwsEcsServiceSummary | null => {
        const serviceArn = service.serviceArn?.trim() ?? "";
        if (!serviceArn) {
          return null;
        }
        const taskDefinitionArn = service.taskDefinition?.trim() || null;
        const taskDefinition = taskDefinitionArn
          ? taskDefinitionByArn.get(taskDefinitionArn)
          : undefined;
        const primaryDeployment = (service.deployments ?? []).find(
          (deployment) => deployment.status?.trim().toUpperCase() === "PRIMARY",
        );
        return {
          serviceArn,
          serviceName: service.serviceName?.trim() || serviceArn,
          status: service.status?.trim() || "UNKNOWN",
          rolloutState: primaryDeployment?.rolloutState?.trim() || null,
          rolloutStateReason:
            primaryDeployment?.rolloutStateReason?.trim() || null,
          desiredCount: service.desiredCount ?? 0,
          runningCount: service.runningCount ?? 0,
          pendingCount: service.pendingCount ?? 0,
          launchType: service.launchType?.trim() || null,
          capacityProviderSummary: formatCapacityProviderSummary(
            service.capacityProviderStrategy ?? [],
          ),
          servicePorts: normalizeTaskDefinitionPorts(taskDefinition),
          exposureKinds: normalizeServiceExposureKinds(service),
          cpuUtilizationPercent: null,
          memoryUtilizationPercent: null,
          configuredCpu: normalizeTaskDefinitionCpu(taskDefinition),
          configuredMemory: normalizeTaskDefinitionMemory(taskDefinition),
          taskDefinitionArn,
          taskDefinitionRevision: taskDefinition?.revision ?? null,
          latestEventMessage:
            service.events?.[0]?.message?.trim() || null,
          deployments: normalizeEcsDeployments(service.deployments ?? []).slice(0, 3),
          events: normalizeEcsEvents(service.events ?? [])
            .filter((event) => !shouldHideSteadyStateEvent(event.message))
            .slice(0, 5),
        };
      })
      .filter((value): value is AwsEcsServiceSummary => value !== null)
      .sort(
        (left, right) =>
          left.serviceName.localeCompare(right.serviceName) ||
          left.serviceArn.localeCompare(right.serviceArn),
      );

    this.setEcsServiceListCache(
      {
        profileName,
        region,
        clusterArn,
      },
      serviceNames,
    );
    this.clearEcsServiceActionContextCacheForCluster({
      profileName,
      region,
      clusterArn,
    });

    return {
      profileName,
      region,
      cluster: {
        clusterArn: cluster.clusterArn.trim(),
        clusterName:
          cluster.clusterName?.trim() ||
          parseClusterNameFromArn(cluster.clusterArn),
        status: cluster.status?.trim() || "UNKNOWN",
        activeServicesCount: cluster.activeServicesCount ?? 0,
        runningTasksCount: cluster.runningTasksCount ?? 0,
        pendingTasksCount: cluster.pendingTasksCount ?? 0,
      },
      services,
      metricsWarning: null,
      loadedAt: new Date().toISOString(),
    };
  }

  async describeEcsClusterUtilization(
    profileName: string,
    region: string,
    clusterArn: string,
  ): Promise<AwsEcsClusterUtilizationSnapshot> {
    const serviceNames = await this.listEcsServiceNames({
      profileName,
      region,
      clusterArn,
    });
    const { metricsByServiceName, warning } =
      await this.loadEcsServiceUtilizationMetrics({
        profileName,
        region,
        clusterName: parseClusterNameFromArn(clusterArn),
        serviceNames,
      });

    return {
      loadedAt: new Date().toISOString(),
      warning,
      services: serviceNames.map((serviceName) => {
        const metrics = metricsByServiceName.get(serviceName);
        return {
          serviceName,
          cpuUtilizationPercent: metrics?.cpuUtilizationPercent ?? null,
          memoryUtilizationPercent: metrics?.memoryUtilizationPercent ?? null,
          cpuHistory: metrics?.cpuHistory ?? [],
          memoryHistory: metrics?.memoryHistory ?? [],
        };
      }),
    };
  }

  async describeEc2Instance(
    profileName: string,
    region: string,
    instanceId: string,
  ): Promise<AwsEc2InstanceSummary | null> {
    let payload: Ec2DescribeInstancesPayload;
    try {
      payload = await this.getEc2Client(profileName, region).send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
        { abortSignal: AbortSignal.timeout(60_000) },
      );
    } catch (error) {
      throw normalizeAwsSdkError(
        error,
        t('aws.ec2.detailsFailed'),
      );
    }
    for (const reservation of payload.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        const summary = toInstanceSummary(instance);
        if (summary) {
          return summary;
        }
      }
    }
    return null;
  }

  async sendSshPublicKey(input: AwsSendSshPublicKeyInput): Promise<void> {
    if (isE2EFakeAwsSessionEnabled()) {
      return;
    }

    try {
      const output = await this.getEc2InstanceConnectClient(
        input.profileName,
        input.region,
      ).send(
        new SendSSHPublicKeyCommand({
          InstanceId: input.instanceId,
          AvailabilityZone: input.availabilityZone,
          InstanceOSUser: input.osUser,
          SSHPublicKey: input.publicKey,
        }),
      );
      if (!output.Success) {
        throw new Error(
          t('aws.eic.pushDenied'),
        );
      }
    } catch (error) {
      throw normalizeAwsSdkError(
        error,
        t('aws.eic.pushFailed'),
      );
    }
  }

  // SSM sessions always run on the in-process data channel; the binary spawn
  // path is gone. The only exception is e2e fake mode, where Node must not
  // issue real AWS tokens — ssh-core serves the session from its fake fixtures.
  shouldUseInProcessSsm(): boolean {
    return !isE2EFakeAwsSessionEnabled();
  }

  async startSsmShellSession(
    profileName: string,
    region: string,
    instanceId: string,
  ): Promise<{ sessionId: string; streamUrl: string; tokenValue: string }> {
    try {
      const output = await this.getSsmClient(profileName, region).send(
        new StartSessionCommand({ Target: instanceId }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
      const sessionId = output.SessionId?.trim();
      const streamUrl = output.StreamUrl?.trim();
      const tokenValue = output.TokenValue?.trim();
      if (!sessionId || !streamUrl || !tokenValue) {
        throw new Error(t('aws.ssm.sessionNoStream'));
      }
      return { sessionId, streamUrl, tokenValue };
    } catch (error) {
      throw normalizeAwsSdkError(error, t('aws.ssm.sessionStartFailed'));
    }
  }

  // Bound issuer for core-manager's port-forward token hook: returns undefined
  // when the binary/e2e-fake path should be used, else a fresh SSM token.
  readonly ssmPortForwardTokenIssuer = async (input: {
    profileName: string;
    region: string;
    targetId: string;
    targetKind: string;
    targetPort: number;
    bindPort: number;
    remoteHost?: string;
  }): Promise<
    { sessionId: string; streamUrl: string; tokenValue: string } | undefined
  > => {
    if (!this.shouldUseInProcessSsm()) {
      return undefined;
    }
    return this.startSsmPortForwardSession(input);
  };

  async startSsmPortForwardSession(input: {
    profileName: string;
    region: string;
    targetId: string;
    targetKind: string;
    targetPort: number;
    bindPort: number;
    remoteHost?: string;
  }): Promise<{ sessionId: string; streamUrl: string; tokenValue: string }> {
    const isRemoteHost =
      input.targetKind === "remote-host" &&
      (input.remoteHost ?? "").trim() !== "";
    const documentName = isRemoteHost
      ? "AWS-StartPortForwardingSessionToRemoteHost"
      : "AWS-StartPortForwardingSession";
    const parameters: Record<string, string[]> = {
      portNumber: [String(input.targetPort)],
      localPortNumber: [String(input.bindPort)],
    };
    if (isRemoteHost) {
      parameters.host = [input.remoteHost!.trim()];
    }
    try {
      const output = await this.getSsmClient(input.profileName, input.region).send(
        new StartSessionCommand({
          Target: input.targetId,
          DocumentName: documentName,
          Parameters: parameters,
        }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
      const sessionId = output.SessionId?.trim();
      const streamUrl = output.StreamUrl?.trim();
      const tokenValue = output.TokenValue?.trim();
      if (!sessionId || !streamUrl || !tokenValue) {
        throw new Error(t('aws.ssm.forwardNoStream'));
      }
      return { sessionId, streamUrl, tokenValue };
    } catch (error) {
      throw normalizeAwsSdkError(error, t('aws.ssm.forwardStartFailed'));
    }
  }

  async startEcsExecSession(input: {
    profileName: string;
    region: string;
    clusterArn: string;
    taskArn: string;
    containerName: string;
    command: string;
  }): Promise<{ sessionId: string; streamUrl: string; tokenValue: string }> {
    try {
      const output = await this.getEcsClient(input.profileName, input.region).send(
        new ExecuteCommandCommand({
          cluster: input.clusterArn,
          task: input.taskArn,
          container: input.containerName,
          command: input.command,
          interactive: true,
        }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
      const session = output.session;
      const sessionId = session?.sessionId?.trim();
      const streamUrl = session?.streamUrl?.trim();
      const tokenValue = session?.tokenValue?.trim();
      if (!sessionId || !streamUrl || !tokenValue) {
        throw new Error(t('aws.ecs.execNoStream'));
      }
      return { sessionId, streamUrl, tokenValue };
    } catch (error) {
      throw normalizeAwsSdkError(error, t('aws.ecs.execStartFailed'));
    }
  }

  private async sendRunCommand(input: {
    profileName: string;
    region: string;
    instanceId: string;
    commands: string[];
    timeoutMs?: number;
  }): Promise<string> {
    let payload: SendCommandPayload;
    try {
      payload = await this.getSsmClient(input.profileName, input.region).send(
        new SendCommandCommand({
          InstanceIds: [input.instanceId],
          DocumentName: "AWS-RunShellScript",
          Parameters: { commands: input.commands },
        }),
        { abortSignal: AbortSignal.timeout(input.timeoutMs ?? 30_000) },
      );
    } catch (error) {
      throw normalizeAwsSdkError(error, t('aws.ssm.sendCommandFailed'));
    }
    const commandId = payload.Command?.CommandId?.trim();
    if (!commandId) {
      throw new Error(t('aws.ssm.commandIdMissing'));
    }
    return commandId;
  }

  private async getCommandInvocation(input: {
    profileName: string;
    region: string;
    instanceId: string;
    commandId: string;
    timeoutMs?: number;
  }): Promise<CommandInvocationPayload> {
    try {
      return await this.getSsmClient(input.profileName, input.region).send(
        new GetCommandInvocationCommand({
          InstanceId: input.instanceId,
          CommandId: input.commandId,
        }),
        { abortSignal: AbortSignal.timeout(input.timeoutMs ?? 30_000) },
      );
    } catch (error) {
      if (isSsmInvocationDoesNotExistError(error)) {
        throw new SsmInvocationNotReadyError();
      }
      throw normalizeAwsSdkError(
        error,
        t('aws.ssm.invocationReadFailed'),
      );
    }
  }

  async inspectHostSshMetadata(
    input: AwsHostSshInspectionInput,
  ): Promise<AwsHostSshInspectionResult> {
    try {
      const metadata = await this.loadHostSshMetadata(input);
      return {
        sshPort: metadata.sshPort,
        recommendedUsername: metadata.recommendedUsername,
        usernameCandidates: metadata.usernameCandidates,
        status: metadata.recommendedUsername ? "ready" : "error",
        errorMessage: metadata.recommendedUsername
          ? null
          : t('aws.ssh.noUserCandidates'),
      };
    } catch (error) {
      return {
        sshPort: 22,
        recommendedUsername: null,
        usernameCandidates: [],
        status: "error",
        errorMessage:
          error instanceof Error
            ? error.message
            : t('aws.ssh.configCheckFailed'),
      };
    }
  }

  async loadHostSshMetadata(
    input: AwsHostSshInspectionInput,
  ): Promise<AwsHostSshMetadataResult> {
    if (isE2EFakeAwsSessionEnabled()) {
      return {
        sshPort: 22,
        recommendedUsername: "ubuntu",
        usernameCandidates: ["ubuntu"],
      };
    }


    const startedAt = Date.now();
    const getRemainingTimeoutMs = () =>
      Math.max(0, AWS_SSH_METADATA_PROBE_TIMEOUT_MS - (Date.now() - startedAt));
    const getCommandTimeoutMs = () =>
      Math.max(
        1,
        Math.min(AWS_SSH_METADATA_COMMAND_TIMEOUT_MS, getRemainingTimeoutMs()),
      );
    const buildTimeoutError = () =>
      new Error(
        t('aws.ssh.configCheckTimeout'),
      );

    let commandId = "";
    try {
      if (getRemainingTimeoutMs() <= 0) {
        throw buildTimeoutError();
      }
      commandId = await this.sendRunCommand({
        profileName: input.profileName,
        region: input.region,
        instanceId: input.instanceId,
        commands: buildSshMetadataProbeCommands(),
        timeoutMs: getCommandTimeoutMs(),
      });
    } catch (error) {
      throw prefixInspectionError("send-command", error);
    }

    while (getRemainingTimeoutMs() > 0) {
      let invocation: CommandInvocationPayload;
      try {
        invocation = await this.getCommandInvocation({
          profileName: input.profileName,
          region: input.region,
          instanceId: input.instanceId,
          commandId,
          timeoutMs: getCommandTimeoutMs(),
        });
      } catch (error) {
        if (error instanceof SsmInvocationNotReadyError) {
          const delayMs = Math.min(
            AWS_SSH_METADATA_POLL_INTERVAL_MS,
            getRemainingTimeoutMs(),
          );
          if (delayMs <= 0) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw prefixInspectionError("read-ssh-config", error);
      }
      const status = (invocation.Status ?? "").trim();
      if (status === "Pending" || status === "InProgress" || status === "Delayed") {
        const delayMs = Math.min(
          AWS_SSH_METADATA_POLL_INTERVAL_MS,
          getRemainingTimeoutMs(),
        );
        if (delayMs <= 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      if (status !== "Success") {
        throw prefixInspectionError(
          "read-ssh-config",
          new Error(
            invocation.StandardErrorContent?.trim() ||
              t('aws.ssm.commandExitStatus', { status: status || 'Unknown' }),
          ),
        );
      }

      let parsed;
      try {
        parsed = parseMetadataProbeOutput(invocation.StandardOutputContent ?? "");
      } catch (error) {
        throw prefixInspectionError("analyze-users", error);
      }
      const candidates = [
        ...new Set([...parsed.homeUsers, ...parsed.passwdUsers]),
      ];
      return {
        sshPort: parsed.sshPort,
        recommendedUsername: recommendSshUsername(parsed),
        usernameCandidates: candidates,
      };
    }

    throw buildTimeoutError();
  }
}
