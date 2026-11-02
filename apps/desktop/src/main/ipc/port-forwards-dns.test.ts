import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcChannels } from '../../common/ipc-channels';
import { HostsOverrideError } from '../hosts-override-manager';
import { CredentialsNeededError } from './connect-credentials';
import { registerPortForwardAndDnsIpcHandlers } from './port-forwards-dns';
import { withVaults } from '../vault-catalog.test-support';

const electronSpies = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: electronSpies.ipcMainHandle,
  },
}));

describe('registerPortForwardAndDnsIpcHandlers', () => {
  beforeEach(() => {
    electronSpies.ipcMainHandle.mockReset();
  });

  it('logs and rethrows a user-facing error when static DNS activation fails', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const record = {
      id: 'dns-static-1',
      type: 'static',
      hostname: 'basket',
      address: '127.0.0.1',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    } as const;

    const setStaticOverrideActive = vi.fn();
    const appendActivityLog = vi.fn();

    registerPortForwardAndDnsIpcHandlers(withVaults({
      listPortForwardSnapshot: vi.fn(() => ({ rules: [], runtimes: [] })),
      listResolvedDnsOverrides: vi.fn(() => []),
      rewriteActiveDnsOverrides: vi.fn(async () => {
        throw new HostsOverrideError(
          'helper-rpc',
          'DNS Override를 적용하지 못했습니다. Dolgate DNS Helper가 요청을 처리하지 못했습니다.',
          'helper rpc failed',
        );
      }),
      dnsOverrides: {
        getById: vi.fn(() => record),
      },
      hostsOverrideManager: {
        getActiveStaticOverrideIds: vi.fn(() => new Set<string>()),
        setStaticOverrideActive,
      },
      activityLogs: {
        append: appendActivityLog,
      },
      queueSync: vi.fn(),
    }) as any);

    const handler = handlers.get(ipcChannels.dnsOverrides.setStaticActive);
    expect(handler).toBeTypeOf('function');
    if (!handler) {
      throw new Error('expected static dns override handler to be registered');
    }

    await expect(handler({}, 'dns-static-1', true)).rejects.toThrow(
      'DNS Override를 적용하지 못했습니다. Dolgate DNS Helper가 요청을 처리하지 못했습니다.',
    );

    expect(setStaticOverrideActive).toHaveBeenNthCalledWith(1, 'dns-static-1', true);
    expect(setStaticOverrideActive).toHaveBeenNthCalledWith(2, 'dns-static-1', false);
    expect(appendActivityLog).toHaveBeenCalledWith(
      'error',
      'audit',
      'DNS Override를 적용하지 못했습니다. Dolgate DNS Helper가 요청을 처리하지 못했습니다.',
      expect.objectContaining({
        dnsOverrideId: 'dns-static-1',
        hostname: 'basket',
        address: '127.0.0.1',
        active: true,
        stage: 'helper-rpc',
        rawError: 'helper rpc failed',
      }),
    );
  });

  it('includes the raw helper-not-ready cause in the user-facing error', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const record = {
      id: 'dns-static-1',
      type: 'static',
      hostname: 'basket',
      address: '127.0.0.1',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    } as const;

    registerPortForwardAndDnsIpcHandlers(withVaults({
      listPortForwardSnapshot: vi.fn(() => ({ rules: [], runtimes: [] })),
      listResolvedDnsOverrides: vi.fn(() => []),
      rewriteActiveDnsOverrides: vi.fn(async () => {
        throw new HostsOverrideError(
          'helper-not-ready',
          'Dolgate DNS Helper가 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.',
          'connect: permission denied',
        );
      }),
      dnsOverrides: {
        getById: vi.fn(() => record),
      },
      hostsOverrideManager: {
        getActiveStaticOverrideIds: vi.fn(() => new Set<string>()),
        setStaticOverrideActive: vi.fn(),
      },
      activityLogs: {
        append: vi.fn(),
      },
      queueSync: vi.fn(),
    }) as any);

    const handler = handlers.get(ipcChannels.dnsOverrides.setStaticActive);
    expect(handler).toBeTypeOf('function');
    if (!handler) {
      throw new Error('expected static dns override handler to be registered');
    }

    await expect(handler({}, 'dns-static-1', true)).rejects.toThrow(
      'Dolgate DNS Helper가 준비되지 않았습니다. 잠시 후 다시 시도해 주세요. 원인: connect: permission denied',
    );
  });

  it('routes a server-proxy AWS EC2 port forward through SSH -L over the WS relay', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const awsHost = {
      id: 'aws-1',
      kind: 'aws-ec2',
      label: 'Prod EC2',
      awsProfileId: null,
      awsProfileName: 'prod',
      awsRegion: 'ap-northeast-2',
      awsInstanceId: 'i-123',
      awsAvailabilityZone: 'ap-northeast-2a',
      awsSshUsername: 'ubuntu',
      awsSshPort: 22,
      awsSsmServerProxyEnabled: true,
    };
    const rule = {
      id: 'rule-1',
      hostId: 'aws-1',
      transport: 'aws-ssm',
      targetKind: 'instance-port',
      targetPort: 8080,
      bindAddress: '127.0.0.1',
      bindPort: 18080,
    };
    const startPortForward = vi
      .fn()
      .mockResolvedValue({ ruleId: 'rule-1', status: 'running' });
    const startSsmPortForward = vi.fn();

    registerPortForwardAndDnsIpcHandlers(withVaults({
      portForwards: { getById: vi.fn(() => rule) },
      hosts: { getById: vi.fn(() => awsHost) },
      assertAwsEc2Host: vi.fn(),
      awsService: {
        requireManagedProfileName: vi.fn((_id, name) => name),
        getProfileStatus: vi
          .fn()
          .mockResolvedValue({ isAuthenticated: true, isSsoProfile: false }),
        isManagedInstance: vi.fn().mockResolvedValue(true),
        buildServerProxySessionEnvSpec: vi
          .fn()
          .mockResolvedValue({ env: { AWS_ACCESS_KEY_ID: 'AKIA' }, unsetEnv: [] }),
      },
      authService: {
        getServerUrl: vi.fn(() => 'https://sync.example.com'),
        getAccessToken: vi.fn(() => 'token-1'),
        refreshSession: vi.fn().mockResolvedValue({ status: 'authenticated' }),
      },
      resolveAwsSftpPreflight: vi.fn().mockResolvedValue(awsHost),
      requireTrustedHostKeys: vi.fn(() => ['trusted']),
      resolveTrustedHostKeys: vi.fn(() => ['trusted']),
      createEphemeralAwsSftpKeyPair: vi.fn(() => ({
        privateKeyPem: 'priv',
        publicKey: 'pub',
      })),
      coreManager: {
        setPortForwardRuntime: vi.fn(),
        listPortForwardRuntimes: vi.fn(() => []),
        startPortForward,
        startSsmPortForward,
      },
      rewriteActiveDnsOverrides: vi.fn().mockResolvedValue(undefined),
    }) as any);

    const handler = handlers.get(ipcChannels.portForwards.start);
    expect(handler).toBeTypeOf('function');
    await handler?.({}, 'rule-1');

    // 서버 프록시: 네이티브 SSM 포워드가 아니라 WS 릴레이 위 SSH -L로 붙는다.
    expect(startSsmPortForward).not.toHaveBeenCalled();
    expect(startPortForward).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: 'rule-1',
        host: 'i-123',
        port: 22,
        username: 'ubuntu',
        authType: 'privateKey',
        targetHost: 'localhost',
        targetPort: 8080,
        transport: 'aws-ssm',
        wsProxy: expect.objectContaining({
          url: expect.stringContaining('/api/aws-ssh-tunnel/ws'),
          authToken: 'token-1',
        }),
      }),
    );
  });

  // 다듬기 2단계 — 포트 포워딩도 SSH 터미널·SFTP 처럼 비밀번호가 빠진 홉을 묻고, 넣은 값으로 붙고, 붙은 뒤 저장한다.
  // 전에는 코어가 붙기 전에 "jump host: password auth requires a password" 원문으로 멈췄다.
  describe('asks for a missing password like the SSH terminal', () => {
    const bastion = { id: 'bastion', kind: 'ssh', label: 'Bastion', hostname: '127.0.0.1', port: 22251, username: 'tester', authType: 'password' };
    const target = { id: 'target', kind: 'ssh', label: 'Target', hostname: 'tpol-target', port: 22, username: 'tester', authType: 'password', jumpHostIds: ['bastion'] };
    const rule = { id: 'rule-1', hostId: 'target', transport: 'ssh', mode: 'local', bindAddress: '127.0.0.1', bindPort: 18411, targetHost: '127.0.0.1', targetPort: 22 };

    /** stored 에 든 호스트는 저장된 비밀번호가 있다. 이번에 넣은 값이 있으면 그것이 먼저다. */
    function setup(
      options: {
        rule?: Record<string, unknown>;
        stored?: Record<string, string>;
        startPortForward?: ReturnType<typeof vi.fn>;
        startContainerTunnelRuntime?: ReturnType<typeof vi.fn>;
      } = {},
    ) {
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
        handlers.set(channel, handler);
      });
      const stored = options.stored ?? {};
      const hosts = [bastion, target];
      const startPortForward = options.startPortForward ?? vi.fn().mockResolvedValue({ ruleId: 'rule-1', status: 'running' });
      const persistHostSpecificSecret = vi.fn(async () => 'ref');
      const theRule = options.rule ?? rule;
      registerPortForwardAndDnsIpcHandlers(withVaults({
        portForwards: { getById: vi.fn(() => theRule), list: vi.fn(() => [theRule]) },
        hosts: { getById: vi.fn((id: string) => hosts.find((host) => host.id === id) ?? null), list: vi.fn(() => hosts) },
        assertSshHost: vi.fn(),
        assertSftpCompatibleHost: vi.fn(),
        startContainerTunnelRuntime: options.startContainerTunnelRuntime ?? vi.fn(),
        resolveTrustedHostKeys: vi.fn(() => ['trusted']),
        resolveSshAuth: vi.fn(async (host: { id: string; username: string; authType: string }, provided?: { password?: string; username?: string }) => ({
          username: provided?.username ?? host.username,
          authType: host.authType,
          secrets: provided?.password ? { password: provided.password } : stored[host.id] ? { password: stored[host.id] } : {},
          shouldPersistHostSecret: Boolean(provided?.password),
          typedUsername: provided?.username ?? null,
        })),
        ensureCertificateAuthReady: vi.fn(),
        resolveJumpHostTarget: vi.fn(async (_host: unknown, jumpSecrets?: Record<string, { password?: string }>) => ({
          host: 'bastion-dial',
          password: jumpSecrets?.bastion?.password ?? stored.bastion,
        })),
        resolveTailnetRoute: vi.fn(() => ({})),
        persistHostSpecificSecret,
        coreManager: { startPortForward, setPortForwardRuntime: vi.fn(), listPortForwardRuntimes: vi.fn(() => []) },
        rewriteActiveDnsOverrides: vi.fn().mockResolvedValue(undefined),
      }) as any);
      const start = handlers.get(ipcChannels.portForwards.start);
      if (!start) {
        throw new Error('expected port forward start handler to be registered');
      }
      return { start, startPortForward, persistHostSpecificSecret };
    }

    it('names the jump host without calling the core when its password is missing', async () => {
      const { start, startPortForward } = setup({ stored: { target: 'app-pw' } });
      await expect(start({}, 'rule-1')).resolves.toEqual({ credentialsNeeded: { hostId: 'bastion', reason: 'missing' } });
      expect(startPortForward).not.toHaveBeenCalled();
    });

    it('connects with the typed values and saves them once the core started the forward', async () => {
      const { start, startPortForward, persistHostSpecificSecret } = setup({ stored: { target: 'app-pw' } });
      await expect(
        start({}, 'rule-1', { jumpSecrets: { bastion: { password: 'jump-pw' } } }),
      ).resolves.toMatchObject({ ruleId: 'rule-1', status: 'running' });
      expect(startPortForward).toHaveBeenCalledWith(
        expect.objectContaining({ password: 'app-pw', jump: expect.objectContaining({ password: 'jump-pw' }) }),
      );
      // 대상은 저장된 값을 썼다 — 저장하는 것은 넣은 베스천의 값뿐이다.
      expect(persistHostSpecificSecret.mock.calls).toEqual([['bastion', 'Bastion', { password: 'jump-pw' }, null]]);
    });

    it('asks the jump host again when it rejects the typed value, saving nothing', async () => {
      const rejected = Object.assign(
        new Error('jump host: ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password]'),
        { jumpDepth: 1 },
      );
      const { start, persistHostSpecificSecret } = setup({
        stored: { target: 'app-pw' },
        startPortForward: vi.fn().mockRejectedValue(rejected),
      });
      await expect(start({}, 'rule-1', { jumpSecrets: { bastion: { password: 'wrong' } } })).resolves.toEqual({
        credentialsNeeded: { hostId: 'bastion', reason: 'rejected', message: rejected.message },
      });
      expect(persistHostSpecificSecret).not.toHaveBeenCalled();
    });

    it('keeps other failures as errors', async () => {
      const { start } = setup({
        stored: { target: 'app-pw', bastion: 'jump-pw' },
        startPortForward: vi.fn().mockRejectedValue(new Error('dial tcp 127.0.0.1:22251: connection refused')),
      });
      await expect(start({}, 'rule-1')).rejects.toThrow('connection refused');
    });

    // 컨테이너 포워딩은 그 호스트의 컨테이너 연결을 지난다 — 묻는 것도, 넣은 값을 넘기는 것도 같다.
    it('asks before a container port forward and turns its rejection into a question', async () => {
      const containerRule = { id: 'rule-c', hostId: 'target', transport: 'container', containerId: 'c1', networkName: 'bridge', targetPort: 80, bindPort: 18080 };
      const startContainerTunnelRuntime = vi.fn();
      const { start } = setup({ rule: containerRule, stored: { target: 'app-pw' }, startContainerTunnelRuntime });
      await expect(start({}, 'rule-c')).resolves.toEqual({ credentialsNeeded: { hostId: 'bastion', reason: 'missing' } });
      expect(startContainerTunnelRuntime).not.toHaveBeenCalled();

      const needed = { hostId: 'bastion', reason: 'rejected' as const, message: 'jump host: ssh: unable to authenticate' };
      startContainerTunnelRuntime.mockRejectedValueOnce(new CredentialsNeededError(needed));
      const attempt = { jumpSecrets: { bastion: { password: 'wrong' } } };
      await expect(start({}, 'rule-c', attempt)).resolves.toEqual({ credentialsNeeded: needed });
      expect(startContainerTunnelRuntime).toHaveBeenCalledWith(expect.objectContaining({ ruleId: 'rule-c', attempt }));
    });
  });

  // 4-6: 볼트는 레코드가 정한다 — 규칙은 호스트의 볼트, Linked DNS 는 규칙의 볼트, Static DNS 는 화면이 고른 볼트.
  describe('writes go to the vault the record belongs to', () => {
    const at = '2025-01-01T00:00:00.000Z';
    // 메모리에 두는 저장소 가짜 — 핸들러가 부르는 것만.
    function memoryVault(seed: { hosts?: string[]; rules?: Array<Record<string, unknown>>; dns?: Array<Record<string, unknown>> }) {
      const rules = [...(seed.rules ?? [])];
      let dns = [...(seed.dns ?? [])];
      const hosts = (seed.hosts ?? []).map((id) => ({ id, kind: 'ssh', label: id, hostname: `${id}.test`, port: 22, username: 'u' }));
      return {
        hosts: { getById: vi.fn((id: string) => hosts.find((host) => host.id === id) ?? null), list: vi.fn(() => hosts) },
        portForwards: {
          list: vi.fn(() => rules),
          getById: vi.fn((id: string) => rules.find((rule) => rule.id === id) ?? null),
          create: vi.fn((draft: Record<string, unknown>) => {
            const record = { ...draft, id: `new-rule-${rules.length}`, createdAt: at, updatedAt: at };
            rules.push(record);
            return record;
          }),
          update: vi.fn((id: string, draft: Record<string, unknown>) => ({ ...draft, id, createdAt: at, updatedAt: at })),
          remove: vi.fn(),
        },
        dnsOverrides: {
          list: vi.fn(() => dns),
          getById: vi.fn((id: string) => dns.find((record) => record.id === id) ?? null),
          create: vi.fn((draft: Record<string, unknown>) => {
            const record = { ...draft, id: `new-dns-${dns.length}`, createdAt: at, updatedAt: at };
            dns.push(record);
            return record;
          }),
          update: vi.fn((id: string, draft: Record<string, unknown>) => ({ ...draft, id, createdAt: at, updatedAt: at })),
          remove: vi.fn((id: string) => {
            dns = dns.filter((record) => record.id !== id);
          }),
          replaceAll: vi.fn(),
        },
        syncOutbox: { upsertDeletion: vi.fn() },
      };
    }
    const teamPrefs = {
      read: () => ({ hosts: new Map(), workspaces: new Map(), terminalThemeByHostId: {} }),
      readHostCredentials: () => null,
    };
    const sshRule = (id: string, hostId: string) => ({
      id, hostId, transport: 'ssh', label: id, mode: 'local', bindAddress: '127.0.0.1', bindPort: 9000, targetHost: 'localhost', targetPort: 80, createdAt: at, updatedAt: at,
    });

    function setup() {
      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
        handlers.set(channel, handler);
      });
      const personal = memoryVault({
        hosts: ['p-host'],
        rules: [sshRule('p-rule', 'p-host')],
        dns: [{ id: 'p-static', type: 'static', hostname: 'grafana.lab.test', address: '10.0.0.20', createdAt: at, updatedAt: at }],
      });
      const team = {
        ...memoryVault({
          hosts: ['t-host', 't-host-2'],
          rules: [sshRule('t-rule', 't-host')],
          dns: [
            { id: 't-linked', type: 'linked', hostname: 'acme.internal', portForwardRuleId: 't-rule', createdAt: at, updatedAt: at },
            { id: 't-static', type: 'static', hostname: 'grafana.lab.test', address: '10.20.0.50', createdAt: at, updatedAt: at },
          ],
        }),
        memberPrefs: teamPrefs,
      };
      const ctx = withVaults(
        {
          ...personal,
          assertSshHost: vi.fn(),
          stopPortForwardWithDnsOverrideCleanup: vi.fn().mockResolvedValue(undefined),
          rewriteActiveDnsOverrides: vi.fn().mockResolvedValue(undefined),
          // 만든 것을 돌려줄 때 찾는 목록 — 두 볼트의 것을 그대로.
          listResolvedDnsOverrides: vi.fn(() =>
            [...personal.dnsOverrides.list(), ...team.dnsOverrides.list()].map((record) => ({ ...record, status: 'inactive' })),
          ),
          hostsOverrideManager: {
            getActiveStaticOverrideIds: vi.fn(() => new Set<string>()),
            setStaticOverrideActive: vi.fn(),
            removeStaticOverrideState: vi.fn(),
          },
          activityLogs: { append: vi.fn() },
          queueSync: vi.fn(),
        },
        { 'team-1': team },
      );
      registerPortForwardAndDnsIpcHandlers(ctx as any);
      const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
      return { personal, team, ctx, call };
    }

    it('creates a rule in the vault of its host', async () => {
      const { personal, team, call } = setup();
      const draft = { label: 'app', hostId: 't-host', transport: 'ssh', mode: 'local', bindAddress: '127.0.0.1', bindPort: 9100, targetHost: 'localhost', targetPort: 3000 };

      await call(ipcChannels.portForwards.create, draft);
      expect(team.portForwards.create).toHaveBeenCalledWith(draft);
      expect(personal.portForwards.create).not.toHaveBeenCalled();

      await call(ipcChannels.portForwards.create, { ...draft, hostId: 'p-host' });
      expect(personal.portForwards.create).toHaveBeenCalledWith({ ...draft, hostId: 'p-host' });
    });

    it('refuses to move a rule onto a host in another vault', async () => {
      const { personal, team, call } = setup();
      const draft = { label: 't', transport: 'ssh', mode: 'local', bindAddress: '127.0.0.1', bindPort: 9000, targetHost: 'localhost', targetPort: 80 };

      await expect(call(ipcChannels.portForwards.update, 't-rule', { ...draft, hostId: 'p-host' })).rejects.toThrow(
        '이 규칙을 다른 볼트의 호스트로 바꿀 수 없습니다',
      );
      expect(team.portForwards.update).not.toHaveBeenCalled();
      expect(personal.portForwards.update).not.toHaveBeenCalled();

      await call(ipcChannels.portForwards.update, 't-rule', { ...draft, hostId: 't-host-2' });
      expect(team.portForwards.update).toHaveBeenCalledWith('t-rule', { ...draft, hostId: 't-host-2' });
    });

    it("removes a team rule and its linked DNS override from the team vault", async () => {
      const { personal, team, call } = setup();

      await call(ipcChannels.portForwards.remove, 't-rule');

      expect(team.dnsOverrides.remove).toHaveBeenCalledWith('t-linked');
      expect(team.syncOutbox.upsertDeletion).toHaveBeenCalledWith('dnsOverrides', 't-linked');
      expect(team.syncOutbox.upsertDeletion).toHaveBeenCalledWith('portForwards', 't-rule');
      expect(team.portForwards.remove).toHaveBeenCalledWith('t-rule');
      expect(personal.portForwards.remove).not.toHaveBeenCalled();
      expect(personal.syncOutbox.upsertDeletion).not.toHaveBeenCalled();
    });

    it("puts a static override in the vault the screen picked and a linked one in its rule's vault", async () => {
      const { personal, team, call } = setup();
      const staticDraft = { type: 'static', hostname: 'grafana.lab.test', address: '10.20.0.60' };

      await call(ipcChannels.dnsOverrides.create, staticDraft, 'team-1');
      expect(team.dnsOverrides.create).toHaveBeenCalledWith(staticDraft, team.portForwards);

      await call(ipcChannels.dnsOverrides.create, staticDraft);
      expect(personal.dnsOverrides.create).toHaveBeenCalledWith(staticDraft, personal.portForwards);

      const linkedDraft = { type: 'linked', hostname: 'api.internal', portForwardRuleId: 't-rule' };
      await call(ipcChannels.dnsOverrides.create, linkedDraft);
      expect(team.dnsOverrides.create).toHaveBeenLastCalledWith(linkedDraft, team.portForwards);
      // 화면이 고른 볼트와 규칙의 볼트가 다르면 거절한다.
      await expect(call(ipcChannels.dnsOverrides.create, linkedDraft, 'personal')).rejects.toThrow(
        '다른 볼트의 포트 포워딩 규칙에는 이을 수 없습니다',
      );
      await expect(call(ipcChannels.dnsOverrides.create, staticDraft, 'team-gone')).rejects.toThrow();
    });

    it("keeps a team override on the team's rules, and toggles and removes it in the team vault", async () => {
      const { personal, team, ctx, call } = setup();

      await expect(
        call(ipcChannels.dnsOverrides.update, 't-linked', { type: 'linked', hostname: 'acme.internal', portForwardRuleId: 'p-rule' }),
      ).rejects.toThrow('다른 볼트의 포트 포워딩 규칙에는 이을 수 없습니다');
      expect(team.dnsOverrides.update).not.toHaveBeenCalled();

      await call(ipcChannels.dnsOverrides.update, 't-static', { type: 'static', hostname: 'grafana.lab.test', address: '10.20.0.70' });
      expect(team.dnsOverrides.update).toHaveBeenCalledWith(
        't-static',
        { type: 'static', hostname: 'grafana.lab.test', address: '10.20.0.70' },
        team.portForwards,
      );

      await call(ipcChannels.dnsOverrides.setStaticActive, 't-static', true);
      expect(ctx.hostsOverrideManager.setStaticOverrideActive).toHaveBeenCalledWith('t-static', true);

      await call(ipcChannels.dnsOverrides.remove, 't-static');
      expect(team.dnsOverrides.remove).toHaveBeenCalledWith('t-static');
      expect(team.syncOutbox.upsertDeletion).toHaveBeenCalledWith('dnsOverrides', 't-static');
      expect(personal.dnsOverrides.remove).not.toHaveBeenCalled();
    });
  });
});
