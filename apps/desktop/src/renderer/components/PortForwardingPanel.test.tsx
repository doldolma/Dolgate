import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  resetPortForwardingPanelUiStateForTests,
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
    label: 'acme-ecs',
    awsProfileName: 'default',
    awsRegion: 'ap-northeast-2',
    awsEcsClusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/acme-ecs',
    awsEcsClusterName: 'acme-ecs',
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
  resetPortForwardingPanelUiStateForTests();
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function openContainerDialog() {
  fireEvent.click(screen.getByRole('tab', { name: '컨테이너' }));
  fireEvent.click(screen.getByRole('button', { name: '컨테이너 터널 추가' }));
}

function openEcsTaskDialog() {
  fireEvent.click(screen.getByRole('tab', { name: 'ECS Task' }));
  fireEvent.click(screen.getByRole('button', { name: 'ECS Task 터널 추가' }));
}

async function chooseContainerHost(optionName: RegExp | string) {
  fireEvent.click(screen.getByRole('button', { name: '호스트' }));
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
}

async function chooseContainerOption(optionName: RegExp | string) {
  fireEvent.click(screen.getByRole('button', { name: '컨테이너' }));
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
}

function renderPanel(options?: {
  onSave?: (ruleId: string | null, draft: PortForwardDraft) => Promise<void>;
  hosts?: HostRecord[];
  runtimes?: PortForwardRuntimeRecord[];
  rules?: PortForwardRuleRecord[];
  dnsOverrides?: DnsOverrideResolvedRecord[];
  onSetStaticDnsOverrideActive?: (overrideId: string, active: boolean) => Promise<void>;
  containerTabs?: any[];
  discoveryInteractiveAuth?: PendingContainersInteractiveAuth | null;
  interactiveAuth?: PendingPortForwardInteractiveAuth | null;
}) {
  const onSave = options?.onSave ?? vi.fn().mockResolvedValue(undefined);
  const onSaveDnsOverride = vi.fn().mockResolvedValue(undefined);
  const onSetStaticDnsOverrideActive =
    options?.onSetStaticDnsOverrideActive ?? vi.fn().mockResolvedValue(undefined);
  const onRemove = vi.fn().mockResolvedValue(undefined);
  const onRemoveDnsOverride = vi.fn().mockResolvedValue(undefined);
  const onStart = vi.fn().mockResolvedValue(undefined);
  const onStop = vi.fn().mockResolvedValue(undefined);
  const onClearInteractiveAuth = vi.fn();
  // 프로덕션과 같은 배치로 띄운다 — 목록 화면 하나와, 편집기를 그리는 인스턴스 하나
  // (실제로는 AppModals 의 PortForwardEditorHost). 화면 쪽 버튼은 스토어에 의도만 넣으므로,
  // 다이얼로그 인스턴스가 없으면 모달이 뜨지 않는다.
  const panelProps = {
    hosts: options?.hosts ?? hosts,
    containerTabs: options?.containerTabs ?? [],
    rules: options?.rules ?? rules,
    dnsOverrides: options?.dnsOverrides ?? dnsOverrides,
    runtimes: options?.runtimes ?? runtimes,
    interactiveAuth: options?.interactiveAuth ?? null,
    discoveryInteractiveAuth: options?.discoveryInteractiveAuth ?? null,
    onSave,
    onSaveDnsOverride,
    onSetStaticDnsOverrideActive,
    onRemove,
    onRemoveDnsOverride,
    onStart,
    onStop,
    onRespondInteractiveAuth: vi.fn().mockResolvedValue(undefined),
    onReopenInteractiveAuthUrl: vi.fn().mockResolvedValue(undefined),
    onClearInteractiveAuth,
  };
  const view = render(
    <>
      <PortForwardingPanel {...panelProps} />
      <PortForwardingPanel {...panelProps} variant="dialog" />
    </>
  );
  return {
    ...view,
    onSave,
    onSaveDnsOverride,
    onSetStaticDnsOverrideActive,
    onRemove,
    onRemoveDnsOverride,
    onStart,
    onStop,
    onClearInteractiveAuth
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
    expect(getAvailablePortForwardHosts(hosts, 'ecs-task').map((host) => host.label)).toEqual(['acme-ecs']);
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

    expect(screen.getByText('SSH 폴백')).toBeInTheDocument();
  });
});

describe('PortForwardingPanel dialog', () => {
  it('exposes an accessible close button for the dialog', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'SSH 포워딩 추가' }));

    fireEvent.click(screen.getByRole('button', { name: '포트 포워딩 창 닫기' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders SSH forwarding host selection as a searchable picker', async () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'SSH 포워딩 추가' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('combobox', { name: '호스트' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '호스트' }));

    await waitFor(() =>
      expect(within(dialog).getByLabelText('SSH forwarding host search')).toHaveFocus(),
    );
    expect(within(dialog).getByRole('listbox', { name: '호스트 옵션' })).toBeInTheDocument();
  });

  it('filters SSH forwarding hosts by label, hostname, username, group, and tags', () => {
    const searchableHosts: HostRecord[] = [
      hosts[0]!,
      {
        id: 'ssh-host-2',
        kind: 'ssh',
        label: 'Production API',
        hostname: 'api.internal',
        port: 22,
        username: 'deploy',
        authType: 'password',
        privateKeyPath: null,
        secretRef: null,
        groupName: 'platform',
        tags: ['blue'],
        terminalThemeId: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
      {
        id: 'ssh-host-3',
        kind: 'ssh',
        label: 'Database',
        hostname: 'db.internal',
        port: 2222,
        username: 'postgres',
        authType: 'password',
        privateKeyPath: null,
        secretRef: null,
        groupName: 'infra',
        tags: ['storage'],
        terminalThemeId: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
      {
        id: 'ssh-host-4',
        kind: 'ssh',
        label: 'Cache',
        hostname: 'cache.internal',
        port: 22,
        username: 'redis',
        authType: 'password',
        privateKeyPath: null,
        secretRef: null,
        groupName: 'data',
        tags: ['hot-path'],
        terminalThemeId: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ];

    renderPanel({ hosts: searchableHosts });

    fireEvent.click(screen.getByRole('button', { name: 'SSH 포워딩 추가' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '호스트' }));

    const searchInput = screen.getByLabelText('SSH forwarding host search');
    fireEvent.change(searchInput, { target: { value: 'deploy' } });
    let listbox = screen.getByRole('listbox', { name: '호스트 옵션' });
    expect(within(listbox).getByText('Production API')).toBeInTheDocument();
    expect(within(listbox).queryByText('Database')).not.toBeInTheDocument();
    expect(within(listbox).queryByText('Cache')).not.toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'infra' } });
    listbox = screen.getByRole('listbox', { name: '호스트 옵션' });
    expect(within(listbox).getByText('Database')).toBeInTheDocument();
    expect(within(listbox).queryByText('Production API')).not.toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'hot-path' } });
    listbox = screen.getByRole('listbox', { name: '호스트 옵션' });
    expect(within(listbox).getByText('Cache')).toBeInTheDocument();
    expect(within(listbox).queryByText('Database')).not.toBeInTheDocument();
  });

  it('selects a searched SSH host and preserves the saved hostId', async () => {
    const searchableHosts: HostRecord[] = [
      hosts[0]!,
      {
        id: 'ssh-host-2',
        kind: 'ssh',
        label: 'Database',
        hostname: 'db.internal',
        port: 2222,
        username: 'postgres',
        authType: 'password',
        privateKeyPath: null,
        secretRef: null,
        groupName: 'infra',
        tags: [],
        terminalThemeId: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderPanel({ hosts: searchableHosts, onSave });

    fireEvent.click(screen.getByRole('button', { name: 'SSH 포워딩 추가' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('이름'), { target: { value: 'DB tunnel' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '호스트' }));
    fireEvent.change(screen.getByLabelText('SSH forwarding host search'), { target: { value: 'database' } });
    fireEvent.pointerDown(within(screen.getByRole('listbox', { name: '호스트 옵션' })).getByText('Database'));

    expect(screen.queryByRole('listbox', { name: '호스트 옵션' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '호스트' })).toHaveTextContent('postgres@db.internal:2222');

    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          transport: 'ssh',
          label: 'DB tunnel',
          hostId: 'ssh-host-2',
        }),
      ),
    );
  });

  it('shows an empty SSH host search state', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'SSH 포워딩 추가' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '호스트' }));
    fireEvent.change(screen.getByLabelText('SSH forwarding host search'), {
      target: { value: 'missing-host' },
    });

    expect(screen.getByText('검색 결과가 없습니다.')).toBeInTheDocument();
  });

  it('shows the selected SSH host when editing an existing forwarding rule', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: '편집' }));

    const hostButton = within(screen.getByRole('dialog')).getByRole('button', { name: '호스트' });
    expect(hostButton).toHaveTextContent('SSH Host');
    expect(hostButton).toHaveTextContent('ubuntu@ssh.example.com:22');
  });

  // 세션 패널에서 편집하면 목록 카드를 볼 수 없어서, 삭제가 모달에 없으면 지울 방법이 없었다.
  it('deletes the rule being edited and closes the dialog', async () => {
    const view = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: '편집' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '삭제' }));

    await waitFor(() => expect(view.onRemove).toHaveBeenCalledWith('ssh-rule-1'));
    // 지운 것을 계속 편집하는 화면이 남으면 저장을 눌렀을 때 무엇이 되는지 알 수 없다.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  // 새로 만드는 중에는 지울 것이 없다.
  it('hides delete while creating a rule', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'SSH 포워딩 추가' }));

    expect(
      within(screen.getByRole('dialog')).queryByRole('button', { name: '삭제' }),
    ).not.toBeInTheDocument();
  });

  it('renders AWS EC2 forwarding host selection as a searchable picker', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'AWS EC2' }));
    fireEvent.click(screen.getByRole('button', { name: 'AWS EC2 포워딩 추가' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('combobox', { name: 'AWS EC2 호스트' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'AWS EC2 호스트' }));
    fireEvent.change(screen.getByLabelText('AWS EC2 forwarding host search'), {
      target: { value: 'i-123' },
    });

    const listbox = screen.getByRole('listbox', { name: 'AWS EC2 호스트 옵션' });
    expect(within(listbox).getByText('Bastion')).toBeInTheDocument();
    fireEvent.pointerDown(within(listbox).getByText('Bastion'));

    expect(screen.queryByRole('listbox', { name: 'AWS EC2 호스트 옵션' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'AWS EC2 호스트' })).toHaveTextContent(
      'default / ap-northeast-2 / i-123',
    );
  });

  it('renders ECS task forwarding host selection as a searchable picker', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'ECS Task' }));
    fireEvent.click(screen.getByRole('button', { name: 'ECS Task 터널 추가' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('combobox', { name: 'AWS ECS 호스트' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'AWS ECS 호스트' }));
    fireEvent.change(screen.getByLabelText('ECS task forwarding host search'), {
      target: { value: 'acme' },
    });

    const listbox = screen.getByRole('listbox', { name: 'AWS ECS 호스트 옵션' });
    expect(within(listbox).getByText('acme-ecs')).toBeInTheDocument();
  });

  it('filters container forwarding host picker options', () => {
    renderPanel();

    openContainerDialog();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '호스트' }));
    fireEvent.change(screen.getByLabelText('Container forwarding host search'), {
      target: { value: 'warp' },
    });

    const listbox = screen.getByRole('listbox', { name: '호스트 옵션' });
    expect(within(listbox).getAllByText('Warpgate').length).toBeGreaterThan(0);
    expect(within(listbox).queryByText('SSH Host')).not.toBeInTheDocument();
  });

  it('renames the AWS tab to AWS EC2 in the panel UI', () => {
    renderPanel();

    expect(screen.getByRole('tab', { name: 'AWS EC2' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'AWS SSM' })).not.toBeInTheDocument();
  });

  it('restores the last selected forwarding tab after the panel remounts', () => {
    const firstRender = renderPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'DNS Override' }));
    expect(screen.getByRole('tab', { name: 'DNS Override' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    firstRender.unmount();

    renderPanel();

    expect(screen.getByRole('tab', { name: 'DNS Override' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('normalizes single-label hostname when saving a DNS override', async () => {
    const { onSaveDnsOverride } = renderPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'DNS Override' }));
    fireEvent.click(screen.getByRole('button', { name: 'DNS Override 추가' }));

    fireEvent.change(screen.getByLabelText('호스트 이름'), {
      target: { value: 'Basket' }
    });
    fireEvent.change(screen.getByLabelText('연결할 규칙'), {
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

  it('shows a DNS error banner when static toggle fails', async () => {
    const onSetStaticDnsOverrideActive = vi
      .fn<(overrideId: string, active: boolean) => Promise<void>>()
      .mockRejectedValue(new Error('DNS Override 권한 승인이 취소되었습니다.'));

    renderPanel({
      dnsOverrides: [
        {
          id: 'dns-static-1',
          type: 'static',
          hostname: 'api.internal',
          address: '10.0.0.20',
          status: 'inactive',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      onSetStaticDnsOverrideActive,
    });

    fireEvent.click(screen.getByRole('tab', { name: 'DNS Override' }));
    fireEvent.click(screen.getByRole('button', { name: 'On' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'DNS Override 권한 승인이 취소되었습니다.',
    );
    expect(screen.getByRole('button', { name: 'On' })).toBeInTheDocument();
  });

  it('disables the active static toggle button while the request is pending', async () => {
    const deferred = createDeferred<void>();
    const onSetStaticDnsOverrideActive = vi
      .fn<(overrideId: string, active: boolean) => Promise<void>>()
      .mockReturnValue(deferred.promise);

    renderPanel({
      dnsOverrides: [
        {
          id: 'dns-static-1',
          type: 'static',
          hostname: 'api.internal',
          address: '10.0.0.20',
          status: 'inactive',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      onSetStaticDnsOverrideActive,
    });

    fireEvent.click(screen.getByRole('tab', { name: 'DNS Override' }));
    const toggleButton = screen.getByRole('button', { name: 'On' });
    fireEvent.click(toggleButton);

    await waitFor(() => expect(toggleButton).toBeDisabled());

    deferred.resolve();

    await waitFor(() => expect(toggleButton).not.toBeDisabled());
  });

  it('clears the DNS error banner after the next successful toggle', async () => {
    const onSetStaticDnsOverrideActive = vi
      .fn<(overrideId: string, active: boolean) => Promise<void>>()
      .mockRejectedValueOnce(new Error('DNS Override 권한 승인이 취소되었습니다.'))
      .mockResolvedValueOnce(undefined);

    renderPanel({
      dnsOverrides: [
        {
          id: 'dns-static-1',
          type: 'static',
          hostname: 'api.internal',
          address: '10.0.0.20',
          status: 'inactive',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      onSetStaticDnsOverrideActive,
    });

    fireEvent.click(screen.getByRole('tab', { name: 'DNS Override' }));
    const toggleButton = screen.getByRole('button', { name: 'On' });
    fireEvent.click(toggleButton);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'DNS Override 권한 승인이 취소되었습니다.',
    );

    fireEvent.click(toggleButton);

    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
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
          title: 'acme-ecs',
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
          logsRangeMode: 'recent',
          logsRelativeRange: {
            presetKey: '30m',
            amount: '30',
            unit: 'minute',
          },
          logsAbsoluteRange: null,
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
          ecsLogsByServiceName: {},
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
    expect(screen.getByText('저장된 규칙')).toBeInTheDocument();
    expect(screen.getByText('Ephemeral')).toBeInTheDocument();
    expect(screen.getByText('worker / api')).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:43110')).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:7001')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: '정지' })[0]!);

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
          logsRangeMode: 'recent',
          logsRelativeRange: {
            presetKey: '30m',
            amount: '30',
            unit: 'minute',
          },
          logsAbsoluteRange: null,
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
          ecsLogsByServiceName: {},
          ecsSelectedServiceName: null,
          ecsActivePanel: 'overview',
          ecsTunnelStatesByServiceName: {},
        },
      ],
    });

    fireEvent.click(screen.getByRole('tab', { name: '컨테이너' }));

    expect(screen.getByText('Running tunnels')).toBeInTheDocument();
    expect(screen.getByText('저장된 규칙')).toBeInTheDocument();
    expect(screen.getByText('Ephemeral')).toBeInTheDocument();
    expect(screen.getByText('bridge:8080')).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:43110')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: '정지' })[0]!);

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

    fireEvent.change(screen.getByLabelText('이름'), { target: { value: 'API tunnel' } });
    fireEvent.change(screen.getByLabelText('서비스'), { target: { value: 'api' } });

    await waitFor(() => {
      expect(awsApi.loadEcsTaskTunnelService).toHaveBeenCalledWith('ecs-host-1', 'api');
    });

    fireEvent.change(screen.getByLabelText('컨테이너'), { target: { value: 'web' } });
    fireEvent.click(screen.getByRole('switch', { name: '자동 (임의 포트)' }));
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

    fireEvent.change(screen.getByLabelText('이름'), { target: { value: 'API tunnel' } });
    fireEvent.change(screen.getByLabelText('서비스'), { target: { value: 'api' } });

    await waitFor(() => {
      expect(awsApi.loadEcsTaskTunnelService).toHaveBeenCalledWith('ecs-host-1', 'api');
    });

    fireEvent.change(screen.getByLabelText('컨테이너'), { target: { value: 'web' } });
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

    fireEvent.click(screen.getByRole('button', { name: 'SSH 포워딩 추가' }));

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

    fireEvent.click(screen.getByRole('button', { name: 'SSH 포워딩 추가' }));
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: 'My SSH Rule' } });
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: '저장' }),
    );

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

    fireEvent.change(screen.getByLabelText('이름'), { target: { value: 'Web tunnel' } });
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

    fireEvent.change(screen.getByLabelText('이름'), { target: { value: 'Jenkins tunnel' } });
    await chooseContainerOption(/jenkins-jenkins1.*정지됨/i);

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

    const hostPicker = screen.getByRole('button', { name: '호스트' });
    expect(screen.getByText('호스트 선택')).toBeInTheDocument();
    expect(hostPicker).toBeEnabled();

    await chooseContainerHost(/SSH Host/);

    await waitFor(() => {
      expect(containersApi.list).toHaveBeenCalledWith('ssh-host-1');
    });

    expect(screen.getByRole('button', { name: '호스트' })).toBeDisabled();

    deferred.resolve({
      runtime: 'docker',
      containers: [],
      unsupportedReason: null,
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '호스트' })).toBeEnabled();
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
      expect(screen.getByRole('button', { name: '호스트' })).toBeEnabled();
    });

    expect(screen.queryByText('컨테이너 탐색')).not.toBeInTheDocument();

    containerConnectionProgressListener?.({
      hostId: 'ssh-host-1',
      endpointId: 'containers:ssh-host-1',
      stage: 'connecting-containers',
      message: 'SSH Host 컨테이너 런타임 연결을 준비하는 중입니다.',
    });

    expect(screen.queryByText('컨테이너 탐색')).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: '컨테이너' }));

    expect(await screen.findByRole('option', { name: /vault.*vault:1\.16.*Running/i })).toBeInTheDocument();
  });

  it('toggles auto local port styling and disables manual input while active', async () => {
    renderPanel();

    openContainerDialog();

    const autoToggle = screen.getByRole('switch', { name: '자동 (임의 포트)' });
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

  it('취소는 그 포워딩을 멈추고 카드를 내린다', () => {
    const { onStop, onClearInteractiveAuth } = renderPanel({
      interactiveAuth: {
        source: 'portForward',
        endpointId: 'ssh-rule-1',
        ruleId: 'ssh-rule-1',
        hostId: 'ssh-host-1',
        challengeId: 'challenge-cancel-1',
        instruction: '',
        prompts: [{ label: 'Verification code:', echo: false }],
        provider: 'generic',
        autoSubmitted: false,
      },
    });

    // 어느 포워딩이 묻는지 제목이 말해야 한다.
    expect(
      screen.getByText('SSH Rule 포워딩이 추가 인증을 기다리는 중입니다.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '취소' }));

    // 규칙을 멈춘다 — 카드만 감추면 코어는 계속 답을 기다리고 규칙은 Starting 에 앉아 있다.
    expect(onStop).toHaveBeenCalledWith('ssh-rule-1');
    // 이 카드만 내린다(인자 없이 부르면 스토어가 다른 연결의 카드까지 비운다).
    expect(onClearInteractiveAuth).toHaveBeenCalledWith('challenge-cancel-1');
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

    expect(
      screen.getByText('Warpgate 포워딩이 추가 인증을 기다리는 중입니다.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/앱이 자동으로 다음 단계를 진행합니다/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Press Enter when done:')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('브라우저 다시 열기')).toBeInTheDocument();
    expect(screen.getByText('E870')).toBeInTheDocument();
  });
});
