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
