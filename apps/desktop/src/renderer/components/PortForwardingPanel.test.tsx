import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord, PortForwardDraft, PortForwardRuleRecord, PortForwardRuntimeRecord } from '@shared';
import type {
  PendingContainersInteractiveAuth,
  PendingPortForwardInteractiveAuth
} from '../store/createAppStore';
import { PortForwardingPanel, filterPortForwardRules, getAvailablePortForwardHosts, shouldShowAwsRemoteHostField } from './PortForwardingPanel';

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
  list: vi.fn().mockResolvedValue({ runtime: 'docker', containers: [], unsupportedReason: null }),
  inspect: vi.fn().mockResolvedValue(null),
};

beforeEach(() => {
  Object.defineProperty(window, 'dolssh', {
    configurable: true,
    writable: true,
    value: {
      containers: containersApi,
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
  discoveryInteractiveAuth?: PendingContainersInteractiveAuth | null;
  interactiveAuth?: PendingPortForwardInteractiveAuth | null;
}) {
  const onSave = options?.onSave ?? vi.fn().mockResolvedValue(undefined);
  const onRemove = vi.fn().mockResolvedValue(undefined);
  const onStart = vi.fn().mockResolvedValue(undefined);
  const onStop = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <PortForwardingPanel
      hosts={hosts}
      rules={rules}
      runtimes={options?.runtimes ?? runtimes}
      interactiveAuth={options?.interactiveAuth ?? null}
      discoveryInteractiveAuth={options?.discoveryInteractiveAuth ?? null}
      onSave={onSave}
      onRemove={onRemove}
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
    onRemove,
    onStart,
    onStop
  };
}

describe('PortForwardingPanel helpers', () => {
  it('filters rules by transport tab', () => {
    expect(filterPortForwardRules(rules, 'ssh').map((rule) => rule.label)).toEqual(['SSH Rule']);
    expect(filterPortForwardRules(rules, 'aws-ssm').map((rule) => rule.label)).toEqual(['AWS Rule']);
    expect(filterPortForwardRules(rules, 'container')).toEqual([]);
  });

  it('returns only matching hosts for each transport tab', () => {
    expect(getAvailablePortForwardHosts(hosts, 'ssh').map((host) => host.label)).toEqual(['SSH Host']);
    expect(getAvailablePortForwardHosts(hosts, 'aws-ssm').map((host) => host.label)).toEqual(['Bastion']);
    expect(getAvailablePortForwardHosts(hosts, 'container').map((host) => host.label)).toEqual(['SSH Host', 'Bastion', 'Warpgate']);
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

  it('closes when the backdrop is clicked while idle', async () => {
    const { container } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'New SSH Forward' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(container.querySelector('.modal-backdrop') as HTMLElement);

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

    fireEvent.click(container.querySelector('.modal-backdrop') as HTMLElement);

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
