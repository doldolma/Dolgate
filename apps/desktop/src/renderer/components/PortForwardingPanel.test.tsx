import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DnsOverrideResolvedRecord, HostRecord, PortForwardDraft, PortForwardRuleRecord, PortForwardRuntimeRecord } from '@shared';
import type {
  PendingContainersInteractiveAuth,
  PendingPortForwardInteractiveAuth
} from '../store/createAppStore';
import {
  PortForwardingPanel,
  filterPortForwardRules,
  getAvailablePortForwardHosts,
  getDnsOverrideEligibleRules,
  shouldShowAwsRemoteHostField
} from './PortForwardingPanel';

const hosts: HostRecord[] = [
  {
    id: 'ssh-host-1',
    kind: 'ssh',
    label: 'SSH Host',
    hostname: 'ssh.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'aws-host-1',
    kind: 'aws-ec2',
    label: 'Bastion',
    awsProfileName: 'default',
    awsRegion: 'ap-northeast-2',
    awsInstanceId: 'i-123',
    awsInstanceName: 'bastion',
    awsPlatform: null,
    awsPrivateIp: '10.0.0.10',
    awsState: 'running',
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'warp-host-1',
    kind: 'warpgate-ssh',
    label: 'Warpgate',
    warpgateBaseUrl: 'https://warp.example.com',
    warpgateSshHost: 'warp.example.com',
    warpgateSshPort: 2222,
    warpgateTargetId: 'target-1',
    warpgateTargetName: 'nas',
    warpgateUsername: 'alice',
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'ecs-host-1',
    kind: 'aws-ecs',
    label: 'gridwiz-ecs',
    awsProfileName: 'default',
    awsRegion: 'ap-northeast-2',
    awsEcsClusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/gridwiz-ecs',
    awsEcsClusterName: 'gridwiz-ecs',
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  }
];

const rules: PortForwardRuleRecord[] = [
  {
    id: 'ssh-rule-1',
    transport: 'ssh',
    label: 'SSH Rule',
    hostId: 'ssh-host-1',
    mode: 'local',
    bindAddress: '127.0.0.1',
    bindPort: 9000,
    targetHost: '127.0.0.1',
    targetPort: 80,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'aws-rule-1',
    transport: 'aws-ssm',
    label: 'AWS Rule',
    hostId: 'aws-host-1',
    bindAddress: '127.0.0.1',
    bindPort: 15432,
    targetKind: 'remote-host',
    targetPort: 5432,
    remoteHost: 'db.internal',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  }
];

const dnsOverrides: DnsOverrideResolvedRecord[] = [];

const runtimes: PortForwardRuntimeRecord[] = [];
let containerConnectionProgressListener: ((event: {
  hostId: string;
  endpointId: string;
  stage: string;
  message: string;
}) => void) | null = null;

const containersApi = {
  onConnectionProgress: vi.fn((listener: (event: {
    hostId: string;
    endpointId: string;
    stage: string;
    message: string;
  }) => void) => {
    containerConnectionProgressListener = listener;
    return () => {
      if (containerConnectionProgressListener === listener) {
        containerConnectionProgressListener = null;
      }
    };
  }),
  release: vi.fn().mockResolvedValue(undefined),
  startTunnel: vi.fn().mockResolvedValue({
    ruleId: 'container-service-tunnel:1',
    hostId: 'ssh-host-1',
    transport: 'container',
    bindAddress: '127.0.0.1',
    bindPort: 43110,
    status: 'running',
    updatedAt: '2025-01-01T00:00:10.000Z',
    startedAt: '2025-01-01T00:00:05.000Z',
    mode: 'local',
    method: 'ssh-native',
  }),
  stopTunnel: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue({ runtime: 'docker', containers: [], unsupportedReason: null }),
  inspect: vi.fn().mockResolvedValue(null),
};

const awsApi = {
  listEcsTaskTunnelServices: vi.fn().mockResolvedValue([]),
  loadEcsTaskTunnelService: vi.fn().mockResolvedValue({
    serviceName: '',
    containers: [],
  }),
};

beforeEach(() => {
  Object.defineProperty(window, 'dolssh', {
    configurable: true,
    writable: true,
    value: {
      containers: containersApi,
      aws: awsApi,
      knownHosts: {
        probeHost: vi.fn().mockResolvedValue({ status: 'trusted' }),
        trust: vi.fn().mockResolvedValue(undefined),
        replace: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  containerConnectionProgressListener = null;
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function openContainerDialog() {
  fireEvent.click(screen.getByRole('tab', { name: 'Container' }));
  fireEvent.click(screen.getByRole('button', { name: 'New Container Tunnel' }));
}

function openEcsTaskDialog() {
  fireEvent.click(screen.getByRole('tab', { name: 'ECS Task' }));
  fireEvent.click(screen.getByRole('button', { name: 'New ECS Task Tunnel' }));
}

async function chooseContainerHost(optionName: RegExp | string) {
  fireEvent.click(screen.getByRole('button', { name: 'Host' }));
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
}

async function chooseContainerOption(optionName: RegExp | string) {
  fireEvent.click(screen.getByRole('button', { name: 'Container' }));
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
}

function renderPanel(options?: {
  onSave?: (ruleId: string | null, draft: PortForwardDraft) => Promise<void>;
  runtimes?: PortForwardRuntimeRecord[];
  rules?: PortForwardRuleRecord[];
  dnsOverrides?: DnsOverrideResolvedRecord[];
  containerTabs?: any[];
  discoveryInteractiveAuth?: PendingContainersInteractiveAuth | null;
  interactiveAuth?: PendingPortForwardInteractiveAuth | null;
}) {
  const onSave = options?.onSave ?? vi.fn().mockResolvedValue(undefined);
  const onSaveDnsOverride = vi.fn().mockResolvedValue(undefined);
  const onSetStaticDnsOverrideActive = vi.fn().mockResolvedValue(undefined);
  const onRemove = vi.fn().mockResolvedValue(undefined);
  const onRemoveDnsOverride = vi.fn().mockResolvedValue(undefined);
  const onStart = vi.fn().mockResolvedValue(undefined);
  const onStop = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <PortForwardingPanel
      hosts={hosts}
      containerTabs={options?.containerTabs ?? []}
      rules={options?.rules ?? rules}
      dnsOverrides={options?.dnsOverrides ?? dnsOverrides}
      runtimes={options?.runtimes ?? runtimes}
      interactiveAuth={options?.interactiveAuth ?? null}
      discoveryInteractiveAuth={options?.discoveryInteractiveAuth ?? null}
      onSave={onSave}
      onSaveDnsOverride={onSaveDnsOverride}
      onSetStaticDnsOverrideActive={onSetStaticDnsOverrideActive}
      onRemove={onRemove}
      onRemoveDnsOverride={onRemoveDnsOverride}
      onStart={onStart}
      onStop={onStop}
      onRespondInteractiveAuth={vi.fn().mockResolvedValue(undefined)}
      onReopenInteractiveAuthUrl={vi.fn().mockResolvedValue(undefined)}
      onClearInteractiveAuth={vi.fn()}
    />
  );

  return {
    ...view,
    onSave,
    onSaveDnsOverride,
    onSetStaticDnsOverrideActive,
    onRemove,
    onRemoveDnsOverride,
    onStart,
    onStop
  };
}

describe('PortForwardingPanel helpers', () => {
  it('filters rules by transport tab', () => {
    expect(filterPortForwardRules(rules, 'ssh').map((rule) => rule.label)).toEqual(['SSH Rule']);
    expect(filterPortForwardRules(rules, 'aws-ssm').map((rule) => rule.label)).toEqual(['AWS Rule']);
    expect(filterPortForwardRules(rules, 'ecs-task')).toEqual([]);
    expect(filterPortForwardRules(rules, 'container')).toEqual([]);
  });

  it('returns only matching hosts for each transport tab', () => {
    expect(getAvailablePortForwardHosts(hosts, 'ssh').map((host) => host.label)).toEqual(['SSH Host']);
    expect(getAvailablePortForwardHosts(hosts, 'aws-ssm').map((host) => host.label)).toEqual(['Bastion']);
    expect(getAvailablePortForwardHosts(hosts, 'ecs-task').map((host) => host.label)).toEqual(['gridwiz-ecs']);
    expect(getAvailablePortForwardHosts(hosts, 'container').map((host) => host.label)).toEqual(['SSH Host', 'Bastion', 'Warpgate']);
  });

  it('returns only loopback local rules for DNS overrides', () => {
    expect(
      getDnsOverrideEligibleRules([
        rules[0]!,
        rules[1]!,
        {
          id: 'ssh-rule-remote',
          transport: 'ssh',
          label: 'SSH Remote',
          hostId: 'ssh-host-1',
          mode: 'remote',
          bindAddress: '127.0.0.1',
          bindPort: 9200,
          targetHost: '127.0.0.1',
          targetPort: 22,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        },
        {
          id: 'aws-rule-public',
          transport: 'aws-ssm',
          label: 'AWS Public',
          hostId: 'aws-host-1',
          bindAddress: '0.0.0.0',
          bindPort: 15433,
          targetKind: 'instance-port',
          targetPort: 5432,
          remoteHost: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ]).map((rule) => rule.id)
    ).toEqual(['ssh-rule-1', 'aws-rule-1']);
  });

  it('shows the remote-host field only for AWS remote-host drafts', () => {
    const sshDraft: PortForwardDraft = {
      transport: 'ssh',
      label: 'SSH',
      hostId: 'ssh-host-1',
      mode: 'local',
      bindAddress: '127.0.0.1',
      bindPort: 9000,
      targetHost: '127.0.0.1',
      targetPort: 80
    };
    const awsDraft: PortForwardDraft = {
      transport: 'aws-ssm',
      label: 'AWS',
      hostId: 'aws-host-1',
      bindAddress: '127.0.0.1',
      bindPort: 9000,
      targetKind: 'remote-host',
      targetPort: 5432,
      remoteHost: 'db.internal'
    };

    expect(shouldShowAwsRemoteHostField(sshDraft)).toBe(false);
    expect(shouldShowAwsRemoteHostField(awsDraft)).toBe(true);
  });
});

describe('PortForwardingPanel runtime labels', () => {
  it('shows the resolved runtime method on the rule card', () => {
    renderPanel({
      runtimes: [
        {
          ruleId: 'ssh-rule-1',
          hostId: 'ssh-host-1',
          transport: 'ssh',
          mode: 'local',
          method: 'ssh-session-proxy',
          bindAddress: '127.0.0.1',
          bindPort: 49152,
          status: 'running',
          updatedAt: '2025-01-01T00:00:00.000Z',
          startedAt: '2025-01-01T00:00:00.000Z'
        }
      ]
    });

    expect(screen.getByText('SSH Fallback')).toBeInTheDocument();
  });
});

describe('PortForwardingPanel dialog', () => {
  it('exposes an accessible close button for the dialog', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'New SSH Forward' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close port forwarding dialog' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renames the AWS tab to AWS EC2 in the panel UI', () => {
    renderPanel();

    expect(screen.getByRole('tab', { name: 'AWS EC2' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'AWS SSM' })).not.toBeInTheDocument();
  });

  it('normalizes single-label hostname when saving a DNS override', async () => {
    const { onSaveDnsOverride } = renderPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'DNS Override' }));
    fireEvent.click(screen.getByRole('button', { name: 'New DNS Override' }));

    fireEvent.change(screen.getByLabelText('Hostname'), {
      target: { value: 'Basket' }
    });
    fireEvent.change(screen.getByLabelText('Linked rule'), {
      target: { value: 'aws-rule-1' }
    });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() =>
      expect(onSaveDnsOverride).toHaveBeenCalledWith(null, {
        type: 'linked',
        hostname: 'basket',
        portForwardRuleId: 'aws-rule-1'
      })
    );
  });

  it('renders and toggles static DNS overrides', () => {
    const { onSetStaticDnsOverrideActive } = renderPanel({
      dnsOverrides: [
        {
          id: 'dns-static-1',
          type: 'static',
          hostname: 'api.internal',
          address: '10.0.0.20',
          status: 'active',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });

    fireEvent.click(screen.getByRole('tab', { name: 'DNS Override' }));

    expect(screen.getByText('Static')).toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.20')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Off' }));

    expect(onSetStaticDnsOverrideActive).toHaveBeenCalledWith('dns-static-1', false);
  });

  it('shows ephemeral ECS service tunnels in the ECS Task tab', () => {
    const runtime: PortForwardRuntimeRecord = {
      ruleId: 'ecs-service-tunnel:1',
      hostId: 'ecs-host-1',
      transport: 'ecs-task',
      bindAddress: '127.0.0.1',
      bindPort: 43110,
      status: 'running',
      updatedAt: '2025-01-01T00:00:10.000Z',
      startedAt: '2025-01-01T00:00:00.000Z',
      mode: 'local',
      method: 'ssm-remote-host',
    };
    const { onStop } = renderPanel({
      rules: [
        ...rules,
        {
          id: 'ecs-rule-1',
          transport: 'ecs-task',
          label: 'Saved ECS tunnel',
          hostId: 'ecs-host-1',
          bindAddress: '127.0.0.1',
          bindPort: 0,
          serviceName: 'saved-service',
          containerName: 'saved-container',
          targetPort: 8080,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      runtimes: [runtime],
      containerTabs: [
        {
          kind: 'ecs-cluster',
          hostId: 'ecs-host-1',
          title: 'gridwiz-ecs',
          runtime: null,
          unsupportedReason: null,
          items: [],
          selectedContainerId: null,
          activePanel: 'overview',
          isLoading: false,
          details: null,
          detailsLoading: false,
          logs: null,
          logsState: 'tail',
          logsLoading: false,
          logsFollowEnabled: true,
          logsTailWindow: 200,
          logsSearchQuery: '',
          logsSearchMode: 'local',
          logsSearchLoading: false,
          logsSearchResult: null,
          metricsSamples: [],
          metricsState: 'live',
          metricsLoading: false,
          pendingAction: null,
          containerTunnelStatesByContainerId: {},
          ecsSnapshot: null,
          ecsMetricsWarning: null,
          ecsMetricsLoadedAt: null,
          ecsMetricsLoading: false,
          ecsUtilizationHistoryByServiceName: {},
          ecsSelectedServiceName: 'worker',
          ecsActivePanel: 'tunnel',
          ecsTunnelStatesByServiceName: {
            worker: {
              serviceName: 'worker',
              taskArn: 'arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1',
              containerName: 'api',
              targetPort: '7001',
              bindPort: '0',
              autoLocalPort: true,
              loading: false,
              error: null,
              runtime,
            },
          },
        },
      ],
    });

    fireEvent.click(screen.getByRole('tab', { name: 'ECS Task' }));

    expect(screen.getByText('Running tunnels')).toBeInTheDocument();
    expect(screen.getByText('Saved rules')).toBeInTheDocument();
    expect(screen.getByText('Ephemeral')).toBeInTheDocument();
    expect(screen.getByText('worker / api')).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:43110')).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:7001')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Stop' })[0]!);

    expect(onStop).toHaveBeenCalledWith('ecs-service-tunnel:1');
  });

  it('shows ephemeral container tunnels in the Container tab', () => {
    const runtime: PortForwardRuntimeRecord = {
      ruleId: 'container-service-tunnel:1',
      hostId: 'ssh-host-1',
      transport: 'container',
      bindAddress: '127.0.0.1',
      bindPort: 43110,
      status: 'running',
      updatedAt: '2025-01-01T00:00:10.000Z',
      startedAt: '2025-01-01T00:00:00.000Z',
      mode: 'local',
      method: 'ssh-native',
    };
    const { onStop } = renderPanel({
      rules: [
        ...rules,
        {
          id: 'container-rule-1',
          transport: 'container',
          label: 'Saved container tunnel',
          hostId: 'ssh-host-1',
          bindAddress: '127.0.0.1',
          bindPort: 0,
          containerId: 'saved-container',
          containerName: 'saved-api',
          containerRuntime: 'docker',
          networkName: 'bridge',
          targetPort: 9000,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      runtimes: [runtime],
      containerTabs: [
        {
          kind: 'host-containers',
          hostId: 'ssh-host-1',
          title: 'SSH Host',
          runtime: 'docker',
          unsupportedReason: null,
          items: [],
          selectedContainerId: 'container-1',
          activePanel: 'tunnel',
          isLoading: false,
          details: null,
          detailsLoading: false,
          logs: null,
          logsState: 'idle',
          logsLoading: false,
          logsFollowEnabled: false,
          logsTailWindow: 200,
          logsSearchQuery: '',
          logsSearchMode: null,
          logsSearchLoading: false,
          logsSearchResult: null,
          metricsSamples: [],
          metricsState: 'idle',
          metricsLoading: false,
          pendingAction: null,
          containerTunnelStatesByContainerId: {
            'container-1': {
              containerId: 'container-1',
              containerName: 'api',
              networkName: 'bridge',
              targetPort: '8080',
              bindPort: '0',
              autoLocalPort: true,
              loading: false,
              error: null,
              runtime,
            },
          },
          ecsSnapshot: null,
          ecsMetricsWarning: null,
          ecsMetricsLoadedAt: null,
          ecsMetricsLoading: false,
          ecsUtilizationHistoryByServiceName: {},
          ecsSelectedServiceName: null,
          ecsActivePanel: 'overview',
          ecsTunnelStatesByServiceName: {},
        },
      ],
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Container' }));

    expect(screen.getByText('Running tunnels')).toBeInTheDocument();
    expect(screen.getByText('Saved rules')).toBeInTheDocument();
    expect(screen.getByText('Ephemeral')).toBeInTheDocument();
    expect(screen.getByText('bridge:8080')).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:43110')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Stop' })[0]!);

    expect(onStop).toHaveBeenCalledWith('container-service-tunnel:1');
  });

  it('allows saving an ECS task tunnel rule', async () => {
    awsApi.listEcsTaskTunnelServices.mockResolvedValueOnce([
      {
        serviceName: 'api',
        status: 'ACTIVE',
        desiredCount: 1,
        runningCount: 1,
        pendingCount: 0,
      },
    ]);
    awsApi.loadEcsTaskTunnelService.mockResolvedValueOnce({
      serviceName: 'api',
      containers: [
        {
          containerName: 'web',
          ports: [{ port: 8080, protocol: 'tcp' }],
        },
      ],
    });

    const onSave = vi.fn().mockResolvedValue(undefined);
    renderPanel({ onSave });

    openEcsTaskDialog();

    await waitFor(() => {
      expect(awsApi.listEcsTaskTunnelServices).toHaveBeenCalledWith('ecs-host-1');
    });

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'API tunnel' } });
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'api' } });

    await waitFor(() => {
      expect(awsApi.loadEcsTaskTunnelService).toHaveBeenCalledWith('ecs-host-1', 'api');
    });

    fireEvent.change(screen.getByLabelText('Container'), { target: { value: 'web' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Auto (random)' }));
    fireEvent.change(screen.getByPlaceholderText('9000'), { target: { value: '18080' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          transport: 'ecs-task',
          label: 'API tunnel',
          hostId: 'ecs-host-1',
          serviceName: 'api',
          containerName: 'web',
          targetPort: 8080,
          bindAddress: '127.0.0.1',
          bindPort: 18080,
        }),
      );
    });
  });

  it('saves an ECS task tunnel rule with auto local port', async () => {
    awsApi.listEcsTaskTunnelServices.mockResolvedValueOnce([
      {
        serviceName: 'api',
        status: 'ACTIVE',
        desiredCount: 1,
        runningCount: 1,
        pendingCount: 0,
      },
    ]);
    awsApi.loadEcsTaskTunnelService.mockResolvedValueOnce({
      serviceName: 'api',
      containers: [
        {
          containerName: 'web',
          ports: [{ port: 8080, protocol: 'tcp' }],
        },
      ],
    });

    const onSave = vi.fn().mockResolvedValue(undefined);
    renderPanel({ onSave });

    openEcsTaskDialog();

    await waitFor(() => {
      expect(awsApi.listEcsTaskTunnelServices).toHaveBeenCalledWith('ecs-host-1');
    });

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'API tunnel' } });
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'api' } });

    await waitFor(() => {
      expect(awsApi.loadEcsTaskTunnelService).toHaveBeenCalledWith('ecs-host-1', 'api');
    });

    fireEvent.change(screen.getByLabelText('Container'), { target: { value: 'web' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          transport: 'ecs-task',
          label: 'API tunnel',
          hostId: 'ecs-host-1',
          serviceName: 'api',
          containerName: 'web',
          targetPort: 8080,
          bindAddress: '127.0.0.1',
          bindPort: 0,
        }),
      );
    });
  });

  it('closes when the backdrop is clicked while idle', async () => {
    const { container } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'New SSH Forward' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    const backdrop = container.querySelector('.modal-backdrop') as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('ignores backdrop clicks while a save is pending', async () => {
    const deferred = createDeferred<void>();
    const onSave = vi.fn().mockReturnValue(deferred.promise);
    const { container } = renderPanel({ onSave });

    fireEvent.click(screen.getByRole('button', { name: 'New SSH Forward' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'My SSH Rule' } });
    fireEvent.click(container.querySelector('.modal-card__footer .primary-button') as HTMLButtonElement);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    const backdrop = container.querySelector('.modal-backdrop') as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    deferred.resolve(undefined);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('saves a container forwarding rule with auto local port', async () => {
    containersApi.list.mockResolvedValueOnce({
      runtime: 'docker',
      containers: [
        {
          id: 'container-1',
          name: 'web',
          runtime: 'docker',
          image: 'nginx:latest',
          status: 'Up 1 hour',
          createdAt: '2025-01-01T00:00:00.000Z',
          ports: '80/tcp',
        },
      ],
      unsupportedReason: null,
    });
    containersApi.inspect.mockResolvedValueOnce({
      id: 'container-1',
      name: 'web',
      runtime: 'docker',
      image: 'nginx:latest',
      status: 'running',
      createdAt: '2025-01-01T00:00:00.000Z',
      command: 'nginx -g daemon off;',
      entrypoint: '/docker-entrypoint.sh',
      mounts: [],
      networks: [
        {
          name: 'bridge',
          ipAddress: '172.17.0.2',
        },
      ],
      ports: [
        {
          containerPort: 80,
          protocol: 'tcp',
          publishedBindings: [],
        },
      ],
      environment: [],
      labels: [],
    });

    const onSave = vi.fn().mockResolvedValue(undefined);
    renderPanel({ onSave });

    openContainerDialog();

    expect(containersApi.list).not.toHaveBeenCalled();
    await chooseContainerHost(/SSH Host/);

    await waitFor(() => {
      expect(containersApi.list).toHaveBeenCalledWith('ssh-host-1');
    });

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Web tunnel' } });
    await chooseContainerOption(/web.*Running/i);

    await waitFor(() => {
      expect(containersApi.inspect).toHaveBeenCalledWith('ssh-host-1', 'container-1');
    });

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('80');
    });

    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          transport: 'container',
          label: 'Web tunnel',
          hostId: 'ssh-host-1',
          containerId: 'container-1',
          containerName: 'web',
          containerRuntime: 'docker',
          networkName: 'bridge',
          targetPort: 80,
          bindAddress: '127.0.0.1',
          bindPort: 0,
        }),
      );
    });
  });

  it('allows saving a stopped container tunnel when the network name is known', async () => {
    containersApi.list.mockResolvedValueOnce({
      runtime: 'docker',
      containers: [
        {
          id: 'container-2',
          name: 'jenkins-jenkins1',
          runtime: 'docker',
          image: 'jenkins:latest',
          status: 'Exited (0) 5 minutes ago',
          createdAt: '2025-01-01T00:00:00.000Z',
          ports: '8080/tcp',
        },
      ],
      unsupportedReason: null,
    });
    containersApi.inspect.mockResolvedValueOnce({
      id: 'container-2',
      name: 'jenkins-jenkins1',
      runtime: 'docker',
      image: 'jenkins:latest',
      status: 'exited',
      createdAt: '2025-01-01T00:00:00.000Z',
      command: 'jenkins.sh',
      entrypoint: '/usr/bin/tini',
      mounts: [],
      networks: [
        {
          name: 'bridge',
          ipAddress: null,
          aliases: [],
        },
      ],
      ports: [
        {
          containerPort: 8080,
          protocol: 'tcp',
          publishedBindings: [],
        },
      ],
      environment: [],
      labels: [],
    });

    const onSave = vi.fn().mockResolvedValue(undefined);
    renderPanel({ onSave });

    openContainerDialog();
    await chooseContainerHost(/SSH Host/);

    await waitFor(() => {
      expect(containersApi.list).toHaveBeenCalledWith('ssh-host-1');
    });

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Jenkins tunnel' } });
    await chooseContainerOption(/jenkins-jenkins1.*Stopped/i);

    await waitFor(() => {
      expect(containersApi.inspect).toHaveBeenCalledWith('ssh-host-1', 'container-2');
    });

    expect(screen.getByText('현재는 네트워크 IP가 보이지 않습니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '저장' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          transport: 'container',
          label: 'Jenkins tunnel',
          hostId: 'ssh-host-1',
          containerId: 'container-2',
          containerName: 'jenkins-jenkins1',
          networkName: 'bridge',
          targetPort: 8080,
        }),
      );
    });
  });

  it('keeps the host select empty initially and disables it while loading containers', async () => {
    const deferred = createDeferred<{ runtime: 'docker'; containers: []; unsupportedReason: null }>();
    containersApi.list.mockReturnValueOnce(deferred.promise);

    renderPanel();

    openContainerDialog();

    const hostPicker = screen.getByRole('button', { name: 'Host' });
    expect(screen.getByText('Select host')).toBeInTheDocument();
    expect(hostPicker).toBeEnabled();

    await chooseContainerHost(/SSH Host/);

    await waitFor(() => {
      expect(containersApi.list).toHaveBeenCalledWith('ssh-host-1');
    });

    expect(screen.getByRole('button', { name: 'Host' })).toBeDisabled();

    deferred.resolve({
      runtime: 'docker',
      containers: [],
      unsupportedReason: null,
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Host' })).toBeEnabled();
    });
  });

  it('ignores stale discovery progress after the container list loads', async () => {
    const deferred = createDeferred<{
      runtime: 'docker';
      containers: Array<{
        id: string;
        name: string;
        runtime: 'docker';
        image: string;
        status: string;
        createdAt: string;
        ports: string;
      }>;
      unsupportedReason: null;
    }>();
    containersApi.list.mockReturnValueOnce(deferred.promise);

    renderPanel();

    openContainerDialog();
    await chooseContainerHost(/SSH Host/);

    await waitFor(() => {
      expect(containerConnectionProgressListener).not.toBeNull();
    });

    await waitFor(() => {
      expect(containersApi.list).toHaveBeenCalledWith('ssh-host-1');
    });

    deferred.resolve({
      runtime: 'docker',
      containers: [
        {
          id: 'container-1',
          name: 'web',
          runtime: 'docker',
          image: 'nginx:latest',
          status: 'Up 1 hour',
          createdAt: '2025-01-01T00:00:00.000Z',
          ports: '80/tcp',
        },
      ],
      unsupportedReason: null,
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Host' })).toBeEnabled();
    });

    expect(screen.queryByText('Container discovery')).not.toBeInTheDocument();

    containerConnectionProgressListener?.({
      hostId: 'ssh-host-1',
      endpointId: 'containers:ssh-host-1',
      stage: 'connecting-containers',
      message: 'SSH Host 컨테이너 런타임 연결을 준비하는 중입니다.',
    });

    expect(screen.queryByText('Container discovery')).not.toBeInTheDocument();
    expect(
      screen.queryByText('SSH Host 컨테이너 런타임 연결을 준비하는 중입니다.'),
    ).not.toBeInTheDocument();
  });

  it('renders container picker options with status badge and shortened image', async () => {
    containersApi.list.mockResolvedValueOnce({
      runtime: 'docker',
      containers: [
        {
          id: 'container-1',
          name: 'vault',
          runtime: 'docker',
          image: 'hashicorp/vault:1.16',
          status: 'Up 3 minutes',
          createdAt: '2025-01-01T00:00:00.000Z',
          ports: '8200/tcp',
        },
      ],
      unsupportedReason: null,
    });

    renderPanel();

    openContainerDialog();
    await chooseContainerHost(/SSH Host/);

    await waitFor(() => {
      expect(containersApi.list).toHaveBeenCalledWith('ssh-host-1');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Container' }));

    expect(await screen.findByRole('option', { name: /vault.*vault:1\.16.*Running/i })).toBeInTheDocument();
  });

  it('toggles auto local port styling and disables manual input while active', async () => {
    renderPanel();

    openContainerDialog();

    const autoToggle = screen.getByRole('switch', { name: 'Auto (random)' });
    const localPortInput = screen.getByPlaceholderText('자동 할당') as HTMLInputElement;

    expect(autoToggle).toHaveAttribute('aria-checked', 'true');
    expect(localPortInput).toBeDisabled();

    fireEvent.click(autoToggle);

    expect(autoToggle).toHaveAttribute('aria-checked', 'false');
    expect(localPortInput).toBeEnabled();
    expect(localPortInput).toHaveAttribute('placeholder', '9000');
  });

  it('shows discovery interactive auth at the panel level when starting a saved container tunnel', () => {
    renderPanel({
      discoveryInteractiveAuth: {
        source: 'containers',
        endpointId: 'containers:warp-host-1',
        hostId: 'warp-host-1',
        challengeId: 'challenge-1',
        name: 'warpgate',
        instruction: 'Open browser approval',
        prompts: [{ label: 'Verification code', echo: true }],
        provider: 'warpgate',
        approvalUrl: 'https://warp.example.com/authorize',
        authCode: 'ABCD-1234',
        autoSubmitted: false,
      },
    });

    expect(
      screen.getByText('컨테이너 런타임 연결 승인을 기다리는 중입니다.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Open browser approval')).toBeInTheDocument();
  });

  it('renders warpgate container tunnel auth without manual prompt inputs', () => {
    renderPanel({
      interactiveAuth: {
        source: 'portForward',
        endpointId: 'container-rule-1',
        ruleId: 'container-rule-1',
        hostId: 'warp-host-1',
        challengeId: 'challenge-portforward-1',
        name: 'warpgate',
        instruction:
          'Warpgate authentication: please open the following URL in your browser: https://warp.example.com/authorize Make sure you are seeing this security key: E 8 7 0',
        prompts: [{ label: 'Press Enter when done:', echo: true }],
        provider: 'warpgate',
        approvalUrl: 'https://warp.example.com/authorize',
        authCode: 'E870',
        autoSubmitted: true,
      },
    });

    expect(screen.getByText('Container tunnel 승인을 기다리는 중입니다.')).toBeInTheDocument();
    expect(screen.getByText(/앱이 자동으로 다음 단계를 진행합니다/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Press Enter when done:')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('브라우저 다시 열기')).toBeInTheDocument();
    expect(screen.getByText('E870')).toBeInTheDocument();
  });
});
