import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AwsEc2InstanceSummary, AwsProfileStatus, AwsProfileSummary } from '@shared';

const REGION_DISCOVERY_REGION = 'us-east-1';

function isE2EFakeAwsSessionEnabled(): boolean {
  return process.env.DOLSSH_E2E_FAKE_AWS_SESSION === '1';
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
  const rawPath = process.env.PATH ?? '';
  return rawPath
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function getExecutableCandidates(command: string): string[] {
  const candidates = new Set<string>();
  const pathEntries = splitPathEnv();

  if (process.platform === 'win32') {
    const suffixes = ['.exe', '.cmd', '.bat', ''];
    for (const entry of pathEntries) {
      for (const suffix of suffixes) {
        candidates.add(path.join(entry, `${command}${suffix}`));
      }
    }

    if (command === 'aws') {
      candidates.add('C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe');
    }
    if (command === 'session-manager-plugin') {
      candidates.add('C:\\Program Files\\Amazon\\SessionManagerPlugin\\bin\\session-manager-plugin.exe');
    }
    return [...candidates];
  }

  for (const entry of pathEntries) {
    candidates.add(path.join(entry, command));
  }

  if (process.platform === 'darwin') {
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

function runCommand(command: string, args: string[], timeoutMs = 30_000, envOverride?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: envOverride ?? process.env
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      finish(() => reject(error));
    });

    child.on('exit', (code) => {
      finish(() => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0
        });
      });
    });

    const timeout = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        reject(new Error(`${command} 명령 실행이 제한 시간을 초과했습니다.`));
      });
    }, timeoutMs);
  });
}

export async function resolveAwsExecutable(command: 'aws' | 'session-manager-plugin'): Promise<string> {
  return resolveExecutable(command);
}

export async function buildAwsCommandEnv(): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  const resolvedDirs = new Set<string>();

  for (const command of ['aws', 'session-manager-plugin'] as const) {
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

export class AwsService {
  private async runResolvedCommand(command: string, args: string[], timeoutMs = 30_000): Promise<CommandResult> {
    const executablePath = await resolveExecutable(command);
    const env = await buildAwsCommandEnv();
    return runCommand(executablePath, args, timeoutMs, env);
  }

  async ensureAwsCliAvailable(): Promise<void> {
    if (isE2EFakeAwsSessionEnabled()) {
      return;
    }

    try {
      const result = await this.runResolvedCommand('aws', ['--version'], 10_000);
      if (result.exitCode !== 0) {
        throw new Error('aws --version failed');
      }
    } catch (error) {
      throw new Error('AWS CLI가 설치되어 있지 않습니다. `aws --version`이 동작해야 합니다.');
    }
  }

  async ensureSessionManagerPluginAvailable(): Promise<void> {
    if (isE2EFakeAwsSessionEnabled()) {
      return;
    }

    try {
      const result = await this.runResolvedCommand('session-manager-plugin', ['--version'], 10_000);
      if (result.exitCode !== 0) {
        throw new Error('session-manager-plugin --version failed');
      }
      return;
    } catch {
      throw new Error('AWS Session Manager Plugin이 설치되어 있지 않아 SSM 세션을 열 수 없습니다.');
    }
  }

  async listProfiles(): Promise<AwsProfileSummary[]> {
    await this.ensureAwsCliAvailable();
    const result = await this.runResolvedCommand('aws', ['configure', 'list-profiles']);
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(result.stderr, 'AWS 프로필 목록을 읽지 못했습니다.');
    }

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((name) => ({ name }));
  }

  private async readConfigValue(profileName: string, key: string): Promise<string> {
    const result = await this.runResolvedCommand('aws', ['configure', 'get', key, '--profile', profileName]);
    if (result.exitCode !== 0) {
      return '';
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
        accountId: '000000000000',
        arn: 'arn:aws:iam::000000000000:user/dolssh-smoke',
        missingTools: []
      };
    }

    await this.ensureAwsCliAvailable();

    const [ssoStartUrl, ssoSession, pluginAvailable] = await Promise.all([
      this.readConfigValue(profileName, 'sso_start_url'),
      this.readConfigValue(profileName, 'sso_session'),
      resolveExecutable('session-manager-plugin')
        .then(() => true)
        .catch(() => false)
    ]);
    const isSsoProfile = Boolean(ssoStartUrl || ssoSession);

    const identity = await this.runResolvedCommand('aws', ['sts', 'get-caller-identity', '--profile', profileName, '--output', 'json']);
    if (identity.exitCode === 0) {
      const payload = parseJson<{ Account?: string; Arn?: string }>(identity.stdout, 'AWS 프로필 상태 응답을 해석하지 못했습니다.');
      return {
        profileName,
        available: true,
        isSsoProfile,
        isAuthenticated: true,
        accountId: payload.Account ?? null,
        arn: payload.Arn ?? null,
        missingTools: pluginAvailable ? [] : ['session-manager-plugin']
      };
    }

    return {
      profileName,
      available: true,
      isSsoProfile,
      isAuthenticated: false,
      errorMessage: isSsoProfile ? '브라우저 로그인이 필요합니다.' : '이 프로필은 AWS CLI 자격 증명이 필요합니다.',
      missingTools: pluginAvailable ? [] : ['session-manager-plugin']
    };
  }

  async login(profileName: string): Promise<void> {
    if (isE2EFakeAwsSessionEnabled()) {
      return;
    }

    await this.ensureAwsCliAvailable();
    const status = await this.getProfileStatus(profileName);
    if (!status.isSsoProfile) {
      throw new Error('이 프로필은 브라우저 로그인 대신 AWS CLI 자격 증명이 필요합니다.');
    }

    const result = await this.runResolvedCommand('aws', ['sso', 'login', '--profile', profileName], 5 * 60_000);
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(result.stderr, 'AWS SSO 로그인에 실패했습니다.');
    }
  }

  async listRegions(profileName: string): Promise<string[]> {
    await this.ensureAwsCliAvailable();
    const result = await this.runResolvedCommand('aws', [
      'ec2',
      'describe-regions',
      '--profile',
      profileName,
      '--region',
      REGION_DISCOVERY_REGION,
      '--output',
      'json'
    ]);
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(result.stderr, 'AWS 리전 목록을 읽지 못했습니다.');
    }

    const payload = parseJson<{ Regions?: Array<{ RegionName?: string }> }>(result.stdout, 'AWS 리전 목록 응답을 해석하지 못했습니다.');
    return (payload.Regions ?? [])
      .map((region) => region.RegionName?.trim() ?? '')
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  }

  async listEc2Instances(profileName: string, region: string): Promise<AwsEc2InstanceSummary[]> {
    await this.ensureAwsCliAvailable();
    const result = await this.runResolvedCommand(
      'aws',
      ['ec2', 'describe-instances', '--profile', profileName, '--region', region, '--output', 'json'],
      60_000
    );
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(result.stderr, 'EC2 인스턴스 목록을 읽지 못했습니다.');
    }

    const payload = parseJson<{
      Reservations?: Array<{
        Instances?: Array<{
          InstanceId?: string;
          Platform?: string;
          PlatformDetails?: string;
          PrivateIpAddress?: string;
          State?: { Name?: string };
          Tags?: Array<{ Key?: string; Value?: string }>;
        }>;
      }>;
    }>(result.stdout, 'EC2 인스턴스 응답을 해석하지 못했습니다.');

    const instances: AwsEc2InstanceSummary[] = [];
    for (const reservation of payload.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        const instanceId = instance.InstanceId?.trim();
        if (!instanceId) {
          continue;
        }
        const nameTag = instance.Tags?.find((tag) => tag.Key === 'Name')?.Value?.trim();
        instances.push({
          instanceId,
          name: nameTag || instanceId,
          platform: instance.PlatformDetails?.trim() || instance.Platform?.trim() || null,
          privateIp: instance.PrivateIpAddress?.trim() || null,
          state: instance.State?.Name?.trim() || null
        });
      }
    }

    return instances.sort((left, right) => left.name.localeCompare(right.name) || left.instanceId.localeCompare(right.instanceId));
  }
}
