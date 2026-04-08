import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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

const REGION_DISCOVERY_REGION = "us-east-1";
const ECS_LOG_INITIAL_LOOKBACK_MS = 30 * 60 * 1000;
const AWS_SSO_REGISTRATION_SCOPES = "sso:account:access";
const SSO_PREPARATION_TTL_MS = 10 * 60 * 1000;

function isE2EFakeAwsSessionEnabled(): boolean {
  const mode = process.env.DOLSSH_E2E_FAKE_AWS_SESSION;
  return mode === "1" || mode === "process";
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface CommandError extends Error {
  code?: string;
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

export interface AwsSessionEnvSpec {
  env: Record<string, string>;
  unsetEnv: string[];
}

const resolvedExecutableCache = new Map<string, string>();

function splitPathEnv(): string[] {
  const rawPath = process.env.PATH ?? "";
  return rawPath
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function splitPathValue(rawPath: string | undefined): string[] {
  return (rawPath ?? "")
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function getExecutableCandidates(command: string): string[] {
  const candidates = new Set<string>();
  const pathEntries = splitPathEnv();

  if (process.platform === "win32") {
    if (command === "aws") {
      candidates.add("C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe");
    }
    if (command === "session-manager-plugin") {
      candidates.add(
        "C:\\Program Files\\Amazon\\SessionManagerPlugin\\bin\\session-manager-plugin.exe",
      );
    }

    for (const entry of pathEntries) {
      candidates.add(path.join(entry, `${command}.exe`));
    }
    for (const entry of pathEntries) {
      candidates.add(path.join(entry, `${command}.cmd`));
      candidates.add(path.join(entry, `${command}.bat`));
      candidates.add(path.join(entry, command));
    }
    return [...candidates];
  }

  for (const entry of pathEntries) {
    candidates.add(path.join(entry, command));
  }

  if (process.platform === "darwin") {
    if (command === "aws") {
      candidates.add(`/opt/aws-cli/bin/${command}`);
    }
    candidates.add(`/opt/homebrew/bin/${command}`);
    candidates.add(`/usr/local/bin/${command}`);
    candidates.add(`/usr/bin/${command}`);
  } else {
    if (command === "aws") {
      candidates.add(`/usr/local/aws-cli/v2/current/bin/${command}`);
    }
    candidates.add(`/usr/local/bin/${command}`);
    candidates.add(`/usr/bin/${command}`);
    candidates.add(`/bin/${command}`);
  }

  return [...candidates];
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(command: string): Promise<string> {
  if (resolvedExecutableCache.has(command)) {
    return resolvedExecutableCache.get(command)!;
  }

  for (const candidate of getExecutableCandidates(command)) {
    if (await pathExists(candidate)) {
      resolvedExecutableCache.set(command, candidate);
      return candidate;
    }
  }

  throw new Error(command);
}

const DEFAULT_AWS_COMMAND_TIMEOUT_MS = 30_000;
const AWS_PROFILE_DETAILS_STATUS_TIMEOUT_MS = 8_000;

function runCommand(
  command: string,
  args: string[],
  timeoutMs = DEFAULT_AWS_COMMAND_TIMEOUT_MS,
  envOverride?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: envOverride ?? process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("exit", (code) => {
      finish(() => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
        });
      });
    });

    const timeout = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error(`${command} 명령 실행이 제한 시간을 초과했습니다.`));
      });
    }, timeoutMs);
  });
}

export async function resolveAwsExecutable(
  command: "aws" | "session-manager-plugin",
): Promise<string> {
  return resolveExecutable(command);
}

export async function buildAwsCommandEnv(
  envPatch?: Record<string, string | null | undefined>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const env = { ...baseEnv };
  const resolvedDirs = new Set<string>();

  for (const command of ["aws", "session-manager-plugin"] as const) {
    try {
      const executablePath = await resolveExecutable(command);
      resolvedDirs.add(path.dirname(executablePath));
    } catch {
      // missing optional tool is handled by caller-specific availability checks
    }
  }

  const mergedPathEntries = [...resolvedDirs, ...splitPathValue(baseEnv.PATH)];
  env.PATH = [...new Set(mergedPathEntries)].join(path.delimiter);

  if (envPatch) {
    for (const [key, value] of Object.entries(envPatch)) {
      if (value === null || value === undefined) {
        delete env[key];
        continue;
      }
      env[key] = value;
    }
  }

  return env;
}

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

function normalizeAwsCliError(stderr: string, fallback: string): Error {
  const message = stderr.trim();
  if (!message) {
    return new Error(fallback);
  }
  return new Error(message);
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
        "입력한 Access Key 또는 Secret이 올바르지 않습니다. Secret이 다르거나 잘못된 키 조합일 수 있습니다. AWS 자격 증명을 다시 확인해 주세요.",
      );
    }
    if (
      errorCode === "InvalidClientTokenId" ||
      errorCode === "UnrecognizedClientException" ||
      /The security token included in the request is invalid/i.test(message)
    ) {
      return new Error(
        "입력한 Access Key 또는 Secret이 올바르지 않습니다. Access Key가 잘못되었거나 비활성화되었을 수 있습니다. AWS 자격 증명을 다시 확인해 주세요.",
      );
    }
  }

  if (context === "role-validation") {
    if (
      isAwsSsoSessionInvalidMessage(message) ||
      /retrieving token from sso|refresh failed/i.test(message)
    ) {
      return new Error(
        "선택한 source profile의 AWS SSO 로그인 세션이 유효하지 않습니다. 먼저 해당 source profile로 다시 로그인해 주세요.",
      );
    }
    if (
      (errorCode === "AccessDenied" || /AccessDenied/i.test(message)) &&
      /(AssumeRole|assume role|sts:AssumeRole)/i.test(message)
    ) {
      return new Error(
        "선택한 source profile로 이 Role을 Assume할 수 없습니다. IAM 권한과 대상 role trust policy를 확인해 주세요.",
      );
    }
    if (
      /Parameter validation failed:.*RoleArn/i.test(message) ||
      ((errorCode === "ValidationError" || /ValidationError/i.test(message)) &&
        /(role.?arn|AssumeRole|arn:aws:iam::)/i.test(message)) ||
      /invalid arn/i.test(message)
    ) {
      return new Error(
        "입력한 Role ARN이 올바르지 않거나 대상 Role을 찾을 수 없습니다. Role ARN 형식과 대상 Role을 다시 확인해 주세요.",
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
        "AWS SSO 로그인에 실패했습니다. SSO Start URL, SSO Region, 브라우저 로그인 상태를 확인해 주세요.",
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
        "SSO 로그인 후 account 또는 role 목록을 불러오지 못했습니다. 권한과 SSO 설정을 확인해 주세요.",
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
        "선택한 account/role로 인증을 완료하지 못했습니다. 다시 로그인하거나 다른 role을 선택해 주세요.",
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

function normalizeAwsProfileName(input: string, fieldLabel = "프로필명"): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(`${fieldLabel}을 입력해 주세요.`);
  }
  if (/[\r\n\]]/.test(trimmed)) {
    throw new Error(`${fieldLabel}에 사용할 수 없는 문자가 포함되어 있습니다.`);
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
        updatedAt: deployment.updatedAt?.trim() || deployment.createdAt?.trim() || null,
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
    .map((event, index) => ({
      id: `${event.createdAt?.trim() || "event"}:${index}`,
      message: event.message?.trim() || "",
      createdAt: event.createdAt?.trim() || null,
    }))
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
      reason: "이 컨테이너에는 CloudWatch Logs 설정이 없습니다.",
    };
  }
  if (logDriver !== "awslogs") {
    return {
      supported: false,
      reason: "v2 로그는 awslogs 드라이버만 지원합니다.",
    };
  }
  const options = containerDefinition?.logConfiguration?.options ?? {};
  const logGroupName = options["awslogs-group"]?.trim() || null;
  const logRegion = options["awslogs-region"]?.trim() || null;
  const logStreamPrefix = options["awslogs-stream-prefix"]?.trim() || null;
  if (!logGroupName || !logStreamPrefix) {
    return {
      supported: false,
      reason: "CloudWatch Logs 그룹 또는 stream prefix가 설정되지 않았습니다.",
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

function pickLatestMetricValue(
  metricResult: NonNullable<CloudWatchGetMetricDataPayload["MetricDataResults"]>[number],
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
    const timestamp = Date.parse(timestamps[index] ?? "");
    if (!Number.isNaN(timestamp) && timestamp > latestTime) {
      latestTime = timestamp;
      latestIndex = index;
    }
  }

  return typeof values[latestIndex] === "number" ? values[latestIndex] : null;
}

function normalizeMetricHistory(
  metricResult: NonNullable<
    CloudWatchGetMetricDataPayload["MetricDataResults"]
  >[number],
): AwsMetricHistoryPoint[] {
  const timestamps = metricResult.Timestamps ?? [];
  const values = metricResult.Values ?? [];
  if (timestamps.length === 0 || timestamps.length !== values.length) {
    return [];
  }

  const pointsByTimestamp = new Map<string, AwsMetricHistoryPoint>();
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index] ?? "";
    const timestampMs = Date.parse(timestamp);
    const value = values[index];
    if (Number.isNaN(timestampMs) || typeof value !== "number") {
      continue;
    }
    const normalizedTimestamp = new Date(timestampMs).toISOString();
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

type AwsHostSshInspectionStage =
  | "SSM 명령 전송"
  | "SSH 설정 조회"
  | "사용자 후보 분석";

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
    error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
  return new Error(`[${stage}] ${message}`);
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
  private readonly pendingSsoPreparations = new Map<
    string,
    AwsPendingSsoPreparation
  >();

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

  private async ensureManagedProfilesReady(): Promise<void> {
    if (this.profileRepository.listMetadata().length > 0) {
      return;
    }
    await this.migrateManagedProfilesFromFilesIfNeeded();
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

  resolveManagedProfileNameOrFallback(
    profileId: string | null | undefined,
    fallbackProfileName: string | null | undefined,
  ): string | null {
    return this.resolveManagedProfileName(profileId) ?? fallbackProfileName?.trim() ?? null;
  }

  private buildManagedSsoSessionKey(startUrl: string, ssoRegion: string): string {
    const digest = createHash("sha1")
      .update(`${startUrl.trim()}|${ssoRegion.trim()}`)
      .digest("hex")
      .slice(0, 12);
    return `dolssh-${digest}`;
  }

  private buildManagedProfilePayloadsFromDocuments(
    documents: Awaited<ReturnType<typeof loadAwsProfileDocuments>>,
  ): ManagedAwsProfilePayload[] {
    const profileNames = listAwsProfileNames(documents);
    const profileIdsByName = new Map(profileNames.map((profileName) => [profileName, randomUUID()]));
    const payloads: ManagedAwsProfilePayload[] = [];

    for (const profileName of profileNames) {
      const snapshot = inspectAwsProfileDocuments(documents, profileName);
      const values = snapshot.mergedValues;
      const region = values.region?.trim() || null;
      const ssoSession = values.sso_session?.trim() || null;
      const ssoSessionValues = ssoSession ? getAwsSsoSessionValues(documents, ssoSession) : {};
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
      const id = profileIdsByName.get(profileName) ?? randomUUID();

      if (ssoStartUrl && ssoRegion && ssoAccountId && ssoRoleName) {
        payloads.push({
          id,
          kind: "sso",
          name: profileName,
          region,
          ssoStartUrl,
          ssoRegion,
          ssoAccountId,
          ssoRoleName,
          updatedAt,
        });
        continue;
      }

      if (roleArn && sourceProfileName) {
        const sourceProfileId = profileIdsByName.get(sourceProfileName);
        if (!sourceProfileId) {
          continue;
        }
        payloads.push({
          id,
          kind: "role",
          name: profileName,
          region,
          roleArn,
          sourceProfileId,
          updatedAt,
        });
        continue;
      }

      if (accessKeyId && secretAccessKey) {
        payloads.push({
          id,
          kind: "static",
          name: profileName,
          region,
          accessKeyId,
          secretAccessKey,
          updatedAt,
        });
      }

    }

    return payloads;
  }

  async migrateManagedProfilesFromFilesIfNeeded(): Promise<void> {
    if (this.profileRepository.listMetadata().length > 0) {
      await this.materializeManagedProfiles();
      return;
    }

    const documents = await loadAwsProfileDocuments(this.awsProfileRootDir);
    const payloads = this.buildManagedProfilePayloadsFromDocuments(documents);
    if (payloads.length > 0) {
      this.profileRepository.replaceAll(payloads);
    }
    await this.materializeManagedProfiles();
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

  private async runResolvedCommand(
    command: string,
    args: string[],
    timeoutMs = DEFAULT_AWS_COMMAND_TIMEOUT_MS,
  ): Promise<CommandResult> {
    const executablePath = await resolveExecutable(command);
    const env = await this.buildManagedCommandEnv();
    return runCommand(executablePath, args, timeoutMs, env);
  }

  private async runResolvedCommandWithEnv(
    command: string,
    args: string[],
    envPatch: Record<string, string | null | undefined>,
    timeoutMs = DEFAULT_AWS_COMMAND_TIMEOUT_MS,
  ): Promise<CommandResult> {
    const executablePath = await resolveExecutable(command);
    const env = await this.buildManagedCommandEnv(process.env, envPatch);
    return runCommand(executablePath, args, timeoutMs, env);
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

  async buildManagedCommandEnv(
    baseEnv: NodeJS.ProcessEnv = process.env,
    envPatch?: Record<string, string | null | undefined>,
  ): Promise<NodeJS.ProcessEnv> {
    const sessionEnv = this.buildManagedSessionEnvSpec();
    const managedEnvPatch = Object.fromEntries([
      ...Object.entries(sessionEnv.env),
      ...sessionEnv.unsetEnv.map((key) => [key, null] as const),
    ]);
    return buildAwsCommandEnv(
      {
        ...managedEnvPatch,
        ...(envPatch ?? {}),
      },
      baseEnv,
    );
  }

  buildManagedSessionEnvSpec(): AwsSessionEnvSpec {
    return splitAwsSessionEnvSpec(this.getManagedAwsEnvOverrides());
  }

  private getConfiguredAwsRootEnvPatch(): Record<string, string | null> {
    return this.getManagedAwsEnvOverrides();
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

  private async destroyTempAwsRoot(homeDir: string): Promise<void> {
    await rm(homeDir, { recursive: true, force: true });
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
      throw new Error("SSO 준비 정보가 만료되었거나 존재하지 않습니다. 다시 로그인해 주세요.");
    }
    if (preparation.expiresAt <= Date.now()) {
      this.pendingSsoPreparations.delete(preparationToken);
      await this.destroyTempAwsRoot(preparation.homeDir);
      throw new Error("SSO 준비 정보가 만료되었습니다. 다시 로그인해 주세요.");
    }
    this.pendingSsoPreparations.delete(preparationToken);
    return preparation;
  }

  private async readSsoAccessToken(homeDir: string): Promise<string> {
    const cacheDir = path.join(homeDir, ".aws", "sso", "cache");
    let files: string[] = [];
    try {
      files = await readdir(cacheDir);
    } catch {
      throw new Error("AWS SSO access token cache를 찾지 못했습니다.");
    }

    for (const fileName of files) {
      if (!fileName.toLowerCase().endsWith(".json")) {
        continue;
      }
      try {
        const raw = await readFile(path.join(cacheDir, fileName), "utf8");
        const payload = parseJson<AwsSsoTokenCacheEntry>(
          raw,
          "AWS SSO token cache를 해석하지 못했습니다.",
        );
        const accessToken = payload.accessToken?.trim();
        if (accessToken) {
          return accessToken;
        }
      } catch {
        continue;
      }
    }

    throw new Error("AWS SSO access token을 찾지 못했습니다.");
  }

  private async listSsoAccounts(input: {
    accessToken: string;
    ssoRegion: string;
  }): Promise<AwsSsoProfileAccountOption[]> {
    const result = await this.runResolvedCommand(
      "aws",
      [
        "sso",
        "list-accounts",
        "--access-token",
        input.accessToken,
        "--region",
        input.ssoRegion,
        "--output",
        "json",
      ],
      60_000,
    );
    if (result.exitCode !== 0) {
      throw normalizeAwsProfileFlowError(
        result.stderr,
        "AWS SSO 계정 목록을 불러오지 못했습니다.",
        "sso-account-list",
      );
    }

    const payload = parseJson<{
      accountList?: Array<{
        accountId?: string;
        accountName?: string;
        emailAddress?: string;
      }>;
    }>(result.stdout, "AWS SSO 계정 목록 응답을 해석하지 못했습니다.");

    return (payload.accountList ?? [])
      .flatMap((item) => {
        const accountId = item.accountId?.trim() ?? "";
        if (!accountId) {
          return [];
        }
        return [{
          accountId,
          accountName: item.accountName?.trim() || accountId,
          emailAddress: item.emailAddress?.trim() || null,
        } satisfies AwsSsoProfileAccountOption];
      })
      .sort(
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
    const result = await this.runResolvedCommand(
      "aws",
      [
        "sso",
        "list-account-roles",
        "--access-token",
        input.accessToken,
        "--account-id",
        input.accountId,
        "--region",
        input.ssoRegion,
        "--output",
        "json",
      ],
      60_000,
    );
    if (result.exitCode !== 0) {
      throw normalizeAwsProfileFlowError(
        result.stderr,
        "AWS SSO role 목록을 불러오지 못했습니다.",
        "sso-role-list",
      );
    }

    const payload = parseJson<{
      roleList?: Array<{
        roleName?: string;
      }>;
    }>(result.stdout, "AWS SSO role 목록 응답을 해석하지 못했습니다.");

    return (payload.roleList ?? [])
      .flatMap((item) => {
        const roleName = item.roleName?.trim() ?? "";
        if (!roleName) {
          return [];
        }
        return [{
          accountId: input.accountId,
          roleName,
        } satisfies AwsSsoProfileRoleOption];
      })
      .sort((left, right) => left.roleName.localeCompare(right.roleName));
  }

  private async assertProfileNameAvailable(profileName: string): Promise<void> {
    if (this.profileRepository.getMetadataByName(profileName)) {
      throw new Error("같은 이름의 AWS 프로필이 이미 존재합니다.");
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
    const validationResult = await this.runResolvedCommandWithEnv(
      "aws",
      ["sts", "get-caller-identity", "--profile", input.profileName, "--output", "json"],
      {
        ...this.getAwsRootEnvPatch(input.homeDir, input.awsRootDir),
        AWS_PROFILE: null,
        AWS_DEFAULT_PROFILE: null,
      },
      30_000,
    );
    if (validationResult.exitCode !== 0) {
      throw normalizeAwsProfileFlowError(
        validationResult.stderr,
        input.fallbackMessage,
        input.errorContext,
      );
    }
  }

  private async validateAssumeRoleWithSourceProfile(input: {
    sourceProfileName: string;
    roleArn: string;
    errorContext: AwsProfileFlowErrorContext;
    fallbackMessage: string;
  }): Promise<void> {
    const sessionName = `dolssh-validate-${Date.now()}`;
    const validationResult = await this.runResolvedCommandWithEnv(
      "aws",
      [
        "sts",
        "assume-role",
        "--profile",
        input.sourceProfileName,
        "--role-arn",
        input.roleArn,
        "--role-session-name",
        sessionName,
        "--output",
        "json",
      ],
      {
        ...this.getConfiguredAwsRootEnvPatch(),
        AWS_PROFILE: null,
        AWS_DEFAULT_PROFILE: null,
        AWS_ACCESS_KEY_ID: null,
        AWS_SECRET_ACCESS_KEY: null,
        AWS_SESSION_TOKEN: null,
      },
      30_000,
    );
    if (validationResult.exitCode !== 0) {
      throw normalizeAwsProfileFlowError(
        validationResult.stderr,
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

  private async validateStaticCredentials(input: {
    accessKeyId: string;
    secretAccessKey: string;
    region?: string | null;
  }): Promise<void> {
    const validationResult = await this.runResolvedCommandWithEnv(
      "aws",
      ["sts", "get-caller-identity", "--output", "json"],
      {
        AWS_ACCESS_KEY_ID: input.accessKeyId,
        AWS_SECRET_ACCESS_KEY: input.secretAccessKey,
        AWS_REGION: input.region?.trim() || null,
        AWS_DEFAULT_REGION: input.region?.trim() || null,
        AWS_PROFILE: null,
        AWS_DEFAULT_PROFILE: null,
      },
      30_000,
    );
    if (validationResult.exitCode !== 0) {
      throw normalizeAwsProfileFlowError(
        validationResult.stderr,
        "입력한 AWS 자격 증명이 유효하지 않습니다.",
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

  async ensureAwsCliAvailable(): Promise<void> {
    if (isE2EFakeAwsSessionEnabled()) {
      return;
    }

    try {
      const result = await this.runResolvedCommand(
        "aws",
        ["--version"],
        10_000,
      );
      if (result.exitCode !== 0) {
        throw new Error("aws --version failed");
      }
    } catch (error) {
      throw new Error(
        "AWS CLI가 설치되어 있지 않습니다. `aws --version`이 동작해야 합니다.",
      );
    }
  }

  async ensureSessionManagerPluginAvailable(): Promise<void> {
    if (isE2EFakeAwsSessionEnabled()) {
      return;
    }

    try {
      const result = await this.runResolvedCommand(
        "session-manager-plugin",
        ["--version"],
        10_000,
      );
      if (result.exitCode !== 0) {
        throw new Error("session-manager-plugin --version failed");
      }
      return;
    } catch {
      throw new Error(
        "AWS Session Manager Plugin이 설치되어 있지 않아 SSM 세션을 열 수 없습니다.",
      );
    }
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
    await this.ensureAwsCliAvailable();

    if (input.kind === "static") {
      const profileName = normalizeAwsProfileName(input.profileName);
      const accessKeyId = input.accessKeyId.trim();
      const secretAccessKey = input.secretAccessKey.trim();
      const region = input.region?.trim() || null;

      if (!accessKeyId) {
        throw new Error("Access key를 입력해 주세요.");
      }
      if (!secretAccessKey) {
        throw new Error("Secret을 입력해 주세요.");
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
        throw new Error("Role ARN을 입력해 주세요.");
      }

      await this.assertProfileNameAvailable(profileName);
      if (!sourceProfile) {
        throw new Error("선택한 source profile을 찾지 못했습니다.");
      }

      await this.validateAssumeRoleWithSourceProfile({
        sourceProfileName: sourceProfile.name,
        roleArn,
        errorContext: "role-validation",
        fallbackMessage:
          "선택한 source profile로 이 Role을 검증하지 못했습니다.",
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
      throw new Error("SSO 계정을 선택해 주세요.");
    }
    if (!ssoRoleName) {
      throw new Error("SSO Role을 선택해 주세요.");
    }

    await this.assertProfileNameAvailable(profileName);
    const preparation = await this.consumeSsoPreparation(input.preparationToken);
    if (preparation.profileName !== profileName) {
      await this.destroyTempAwsRoot(preparation.homeDir);
      throw new Error("SSO 준비 정보와 선택한 프로필명이 일치하지 않습니다.");
    }
    if (
      preparation.ssoSessionName !== input.ssoSessionName ||
      preparation.ssoStartUrl !== input.ssoStartUrl.trim() ||
      preparation.ssoRegion !== input.ssoRegion.trim() ||
      preparation.region !== (input.region?.trim() || null)
    ) {
      await this.destroyTempAwsRoot(preparation.homeDir);
      throw new Error("SSO 준비 정보가 현재 입력값과 일치하지 않습니다. 다시 로그인해 주세요.");
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
          "선택한 account/role로 인증을 완료하지 못했습니다.",
      });
    } finally {
      await this.destroyTempAwsRoot(preparation.homeDir);
    }

    await this.saveSsoProfileValues({
      profileName,
      ssoSessionName: preparation.ssoSessionName,
      ssoStartUrl: preparation.ssoStartUrl,
      ssoRegion: preparation.ssoRegion,
      ssoAccountId,
      ssoRoleName,
      region: preparation.region,
    });
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

    await this.ensureManagedProfilesReady();
    await this.ensureAwsCliAvailable();
    this.pruneExpiredSsoPreparations();

    const profileName = normalizeAwsProfileName(input.profileName);
    const ssoStartUrl = input.ssoStartUrl.trim();
    const ssoRegion = input.ssoRegion.trim();
    const region = input.region?.trim() || null;

    if (!ssoStartUrl) {
      throw new Error("SSO Start URL을 입력해 주세요.");
    }
    if (!ssoRegion) {
      throw new Error("SSO Region을 선택해 주세요.");
    }

    await this.assertProfileNameAvailable(profileName);

    const ssoSessionName = await this.buildUniqueSsoSessionName(profileName);
    const tempRoot = await this.createTempAwsRoot();
    try {
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

      const envPatch = {
        ...this.getAwsRootEnvPatch(tempRoot.homeDir, tempRoot.awsRootDir),
        AWS_PROFILE: null,
        AWS_DEFAULT_PROFILE: null,
      };
      const loginResult = await this.runResolvedCommandWithEnv(
        "aws",
        ["sso", "login", "--profile", profileName],
        envPatch,
        5 * 60_000,
      );
      if (loginResult.exitCode !== 0) {
        throw normalizeAwsProfileFlowError(
          loginResult.stderr,
          "AWS SSO 로그인에 실패했습니다.",
          "sso-login",
        );
      }

      const accessToken = await this.readSsoAccessToken(tempRoot.homeDir);
      const accounts = await this.listSsoAccounts({
        accessToken,
        ssoRegion,
      });
      if (accounts.length === 0) {
        throw new Error("선택 가능한 AWS SSO 계정을 찾지 못했습니다.");
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
        throw new Error("선택 가능한 AWS SSO account/role 조합을 찾지 못했습니다.");
      }

      const preparationToken = randomUUID();
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
      await this.destroyTempAwsRoot(tempRoot.homeDir);
      throw error;
    }
  }

  private async readConfigValue(
    profileName: string,
    key: string,
    awsRootDir = this.awsProfileRootDir,
  ): Promise<string> {
    const result = await this.runResolvedCommandWithEnv(
      "aws",
      ["configure", "get", key, "--profile", profileName],
      this.getManagedAwsEnvOverrides(awsRootDir),
    );
    if (result.exitCode !== 0) {
      return "";
    }
    return result.stdout.trim();
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
        errorMessage: "앱 전용 AWS 프로필을 찾지 못했습니다. 먼저 프로필을 가져오거나 생성해 주세요.",
        missingTools: [],
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
        missingTools: [],
      };
    }

    await this.ensureAwsCliAvailable();

    const [ssoStartUrl, ssoSession, configuredRegion, pluginAvailable] = await Promise.all([
      this.readConfigValue(profileName, "sso_start_url", awsRootDir),
      this.readConfigValue(profileName, "sso_session", awsRootDir),
      this.readConfigValue(profileName, "region", awsRootDir),
      resolveExecutable("session-manager-plugin")
        .then(() => true)
        .catch(() => false),
    ]);
    const isSsoProfile = Boolean(ssoStartUrl || ssoSession);

    const identity = await this.runResolvedCommandWithEnv(
      "aws",
      [
        "sts",
        "get-caller-identity",
        "--profile",
        profileName,
        "--output",
        "json",
      ],
      this.getManagedAwsEnvOverrides(awsRootDir),
      statusTimeoutMs,
    );
    if (identity.exitCode === 0) {
      const payload = parseJson<{ Account?: string; Arn?: string }>(
        identity.stdout,
        "AWS 프로필 상태 응답을 해석하지 못했습니다.",
      );
      return {
        id: profileId,
        profileName,
        available: true,
        isSsoProfile,
        isAuthenticated: true,
        configuredRegion: configuredRegion || null,
        accountId: payload.Account ?? null,
        arn: payload.Arn ?? null,
        missingTools: pluginAvailable ? [] : ["session-manager-plugin"],
      };
    }

    return {
      id: profileId,
      profileName,
      available: true,
      isSsoProfile,
      isAuthenticated: false,
      configuredRegion: configuredRegion || null,
      errorMessage: isSsoProfile
        ? "브라우저 로그인이 필요합니다."
        : "이 프로필은 AWS CLI 자격 증명이 필요합니다.",
      missingTools: pluginAvailable ? [] : ["session-manager-plugin"],
    };
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
        missingTools: [],
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
    await this.ensureAwsCliAvailable();

    const profileName = normalizeAwsProfileName(input.profileName);
    const accessKeyId = input.accessKeyId.trim();
    const secretAccessKey = input.secretAccessKey.trim();
    const region = input.region?.trim() || null;

    if (!accessKeyId) {
      throw new Error("Access key를 입력해 주세요.");
    }
    if (!secretAccessKey) {
      throw new Error("Secret을 입력해 주세요.");
    }

    const currentProfile = this.getManagedProfileByName(profileName);
    if (!currentProfile || currentProfile.kind !== "static") {
      throw new Error("이 프로필은 access key 기반 프로필만 수정할 수 있습니다.");
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

  async renameProfile(input: AwsProfileRenameInput): Promise<void> {
    if (isE2EFakeAwsSessionEnabled()) {
      return;
    }

    await this.ensureManagedProfilesReady();
    await this.ensureAwsCliAvailable();

    const profileName = normalizeAwsProfileName(input.profileName);
    const nextProfileName = normalizeAwsProfileName(
      input.nextProfileName,
      "새 프로필명",
    );
    if (profileName === nextProfileName) {
      throw new Error("새 프로필명이 기존 프로필명과 같습니다.");
    }

    const currentProfile = this.getManagedProfileByName(profileName);
    if (!currentProfile) {
      throw new Error("선택한 AWS 프로필을 찾지 못했습니다.");
    }
    if (this.getManagedProfileByName(nextProfileName)) {
      throw new Error("같은 이름의 AWS 프로필이 이미 존재합니다.");
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
    await this.ensureAwsCliAvailable();

    const normalizedProfileName = normalizeAwsProfileName(profileName);
    const existingProfile = this.getManagedProfileByName(normalizedProfileName);
    if (!existingProfile) {
      throw new Error("선택한 AWS 프로필을 찾지 못했습니다.");
    }
    this.profileRepository.remove(existingProfile.id);
    await this.materializeManagedProfiles();
  }

  async login(profileName: string): Promise<void> {
    if (isE2EFakeAwsSessionEnabled()) {
      return;
    }

    await this.ensureAwsCliAvailable();
    const status = await this.getProfileStatus(profileName);
    if (!status.isSsoProfile) {
      throw new Error(
        "이 프로필은 브라우저 로그인 대신 AWS CLI 자격 증명이 필요합니다.",
      );
    }

    const result = await this.runResolvedCommand(
      "aws",
      ["sso", "login", "--profile", profileName],
      5 * 60_000,
    );
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(
        result.stderr,
        "AWS SSO 로그인에 실패했습니다.",
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

    await this.ensureAwsCliAvailable();
    await this.ensureSessionManagerPluginAvailable();

    const result = await this.runResolvedCommand("aws", [
      "ssm",
      "describe-instance-information",
      "--profile",
      profileName,
      "--region",
      region,
      "--filters",
      `Key=InstanceIds,Values=${instanceId}`,
      "--output",
      "json",
    ]);
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(
        result.stderr,
        "SSM managed instance 상태를 확인하지 못했습니다.",
      );
    }

    const payload = parseJson<{
      InstanceInformationList?: Array<{
        InstanceId?: string;
        PingStatus?: string;
      }>;
    }>(
      result.stdout,
      "SSM managed instance 응답을 해석하지 못했습니다.",
    );

    return (payload.InstanceInformationList ?? []).some(
      (item) =>
        item.InstanceId?.trim() === instanceId &&
        (item.PingStatus?.trim() ?? "") !== "Inactive",
    );
  }

  async listRegions(profileName: string): Promise<string[]> {
    await this.ensureAwsCliAvailable();
    const result = await this.runResolvedCommand("aws", [
      "ec2",
      "describe-regions",
      "--profile",
      profileName,
      "--region",
      REGION_DISCOVERY_REGION,
      "--output",
      "json",
    ]);
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(
        result.stderr,
        "AWS 리전 목록을 읽지 못했습니다.",
      );
    }

    const payload = parseJson<{ Regions?: Array<{ RegionName?: string }> }>(
      result.stdout,
      "AWS 리전 목록 응답을 해석하지 못했습니다.",
    );
    return (payload.Regions ?? [])
      .map((region) => region.RegionName?.trim() ?? "")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  }

  async listEc2Instances(
    profileName: string,
    region: string,
  ): Promise<AwsEc2InstanceSummary[]> {
    await this.ensureAwsCliAvailable();
    const result = await this.runResolvedCommand(
      "aws",
      [
        "ec2",
        "describe-instances",
        "--profile",
        profileName,
        "--region",
        region,
        "--output",
        "json",
      ],
      60_000,
    );
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(
        result.stderr,
        "EC2 인스턴스 목록을 읽지 못했습니다.",
      );
    }

    const payload = parseJson<Ec2DescribeInstancesPayload>(
      result.stdout,
      "EC2 인스턴스 응답을 해석하지 못했습니다.",
    );

    const instances: AwsEc2InstanceSummary[] = [];
    for (const reservation of payload.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        const summary = toInstanceSummary(instance);
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

  async listEcsClusters(
    profileName: string,
    region: string,
  ): Promise<AwsEcsClusterListItem[]> {
    await this.ensureAwsCliAvailable();

    const clusterArns: string[] = [];
    let nextToken: string | undefined;
    do {
      const args = [
        "ecs",
        "list-clusters",
        "--profile",
        profileName,
        "--region",
        region,
        "--output",
        "json",
      ];
      if (nextToken) {
        args.push("--starting-token", nextToken);
      }
      const result = await this.runResolvedCommand("aws", args, 60_000);
      if (result.exitCode !== 0) {
        throw normalizeAwsCliError(
          result.stderr,
          "ECS 클러스터 목록을 읽지 못했습니다.",
        );
      }
      const payload = parseJson<EcsListClustersPayload>(
        result.stdout,
        "ECS 클러스터 목록 응답을 해석하지 못했습니다.",
      );
      clusterArns.push(
        ...(payload.clusterArns ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
      );
      nextToken = payload.nextToken?.trim() || undefined;
    } while (nextToken);

    if (clusterArns.length === 0) {
      return [];
    }

    const result = await this.runResolvedCommand(
      "aws",
      [
        "ecs",
        "describe-clusters",
        "--profile",
        profileName,
        "--region",
        region,
        "--clusters",
        ...clusterArns,
        "--output",
        "json",
      ],
      60_000,
    );
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(
        result.stderr,
        "ECS 클러스터 상세 정보를 읽지 못했습니다.",
      );
    }
    const payload = parseJson<EcsDescribeClustersPayload>(
      result.stdout,
      "ECS 클러스터 상세 응답을 해석하지 못했습니다.",
    );

    return (payload.clusters ?? [])
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

        const result = await this.runResolvedCommand(
          "aws",
          [
            "cloudwatch",
            "get-metric-data",
            "--profile",
            input.profileName,
            "--region",
            input.region,
            "--start-time",
            startTime.toISOString(),
            "--end-time",
            endTime.toISOString(),
            "--scan-by",
            "TimestampDescending",
            "--metric-data-queries",
            JSON.stringify(metricQueries),
            "--output",
            "json",
          ],
          60_000,
        );
        if (result.exitCode !== 0) {
          throw normalizeAwsCliError(
            result.stderr,
            "ECS 현재 사용량 지표를 읽지 못했습니다.",
          );
        }

        const payload = parseJson<CloudWatchGetMetricDataPayload>(
          result.stdout,
          "ECS 현재 사용량 지표 응답을 해석하지 못했습니다.",
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
          "현재 사용량 지표를 읽지 못해 일부 서비스는 사용률이 표시되지 않을 수 있습니다.",
      };
    }
  }

  private async listEcsServiceNames(input: {
    profileName: string;
    region: string;
    clusterArn: string;
  }): Promise<string[]> {
    const serviceArns: string[] = [];
    let nextToken: string | undefined;
    do {
      const args = [
        "ecs",
        "list-services",
        "--profile",
        input.profileName,
        "--region",
        input.region,
        "--cluster",
        input.clusterArn,
        "--output",
        "json",
      ];
      if (nextToken) {
        args.push("--starting-token", nextToken);
      }
      const result = await this.runResolvedCommand("aws", args, 60_000);
      if (result.exitCode !== 0) {
        throw normalizeAwsCliError(
          result.stderr,
          "ECS 서비스 목록을 읽지 못했습니다.",
        );
      }
      const payload = parseJson<EcsListServicesPayload>(
        result.stdout,
        "ECS 서비스 목록 응답을 해석하지 못했습니다.",
      );
      serviceArns.push(
        ...(payload.serviceArns ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
      );
      nextToken = payload.nextToken?.trim() || undefined;
    } while (nextToken);

    return [...new Set(serviceArns.map(parseServiceNameFromArn).filter(Boolean))];
  }

  private async describeEcsServices(input: {
    profileName: string;
    region: string;
    clusterArn: string;
    serviceNames: string[];
  }): Promise<NonNullable<EcsDescribeServicesPayload["services"]>> {
    const services: NonNullable<EcsDescribeServicesPayload["services"]> = [];
    for (const serviceChunk of chunk(input.serviceNames, 10)) {
      const result = await this.runResolvedCommand(
        "aws",
        [
          "ecs",
          "describe-services",
          "--profile",
          input.profileName,
          "--region",
          input.region,
          "--cluster",
          input.clusterArn,
          "--services",
          ...serviceChunk,
          "--output",
          "json",
        ],
        60_000,
      );
      if (result.exitCode !== 0) {
        throw normalizeAwsCliError(
          result.stderr,
          "ECS 서비스 상세 정보를 읽지 못했습니다.",
        );
      }
      const payload = parseJson<EcsDescribeServicesPayload>(
        result.stdout,
        "ECS 서비스 상세 응답을 해석하지 못했습니다.",
      );
      services.push(...(payload.services ?? []));
    }
    return services;
  }

  private async describeTaskDefinitions(
    profileName: string,
    region: string,
    taskDefinitionArns: string[],
  ): Promise<Map<string, EcsTaskDefinitionPayload["taskDefinition"]>> {
    const taskDefinitionByArn = new Map<
      string,
      EcsTaskDefinitionPayload["taskDefinition"]
    >();
    await Promise.all(
      taskDefinitionArns.map(async (taskDefinitionArn) => {
        const result = await this.runResolvedCommand(
          "aws",
          [
            "ecs",
            "describe-task-definition",
            "--profile",
            profileName,
            "--region",
            region,
            "--task-definition",
            taskDefinitionArn,
            "--output",
            "json",
          ],
          60_000,
        );
        if (result.exitCode !== 0) {
          throw normalizeAwsCliError(
            result.stderr,
            "ECS task definition 정보를 읽지 못했습니다.",
          );
        }
        const payload = parseJson<EcsTaskDefinitionPayload>(
          result.stdout,
          "ECS task definition 응답을 해석하지 못했습니다.",
        );
        taskDefinitionByArn.set(taskDefinitionArn, payload.taskDefinition);
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
    const taskArns: string[] = [];
    let nextToken: string | undefined;

    do {
      const result = await this.runResolvedCommand(
        "aws",
        [
          "ecs",
          "list-tasks",
          "--profile",
          input.profileName,
          "--region",
          input.region,
          "--cluster",
          input.clusterArn,
          "--service-name",
          input.serviceName,
          "--desired-status",
          "RUNNING",
          ...(nextToken ? ["--next-token", nextToken] : []),
          "--output",
          "json",
        ],
        60_000,
      );
      if (result.exitCode !== 0) {
        throw normalizeAwsCliError(
          result.stderr,
          "ECS task 목록을 읽지 못했습니다.",
        );
      }
      const payload = parseJson<EcsListTasksPayload>(
        result.stdout,
        "ECS task 목록 응답을 해석하지 못했습니다.",
      );
      taskArns.push(
        ...(payload.taskArns ?? [])
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
    const tasks: AwsEcsServiceTaskSummary[] = [];
    for (const taskChunk of chunk(input.taskArns, 100)) {
      const result = await this.runResolvedCommand(
        "aws",
        [
          "ecs",
          "describe-tasks",
          "--profile",
          input.profileName,
          "--region",
          input.region,
          "--cluster",
          input.clusterArn,
          "--tasks",
          ...taskChunk,
          "--output",
          "json",
        ],
        60_000,
      );
      if (result.exitCode !== 0) {
        throw normalizeAwsCliError(
          result.stderr,
          "ECS task 상세 정보를 읽지 못했습니다.",
        );
      }
      const payload = parseJson<EcsDescribeTasksPayload>(
        result.stdout,
        "ECS task 상세 응답을 해석하지 못했습니다.",
      );
      tasks.push(
        ...((payload.tasks ?? [])
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
      throw new Error("선택한 ECS 서비스를 찾지 못했습니다.");
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
    await this.ensureAwsCliAvailable();
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
    await this.ensureAwsCliAvailable();
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
      throw new Error("선택한 ECS 서비스를 찾지 못했습니다.");
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
    await this.ensureAwsCliAvailable();
    const { service, taskDefinition, runningTasks } = await this.loadEcsServiceContext({
      profileName,
      region,
      clusterArn,
      serviceName,
    });
    const serviceArn = service.serviceArn?.trim() || "";
    if (!serviceArn) {
      throw new Error("선택한 ECS 서비스를 찾지 못했습니다.");
    }
    return {
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
    };
  }

  async resolveEcsTaskTunnelTarget(input: {
    profileName: string;
    region: string;
    clusterArn: string;
    serviceName: string;
    containerName: string;
  }): Promise<string> {
    await this.ensureAwsCliAvailable();
    const listResult = await this.runResolvedCommand(
      "aws",
      [
        "ecs",
        "list-tasks",
        "--profile",
        input.profileName,
        "--region",
        input.region,
        "--cluster",
        input.clusterArn,
        "--service-name",
        input.serviceName,
        "--desired-status",
        "RUNNING",
        "--output",
        "json",
      ],
      60_000,
    );
    if (listResult.exitCode !== 0) {
      throw normalizeAwsCliError(
        listResult.stderr,
        "ECS task 목록을 읽지 못했습니다.",
      );
    }
    const listPayload = parseJson<EcsListTasksPayload>(
      listResult.stdout,
      "ECS task 목록 응답을 해석하지 못했습니다.",
    );
    const taskArn = (listPayload.taskArns ?? [])
      .map((value) => value.trim())
      .find(Boolean);
    if (!taskArn) {
      throw new Error("이 서비스에 실행 중인 task가 없습니다.");
    }

    const describeResult = await this.runResolvedCommand(
      "aws",
      [
        "ecs",
        "describe-tasks",
        "--profile",
        input.profileName,
        "--region",
        input.region,
        "--cluster",
        input.clusterArn,
        "--tasks",
        taskArn,
        "--output",
        "json",
      ],
      60_000,
    );
    if (describeResult.exitCode !== 0) {
      throw normalizeAwsCliError(
        describeResult.stderr,
        "ECS task 상세 정보를 읽지 못했습니다.",
      );
    }
    const describePayload = parseJson<EcsDescribeTasksPayload>(
      describeResult.stdout,
      "ECS task 상세 응답을 해석하지 못했습니다.",
    );
    const task = (describePayload.tasks ?? []).find(
      (item) => item.taskArn?.trim() === taskArn,
    );
    if (!task) {
      throw new Error("실행 중인 ECS task 상세 정보를 찾지 못했습니다.");
    }
    if (task.enableExecuteCommand !== true) {
      throw new Error(
        "이 task는 ECS Exec가 활성화되어 있지 않아 터널을 열 수 없습니다.",
      );
    }

    const container = (task.containers ?? []).find(
      (item) => item.name?.trim() === input.containerName,
    );
    if (!container) {
      throw new Error("선택한 컨테이너를 실행 중인 task에서 찾지 못했습니다.");
    }
    const runtimeId = container.runtimeId?.trim() || "";
    if (!runtimeId) {
      throw new Error("선택한 컨테이너의 runtime ID를 확인하지 못했습니다.");
    }

    const clusterName = parseClusterNameFromArn(input.clusterArn);
    const taskId = parseTaskIdFromArn(taskArn);
    if (!clusterName || !taskId) {
      throw new Error("ECS task target을 구성하지 못했습니다.");
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
    await this.ensureAwsCliAvailable();
    const tasks = await this.describeEcsTasks({
      profileName: input.profileName,
      region: input.region,
      clusterArn: input.clusterArn,
      taskArns: [input.taskArn],
    });
    const task = tasks.find((item) => item.taskArn === input.taskArn);
    if (!task) {
      throw new Error("선택한 ECS task 상세 정보를 찾지 못했습니다.");
    }
    if (!task.enableExecuteCommand) {
      throw new Error(
        "이 task는 ECS Exec가 활성화되어 있지 않아 터널을 열 수 없습니다.",
      );
    }
    const container = task.containers.find(
      (item) => item.containerName === input.containerName,
    );
    if (!container) {
      throw new Error("선택한 컨테이너를 실행 중인 task에서 찾지 못했습니다.");
    }
    const runtimeId = container.runtimeId?.trim() || "";
    if (!runtimeId) {
      throw new Error("선택한 컨테이너의 runtime ID를 확인하지 못했습니다.");
    }

    const clusterName = parseClusterNameFromArn(input.clusterArn);
    const taskId = parseTaskIdFromArn(input.taskArn);
    if (!clusterName || !taskId) {
      throw new Error("ECS task target을 구성하지 못했습니다.");
    }
    return `ecs:${clusterName}_${taskId}_${runtimeId}`;
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
    await this.ensureAwsCliAvailable();
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
        unsupportedReason: "선택한 컨테이너 로그 대상을 찾지 못했습니다.",
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
          "v2 로그는 awslogs 드라이버만 지원합니다.",
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
      throw new Error("종료 시간이 시작 시간보다 빠를 수 없습니다.");
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
      const result = await this.runResolvedCommand(
        "aws",
        [
          "logs",
          "filter-log-events",
          "--profile",
          input.profileName,
          "--region",
          logRegion,
          "--log-group-name",
          logGroupName,
          "--log-stream-name-prefix",
          `${logStreamPrefix}/${container.containerName}/`,
          "--limit",
          String(Math.max(25, Math.ceil(limit / supportedContainers.length))),
          "--start-time",
          String(startTimeMs),
          ...(typeof endTimeMs === "number"
            ? ["--end-time", String(endTimeMs)]
            : []),
          "--output",
          "json",
        ],
        60_000,
      );
      if (result.exitCode !== 0) {
        throw normalizeAwsCliError(
          result.stderr,
          "CloudWatch Logs를 읽지 못했습니다.",
        );
      }
      const payload = parseJson<CloudWatchLogsFilterEventsPayload>(
        result.stdout,
        "CloudWatch Logs 응답을 해석하지 못했습니다.",
      );
      for (const event of payload.events ?? []) {
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
    await this.ensureAwsCliAvailable();

    const clusterResult = await this.runResolvedCommand(
      "aws",
      [
        "ecs",
        "describe-clusters",
        "--profile",
        profileName,
        "--region",
        region,
        "--clusters",
        clusterArn,
        "--output",
        "json",
      ],
      60_000,
    );
    if (clusterResult.exitCode !== 0) {
      throw normalizeAwsCliError(
        clusterResult.stderr,
        "ECS 클러스터 정보를 읽지 못했습니다.",
      );
    }
    const clusterPayload = parseJson<EcsDescribeClustersPayload>(
      clusterResult.stdout,
      "ECS 클러스터 응답을 해석하지 못했습니다.",
    );
    const cluster = (clusterPayload.clusters ?? []).find(
      (item) => item.clusterArn?.trim() === clusterArn,
    );
    if (!cluster?.clusterArn?.trim()) {
      throw new Error("선택한 ECS 클러스터를 찾지 못했습니다.");
    }

    const serviceNames = await this.listEcsServiceNames({
      profileName,
      region,
      clusterArn,
    });

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
    await this.ensureAwsCliAvailable();

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
    await this.ensureAwsCliAvailable();
    const result = await this.runResolvedCommand(
      "aws",
      [
        "ec2",
        "describe-instances",
        "--profile",
        profileName,
        "--region",
        region,
        "--instance-ids",
        instanceId,
        "--output",
        "json",
      ],
      60_000,
    );
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(
        result.stderr,
        "EC2 인스턴스 정보를 읽지 못했습니다.",
      );
    }

    const payload = parseJson<Ec2DescribeInstancesPayload>(
      result.stdout,
      "EC2 인스턴스 응답을 해석하지 못했습니다.",
    );
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

    await this.ensureAwsCliAvailable();
    const result = await this.runResolvedCommand(
      "aws",
      [
        "ec2-instance-connect",
        "send-ssh-public-key",
        "--profile",
        input.profileName,
        "--region",
        input.region,
        "--instance-id",
        input.instanceId,
        "--availability-zone",
        input.availabilityZone,
        "--instance-os-user",
        input.osUser,
        "--ssh-public-key",
        input.publicKey,
        "--output",
        "json",
      ],
      30_000,
    );
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(
        result.stderr,
        "EC2 Instance Connect 공개 키 전송에 실패했습니다.",
      );
    }

    const payload = parseJson<{ Success?: boolean; Message?: string }>(
      result.stdout,
      "EC2 Instance Connect 응답을 해석하지 못했습니다.",
    );
    if (!payload.Success) {
      throw new Error(
        payload.Message?.trim() ||
          "EC2 Instance Connect 공개 키 전송이 거부되었습니다.",
      );
    }
  }

  private async sendRunCommand(input: {
    profileName: string;
    region: string;
    instanceId: string;
    commands: string[];
  }): Promise<string> {
    const result = await this.runResolvedCommand(
      "aws",
      [
        "ssm",
        "send-command",
        "--profile",
        input.profileName,
        "--region",
        input.region,
        "--instance-ids",
        input.instanceId,
        "--document-name",
        "AWS-RunShellScript",
        "--parameters",
        `commands=${JSON.stringify(input.commands)}`,
        "--output",
        "json",
      ],
      30_000,
    );
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(
        result.stderr,
        "SSM 명령을 전송하지 못했습니다.",
      );
    }
    const payload = parseJson<SendCommandPayload>(
      result.stdout,
      "SSM 명령 전송 응답을 해석하지 못했습니다.",
    );
    const commandId = payload.Command?.CommandId?.trim();
    if (!commandId) {
      throw new Error("SSM 명령 ID를 확인하지 못했습니다.");
    }
    return commandId;
  }

  private async getCommandInvocation(input: {
    profileName: string;
    region: string;
    instanceId: string;
    commandId: string;
  }): Promise<CommandInvocationPayload> {
    const result = await this.runResolvedCommand(
      "aws",
      [
        "ssm",
        "get-command-invocation",
        "--profile",
        input.profileName,
        "--region",
        input.region,
        "--instance-id",
        input.instanceId,
        "--command-id",
        input.commandId,
        "--output",
        "json",
      ],
      30_000,
    );
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(
        result.stderr,
        "SSM 명령 실행 결과를 읽지 못했습니다.",
      );
    }
    return parseJson<CommandInvocationPayload>(
      result.stdout,
      "SSM 명령 실행 결과를 해석하지 못했습니다.",
    );
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
          : "SSH 로그인 사용자 후보를 찾지 못했습니다.",
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
            : "SSH 설정을 자동으로 확인하지 못했습니다.",
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

    try {
      await this.ensureAwsCliAvailable();
      await this.ensureSessionManagerPluginAvailable();
    } catch (error) {
      throw prefixInspectionError("SSM 명령 전송", error);
    }

    let commandId = "";
    try {
      commandId = await this.sendRunCommand({
        profileName: input.profileName,
        region: input.region,
        instanceId: input.instanceId,
        commands: buildSshMetadataProbeCommands(),
      });
    } catch (error) {
      throw prefixInspectionError("SSM 명령 전송", error);
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 90_000) {
      let invocation: CommandInvocationPayload;
      try {
        invocation = await this.getCommandInvocation({
          profileName: input.profileName,
          region: input.region,
          instanceId: input.instanceId,
          commandId,
        });
      } catch (error) {
        throw prefixInspectionError("SSH 설정 조회", error);
      }
      const status = (invocation.Status ?? "").trim();
      if (status === "Pending" || status === "InProgress" || status === "Delayed") {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        continue;
      }
      if (status !== "Success") {
        throw prefixInspectionError(
          "SSH 설정 조회",
          new Error(
          invocation.StandardErrorContent?.trim() ||
            `SSM 명령이 ${status || "Unknown"} 상태로 종료되었습니다.`,
          ),
        );
      }

      let parsed;
      try {
        parsed = parseMetadataProbeOutput(invocation.StandardOutputContent ?? "");
      } catch (error) {
        throw prefixInspectionError("사용자 후보 분석", error);
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

    throw new Error("SSH 설정 확인이 제한 시간을 초과했습니다.");
  }
}
