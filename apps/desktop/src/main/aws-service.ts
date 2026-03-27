import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  AwsEc2InstanceSummary,
  AwsHostSshInspectionInput,
  AwsHostSshInspectionResult,
  AwsProfileStatus,
  AwsProfileSummary,
} from "@shared";

const REGION_DISCOVERY_REGION = "us-east-1";

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

const resolvedExecutableCache = new Map<string, string | null>();

function splitPathEnv(): string[] {
  const rawPath = process.env.PATH ?? "";
  return rawPath
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
    candidates.add(`/opt/homebrew/bin/${command}`);
    candidates.add(`/usr/local/bin/${command}`);
    candidates.add(`/usr/bin/${command}`);
  } else {
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
    const cached = resolvedExecutableCache.get(command);
    if (cached) {
      return cached;
    }
    throw new Error(command);
  }

  for (const candidate of getExecutableCandidates(command)) {
    if (await pathExists(candidate)) {
      resolvedExecutableCache.set(command, candidate);
      return candidate;
    }
  }

  resolvedExecutableCache.set(command, null);
  throw new Error(command);
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs = 30_000,
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

export async function buildAwsCommandEnv(): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  const resolvedDirs = new Set<string>();

  for (const command of ["aws", "session-manager-plugin"] as const) {
    try {
      const executablePath = await resolveExecutable(command);
      resolvedDirs.add(path.dirname(executablePath));
    } catch {
      // missing optional tool is handled by caller-specific availability checks
    }
  }

  const mergedPathEntries = [...resolvedDirs, ...splitPathEnv()];
  env.PATH = [...new Set(mergedPathEntries)].join(path.delimiter);
  return env;
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
  private async runResolvedCommand(
    command: string,
    args: string[],
    timeoutMs = 30_000,
  ): Promise<CommandResult> {
    const executablePath = await resolveExecutable(command);
    const env = await buildAwsCommandEnv();
    return runCommand(executablePath, args, timeoutMs, env);
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
    await this.ensureAwsCliAvailable();
    const result = await this.runResolvedCommand("aws", [
      "configure",
      "list-profiles",
    ]);
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(
        result.stderr,
        "AWS 프로필 목록을 읽지 못했습니다.",
      );
    }

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((name) => ({ name }));
  }

  private async readConfigValue(
    profileName: string,
    key: string,
  ): Promise<string> {
    const result = await this.runResolvedCommand("aws", [
      "configure",
      "get",
      key,
      "--profile",
      profileName,
    ]);
    if (result.exitCode !== 0) {
      return "";
    }
    return result.stdout.trim();
  }

  async getProfileStatus(profileName: string): Promise<AwsProfileStatus> {
    if (isE2EFakeAwsSessionEnabled()) {
      return {
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
      this.readConfigValue(profileName, "sso_start_url"),
      this.readConfigValue(profileName, "sso_session"),
      this.readConfigValue(profileName, "region"),
      resolveExecutable("session-manager-plugin")
        .then(() => true)
        .catch(() => false),
    ]);
    const isSsoProfile = Boolean(ssoStartUrl || ssoSession);

    const identity = await this.runResolvedCommand("aws", [
      "sts",
      "get-caller-identity",
      "--profile",
      profileName,
      "--output",
      "json",
    ]);
    if (identity.exitCode === 0) {
      const payload = parseJson<{ Account?: string; Arn?: string }>(
        identity.stdout,
        "AWS 프로필 상태 응답을 해석하지 못했습니다.",
      );
      return {
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
