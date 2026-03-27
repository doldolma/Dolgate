import { describe, expect, it, vi } from 'vitest';
import { AwsService, buildSshMetadataProbeCommands } from './aws-service';

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
      runResolvedCommand: ReturnType<typeof vi.fn>;
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
    service.runResolvedCommand = vi.fn().mockResolvedValue({
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
  });

  it('returns null configuredRegion when the profile has no default region', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      readConfigValue: ReturnType<typeof vi.fn>;
      runResolvedCommand: ReturnType<typeof vi.fn>;
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
    service.runResolvedCommand = vi.fn().mockResolvedValue({
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
