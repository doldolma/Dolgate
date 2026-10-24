import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcChannels } from '../../common/ipc-channels';

const electronMocks = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
  clipboardWriteText: vi.fn(async (_text: string) => {}),
}));

const ipcHandlers = electronMocks.ipcHandlers;

vi.mock('electron', () => ({
  clipboard: {
    writeText: electronMocks.clipboardWriteText,
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      electronMocks.ipcHandlers.set(channel, handler);
    }),
  },
}));

import { registerKnownHostsLogsKeychainIpcHandlers } from './known-hosts-logs-keychain';
import { withVaults } from '../vault-catalog.test-support';

function createContext() {
  return withVaults({
    knownHosts: {
      list: vi.fn(),
      trust: vi.fn(),
      remove: vi.fn(),
    },
    buildHostKeyProbeResult: vi.fn(),
    emitContainersConnectionProgress: vi.fn(),
    emitSftpConnectionProgress: vi.fn(),
    activityLogs: {
      append: vi.fn(),
      list: vi.fn(),
      clear: vi.fn(),
    },
    sessionReplayService: {
      openReplayWindow: vi.fn(),
      get: vi.fn(),
    },
    resolveWindowFromSender: vi.fn(),
    secretMetadata: {
      list: vi.fn(),
      removeMany: vi.fn(),
      getBySecretRef: vi.fn(),
      upsert: vi.fn(),
    },
    secretStore: {
      load: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
    },
    inspectCertificate: vi.fn(),
    hosts: {
      clearSecretRefs: vi.fn(),
      getById: vi.fn(),
      updateSecretRef: vi.fn(),
    },
    syncOutbox: {
      upsertDeletion: vi.fn(),
      upsertDeletions: vi.fn(),
    },
    hasSecretValue: vi.fn((secrets) =>
      Boolean(
        secrets.password ||
          secrets.passphrase ||
          secrets.privateKeyPem ||
          secrets.certificateText,
      ),
    ),
    assertSshHost: vi.fn(),
    persistSecret: vi.fn(),
    describeHostLabel: vi.fn(),
    queueSync: vi.fn(),
  }) as any;
}

describe('registerKnownHostsLogsKeychainIpcHandlers', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    electronMocks.clipboardWriteText.mockReset();
  });

  it('reads known hosts and saved credentials from the vault the settings screen picks', async () => {
    const teamKnownHosts = [{ id: 'kh-team' }];
    const teamSecrets = [{ secretRef: 'secret:team' }];
    const ctx = withVaults(createContext(), {
      'team-1': {
        knownHosts: { list: vi.fn(() => teamKnownHosts) },
        secretMetadata: { list: vi.fn(() => teamSecrets) },
      },
    }) as any;
    ctx.knownHosts.list.mockReturnValue([{ id: 'kh-personal' }]);
    ctx.secretMetadata.list.mockReturnValue([{ secretRef: 'secret:personal' }]);
    registerKnownHostsLogsKeychainIpcHandlers(ctx);
    const knownHosts = ipcHandlers.get(ipcChannels.knownHosts.list)!;
    const keychain = ipcHandlers.get(ipcChannels.keychain.list)!;

    // 고르지 않았거나 개인이면 지금까지와 같은 개인 저장소다.
    await expect(knownHosts({})).resolves.toEqual([{ id: 'kh-personal' }]);
    await expect(knownHosts({}, 'personal')).resolves.toEqual([{ id: 'kh-personal' }]);
    await expect(keychain({})).resolves.toEqual([{ secretRef: 'secret:personal' }]);
    await expect(knownHosts({}, 'team-1')).resolves.toBe(teamKnownHosts);
    await expect(keychain({}, 'team-1')).resolves.toBe(teamSecrets);
    // 막 빠진 팀을 화면이 아직 들고 있어도 깨지지 않는다.
    await expect(knownHosts({}, 'team-gone')).resolves.toEqual([]);
    await expect(keychain({}, 'team-gone')).resolves.toEqual([]);
  });

  it('includes certificate validity info when loading a certificate secret', async () => {
    const ctx = createContext();
    ctx.secretMetadata.getBySecretRef.mockReturnValue({
      secretRef: 'secret-1',
      label: 'Prod certificate',
      updatedAt: '2026-04-12T00:00:00.000Z',
    });
    ctx.secretStore.load.mockResolvedValue(
      JSON.stringify({
        secretRef: 'secret-1',
        label: 'Prod certificate',
        privateKeyPem: 'PRIVATE KEY',
        certificateText: 'CERTIFICATE',
        updatedAt: '2026-04-12T00:00:00.000Z',
      }),
    );
    ctx.inspectCertificate.mockResolvedValue({
      status: 'expired',
      validBefore: '2026-04-11T00:00:00.000Z',
      principals: ['ubuntu'],
    });

    registerKnownHostsLogsKeychainIpcHandlers(ctx);

    const loadHandler = ipcHandlers.get(ipcChannels.keychain.load);
    expect(loadHandler).toBeTypeOf('function');

    await expect(loadHandler?.(null, 'secret-1')).resolves.toMatchObject({
      secretRef: 'secret-1',
      certificateInfo: {
        status: 'expired',
        validBefore: '2026-04-11T00:00:00.000Z',
        principals: ['ubuntu'],
      },
    });
  });

  it('copies a saved password to the Electron clipboard without returning it', async () => {
    const ctx = createContext();
    ctx.secretMetadata.getBySecretRef.mockReturnValue({
      secretRef: 'secret-1',
      label: 'Prod password',
      updatedAt: '2026-04-12T00:00:00.000Z',
    });
    ctx.secretStore.load.mockResolvedValue(
      JSON.stringify({
        secretRef: 'secret-1',
        label: 'Prod password',
        password: 'super-secret-password',
        updatedAt: '2026-04-12T00:00:00.000Z',
      }),
    );

    registerKnownHostsLogsKeychainIpcHandlers(ctx);

    const copyHandler = ipcHandlers.get(ipcChannels.keychain.copyPassword);
    expect(copyHandler).toBeTypeOf('function');

    await expect(copyHandler?.(null, 'secret-1')).resolves.toBeUndefined();

    expect(electronMocks.clipboardWriteText).toHaveBeenCalledWith(
      'super-secret-password',
    );
    expect(ctx.activityLogs.append).not.toHaveBeenCalled();
  });

  it('rejects password copy for secrets that do not contain a password', async () => {
    const ctx = createContext();
    ctx.secretMetadata.getBySecretRef.mockReturnValue({
      secretRef: 'secret-key',
      label: 'Prod key',
      updatedAt: '2026-04-12T00:00:00.000Z',
    });
    ctx.secretStore.load.mockResolvedValue(
      JSON.stringify({
        secretRef: 'secret-key',
        label: 'Prod key',
        privateKeyPem: 'PRIVATE KEY',
        updatedAt: '2026-04-12T00:00:00.000Z',
      }),
    );

    registerKnownHostsLogsKeychainIpcHandlers(ctx);

    const copyHandler = ipcHandlers.get(ipcChannels.keychain.copyPassword);
    expect(copyHandler).toBeTypeOf('function');

    await expect(copyHandler?.(null, 'secret-key')).rejects.toThrow(
      '이 인증 정보에는 저장된 비밀번호가 없습니다.',
    );
    expect(electronMocks.clipboardWriteText).not.toHaveBeenCalled();
    expect(ctx.activityLogs.append).not.toHaveBeenCalled();
  });

  it('recomputes key and certificate metadata from the merged secret payload', async () => {
    const ctx = createContext();
    ctx.secretMetadata.getBySecretRef.mockReturnValue({
      secretRef: 'secret-1',
      label: 'Old certificate secret',
      hasPassword: false,
      hasPassphrase: false,
      hasManagedPrivateKey: true,
      hasCertificate: true,
    });
    registerKnownHostsLogsKeychainIpcHandlers(ctx);

    const updateHandler = ipcHandlers.get(ipcChannels.keychain.update);
    expect(updateHandler).toBeTypeOf('function');

    await updateHandler?.(null, {
      secretRef: 'secret-1',
      secrets: {
        password: 'new-password',
      },
    });

    expect(ctx.secretMetadata.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        secretRef: 'secret-1',
        hasPassword: true,
        hasManagedPrivateKey: false,
        hasCertificate: false,
      }),
    );
  });

  it('treats update payload as a full replacement instead of merging old fields', async () => {
    const ctx = createContext();
    ctx.secretMetadata.getBySecretRef.mockReturnValue({
      secretRef: 'secret-1',
      label: 'Mixed secret',
      hasPassword: true,
      hasPassphrase: true,
      hasManagedPrivateKey: true,
      hasCertificate: true,
    });

    registerKnownHostsLogsKeychainIpcHandlers(ctx);

    const updateHandler = ipcHandlers.get(ipcChannels.keychain.update);
    expect(updateHandler).toBeTypeOf('function');

    await updateHandler?.(null, {
      secretRef: 'secret-1',
      secrets: {
        privateKeyPem: 'PRIVATE KEY',
      },
    });

    expect(ctx.secretStore.save).toHaveBeenCalledWith(
      'secret-1',
      expect.stringContaining('"privateKeyPem":"PRIVATE KEY"'),
    );
    expect(ctx.secretStore.save).not.toHaveBeenCalledWith(
      'secret-1',
      expect.stringContaining('"password"'),
    );
    expect(ctx.secretMetadata.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        hasPassword: false,
        hasPassphrase: false,
        hasManagedPrivateKey: true,
        hasCertificate: false,
      }),
    );
  });

  it('logs a connection failure when the host key probe fails', async () => {
    const ctx = createContext();
    ctx.hosts.getById.mockReturnValue({
      id: 'host-1',
      kind: 'ssh',
      label: 'Unreachable',
      secretRef: null,
    });
    ctx.resolveJumpHostTarget = vi.fn().mockResolvedValue(undefined);
    ctx.buildHostKeyProbeResult.mockRejectedValue(
      new Error('dial tcp 100.64.0.2:22: i/o timeout'),
    );

    registerKnownHostsLogsKeychainIpcHandlers(ctx);

    const probeHandler = ipcHandlers.get(ipcChannels.knownHosts.probeHost);
    expect(probeHandler).toBeTypeOf('function');

    await expect(probeHandler?.(null, { hostId: 'host-1' })).rejects.toThrow(
      'i/o timeout',
    );

    expect(ctx.activityLogs.append).toHaveBeenCalledWith(
      'error',
      'session',
      expect.objectContaining({ messageKey: 'knownHostsIpc.connectFailed' }),
      expect.objectContaining({ hostId: 'host-1', hostLabel: 'Unreachable' }),
    );
  });

  it('creates host-specific clones from the replacement payload only', async () => {
    const ctx = createContext();
    ctx.hosts.getById.mockReturnValue({
      id: 'host-1',
      kind: 'ssh',
      label: 'Prod',
      secretRef: 'secret-1',
    });
    ctx.describeHostLabel.mockReturnValue('Prod');
    ctx.persistSecret.mockResolvedValue('secret-2');

    registerKnownHostsLogsKeychainIpcHandlers(ctx);

    const cloneHandler = ipcHandlers.get(ipcChannels.keychain.cloneForHost);
    expect(cloneHandler).toBeTypeOf('function');

    await cloneHandler?.(null, {
      hostId: 'host-1',
      sourceSecretRef: 'secret-1',
      secrets: {
        certificateText: 'ssh-ed25519-cert-v01@openssh.com AAA',
        privateKeyPem: 'PRIVATE KEY',
      },
    });

    expect(ctx.persistSecret).toHaveBeenCalledWith('Prod', {
      password: undefined,
      passphrase: undefined,
      privateKeyPem: 'PRIVATE KEY',
      certificateText: 'ssh-ed25519-cert-v01@openssh.com AAA',
    });
    expect(ctx.hosts.updateSecretRef).toHaveBeenCalledWith('host-1', 'secret-2');
  });
});

// 신뢰 범위를 렌더러가 정하게 두면 그것이 곧 우회 경로가 된다 — tailnet 밖에서 신뢰한 키를
// tailnet 안에서 통하게 만들 수 있다. 범위는 호스트 레코드가 정한다.
describe('known host trust scope', () => {
  it('takes the tailnet from the host record, not from the renderer', async () => {
    ipcHandlers.clear();
    const ctx = createContext();
    ctx.hosts.getById = vi.fn(() => ({
      id: 'host-1',
      kind: 'ssh',
      label: 'Prod',
      hostname: 'server',
      port: 22,
      username: 'root',
      authType: 'password',
      tailnetId: 'net-a',
    })) as never;
    registerKnownHostsLogsKeychainIpcHandlers(ctx as never);

    const handler = ipcHandlers.get(ipcChannels.knownHosts.trust)!;
    await handler({}, {
      hostId: 'host-1',
      hostLabel: 'Prod',
      host: 'server',
      port: 22,
      algorithm: 'ssh-ed25519',
      publicKeyBase64: 'AAA',
      fingerprintSha256: 'SHA256:x',
      // 렌더러가 다른 범위를 주장한다.
      tailnetId: 'net-attacker',
    });

    expect(ctx.knownHosts.trust).toHaveBeenCalledWith(
      expect.objectContaining({ tailnetId: 'net-a' }),
    );
  });

  it('scopes to the plain network when the host has no tailnet', async () => {
    ipcHandlers.clear();
    const ctx = createContext();
    ctx.hosts.getById = vi.fn(() => ({
      id: 'host-1',
      kind: 'ssh',
      label: 'Prod',
      hostname: 'server',
      port: 22,
      username: 'root',
      authType: 'password',
    })) as never;
    registerKnownHostsLogsKeychainIpcHandlers(ctx as never);

    const handler = ipcHandlers.get(ipcChannels.knownHosts.trust)!;
    await handler({}, {
      hostId: 'host-1',
      hostLabel: 'Prod',
      host: 'server',
      port: 22,
      algorithm: 'ssh-ed25519',
      publicKeyBase64: 'AAA',
      fingerprintSha256: 'SHA256:x',
      tailnetId: 'net-attacker',
    });

    expect(ctx.knownHosts.trust).toHaveBeenCalledWith(
      expect.objectContaining({ tailnetId: undefined }),
    );
  });

  // 교체(호스트키 변경 수락)도 같은 경계를 지나야 한다.
  // 팀 호스트의 키는 팀원 모두가 믿는다 — 신뢰는 그 호스트의 볼트에 둔다.
  it("stores trust in the host's own vault", async () => {
    ipcHandlers.clear();
    const ctx = createContext();
    const teamKnownHosts = { trust: vi.fn((input: unknown) => input) };
    ctx.vaults = {
      ...ctx.vaults,
      getHost: vi.fn(() => ({ id: 'team-host', kind: 'ssh', hostname: 'server', port: 22 })),
      scopeOfHost: vi.fn((hostId: string) =>
        hostId === 'team-host' ? { id: 'team-1', knownHosts: teamKnownHosts } : ctx.vaults.personal,
      ),
    };
    registerKnownHostsLogsKeychainIpcHandlers(ctx as never);

    await ipcHandlers.get(ipcChannels.knownHosts.trust)!({}, {
      hostId: 'team-host',
      hostLabel: 'Shared',
      host: 'server',
      port: 22,
      algorithm: 'ssh-ed25519',
      publicKeyBase64: 'AAA',
      fingerprintSha256: 'SHA256:x',
    });

    expect(teamKnownHosts.trust).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'team-host' }));
    expect(ctx.knownHosts.trust).not.toHaveBeenCalled();
  });

  it('applies the same scope rule when replacing a key', async () => {
    ipcHandlers.clear();
    const ctx = createContext();
    ctx.hosts.getById = vi.fn(() => ({
      id: 'host-1',
      kind: 'ssh',
      label: 'Prod',
      hostname: 'server',
      port: 22,
      username: 'root',
      authType: 'password',
      tailnetId: 'net-a',
    })) as never;
    registerKnownHostsLogsKeychainIpcHandlers(ctx as never);

    const handler = ipcHandlers.get(ipcChannels.knownHosts.replace)!;
    await handler({}, {
      hostId: 'host-1',
      hostLabel: 'Prod',
      host: 'server',
      port: 22,
      algorithm: 'ssh-ed25519',
      publicKeyBase64: 'AAANEW',
      fingerprintSha256: 'SHA256:new',
      tailnetId: 'net-attacker',
    });

    expect(ctx.knownHosts.trust).toHaveBeenCalledWith(
      expect.objectContaining({ tailnetId: 'net-a' }),
    );
  });
});

// 설정의 팀 묶음(4-7): 팀의 저장 자격 증명·호스트 키는 그 팀에서 읽고, 바꾸고, 지운다 — 멤버 모두에게 간다.
describe('team vault saved credentials and host keys', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    electronMocks.clipboardWriteText.mockClear();
  });

  function createTeamContext() {
    const ctx = createContext();
    // 개인 볼트에는 없는 것으로(목의 기본 undefined 는 "있다"로 읽힌다).
    ctx.secretMetadata.getBySecretRef.mockImplementation((secretRef: string) =>
      secretRef === 'secret:personal' ? { secretRef, label: 'mine', updatedAt: 't' } : null,
    );
    ctx.secretStore.load.mockResolvedValue(JSON.stringify({ secretRef: 'secret:personal', label: 'mine', password: 'my-pw' }));
    ctx.knownHosts.list.mockReturnValue([{ id: 'kh-personal' }]);
    const stored = new Map([
      ['secret:team', JSON.stringify({ secretRef: 'secret:team', label: 'acme-db', password: 'team-pw', updatedAt: 't' })],
    ]);
    const team = {
      secretMetadata: {
        getBySecretRef: vi.fn((secretRef: string) =>
          secretRef === 'secret:team' ? { secretRef, label: 'acme-db', updatedAt: 't', linkedHostCount: 2 } : null,
        ),
        list: vi.fn(() => []),
        removeMany: vi.fn(),
        upsert: vi.fn(),
      },
      secrets: {
        load: vi.fn(async (secretRef: string) => stored.get(secretRef) ?? null),
        save: vi.fn(async (secretRef: string) => secretRef),
        remove: vi.fn(async () => {}),
      },
      hosts: { clearSecretRefs: vi.fn() },
      syncOutbox: { upsertDeletion: vi.fn(), upsertDeletions: vi.fn() },
      knownHosts: { list: vi.fn(() => [{ id: 'kh-team' }]), remove: vi.fn() },
    };
    withVaults(ctx, { 'team-1': team });
    registerKnownHostsLogsKeychainIpcHandlers(ctx);
    return { ctx, team };
  }

  const invoke = (channel: string, ...args: unknown[]) => ipcHandlers.get(channel)!({}, ...args);

  it('loads, copies and edits a team credential in the team, and keeps a personal one personal', async () => {
    const { ctx, team } = createTeamContext();

    await expect(invoke(ipcChannels.keychain.load, 'secret:team')).resolves.toMatchObject({
      secretRef: 'secret:team',
      label: 'acme-db',
      password: 'team-pw',
    });
    await invoke(ipcChannels.keychain.copyPassword, 'secret:team');
    expect(electronMocks.clipboardWriteText).toHaveBeenCalledWith('team-pw');

    await invoke(ipcChannels.keychain.update, { secretRef: 'secret:team', secrets: { password: 'new-team-pw' } });
    expect(team.secrets.save).toHaveBeenCalledWith('secret:team', expect.stringContaining('new-team-pw'));
    expect(team.secretMetadata.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ secretRef: 'secret:team', label: 'acme-db', hasPassword: true }),
    );
    expect(ctx.secretStore.save).not.toHaveBeenCalled();
    expect(ctx.secretMetadata.upsert).not.toHaveBeenCalled();

    // 개인 것은 팀이 있어도 개인 저장소로 간다.
    await expect(invoke(ipcChannels.keychain.load, 'secret:personal')).resolves.toMatchObject({ password: 'my-pw' });
    expect(ctx.secretStore.load).toHaveBeenCalledWith('secret:personal');
    expect(team.secrets.load).not.toHaveBeenCalledWith('secret:personal');
  });

  it('removes a team credential from the team and unlinks it from the team hosts', async () => {
    const { ctx, team } = createTeamContext();
    // 지움 기록이 먼저다 — 지우는 사이 팀 동기화가 돌아도 서버 사본으로 되살리지 않게(실제 앱에서 잠깐 되살아났다).
    team.secrets.remove.mockImplementation(async () => {
      expect(team.syncOutbox.upsertDeletions).toHaveBeenCalledWith('secrets', ['secret:team']);
    });

    await invoke(ipcChannels.keychain.remove, ['secret:team']);

    expect(team.secrets.remove).toHaveBeenCalledWith('secret:team');
    expect(team.secretMetadata.removeMany).toHaveBeenCalledWith(['secret:team']);
    expect(team.hosts.clearSecretRefs).toHaveBeenCalledWith(['secret:team']);
    expect(ctx.secretStore.remove).not.toHaveBeenCalled();
    expect(ctx.hosts.clearSecretRefs).not.toHaveBeenCalled();
    expect(ctx.syncOutbox.upsertDeletions).not.toHaveBeenCalled();
  });

  // 여러 개를 하나씩 지우면 지울 때마다 상태 쓰기·동기화·화면 새로 읽기가 돌고, 그러다 화면이 죽으면 반쯤 지운 채 남았다
  // (호스트 169개를 지우며 안 쓰게 된 인증 정보 83개 중 11개만 지워졌다).
  it('removes several credentials at once, each in its own vault, telling sync once', async () => {
    const { ctx, team } = createTeamContext();
    ctx.secretMetadata.getBySecretRef.mockImplementation((secretRef: string) =>
      secretRef.startsWith('secret:mine') ? { secretRef, label: 'mine', updatedAt: 't' } : null,
    );

    await invoke(ipcChannels.keychain.remove, ['secret:mine-1', 'secret:team', 'secret:mine-2']);

    expect(ctx.syncOutbox.upsertDeletions).toHaveBeenCalledWith('secrets', ['secret:mine-1', 'secret:mine-2']);
    expect(ctx.secretStore.remove.mock.calls).toEqual([['secret:mine-1'], ['secret:mine-2']]);
    expect(ctx.secretMetadata.removeMany).toHaveBeenCalledWith(['secret:mine-1', 'secret:mine-2']);
    expect(ctx.hosts.clearSecretRefs).toHaveBeenCalledWith(['secret:mine-1', 'secret:mine-2']);
    expect(team.syncOutbox.upsertDeletions).toHaveBeenCalledWith('secrets', ['secret:team']);
    expect(team.secretMetadata.removeMany).toHaveBeenCalledWith(['secret:team']);
    expect(ctx.activityLogs.append.mock.calls.map((call: unknown[]) => call[3])).toEqual([
      { vaultId: 'personal', secretRef: 'secret:mine-1' },
      { vaultId: 'personal', secretRef: 'secret:mine-2' },
      { vaultId: 'team-1', secretRef: 'secret:team' },
    ]);
    expect(ctx.queueSync).toHaveBeenCalledTimes(1);
  });

  it('removes a team host key from the team, a personal one from the personal vault', async () => {
    const { ctx, team } = createTeamContext();

    await invoke(ipcChannels.knownHosts.remove, 'kh-team');
    expect(team.syncOutbox.upsertDeletion).toHaveBeenCalledWith('knownHosts', 'kh-team');
    expect(team.knownHosts.remove).toHaveBeenCalledWith('kh-team');
    expect(ctx.knownHosts.remove).not.toHaveBeenCalled();

    await invoke(ipcChannels.knownHosts.remove, 'kh-personal');
    expect(ctx.syncOutbox.upsertDeletion).toHaveBeenCalledWith('knownHosts', 'kh-personal');
    expect(ctx.knownHosts.remove).toHaveBeenCalledWith('kh-personal');
    expect(team.knownHosts.remove).toHaveBeenCalledTimes(1);
  });
});
