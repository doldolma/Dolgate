import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AwsProfileDetails } from '@shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AwsService,
  buildSshMetadataProbeCommands,
} from './aws-service';
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

async function writeSsoCacheToken(
  rootDir: string,
  fileName: string,
  token: Record<string, unknown>,
) {
  const cacheDir = path.join(rootDir, 'sso', 'cache');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, fileName), JSON.stringify(token), 'utf8');
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
      ensureSessionManagerPluginAvailable: () => Promise<void>;
      getSsmClient: ReturnType<typeof vi.fn>;
      isManagedInstance: (profileName: string, region: string, instanceId: string) => Promise<boolean>;
    };

    service.ensureSessionManagerPluginAvailable = vi.fn().mockResolvedValue(undefined);
    service.getSsmClient = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        InstanceInformationList: [{ InstanceId: 'i-123', PingStatus: 'Online' }],
      }),
    });

    await expect(service.isManagedInstance('default', 'ap-northeast-2', 'i-123')).resolves.toBe(true);
  });

  it('returns false when the instance is not currently managed by SSM', async () => {
    const service = new AwsService() as unknown as {
      ensureSessionManagerPluginAvailable: () => Promise<void>;
      getSsmClient: ReturnType<typeof vi.fn>;
      isManagedInstance: (profileName: string, region: string, instanceId: string) => Promise<boolean>;
    };

    service.ensureSessionManagerPluginAvailable = vi.fn().mockResolvedValue(undefined);
    service.getSsmClient = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        InstanceInformationList: [{ InstanceId: 'i-123', PingStatus: 'Inactive' }],
      }),
    });

    await expect(service.isManagedInstance('default', 'ap-northeast-2', 'i-123')).resolves.toBe(false);
  });

  it('returns false when Session Manager reports ConnectionLost', async () => {
    const service = new AwsService() as unknown as {
      ensureSessionManagerPluginAvailable: () => Promise<void>;
      getSsmClient: ReturnType<typeof vi.fn>;
      isManagedInstance: (profileName: string, region: string, instanceId: string) => Promise<boolean>;
    };

    service.ensureSessionManagerPluginAvailable = vi.fn().mockResolvedValue(undefined);
    service.getSsmClient = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        InstanceInformationList: [{ InstanceId: 'i-123', PingStatus: 'ConnectionLost' }],
      }),
    });

    await expect(service.isManagedInstance('default', 'ap-northeast-2', 'i-123')).resolves.toBe(false);
  });
});

describe('AwsService.listRegions', () => {
  function createListRegionsService(send: ReturnType<typeof vi.fn>) {
    const service = new AwsService() as unknown as {
      getEc2Client: ReturnType<typeof vi.fn>;
      listRegions: (profileName: string) => Promise<string[]>;
    };

    service.getEc2Client = vi.fn().mockReturnValue({ send });
    return service;
  }

  it('falls back to the built-in EC2 region list when DescribeRegions is denied', async () => {
    const service = createListRegionsService(
      vi.fn().mockRejectedValue(
        Object.assign(
          new Error(
            'You are not authorized to perform this operation.',
          ),
          { name: 'UnauthorizedOperation' },
        ),
      ),
    );

    const regions = await service.listRegions('readonly');

    expect(regions).toContain('ap-northeast-2');
    expect(regions).toContain('us-east-1');
    expect(regions).toContain('mx-central-1');
    expect(service.getEc2Client).toHaveBeenCalled();
  });

  it('keeps non-permission DescribeRegions failures visible', async () => {
    const service = createListRegionsService(
      vi.fn().mockRejectedValue(
        new Error(
          'Unable to locate credentials. You can configure credentials by running "aws configure".',
        ),
      ),
    );

    await expect(service.listRegions('broken')).rejects.toThrow(
      'Unable to locate credentials',
    );
  });

  it('falls back to the built-in EC2 region list when DescribeRegions returns an empty payload', async () => {
    const service = createListRegionsService(
      vi.fn().mockResolvedValue({ Regions: [] }),
    );

    await expect(service.listRegions('empty')).resolves.toContain('ap-northeast-2');
  });
});

describe('AwsService.getProfileStatus', () => {
  it('includes the configured region when the profile is authenticated', async () => {
    const service = new AwsService() as unknown as {
      readConfigValue: ReturnType<typeof vi.fn>;
      stsGetCallerIdentityFromRoot: ReturnType<typeof vi.fn>;
      getProfileStatus: (profileName: string) => Promise<{
        configuredRegion?: string | null;
        isAuthenticated: boolean;
      }>;
    };

    service.readConfigValue = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('ap-northeast-2');
    service.stsGetCallerIdentityFromRoot = vi.fn().mockResolvedValue({
      account: '123456789012',
      arn: 'arn:aws:iam::123456789012:user/test',
    });

    await expect(service.getProfileStatus('default')).resolves.toMatchObject({
      isAuthenticated: true,
      configuredRegion: 'ap-northeast-2',
    });
    expect(service.stsGetCallerIdentityFromRoot).toHaveBeenCalledWith(
      'default',
      expect.any(String),
      30_000,
    );
  });

  it('returns null configuredRegion when the profile has no default region', async () => {
    const service = new AwsService() as unknown as {
      readConfigValue: ReturnType<typeof vi.fn>;
      stsGetCallerIdentityFromRoot: ReturnType<typeof vi.fn>;
      getProfileStatus: (profileName: string) => Promise<{
        configuredRegion?: string | null;
        isAuthenticated: boolean;
      }>;
    };

    service.readConfigValue = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    service.stsGetCallerIdentityFromRoot = vi
      .fn()
      .mockRejectedValue(new Error('credential missing'));

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

describe('AwsService.buildServerProxySessionEnvSpec', () => {
  it('resolves managed profile credentials into server-safe AWS env values', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeFile(
      path.join(rootDir, 'config'),
      ['[profile prod]', 'region = ap-southeast-2', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(rootDir, 'credentials'),
      [
        '[prod]',
        'aws_access_key_id = AKIATEST123',
        'aws_secret_access_key = secret-value',
        'aws_session_token = token-value',
        '',
      ].join('\n'),
      'utf8',
    );

    const service = new AwsService(rootDir);

    await expect(
      service.buildServerProxySessionEnvSpec('prod', 'ap-southeast-2'),
    ).resolves.toEqual({
      env: {
        AWS_ACCESS_KEY_ID: 'AKIATEST123',
        AWS_SECRET_ACCESS_KEY: 'secret-value',
        AWS_REGION: 'ap-southeast-2',
        AWS_DEFAULT_REGION: 'ap-southeast-2',
      },
      unsetEnv: [
        'AWS_SESSION_TOKEN',
        'AWS_PROFILE',
        'AWS_DEFAULT_PROFILE',
        'AWS_CONFIG_FILE',
        'AWS_SHARED_CREDENTIALS_FILE',
      ],
    });
  });
});

describe('AwsService.createProfile', () => {
  it('validates credentials first and writes the new profile when they are valid', async () => {
    const rootDir = await createTempAwsProfileDir();
    const service = new AwsService(rootDir) as unknown as {
      stsGetCallerIdentityWithStaticCredentials: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'static';
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.stsGetCallerIdentityWithStaticCredentials = vi
      .fn()
      .mockResolvedValue(undefined);

    await service.createProfile({
      kind: 'static',
      profileName: 'dolssh-prod',
      accessKeyId: 'AKIATEST123',
      secretAccessKey: 'secret-value',
      region: 'ap-northeast-2',
    });

    expect(service.stsGetCallerIdentityWithStaticCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        accessKeyId: 'AKIATEST123',
        secretAccessKey: 'secret-value',
        region: 'ap-northeast-2',
      }),
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
      stsGetCallerIdentityWithStaticCredentials: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'static';
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.stsGetCallerIdentityWithStaticCredentials = vi.fn();

    await expect(
      service.createProfile({
        kind: 'static',
        profileName: 'dolssh-prod',
        accessKeyId: 'AKIATEST123',
        secretAccessKey: 'secret-value',
        region: null,
      }),
    ).rejects.toThrow('같은 이름의 AWS 프로필이 이미 존재합니다.');
    expect(service.stsGetCallerIdentityWithStaticCredentials).not.toHaveBeenCalled();
  });

  it('does not write a region when it is omitted', async () => {
    const rootDir = await createTempAwsProfileDir();
    const service = new AwsService(rootDir) as unknown as {
      stsGetCallerIdentityWithStaticCredentials: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'static';
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.stsGetCallerIdentityWithStaticCredentials = vi
      .fn()
      .mockResolvedValue(undefined);

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
      listProfiles: ReturnType<typeof vi.fn>;
      stsGetCallerIdentityWithStaticCredentials: ReturnType<typeof vi.fn>;
      saveStaticProfileValues: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'static';
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.listProfiles = vi.fn().mockResolvedValue([]);
    service.stsGetCallerIdentityWithStaticCredentials = vi
      .fn()
      .mockRejectedValue(
        Object.assign(
          new Error('The security token included in the request is invalid.'),
          { name: 'InvalidClientTokenId' },
        ),
      );
    service.saveStaticProfileValues = vi.fn();

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
    expect(service.saveStaticProfileValues).not.toHaveBeenCalled();
  });

  it('keeps unmapped validation errors as raw messages for debugging', async () => {
    const service = new AwsService() as unknown as {
      listProfiles: ReturnType<typeof vi.fn>;
      stsGetCallerIdentityWithStaticCredentials: ReturnType<typeof vi.fn>;
      saveStaticProfileValues: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'static';
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.listProfiles = vi.fn().mockResolvedValue([]);
    service.stsGetCallerIdentityWithStaticCredentials = vi
      .fn()
      .mockRejectedValue(new Error('mystery validation failure'));
    service.saveStaticProfileValues = vi.fn();

    await expect(
      service.createProfile({
        kind: 'static',
        profileName: 'dolssh-prod',
        accessKeyId: 'AKIATEST123',
        secretAccessKey: 'secret-value',
        region: null,
      }),
    ).rejects.toThrow('mystery validation failure');
    expect(service.saveStaticProfileValues).not.toHaveBeenCalled();
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
      stsAssumeRoleWithSourceProfile: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'role';
        profileName: string;
        sourceProfileName: string;
        roleArn: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.stsAssumeRoleWithSourceProfile = vi
      .fn()
      .mockRejectedValue(
        Object.assign(
          new Error('User is not authorized to perform sts:AssumeRole'),
          { name: 'AccessDenied' },
        ),
      );

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
      stsAssumeRoleWithSourceProfile: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'role';
        profileName: string;
        sourceProfileName: string;
        roleArn: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.stsAssumeRoleWithSourceProfile = vi.fn().mockResolvedValue(undefined);

    await service.createProfile({
      kind: 'role',
      profileName: 'prod-admin',
      sourceProfileName: 'default',
      roleArn: 'arn:aws:iam::123456789012:role/Admin',
      region: 'ap-northeast-2',
    });

    expect(service.stsAssumeRoleWithSourceProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceProfileName: 'default',
        roleArn: 'arn:aws:iam::123456789012:role/Admin',
        sessionName: expect.stringMatching(/^dolssh-validate-\d+$/),
      }),
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
      stsAssumeRoleWithSourceProfile: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'role';
        profileName: string;
        sourceProfileName: string;
        roleArn: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.stsAssumeRoleWithSourceProfile = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Error when retrieving token from sso: Token has expired and refresh failed',
        ),
      );

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
      stsAssumeRoleWithSourceProfile: ReturnType<typeof vi.fn>;
      createProfile: (input: {
        kind: 'role';
        profileName: string;
        sourceProfileName: string;
        roleArn: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.stsAssumeRoleWithSourceProfile = vi
      .fn()
      .mockRejectedValue(
        Object.assign(
          new Error(
            'Invalid length for parameter RoleArn, value: 18, valid min length: 20',
          ),
          { name: 'ValidationError' },
        ),
      );

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
      listProfiles: ReturnType<typeof vi.fn>;
      stsGetCallerIdentityFromRoot: ReturnType<typeof vi.fn>;
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

    service.listProfiles = vi.fn().mockResolvedValue([]);
    service.stsGetCallerIdentityFromRoot = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.',
        ),
      );
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

  it('persists the prepared SSO token cache into the managed store after successful validation', async () => {
    const rootDir = await createTempAwsProfileDir();
    const homeDir = await createTempAwsProfileDir();
    const awsRootDir = path.join(homeDir, '.aws');
    await writeAwsProfileFiles(awsRootDir, {
      config: [
        '[profile corp-sso]',
        'sso_session = corp-sso',
        'region = ap-northeast-2',
        '',
        '[sso-session corp-sso]',
        'sso_start_url = https://example.awsapps.com/start',
        'sso_region = ap-northeast-2',
        '',
      ].join('\n'),
      credentials: '',
    });
    await mkdir(path.join(awsRootDir, 'sso', 'cache'), { recursive: true });
    await writeFile(
      path.join(awsRootDir, 'sso', 'cache', 'token.json'),
      JSON.stringify({
        accessToken: 'prepared-token',
        expiresAt: '2026-04-10T01:00:00.000Z',
        startUrl: 'https://example.awsapps.com/start',
        region: 'ap-northeast-2',
      }),
      'utf8',
    );

    const service = new AwsService(rootDir) as unknown as {
      stsGetCallerIdentityFromRoot: ReturnType<typeof vi.fn>;
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

    service.stsGetCallerIdentityFromRoot = vi.fn().mockResolvedValue({
      account: '123456789012',
      arn: 'arn:aws:sts::123456789012:assumed-role/AdministratorAccess/dolssh',
    });
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

    await service.createProfile({
      kind: 'sso',
      profileName: 'corp-sso',
      ssoStartUrl: 'https://example.awsapps.com/start',
      ssoRegion: 'ap-northeast-2',
      region: 'ap-northeast-2',
      preparationToken: 'prep-token',
      ssoSessionName: 'corp-sso',
      ssoAccountId: '123456789012',
      ssoRoleName: 'AdministratorAccess',
    });

    const managedConfig = await readFile(path.join(rootDir, 'config'), 'utf8');
    const managedToken = await readFile(
      path.join(rootDir, 'sso', 'cache', 'token.json'),
      'utf8',
    );

    expect(managedConfig).toContain('[profile corp-sso]');
    expect(managedConfig).toContain('sso_account_id = 123456789012');
    expect(managedConfig).toContain('sso_role_name = AdministratorAccess');
    expect(JSON.parse(managedToken)).toMatchObject({
      accessToken: 'prepared-token',
      startUrl: 'https://example.awsapps.com/start',
      region: 'ap-northeast-2',
    });
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
      readConfigValue: ReturnType<typeof vi.fn>;
      stsGetCallerIdentityFromRoot: ReturnType<typeof vi.fn>;
      getProfileDetails: (profileName: string) => Promise<AwsProfileDetails>;
    };

    service.readConfigValue = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('ap-northeast-2');
    service.stsGetCallerIdentityFromRoot = vi.fn().mockResolvedValue({
      account: '123456789012',
      arn: 'arn:aws:iam::123456789012:user/test',
    });

    await expect(service.getProfileDetails('static-profile')).resolves.toMatchObject({
      profileName: 'static-profile',
      kind: 'static',
    });
    expect(service.stsGetCallerIdentityFromRoot).toHaveBeenCalledWith(
      'static-profile',
      expect.any(String),
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
    ).resolves.toEqual(
      JSON.stringify({ accessToken: 'external-only-token' }),
    );
  });

  it('backfills the managed sso cache from the external root on first managed-profile init', async () => {
    const managedRootDir = await createTempAwsProfileDir();
    const externalRootDir = await createTempAwsProfileDir();
    await writeSsoCacheToken(externalRootDir, 'token.json', {
      accessToken: 'external-backfill-token',
      expiresAt: '2026-04-11T00:00:00.000Z',
      startUrl: 'https://example.awsapps.com/start',
      region: 'ap-northeast-2',
    });

    const service = new AwsService(managedRootDir, externalRootDir);

    await expect(service.listProfiles()).resolves.toEqual([]);
    await expect(
      readFile(path.join(managedRootDir, 'sso', 'cache', 'token.json'), 'utf8'),
    ).resolves.toEqual(
      JSON.stringify({
        accessToken: 'external-backfill-token',
        expiresAt: '2026-04-11T00:00:00.000Z',
        startUrl: 'https://example.awsapps.com/start',
        region: 'ap-northeast-2',
      }),
    );
  });

  it('keeps the later-expiring sso cache entry when managed and external caches conflict', async () => {
    const managedRootDir = await createTempAwsProfileDir();
    const externalRootDir = await createTempAwsProfileDir();
    await writeSsoCacheToken(managedRootDir, 'token.json', {
      accessToken: 'managed-fresher-token',
      expiresAt: '2026-04-12T00:00:00.000Z',
      startUrl: 'https://example.awsapps.com/start',
      region: 'ap-northeast-2',
    });
    await writeSsoCacheToken(externalRootDir, 'token.json', {
      accessToken: 'external-stale-token',
      expiresAt: '2026-04-11T00:00:00.000Z',
      startUrl: 'https://example.awsapps.com/start',
      region: 'ap-northeast-2',
    });

    const service = new AwsService(managedRootDir, externalRootDir) as unknown as {
      syncSsoCacheIntoManagedRoot: (sourceAwsRootDir: string) => Promise<void>;
    };

    await service.syncSsoCacheIntoManagedRoot(externalRootDir);

    await expect(
      readFile(path.join(managedRootDir, 'sso', 'cache', 'token.json'), 'utf8'),
    ).resolves.toEqual(
      JSON.stringify({
        accessToken: 'managed-fresher-token',
        expiresAt: '2026-04-12T00:00:00.000Z',
        startUrl: 'https://example.awsapps.com/start',
        region: 'ap-northeast-2',
      }),
    );
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
      stsGetCallerIdentityWithStaticCredentials: ReturnType<typeof vi.fn>;
      updateProfile: (input: {
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.stsGetCallerIdentityWithStaticCredentials = vi
      .fn()
      .mockResolvedValue(undefined);

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
    expect(service.stsGetCallerIdentityWithStaticCredentials).toHaveBeenCalled();
  });

  it('updates static, sso, and role profile regions without validating aws auth', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: [
        '[profile source-static]',
        'region = ap-northeast-2',
        '',
        '[profile corp-sso]',
        'sso_session = corp-session',
        'sso_account_id = 123456789012',
        'sso_role_name = ReadOnly',
        'region = us-west-2',
        '',
        '[sso-session corp-session]',
        'sso_region = ap-northeast-2',
        'sso_start_url = https://example.awsapps.com/start',
        'sso_registration_scopes = sso:account:access',
        '',
        '[profile assume-admin]',
        'role_arn = arn:aws:iam::123456789012:role/Admin',
        'source_profile = source-static',
        '',
      ].join('\n'),
      credentials: [
        '[source-static]',
        'aws_access_key_id = AKIASOURCE1234',
        'aws_secret_access_key = source-secret',
        '',
      ].join('\n'),
    });

    const service = new AwsService(rootDir) as unknown as {
      stsGetCallerIdentityWithStaticCredentials: ReturnType<typeof vi.fn>;
      stsAssumeRoleWithSourceProfile: ReturnType<typeof vi.fn>;
      updateProfileRegion: (input: {
        profileName: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.stsGetCallerIdentityWithStaticCredentials = vi
      .fn()
      .mockRejectedValue(new Error('auth validation should not run'));
    service.stsAssumeRoleWithSourceProfile = vi
      .fn()
      .mockRejectedValue(new Error('auth validation should not run'));

    await service.updateProfileRegion({
      profileName: 'source-static',
      region: 'us-east-1',
    });
    await service.updateProfileRegion({
      profileName: 'corp-sso',
      region: 'ap-southeast-2',
    });
    await service.updateProfileRegion({
      profileName: 'assume-admin',
      region: 'eu-west-1',
    });

    const config = await readFile(path.join(rootDir, 'config'), 'utf8');
    const credentials = await readFile(path.join(rootDir, 'credentials'), 'utf8');

    expect(config).toContain('[profile source-static]\nregion = us-east-1');
    expect(config).toContain(
      [
        '[profile assume-admin]',
        'role_arn = arn:aws:iam::123456789012:role/Admin',
        'source_profile = source-static',
        'region = eu-west-1',
      ].join('\n'),
    );
    expect(config).toMatch(
      /\[profile corp-sso\]\nsso_session = dolssh-[0-9a-f]{12}\nsso_account_id = 123456789012\nsso_role_name = ReadOnly\nregion = ap-southeast-2/,
    );
    expect(credentials).toContain('aws_access_key_id = AKIASOURCE1234');
    expect(service.stsGetCallerIdentityWithStaticCredentials).not.toHaveBeenCalled();
    expect(service.stsAssumeRoleWithSourceProfile).not.toHaveBeenCalled();
  });

  it('removes a profile region when saving a blank region-only update', async () => {
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
      updateProfileRegion: (input: {
        profileName: string;
        region?: string | null;
      }) => Promise<void>;
    };

    await service.updateProfileRegion({
      profileName: 'static-profile',
      region: '',
    });

    const config = await readFile(path.join(rootDir, 'config'), 'utf8');
    expect(config.trim()).toBe('');
    expect(config).not.toContain('region = ap-northeast-2');
  });

  it('rejects region-only updates for missing managed profiles', async () => {
    const rootDir = await createTempAwsProfileDir();
    await writeAwsProfileFiles(rootDir, {
      config: '',
      credentials: '',
    });

    const service = new AwsService(rootDir) as unknown as {
      updateProfileRegion: (input: {
        profileName: string;
        region?: string | null;
      }) => Promise<void>;
    };

    await expect(
      service.updateProfileRegion({
        profileName: 'missing-profile',
        region: 'us-east-1',
      }),
    ).rejects.toThrow('선택한 AWS 프로필을 찾지 못했습니다.');
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
      stsGetCallerIdentityWithStaticCredentials: ReturnType<typeof vi.fn>;
      updateProfile: (input: {
        profileName: string;
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | null;
      }) => Promise<void>;
    };

    service.stsGetCallerIdentityWithStaticCredentials = vi
      .fn()
      .mockRejectedValue(
        Object.assign(
          new Error(
            'The request signature we calculated does not match the signature you provided.',
          ),
          { name: 'SignatureDoesNotMatch' },
        ),
      );

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
  });

  it('translates SSO login preparation failures', async () => {
    const rootDir = await createTempAwsProfileDir();
    const service = new AwsService(rootDir) as unknown as {
      listProfiles: ReturnType<typeof vi.fn>;
      performSsoLoginForRoot: ReturnType<typeof vi.fn>;
      prepareSsoProfile: (input: {
        profileName: string;
        ssoStartUrl: string;
        ssoRegion: string;
        region?: string | null;
      }) => Promise<unknown>;
    };

    service.listProfiles = vi.fn().mockResolvedValue([]);
    service.performSsoLoginForRoot = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.',
        ),
      );

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
      listProfiles: ReturnType<typeof vi.fn>;
      performSsoLoginForRoot: ReturnType<typeof vi.fn>;
      listSsoAccounts: ReturnType<typeof vi.fn>;
      prepareSsoProfile: (input: {
        profileName: string;
        ssoStartUrl: string;
        ssoRegion: string;
        region?: string | null;
      }) => Promise<unknown>;
    };

    service.listProfiles = vi.fn().mockResolvedValue([]);
    service.performSsoLoginForRoot = vi
      .fn()
      .mockResolvedValue({ accessToken: 'token-value' });
    service.listSsoAccounts = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'SSO 로그인 후 account 또는 role 목록을 불러오지 못했습니다. 권한과 SSO 설정을 확인해 주세요.',
        ),
      );

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
      getEc2Client: ReturnType<typeof vi.fn>;
      getSsmClient: ReturnType<typeof vi.fn>;
      listEc2Instances: (profileName: string, region: string) => Promise<Array<Record<string, unknown>>>;
    };

    service.getEc2Client = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-123',
                PrivateIpAddress: '10.0.0.10',
                PlatformDetails: 'Linux/UNIX',
                Placement: { AvailabilityZone: 'ap-northeast-2a' },
                State: { Name: 'running' },
                Tags: [{ Key: 'Name', Value: 'web-1' }],
              },
            ],
          },
        ],
      }),
    });
    service.getSsmClient = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        InstanceInformationList: [{ InstanceId: 'i-123', PingStatus: 'Online' }],
      }),
    });

    await expect(service.listEc2Instances('default', 'ap-northeast-2')).resolves.toEqual([
      {
        instanceId: 'i-123',
        name: 'web-1',
        availabilityZone: 'ap-northeast-2a',
        platform: 'Linux/UNIX',
        privateIp: '10.0.0.10',
        state: 'running',
        ssmAvailability: 'ready',
        ssmAvailabilityReason: null,
      }
    ]);
    expect(service.getEc2Client).toHaveBeenCalled();
    expect(service.getSsmClient).toHaveBeenCalled();
  });

  it('marks inactive managed instances unavailable with a more specific reason', async () => {
    const service = new AwsService() as unknown as {
      getEc2Client: ReturnType<typeof vi.fn>;
      getSsmClient: ReturnType<typeof vi.fn>;
      listEc2Instances: (profileName: string, region: string) => Promise<Array<Record<string, unknown>>>;
    };

    service.getEc2Client = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-123',
                PrivateIpAddress: '10.0.0.10',
                PlatformDetails: 'Linux/UNIX',
                Placement: { AvailabilityZone: 'ap-northeast-2a' },
                State: { Name: 'running' },
                Tags: [{ Key: 'Name', Value: 'web-1' }],
              },
            ],
          },
        ],
      }),
    });
    service.getSsmClient = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        InstanceInformationList: [{ InstanceId: 'i-123', PingStatus: 'Inactive' }],
      }),
    });

    await expect(service.listEc2Instances('default', 'ap-northeast-2')).resolves.toEqual([
      {
        instanceId: 'i-123',
        name: 'web-1',
        availabilityZone: 'ap-northeast-2a',
        platform: 'Linux/UNIX',
        privateIp: '10.0.0.10',
        state: 'running',
        ssmAvailability: 'unavailable',
        ssmAvailabilityReason:
          '이 인스턴스는 SSM managed instance로 등록되어 있지만 현재 연결이 비활성 상태입니다. SSM Agent, 인스턴스 프로파일, 네트워크 연결을 확인해 주세요.',
      }
    ]);
  });

  it('marks ConnectionLost managed instances unavailable with an offline reason', async () => {
    const service = new AwsService() as unknown as {
      getEc2Client: ReturnType<typeof vi.fn>;
      getSsmClient: ReturnType<typeof vi.fn>;
      listEc2Instances: (profileName: string, region: string) => Promise<Array<Record<string, unknown>>>;
    };

    service.getEc2Client = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-123',
                PrivateIpAddress: '10.0.0.10',
                PlatformDetails: 'Linux/UNIX',
                Placement: { AvailabilityZone: 'ap-northeast-2a' },
                State: { Name: 'running' },
                Tags: [{ Key: 'Name', Value: 'web-1' }],
              },
            ],
          },
        ],
      }),
    });
    service.getSsmClient = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        InstanceInformationList: [{ InstanceId: 'i-123', PingStatus: 'ConnectionLost' }],
      }),
    });

    await expect(service.listEc2Instances('default', 'ap-northeast-2')).resolves.toEqual([
      {
        instanceId: 'i-123',
        name: 'web-1',
        availabilityZone: 'ap-northeast-2a',
        platform: 'Linux/UNIX',
        privateIp: '10.0.0.10',
        state: 'running',
        ssmAvailability: 'unavailable',
        ssmAvailabilityReason:
          '이 인스턴스는 SSM managed instance로 등록되어 있지만 Session Manager 연결 상태가 오프라인(ConnectionLost)입니다. SSM Agent, 인스턴스 프로파일, 네트워크 연결을 확인해 주세요.',
      }
    ]);
  });

  it('marks non-running instances unavailable with a state-specific reason', async () => {
    const service = new AwsService() as unknown as {
      getEc2Client: ReturnType<typeof vi.fn>;
      getSsmClient: ReturnType<typeof vi.fn>;
      listEc2Instances: (profileName: string, region: string) => Promise<Array<Record<string, unknown>>>;
    };

    service.getEc2Client = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-123',
                PrivateIpAddress: '10.0.0.10',
                PlatformDetails: 'Linux/UNIX',
                Placement: { AvailabilityZone: 'ap-northeast-2a' },
                State: { Name: 'stopped' },
                Tags: [{ Key: 'Name', Value: 'web-1' }],
              },
            ],
          },
        ],
      }),
    });
    service.getSsmClient = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        InstanceInformationList: [],
      }),
    });

    await expect(service.listEc2Instances('default', 'ap-northeast-2')).resolves.toEqual([
      {
        instanceId: 'i-123',
        name: 'web-1',
        availabilityZone: 'ap-northeast-2a',
        platform: 'Linux/UNIX',
        privateIp: '10.0.0.10',
        state: 'stopped',
        ssmAvailability: 'unavailable',
        ssmAvailabilityReason:
          '이 인스턴스는 현재 stopped 상태라 SSM import를 사용할 수 없습니다. 인스턴스를 실행한 뒤 다시 시도해 주세요.',
      }
    ]);
  });

  it('keeps the EC2 list but marks every instance unknown when SSM availability lookup fails', async () => {
    const service = new AwsService() as unknown as {
      getEc2Client: ReturnType<typeof vi.fn>;
      getSsmClient: ReturnType<typeof vi.fn>;
      listEc2Instances: (profileName: string, region: string) => Promise<Array<Record<string, unknown>>>;
    };

    service.getEc2Client = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-123',
                PrivateIpAddress: '10.0.0.10',
                PlatformDetails: 'Linux/UNIX',
                Placement: { AvailabilityZone: 'ap-northeast-2a' },
                State: { Name: 'running' },
                Tags: [{ Key: 'Name', Value: 'web-1' }],
              },
            ],
          },
        ],
      }),
    });
    service.getSsmClient = vi.fn().mockReturnValue({
      send: vi.fn().mockRejectedValue(new Error('AccessDeniedException')),
    });

    await expect(service.listEc2Instances('default', 'ap-northeast-2')).resolves.toEqual([
      {
        instanceId: 'i-123',
        name: 'web-1',
        availabilityZone: 'ap-northeast-2a',
        platform: 'Linux/UNIX',
        privateIp: '10.0.0.10',
        state: 'running',
        ssmAvailability: 'unknown',
        ssmAvailabilityReason:
          'SSM 상태를 조회할 권한이 없어 가져오기를 차단했습니다. 사용자/역할에 `ssm:DescribeInstanceInformation` 권한이 포함되어 있는지 확인해 주세요.',
      }
    ]);
  });

  it('keeps the EC2 list but marks every instance unknown when SSM availability lookup times out', async () => {
    const service = new AwsService() as unknown as {
      getEc2Client: ReturnType<typeof vi.fn>;
      getSsmClient: ReturnType<typeof vi.fn>;
      listEc2Instances: (profileName: string, region: string) => Promise<Array<Record<string, unknown>>>;
    };

    service.getEc2Client = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-123',
                PrivateIpAddress: '10.0.0.10',
                PlatformDetails: 'Linux/UNIX',
                Placement: { AvailabilityZone: 'ap-northeast-2a' },
                State: { Name: 'running' },
                Tags: [{ Key: 'Name', Value: 'web-1' }],
              },
            ],
          },
        ],
      }),
    });
    service.getSsmClient = vi.fn().mockReturnValue({
      send: vi.fn().mockRejectedValue(new Error('operation timed out')),
    });

    await expect(service.listEc2Instances('default', 'ap-northeast-2')).resolves.toEqual([
      {
        instanceId: 'i-123',
        name: 'web-1',
        availabilityZone: 'ap-northeast-2a',
        platform: 'Linux/UNIX',
        privateIp: '10.0.0.10',
        state: 'running',
        ssmAvailability: 'unknown',
        ssmAvailabilityReason:
          'SSM 상태 조회가 제한 시간을 초과했습니다. SSM 연결 상태와 권한을 확인한 뒤 다시 시도해 주세요.',
      }
    ]);
    expect(service.getEc2Client).toHaveBeenCalled();
    expect(service.getSsmClient).toHaveBeenCalled();
  });

  it('caps paginated SSM availability lookup calls to the remaining timeout budget', async () => {
    const service = new AwsService() as unknown as {
      getEc2Client: ReturnType<typeof vi.fn>;
      getSsmClient: ReturnType<typeof vi.fn>;
      listEc2Instances: (profileName: string, region: string) => Promise<Array<Record<string, unknown>>>;
    };
    const nowValues = [1_000_000, 1_000_000, 1_000_000, 1_010_500, 1_010_500];
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => nowValues.shift() ?? 1_010_500);

    service.getEc2Client = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-123',
                PrivateIpAddress: '10.0.0.10',
                PlatformDetails: 'Linux/UNIX',
                Placement: { AvailabilityZone: 'ap-northeast-2a' },
                State: { Name: 'running' },
                Tags: [{ Key: 'Name', Value: 'web-1' }],
              },
            ],
          },
        ],
      }),
    });
    const ssmSend = vi
      .fn()
      .mockResolvedValueOnce({
        InstanceInformationList: [],
        NextToken: 'next-page',
      })
      .mockResolvedValueOnce({
        InstanceInformationList: [{ InstanceId: 'i-123', PingStatus: 'Online' }],
      });
    service.getSsmClient = vi.fn().mockReturnValue({ send: ssmSend });

    try {
      await expect(service.listEc2Instances('default', 'ap-northeast-2')).resolves.toEqual([
        {
          instanceId: 'i-123',
          name: 'web-1',
          availabilityZone: 'ap-northeast-2a',
          platform: 'Linux/UNIX',
          privateIp: '10.0.0.10',
          state: 'running',
          ssmAvailability: 'ready',
          ssmAvailabilityReason: null,
        }
      ]);
      expect(ssmSend).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('describes a single EC2 instance and returns null when no instance is present', async () => {
    const service = new AwsService() as unknown as {
      getEc2Client: ReturnType<typeof vi.fn>;
      describeEc2Instance: (profileName: string, region: string, instanceId: string) => Promise<Record<string, unknown> | null>;
    };

    service.getEc2Client = vi.fn().mockReturnValue({
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-abc',
                  PrivateIpAddress: '10.0.0.99',
                  PlatformDetails: 'Linux/UNIX',
                  Placement: { AvailabilityZone: 'ap-northeast-2c' },
                  State: { Name: 'running' },
                  Tags: [{ Key: 'Name', Value: 'api-1' }],
                },
              ],
            },
          ],
        })
        .mockResolvedValueOnce({ Reservations: [] }),
    });

    await expect(service.describeEc2Instance('default', 'ap-northeast-2', 'i-abc')).resolves.toEqual({
      instanceId: 'i-abc',
      name: 'api-1',
      availabilityZone: 'ap-northeast-2c',
      platform: 'Linux/UNIX',
      privateIp: '10.0.0.99',
      state: 'running',
      ssmAvailability: 'unknown',
      ssmAvailabilityReason: null,
    });
    await expect(service.describeEc2Instance('default', 'ap-northeast-2', 'i-missing')).resolves.toBeNull();
  });

  it('sends the SSH public key with the expected EIC parameters', async () => {
    const service = new AwsService() as unknown as {
      getEc2InstanceConnectClient: ReturnType<typeof vi.fn>;
      sendSshPublicKey: (input: {
        profileName: string;
        region: string;
        instanceId: string;
        availabilityZone: string;
        osUser: string;
        publicKey: string;
      }) => Promise<void>;
    };

    const eicSend = vi.fn().mockResolvedValue({ Success: true });
    service.getEc2InstanceConnectClient = vi.fn().mockReturnValue({ send: eicSend });

    await service.sendSshPublicKey({
      profileName: 'default',
      region: 'ap-northeast-2',
      instanceId: 'i-abc',
      availabilityZone: 'ap-northeast-2a',
      osUser: 'ubuntu',
      publicKey: 'ssh-ed25519 AAAATEST'
    });

    expect(service.getEc2InstanceConnectClient).toHaveBeenCalledWith(
      'default',
      'ap-northeast-2',
    );
    expect(eicSend).toHaveBeenCalledTimes(1);
    const sentCommand = eicSend.mock.calls[0][0];
    expect(sentCommand.input).toEqual({
      InstanceId: 'i-abc',
      AvailabilityZone: 'ap-northeast-2a',
      InstanceOSUser: 'ubuntu',
      SSHPublicKey: 'ssh-ed25519 AAAATEST',
    });
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

  it('retries polling when the invocation is not registered yet (InvocationDoesNotExist)', async () => {
    const service = new AwsService() as unknown as {
      ensureSessionManagerPluginAvailable: () => Promise<void>;
      getSsmClient: ReturnType<typeof vi.fn>;
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

    service.ensureSessionManagerPluginAvailable = vi.fn().mockResolvedValue(undefined);
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Command: { CommandId: 'cmd-123' } })
      .mockRejectedValueOnce(
        Object.assign(new Error(''), { name: 'InvocationDoesNotExist' })
      )
      .mockResolvedValueOnce({
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
    service.getSsmClient = vi.fn().mockReturnValue({ send });

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
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('times out SSH metadata polling after the shorter SSM probe budget', async () => {
    vi.useFakeTimers();
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      ensureSessionManagerPluginAvailable: () => Promise<void>;
      sendRunCommand: ReturnType<typeof vi.fn>;
      getCommandInvocation: ReturnType<typeof vi.fn>;
      loadHostSshMetadata: (input: {
        profileName: string;
        region: string;
        instanceId: string;
      }) => Promise<unknown>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.ensureSessionManagerPluginAvailable = vi.fn().mockResolvedValue(undefined);
    service.sendRunCommand = vi.fn().mockResolvedValue('cmd-123');
    service.getCommandInvocation = vi.fn().mockResolvedValue({
      Status: 'InProgress',
      StandardOutputContent: '',
      StandardErrorContent: '',
    });

    try {
      const promise = service.loadHostSshMetadata({
        profileName: 'default',
        region: 'ap-northeast-2',
        instanceId: 'i-abc',
      });
      const expectation = expect(promise).rejects.toThrow(
        'SSH 설정 확인이 제한 시간을 초과했습니다. SSM 연결 상태와 권한을 확인한 뒤 다시 시도해 주세요.',
      );

      await vi.advanceTimersByTimeAsync(12_000);
      await expectation;
      expect(service.getCommandInvocation).toHaveBeenCalledTimes(12);
      expect(service.sendRunCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutMs: 5_000,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
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

describe('AwsService.startSsmShellSession', () => {
  it('returns the session token issued by StartSession', async () => {
    const service = new AwsService() as unknown as {
      getSsmClient: ReturnType<typeof vi.fn>;
      startSsmShellSession: (
        profileName: string,
        region: string,
        instanceId: string,
      ) => Promise<{ sessionId: string; streamUrl: string; tokenValue: string }>;
    };

    const send = vi.fn().mockResolvedValue({
      SessionId: 'ssm-sess-1',
      StreamUrl: 'wss://ssmmessages.example/v1/data-channel/ssm-sess-1',
      TokenValue: 'token-1',
    });
    service.getSsmClient = vi.fn().mockReturnValue({ send });

    await expect(
      service.startSsmShellSession('default', 'ap-northeast-2', 'i-abc'),
    ).resolves.toEqual({
      sessionId: 'ssm-sess-1',
      streamUrl: 'wss://ssmmessages.example/v1/data-channel/ssm-sess-1',
      tokenValue: 'token-1',
    });
    expect(send.mock.calls[0][0].input).toEqual({ Target: 'i-abc' });
  });

  it('fails when the StartSession response is missing stream details', async () => {
    const service = new AwsService() as unknown as {
      getSsmClient: ReturnType<typeof vi.fn>;
      startSsmShellSession: (
        profileName: string,
        region: string,
        instanceId: string,
      ) => Promise<{ sessionId: string; streamUrl: string; tokenValue: string }>;
    };

    service.getSsmClient = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({ SessionId: 'ssm-sess-1' }),
    });

    await expect(
      service.startSsmShellSession('default', 'ap-northeast-2', 'i-abc'),
    ).rejects.toThrow('SSM 세션 응답에 스트림 정보가 없습니다.');
  });
});

describe('AwsService.startSsmPortForwardSession', () => {
  it('includes localPortNumber for direct instance port forwarding', async () => {
    const service = new AwsService() as unknown as {
      getSsmClient: ReturnType<typeof vi.fn>;
      startSsmPortForwardSession: (input: {
        profileName: string;
        region: string;
        targetId: string;
        targetKind: string;
        targetPort: number;
        bindPort: number;
      }) => Promise<{ sessionId: string; streamUrl: string; tokenValue: string }>;
    };

    const send = vi.fn().mockResolvedValue({
      SessionId: 'ssm-forward-1',
      StreamUrl: 'wss://ssmmessages.example/v1/data-channel/ssm-forward-1',
      TokenValue: 'forward-token-1',
    });
    service.getSsmClient = vi.fn().mockReturnValue({ send });

    await service.startSsmPortForwardSession({
      profileName: 'default',
      region: 'ap-northeast-2',
      targetId: 'i-abc',
      targetKind: 'instance-port',
      targetPort: 22,
      bindPort: 0,
    });

    expect(send.mock.calls[0][0].input).toEqual({
      Target: 'i-abc',
      DocumentName: 'AWS-StartPortForwardingSession',
      Parameters: {
        portNumber: ['22'],
        localPortNumber: ['0'],
      },
    });
  });

  it('includes localPortNumber for remote-host forwarding', async () => {
    const service = new AwsService() as unknown as {
      getSsmClient: ReturnType<typeof vi.fn>;
      startSsmPortForwardSession: (input: {
        profileName: string;
        region: string;
        targetId: string;
        targetKind: string;
        targetPort: number;
        bindPort: number;
        remoteHost?: string;
      }) => Promise<{ sessionId: string; streamUrl: string; tokenValue: string }>;
    };

    const send = vi.fn().mockResolvedValue({
      SessionId: 'ssm-forward-2',
      StreamUrl: 'wss://ssmmessages.example/v1/data-channel/ssm-forward-2',
      TokenValue: 'forward-token-2',
    });
    service.getSsmClient = vi.fn().mockReturnValue({ send });

    await service.startSsmPortForwardSession({
      profileName: 'default',
      region: 'ap-northeast-2',
      targetId: 'i-abc',
      targetKind: 'remote-host',
      targetPort: 5432,
      bindPort: 15432,
      remoteHost: 'db.internal',
    });

    expect(send.mock.calls[0][0].input).toEqual({
      Target: 'i-abc',
      DocumentName: 'AWS-StartPortForwardingSessionToRemoteHost',
      Parameters: {
        portNumber: ['5432'],
        localPortNumber: ['15432'],
        host: ['db.internal'],
      },
    });
  });
});
