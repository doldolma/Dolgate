import { spawn } from 'node:child_process';
import type { AwsEc2InstanceSummary, AwsProfileStatus, AwsProfileSummary } from '@shared';

const REGION_DISCOVERY_REGION = 'us-east-1';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface CommandError extends Error {
  code?: string;
}

function runCommand(command: string, args: string[], timeoutMs = 30_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env
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

function parseJson<T>(raw: string, fallbackMessage: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(fallbackMessage);
  }
}

async function commandExists(command: string, args: string[]): Promise<boolean> {
  try {
    await runCommand(command, args, 10_000);
    return true;
  } catch (error) {
    const commandError = error as CommandError;
    if (commandError?.code === 'ENOENT') {
      return false;
    }
    return true;
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
  async ensureAwsCliAvailable(): Promise<void> {
    const available = await commandExists('aws', ['--version']);
    if (!available) {
      throw new Error('AWS CLI가 설치되어 있지 않습니다. `aws --version`이 동작해야 합니다.');
    }
  }

  async ensureSessionManagerPluginAvailable(): Promise<void> {
    const available = await commandExists('session-manager-plugin', ['--version']);
    if (!available) {
      throw new Error('AWS Session Manager Plugin이 설치되어 있지 않아 SSM 세션을 열 수 없습니다.');
    }
  }

  async listProfiles(): Promise<AwsProfileSummary[]> {
    await this.ensureAwsCliAvailable();
    const result = await runCommand('aws', ['configure', 'list-profiles']);
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
    const result = await runCommand('aws', ['configure', 'get', key, '--profile', profileName]);
    if (result.exitCode !== 0) {
      return '';
    }
    return result.stdout.trim();
  }

  async getProfileStatus(profileName: string): Promise<AwsProfileStatus> {
    await this.ensureAwsCliAvailable();

    const [ssoStartUrl, ssoSession, pluginAvailable] = await Promise.all([
      this.readConfigValue(profileName, 'sso_start_url'),
      this.readConfigValue(profileName, 'sso_session'),
      commandExists('session-manager-plugin', ['--version'])
    ]);
    const isSsoProfile = Boolean(ssoStartUrl || ssoSession);

    const identity = await runCommand('aws', ['sts', 'get-caller-identity', '--profile', profileName, '--output', 'json']);
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
    await this.ensureAwsCliAvailable();
    const status = await this.getProfileStatus(profileName);
    if (!status.isSsoProfile) {
      throw new Error('이 프로필은 브라우저 로그인 대신 AWS CLI 자격 증명이 필요합니다.');
    }

    const result = await runCommand('aws', ['sso', 'login', '--profile', profileName], 5 * 60_000);
    if (result.exitCode !== 0) {
      throw normalizeAwsCliError(result.stderr, 'AWS SSO 로그인에 실패했습니다.');
    }
  }

  async listRegions(profileName: string): Promise<string[]> {
    await this.ensureAwsCliAvailable();
    const result = await runCommand('aws', [
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
    const result = await runCommand(
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
