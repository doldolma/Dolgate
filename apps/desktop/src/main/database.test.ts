import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS } from '@shared';
import { resolveLocalHistoryScope } from './local-history-scope';

type DatabaseModule = typeof import('./database');

const TEST_HISTORY_OWNER = {
  userId: 'user-1',
  serverUrl: 'https://ssh.doldolma.com',
};

async function loadRepositories(): Promise<{
  tempDir: string;
  HostRepository: DatabaseModule['HostRepository'];
  GroupRepository: DatabaseModule['GroupRepository'];
  PortForwardRepository: DatabaseModule['PortForwardRepository'];
  DnsOverrideRepository: DatabaseModule['DnsOverrideRepository'];
  KnownHostRepository: DatabaseModule['KnownHostRepository'];
  SettingsRepository: DatabaseModule['SettingsRepository'];
  ActivityLogRepository: DatabaseModule['ActivityLogRepository'];
}> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dolgate-desktop-db-'));
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  vi.resetModules();

  const stateStorageModule = await import('./state-storage');
  stateStorageModule.resetDesktopStateStorageForTests();
  const databaseModule = await import('./database');
  stateStorageModule
    .getDesktopStateStorage()
    .activateActivityLogScope(TEST_HISTORY_OWNER);

  return {
    tempDir,
    HostRepository: databaseModule.HostRepository,
    GroupRepository: databaseModule.GroupRepository,
    PortForwardRepository: databaseModule.PortForwardRepository,
    DnsOverrideRepository: databaseModule.DnsOverrideRepository,
    KnownHostRepository: databaseModule.KnownHostRepository,
    SettingsRepository: databaseModule.SettingsRepository,
    ActivityLogRepository: databaseModule.ActivityLogRepository
  };
}

async function loadRepositoriesWithStateFile(stateFile: unknown): Promise<{
  tempDir: string;
  HostRepository: DatabaseModule['HostRepository'];
  SettingsRepository: DatabaseModule['SettingsRepository'];
  ActivityLogRepository: DatabaseModule['ActivityLogRepository'];
}> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dolgate-desktop-db-'));
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  mkdirSync(path.join(tempDir, 'storage'), { recursive: true });
  writeFileSync(path.join(tempDir, 'storage', 'state.json'), JSON.stringify(stateFile), 'utf8');
  vi.resetModules();

  const stateStorageModule = await import('./state-storage');
  stateStorageModule.resetDesktopStateStorageForTests();
  const databaseModule = await import('./database');
  stateStorageModule
    .getDesktopStateStorage()
    .activateActivityLogScope(TEST_HISTORY_OWNER);

  return {
    tempDir,
    HostRepository: databaseModule.HostRepository,
    SettingsRepository: databaseModule.SettingsRepository,
    ActivityLogRepository: databaseModule.ActivityLogRepository
  };
}

afterEach(() => {
  const tempDir = process.env.DOLSSH_USER_DATA_DIR;
  delete process.env.DOLSSH_USER_DATA_DIR;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  vi.resetModules();
});

describe('HostRepository', () => {
  it('persists startup commands and clears deleted snippet references', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    const created = hosts.create('ssh-startup', {
      kind: 'ssh',
      label: 'Startup host',
      hostname: 'startup.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      startupCommand: { type: 'command', command: 'cd /srv/app' },
    });
    expect(created).toMatchObject({
      startupCommand: { type: 'command', command: 'cd /srv/app' },
    });

    hosts.update('ssh-startup', {
      kind: 'ssh',
      label: 'Startup host',
      hostname: 'startup.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      startupCommand: { type: 'snippet', snippetId: 'snippet-1' },
    });
    const updated = hosts.clearStartupSnippetRef('snippet-1');

    expect(updated).toHaveLength(1);
    expect(hosts.getById('ssh-startup')).toMatchObject({ startupCommand: null });
  });

  it('persists a multi-hop jump chain and prunes it when a bastion is removed', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    const baseDraft = (label: string) => ({
      kind: 'ssh' as const,
      label,
      hostname: `${label}.example.com`,
      port: 22,
      username: 'ubuntu',
      authType: 'password' as const,
    });

    hosts.create('jump-1', baseDraft('jump1'));
    hosts.create('jump-2', baseDraft('jump2'));
    hosts.create('target', { ...baseDraft('target'), jumpHostIds: ['jump-1', 'jump-2'] });

    // 저장: 체인 보존 + 레거시 단일 필드는 첫 홉으로 미러링.
    expect(hosts.getById('target')).toMatchObject({
      jumpHostIds: ['jump-1', 'jump-2'],
      jumpHostId: 'jump-1',
    });

    // 첫 베스천 삭제 → 체인에서 제거되고 미러도 갱신.
    hosts.remove('jump-1');
    expect(hosts.getById('target')).toMatchObject({
      jumpHostIds: ['jump-2'],
      jumpHostId: 'jump-2',
    });

    // 마지막 점프까지 삭제 → 직접 연결(null).
    hosts.remove('jump-2');
    expect(hosts.getById('target')).toMatchObject({
      jumpHostIds: null,
      jumpHostId: null,
    });
  });

  it('toggles favorite and preserves it across host edits', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    const created = hosts.create('ssh-fav', {
      kind: 'ssh',
      label: 'Fav host',
      hostname: 'fav.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
    });
    expect(created.favorite ?? null).toBeNull();

    const favored = hosts.setFavorite('ssh-fav', true);
    expect(favored).toMatchObject({ favorite: true });

    // 편집 폼 저장(update)에서도 즐겨찾기가 유지되어야 한다.
    const edited = hosts.update('ssh-fav', {
      kind: 'ssh',
      label: 'Fav host (renamed)',
      hostname: 'fav.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
    });
    expect(edited).toMatchObject({ label: 'Fav host (renamed)', favorite: true });

    // 해제하면 null로 돌아간다.
    const unfavored = hosts.setFavorite('ssh-fav', false);
    expect(unfavored?.favorite ?? null).toBeNull();
  });

  it('stores env on the host record, not the shared credential, so it does not bleed across hosts', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    // 두 호스트가 같은 자격증명(secretRef)을 공유 — 예전엔 env가 시크릿에 있어 서로 번졌다.
    hosts.create(
      'ssh-env-a',
      {
        kind: 'ssh',
        label: 'A',
        hostname: 'a.example.com',
        port: 22,
        username: 'ubuntu',
        authType: 'password',
        env: [{ key: 'FOO', value: 'a-foo' }],
      },
      'secret:shared',
    );
    hosts.create(
      'ssh-env-b',
      {
        kind: 'ssh',
        label: 'B',
        hostname: 'b.example.com',
        port: 22,
        username: 'ubuntu',
        authType: 'password',
      },
      'secret:shared',
    );

    expect(hosts.getById('ssh-env-a')).toMatchObject({
      secretRef: 'secret:shared',
      env: [{ key: 'FOO', value: 'a-foo' }],
    });
    expect(hosts.getById('ssh-env-b')).toMatchObject({ secretRef: 'secret:shared', env: null });

    // A의 env를 수정해도 같은 자격증명을 쓰는 B에는 번지지 않는다(env가 호스트 레코드에 있으므로).
    hosts.update(
      'ssh-env-a',
      {
        kind: 'ssh',
        label: 'A',
        hostname: 'a.example.com',
        port: 22,
        username: 'ubuntu',
        authType: 'password',
        env: [
          { key: 'FOO', value: 'a-foo' },
          { key: 'BAR', value: 'a-bar' },
        ],
      },
      'secret:shared',
    );

    expect(hosts.getById('ssh-env-a')).toMatchObject({
      env: [
        { key: 'FOO', value: 'a-foo' },
        { key: 'BAR', value: 'a-bar' },
      ],
    });
    expect(hosts.getById('ssh-env-b')).toMatchObject({ env: null });
  });

  it('persists AWS SFTP metadata on create and update', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    const created = hosts.create('aws-host-1', {
      kind: 'aws-ec2',
      label: 'AWS Prod',
      groupName: 'Production',
      tags: ['prod'],
      terminalThemeId: null,
      awsProfileName: 'default',
      awsRegion: 'ap-northeast-2',
      awsInstanceId: 'i-abc',
      awsAvailabilityZone: 'ap-northeast-2a',
      awsInstanceName: 'web-1',
      awsPlatform: 'Linux/UNIX',
      awsPrivateIp: '10.0.0.10',
      awsState: 'running',
      awsSshUsername: 'ubuntu',
      awsSshPort: 2222,
      awsSshMetadataStatus: 'ready',
      awsSshMetadataError: null,
      awsSsmServerProxyEnabled: true
    });

    expect(created).toMatchObject({
      kind: 'aws-ec2',
      awsAvailabilityZone: 'ap-northeast-2a',
      awsSshUsername: 'ubuntu',
      awsSshPort: 2222,
      awsSshMetadataStatus: 'ready',
      awsSshMetadataError: null,
      awsSsmServerProxyEnabled: true
    });

    const updated = hosts.update('aws-host-1', {
      kind: 'aws-ec2',
      label: 'AWS Prod',
      groupName: 'Production',
      tags: ['prod'],
      terminalThemeId: null,
      awsProfileName: 'default',
      awsRegion: 'ap-northeast-2',
      awsInstanceId: 'i-abc',
      awsAvailabilityZone: 'ap-northeast-2c',
      awsInstanceName: 'web-1',
      awsPlatform: 'Linux/UNIX',
      awsPrivateIp: '10.0.0.10',
      awsState: 'running',
      awsSshUsername: 'ec2-user',
      awsSshPort: 22,
      awsSshMetadataStatus: 'ready',
      awsSshMetadataError: null
    });

    expect(updated).toMatchObject({
      kind: 'aws-ec2',
      awsAvailabilityZone: 'ap-northeast-2c',
      awsSshUsername: 'ec2-user',
      awsSshPort: 22,
      awsSshMetadataStatus: 'ready',
      awsSshMetadataError: null,
      awsSsmServerProxyEnabled: true
    });
    expect(hosts.getById('aws-host-1')).toMatchObject({
      kind: 'aws-ec2',
      awsAvailabilityZone: 'ap-northeast-2c',
      awsSshUsername: 'ec2-user',
      awsSshPort: 22,
      awsSshMetadataStatus: 'ready',
      awsSshMetadataError: null,
      awsSsmServerProxyEnabled: true
    });

    const disabled = hosts.update('aws-host-1', {
      kind: 'aws-ec2',
      label: 'AWS Prod',
      groupName: 'Production',
      tags: ['prod'],
      terminalThemeId: null,
      awsProfileName: 'default',
      awsRegion: 'ap-northeast-2',
      awsInstanceId: 'i-abc',
      awsAvailabilityZone: 'ap-northeast-2c',
      awsInstanceName: 'web-1',
      awsPlatform: 'Linux/UNIX',
      awsPrivateIp: '10.0.0.10',
      awsState: 'running',
      awsSshUsername: 'ec2-user',
      awsSshPort: 22,
      awsSshMetadataStatus: 'ready',
      awsSshMetadataError: null,
      awsSsmServerProxyEnabled: false
    });
    expect(disabled).toMatchObject({
      awsSsmServerProxyEnabled: false
    });
  });

  it('refreshes AWS profile names only for an exact profile ID match', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();
    const createAwsHost = (
      id: string,
      awsProfileId: string | null,
      awsProfileName: string,
    ) =>
      hosts.create(id, {
        kind: 'aws-ec2',
        label: id,
        awsProfileId,
        awsProfileName,
        awsRegion: 'ap-northeast-2',
        awsInstanceId: `i-${id}`,
      });

    createAwsHost('valid-profile', 'profile-current', 'old-name');
    createAwsHost('deleted-profile', 'profile-deleted', 'shared-name');
    createAwsHost('missing-profile-id', null, 'shared-name');

    const updated = hosts.refreshAwsProfileNameCaches([
      { id: 'profile-current', name: 'renamed-profile' },
      { id: 'profile-replacement', name: 'shared-name' },
    ]);

    expect(updated.map((host) => host.id)).toEqual(['valid-profile']);
    expect(hosts.getById('valid-profile')).toMatchObject({
      awsProfileId: 'profile-current',
      awsProfileName: 'renamed-profile',
    });
    expect(hosts.getById('deleted-profile')).toMatchObject({
      awsProfileId: 'profile-deleted',
      awsProfileName: 'shared-name',
    });
    expect(hosts.getById('missing-profile-id')).toMatchObject({
      awsProfileId: null,
      awsProfileName: 'shared-name',
    });
  });

  it('keeps persisted AWS SFTP metadata after reloading state storage', async () => {
    const { HostRepository } = await loadRepositoriesWithStateFile({
      schemaVersion: 1,
      settings: {
        theme: 'system',
        sftpBrowserColumnWidths: DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
        sessionReplayRetentionCount: 100,
        serverUrlOverride: null,
        updatedAt: '2025-01-01T00:00:00.000Z'
      },
      terminal: {
        globalThemeId: 'dolssh-dark',
        globalThemeUpdatedAt: '2025-01-01T00:00:00.000Z',
        fontFamily: 'jetbrains-mono',
        fontSize: 13,
        scrollbackLines: 5000,
        lineHeight: 1,
        letterSpacing: 0,
        minimumContrastRatio: 1,
        altIsMeta: false,
        webglEnabled: true,
        localUpdatedAt: '2025-01-01T00:00:00.000Z'
      },
      updater: {
        dismissedVersion: null,
        updatedAt: '2025-01-01T00:00:00.000Z'
      },
      auth: {
        status: 'authenticated',
        updatedAt: '2025-01-01T00:00:00.000Z'
      },
      sync: {
        lastSuccessfulSyncAt: null,
        pendingPush: false,
        errorMessage: null,
        ownerUserId: null,
        ownerServerUrl: null,
        updatedAt: '2025-01-01T00:00:00.000Z'
      },
      data: {
        groups: [],
        hosts: [
          {
            id: 'aws-host-restore',
            kind: 'aws-ec2',
            label: 'AWS Restore',
            groupName: 'Production',
            tags: ['prod'],
            terminalThemeId: null,
            awsProfileName: 'default',
            awsRegion: 'ap-northeast-2',
            awsInstanceId: 'i-restore',
            awsAvailabilityZone: 'ap-northeast-2a',
            awsInstanceName: 'restore-web',
            awsPlatform: 'Linux/UNIX',
            awsPrivateIp: '10.0.0.88',
            awsState: 'running',
            awsSshUsername: 'ubuntu',
            awsSshPort: 2222,
            awsSshMetadataStatus: 'ready',
            awsSshMetadataError: null,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z'
          }
        ],
        knownHosts: [],
        portForwards: [],
        secretMetadata: [],
        syncOutbox: []
      },
      secure: {
        refreshToken: null,
        managedSecretsByRef: {}
      }
    });

    const hosts = new HostRepository();
    expect(hosts.getById('aws-host-restore')).toMatchObject({
      kind: 'aws-ec2',
      awsAvailabilityZone: 'ap-northeast-2a',
      awsSshUsername: 'ubuntu',
      awsSshPort: 2222,
      awsSshMetadataStatus: 'ready',
      awsSshMetadataError: null
    });
  });

  it('persists AWS ECS hosts on create and reload', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    const created = hosts.create('ecs-host-1', {
      kind: 'aws-ecs',
      label: 'prod cluster',
      groupName: 'Production',
      tags: ['ecs'],
      terminalThemeId: null,
      awsProfileName: 'default',
      awsRegion: 'ap-northeast-2',
      awsEcsClusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
      awsEcsClusterName: 'prod',
    });

    expect(created).toMatchObject({
      kind: 'aws-ecs',
      awsProfileName: 'default',
      awsRegion: 'ap-northeast-2',
      awsEcsClusterName: 'prod',
    });
    expect(hosts.getById('ecs-host-1')).toMatchObject({
      kind: 'aws-ecs',
      awsEcsClusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod',
    });
  });

  it('persists serial hosts on create and reload', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    const created = hosts.create('serial-host-1', {
      kind: 'serial',
      label: 'Console',
      groupName: 'Lab',
      tags: ['serial'],
      terminalThemeId: null,
      transport: 'rfc2217',
      devicePath: null,
      host: 'serial.example.com',
      port: 2217,
      baudRate: 115200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      flowControl: 'rts-cts',
      transmitLineEnding: 'crlf',
      localEcho: false,
      localLineEditing: true,
    });

    expect(created).toMatchObject({
      kind: 'serial',
      transport: 'rfc2217',
      host: 'serial.example.com',
      port: 2217,
      baudRate: 115200,
      flowControl: 'rts-cts',
      transmitLineEnding: 'crlf',
      localEcho: false,
      localLineEditing: true,
    });

    vi.resetModules();
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    const reloadedHosts = new databaseModule.HostRepository();

    expect(reloadedHosts.getById('serial-host-1')).toMatchObject({
      kind: 'serial',
      label: 'Console',
      transport: 'rfc2217',
      host: 'serial.example.com',
      port: 2217,
      baudRate: 115200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      flowControl: 'rts-cts',
      transmitLineEnding: 'crlf',
      localEcho: false,
      localLineEditing: true,
    });
  });

  it('clears key paths when unlinking a secret-backed SSH host', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    hosts.create('ssh-host-1', {
      kind: 'ssh',
      label: 'Cert Host',
      groupName: null,
      tags: [],
      terminalThemeId: null,
      hostname: 'cert.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'certificate',
      privateKeyPath: '/Users/test/.ssh/id_ed25519',
      certificatePath: '/Users/test/.ssh/id_ed25519-cert.pub',
      secretRef: 'secret:cert',
    }, 'secret:cert');

    hosts.clearSecretRef('secret:cert');

    expect(hosts.getById('ssh-host-1')).toMatchObject({
      secretRef: null,
      privateKeyPath: null,
      certificatePath: null,
    });
  });
});

describe('GroupRepository.remove', () => {
  it('reparents descendant groups and hosts while preserving existing target paths', async () => {
    const { HostRepository, GroupRepository } = await loadRepositories();
    const hosts = new HostRepository();
    const groups = new GroupRepository();

    groups.create('group-root', 'root');
    groups.create('group-branch', 'branch', 'root');
    groups.create('group-branch-leaf', 'leaf', 'root/branch');
    groups.create('group-root-leaf', 'leaf', 'root');

    hosts.create('host-direct', {
      kind: 'ssh',
      label: 'Direct',
      hostname: 'direct.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root/branch',
      tags: [],
      terminalThemeId: null
    });
    hosts.create('host-nested', {
      kind: 'ssh',
      label: 'Nested',
      hostname: 'nested.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root/branch/leaf',
      tags: [],
      terminalThemeId: null
    });

    const result = groups.remove('root/branch', 'reparent-descendants');

    expect(result.groups.map((group) => group.path)).toEqual(['root', 'root/leaf']);
    expect(result.hosts.map((host) => [host.id, host.groupName])).toEqual([
      ['host-direct', 'root'],
      ['host-nested', 'root/leaf']
    ]);
    expect(result.removedGroupIds).toEqual(['group-branch', 'group-branch-leaf']);
    expect(result.removedHostIds).toEqual([]);
  });

  it('deletes an entire subtree and returns removed host and group ids', async () => {
    const { HostRepository, GroupRepository } = await loadRepositories();
    const hosts = new HostRepository();
    const groups = new GroupRepository();

    groups.create('group-root', 'root');
    groups.create('group-branch', 'branch', 'root');
    groups.create('group-branch-leaf', 'leaf', 'root/branch');

    hosts.create('host-root', {
      kind: 'ssh',
      label: 'Root',
      hostname: 'root.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root',
      tags: [],
      terminalThemeId: null
    });
    hosts.create('host-branch', {
      kind: 'ssh',
      label: 'Branch',
      hostname: 'branch.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root/branch',
      tags: [],
      terminalThemeId: null
    });
    hosts.create('host-leaf', {
      kind: 'ssh',
      label: 'Leaf',
      hostname: 'leaf.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root/branch/leaf',
      tags: [],
      terminalThemeId: null
    });

    const result = groups.remove('root/branch', 'delete-subtree');

    expect(result.groups.map((group) => group.path)).toEqual(['root']);
    expect(result.hosts.map((host) => [host.id, host.groupName])).toEqual([['host-root', 'root']]);
    expect(result.removedGroupIds).toEqual(['group-branch', 'group-branch-leaf']);
    expect(result.removedHostIds).toEqual(['host-branch', 'host-leaf']);
  });

  it('supports deleting an implicit group path that only exists on hosts', async () => {
    const { HostRepository, GroupRepository } = await loadRepositories();
    const hosts = new HostRepository();
    const groups = new GroupRepository();

    groups.create('group-root', 'root');
    hosts.create('host-implicit', {
      kind: 'ssh',
      label: 'Implicit',
      hostname: 'implicit.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root/implicit',
      tags: [],
      terminalThemeId: null
    });

    const result = groups.remove('root/implicit', 'reparent-descendants');

    expect(result.groups.map((group) => group.path)).toEqual(['root']);
    expect(result.hosts.map((host) => [host.id, host.groupName])).toEqual([['host-implicit', 'root']]);
    expect(result.removedGroupIds).toEqual([]);
    expect(result.removedHostIds).toEqual([]);
  });
});

describe('GroupRepository.move', () => {
  it('moves an explicit group subtree under another group', async () => {
    const { HostRepository, GroupRepository } = await loadRepositories();
    const hosts = new HostRepository();
    const groups = new GroupRepository();

    groups.create('group-servers', 'Servers');
    groups.create('group-nested', 'Nested', 'Servers');
    groups.create('group-clients', 'Clients');

    hosts.create('host-nested', {
      kind: 'ssh',
      label: 'Nested',
      hostname: 'nested.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'Servers/Nested',
      tags: [],
      terminalThemeId: null
    });

    const result = groups.move('Servers/Nested', 'Clients');

    expect(result.nextPath).toBe('Clients/Nested');
    expect(result.groups.map((group) => group.path)).toEqual(['Clients', 'Clients/Nested', 'Servers']);
    expect(result.hosts.map((host) => [host.id, host.groupName])).toEqual([['host-nested', 'Clients/Nested']]);
  });

  it('moves an implicit group path to the root', async () => {
    const { HostRepository, GroupRepository } = await loadRepositories();
    const hosts = new HostRepository();
    const groups = new GroupRepository();

    groups.create('group-root', 'root');
    hosts.create('host-implicit', {
      kind: 'ssh',
      label: 'Implicit',
      hostname: 'implicit.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root/implicit',
      tags: [],
      terminalThemeId: null
    });

    const result = groups.move('root/implicit', null);

    expect(result.nextPath).toBe('implicit');
    expect(result.groups.map((group) => group.path)).toEqual(['root']);
    expect(result.hosts.map((host) => [host.id, host.groupName])).toEqual([['host-implicit', 'implicit']]);
  });

  it('blocks moving a group into one of its descendants or into a conflicting path', async () => {
    const { GroupRepository } = await loadRepositories();
    const groups = new GroupRepository();

    groups.create('group-root', 'root');
    groups.create('group-branch', 'branch', 'root');
    groups.create('group-leaf', 'leaf', 'root/branch');
    groups.create('group-clients', 'clients');
    groups.create('group-duplicate', 'branch', 'clients');

    expect(() => groups.move('root/branch', 'root/branch/leaf')).toThrow(
      'Group cannot be moved into itself or one of its descendants'
    );
    expect(() => groups.move('root/branch', 'clients')).toThrow('Group already exists');
  });
});

describe('GroupRepository.rename', () => {
  it('renames an explicit group subtree and rebases descendants', async () => {
    const { HostRepository, GroupRepository } = await loadRepositories();
    const hosts = new HostRepository();
    const groups = new GroupRepository();

    groups.create('group-root', 'root');
    groups.create('group-branch', 'branch', 'root');
    groups.create('group-leaf', 'leaf', 'root/branch');

    hosts.create('host-branch', {
      kind: 'ssh',
      label: 'Branch',
      hostname: 'branch.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root/branch/leaf',
      tags: [],
      terminalThemeId: null
    });

    const result = groups.rename('root/branch', 'api');

    expect(result.nextPath).toBe('root/api');
    expect(result.groups.map((group) => group.path)).toEqual(['root', 'root/api', 'root/api/leaf']);
    expect(result.hosts.map((host) => [host.id, host.groupName])).toEqual([['host-branch', 'root/api/leaf']]);
  });

  it('renames an implicit group path and rejects conflicting targets', async () => {
    const { HostRepository, GroupRepository } = await loadRepositories();
    const hosts = new HostRepository();
    const groups = new GroupRepository();

    groups.create('group-root', 'root');
    groups.create('group-api', 'api', 'root');
    hosts.create('host-implicit', {
      kind: 'ssh',
      label: 'Implicit',
      hostname: 'implicit.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      privateKeyPath: null,
      secretRef: null,
      groupName: 'root/implicit',
      tags: [],
      terminalThemeId: null
    });

    const result = groups.rename('root/implicit', 'ops');
    expect(result.nextPath).toBe('root/ops');
    expect(result.hosts.map((host) => [host.id, host.groupName])).toEqual([['host-implicit', 'root/ops']]);

    expect(() => groups.rename('root/ops', 'api')).toThrow('Group already exists');
  });
});

describe('SettingsRepository', () => {
  it('persists a login server override and resolves the effective server URL', async () => {
    const { SettingsRepository } = await loadRepositories();
    const settings = new SettingsRepository({
      getConfig: () => ({
        sync: {
          serverUrl: 'https://bundled.example.com',
          desktopClientId: 'dolgate-desktop',
          redirectUri: 'dolgate://auth/callback'
        }
      })
    } as never);

    expect(settings.get().serverUrl).toBe('https://bundled.example.com');
    expect(settings.get().serverUrlOverride).toBeNull();
    expect(settings.get().terminalScrollbackLines).toBe(5000);
    expect(settings.get().terminalWebglEnabled).toBe(true);

    const updated = settings.update({
      serverUrlOverride: 'https://custom.example.com',
      terminalScrollbackLines: 99999,
      terminalLineHeight: 2.5,
      terminalLetterSpacing: -10,
      terminalMinimumContrastRatio: 99,
      terminalAltIsMeta: true,
      terminalWebglEnabled: false
    });

    expect(updated.serverUrl).toBe('https://custom.example.com');
    expect(updated.serverUrlOverride).toBe('https://custom.example.com');
    expect(updated.terminalScrollbackLines).toBe(25000);
    expect(updated.terminalLineHeight).toBe(2);
    expect(updated.terminalLetterSpacing).toBe(0);
    expect(updated.terminalMinimumContrastRatio).toBe(21);
    expect(updated.terminalAltIsMeta).toBe(true);
    expect(updated.terminalWebglEnabled).toBe(false);

    const reset = settings.update({
      serverUrlOverride: null,
      terminalScrollbackLines: 800,
      terminalLineHeight: 0.5,
      terminalLetterSpacing: 99,
      terminalMinimumContrastRatio: 0,
      terminalAltIsMeta: false,
      terminalWebglEnabled: true
    });

    expect(reset.serverUrl).toBe('https://bundled.example.com');
    expect(reset.serverUrlOverride).toBeNull();
    expect(reset.terminalScrollbackLines).toBe(1000);
    expect(reset.terminalLineHeight).toBe(1);
    expect(reset.terminalLetterSpacing).toBe(2);
    expect(reset.terminalMinimumContrastRatio).toBe(1);
    expect(reset.terminalAltIsMeta).toBe(false);
    expect(reset.terminalWebglEnabled).toBe(true);

    const clampedLow = settings.update({
      sessionReplayRetentionCount: 2,
    });
    expect(clampedLow.sessionReplayRetentionCount).toBe(10);

    const clampedHigh = settings.update({
      sessionReplayRetentionCount: 50000,
    });
    expect(clampedHigh.sessionReplayRetentionCount).toBe(10000);
  });

  it('stores and syncs the global terminal system theme mode', async () => {
    const { SettingsRepository } = await loadRepositories();
    const settings = new SettingsRepository({
      getConfig: () => ({
        sync: {
          serverUrl: 'https://bundled.example.com',
          desktopClientId: 'dolgate-desktop',
          redirectUri: 'dolgate://auth/callback'
        }
      })
    } as never);

    const updated = settings.update({
      globalTerminalThemeId: 'system'
    });

    expect(updated.globalTerminalThemeId).toBe('system');
    expect(settings.getSyncedTerminalPreferences()).toEqual({
      id: 'global-terminal',
      globalTerminalThemeId: 'system',
      updatedAt: expect.any(String)
    });

    settings.replaceSyncedTerminalPreferences({
      id: 'global-terminal',
      globalTerminalThemeId: 'system',
      updatedAt: '2026-03-26T00:00:00.000Z'
    });

    expect(settings.get().globalTerminalThemeId).toBe('system');
  });

  it('persists shared SFTP browser column widths and clamps them to minimums', async () => {
    const { SettingsRepository } = await loadRepositories();
    const settings = new SettingsRepository({
      getConfig: () => ({
        sync: {
          serverUrl: 'https://bundled.example.com',
          desktopClientId: 'dolgate-desktop',
          redirectUri: 'dolgate://auth/callback'
        }
      })
    } as never);

    const updated = settings.update({
      sftpBrowserColumnWidths: {
        name: 420,
        dateModified: 120,
        size: 70,
        kind: 140
      }
    });

    expect(updated.sftpBrowserColumnWidths).toEqual({
      name: 420,
      dateModified: 140,
      size: 72,
      kind: 140
    });
    expect(settings.get().sftpBrowserColumnWidths).toEqual({
      name: 420,
      dateModified: 140,
      size: 72,
      kind: 140
    });
  });

  it('persists the home host view mode locally and ignores invalid updates', async () => {
    const { SettingsRepository } = await loadRepositories();
    const settings = new SettingsRepository({
      getConfig: () => ({
        sync: {
          serverUrl: 'https://bundled.example.com',
          desktopClientId: 'dolgate-desktop',
          redirectUri: 'dolgate://auth/callback'
        }
      })
    } as never);

    expect(settings.get().homeHostViewMode).toBe('grid');

    const updated = settings.update({ homeHostViewMode: 'list' });
    expect(updated.homeHostViewMode).toBe('list');
    expect(settings.get().homeHostViewMode).toBe('list');

    const invalid = settings.update({ homeHostViewMode: 'table' as never });
    expect(invalid.homeHostViewMode).toBe('list');
  });

  it('restores missing or invalid SFTP browser widths from the stored state file', async () => {
    const { SettingsRepository } = await loadRepositoriesWithStateFile({
      schemaVersion: 1,
      settings: {
        theme: 'system',
        sftpBrowserColumnWidths: {
          name: 512,
          dateModified: 'bad',
          size: null,
          kind: 48
        },
        sessionReplayRetentionCount: 100,
        serverUrlOverride: null,
        updatedAt: '2026-03-26T00:00:00.000Z'
      }
    });
    const settings = new SettingsRepository({
      getConfig: () => ({
        sync: {
          serverUrl: 'https://bundled.example.com',
          desktopClientId: 'dolgate-desktop',
          redirectUri: 'dolgate://auth/callback'
        }
      })
    } as never);

    expect(settings.get().sftpBrowserColumnWidths).toEqual({
      ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
      name: 512,
      kind: 72
    });
  });

  it('restores invalid persisted home host view mode to grid', async () => {
    const { SettingsRepository } = await loadRepositoriesWithStateFile({
      schemaVersion: 1,
      settings: {
        theme: 'system',
        homeHostViewMode: 'table',
        sftpBrowserColumnWidths: { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS },
        sessionReplayRetentionCount: 100,
        serverUrlOverride: null,
        updatedAt: '2026-03-26T00:00:00.000Z'
      }
    });
    const settings = new SettingsRepository({
      getConfig: () => ({
        sync: {
          serverUrl: 'https://bundled.example.com',
          desktopClientId: 'dolgate-desktop',
          redirectUri: 'dolgate://auth/callback'
        }
      })
    } as never);

    expect(settings.get().homeHostViewMode).toBe('grid');
  });
});

describe('PortForwardRepository', () => {
  it('stores AWS SSM port forward rules with the provided bind address', async () => {
    const { PortForwardRepository } = await loadRepositories();
    const forwards = new PortForwardRepository();

    const record = forwards.create({
      transport: 'aws-ssm',
      label: 'RDS via bastion',
      hostId: 'aws-host-1',
      bindAddress: '127.0.0.2',
      bindPort: 15432,
      targetKind: 'remote-host',
      targetPort: 5432,
      remoteHost: 'db.internal'
    });

    expect(record).toMatchObject({
      transport: 'aws-ssm',
      bindAddress: '127.0.0.2',
      bindPort: 15432,
      targetKind: 'remote-host',
      targetPort: 5432,
      remoteHost: 'db.internal'
    });
  });

  it('stores ECS task port forward rules with a fixed localhost bind address', async () => {
    const { PortForwardRepository } = await loadRepositories();
    const forwards = new PortForwardRepository();

    const record = forwards.create({
      transport: 'ecs-task',
      label: 'api task tunnel',
      hostId: 'ecs-host-1',
      bindAddress: '127.0.0.1',
      bindPort: 18080,
      serviceName: 'api',
      containerName: 'web',
      targetPort: 8080,
    });

    expect(record).toMatchObject({
      transport: 'ecs-task',
      bindAddress: '127.0.0.1',
      bindPort: 18080,
      serviceName: 'api',
      containerName: 'web',
      targetPort: 8080,
    });
  });
});

describe('ActivityLogRepository', () => {
  it('isolates logs by server and user while restoring the matching account history', async () => {
    const { ActivityLogRepository } = await loadRepositories();
    const logs = new ActivityLogRepository();

    logs.append('info', 'audit', 'user-1 log');
    expect(logs.list().map((entry) => entry.message)).toEqual(['user-1 log']);

    logs.activate({
      userId: 'user-2',
      serverUrl: TEST_HISTORY_OWNER.serverUrl,
    });
    expect(logs.list()).toEqual([]);
    logs.append('info', 'audit', 'user-2 log');

    logs.activate(TEST_HISTORY_OWNER);
    expect(logs.list().map((entry) => entry.message)).toEqual(['user-1 log']);

    logs.activate({
      userId: TEST_HISTORY_OWNER.userId,
      serverUrl: 'https://other.example.com',
    });
    expect(logs.list()).toEqual([]);

    logs.activate({
      userId: 'user-2',
      serverUrl: TEST_HISTORY_OWNER.serverUrl,
    });
    logs.clear();
    expect(logs.list()).toEqual([]);
    logs.activate(TEST_HISTORY_OWNER);
    expect(logs.list().map((entry) => entry.message)).toEqual(['user-1 log']);

    logs.deactivate();
    expect(logs.list()).toEqual([]);
  });

  it('clears hasReplay for session logs whose recording no longer exists', async () => {
    const { ActivityLogRepository } = await loadRepositories();
    const logs = new ActivityLogRepository();

    logs.upsert({
      id: 'log-keep',
      level: 'info',
      category: 'session',
      kind: 'session-lifecycle',
      message: 'ssh 세션',
      metadata: { recordingId: 'rec-keep', hasReplay: true, status: 'closed' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    logs.upsert({
      id: 'log-gone',
      level: 'info',
      category: 'session',
      kind: 'session-lifecycle',
      message: 'ssh 세션',
      metadata: { recordingId: 'rec-gone', hasReplay: true, status: 'closed' },
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    // 존재하는 녹화(rec-keep)만 전달 → 파일이 없는 rec-gone의 hasReplay만 꺼진다.
    expect(logs.reconcileReplayFlags(new Set(['rec-keep']))).toBe(1);

    const byId = new Map(logs.list().map((entry) => [entry.id, entry] as const));
    expect((byId.get('log-keep')?.metadata as { hasReplay?: boolean }).hasReplay).toBe(true);
    const goneMeta = byId.get('log-gone')?.metadata as {
      hasReplay?: boolean;
      recordingId?: string;
      status?: string;
    };
    expect(goneMeta.hasReplay).toBe(false);
    // 나머지 메타데이터(recordingId/status 등)는 보존한다.
    expect(goneMeta.recordingId).toBe('rec-gone');
    expect(goneMeta.status).toBe('closed');

    // 멱등 — 다시 호출해도 추가 변경 없음.
    expect(logs.reconcileReplayFlags(new Set(['rec-keep']))).toBe(0);
  });

  it('migrates and merges legacy unscoped logs into the first activated account', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dolgate-desktop-db-'));
    process.env.DOLSSH_USER_DATA_DIR = tempDir;
    const scope = resolveLocalHistoryScope(TEST_HISTORY_OWNER);
    const legacyRecord = {
      id: 'legacy-log',
      level: 'info',
      category: 'audit',
      kind: 'generic',
      message: 'legacy log',
      metadata: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const targetRecord = {
      ...legacyRecord,
      id: 'target-log',
      message: 'target log',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    mkdirSync(path.dirname(scope.legacyActivityLogFilePath), { recursive: true });
    mkdirSync(path.dirname(scope.activityLogFilePath), { recursive: true });
    writeFileSync(
      scope.legacyActivityLogFilePath,
      `${JSON.stringify(legacyRecord)}\n${JSON.stringify({
        ...targetRecord,
        message: 'legacy duplicate',
      })}\n`,
      'utf8',
    );
    writeFileSync(
      scope.activityLogFilePath,
      `${JSON.stringify(targetRecord)}\n`,
      'utf8',
    );

    vi.resetModules();
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    const logs = new databaseModule.ActivityLogRepository();
    logs.activate(TEST_HISTORY_OWNER);

    expect(logs.list().map((entry) => entry.id)).toEqual([
      'target-log',
      'legacy-log',
    ]);
    expect(logs.list()[0]?.message).toBe('target log');
    expect(existsSync(scope.legacyActivityLogFilePath)).toBe(false);
    expect(existsSync(scope.activityLogFilePath)).toBe(true);
  });

  it('upserts session lifecycle logs by id and restores them after reload', async () => {
    const { ActivityLogRepository } = await loadRepositories();
    const logs = new ActivityLogRepository();

    logs.upsert({
      id: 'session:session-1',
      level: 'info',
      category: 'session',
      kind: 'session-lifecycle',
      message: 'SSH 세션',
      metadata: {
        sessionId: 'session-1',
        hostId: 'host-1',
        hostLabel: 'nas',
        title: 'NAS',
        connectionKind: 'ssh',
        connectedAt: '2026-03-29T00:00:00.000Z',
        status: 'connected'
      },
      createdAt: '2026-03-29T00:00:00.000Z',
      updatedAt: '2026-03-29T00:00:00.000Z'
    });

    logs.upsert({
      id: 'session:session-1',
      level: 'error',
      category: 'session',
      kind: 'session-lifecycle',
      message: 'SSH 세션',
      metadata: {
        sessionId: 'session-1',
        hostId: 'host-1',
        hostLabel: 'nas',
        title: 'NAS',
        connectionKind: 'ssh',
        connectedAt: '2026-03-29T00:00:00.000Z',
        disconnectedAt: '2026-03-29T00:05:00.000Z',
        durationMs: 300000,
        status: 'error',
        disconnectReason: 'socket closed'
      },
      createdAt: '2026-03-29T00:00:00.000Z',
      updatedAt: '2026-03-29T00:05:00.000Z'
    });

    expect(logs.list()).toHaveLength(1);
    expect(logs.list()[0]).toMatchObject({
      id: 'session:session-1',
      kind: 'session-lifecycle',
      level: 'error',
      updatedAt: '2026-03-29T00:05:00.000Z',
      metadata: {
        hostLabel: 'nas',
        status: 'error',
        durationMs: 300000
      }
    });

    vi.resetModules();
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    stateStorageModule
      .getDesktopStateStorage()
      .activateActivityLogScope(TEST_HISTORY_OWNER);
    const reloadedLogs = new databaseModule.ActivityLogRepository();

    expect(reloadedLogs.list()).toHaveLength(1);
    expect(reloadedLogs.list()[0]).toMatchObject({
      id: 'session:session-1',
      kind: 'session-lifecycle',
      metadata: {
        hostLabel: 'nas',
        disconnectReason: 'socket closed'
      }
    });
  });

  it('restores port forward lifecycle logs after reload', async () => {
    const { ActivityLogRepository } = await loadRepositories();
    const logs = new ActivityLogRepository();

    logs.upsert({
      id: 'port-forward:rule-1:attempt-1',
      level: 'info',
      category: 'audit',
      kind: 'port-forward-lifecycle',
      message: 'RDS tunnel 포트 포워딩',
      metadata: {
        ruleId: 'rule-1',
        ruleLabel: 'RDS tunnel',
        hostId: 'host-1',
        hostLabel: 'bastion',
        transport: 'aws-ssm',
        mode: 'local',
        bindAddress: '127.0.0.1',
        bindPort: 15432,
        targetSummary: 'Remote host db.internal:5432',
        startedAt: '2026-03-29T00:00:00.000Z',
        stoppedAt: '2026-03-29T00:05:00.000Z',
        durationMs: 300000,
        status: 'closed'
      },
      createdAt: '2026-03-29T00:00:00.000Z',
      updatedAt: '2026-03-29T00:05:00.000Z'
    });

    vi.resetModules();
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    stateStorageModule
      .getDesktopStateStorage()
      .activateActivityLogScope(TEST_HISTORY_OWNER);
    const reloadedLogs = new databaseModule.ActivityLogRepository();

    expect(reloadedLogs.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'port-forward:rule-1:attempt-1',
          kind: 'port-forward-lifecycle',
          metadata: expect.objectContaining({
            ruleLabel: 'RDS tunnel',
            targetSummary: 'Remote host db.internal:5432',
            status: 'closed',
          }),
        }),
      ]),
    );
  });

  it('restores SFTP and container activity log kinds after reload', async () => {
    const { ActivityLogRepository } = await loadRepositories();
    const logs = new ActivityLogRepository();
    const createdAt = '2026-06-18T00:00:00.000Z';

    logs.upsert({
      id: 'sftp:endpoint-1',
      level: 'info',
      category: 'session',
      kind: 'sftp-lifecycle',
      message: 'SFTP 세션',
      metadata: { endpointId: 'endpoint-1' },
      createdAt,
      updatedAt: createdAt,
    });
    logs.upsert({
      id: 'container:lifecycle-1',
      level: 'info',
      category: 'session',
      kind: 'container-lifecycle',
      message: 'Containers 연결',
      metadata: { lifecycleId: 'lifecycle-1', status: 'connected' },
      createdAt,
      updatedAt: createdAt,
    });
    logs.upsert({
      id: 'container-action:action-1',
      level: 'warn',
      category: 'audit',
      kind: 'container-action',
      message: '컨테이너 삭제',
      metadata: { actionId: 'action-1', action: 'remove' },
      createdAt,
      updatedAt: createdAt,
    });

    vi.resetModules();
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    stateStorageModule
      .getDesktopStateStorage()
      .activateActivityLogScope(TEST_HISTORY_OWNER);

    expect(
      new databaseModule.ActivityLogRepository().list().map((entry) => entry.kind),
    ).toEqual(expect.arrayContaining([
      'sftp-lifecycle',
      'container-lifecycle',
      'container-action',
    ]));
  });
});

describe('KnownHostRepository', () => {
  it('stores trusted host keys by host, port, and algorithm', async () => {
    const { KnownHostRepository } = await loadRepositories();
    const knownHosts = new KnownHostRepository();

    const ed25519 = knownHosts.trust({
      hostId: 'host-1',
      hostLabel: 'Prod',
      host: 'example.com',
      port: 22,
      algorithm: 'ssh-ed25519',
      publicKeyBase64: 'AAAED25519',
      fingerprintSha256: 'SHA256:ed25519',
    });
    const ecdsa = knownHosts.trust({
      hostId: 'host-1',
      hostLabel: 'Prod',
      host: 'example.com',
      port: 22,
      algorithm: 'ecdsa-sha2-nistp256',
      publicKeyBase64: 'AAAECDSA',
      fingerprintSha256: 'SHA256:ecdsa',
    });

    expect(knownHosts.listByHostPort('example.com', 22).map((record) => record.id)).toEqual([
      ecdsa.id,
      ed25519.id,
    ]);
    expect(knownHosts.getByHostPortAlgorithm('example.com', 22, 'ssh-ed25519')?.publicKeyBase64).toBe(
      'AAAED25519',
    );
    expect(knownHosts.getByHostPortAlgorithm('example.com', 22, 'ecdsa-sha2-nistp256')?.publicKeyBase64).toBe(
      'AAAECDSA',
    );
  });

  it('updates only the matching algorithm record when trust changes', async () => {
    const { KnownHostRepository } = await loadRepositories();
    const knownHosts = new KnownHostRepository();

    const ed25519 = knownHosts.trust({
      hostId: 'host-1',
      hostLabel: 'Prod',
      host: 'example.com',
      port: 22,
      algorithm: 'ssh-ed25519',
      publicKeyBase64: 'AAAOLD',
      fingerprintSha256: 'SHA256:old',
    });
    const ecdsa = knownHosts.trust({
      hostId: 'host-1',
      hostLabel: 'Prod',
      host: 'example.com',
      port: 22,
      algorithm: 'ecdsa-sha2-nistp256',
      publicKeyBase64: 'AAAECDSA',
      fingerprintSha256: 'SHA256:ecdsa',
    });

    const replaced = knownHosts.trust({
      hostId: 'host-1',
      hostLabel: 'Prod',
      host: 'example.com',
      port: 22,
      algorithm: 'ssh-ed25519',
      publicKeyBase64: 'AAANEW',
      fingerprintSha256: 'SHA256:new',
    });

    expect(replaced.id).toBe(ed25519.id);
    expect(knownHosts.listByHostPort('example.com', 22)).toHaveLength(2);
    expect(knownHosts.getByHostPortAlgorithm('example.com', 22, 'ssh-ed25519')?.publicKeyBase64).toBe('AAANEW');
    expect(knownHosts.getByHostPortAlgorithm('example.com', 22, 'ecdsa-sha2-nistp256')?.id).toBe(ecdsa.id);
  });
});

describe('DnsOverrideRepository', () => {
  it('stores normalized hostnames linked to eligible loopback rules', async () => {
    const { PortForwardRepository, DnsOverrideRepository } = await loadRepositories();
    const forwards = new PortForwardRepository();
    const overrides = new DnsOverrideRepository();

    const rule = forwards.create({
      transport: 'aws-ssm',
      label: 'Kafka broker',
      hostId: 'aws-host-1',
      bindAddress: '127.0.0.2',
      bindPort: 9098,
      targetKind: 'remote-host',
      targetPort: 9098,
      remoteHost: 'b-1.kafka.internal'
    });

    const record = overrides.create(
      {
        type: 'linked',
        hostname: 'B-1.KAFKA.INTERNAL',
        portForwardRuleId: rule.id
      },
      forwards
    );

    expect(record).toMatchObject({
      type: 'linked',
      hostname: 'b-1.kafka.internal',
      portForwardRuleId: rule.id
    });
  });

  it('stores static overrides with validated ip addresses', async () => {
    const { PortForwardRepository, DnsOverrideRepository } = await loadRepositories();
    const forwards = new PortForwardRepository();
    const overrides = new DnsOverrideRepository();

    forwards.list();

    const record = overrides.create(
      {
        type: 'static',
        hostname: 'Kafka-Static.INTERNAL',
        address: '10.0.0.15',
      },
      forwards
    );

    expect(record).toMatchObject({
      type: 'static',
      hostname: 'kafka-static.internal',
      address: '10.0.0.15',
    });
  });
});
