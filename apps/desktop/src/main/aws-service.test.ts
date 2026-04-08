import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AwsProfileDetails } from '@shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AwsService, buildSshMetadataProbeCommands } from './aws-service';
import { resetDesktopStateStorageForTests } from './state-storage';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) =>
      name === 'userData'
        ? process.env.DOLSSH_USER_DATA_DIR ?? os.tmpdir()
        : os.tmpdir(),
    ),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => Buffer.from(value).toString('utf8')),
  },
}));

const tempDirectories: string[] = [];

async function createTempAwsProfileDir() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dolssh-aws-profiles-'));
  tempDirectories.push(rootDir);
  return rootDir;
}

beforeEach(async () => {
  const userDataDir = await createTempAwsProfileDir();
  process.env.DOLSSH_USER_DATA_DIR = userDataDir;
  resetDesktopStateStorageForTests();
});

async function writeAwsProfileFiles(
  rootDir: string,
  input: {
    config?: string;
    credentials?: string;
  },
) {
  await mkdir(rootDir, { recursive: true });
  await writeFile(path.join(rootDir, 'config'), input.config ?? '', 'utf8');
  await writeFile(
    path.join(rootDir, 'credentials'),
    input.credentials ?? '',
    'utf8',
  );
}

afterEach(async () => {
  resetDesktopStateStorageForTests();
  delete process.env.DOLSSH_USER_DATA_DIR;
  while (tempDirectories.length > 0) {
    const rootDir = tempDirectories.pop();
    if (!rootDir) {
      continue;
    }
    await rm(rootDir, { recursive: true, force: true });
  }
});

describe('AwsService.isManagedInstance', () => {
  it('returns true when the target instance is present in the managed instance list', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      ensureSessionManagerPluginAvailable: () => Promise<void>;
      runResolvedCommand: () => Promise<{ stdout: string; stderr: string; exitCode: number }>;
      isManagedInstance: (profileName: string, region: string, instanceId: string) => Promise<boolean>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.ensureSessionManagerPluginAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        InstanceInformationList: [{ InstanceId: 'i-123', PingStatus: 'Online' }]
      }),
      stderr: '',
      exitCode: 0
    });

    await expect(service.isManagedInstance('default', 'ap-northeast-2', 'i-123')).resolves.toBe(true);
  });

  it('returns false when the instance is not currently managed by SSM', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      ensureSessionManagerPluginAvailable: () => Promise<void>;
      runResolvedCommand: () => Promise<{ stdout: string; stderr: string; exitCode: number }>;
      isManagedInstance: (profileName: string, region: string, instanceId: string) => Promise<boolean>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.ensureSessionManagerPluginAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        InstanceInformationList: [{ InstanceId: 'i-123', PingStatus: 'Inactive' }]
      }),
      stderr: '',
      exitCode: 0
    });

    await expect(service.isManagedInstance('default', 'ap-northeast-2', 'i-123')).resolves.toBe(false);
  });
});

describe('AwsService.getProfileStatus', () => {
  it('includes the configured region when the profile is authenticated', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      readConfigValue: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      getProfileStatus: (profileName: string) => Promise<{
        configuredRegion?: string | null;
        isAuthenticated: boolean;
      }>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.readConfigValue = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('ap-northeast-2');
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
      stderr: '',
      exitCode: 0,
    });

    await expect(service.getProfileStatus('default')).resolves.toMatchObject({
      isAuthenticated: true,
      configuredRegion: 'ap-northeast-2',
    });
    expect(service.runResolvedCommandWithEnv).toHaveBeenCalledWith(
      'aws',
      ['sts', 'get-caller-identity', '--profile', 'default', '--output', 'json'],
      expect.any(Object),
      30_000,
    );
  });

  it('returns null configuredRegion when the profile has no default region', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      readConfigValue: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      getProfileStatus: (profileName: string) => Promise<{
        configuredRegion?: string | null;
        isAuthenticated: boolean;
      }>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.readConfigValue = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'credential missing',
      exitCode: 255,
    });

    await expect(service.getProfileStatus('default')).resolves.toMatchObject({
      isAuthenticated: false,
      configuredRegion: null,
    });
  });
});

describe('AwsService.buildManagedSessionEnvSpec', () => {
  it('returns the managed AWS session env patch and unset list', () => {
    const userDataDir = process.env.DOLSSH_USER_DATA_DIR;
    if (!userDataDir) {
      throw new Error('DOLSSH_USER_DATA_DIR is not configured for the test');
    }

    const service = new AwsService();
    const awsHomeDir = path.join(userDataDir, 'storage', 'aws');
    const awsRootDir = path.join(awsHomeDir, '.aws');

    expect(service.buildManagedSessionEnvSpec()).toEqual({
      env: {
        HOME: awsHomeDir,
        USERPROFILE: awsHomeDir,
        AWS_CONFIG_FILE: path.join(awsRootDir, 'config'),
        AWS_SHARED_CREDENTIALS_FILE: path.join(awsRootDir, 'credentials'),
      },
      unsetEnv: [
        'AWS_PROFILE',
        'AWS_DEFAULT_PROFILE',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
        'AWS_REGION',
        'AWS_DEFAULT_REGION',
      ],
    });
  });
});

describe('AwsService.createProfile', () => {
  it('validates credentials first and writes the new profile when they are valid', async () => {
    const rootDir = await createTempAwsProfileDir();
    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'static';
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
      stderr: '',
      exitCode: 0,
    });

    await service.createProfile({
      kind: 'static',
      profileName: 'dolssh-prod',
      accessKeyId: 'AKIATEST123',
      secretAccessKey: 'secret-value',
      region: 'ap-northeast-2',
    });

    expect(service.runResolvedCommandWithEnv).toHaveBeenCalledWith(
      'aws',
      ['sts', 'get-caller-identity', '--output', 'json'],
      expect.objectContaining({
        AWS_ACCESS_KEY_ID: 'AKIATEST123',
        AWS_SECRET_ACCESS_KEY: 'secret-value',
        AWS_REGION: 'ap-northeast-2',
        AWS_DEFAULT_REGION: 'ap-northeast-2',
      }),
      30_000,
    );
    const config = await readFile(path.join(rootDir, 'config'), 'utf8');
    const credentials = await readFile(path.join(rootDir, 'credentials'), 'utf8');
    expect(config).toContain('[profile dolssh-prod]');
    expect(config).toContain('region = ap-northeast-2');
    expect(credentials).toContain('[dolssh-prod]');
    expect(credentials).toContain('aws_access_key_id = AKIATEST123');
    expect(credentials).toContain('aws_secret_access_key = secret-value');
  });

  it('rejects duplicate profile names before validation or writes', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: ['[profile dolssh-prod]', 'region = ap-northeast-2', ''].join('\n'),
      credentials: ['[dolssh-prod]', 'aws_access_key_id = AKIAEXISTING', 'aws_secret_access_key = secret', ''].join('\n'),
    });
    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'static';
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommandWithEnv = vi.fn();

    await expect(
      service.createProfile({
        kind: 'static',
        profileName: 'dolssh-prod',
        accessKeyId: 'AKIATEST123',
        secretAccessKey: 'secret-value',
        region: null,
      }),
    ).rejects.toThrow('같은 이름의 AWS 프로필이 이미 존재합니다.');
    expect(service.runResolvedCommandWithEnv).not.toHaveBeenCalled();
  });

  it('does not write a region when it is omitted', async () => {
    const rootDir = await createTempAwsProfileDir();
    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'static';
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: '{}',
      stderr: '',
      exitCode: 0,
    });

    await service.createProfile({
      kind: 'static',
      profileName: 'dolssh-prod',
      accessKeyId: 'AKIATEST123',
      secretAccessKey: 'secret-value',
      region: null,
    });

    const config = await readFile(path.join(rootDir, 'config'), 'utf8');
    const credentials = await readFile(path.join(rootDir, 'credentials'), 'utf8');
    expect(config).not.toContain('region =');
    expect(config).not.toContain('[profile dolssh-prod]');
    expect(credentials).toContain('[dolssh-prod]');
  });

  it('fails validation without writing any profile values when credentials are invalid', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      listProfiles: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'static';
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.listProfiles = vi.fn().mockResolvedValue([]);
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'The security token included in the request is invalid.',
      exitCode: 255,
    });
    service.runResolvedCommand = vi.fn();

    await expect(
      service.createProfile({
        kind: 'static',
        profileName: 'dolssh-prod',
        accessKeyId: 'AKIATEST123',
        secretAccessKey: 'secret-value',
        region: null,
      }),
    ).rejects.toThrow(
      '입력한 Access Key 또는 Secret이 올바르지 않습니다. Access Key가 잘못되었거나 비활성화되었을 수 있습니다. AWS 자격 증명을 다시 확인해 주세요.',
    );
    expect(service.runResolvedCommand).not.toHaveBeenCalled();
  });

  it('keeps unmapped validation errors as raw stderr for debugging', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      listProfiles: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'static';
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.listProfiles = vi.fn().mockResolvedValue([]);
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'mystery validation failure',
      exitCode: 255,
    });
    service.runResolvedCommand = vi.fn();

    await expect(
      service.createProfile({
        kind: 'static',
        profileName: 'dolssh-prod',
        accessKeyId: 'AKIATEST123',
        secretAccessKey: 'secret-value',
        region: null,
      }),
    ).rejects.toThrow('mystery validation failure');
    expect(service.runResolvedCommand).not.toHaveBeenCalled();
  });

  it('translates AssumeRole access denied errors for role profiles', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: ['[default]', 'region = ap-northeast-2', ''].join('\n'),
      credentials: [
        '[default]',
        'aws_access_key_id = AKIADEFAULT1234',
        'aws_secret_access_key = default-secret',
        '',
      ].join('\n'),
    });
    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'role';
        profileName: string;
        sourceProfileName: string;
        roleArn: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: '',
      stderr:
        'An error occurred (AccessDenied) when calling the AssumeRole operation: User is not authorized to perform sts:AssumeRole',
      exitCode: 255,
    });
    service.runResolvedCommand = vi.fn();

    await expect(
      service.createProfile({
        kind: 'role',
        profileName: 'prod-admin',
        sourceProfileName: 'default',
        roleArn: 'arn:aws:iam::123456789012:role/Admin',
        region: null,
      }),
    ).rejects.toThrow(
      '선택한 source profile로 이 Role을 Assume할 수 없습니다. IAM 권한과 대상 role trust policy를 확인해 주세요.',
    );
    expect(service.runResolvedCommand).not.toHaveBeenCalled();
  });

  it('validates role profiles by assuming the role with the selected source profile', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: ['[default]', 'region = ap-northeast-2', ''].join('\n'),
      credentials: [
        '[default]',
        'aws_access_key_id = AKIADEFAULT1234',
        'aws_secret_access_key = default-secret',
        '',
      ].join('\n'),
    });

    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'role';
        profileName: string;
        sourceProfileName: string;
        roleArn: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        Credentials: {
          AccessKeyId: 'ASIA....',
        },
      }),
      stderr: '',
      exitCode: 0,
    });

    await service.createProfile({
      kind: 'role',
      profileName: 'prod-admin',
      sourceProfileName: 'default',
      roleArn: 'arn:aws:iam::123456789012:role/Admin',
      region: 'ap-northeast-2',
    });

    expect(service.runResolvedCommandWithEnv).toHaveBeenCalledWith(
      'aws',
      [
        'sts',
        'assume-role',
        '--profile',
        'default',
        '--role-arn',
        'arn:aws:iam::123456789012:role/Admin',
        '--role-session-name',
        expect.stringMatching(/^dolssh-validate-\d+$/),
        '--output',
        'json',
      ],
      expect.objectContaining({
        AWS_CONFIG_FILE: path.join(rootDir, 'config'),
        AWS_SHARED_CREDENTIALS_FILE: path.join(rootDir, 'credentials'),
      }),
      30_000,
    );

    const config = await readFile(path.join(rootDir, 'config'), 'utf8');
    expect(config).toContain('[profile prod-admin]');
    expect(config).toContain('role_arn = arn:aws:iam::123456789012:role/Admin');
    expect(config).toContain('source_profile = default');
    expect(config).toContain('region = ap-northeast-2');
  });

  it('translates invalid or expired SSO sessions during role validation', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: [
        '[default]',
        'sso_session = gridwiz',
        'sso_account_id = 123456789012',
        'sso_role_name = developer',
        '',
        '[sso-session gridwiz]',
        'sso_start_url = https://example.awsapps.com/start',
        'sso_region = ap-northeast-2',
        '',
      ].join('\n'),
      credentials: '',
    });
    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'role';
        profileName: string;
        sourceProfileName: string;
        roleArn: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'Error when retrieving token from sso: Token has expired and refresh failed',
      exitCode: 255,
    });

    await expect(
      service.createProfile({
        kind: 'role',
        profileName: 'prod-admin',
        sourceProfileName: 'default',
        roleArn: 'arn:aws:iam::123456789012:role/Admin',
        region: null,
      }),
    ).rejects.toThrow(
      '선택한 source profile의 AWS SSO 로그인 세션이 유효하지 않습니다. 먼저 해당 source profile로 다시 로그인해 주세요.',
    );
  });

  it('translates RoleArn parameter validation errors during role validation', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: ['[default]', 'region = ap-northeast-2', ''].join('\n'),
      credentials: [
        '[default]',
        'aws_access_key_id = AKIADEFAULT1234',
        'aws_secret_access_key = default-secret',
        '',
      ].join('\n'),
    });
    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'role';
        profileName: string;
        sourceProfileName: string;
        roleArn: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: '',
      stderr:
        'Parameter validation failed: Invalid length for parameter RoleArn, value: 18, valid min length: 20',
      exitCode: 255,
    });

    await expect(
      service.createProfile({
        kind: 'role',
        profileName: 'prod-admin',
        sourceProfileName: 'default',
        roleArn: 'arn:aws:iam::short',
        region: null,
      }),
    ).rejects.toThrow(
      '입력한 Role ARN이 올바르지 않거나 대상 Role을 찾을 수 없습니다. Role ARN 형식과 대상 Role을 다시 확인해 주세요.',
    );
  });

  it('translates final SSO role validation failures', async () => {
    const rootDir = await createTempAwsProfileDir();
    const homeDir = await createTempAwsProfileDir();
    const awsRootDir = path.join(homeDir, '.aws');
    await writeAwsProfileFiles(awsRootDir, {});

    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      listProfiles: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      pendingSsoPreparations: Map<string, unknown>;
      createProfile: (input: {
        kind: 'sso';
        profileName: string;
        ssoStartUrl: string;
        ssoRegion: string;
        region?: string | null;
        preparationToken: string;
        ssoSessionName: string;
        ssoAccountId: string;
        ssoRoleName: string;
      }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.listProfiles = vi.fn().mockResolvedValue([]);
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: '',
      stderr:
        'The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.',
      exitCode: 255,
    });
    service.runResolvedCommand = vi.fn();
    service.pendingSsoPreparations.set('prep-token', {
      preparationToken: 'prep-token',
      profileName: 'corp-sso',
      ssoSessionName: 'corp-sso',
      ssoStartUrl: 'https://example.awsapps.com/start',
      ssoRegion: 'ap-northeast-2',
      region: 'ap-northeast-2',
      awsRootDir,
      homeDir,
      expiresAt: Date.now() + 60_000,
      accounts: [],
      rolesByAccountId: {},
    });

    await expect(
      service.createProfile({
        kind: 'sso',
        profileName: 'corp-sso',
        ssoStartUrl: 'https://example.awsapps.com/start',
        ssoRegion: 'ap-northeast-2',
        region: 'ap-northeast-2',
        preparationToken: 'prep-token',
        ssoSessionName: 'corp-sso',
        ssoAccountId: '123456789012',
        ssoRoleName: 'AdministratorAccess',
      }),
    ).rejects.toThrow(
      '선택한 account/role로 인증을 완료하지 못했습니다. 다시 로그인하거나 다른 role을 선택해 주세요.',
    );
  });

  it('surfaces the aws cli availability error before any work starts', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      listProfiles: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'static';
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi
      .fn()
      .mockRejectedValue(
        new Error('AWS CLI가 설치되어 있지 않습니다. `aws --version`이 동작해야 합니다.'),
      );
    service.listProfiles = vi.fn();
    service.runResolvedCommandWithEnv = vi.fn();
    service.runResolvedCommand = vi.fn();

    await expect(
      service.createProfile({
        kind: 'static',
        profileName: 'dolssh-prod',
        accessKeyId: 'AKIATEST123',
        secretAccessKey: 'secret-value',
        region: null,
      }),
    ).rejects.toThrow('AWS CLI가 설치되어 있지 않습니다. `aws --version`이 동작해야 합니다.');
    expect(service.listProfiles).not.toHaveBeenCalled();
    expect(service.runResolvedCommandWithEnv).not.toHaveBeenCalled();
    expect(service.runResolvedCommand).not.toHaveBeenCalled();
  });
});

describe('AwsService AWS profile management', () => {
  it('copies the local sso cache into temp aws roots for profile validation', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: [
        '[default]',
        'sso_session = corp-session',
        '',
        '[sso-session corp-session]',
        'sso_start_url = https://example.awsapps.com/start',
        'sso_region = ap-northeast-2',
        '',
      ].join('\n'),
      credentials: '',
    });
    await mkdir(path.join(rootDir, 'sso', 'cache'), { recursive: true });
    await writeFile(
      path.join(rootDir, 'sso', 'cache', 'token.json'),
      JSON.stringify({ accessToken: 'cached-token' }),
      'utf8',
    );

    const service = new AwsService(rootDir) as unknown as {
      createTempAwsRoot: () => Promise<{ homeDir: string; awsRootDir: string }>;
      destroyTempAwsRoot: (homeDir: string) => Promise<void>;
    };

    const tempRoot = await service.createTempAwsRoot();
    tempDirectories.push(tempRoot.homeDir);

    const copiedToken = await readFile(
      path.join(tempRoot.awsRootDir, 'sso', 'cache', 'token.json'),
      'utf8',
    );

    expect(JSON.parse(copiedToken)).toMatchObject({
      accessToken: 'cached-token',
    });

    await service.destroyTempAwsRoot(tempRoot.homeDir);
  });

  it('classifies profile details by config shape and never exposes raw secrets', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: [
        '[profile static-profile]',
        'region = ap-northeast-2',
        '',
        '[profile sso-profile]',
        'sso_session = corp-session',
        'sso_account_id = 123456789012',
        'sso_role_name = AdministratorAccess',
        '',
        '[profile role-profile]',
        'role_arn = arn:aws:iam::123456789012:role/Admin',
        'source_profile = static-profile',
        '',
        '[profile process-profile]',
        'credential_process = node scripts/aws-creds.js',
        '',
        '[profile unknown-profile]',
        'region = us-east-1',
        '',
        '[sso-session corp-session]',
        'sso_start_url = https://example.awsapps.com/start',
        'sso_region = ap-northeast-2',
      ].join('\n'),
      credentials: [
        '[static-profile]',
        'aws_access_key_id = AKIATEST12345678',
        'aws_secret_access_key = secret-value',
      ].join('\n'),
    });

    const service = new AwsService(rootDir) as unknown as {
      getProfileStatusFromRoot: ReturnType<typeof vi.fn>;
      getProfileDetails: (profileName: string) => Promise<AwsProfileDetails>;
    };

    service.getProfileStatusFromRoot = vi.fn().mockImplementation(async (profileName: string) => ({
      profileName,
      available: true,
      isSsoProfile: profileName === 'sso-profile',
      isAuthenticated: profileName !== 'unknown-profile',
      configuredRegion:
        profileName === 'static-profile'
          ? 'ap-northeast-2'
          : profileName === 'unknown-profile'
            ? 'us-east-1'
            : null,
      accountId: null,
      arn: null,
      errorMessage: null,
      missingTools: [],
    }));

    await expect(service.getProfileDetails('static-profile')).resolves.toMatchObject({
      kind: 'static',
      maskedAccessKeyId: 'AKIA********5678',
      hasSecretAccessKey: true,
      hasSessionToken: false,
    });
    await expect(service.getProfileDetails('sso-profile')).resolves.toMatchObject({
      kind: 'sso',
      ssoSession: expect.stringMatching(/^dolssh-[0-9a-f]{12}$/),
      ssoStartUrl: 'https://example.awsapps.com/start',
      ssoRegion: 'ap-northeast-2',
      ssoAccountId: '123456789012',
      ssoRoleName: 'AdministratorAccess',
      orphanedSsoSessionName: expect.stringMatching(/^dolssh-[0-9a-f]{12}$/),
    });
    await expect(service.getProfileDetails('role-profile')).resolves.toMatchObject({
      kind: 'role',
      roleArn: 'arn:aws:iam::123456789012:role/Admin',
      sourceProfile: 'static-profile',
    });
    await expect(service.getProfileDetails('process-profile')).resolves.toMatchObject({
      kind: 'unknown',
      credentialProcess: null,
    });
    await expect(service.getProfileDetails('unknown-profile')).resolves.toMatchObject({
      kind: 'unknown',
    });
  });

  it('uses a shorter timeout when loading profile details', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: ['[profile static-profile]', 'region = ap-northeast-2', ''].join('\n'),
      credentials: [
        '[static-profile]',
        'aws_access_key_id = AKIATEST12345678',
        'aws_secret_access_key = secret-value',
        '',
      ].join('\n'),
    });

    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      readConfigValue: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      getProfileDetails: (profileName: string) => Promise<AwsProfileDetails>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.readConfigValue = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('ap-northeast-2');
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
      stderr: '',
      exitCode: 0,
    });

    await expect(service.getProfileDetails('static-profile')).resolves.toMatchObject({
      profileName: 'static-profile',
      kind: 'static',
    });
    expect(service.runResolvedCommandWithEnv).toHaveBeenCalledWith(
      'aws',
      ['sts', 'get-caller-identity', '--profile', 'static-profile', '--output', 'json'],
      expect.any(Object),
      8_000,
    );
  });

  it('imports external profiles into the managed store and carries role and sso dependencies with them', async () => {
    const managedRootDir = await createTempAwsProfileDir();
    const externalRootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(externalRootDir, {
      config: [
        '[profile base-static]',
        'region = ap-northeast-2',
        '',
        '[profile admin-role]',
        'role_arn = arn:aws:iam::123456789012:role/Admin',
        'source_profile = base-static',
        '',
        '[profile corp-sso]',
        'sso_session = corp-session',
        'sso_account_id = 123456789012',
        'sso_role_name = AdministratorAccess',
        'region = ap-northeast-2',
        '',
        '[sso-session corp-session]',
        'sso_start_url = https://example.awsapps.com/start',
        'sso_region = ap-northeast-2',
        'sso_registration_scopes = sso:account:access',
        '',
      ].join('\n'),
      credentials: [
        '[base-static]',
        'aws_access_key_id = AKIATEST12345678',
        'aws_secret_access_key = secret-value',
        '',
      ].join('\n'),
    });
    await mkdir(path.join(externalRootDir, 'sso', 'cache'), { recursive: true });
    await writeFile(
      path.join(externalRootDir, 'sso', 'cache', 'token.json'),
      JSON.stringify({ accessToken: 'external-only-token' }),
      'utf8',
    );

    const service = new AwsService(managedRootDir, externalRootDir);

    await expect(
      service.importExternalProfiles({
        profileNames: ['admin-role', 'corp-sso'],
      }),
    ).resolves.toEqual({
      importedProfileNames: ['admin-role', 'base-static', 'corp-sso'],
      skippedProfileNames: [],
    });

    const managedConfig = await readFile(path.join(managedRootDir, 'config'), 'utf8');
    const managedCredentials = await readFile(
      path.join(managedRootDir, 'credentials'),
      'utf8',
    );

    expect(managedConfig).toContain('[profile base-static]');
    expect(managedConfig).toContain('[profile admin-role]');
    expect(managedConfig).toContain('source_profile = base-static');
    expect(managedConfig).toContain('[profile corp-sso]');
    expect(managedConfig).toMatch(/sso_session = dolssh-[0-9a-f]{12}/);
    expect(managedConfig).toMatch(/\[sso-session dolssh-[0-9a-f]{12}\]/);
    expect(managedCredentials).toContain('[base-static]');
    await expect(
      readFile(path.join(managedRootDir, 'sso', 'cache', 'token.json'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('skips importing external profiles when the managed store already has the same profile name', async () => {
    const managedRootDir = await createTempAwsProfileDir();
    const externalRootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(managedRootDir, {
      config: ['[profile shared-profile]', 'region = us-east-1', ''].join('\n'),
      credentials: [
        '[shared-profile]',
        'aws_access_key_id = AKIAMANAGED1234',
        'aws_secret_access_key = managed-secret',
        '',
      ].join('\n'),
    });
    await writeAwsProfileFiles(externalRootDir, {
      config: ['[profile shared-profile]', 'region = ap-northeast-2', ''].join('\n'),
      credentials: [
        '[shared-profile]',
        'aws_access_key_id = AKIAEXTERNAL1234',
        'aws_secret_access_key = external-secret',
        '',
      ].join('\n'),
    });

    const service = new AwsService(managedRootDir, externalRootDir);

    await expect(
      service.importExternalProfiles({
        profileNames: ['shared-profile'],
      }),
    ).resolves.toEqual({
      importedProfileNames: [],
      skippedProfileNames: ['shared-profile'],
    });

    const managedConfig = await readFile(path.join(managedRootDir, 'config'), 'utf8');
    const managedCredentials = await readFile(
      path.join(managedRootDir, 'credentials'),
      'utf8',
    );

    expect(managedConfig).toContain('region = us-east-1');
    expect(managedConfig).not.toContain('region = ap-northeast-2');
    expect(managedCredentials).toContain('AKIAMANAGED1234');
    expect(managedCredentials).not.toContain('AKIAEXTERNAL1234');
  });

  it('removes region from the config file when updating a static profile without a region', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: ['[profile static-profile]', 'region = ap-northeast-2', ''].join('\n'),
      credentials: [
        '[static-profile]',
        'aws_access_key_id = AKIAOLDVALUE',
        'aws_secret_access_key = old-secret',
        '',
      ].join('\n'),
    });

    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      updateProfile: (input: {
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: '{}',
      stderr: '',
      exitCode: 0,
    });

    await service.updateProfile({
      profileName: 'static-profile',
      accessKeyId: 'AKIANEWVALUE',
      secretAccessKey: 'new-secret',
      region: null,
    });

    const config = await readFile(path.join(rootDir, 'config'), 'utf8');
    const credentials = await readFile(path.join(rootDir, 'credentials'), 'utf8');
    expect(config.trim()).toBe('');
    expect(config).not.toContain('region = ap-northeast-2');
    expect(credentials).toContain('aws_access_key_id = AKIANEWVALUE');
    expect(credentials).toContain('aws_secret_access_key = new-secret');
    expect(service.runResolvedCommandWithEnv).toHaveBeenCalled();
  });

  it('translates SignatureDoesNotMatch during static profile updates', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: ['[profile static-profile]', 'region = ap-northeast-2', ''].join('\n'),
      credentials: [
        '[static-profile]',
        'aws_access_key_id = AKIAOLDVALUE',
        'aws_secret_access_key = old-secret',
        '',
      ].join('\n'),
    });
    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      updateProfile: (input: {
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: '',
      stderr:
        'An error occurred (SignatureDoesNotMatch) when calling the GetCallerIdentity operation: The request signature we calculated does not match the signature you provided.',
      exitCode: 255,
    });
    service.runResolvedCommand = vi.fn();

    await expect(
      service.updateProfile({
        profileName: 'static-profile',
        accessKeyId: 'AKIANEWVALUE',
        secretAccessKey: 'wrong-secret',
        region: null,
      }),
    ).rejects.toThrow(
      '입력한 Access Key 또는 Secret이 올바르지 않습니다. Secret이 다르거나 잘못된 키 조합일 수 있습니다. AWS 자격 증명을 다시 확인해 주세요.',
    );
    expect(service.runResolvedCommand).not.toHaveBeenCalled();
  });

  it('translates SSO login preparation failures', async () => {
    const rootDir = await createTempAwsProfileDir();
    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      listProfiles: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      prepareSsoProfile: (input: {
        profileName: string;
        ssoStartUrl: string;
        ssoRegion: string;
        region?: string | null;
      }) => Promise<unknown>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.listProfiles = vi.fn().mockResolvedValue([]);
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: '',
      stderr:
        'The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.',
      exitCode: 255,
    });

    await expect(
      service.prepareSsoProfile({
        profileName: 'corp-sso',
        ssoStartUrl: 'https://example.awsapps.com/start',
        ssoRegion: 'ap-northeast-2',
        region: null,
      }),
    ).rejects.toThrow(
      'AWS SSO 로그인에 실패했습니다. SSO Start URL, SSO Region, 브라우저 로그인 상태를 확인해 주세요.',
    );
  });

  it('translates SSO account loading failures after login', async () => {
    const rootDir = await createTempAwsProfileDir();
    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      listProfiles: ReturnType<typeof vi.fn>;
      runResolvedCommandWithEnv: ReturnType<typeof vi.fn>;
      readSsoAccessToken: ReturnType<typeof vi.fn>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      prepareSsoProfile: (input: {
        profileName: string;
        ssoStartUrl: string;
        ssoRegion: string;
        region?: string | null;
      }) => Promise<unknown>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.listProfiles = vi.fn().mockResolvedValue([]);
    service.runResolvedCommandWithEnv = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
    service.readSsoAccessToken = vi.fn().mockResolvedValue('token-value');
    service.runResolvedCommand = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'AccessDeniedException: token expired',
      exitCode: 255,
    });

    await expect(
      service.prepareSsoProfile({
        profileName: 'corp-sso',
        ssoStartUrl: 'https://example.awsapps.com/start',
        ssoRegion: 'ap-northeast-2',
        region: null,
      }),
    ).rejects.toThrow(
      'SSO 로그인 후 account 또는 role 목록을 불러오지 못했습니다. 권한과 SSO 설정을 확인해 주세요.',
    );
  });

  it('renames the default profile sections and rewrites source_profile references', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: [
        '[default]',
        'region = ap-northeast-2',
        '',
        '[profile assume-admin]',
        'role_arn = arn:aws:iam::123456789012:role/Admin',
        'source_profile = default',
        '',
      ].join('\n'),
      credentials: [
        '[default]',
        'aws_access_key_id = AKIADEFAULT1234',
        'aws_secret_access_key = secret-value',
        '',
      ].join('\n'),
    });

    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      listProfiles: ReturnType<typeof vi.fn>;
      renameProfile: (input: { profileName: string; nextProfileName: string }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.listProfiles = vi.fn().mockResolvedValue([
      { name: 'default' },
      { name: 'assume-admin' },
    ]);

    await service.renameProfile({
      profileName: 'default',
      nextProfileName: 'shared-prod',
    });

    const config = await readFile(path.join(rootDir, 'config'), 'utf8');
    const credentials = await readFile(path.join(rootDir, 'credentials'), 'utf8');

    expect(config).toContain('[profile shared-prod]');
    expect(config).toContain('source_profile = shared-prod');
    expect(config).not.toContain('[default]');
    expect(credentials).toContain('[shared-prod]');
    expect(credentials).not.toContain('[default]');
  });

  it('keeps a shared sso-session when another local profile still references it', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: [
        '[profile primary-sso]',
        'sso_session = corp-session',
        'sso_account_id = 123456789012',
        'sso_role_name = AdministratorAccess',
        '',
        '[profile backup-sso]',
        'sso_session = corp-session',
        'sso_account_id = 123456789012',
        'sso_role_name = AdministratorAccess',
        '',
        '[sso-session corp-session]',
        'sso_start_url = https://example.awsapps.com/start',
        'sso_region = ap-northeast-2',
        '',
      ].join('\n'),
      credentials: '',
    });

    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      listProfiles: ReturnType<typeof vi.fn>;
      deleteProfile: (profileName: string) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.listProfiles = vi.fn().mockResolvedValue([
      { name: 'primary-sso' },
      { name: 'backup-sso' },
    ]);

    await service.deleteProfile('primary-sso');

    const config = await readFile(path.join(rootDir, 'config'), 'utf8');
    expect(config).not.toContain('[profile primary-sso]');
    expect(config).toContain('[profile backup-sso]');
    expect(config).toMatch(/\[sso-session dolssh-[0-9a-f]{12}\]/);
  });

  it('deletes the default profile and removes an orphaned sso-session section', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: [
        '[default]',
        'sso_session = corp-session',
        'sso_account_id = 123456789012',
        'sso_role_name = AdministratorAccess',
        '',
        '[sso-session corp-session]',
        'sso_start_url = https://example.awsapps.com/start',
        'sso_region = ap-northeast-2',
        '',
      ].join('\n'),
      credentials: '',
    });

    const service = new AwsService(rootDir) as unknown as {
      ensureAwsCliAvailable: ReturnType<typeof vi.fn>;
      listProfiles: ReturnType<typeof vi.fn>;
      deleteProfile: (profileName: string) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.listProfiles = vi.fn().mockResolvedValue([{ name: 'default' }]);

    await service.deleteProfile('default');

    const config = await readFile(path.join(rootDir, 'config'), 'utf8');
    expect(config).not.toContain('[default]');
    expect(config).not.toContain('[sso-session corp-session]');
  });
});

describe('AwsService EC2 helpers', () => {
  it('includes availability zone when listing EC2 instances', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      runResolvedCommand: () => Promise<{ stdout: string; stderr: string; exitCode: number }>;
      listEc2Instances: (profileName: string, region: string) => Promise<Array<Record<string, unknown>>>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-123',
                PrivateIpAddress: '10.0.0.10',
                PlatformDetails: 'Linux/UNIX',
                Placement: { AvailabilityZone: 'ap-northeast-2a' },
                State: { Name: 'running' },
                Tags: [{ Key: 'Name', Value: 'web-1' }]
              }
            ]
          }
        ]
      }),
      stderr: '',
      exitCode: 0
    });

    await expect(service.listEc2Instances('default', 'ap-northeast-2')).resolves.toEqual([
      {
        instanceId: 'i-123',
        name: 'web-1',
        availabilityZone: 'ap-northeast-2a',
        platform: 'Linux/UNIX',
        privateIp: '10.0.0.10',
        state: 'running'
      }
    ]);
  });

  it('describes a single EC2 instance and returns null when no instance is present', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      describeEc2Instance: (profileName: string, region: string, instanceId: string) => Promise<Record<string, unknown> | null>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-abc',
                  PrivateIpAddress: '10.0.0.99',
                  PlatformDetails: 'Linux/UNIX',
                  Placement: { AvailabilityZone: 'ap-northeast-2c' },
                  State: { Name: 'running' },
                  Tags: [{ Key: 'Name', Value: 'api-1' }]
                }
              ]
            }
          ]
        }),
        stderr: '',
        exitCode: 0
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ Reservations: [] }),
        stderr: '',
        exitCode: 0
      });

    await expect(service.describeEc2Instance('default', 'ap-northeast-2', 'i-abc')).resolves.toEqual({
      instanceId: 'i-abc',
      name: 'api-1',
      availabilityZone: 'ap-northeast-2c',
      platform: 'Linux/UNIX',
      privateIp: '10.0.0.99',
      state: 'running'
    });
    await expect(service.describeEc2Instance('default', 'ap-northeast-2', 'i-missing')).resolves.toBeNull();
  });

  it('sends the SSH public key with the expected EIC parameters', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      sendSshPublicKey: (input: {
        profileName: string;
        region: string;
        instanceId: string;
        availabilityZone: string;
        osUser: string;
        publicKey: string;
      }) => Promise<void>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ Success: true }),
      stderr: '',
      exitCode: 0
    });

    await service.sendSshPublicKey({
      profileName: 'default',
      region: 'ap-northeast-2',
      instanceId: 'i-abc',
      availabilityZone: 'ap-northeast-2a',
      osUser: 'ubuntu',
      publicKey: 'ssh-ed25519 AAAATEST'
    });

    expect(service.runResolvedCommand).toHaveBeenCalledWith(
      'aws',
      [
        'ec2-instance-connect',
        'send-ssh-public-key',
        '--profile',
        'default',
        '--region',
        'ap-northeast-2',
        '--instance-id',
        'i-abc',
        '--availability-zone',
        'ap-northeast-2a',
        '--instance-os-user',
        'ubuntu',
        '--ssh-public-key',
        'ssh-ed25519 AAAATEST',
        '--output',
        'json'
      ],
      30_000
    );
  });

  it('loads SSH metadata over SSM and recommends a username', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      ensureSessionManagerPluginAvailable: () => Promise<void>;
      sendRunCommand: ReturnType<typeof vi.fn>;
      getCommandInvocation: ReturnType<typeof vi.fn>;
      loadHostSshMetadata: (input: {
        profileName: string;
        region: string;
        instanceId: string;
      }) => Promise<{
        sshPort: number;
        recommendedUsername: string | null;
        usernameCandidates: string[];
      }>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.ensureSessionManagerPluginAvailable = vi.fn().mockResolvedValue(undefined);
    service.sendRunCommand = vi.fn().mockResolvedValue('cmd-123');
    service.getCommandInvocation = vi.fn().mockResolvedValue({
      Status: 'Success',
      ResponseCode: 0,
      StandardOutputContent: [
        'OS_ID=ubuntu',
        'CLOUD_USER=ubuntu',
        'SSH_PORT=2222',
        'PASSWD_USERS=ubuntu,deploy,ssm-user',
        'HOME_USERS=deploy,ubuntu'
      ].join('\n'),
      StandardErrorContent: ''
    });

    await expect(
      service.loadHostSshMetadata({
        profileName: 'default',
        region: 'ap-northeast-2',
        instanceId: 'i-abc'
      })
    ).resolves.toEqual({
      sshPort: 2222,
      recommendedUsername: 'ubuntu',
      usernameCandidates: ['deploy', 'ubuntu']
    });
  });

  it('builds SSM probe commands as a command array instead of a single blob script', () => {
    const commands = buildSshMetadataProbeCommands();

    expect(Array.isArray(commands)).toBe(true);
    expect(commands.length).toBeGreaterThan(5);
    expect(commands.join('\n')).toContain('SSH_PORT=');
    expect(commands.some((command) => command.includes('\n'))).toBe(false);
  });

  it('returns a structured inspection error result with a default SSH port recommendation', async () => {
    const service = new AwsService() as unknown as {
      loadHostSshMetadata: ReturnType<typeof vi.fn>;
      inspectHostSshMetadata: (input: {
        profileName: string;
        region: string;
        instanceId: string;
      }) => Promise<{
        sshPort: number | null;
        recommendedUsername: string | null;
        usernameCandidates: string[];
        status: 'ready' | 'error';
        errorMessage: string | null;
      }>;
    };

    service.loadHostSshMetadata = vi
      .fn()
      .mockRejectedValue(new Error('[SSM 명령 전송] SSM 명령을 전송하지 못했습니다.'));

    await expect(
      service.inspectHostSshMetadata({
        profileName: 'default',
        region: 'ap-northeast-2',
        instanceId: 'i-abc',
      }),
    ).resolves.toEqual({
      sshPort: 22,
      recommendedUsername: null,
      usernameCandidates: [],
      status: 'error',
      errorMessage: '[SSM 명령 전송] SSM 명령을 전송하지 못했습니다.',
    });
  });
});

describe('AwsService ECS helpers', () => {
  it('lists ECS clusters with summary counts', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      listEcsClusters: (profileName: string, region: string) => Promise<Array<Record<string, unknown>>>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          clusterArns: ['arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod'],
        }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          clusters: [
            {
              clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
              clusterName: 'prod',
              status: 'ACTIVE',
              activeServicesCount: 4,
              runningTasksCount: 6,
              pendingTasksCount: 1,
            },
          ],
        }),
        stderr: '',
        exitCode: 0,
      });

    await expect(service.listEcsClusters('default', 'ap-northeast-2')).resolves.toEqual([
      {
        clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
        clusterName: 'prod',
        status: 'ACTIVE',
        activeServicesCount: 4,
        runningTasksCount: 6,
        pendingTasksCount: 1,
      },
    ]);
  });

  it('loads an ECS cluster metadata snapshot without CloudWatch utilization data', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      describeEcsClusterSnapshot: (
        profileName: string,
        region: string,
        clusterArn: string,
      ) => Promise<Record<string, unknown>>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          clusters: [
            {
              clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
              clusterName: 'prod',
              status: 'ACTIVE',
              activeServicesCount: 2,
              runningTasksCount: 3,
              pendingTasksCount: 1,
            },
          ],
        }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          serviceArns: ['arn:aws:ecs:ap-northeast-2:123456789012:service/prod/api'],
        }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          services: [
            {
              serviceArn: 'arn:aws:ecs:ap-northeast-2:123456789012:service/prod/api',
              serviceName: 'api',
              status: 'ACTIVE',
              desiredCount: 2,
              runningCount: 2,
              pendingCount: 0,
              launchType: 'FARGATE',
              loadBalancers: [{ targetGroupArn: 'arn:aws:elasticloadbalancing:ap-northeast-2:123456789012:targetgroup/api/abc' }],
              serviceConnectConfiguration: { enabled: true },
              taskDefinition: 'api:7',
              deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }],
              events: [{ message: 'steady state' }],
            },
          ],
        }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          taskDefinition: {
            revision: 7,
            cpu: '512',
            memory: '1024',
            containerDefinitions: [
              {
                portMappings: [
                  { containerPort: 9090, protocol: 'tcp' },
                  { containerPort: 8080, protocol: 'tcp' },
                  { containerPort: 8080, protocol: 'tcp' },
                ],
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

    await expect(
      service.describeEcsClusterSnapshot(
        'default',
        'ap-northeast-2',
        'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
      ),
    ).resolves.toMatchObject({
      profileName: 'default',
      region: 'ap-northeast-2',
      cluster: {
        clusterName: 'prod',
        status: 'ACTIVE',
      },
      services: [
        {
          serviceName: 'api',
          status: 'ACTIVE',
          rolloutState: 'COMPLETED',
          desiredCount: 2,
          runningCount: 2,
          pendingCount: 0,
          launchType: 'FARGATE',
          servicePorts: [
            { port: 8080, protocol: 'tcp' },
            { port: 9090, protocol: 'tcp' },
          ],
          exposureKinds: ['alb', 'service-connect'],
          cpuUtilizationPercent: null,
          memoryUtilizationPercent: null,
          configuredCpu: '512',
          configuredMemory: '1024',
          taskDefinitionRevision: 7,
          latestEventMessage: 'steady state',
        },
      ],
      metricsWarning: null,
    });
  });

  it('loads ECS cluster utilization separately from cluster metadata', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      describeEcsClusterUtilization: (
        profileName: string,
        region: string,
        clusterArn: string,
      ) => Promise<Record<string, unknown>>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          serviceArns: ['arn:aws:ecs:ap-northeast-2:123456789012:service/prod/api'],
        }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          MetricDataResults: [
            {
              Id: 'cpu0',
              Timestamps: [
                '2026-03-29T00:05:00.000Z',
                '2026-03-29T00:04:00.000Z',
              ],
              Values: [23.4, 19.8],
            },
            {
              Id: 'mem0',
              Timestamps: [
                '2026-03-29T00:05:00.000Z',
                '2026-03-29T00:04:00.000Z',
              ],
              Values: [61.2, 58.4],
            },
          ],
        }),
        stderr: '',
        exitCode: 0,
      });

    await expect(
      service.describeEcsClusterUtilization(
        'default',
        'ap-northeast-2',
        'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
      ),
    ).resolves.toMatchObject({
      warning: null,
      services: [
        {
          serviceName: 'api',
          cpuUtilizationPercent: 23.4,
          memoryUtilizationPercent: 61.2,
          cpuHistory: [
            {
              timestamp: '2026-03-29T00:04:00.000Z',
              value: 19.8,
            },
            {
              timestamp: '2026-03-29T00:05:00.000Z',
              value: 23.4,
            },
          ],
          memoryHistory: [
            {
              timestamp: '2026-03-29T00:04:00.000Z',
              value: 58.4,
            },
            {
              timestamp: '2026-03-29T00:05:00.000Z',
              value: 61.2,
            },
          ],
        },
      ],
    });
  });

  it('keeps the ECS utilization snapshot available when CloudWatch utilization lookup fails', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      describeEcsClusterUtilization: (
        profileName: string,
        region: string,
        clusterArn: string,
      ) => Promise<Record<string, unknown>>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          serviceArns: ['arn:aws:ecs:ap-northeast-2:123456789012:service/prod/api'],
        }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: 'AccessDenied',
        exitCode: 255,
      });

    await expect(
      service.describeEcsClusterUtilization(
        'default',
        'ap-northeast-2',
        'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
      ),
    ).resolves.toMatchObject({
      services: [
        {
          serviceName: 'api',
          cpuUtilizationPercent: null,
          memoryUtilizationPercent: null,
          cpuHistory: [],
          memoryHistory: [],
        },
      ],
      warning:
        '현재 사용량 지표를 읽지 못해 일부 서비스는 사용률이 표시되지 않을 수 있습니다.',
    });
  });

  it('lists ECS task tunnel services with basic runtime counts', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      listEcsTaskTunnelServices: (
        profileName: string,
        region: string,
        clusterArn: string,
      ) => Promise<Array<Record<string, unknown>>>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          serviceArns: ['arn:aws:ecs:ap-northeast-2:123456789012:service/prod/api'],
        }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          services: [
            {
              serviceName: 'api',
              status: 'ACTIVE',
              desiredCount: 2,
              runningCount: 2,
              pendingCount: 0,
            },
          ],
        }),
        stderr: '',
        exitCode: 0,
      });

    await expect(
      service.listEcsTaskTunnelServices(
        'default',
        'ap-northeast-2',
        'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
      ),
    ).resolves.toEqual([
      {
        serviceName: 'api',
        status: 'ACTIVE',
        desiredCount: 2,
        runningCount: 2,
        pendingCount: 0,
      },
    ]);
  });

  it('loads ECS task tunnel container ports from task definition metadata', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      describeEcsTaskTunnelService: (
        profileName: string,
        region: string,
        clusterArn: string,
        serviceName: string,
      ) => Promise<Record<string, unknown>>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          services: [
            {
              serviceName: 'api',
              taskDefinition: 'arn:aws:ecs:ap-northeast-2:123456789012:task-definition/api:42',
            },
          ],
        }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          taskDefinition: {
            containerDefinitions: [
              {
                name: 'web',
                portMappings: [
                  { containerPort: 8080, protocol: 'tcp' },
                  { containerPort: 8080, protocol: 'tcp' },
                ],
              },
              {
                name: 'metrics',
                portMappings: [{ containerPort: 9090, protocol: 'tcp' }],
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

    await expect(
      service.describeEcsTaskTunnelService(
        'default',
        'ap-northeast-2',
        'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
        'api',
      ),
    ).resolves.toEqual({
      serviceName: 'api',
      containers: [
        {
          containerName: 'metrics',
          ports: [{ port: 9090, protocol: 'tcp' }],
        },
        {
          containerName: 'web',
          ports: [{ port: 8080, protocol: 'tcp' }],
        },
      ],
    });
  });

  it('resolves an ECS task tunnel target string from the first running task', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      resolveEcsTaskTunnelTarget: (input: {
        profileName: string;
        region: string;
        clusterArn: string;
        serviceName: string;
        containerName: string;
      }) => Promise<string>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          taskArns: ['arn:aws:ecs:ap-northeast-2:123456789012:task/prod/abcdef1234567890'],
        }),
        stderr: '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          tasks: [
            {
              taskArn: 'arn:aws:ecs:ap-northeast-2:123456789012:task/prod/abcdef1234567890',
              enableExecuteCommand: true,
              containers: [
                {
                  name: 'web',
                  runtimeId: 'runtime-123',
                },
              ],
            },
          ],
        }),
        stderr: '',
        exitCode: 0,
      });

    await expect(
      service.resolveEcsTaskTunnelTarget({
        profileName: 'default',
        region: 'ap-northeast-2',
        clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
        serviceName: 'api',
        containerName: 'web',
      }),
    ).resolves.toBe('ecs:prod_abcdef1234567890_runtime-123');
  });

  it('reports a clear error when there is no running ECS task for the service', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      resolveEcsTaskTunnelTarget: (input: {
        profileName: string;
        region: string;
        clusterArn: string;
        serviceName: string;
        containerName: string;
      }) => Promise<string>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ taskArns: [] }),
      stderr: '',
      exitCode: 0,
    });

    await expect(
      service.resolveEcsTaskTunnelTarget({
        profileName: 'default',
        region: 'ap-northeast-2',
        clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
        serviceName: 'api',
        containerName: 'web',
      }),
    ).rejects.toThrow('이 서비스에 실행 중인 task가 없습니다.');
  });

  it('loads ECS service logs from the last 30 minutes on the initial fetch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-29T00:30:00.000Z'));

    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      describeEcsServiceActionContext: ReturnType<typeof vi.fn>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      loadEcsServiceLogs: (input: {
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
      }) => Promise<Record<string, unknown>>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.describeEcsServiceActionContext = vi.fn().mockResolvedValue({
      serviceName: 'api',
      serviceArn: 'arn:aws:ecs:ap-northeast-2:123456789012:service/prod/api',
      taskDefinitionArn: 'api:7',
      taskDefinitionRevision: 7,
      containers: [
        {
          containerName: 'api',
          ports: [{ port: 8080, protocol: 'tcp' }],
          execEnabled: true,
          logSupport: {
            containerName: 'api',
            supported: true,
            reason: null,
            logGroupName: '/ecs/api',
            logRegion: 'ap-northeast-2',
            logStreamPrefix: 'ecs',
          },
        },
      ],
      runningTasks: [
        {
          taskArn: 'arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1',
          taskId: 'task-1',
          lastStatus: 'RUNNING',
          enableExecuteCommand: true,
          containers: [
            {
              containerName: 'api',
              lastStatus: 'RUNNING',
              runtimeId: 'runtime-1',
            },
          ],
        },
      ],
      deployments: [],
      events: [],
    });
    service.runResolvedCommand = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ events: [] }),
      stderr: '',
      exitCode: 0,
    });

    await service.loadEcsServiceLogs({
      profileName: 'default',
      region: 'ap-northeast-2',
      clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
      serviceName: 'api',
      limit: 200,
    });

    expect(service.runResolvedCommand).toHaveBeenCalledWith(
      'aws',
      expect.arrayContaining([
        'logs',
        'filter-log-events',
        '--start-time',
        String(Date.parse('2026-03-29T00:00:00.000Z')),
      ]),
      60_000,
    );

    vi.useRealTimers();
  });

  it('loads ECS service logs for a custom absolute range when start and end are provided', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      describeEcsServiceActionContext: ReturnType<typeof vi.fn>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
      loadEcsServiceLogs: (input: {
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
      }) => Promise<Record<string, unknown>>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.describeEcsServiceActionContext = vi.fn().mockResolvedValue({
      serviceName: 'api',
      serviceArn: 'arn:aws:ecs:ap-northeast-2:123456789012:service/prod/api',
      taskDefinitionArn: 'api:7',
      taskDefinitionRevision: 7,
      containers: [
        {
          containerName: 'api',
          ports: [{ port: 8080, protocol: 'tcp' }],
          execEnabled: true,
          logSupport: {
            containerName: 'api',
            supported: true,
            reason: null,
            logGroupName: '/ecs/api',
            logRegion: 'ap-northeast-2',
            logStreamPrefix: 'ecs',
          },
        },
      ],
      runningTasks: [
        {
          taskArn: 'arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1',
          taskId: 'task-1',
          lastStatus: 'RUNNING',
          enableExecuteCommand: true,
          containers: [
            {
              containerName: 'api',
              lastStatus: 'RUNNING',
              runtimeId: 'runtime-1',
            },
          ],
        },
      ],
      deployments: [],
      events: [],
    });
    service.runResolvedCommand = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ events: [] }),
      stderr: '',
      exitCode: 0,
    });

    await service.loadEcsServiceLogs({
      profileName: 'default',
      region: 'ap-northeast-2',
      clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
      serviceName: 'api',
      startTime: '2026-03-28T15:00:00.000Z',
      endTime: '2026-03-28T16:00:00.000Z',
      limit: 200,
    });

    expect(service.runResolvedCommand).toHaveBeenCalledWith(
      'aws',
      expect.arrayContaining([
        'logs',
        'filter-log-events',
        '--start-time',
        String(Date.parse('2026-03-28T15:00:00.000Z')),
        '--end-time',
        String(Date.parse('2026-03-28T16:00:00.000Z')),
      ]),
      60_000,
    );
  });
});
