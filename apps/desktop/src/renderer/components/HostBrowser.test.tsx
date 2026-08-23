import { cloneElement } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildVisibleGroups,
  collectGroupPaths,
  filterHostsInGroupTree,
  getGroupDeleteDialogVariant,
  getHostTagsToggleLabel,
  isDirectHostChild,
  isGroupWithinPath,
  normalizeGroupPath
} from '@shared';
import type {
  ActivityLogRecord,
  GroupRecord,
  HostRecord,
  SecretMetadataRecord,
  SshHostRecord,
} from '@shared';
import {
  HostBrowser,
  getHostBrowserEmptyCalloutMessage,
  getHostBrowserVisibleImportMenuLabels,
  HOST_BROWSER_IMPORT_MENU_LABELS
} from './HostBrowser';
import { resolveResponsiveCardGridLayout } from '../lib/responsive-card-grid';
import {
  getHostNavigationStep,
  HOME_BROWSER_CARD_GAP_PX,
  HOME_BROWSER_HOST_CARD_MAX_WIDTH_PX,
  HOME_BROWSER_HOST_CARD_MIN_WIDTH_PX,
} from './host-browser/useHostBrowser';

const resizeObserverInstances: MockResizeObserver[] = [];

function getObservedWidth(element: Element): number {
  const width = Number((element as HTMLElement).dataset.testWidth ?? '0');
  return Number.isFinite(width) ? width : 0;
}

function createObservedRect(element: Element): DOMRectReadOnly {
  const width = getObservedWidth(element);
  return {
    width,
    height: 0,
    top: 0,
    right: width,
    bottom: 0,
    left: 0,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    }
  } as DOMRectReadOnly;
}

class MockResizeObserver {
  observedElements = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObserverInstances.push(this);
  }

  observe = (element: Element) => {
    this.observedElements.add(element);
    this.callback(
      [{ target: element, contentRect: createObservedRect(element) } as ResizeObserverEntry],
      this as unknown as ResizeObserver
    );
  };

  unobserve = (element: Element) => {
    this.observedElements.delete(element);
  };

  disconnect = () => {
    this.observedElements.clear();
  };

  notify(element: Element) {
    this.callback(
      [{ target: element, contentRect: createObservedRect(element) } as ResizeObserverEntry],
      this as unknown as ResizeObserver
    );
  }
}

function setObservedWidth(element: HTMLElement, width: number) {
  element.dataset.testWidth = String(width);
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => createObservedRect(element)
  });
}

function triggerResize(element: HTMLElement) {
  resizeObserverInstances.forEach((instance) => {
    if (instance.observedElements.has(element)) {
      instance.notify(element);
    }
  });
}

const groups: GroupRecord[] = [
  {
    id: 'group-1',
    name: 'Servers',
    path: 'Servers',
    parentPath: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'group-2',
    name: 'Nested',
    path: 'Servers/Nested',
    parentPath: 'Servers',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  }
];

const hosts: HostRecord[] = [
  {
    id: 'host-1',
    kind: 'ssh',
    label: 'App',
    hostname: 'app.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName: 'Servers',
    tags: ['app'],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'aws-1',
    kind: 'aws-ec2',
    label: 'AWS App',
    awsProfileId: 'profile-default',
    awsProfileName: 'default',
    awsRegion: 'ap-northeast-2',
    awsInstanceId: 'i-aws',
    awsAvailabilityZone: 'ap-northeast-2a',
    awsInstanceName: 'aws-app',
    awsPlatform: 'Linux/UNIX',
    awsPrivateIp: '10.0.0.10',
    awsState: 'running',
    awsSshUsername: null,
    awsSshPort: null,
    awsSshMetadataStatus: 'loading',
    awsSshMetadataError: null,
    groupName: 'Servers',
    tags: ['app'],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'host-2',
    kind: 'ssh',
    label: 'DB',
    hostname: 'db.example.com',
    port: 22,
    username: 'postgres',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName: 'Servers/Nested',
    tags: ['database'],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  }
];

// SFTP·tmux·컨테이너는 SSH 세션이 있어야 성립한다 — RDP 는 그 셋이 다 빠지는 종류라
// 컨텍스트 메뉴가 종류를 보고 거르는지 확인하는 데 쓴다. 기본 목록에는 넣지 않는다(호스트
// 개수를 세는 기존 테스트가 흔들린다).
const rdpHost: HostRecord = {
  id: 'host-rdp',
  kind: 'rdp',
  label: 'WinBox',
  hostname: 'win.example.com',
  port: 3389,
  groupName: 'Servers',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z'
};

const vncHost: HostRecord = {
  id: 'host-vnc',
  kind: 'vnc',
  label: 'Console',
  hostname: 'kvm.example.com',
  port: 5901,
  groupName: 'Servers',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z'
};

const keychainEntries: SecretMetadataRecord[] = [
  {
    secretRef: 'secret:host-1',
    label: 'App Secret',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    linkedHostCount: 1,
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    secretRef: 'secret:shared',
    label: 'Shared Secret',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    linkedHostCount: 2,
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
];

interface RenderBrowserOptions {
  desktopPlatform?: 'darwin' | 'win32' | 'linux' | 'unknown';
  groups?: GroupRecord[];
  hosts?: HostRecord[];
  keychainEntries?: SecretMetadataRecord[];
  currentGroupPath?: string | null;
  searchQuery?: string;
  hostViewMode?: 'grid' | 'list';
  selectedHostId?: string | null;
  active?: boolean;
  activityLogs?: ActivityLogRecord[];
  canSelectHost?: (hostId: string, options?: { reason?: 'click' | 'menu' }) => boolean;
  onClearHostSelection?: ReturnType<typeof vi.fn>;
  onSelectHost?: ReturnType<typeof vi.fn>;
  onDuplicateHosts?: ReturnType<typeof vi.fn>;
  onRemoveGroup?: ReturnType<typeof vi.fn>;
  onMoveGroup?: ReturnType<typeof vi.fn>;
  onReorderGroup?: ReturnType<typeof vi.fn>;
  onRenameGroup?: ReturnType<typeof vi.fn>;
  onMoveHostToGroup?: ReturnType<typeof vi.fn>;
  onRemoveHost?: ReturnType<typeof vi.fn>;
  onRemoveSecret?: ReturnType<typeof vi.fn>;
  onConnectHost?: ReturnType<typeof vi.fn>;
  onOpenHostInNewWindow?: ReturnType<typeof vi.fn>;
  onConnectHostTmux?: ReturnType<typeof vi.fn>;
  onOpenHostContainers?: ReturnType<typeof vi.fn>;
  onOpenSftp?: ReturnType<typeof vi.fn>;
  onActivateSftp?: ReturnType<typeof vi.fn>;
  onActivateContainers?: ReturnType<typeof vi.fn>;
  onOpenSettingsSection?: ReturnType<typeof vi.fn>;
  onQuickConnectSsh?: ReturnType<typeof vi.fn>;
  onSelectSection?: ReturnType<typeof vi.fn>;
  onNavigateGroup?: ReturnType<typeof vi.fn>;
  onHostViewModeChange?: ReturnType<typeof vi.fn>;
  onOpenLocalTerminal?: ReturnType<typeof vi.fn>;
  onCreateHost?: ReturnType<typeof vi.fn>;
  onOpenDolgateImport?: ReturnType<typeof vi.fn>;
  onOpenAwsImport?: ReturnType<typeof vi.fn>;
  onOpenOpenSshImport?: ReturnType<typeof vi.fn>;
  onOpenXshellImport?: ReturnType<typeof vi.fn>;
  onOpenTermiusImport?: ReturnType<typeof vi.fn>;
  onOpenWarpgateImport?: ReturnType<typeof vi.fn>;
  onExportHosts?: ReturnType<typeof vi.fn>;
}

function renderBrowser({
  desktopPlatform = 'win32',
  groups: groupsOverride = groups,
  hosts: hostsOverride = hosts,
  keychainEntries: keychainEntriesOverride = keychainEntries,
  currentGroupPath = null,
  searchQuery = '',
  hostViewMode = 'grid',
  selectedHostId = null,
  active = true,
  activityLogs = [],
  canSelectHost,
  onClearHostSelection = vi.fn(),
  onSelectHost = vi.fn(),
  onDuplicateHosts = vi.fn().mockResolvedValue(undefined),
  onRemoveGroup = vi.fn().mockResolvedValue(undefined),
  onMoveGroup = vi.fn().mockResolvedValue(undefined),
  onReorderGroup = vi.fn().mockResolvedValue(undefined),
  onRenameGroup = vi.fn().mockResolvedValue(undefined),
  onMoveHostToGroup = vi.fn().mockResolvedValue(undefined),
  onRemoveHost = vi.fn().mockResolvedValue(undefined),
  onRemoveSecret = vi.fn().mockResolvedValue(undefined),
  onConnectHost = vi.fn().mockResolvedValue(undefined),
  onOpenHostInNewWindow,
  onConnectHostTmux,
  onOpenHostContainers = vi.fn().mockResolvedValue(undefined),
  onOpenSftp,
  onActivateSftp = vi.fn(),
  onActivateContainers = vi.fn(),
  onOpenSettingsSection = vi.fn(),
  onQuickConnectSsh = vi.fn().mockResolvedValue(undefined),
  onSelectSection = vi.fn(),
  onNavigateGroup = vi.fn(),
  onHostViewModeChange = vi.fn(),
  onOpenLocalTerminal = vi.fn(),
  onCreateHost = vi.fn(),
  onOpenDolgateImport = vi.fn(),
  onOpenAwsImport = vi.fn(),
  onOpenOpenSshImport = vi.fn(),
  onOpenXshellImport = vi.fn(),
  onOpenTermiusImport = vi.fn(),
  onOpenWarpgateImport = vi.fn(),
  onExportHosts = vi.fn(),
}: RenderBrowserOptions = {}) {
  const element = (
    <HostBrowser
      desktopPlatform={desktopPlatform}
      hosts={hostsOverride}
      groups={groupsOverride}
      keychainEntries={keychainEntriesOverride}
      currentGroupPath={currentGroupPath}
      searchQuery={searchQuery}
      hostViewMode={hostViewMode}
      selectedHostId={selectedHostId}
      active={active}
      activityLogs={activityLogs}
      canSelectHost={canSelectHost}
      onSearchChange={vi.fn()}
      onHostViewModeChange={onHostViewModeChange}
      onOpenLocalTerminal={onOpenLocalTerminal}
      onCreateHost={onCreateHost}
      onOpenDolgateImport={onOpenDolgateImport}
      onOpenAwsImport={onOpenAwsImport}
      onOpenOpenSshImport={onOpenOpenSshImport}
      onOpenXshellImport={onOpenXshellImport}
      onOpenTermiusImport={onOpenTermiusImport}
      onOpenWarpgateImport={onOpenWarpgateImport}
      onCreateGroup={vi.fn().mockResolvedValue(undefined)}
      onRemoveGroup={onRemoveGroup}
      onMoveGroup={onMoveGroup}
      onReorderGroup={onReorderGroup}
      onRenameGroup={onRenameGroup}
      onNavigateGroup={onNavigateGroup}
      onClearHostSelection={onClearHostSelection}
      onSelectHost={onSelectHost}
      onEditHost={vi.fn()}
      onDuplicateHosts={onDuplicateHosts}
      onExportHosts={onExportHosts}
      onMoveHostToGroup={onMoveHostToGroup}
      onSetHostFavorite={vi.fn()}
      onRemoveHost={onRemoveHost}
      onRemoveSecret={onRemoveSecret}
      onConnectHost={onConnectHost}
      onOpenHostInNewWindow={onOpenHostInNewWindow}
      onConnectHostTmux={onConnectHostTmux}
      onOpenHostContainers={onOpenHostContainers}
      onOpenSftp={onOpenSftp}
      onActivateSftp={onActivateSftp}
      onActivateContainers={onActivateContainers}
      onOpenSettingsSection={onOpenSettingsSection}
      onQuickConnectSsh={onQuickConnectSsh}
      onSelectSection={onSelectSection}
    />
  );
  const view = render(element);
  return {
    ...view,
    /** 상위가 selectedHostId 만 바꿔 내려주는 경로(편집 대상 전환)를 흉내낸다. */
    rerenderSelectedHost: (nextHostId: string | null) =>
      view.rerender(cloneElement(element, { selectedHostId: nextHostId })),
  };
}

function createDataTransfer(): DataTransfer {
  const entries = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: (format?: string) => {
      if (format) {
        entries.delete(format);
      } else {
        entries.clear();
      }
    },
    getData: (format: string) => entries.get(format) ?? '',
    setData: (format: string, data: string) => {
      entries.set(format, data);
    },
    setDragImage: () => undefined,
  } as unknown as DataTransfer;
}

beforeEach(() => {
  resizeObserverInstances.length = 0;
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
});

afterEach(() => {
  resizeObserverInstances.length = 0;
  vi.unstubAllGlobals();
});

describe('HostBrowser helpers', () => {
  it.each([
    {
      kind: 'aws-ec2' as const,
      host: hosts.find((host) => host.id === 'aws-1')!,
      expectedProfileName: 'default',
    },
    {
      kind: 'aws-ecs' as const,
      host: {
        id: 'ecs-1',
        kind: 'aws-ecs' as const,
        label: 'AWS ECS',
        awsProfileId: 'profile-production',
        awsProfileName: 'production',
        awsRegion: 'ap-northeast-2',
        awsEcsClusterArn:
          'arn:aws:ecs:ap-northeast-2:123456789012:cluster/production',
        awsEcsClusterName: 'production',
        groupName: null,
        tags: [],
        terminalThemeId: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
      expectedProfileName: 'production',
    },
  ])('shows the configured profile in the $kind Overview', ({ host, expectedProfileName }) => {
    renderBrowser({
      groups: [],
      hosts: [host],
      selectedHostId: host.id,
    });

    const heading = screen.getByRole('heading', { name: 'Host Information' });
    const section = heading.parentElement?.parentElement;
    expect(section).not.toBeNull();
    const profileLabel = within(section as HTMLElement).getByText('Profile');
    expect(profileLabel).toBeInTheDocument();
    expect(profileLabel.parentElement).toHaveTextContent(expectedProfileName);
  });

  it('shows an unconfigured AWS profile explicitly in Overview', () => {
    const host = {
      ...(hosts.find((entry) => entry.id === 'aws-1') as Extract<
        HostRecord,
        { kind: 'aws-ec2' }
      >),
      awsProfileId: null,
      awsProfileName: '',
    };

    renderBrowser({ groups: [], hosts: [host], selectedHostId: host.id });

    const heading = screen.getByRole('heading', { name: 'Host Information' });
    const section = heading.parentElement?.parentElement;
    expect(within(section as HTMLElement).getByText('Not configured')).toBeInTheDocument();
  });

  it('normalizes group paths and checks membership within the current tree', () => {
    expect(normalizeGroupPath('  Servers // Nested  ')).toBe('Servers/Nested');
    expect(isGroupWithinPath('Servers/Nested', 'Servers')).toBe(true);
    expect(isGroupWithinPath('Other', 'Servers')).toBe(false);
  });

  it('collects ancestor group paths and builds only direct child group cards', () => {
    expect(collectGroupPaths(groups, hosts)).toEqual(['Servers', 'Servers/Nested']);

    expect(buildVisibleGroups(groups, hosts, null)).toEqual([
      {
        path: 'Servers',
        name: 'Servers',
        hostCount: 3
      }
    ]);

    expect(buildVisibleGroups(groups, hosts, 'Servers')).toEqual([
      {
        path: 'Servers/Nested',
        name: 'Nested',
        hostCount: 1
      }
    ]);
  });

  it('identifies only direct host children for the current group', () => {
    expect(isDirectHostChild(hosts[0].groupName ?? null, 'Servers')).toBe(true);
    expect(isDirectHostChild(hosts[2].groupName ?? null, 'Servers')).toBe(false);
    expect(isDirectHostChild(hosts[2].groupName ?? null, 'Servers/Nested')).toBe(true);
  });

  it('chooses the right delete dialog variant based on descendant counts', () => {
    expect(getGroupDeleteDialogVariant(0, 0)).toBe('simple');
    expect(getGroupDeleteDialogVariant(1, 0)).toBe('with-descendants');
    expect(getGroupDeleteDialogVariant(0, 2)).toBe('with-descendants');
  });

  it('shows subtree hosts when a parent group is selected', () => {
    expect(filterHostsInGroupTree(hosts, 'Servers').map((host) => host.label)).toEqual(['App', 'AWS App', 'DB']);
  });

  it('matches English host labels when the query was typed in the Korean keyboard layout', () => {
    const baseHost = hosts[0] as SshHostRecord;
    renderBrowser({
      hosts: [
        ...hosts,
        {
          ...baseHost,
          id: 'host-lime',
          label: 'Lime',
          hostname: 'lime.example.com',
          groupName: null,
          tags: []
        }
      ],
      searchQuery: 'ㅣㅑㅡㄷ'
    });

    expect(screen.getByText('Lime')).toBeInTheDocument();
  });

  it('matches Hangul host labels when the query was typed in the English keyboard layout', () => {
    const baseHost = hosts[0] as SshHostRecord;
    renderBrowser({
      hosts: [
        ...hosts,
        {
          ...baseHost,
          id: 'host-asan',
          label: '아산',
          hostname: 'asan.example.com',
          groupName: null,
          tags: []
        }
      ],
      searchQuery: 'dktks'
    });

    expect(screen.getByText('아산')).toBeInTheDocument();
  });

  it('opens the command palette from the host search field and runs navigation actions', () => {
    const onSelectSection = vi.fn();
    const onActivateSftp = vi.fn();
    renderBrowser({ onSelectSection, onActivateSftp });

    fireEvent.focus(screen.getByLabelText('Search hosts'));

    expect(screen.getByRole('listbox', { name: 'Command Palette' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /SFTP.*파일 전송/i }));
    expect(onActivateSftp).toHaveBeenCalledTimes(1);

    fireEvent.focus(screen.getByLabelText('Search hosts'));
    fireEvent.click(screen.getByRole('option', { name: /로그.*활동 기록/i }));
    expect(onSelectSection).toHaveBeenCalledWith('logs');
  });

  // 왼쪽 목록이 한 그룹으로 좁혀져 있는데 오른쪽 "최근 로그"가 전체를 늘어놓으면 같은 화면이
  // 서로 다른 범위를 말한다. 그룹 맥락이 있으면 로그도 그 그룹으로 좁힌다.
  const groupScopeLogs: ActivityLogRecord[] = [
    {
      id: 'log-app',
      level: 'info',
      category: 'session',
      kind: 'session-lifecycle',
      message: 'connected',
      metadata: { hostId: 'host-1' },
      createdAt: '2025-01-02T00:00:00.000Z',
    },
    {
      id: 'log-db',
      level: 'info',
      category: 'session',
      kind: 'session-lifecycle',
      message: 'connected',
      metadata: { hostId: 'host-2' },
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  ];

  it('scopes recent logs to the group being viewed', () => {
    renderBrowser({ currentGroupPath: 'Servers/Nested', activityLogs: groupScopeLogs });

    const recentLogs = within(screen.getByTestId('recent-logs'));
    expect(recentLogs.getByText('DB')).toBeInTheDocument();
    expect(recentLogs.queryByText('App')).not.toBeInTheDocument();
    // 어느 범위인지 제목에 남는다 — 목록이 짧아진 이유를 화면에서 알 수 있어야 한다.
    expect(screen.getByText(/최근 로그 · Nested/)).toBeInTheDocument();
  });

  // 트리에서 부모를 고르면 그 아래가 다 보이는 것과 같아야 한다.
  it('includes hosts from nested groups in the scoped recent logs', () => {
    renderBrowser({ currentGroupPath: 'Servers', activityLogs: groupScopeLogs });

    const recentLogs = within(screen.getByTestId('recent-logs'));
    expect(recentLogs.getByText('App')).toBeInTheDocument();
    expect(recentLogs.getByText('DB')).toBeInTheDocument();
  });

  // 섹션째 사라지면 "로그가 없다" 와 "이 그룹엔 없다" 를 구분할 수 없다.
  it('keeps the recent logs section with an empty note when the group has none', () => {
    renderBrowser({
      currentGroupPath: 'Servers/Nested',
      activityLogs: [groupScopeLogs[0]],
    });

    const recentLogs = within(screen.getByTestId('recent-logs'));
    expect(recentLogs.getByText('이 그룹에는 최근 로그가 없습니다.')).toBeInTheDocument();
    expect(recentLogs.queryByText('App')).not.toBeInTheDocument();
  });

  it('shows settings sections in the command palette', () => {
    const onOpenSettingsSection = vi.fn();
    renderBrowser({ searchQuery: 'credentials', onOpenSettingsSection });

    fireEvent.focus(screen.getByLabelText('Search hosts'));
    fireEvent.click(screen.getByRole('option', { name: /저장된 인증 정보/i }));

    expect(onOpenSettingsSection).toHaveBeenCalledWith('secrets');
  });

  it('uses recent activity logs for empty command palette host reconnect suggestions', () => {
    const onConnectHost = vi.fn().mockResolvedValue(undefined);
    renderBrowser({
      onConnectHost,
      activityLogs: [
        {
          id: 'log-old',
          level: 'info',
          category: 'session',
          kind: 'session-lifecycle',
          message: 'connected',
          metadata: { hostId: 'host-1' },
          createdAt: '2025-01-01T00:00:00.000Z',
        },
        {
          id: 'log-new',
          level: 'info',
          category: 'session',
          kind: 'session-lifecycle',
          message: 'connected',
          metadata: { hostId: 'host-2' },
          createdAt: '2025-01-02T00:00:00.000Z',
        },
      ],
    });

    const input = screen.getByLabelText('Search hosts');
    fireEvent.focus(input);

    const options = screen.getAllByRole('option').map((option) => option.textContent ?? '');
    expect(options.findIndex((text) => text.includes('DB 연결'))).toBeLessThan(
      options.findIndex((text) => text.includes('App 연결')),
    );
    expect(screen.queryByRole('option', { name: /DB SFTP/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: /DB 연결/i }));
    expect(onConnectHost).toHaveBeenCalledWith('host-2');
  });

  // 호스트를 고치면 audit 로그가 남고 그것도 metadata.hostId 를 갖는다 — 종류를 가리지 않으면
  // 이름만 바꿔도 "최근 접속"이 방금으로 올라가고 최근순 정렬이 뒤바뀐다.
  it('ignores host edit audit logs when ranking hosts by last connection', () => {
    const onConnectHost = vi.fn().mockResolvedValue(undefined);
    renderBrowser({
      onConnectHost,
      activityLogs: [
        {
          id: 'log-connect-host-2',
          level: 'info',
          category: 'session',
          kind: 'session-lifecycle',
          message: 'connected',
          metadata: { hostId: 'host-2' },
          createdAt: '2025-01-02T00:00:00.000Z',
        },
        {
          id: 'log-edit-host-1',
          level: 'info',
          category: 'audit',
          message: 'host updated',
          metadata: { hostId: 'host-1' },
          createdAt: '2025-06-01T00:00:00.000Z',
        },
      ],
    });

    const input = screen.getByLabelText('Search hosts');
    fireEvent.focus(input);

    // 재접속 제안은 접속한 적 있는 호스트만 담는다. host-2 만 세션 로그가 있으므로, 더 나중에
    // 수정된 host-1 이 목록에 끼면 편집을 접속으로 읽은 것이다.
    expect(screen.getByRole('option', { name: /DB 연결/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /App 연결/i })).not.toBeInTheDocument();
  });

  // 정렬·그룹에 따라 보이는 순서가 달라지므로 화면에 그려진 순서를 읽어 그 다음 항목을 기대한다.
  function visibleHostIdsInDom(): string[] {
    return Array.from(document.querySelectorAll('[data-host-id]')).map(
      (element) => element.getAttribute('data-host-id') ?? '',
    );
  }

  it('moves the selected host with the arrow keys', () => {
    const onSelectHost = vi.fn();
    renderBrowser({ onSelectHost, selectedHostId: 'host-1' });

    const ids = visibleHostIdsInDom();
    const index = ids.indexOf('host-1');
    expect(index).toBeGreaterThanOrEqual(0);
    const next = ids[index + 1];
    expect(next).toBeTruthy();

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(onSelectHost).toHaveBeenCalledWith(next);
  });

  it('stops at the ends instead of wrapping around', () => {
    const probe = renderBrowser({});
    const [first] = visibleHostIdsInDom();
    probe.unmount();

    const onSelectHost = vi.fn();
    renderBrowser({ onSelectHost, selectedHostId: first });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(onSelectHost).not.toHaveBeenCalled();
  });

  // 검색 입력에서는 팔레트가 화살표를 쓴다 — 여기서 선택까지 움직이면 두 곳이 동시에 반응한다.
  it('leaves the arrow keys to the command palette while typing a search', () => {
    const onSelectHost = vi.fn();
    renderBrowser({ onSelectHost, selectedHostId: 'host-1' });

    fireEvent.keyDown(screen.getByLabelText('Search hosts'), { key: 'ArrowDown' });
    expect(onSelectHost).not.toHaveBeenCalled();
  });

  // 격자에서 위아래는 한 칸이 아니라 한 줄만큼 움직인다. jsdom 은 폭을 재지 못해 열 수가 항상
  // 1 이므로, 열 수에 따른 계산은 여기서 직접 확인한다.
  it('moves by a full row in a multi-column grid', () => {
    expect(getHostNavigationStep('ArrowDown', 3)).toBe(3);
    expect(getHostNavigationStep('ArrowUp', 3)).toBe(-3);
    expect(getHostNavigationStep('ArrowRight', 3)).toBe(1);
    expect(getHostNavigationStep('ArrowLeft', 3)).toBe(-1);
    expect(getHostNavigationStep('Enter', 3)).toBeNull();
  });

  // 홈 셸은 세션 탭이 활성일 때도 마운트된 채 숨겨지기만 한다 — 그때 창 전역 화살표가
  // 살아 있으면 터미널을 쓰는 중에 보이지 않는 목록의 선택이 움직인다.
  it('ignores the arrow keys while the home shell is not the active view', () => {
    const onSelectHost = vi.fn();
    renderBrowser({ onSelectHost, selectedHostId: 'host-1', active: false });

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(onSelectHost).not.toHaveBeenCalled();
  });

  it('runs the first host palette result with Enter', () => {
    const onConnectHost = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ searchQuery: 'app', onConnectHost });

    const input = screen.getByLabelText('Search hosts');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onConnectHost).toHaveBeenCalledWith('host-1');
  });

  it('offers Quick Connect for ssh commands and passes parsed input', () => {
    const onQuickConnectSsh = vi.fn().mockResolvedValue(undefined);
    renderBrowser({
      searchQuery: 'ssh acme@192.168.0.13',
      onQuickConnectSsh,
    });

    const input = screen.getByLabelText('Search hosts');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onQuickConnectSsh).toHaveBeenCalledWith({
      username: 'acme',
      hostname: '192.168.0.13',
      port: 22,
    });
  });

  it('keeps tags hidden until the toggle is pressed', () => {
    expect(getHostTagsToggleLabel(false, 1)).toBe('Tags (1)');
    expect(getHostTagsToggleLabel(true, 1)).toBe('Hide tags');
  });

  it('describes host card state via data attributes instead of legacy class names', () => {
    const { container } = renderBrowser();

    const appCard = screen.getByText('App').closest('[data-host-card="true"]') as HTMLElement;
    expect(appCard.dataset.hostCardState).toBe('idle');

    fireEvent.click(appCard);
    expect(appCard.dataset.hostCardState).toBe('selected');

    // Tags now render inline on the card (no expand toggle).
    expect(within(appCard).getByText('app')).toBeInTheDocument();
  });

  it('renders the persisted list view mode when provided by settings', () => {
    const { container } = renderBrowser({ hostViewMode: 'list' });

    expect(screen.getByRole('button', { name: '목록 보기' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '격자 보기' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('row')).toBeInTheDocument();
    expect(container.querySelector('[data-host-grid="true"]')).toBeNull();
  });

  it('requests a settings update when the host layout toggle changes', () => {
    const onHostViewModeChange = vi.fn();
    renderBrowser({ onHostViewModeChange });

    fireEvent.click(screen.getByRole('button', { name: '목록 보기' }));

    expect(onHostViewModeChange).toHaveBeenCalledWith('list');
  });

  // Serial·RDP 는 가져오기가 아니라 새로 만들기라서 New Host 폼의 종류 셀렉터로 옮겼다.
  // 이 메뉴에 다시 생기면 입구가 또 갈라진다.
  it('defines import actions for the split-button menu in the expected order', () => {
    expect(HOST_BROWSER_IMPORT_MENU_LABELS).toEqual([
      'Import Dolgate',
      'Import OpenSSH',
      'Import from Termius',
      'Import from Xshell',
      'Import from Warpgate',
      'Import via AWS SSM'
    ]);
  });

  it('hides the Xshell import action outside Windows', () => {
    expect(getHostBrowserVisibleImportMenuLabels('win32')).toEqual([
      'Import Dolgate',
      'Import OpenSSH',
      'Import from Termius',
      'Import from Xshell',
      'Import from Warpgate',
      'Import via AWS SSM'
    ]);
    expect(getHostBrowserVisibleImportMenuLabels('darwin')).toEqual([
      'Import Dolgate',
      'Import OpenSSH',
      'Import from Termius',
      'Import from Warpgate',
      'Import via AWS SSM'
    ]);
  });

  it('points the empty-state copy at the New Host form instead of an import item', () => {
    expect(getHostBrowserEmptyCalloutMessage(0, '')).toBe('New Host로 첫 번째 호스트를 추가해보세요. 폼 맨 위에서 SSH·Serial·RDP·VNC를 고를 수 있습니다.');
    expect(getHostBrowserEmptyCalloutMessage(2, 'nas')).toBe('검색어를 지우거나 다른 호스트명으로 다시 찾아보세요.');
    expect(getHostBrowserEmptyCalloutMessage(2, '')).toBe('New Host로 호스트를 추가해보세요. 폼 맨 위에서 SSH·Serial·RDP·VNC를 고를 수 있습니다.');
  });

  it('prioritizes New Host while routing the Import primary action to OpenSSH import', () => {
    const onCreateHost = vi.fn();
    const onOpenOpenSshImport = vi.fn();
    renderBrowser({ onCreateHost, onOpenOpenSshImport });

    const newHostButton = screen.getByRole('button', { name: 'New Host' });
    const importButton = screen.getByRole('button', { name: 'Import' });

    expect(newHostButton.className).toContain('bg-[var(--accent-strong)]');
    expect(importButton.className).toContain('bg-[var(--surface-elevated)]');

    fireEvent.click(importButton);

    expect(onCreateHost).not.toHaveBeenCalled();
    expect(onOpenOpenSshImport).toHaveBeenCalledTimes(1);
  });

  it('no longer offers Serial or RDP as import menu items', () => {
    renderBrowser();

    fireEvent.click(screen.getByRole('button', { name: 'Open import menu' }));

    expect(
      screen.queryByRole('menuitem', { name: 'Import Serial' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Import RDP' }),
    ).not.toBeInTheDocument();
  });

  it('does not show AWS SSH metadata status on host cards (it lives in the edit form)', () => {
    renderBrowser();

    expect(screen.queryByText('SSH 설정 확인 중')).not.toBeInTheDocument();
  });

  it('shows the containers action in the host context menu and opens the host-scoped page', async () => {
    const onOpenHostContainers = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onOpenHostContainers });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;

    fireEvent.contextMenu(appCard);
    fireEvent.click(screen.getByRole('button', { name: '컨테이너' }));

    await waitFor(() => {
      expect(onOpenHostContainers).toHaveBeenCalledWith('host-1');
    });
  });

  it('shows the connect action in the host context menu and connects the selected host', async () => {
    const onConnectHost = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onConnectHost });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;

    fireEvent.contextMenu(appCard);
    fireEvent.click(screen.getByRole('button', { name: '연결' }));

    await waitFor(() => {
      expect(onConnectHost).toHaveBeenCalledWith('host-1');
    });
  });

  it('opens a single host in a new window from the context menu', async () => {
    const onOpenHostInNewWindow = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onOpenHostInNewWindow });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    fireEvent.contextMenu(appCard);
    fireEvent.click(screen.getByRole('button', { name: '새 창에서 연결' }));

    await waitFor(() => {
      expect(onOpenHostInNewWindow).toHaveBeenCalledWith('host-1');
    });
  });

  it('fills the host row width while staying within the configured maximum', async () => {
    const { container } = renderBrowser({
      currentGroupPath: 'Servers'
    });

    const hostGrid = container.querySelector('[data-host-grid="true"]') as HTMLElement;
    expect(hostGrid).toBeTruthy();

    setObservedWidth(hostGrid, 1200);
    triggerResize(hostGrid);

    const expectedLayout = resolveResponsiveCardGridLayout({
      containerWidth: 1200,
      itemCount: 3,
      minWidth: HOME_BROWSER_HOST_CARD_MIN_WIDTH_PX,
      maxWidth: HOME_BROWSER_HOST_CARD_MAX_WIDTH_PX,
      gap: HOME_BROWSER_CARD_GAP_PX,
    });

    await waitFor(() => {
      expect(hostGrid.style.gridTemplateColumns).toBe(expectedLayout.gridTemplateColumns);
      expect(hostGrid.style.justifyContent).toBe('');
    });
  });
});

describe('HostBrowser dialogs', () => {
  it('shows the Xshell import menu item only on Windows', () => {
    const firstRender = renderBrowser({ desktopPlatform: 'darwin' });

    fireEvent.click(screen.getByRole('button', { name: 'Open import menu' }));
    expect(screen.queryByRole('menuitem', { name: 'Import from Xshell' })).not.toBeInTheDocument();

    firstRender.unmount();

    renderBrowser({ desktopPlatform: 'win32' });

    fireEvent.click(screen.getByRole('button', { name: 'Open import menu' }));
    expect(screen.getByRole('menuitem', { name: 'Import from Xshell' })).toBeInTheDocument();
  });

  it('closes the create-group dialog when the backdrop is clicked', () => {
    const { container } = renderBrowser();

    fireEvent.click(screen.getByRole('button', { name: 'New Group' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    const backdrop = screen.getByTestId('host-browser-modal-backdrop');
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the group tree and navigates immediately when a group is clicked', () => {
    const onNavigateGroup = vi.fn();
    renderBrowser({ onNavigateGroup });

    const groupTree = screen.getByLabelText('Group tree');
    const treeQueries = within(groupTree);
    expect(groupTree).toBeInTheDocument();
    expect(treeQueries.getByRole('button', { name: /All Hosts/ })).toBeInTheDocument();
    expect(treeQueries.getByRole('button', { name: /Servers/ })).toBeInTheDocument();
    expect(treeQueries.getByRole('button', { name: /Nested/ })).toBeInTheDocument();

    fireEvent.click(treeQueries.getByRole('button', { name: /Nested/ }));

    expect(onNavigateGroup).toHaveBeenCalledWith('Servers/Nested');
  });

  it('deselects the group and returns to root when the selected group is clicked again', () => {
    const onNavigateGroup = vi.fn();
    renderBrowser({ onNavigateGroup });

    const getNested = () =>
      within(screen.getByLabelText('Group tree')).getByRole('button', { name: /Nested/ });

    // 1st click: navigate into the group.
    fireEvent.click(getNested());
    expect(onNavigateGroup).toHaveBeenLastCalledWith('Servers/Nested');

    // 2nd click on the now-selected group: deselect and return to root (host 재클릭 해제와 동일).
    fireEvent.click(getNested());
    expect(onNavigateGroup).toHaveBeenLastCalledWith(null);
  });

  it('keeps the root group selection tint-based without drag shadows', () => {
    renderBrowser();

    const rootButton = screen.getByRole('button', { name: /All Hosts/ });
    expect(rootButton.className).toContain('bg-[var(--selection-tint)]');
    expect(rootButton.className).toContain('border-[var(--selection-border)]');
    expect(rootButton.className).not.toContain('shadow-[0_0_0_2px');
  });

  it('moves a dragged group under another group row', async () => {
    const onMoveGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({
      groups: [
        ...groups,
        {
          id: 'group-3',
          name: 'Clients',
          path: 'Clients',
          parentPath: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ],
      onMoveGroup
    });

    const groupTree = within(screen.getByLabelText('Group tree'));
    const clientsRow = groupTree.getByRole('button', { name: /Clients/ });
    const serversRow = groupTree.getByRole('button', { name: /Servers/ });
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(clientsRow, { dataTransfer });
    fireEvent.dragOver(serversRow, { dataTransfer });
    fireEvent.drop(serversRow, { dataTransfer });

    await waitFor(() => {
      expect(onMoveGroup).toHaveBeenCalledWith('Clients', 'Servers');
    });
  });

  it('moves a dragged group to the root when dropped on All Groups', async () => {
    const onMoveGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onMoveGroup });

    const groupTree = within(screen.getByLabelText('Group tree'));
    const nestedRow = groupTree.getByRole('button', { name: /Nested/ });
    const rootRow = groupTree.getByRole('button', { name: /All Hosts/ });
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(nestedRow, { dataTransfer });
    fireEvent.dragOver(rootRow, { dataTransfer });
    fireEvent.drop(rootRow, { dataTransfer });

    await waitFor(() => {
      expect(onMoveGroup).toHaveBeenCalledWith('Servers/Nested', null);
    });
  });

  it('keeps group drop targets active even when dragover cannot read custom dataTransfer payloads', async () => {
    const onMoveGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({
      groups: [
        ...groups,
        {
          id: 'group-3',
          name: 'Clients',
          path: 'Clients',
          parentPath: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ],
      onMoveGroup
    });

    const groupTree = within(screen.getByLabelText('Group tree'));
    const clientsRow = groupTree.getByRole('button', { name: /Clients/ });
    const serversRow = groupTree.getByRole('button', { name: /Servers/ });
    const startDataTransfer = createDataTransfer();
    const emptyDataTransfer = createDataTransfer();

    fireEvent.dragStart(clientsRow, { dataTransfer: startDataTransfer });
    fireEvent.dragOver(serversRow, { dataTransfer: emptyDataTransfer });
    fireEvent.drop(serversRow, { dataTransfer: emptyDataTransfer });

    await waitFor(() => {
      expect(onMoveGroup).toHaveBeenCalledWith('Clients', 'Servers');
    });
  });

  it('does not move a group into one of its descendants', () => {
    const onMoveGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onMoveGroup });

    const groupTree = within(screen.getByLabelText('Group tree'));
    const serversRow = groupTree.getByRole('button', { name: /Servers/ });
    const nestedRow = groupTree.getByRole('button', { name: /Nested/ });
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(serversRow, { dataTransfer });
    fireEvent.dragOver(nestedRow, { dataTransfer });
    fireEvent.drop(nestedRow, { dataTransfer });

    expect(onMoveGroup).not.toHaveBeenCalled();
  });

  it('lets the user toggle subgroup rows with the disclosure and group double click', () => {
    renderBrowser();

    const groupTree = screen.getByLabelText('Group tree');
    const treeQueries = within(groupTree);
    const disclosure = treeQueries.getByRole('button', { name: 'Collapse subgroup' });
    const serversRow = treeQueries.getByRole('button', { name: /Servers/ });

    expect(treeQueries.getByRole('button', { name: /Nested/ })).toBeInTheDocument();

    fireEvent.click(disclosure);
    expect(treeQueries.queryByRole('button', { name: /Nested/ })).not.toBeInTheDocument();

    fireEvent.dblClick(serversRow);
    expect(treeQueries.getByRole('button', { name: /Nested/ })).toBeInTheDocument();

    fireEvent.dblClick(serversRow);
    expect(treeQueries.queryByRole('button', { name: /Nested/ })).not.toBeInTheDocument();

    fireEvent.click(treeQueries.getByRole('button', { name: 'Expand subgroup' }));
    expect(treeQueries.getByRole('button', { name: /Nested/ })).toBeInTheDocument();
  });

  it('keeps the groups area out of the main pane and shows the tree toggle instead', () => {
    const { container } = renderBrowser();

    expect(screen.getByLabelText('Group tree')).toBeInTheDocument();
    expect(container.querySelector('[data-group-grid="true"]')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Groups' })).not.toBeInTheDocument();
  });

  it('does not render a duplicate current group breadcrumb above the cards', () => {
    const { container } = renderBrowser({ currentGroupPath: 'Servers/Nested' });
    const content = screen.getByTestId('host-browser-content');

    expect(within(content).queryByText('All Groups')).not.toBeInTheDocument();
    expect(within(content).queryByText('Servers')).not.toBeInTheDocument();
    expect(within(content).queryByText('Nested')).not.toBeInTheDocument();
  });

  it('keeps ungrouped hosts only in the root view and does not add an Ungrouped tree node', () => {
    renderBrowser({
      hosts: [
        ...hosts,
        {
          id: 'host-3',
          kind: 'ssh',
          label: 'Ungrouped Host',
          hostname: 'ungrouped.example.com',
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
        }
      ]
    });

    expect(screen.getByText('Ungrouped Host')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Group tree')).queryByRole('button', { name: /^Ungrouped(?:\s|$)/ })).not.toBeInTheDocument();
  });

  it('keeps the group tree visible even when there are no groups', () => {
    renderBrowser({ groups: [], hosts: [] });

    expect(screen.getByLabelText('Group tree')).toBeInTheDocument();
    expect(screen.getByText('아직 만든 그룹이 없습니다.')).toBeInTheDocument();
  });

  it('prefills the rename dialog from the group context menu and saves the new name', async () => {
    const onRenameGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onRenameGroup });

    const nestedRow = within(screen.getByLabelText('Group tree')).getByRole('button', { name: /Nested/ });

    fireEvent.contextMenu(nestedRow);
    fireEvent.click(screen.getByRole('button', { name: '이름 변경' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const input = screen.getByPlaceholderText('Group name') as HTMLInputElement;
    expect(input.value).toBe('Nested');

    fireEvent.change(input, { target: { value: 'API' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename group' }));

    await waitFor(() => {
      expect(onRenameGroup).toHaveBeenCalledWith('Servers/Nested', 'API');
    });
  });

  it('uses only the dragged group when multiple groups are selected', async () => {
    const onMoveGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({
      groups: [
        ...groups,
        {
          id: 'group-3',
          name: 'Clients',
          path: 'Clients',
          parentPath: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ],
      onMoveGroup
    });

    const groupTree = within(screen.getByLabelText('Group tree'));
    const clientsRow = groupTree.getByRole('button', { name: /Clients/ });
    const serversRow = groupTree.getByRole('button', { name: /Servers/ });
    const nestedRow = groupTree.getByRole('button', { name: /Nested/ });
    const dataTransfer = createDataTransfer();

    fireEvent.click(serversRow, { ctrlKey: true });
    fireEvent.click(clientsRow, { ctrlKey: true });
    fireEvent.dragStart(clientsRow, { dataTransfer });
    fireEvent.dragOver(nestedRow, { dataTransfer });
    fireEvent.drop(nestedRow, { dataTransfer });

    await waitFor(() => {
      expect(onMoveGroup).toHaveBeenCalledWith('Clients', 'Servers/Nested');
    });
  });

  it('moves all selected hosts when dragging a selected host to a group', async () => {
    const onMoveHostToGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({
      groups: [
        ...groups,
        {
          id: 'group-3',
          name: 'Clients',
          path: 'Clients',
          parentPath: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ],
      onMoveHostToGroup
    });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;
    const clientsRow = within(screen.getByLabelText('Group tree')).getByRole('button', { name: /Clients/ });
    const dataTransfer = createDataTransfer();

    fireEvent.click(appCard);
    fireEvent.click(dbCard, { ctrlKey: true });
    fireEvent.dragStart(dbCard, { dataTransfer });
    fireEvent.dragOver(clientsRow, { dataTransfer });
    fireEvent.drop(clientsRow, { dataTransfer });

    await waitFor(() => {
      expect(onMoveHostToGroup).toHaveBeenCalledTimes(2);
    });
    expect(onMoveHostToGroup).toHaveBeenNthCalledWith(1, 'host-1', 'Clients');
    expect(onMoveHostToGroup).toHaveBeenNthCalledWith(2, 'host-2', 'Clients');
    expect(dataTransfer.getData('application/x-dolssh-host-ids')).toBe(
      JSON.stringify(['host-1', 'host-2']),
    );
  });

  it('moves only the dragged host when dragging an unselected host', async () => {
    const onMoveHostToGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({
      groups: [
        ...groups,
        {
          id: 'group-3',
          name: 'Clients',
          path: 'Clients',
          parentPath: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ],
      onMoveHostToGroup
    });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;
    const awsCard = screen.getByText('AWS App').closest('article') as HTMLElement;
    const clientsRow = within(screen.getByLabelText('Group tree')).getByRole('button', { name: /Clients/ });
    const dataTransfer = createDataTransfer();

    fireEvent.click(appCard);
    fireEvent.click(dbCard, { ctrlKey: true });
    fireEvent.dragStart(awsCard, { dataTransfer });
    fireEvent.dragOver(clientsRow, { dataTransfer });
    fireEvent.drop(clientsRow, { dataTransfer });

    await waitFor(() => {
      expect(onMoveHostToGroup).toHaveBeenCalledTimes(1);
    });
    expect(onMoveHostToGroup).toHaveBeenCalledWith('aws-1', 'Clients');
    expect(dataTransfer.getData('application/x-dolssh-host-ids')).toBe(
      JSON.stringify(['aws-1']),
    );
  });

  it('keeps multi-host drop targets active when dragover cannot read custom host payloads', async () => {
    const onMoveHostToGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({
      groups: [
        ...groups,
        {
          id: 'group-3',
          name: 'Clients',
          path: 'Clients',
          parentPath: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ],
      onMoveHostToGroup
    });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;
    const clientsRow = within(screen.getByLabelText('Group tree')).getByRole('button', { name: /Clients/ });
    const startDataTransfer = createDataTransfer();
    const emptyDataTransfer = createDataTransfer();

    fireEvent.click(appCard);
    fireEvent.click(dbCard, { ctrlKey: true });
    fireEvent.dragStart(appCard, { dataTransfer: startDataTransfer });
    fireEvent.dragOver(clientsRow, { dataTransfer: emptyDataTransfer });
    fireEvent.drop(clientsRow, { dataTransfer: emptyDataTransfer });

    await waitFor(() => {
      expect(onMoveHostToGroup).toHaveBeenCalledTimes(2);
    });
    expect(onMoveHostToGroup).toHaveBeenNthCalledWith(1, 'host-1', 'Clients');
    expect(onMoveHostToGroup).toHaveBeenNthCalledWith(2, 'host-2', 'Clients');
  });

  it('supports additive host selection and copies all selected hosts from the context menu', async () => {
    const onSelectHost = vi.fn();
    const onDuplicateHosts = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onSelectHost, onDuplicateHosts });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;

    fireEvent.click(appCard);
    fireEvent.click(dbCard, { ctrlKey: true });

    expect(onSelectHost).toHaveBeenCalledTimes(1);
    expect(appCard.dataset.hostCardState).toBe('selected');
    expect(dbCard.dataset.hostCardState).toBe('selected');

    fireEvent.contextMenu(appCard);
    fireEvent.click(screen.getByRole('button', { name: '복사 (2개)' }));

    expect(onDuplicateHosts).toHaveBeenCalledWith(['host-1', 'host-2']);
  });

  it('selects every visible host with Cmd/Ctrl+A', () => {
    renderBrowser();

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;

    fireEvent.keyDown(window, { key: 'a', metaKey: true });

    expect(appCard.dataset.hostCardState).toBe('selected');
    expect(dbCard.dataset.hostCardState).toBe('selected');
  });

  it('limits Cmd/Ctrl+A selection to the current filtered host list', () => {
    renderBrowser({ searchQuery: 'App' });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });

    expect(appCard.dataset.hostCardState).toBe('selected');
    expect(screen.queryByText('DB')).not.toBeInTheDocument();
  });

  it('preserves native Cmd/Ctrl+A behavior in inputs and open dialogs', () => {
    renderBrowser();

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const searchInput = screen.getByRole('textbox', { name: 'Search hosts' });
    fireEvent.keyDown(searchInput, { key: 'a', ctrlKey: true });
    expect(appCard.dataset.hostCardState).not.toBe('selected');

    fireEvent.click(screen.getByRole('button', { name: 'New Group' }));
    fireEvent.keyDown(window, { key: 'a', metaKey: true });
    expect(appCard.dataset.hostCardState).not.toBe('selected');
  });

  it('opens one export flow for all selected hosts from the context menu', () => {
    const onExportHosts = vi.fn();
    renderBrowser({ onExportHosts });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;
    fireEvent.click(appCard);
    fireEvent.click(dbCard, { ctrlKey: true });
    fireEvent.contextMenu(dbCard, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: '내보내기... (2개)' }));

    expect(onExportHosts).toHaveBeenCalledWith(['host-1', 'host-2']);
  });

  it('exports every host in a group subtree from the group context menu', () => {
    const onExportHosts = vi.fn();
    renderBrowser({ onExportHosts });

    const groupTree = within(screen.getByLabelText('Group tree'));
    fireEvent.contextMenu(groupTree.getByRole('button', { name: /Servers 3/ }));
    fireEvent.click(screen.getByRole('button', { name: '내보내기... (3개 호스트)' }));

    expect(onExportHosts).toHaveBeenCalledWith(['host-1', 'aws-1', 'host-2']);
  });

  it('disables group export when the group subtree has no hosts', () => {
    renderBrowser({
      groups: [
        ...groups,
        {
          id: 'group-empty',
          name: 'Empty',
          path: 'Empty',
          parentPath: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });

    const groupTree = within(screen.getByLabelText('Group tree'));
    fireEvent.contextMenu(groupTree.getByRole('button', { name: /Empty 0/ }));

    expect(screen.getByRole('button', { name: '내보내기... (0개 호스트)' })).toBeDisabled();
  });

  it('connects all selected hosts from the context menu in visible order', async () => {
    const onConnectHost = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onConnectHost });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;

    fireEvent.click(appCard);
    fireEvent.click(dbCard, { ctrlKey: true });

    fireEvent.contextMenu(appCard);
    fireEvent.click(screen.getByRole('button', { name: '연결 (2개)' }));

    await waitFor(() => {
      expect(onConnectHost).toHaveBeenCalledTimes(2);
    });
    expect(onConnectHost).toHaveBeenNthCalledWith(1, 'host-1');
    expect(onConnectHost).toHaveBeenNthCalledWith(2, 'host-2');
  });

  it('opens containers for all selected hosts from the context menu in visible order', async () => {
    const onOpenHostContainers = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onOpenHostContainers });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;

    fireEvent.click(appCard);
    fireEvent.click(dbCard, { ctrlKey: true });

    fireEvent.contextMenu(appCard);
    fireEvent.click(screen.getByRole('button', { name: '컨테이너 (2개)' }));

    await waitFor(() => {
      expect(onOpenHostContainers).toHaveBeenCalledTimes(2);
    });
    expect(onOpenHostContainers).toHaveBeenNthCalledWith(1, 'host-1');
    expect(onOpenHostContainers).toHaveBeenNthCalledWith(2, 'host-2');
  });

  it('connects all selected hosts with tmux from the context menu in visible order', async () => {
    const onConnectHostTmux = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onConnectHostTmux });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;

    fireEvent.click(appCard);
    fireEvent.click(dbCard, { ctrlKey: true });

    fireEvent.contextMenu(appCard);
    fireEvent.click(screen.getByRole('button', { name: 'tmux로 연결 (2개)' }));

    await waitFor(() => {
      expect(onConnectHostTmux).toHaveBeenCalledTimes(2);
    });
    expect(onConnectHostTmux).toHaveBeenNthCalledWith(1, 'host-1');
    expect(onConnectHostTmux).toHaveBeenNthCalledWith(2, 'host-2');
  });

  it('hides SSH-only actions from the context menu for an RDP host', () => {
    renderBrowser({
      hosts: [...hosts, rdpHost],
      onConnectHostTmux: vi.fn(),
      onOpenSftp: vi.fn(),
    });

    const rdpCard = screen.getByText('WinBox').closest('article') as HTMLElement;
    fireEvent.contextMenu(rdpCard);

    expect(screen.queryByRole('button', { name: 'SFTP 연결' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'tmux로 연결' })).toBeNull();
    expect(screen.queryByRole('button', { name: '컨테이너' })).toBeNull();

    // 종류를 가리지 않는 항목은 그대로 남아야 한다 — 메뉴 전체가 사라진 게 아니다.
    expect(screen.getByRole('button', { name: '연결' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '수정' })).toBeTruthy();
  });

  it('narrows a mixed selection to the hosts that support the action, and says how many', async () => {
    const onOpenHostContainers = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ hosts: [...hosts, rdpHost], onOpenHostContainers });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;
    const rdpCard = screen.getByText('WinBox').closest('article') as HTMLElement;

    fireEvent.click(appCard);
    fireEvent.click(dbCard, { ctrlKey: true });
    fireEvent.click(rdpCard, { ctrlKey: true });

    fireEvent.contextMenu(appCard);
    // 3대를 골랐지만 컨테이너가 되는 건 2대다 — 라벨이 그 2대를 말해 준다.
    fireEvent.click(screen.getByRole('button', { name: '컨테이너 (2개)' }));

    await waitFor(() => {
      expect(onOpenHostContainers).toHaveBeenCalledTimes(2);
    });
    expect(onOpenHostContainers).toHaveBeenNthCalledWith(1, 'host-1');
    expect(onOpenHostContainers).toHaveBeenNthCalledWith(2, 'host-2');
    expect(onOpenHostContainers).not.toHaveBeenCalledWith('host-rdp');
  });

  // SFTP 는 순회가 안 되니 대상이 1대로 좁혀질 때만 연다 — 고른 개수가 아니라 대상 개수가 기준이다.
  it('enables SFTP when a mixed selection narrows down to exactly one supported host', () => {
    const onOpenSftp = vi.fn();
    renderBrowser({ hosts: [...hosts, rdpHost], onOpenSftp });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const rdpCard = screen.getByText('WinBox').closest('article') as HTMLElement;

    fireEvent.click(appCard);
    fireEvent.click(rdpCard, { ctrlKey: true });

    fireEvent.contextMenu(appCard);
    fireEvent.click(screen.getByRole('button', { name: 'SFTP 연결' }));

    expect(onOpenSftp).toHaveBeenCalledWith('host-1');
  });

  it('disables SFTP when the selection has more than one supported host', () => {
    const onOpenSftp = vi.fn();
    renderBrowser({ hosts: [...hosts, rdpHost], onOpenSftp });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;

    fireEvent.click(appCard);
    fireEvent.click(dbCard, { ctrlKey: true });

    fireEvent.contextMenu(appCard);
    expect(screen.getByRole('button', { name: 'SFTP 연결' })).toBeDisabled();
  });

  it('supports shift range selection for hosts without changing the active drawer selection', () => {
    const onSelectHost = vi.fn();
    renderBrowser({ onSelectHost });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;

    fireEvent.click(appCard);
    fireEvent.click(dbCard, { shiftKey: true });

    expect(onSelectHost).toHaveBeenCalledTimes(1);
    expect(appCard.dataset.hostCardState).toBe('selected');
    expect(dbCard.dataset.hostCardState).toBe('selected');
  });

  it('keeps mixed host and group selections but scopes the context menu to the clicked type', () => {
    renderBrowser({
      groups: [
        ...groups,
        {
          id: 'group-3',
          name: 'Clients',
          path: 'Clients',
          parentPath: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ]
    });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const serversTreeItem = within(screen.getByLabelText('Group tree')).getByRole('button', { name: /Servers/ });

    fireEvent.click(appCard, { ctrlKey: true });
    fireEvent.click(serversTreeItem, { ctrlKey: true });

    expect(appCard.dataset.hostCardState).toBe('selected');
    expect(serversTreeItem.getAttribute('data-group-tree-state')).toBe('selected');

    fireEvent.contextMenu(serversTreeItem);

    expect(screen.queryByRole('button', { name: /복사/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /삭제/ })).toBeInTheDocument();
  });

  it('shows an in-app delete dialog for selected hosts instead of calling window.confirm', async () => {
    const onRemoveHost = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderBrowser({ onRemoveHost });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;

    fireEvent.click(appCard);
    fireEvent.click(dbCard, { ctrlKey: true });
    fireEvent.contextMenu(appCard);
    fireEvent.click(screen.getByRole('button', { name: /삭제/ }));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '삭제' }));

    await waitFor(() => {
      expect(onRemoveHost).toHaveBeenCalledTimes(2);
    });
  });

  // 원격 화면 호스트도 같은 자격증명 저장소를 쓴다. VNC 는 이 제안에서 빠져 있어서, 호스트를
  // 지워도 쓰는 데 없는 비밀번호가 키체인에 계속 남았다(판정하는 getHostSecretRef 가 vnc 를
  // 몰랐다). SSH 와 같은 화면·같은 경로여야 한다.
  it.each([
    ['RDP', rdpHost, 'WinBox', 'secret:host-rdp'],
    ['VNC', vncHost, 'Console', 'secret:host-vnc'],
  ] as const)(
    '%s 호스트를 지울 때도 남는 자격증명을 함께 지우자고 제안한다',
    async (_kind, host, cardLabel, secretRef) => {
      const onRemoveHost = vi.fn().mockResolvedValue(undefined);
      const onRemoveSecret = vi.fn().mockResolvedValue(undefined);

      renderBrowser({
        hosts: [...hosts, { ...host, secretRef } as HostRecord],
        keychainEntries: [
          ...keychainEntries,
          {
            secretRef,
            label: 'Remote screen password',
            hasPassword: true,
            hasPassphrase: false,
            hasManagedPrivateKey: false,
            hasCertificate: false,
            linkedHostCount: 1,
            updatedAt: '2025-01-01T00:00:00.000Z',
          },
        ],
        onRemoveHost,
        onRemoveSecret,
      });

      const card = screen.getByText(cardLabel).closest('article') as HTMLElement;
      fireEvent.click(card);
      fireEvent.contextMenu(card);
      fireEvent.click(screen.getByRole('button', { name: /삭제/ }));

      const checkbox = screen.getByRole('checkbox', {
        name: '더 이상 사용되지 않는 저장된 인증 정보 1개도 함께 삭제',
      });
      expect(checkbox).toBeChecked();

      fireEvent.click(screen.getByRole('button', { name: '삭제' }));

      await waitFor(() => expect(onRemoveHost).toHaveBeenCalledWith(host.id));
      await waitFor(() => expect(onRemoveSecret).toHaveBeenCalledWith(secretRef));
    },
  );

  it('offers to remove an unused local secret and keeps the checkbox enabled by default', async () => {
    const onRemoveHost = vi.fn().mockResolvedValue(undefined);
    const onRemoveSecret = vi.fn().mockResolvedValue(undefined);
    const hostsWithSecret: HostRecord[] = [
      {
        ...(hosts[0] as Extract<HostRecord, { kind: 'ssh' }>),
        secretRef: 'secret:host-1',
      },
      ...hosts.slice(1),
    ];

    renderBrowser({
      hosts: hostsWithSecret,
      onRemoveHost,
      onRemoveSecret,
    });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    fireEvent.click(appCard);
    fireEvent.contextMenu(appCard);
    fireEvent.click(screen.getByRole('button', { name: /삭제/ }));

    const checkbox = screen.getByRole('checkbox', {
      name: '더 이상 사용되지 않는 저장된 인증 정보 1개도 함께 삭제',
    });
    expect(checkbox).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '삭제' }));

    await waitFor(() => expect(onRemoveHost).toHaveBeenCalledWith('host-1'));
    await waitFor(() => expect(onRemoveSecret).toHaveBeenCalledWith('secret:host-1'));
  });

  // 편집 중에는 상위(HomeShell)가 "저장 안 된 변경" 을 물어본 뒤에 선택을 옮긴다. 상위가 막았는데
  // 목록 하이라이트만 움직이면, 편집을 닫았을 때 센터와 우측이 서로 다른 호스트를 가리킨다.
  it('leaves the highlight alone when the parent vetoes the selection', () => {
    const onSelectHost = vi.fn();
    renderBrowser({
      selectedHostId: 'host-1',
      onSelectHost,
      canSelectHost: () => false,
    });

    const card = (hostId: string) =>
      document.querySelector(`[data-host-id="${hostId}"]`) as HTMLElement;

    fireEvent.click(card('host-2'));

    expect(onSelectHost).not.toHaveBeenCalled();
    expect(card('host-2')).toHaveAttribute('data-host-card-state', 'idle');
    expect(card('host-1')).toHaveAttribute('data-host-card-state', 'selected');
  });

  // 상위가 직접 선택을 옮기는 경로(편집 대상 전환)가 있다. 그때 목록도 따라와야 한다.
  it('follows the selection the parent hands down', () => {
    const { rerenderSelectedHost } = renderBrowser({ selectedHostId: 'host-1' });
    const card = (hostId: string) =>
      document.querySelector(`[data-host-id="${hostId}"]`) as HTMLElement;
    expect(card('host-1')).toHaveAttribute('data-host-card-state', 'selected');

    rerenderSelectedHost('host-2');

    expect(card('host-2')).toHaveAttribute('data-host-card-state', 'selected');
    expect(card('host-1')).toHaveAttribute('data-host-card-state', 'idle');
  });

  // 파일 탐색기와 같은 규칙: 선택 안 된 항목을 우클릭하면 그 항목이 선택돼 보인다. 무엇에 걸리는
  // 메뉴인지 화면에서 알 수 있어야 한다.
  it('selects the right-clicked host and marks it as the menu target', () => {
    renderBrowser({ selectedHostId: 'host-1' });
    const card = (hostId: string) =>
      document.querySelector(`[data-host-id="${hostId}"]`) as HTMLElement;

    fireEvent.contextMenu(card('host-2'));

    expect(card('host-2')).toHaveAttribute('data-host-card-state', 'selected');
    expect(card('host-2')).toHaveAttribute('data-host-menu-target', 'true');
    expect(card('host-1')).not.toHaveAttribute('data-host-menu-target');
  });

  // 편집 중에는 상위가 메뉴발 선택을 거절한다(확인 창이 뜨면 메뉴 한 번 열려고 편집이 끊긴다).
  // 그때도 무엇에 걸리는지는 보여야 한다.
  it('keeps the selection but still marks the target when the parent refuses menu selection', () => {
    renderBrowser({
      selectedHostId: 'host-1',
      canSelectHost: (_hostId, options) => options?.reason !== 'menu',
    });
    const card = (hostId: string) =>
      document.querySelector(`[data-host-id="${hostId}"]`) as HTMLElement;

    fireEvent.contextMenu(card('host-2'));

    expect(card('host-2')).toHaveAttribute('data-host-card-state', 'idle');
    expect(card('host-1')).toHaveAttribute('data-host-card-state', 'selected');
    expect(card('host-2')).toHaveAttribute('data-host-menu-target', 'true');
  });
});
