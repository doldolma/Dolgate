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
  SecretMetadataRepository: DatabaseModule['SecretMetadataRepository'];
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
    SecretMetadataRepository: databaseModule.SecretMetadataRepository,
    ActivityLogRepository: databaseModule.ActivityLogRepository
  };
}

async function loadRepositoriesWithStateFile(stateFile: unknown): Promise<{
  tempDir: string;
  HostRepository: DatabaseModule['HostRepository'];
  SettingsRepository: DatabaseModule['SettingsRepository'];
  SecretMetadataRepository: DatabaseModule['SecretMetadataRepository'];
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
    SecretMetadataRepository: databaseModule.SecretMetadataRepository,
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

  it('refreshes exact AWS profile names and clears invalid profile references', async () => {
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
    hosts.create('missing-profile-id', {
      kind: 'aws-ecs',
      label: 'missing-profile-id',
      awsProfileId: null,
      awsProfileName: 'shared-name',
      awsRegion: 'ap-northeast-2',
      awsEcsClusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/test',
      awsEcsClusterName: 'test',
    });

    const updated = hosts.refreshAwsProfileNameCaches([
      { id: 'profile-current', name: 'renamed-profile' },
      { id: 'profile-replacement', name: 'shared-name' },
    ]);

    expect(updated.map((host) => host.id)).toEqual([
      'valid-profile',
      'deleted-profile',
      'missing-profile-id',
    ]);
    expect(hosts.getById('valid-profile')).toMatchObject({
      awsProfileId: 'profile-current',
      awsProfileName: 'renamed-profile',
    });
    expect(hosts.getById('deleted-profile')).toMatchObject({
      awsProfileId: null,
      awsProfileName: '',
    });
    expect(hosts.getById('missing-profile-id')).toMatchObject({
      awsProfileId: null,
      awsProfileName: '',
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

  it('persists RDP hosts on create and reload', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    hosts.create('rdp-host-1', {
      kind: 'rdp',
      label: 'Win Box',
      groupName: 'Lab',
      tags: ['rdp'],
      terminalThemeId: null,
      hostname: '192.168.200.27',
      port: 3389,
      secretRef: 'secret-1',
    });

    vi.resetModules();
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    const reloadedHosts = new databaseModule.HostRepository();

    expect(reloadedHosts.getById('rdp-host-1')).toMatchObject({
      kind: 'rdp',
      label: 'Win Box',
      groupName: 'Lab',
      hostname: '192.168.200.27',
      port: 3389,
      secretRef: 'secret-1',
    });
  });

  // RDP 레코드에 username 을 실으면 안 된다. RDP 를 모르는 옛 빌드(1.8.10)의
  // normalizeHostRecord 가 "hostname·port·username 이 다 있으면 SSH" 로 보고 kind 를 'ssh' 로
  // 바꿔 RDP 필드를 전부 버린 뒤, 전체 스냅샷을 push 한다 — 서버는 같은 updatedAt + 다른 내용을
  // 마지막 쓰기 승리로 받으므로 모든 기기에서 그 호스트가 SSH 로 덮어써진다.
  //
  // 필드가 없으면 그 빌드는 레코드를 버리기만 한다(push 는 upsert 라 서버 사본은 살아 있다).
  // 모르는 종류를 SSH 로 바꿔 저장하던 폴백. 이것이 이번 사고의 뿌리다 — RDP 를 모르는 빌드가
  // RDP 호스트를 `kind:'ssh'` 로 고쳐 쓰고 전량 스냅샷을 push 해서, 다른 기기의 원본까지
  // 덮어썼다(서버가 같은 타임스탬프 + 다른 내용을 마지막 쓰기 승리로 받는다).
  //
  // 종류는 계속 추가되므로 이 빌드도 "다음 종류" 에 대해 같은 짓을 할 수 있다. 모르면 고치지 말고
  // 버려야 한다 — 버려도 서버 사본은 upsert 라 남고, 업데이트하면 돌아온다.
  it('모르는 종류의 호스트를 SSH 로 바꾸지 않고 버린다', async () => {
    await loadRepositories();
    const storage = await import('./state-storage');
    storage.getDesktopStateStorage().updateState((state) => {
      state.data.hosts = [
        ...state.data.hosts,
        // 새 버전이 만든 호스트. SSH 로 볼 수 있는 필드를 다 갖췄지만 종류가 다르다.
        {
          id: 'future-1',
          kind: 'telnet',
          label: 'switch',
          hostname: 'switch.example.com',
          port: 23,
          username: 'admin',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as never,
      ];
    });

    vi.resetModules();
    const reloadedStorage = await import('./state-storage');
    reloadedStorage.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    const reloaded = new databaseModule.HostRepository();

    expect(reloaded.getById('future-1')).toBeNull();
    // SSH 로 바뀐 사본이 남아 있어도 안 된다 — 그 사본이 동기화로 올라가 원본을 덮는다.
    expect(reloaded.list().some((host) => host.id === 'future-1')).toBe(false);
  });

  // `kind` 가 아예 없는 레코드도 같다. 이쪽에는 "그 필드가 없던 시절의 옛 레코드" 를 위한 폴백이
  // 남아 있었는데, 동기화 pull 은 이미 그런 레코드를 버리고 있었다(isKnownHostKind). 판정이 두
  // 계층에서 갈리면 어느 쪽이 맞는지 알 수 없는 상태로 데이터가 오간다.
  it('kind 가 없는 레코드를 SSH 로 보지 않는다', async () => {
    await loadRepositories();
    const storage = await import('./state-storage');
    storage.getDesktopStateStorage().updateState((state) => {
      state.data.hosts = [
        ...state.data.hosts,
        {
          id: 'kindless-1',
          label: 'legacy',
          hostname: 'legacy.example.com',
          port: 22,
          username: 'root',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as never,
      ];
    });

    vi.resetModules();
    const reloadedStorage = await import('./state-storage');
    reloadedStorage.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    const reloaded = new databaseModule.HostRepository();

    expect(reloaded.getById('kindless-1')).toBeNull();
  });

  // 레코드를 만드는 변환(toRdpHostRecord)과 읽는 정규화(normalizeHostRecord) 둘 다 필드를 나열해
  // 새 객체를 만든다. 어느 한쪽에서 빠뜨리면 "저장은 되는데 다시 켜면 사라지는" 증상이 된다.
  // VNC 는 호스트 종류가 늘어날 때 저장 계층 양쪽(쓰기 toHostRecord / 읽기 normalizeHostRecord)을
  // 다 채워야 한다는 것을 보여 준 사례다. 쓰기 분기가 없어서 "Create Host" 가 아무 반응 없이
  // 실패했다(Unsupported host draft type).
  it('VNC 호스트를 저장하고 다시 읽는다', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    hosts.create('vnc-1', {
      kind: 'vnc',
      label: '',
      tags: [],
      terminalThemeId: null,
      hostname: '192.168.0.10',
      port: 5900,
      shared: false,
      viewOnly: true,
    });

    // 라벨을 비워 두면 호스트 이름을 쓴다(다른 종류와 같은 규칙).
    expect(hosts.getById('vnc-1')).toMatchObject({
      kind: 'vnc',
      label: '192.168.0.10',
      hostname: '192.168.0.10',
      port: 5900,
      shared: false,
      viewOnly: true,
    });

    vi.resetModules();
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');

    // 다시 읽어도 같아야 한다 — 읽기 쪽 화이트리스트가 빠뜨리면 여기서 초기값으로 돌아간다.
    expect(new databaseModule.HostRepository().getById('vnc-1')).toMatchObject({
      kind: 'vnc',
      hostname: '192.168.0.10',
      shared: false,
      viewOnly: true,
    });
  });

  it('VNC 기본값은 저장하지 않는다', async () => {
    // 기본값이 "켜짐" 인 것은 false 만 저장한다. true/null 을 둘 다 쓰면 기본값을 나중에 바꿀 수 없다.
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    hosts.create('vnc-2', {
      kind: 'vnc',
      label: 'plain',
      tags: [],
      terminalThemeId: null,
      hostname: '192.168.0.11',
      port: 5901,
    });

    expect(hosts.getById('vnc-2')).toMatchObject({ shared: null, viewOnly: null });
  });

  it('SSM 경유 정보를 저장하고 다시 읽는다', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    hosts.create('rdp-ssm-1', {
      kind: 'rdp',
      label: 'test',
      tags: [],
      terminalThemeId: null,
      hostname: '10.0.2.181',
      port: 3389,
      awsSsm: {
        profileName: 'gw-prod',
        region: 'ap-northeast-2',
        instanceId: 'i-00c8d7296782e6ad5',
      },
    });

    vi.resetModules();
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    const reloaded = new databaseModule.HostRepository().getById('rdp-ssm-1');

    expect(reloaded).toMatchObject({
      kind: 'rdp',
      awsSsm: {
        profileName: 'gw-prod',
        region: 'ap-northeast-2',
        instanceId: 'i-00c8d7296782e6ad5',
      },
    });
  });

  it('SSM 경유 정보가 반쯤 비어 있으면 버린다', async () => {
    // 반쯤 채워진 값을 저장하면 "SSM 으로 붙는 호스트" 처럼 보이면서 접속마다 실패한다.
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    hosts.create('rdp-ssm-2', {
      kind: 'rdp',
      label: 'broken',
      tags: [],
      terminalThemeId: null,
      hostname: '10.0.2.181',
      port: 3389,
      awsSsm: {
        profileName: 'gw-prod',
        region: '',
        instanceId: 'i-00c8d7296782e6ad5',
      },
    });

    expect(hosts.getById('rdp-ssm-2')).toMatchObject({ awsSsm: null });
  });

  it('호스트를 편집해도 SSM 경유가 지워지지 않는다', async () => {
    // 편집 폼은 이 필드를 다루지 않는다(AWS 가져오기가 정한다). draft 만 보면 이름만 바꿔도 경로가
    // 사라져서 그 뒤로 직접 붙으려다 타임아웃 난다.
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    hosts.create('rdp-ssm-3', {
      kind: 'rdp',
      label: 'test',
      tags: [],
      terminalThemeId: null,
      hostname: '10.0.2.181',
      port: 3389,
      awsSsm: {
        profileName: 'gw-prod',
        region: 'ap-northeast-2',
        instanceId: 'i-00c8d7296782e6ad5',
      },
    });

    hosts.update('rdp-ssm-3', {
      kind: 'rdp',
      label: 'renamed',
      tags: [],
      terminalThemeId: null,
      hostname: '10.0.2.181',
      port: 3389,
    });

    expect(hosts.getById('rdp-ssm-3')).toMatchObject({
      label: 'renamed',
      awsSsm: { instanceId: 'i-00c8d7296782e6ad5' },
    });
  });

  it('RDP 호스트에 username 을 싣지 않는다', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    hosts.create('rdp-compat-1', {
      kind: 'rdp',
      label: 'Win Box',
      tags: [],
      terminalThemeId: null,
      hostname: '10.0.2.181',
      port: 3389,
    });

    expect(hosts.getById('rdp-compat-1')).not.toHaveProperty('username');

    vi.resetModules();
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    const reloaded = new databaseModule.HostRepository().getById('rdp-compat-1');

    expect(reloaded).toMatchObject({ kind: 'rdp' });
    expect(reloaded).not.toHaveProperty('username');
  });

  it('keeps the admin session choice across a reload', async () => {
    // 저장·복원 두 계층이 명시한 필드만 통과시키므로, 어느 한쪽을 빠뜨리면 켜 둔 관리 세션이
    // 앱을 껐다 켜면 조용히 꺼진다 — 그러면 라이선스를 쓰는 일반 세션으로 붙는다.
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    hosts.create('rdp-admin-1', {
      kind: 'rdp',
      label: 'Win Box',
      groupName: '',
      tags: [],
      terminalThemeId: null,
      hostname: '10.0.0.9',
      port: 3389,
      adminSession: true,
    });

    vi.resetModules();
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    const reloadedHosts = new databaseModule.HostRepository();

    expect(reloadedHosts.getById('rdp-admin-1')).toMatchObject({
      adminSession: true,
    });
  });

  it('leaves the admin session off unless it was asked for', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    hosts.create('rdp-admin-2', {
      kind: 'rdp',
      label: 'Win Box',
      groupName: '',
      tags: [],
      terminalThemeId: null,
      hostname: '10.0.0.9',
      port: 3389,
    });

    // null 하나로 눕힌다. false 와 null 이 섞이면 접속 경로에서 판단이 갈린다.
    expect(hosts.getById('rdp-admin-2')).toMatchObject({ adminSession: null });
  });

  it('keeps the chosen monitors across a reload', async () => {
    // 저장·복원 두 계층 모두 명시한 필드만 통과시킨다. 어느 한쪽에서 빠뜨리면 배치도에서
    // 고른 화면이 앱을 껐다 켜면 조용히 사라진다.
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    hosts.create('rdp-host-monitors', {
      kind: 'rdp',
      label: 'Multi',
      groupName: null,
      tags: [],
      terminalThemeId: null,
      hostname: 'host',
      port: 3389,
      secretRef: null,
      monitors: [
        { id: 1, label: 'Built-in', width: 3024, height: 1964 },
        { id: 2, label: 'LG HDR 4K', width: 3840, height: 2160 },
      ],
    });

    vi.resetModules();
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    const reloadedHosts = new databaseModule.HostRepository();

    expect(reloadedHosts.getById('rdp-host-monitors')).toMatchObject({
      monitors: [
        { id: 1, label: 'Built-in', width: 3024, height: 1964 },
        { id: 2, label: 'LG HDR 4K', width: 3840, height: 2160 },
      ],
    });
  });

  it('keeps the chosen monitors when an unrelated edit omits them', async () => {
    // 호스트 폼은 이 필드를 모른다. draft 에 없다고 지워버리면 이름만 바꿔도 배치가 날아간다 —
    // 인증서 핀이 같은 이유로 current 에서 이어받는다.
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    const base = {
      kind: 'rdp' as const,
      label: 'Multi',
      groupName: null,
      tags: [],
      terminalThemeId: null,
      hostname: 'host',
      port: 3389,
      secretRef: null,
    };

    hosts.create('rdp-host-keep', {
      ...base,
      monitors: [{ id: 1, label: 'Built-in', width: 3024, height: 1964 }],
    });

    const updated = hosts.update('rdp-host-keep', { ...base, label: 'Renamed' });

    expect(updated).toMatchObject({
      label: 'Renamed',
      monitors: [{ id: 1, label: 'Built-in', width: 3024, height: 1964 }],
    });
  });

  it('clears the monitor choice when the picker sends an empty list', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    const base = {
      kind: 'rdp' as const,
      label: 'Multi',
      groupName: null,
      tags: [],
      terminalThemeId: null,
      hostname: 'host',
      port: 3389,
      secretRef: null,
    };

    hosts.create('rdp-host-clear', {
      ...base,
      monitors: [{ id: 1, label: 'Built-in', width: 3024, height: 1964 }],
    });

    // 빈 배열은 "안 정했다"가 아니라 "지운다"는 뜻이다 — undefined 와 구분된다.
    const updated = hosts.update('rdp-host-clear', { ...base, monitors: [] });

    expect(updated).toMatchObject({ monitors: null });
  });

  it('stores an empty monitor choice as none at all', async () => {
    // "선택 없음"이 [] 와 null 두 모양으로 저장되면 접속 경로에서 판단이 갈린다.
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    const created = hosts.create('rdp-host-empty', {
      kind: 'rdp',
      label: 'Empty',
      groupName: null,
      tags: [],
      terminalThemeId: null,
      hostname: 'host',
      port: 3389,
      secretRef: null,
      monitors: [],
    });

    expect(created).toMatchObject({ monitors: null });
  });

  it('brings a stored RDP desktop size back inside the protocol limits', async () => {
    const { HostRepository } = await loadRepositories();
    const hosts = new HostRepository();

    // 폭은 홀수 금지, 양변은 200~8192 — 규격을 벗어난 값이 저장돼 있으면 연결 단계에서야
    // 터지므로 읽는 시점에 되돌려야 한다.
    hosts.create('rdp-host-2', {
      kind: 'rdp',
      label: 'Odd',
      groupName: null,
      tags: [],
      terminalThemeId: null,
      hostname: 'host',
      port: 3389,
      secretRef: null,
    });

    vi.resetModules();
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    const reloadedHosts = new databaseModule.HostRepository();

    expect(reloadedHosts.getById('rdp-host-2')).toMatchObject({
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
  // update() 는 필드별 명시 허용목록이라, 새 설정을 읽기 경로에만 추가하면 저장이 조용히
  // 무시된다(설정 화면의 스위치가 눌러도 안 켜진다). 실제로 그렇게 새어 나간 적이 있다.
  it('호스트 상태 표시 토글을 저장한다', async () => {
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

    expect(settings.get().hostMetricsEnabled).toBe(true);

    expect(settings.update({ hostMetricsEnabled: false }).hostMetricsEnabled).toBe(false);
    // 다시 읽어도 유지돼야 한다(저장이 아니라 반환값만 바뀌는 경우를 배제).
    expect(settings.get().hostMetricsEnabled).toBe(false);

    expect(settings.update({ hostMetricsEnabled: true }).hostMetricsEnabled).toBe(true);
    expect(settings.get().hostMetricsEnabled).toBe(true);
  });

  it('UI 언어 선택을 저장한다', async () => {
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

    // 기본값은 시스템 언어 따르기.
    expect(settings.get().language).toBe('system');

    expect(settings.update({ language: 'en' }).language).toBe('en');
    expect(settings.get().language).toBe('en');

    expect(settings.update({ language: 'system' }).language).toBe('system');
    expect(settings.get().language).toBe('system');
  });

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

    // 인위적 하한을 없앴으므로 작은 값도 그대로 저장된다(0/음수만 자연 하한 1로).
    const smallValue = settings.update({
      sessionReplayRetentionCount: 2,
    });
    expect(smallValue.sessionReplayRetentionCount).toBe(2);

    const clampedFloor = settings.update({
      sessionReplayRetentionCount: 0,
    });
    expect(clampedFloor.sessionReplayRetentionCount).toBe(1);

    // 상한은 안전상 유지된다.
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

// 호스트 이름은 tailnet 안에서만 유효하다 — 다른 tailnet 의 같은 이름은 다른 머신이다.
// 이 경계가 새면 신뢰한 적 없는 머신을 신뢰한 것으로 착각한다.
// kind 가 없는 자격증명은 SSH 용으로 본다. 이 필드가 생기기 전에 만든 것이 전부 그렇고, 잘못
// 판정하면 기존 자격증명이 SSH 목록에서 사라진다.
describe('SecretMetadataRepository credential kind', () => {
  // 정리는 파일 위쪽 전역 afterEach 가 한다(DOLSSH_USER_DATA_DIR 기준).
  it('keeps the kind and account from upsert to list', async () => {
    // upsert → 저장 → list 사이에 필드를 하나라도 흘리면 저장은 되는데 RDP 목록에 안 나온다.
    // 실제로 그렇게 깨졌던 자리라(IPC 핸들러) 체인 전체를 여기서 잠근다.
    const { SecretMetadataRepository } = await loadRepositories();
    const secrets = new SecretMetadataRepository();

    secrets.upsert({
      secretRef: 'secret:rdp',
      label: 'Win admin',
      kind: 'rdp',
      username: 'Administrator',
      domain: 'CORP',
      hasPassword: true,
      hasPassphrase: false,
    });

    const entry = secrets.list().find((item) => item.secretRef === 'secret:rdp');
    expect(entry).toMatchObject({
      kind: 'rdp',
      username: 'Administrator',
      domain: 'CORP',
      hasPassword: true,
    });
  });

  // 화질은 디스크를 다시 읽어도 남아야 한다. 화이트리스트에서 빠지면 앱을 다시 켜는 순간
  // 무손실로 돌아가고, 사용자는 설정이 저장된 줄 안다.
  it('VNC 화질이 디스크 왕복을 견딘다', async () => {
    const loaded = await loadRepositoriesWithStateFile({
      schemaVersion: 1,
      data: {
        groups: [],
        hosts: [
          {
            id: 'h-vnc',
            kind: 'vnc',
            label: 'Lab',
            tags: [],
            hostname: '10.0.0.6',
            port: 5900,
            imageQuality: 'balanced',
            groupName: null,
            terminalThemeId: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'h-vnc2',
            kind: 'vnc',
            label: 'Lab2',
            tags: [],
            hostname: '10.0.0.7',
            port: 5900,
            // 모르는 값은 무손실로 떨어져야 한다 — 조용히 뭉개진 화면을 보여주지 않는다.
            imageQuality: 'ultra',
            groupName: null,
            terminalThemeId: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        knownHosts: [],
        portForwards: [],
        secretMetadata: [],
        syncOutbox: [],
      },
      secure: { refreshToken: null, managedSecretsByRef: {} },
    });

    const hosts = new loaded.HostRepository().list();
    const first = hosts.find((host) => host.id === 'h-vnc');
    const second = hosts.find((host) => host.id === 'h-vnc2');
    expect(first && 'imageQuality' in first ? first.imageQuality : undefined).toBe('balanced');
    expect(second && 'imageQuality' in second ? second.imageQuality : undefined).toBeNull();
  });

  // 옛 빌드의 동기화 투영이 metadata 의 kind 를 떨어뜨린 적이 있다(실측: 86개 전부). 그러면
  // RDP·VNC 폼의 자격증명 목록이 비어 보인다 — 연결된 호스트의 종류로 되짚는다.
  it('kind 를 잃은 자격증명을 연결된 호스트로 되짚는다', async () => {
    const loaded = await loadRepositoriesWithStateFile({
      schemaVersion: 1,
      data: {
        groups: [],
        hosts: [
          {
            id: 'h-rdp',
            kind: 'rdp',
            label: 'Win',
            tags: [],
            hostname: '10.0.0.5',
            port: 3389,
            secretRef: 'secret:lost-rdp',
            groupName: null,
            terminalThemeId: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'h-vnc',
            kind: 'vnc',
            label: 'Lab',
            tags: [],
            hostname: '10.0.0.6',
            port: 5900,
            secretRef: 'secret:lost-vnc',
            groupName: null,
            terminalThemeId: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        knownHosts: [],
        portForwards: [],
        secretMetadata: [
          {
            secretRef: 'secret:lost-rdp',
            label: 'Win admin',
            hasPassword: true,
            hasPassphrase: false,
            linkedHostCount: 0,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            secretRef: 'secret:lost-vnc',
            label: 'Lab screen',
            hasPassword: true,
            hasPassphrase: false,
            linkedHostCount: 0,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            secretRef: 'secret:orphan',
            label: '아무 호스트도 안 씀',
            hasPassword: true,
            hasPassphrase: false,
            linkedHostCount: 0,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        syncOutbox: [],
      },
      secure: { refreshToken: null, managedSecretsByRef: {} },
    });

    const entries = new loaded.SecretMetadataRepository().list();
    const find = (ref: string) => entries.find((entry) => entry.secretRef === ref);

    expect(find('secret:lost-rdp')?.kind).toBe('rdp');
    expect(find('secret:lost-vnc')?.kind).toBe('vnc');
    // 아무 호스트도 안 쓰면 판단하지 않는다 — 틀린 종류를 씌우면 엉뚱한 폼에 나타난다.
    expect(find('secret:orphan')?.kind ?? null).toBeNull();
    // VNC 도 연결 수에 세어야 한다. 안 세면 "연결된 호스트 0개" 로 보여 지울 때 경고가 없다.
    expect(find('secret:lost-vnc')?.linkedHostCount).toBe(1);
  });

  it('treats a credential without a kind as SSH', async () => {
    const loaded = await loadRepositoriesWithStateFile({
      schemaVersion: 1,
      data: {
        groups: [],
        hosts: [],
        knownHosts: [],
        portForwards: [],
        secretMetadata: [
          {
            // 옛 항목: kind 가 없다.
            secretRef: 'secret:legacy',
            label: 'Prod password',
            hasPassword: true,
            hasPassphrase: false,
            linkedHostCount: 0,
            updatedAt: '2025-01-01T00:00:00.000Z'
          },
          {
            secretRef: 'secret:rdp',
            label: 'Win admin',
            kind: 'rdp',
            username: 'Administrator',
            domain: 'CORP',
            hasPassword: true,
            hasPassphrase: false,
            linkedHostCount: 0,
            updatedAt: '2025-01-01T00:00:00.000Z'
          }
        ],
        syncOutbox: []
      },
      secure: {
        refreshToken: null,
        managedSecretsByRef: {}
      }
    });
    const entries = new loaded.SecretMetadataRepository().list();
    const legacy = entries.find((entry) => entry.secretRef === 'secret:legacy');
    const rdp = entries.find((entry) => entry.secretRef === 'secret:rdp');

    // 옛 항목은 kind 가 비어 있고, SSH 목록의 조건(kind !== 'rdp')을 통과한다.
    expect(legacy?.kind ?? null).toBeNull();
    expect(legacy?.kind).not.toBe('rdp');
    // RDP 항목은 계정까지 그대로 살아난다.
    expect(rdp?.kind).toBe('rdp');
    expect(rdp?.username).toBe('Administrator');
    expect(rdp?.domain).toBe('CORP');
  });
});

describe('KnownHostRepository tailnet scoping', () => {
  const base = {
    hostId: 'host-1',
    hostLabel: 'Prod',
    host: 'server',
    port: 22,
    algorithm: 'ssh-ed25519',
    fingerprintSha256: 'SHA256:x',
  };

  it('keeps the same name in different tailnets apart', async () => {
    const { KnownHostRepository } = await loadRepositories();
    const knownHosts = new KnownHostRepository();

    knownHosts.trust({ ...base, publicKeyBase64: 'AAAPLAIN' });
    knownHosts.trust({ ...base, tailnetId: 'net-a', publicKeyBase64: 'AAANETA' });
    knownHosts.trust({ ...base, tailnetId: 'net-b', publicKeyBase64: 'AAANETB' });

    expect(
      knownHosts.getByHostPortAlgorithm('server', 22, 'ssh-ed25519')?.publicKeyBase64,
    ).toBe('AAAPLAIN');
    expect(
      knownHosts.getByHostPortAlgorithm('server', 22, 'ssh-ed25519', 'net-a')
        ?.publicKeyBase64,
    ).toBe('AAANETA');
    expect(
      knownHosts.getByHostPortAlgorithm('server', 22, 'ssh-ed25519', 'net-b')
        ?.publicKeyBase64,
    ).toBe('AAANETB');
    // 세 개가 각자 남아야 한다. 하나를 다른 것으로 덮어썼다면 경계가 없는 것이다.
    expect(knownHosts.list().filter((record) => record.host === 'server')).toHaveLength(3);
  });

  it('does not offer a tailnet key to a plain-network lookup', async () => {
    const { KnownHostRepository } = await loadRepositories();
    const knownHosts = new KnownHostRepository();

    knownHosts.trust({ ...base, tailnetId: 'net-a', publicKeyBase64: 'AAANETA' });

    expect(knownHosts.getByHostPortAlgorithm('server', 22, 'ssh-ed25519')).toBeNull();
    expect(knownHosts.listByHostPort('server', 22)).toEqual([]);
  });

  it('does not offer a plain-network key inside a tailnet', async () => {
    const { KnownHostRepository } = await loadRepositories();
    const knownHosts = new KnownHostRepository();

    knownHosts.trust({ ...base, publicKeyBase64: 'AAAPLAIN' });

    expect(
      knownHosts.getByHostPortAlgorithm('server', 22, 'ssh-ed25519', 'net-a'),
    ).toBeNull();
    expect(knownHosts.listByHostPort('server', 22, 'net-a')).toEqual([]);
  });

  // 예전 레코드에는 tailnetId 가 없다. 그것은 일반 네트워크에서 신뢰한 것으로 계속 읽혀야
  // 한다 — 아니면 업그레이드 직후 모든 호스트가 다시 신뢰를 물어본다.
  it('reads records saved before tailnets existed as plain-network trust', async () => {
    const { KnownHostRepository } = await loadRepositories();
    const knownHosts = new KnownHostRepository();

    knownHosts.trust({ ...base, publicKeyBase64: 'AAAPLAIN' });
    const stored = knownHosts.list().find((record) => record.host === 'server');

    expect(stored).not.toHaveProperty('tailnetId');
    expect(
      knownHosts.getByHostPortAlgorithm('server', 22, 'ssh-ed25519')?.publicKeyBase64,
    ).toBe('AAAPLAIN');
  });

  // 빈 문자열과 공백은 "일반 네트워크"와 같아야 한다. 다르게 취급하면 같은 신뢰가 둘로 갈린다.
  it('treats a blank tailnet id as the plain network', async () => {
    const { KnownHostRepository } = await loadRepositories();
    const knownHosts = new KnownHostRepository();

    knownHosts.trust({ ...base, publicKeyBase64: 'AAAPLAIN' });
    knownHosts.trust({ ...base, tailnetId: '  ', publicKeyBase64: 'AAAUPDATED' });

    expect(knownHosts.list().filter((record) => record.host === 'server')).toHaveLength(1);
    expect(
      knownHosts.getByHostPortAlgorithm('server', 22, 'ssh-ed25519')?.publicKeyBase64,
    ).toBe('AAAUPDATED');
  });

  it('updates within its own tailnet only', async () => {
    const { KnownHostRepository } = await loadRepositories();
    const knownHosts = new KnownHostRepository();

    knownHosts.trust({ ...base, tailnetId: 'net-a', publicKeyBase64: 'AAAOLD' });
    knownHosts.trust({ ...base, tailnetId: 'net-b', publicKeyBase64: 'AAAOTHER' });
    knownHosts.trust({ ...base, tailnetId: 'net-a', publicKeyBase64: 'AAANEW' });

    expect(
      knownHosts.getByHostPortAlgorithm('server', 22, 'ssh-ed25519', 'net-a')
        ?.publicKeyBase64,
    ).toBe('AAANEW');
    expect(
      knownHosts.getByHostPortAlgorithm('server', 22, 'ssh-ed25519', 'net-b')
        ?.publicKeyBase64,
    ).toBe('AAAOTHER');
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
