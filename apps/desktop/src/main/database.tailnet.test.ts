import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TailnetRecord } from '@shared';

// tailnet 의 auth key 는 안전 저장소를 거치는 유일한 tailnet 데이터라서, electron 을 목킹
// 하지 않는 database.test.ts 에서는 돌릴 수 없다(safeStorage 가 없어 즉시 터진다).
let tempDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'userData' ? tempDir : os.tmpdir())),
    // SettingsRepository.get() 은 기본 서버 주소를 앱 설정 파일에서 읽는다.
    getAppPath: vi.fn(() => process.cwd()),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => Buffer.from(value).toString('utf8')),
  },
}));

async function loadTailnets() {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'dolgate-tailnet-db-'));
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  vi.resetModules();

  const stateStorageModule = await import('./state-storage');
  stateStorageModule.resetDesktopStateStorageForTests();
  const { TailnetRepository } = await import('./database');
  return new TailnetRepository();
}

async function loadSettings() {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'dolgate-tailnet-db-'));
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  vi.resetModules();

  const stateStorageModule = await import('./state-storage');
  stateStorageModule.resetDesktopStateStorageForTests();
  const { SettingsRepository } = await import('./database');
  return new SettingsRepository();
}

function draft(overrides: Partial<TailnetRecord> = {}): TailnetRecord {
  return {
    id: 'net-1',
    label: 'Work',
    ephemeral: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TailnetRepository', () => {
  beforeEach(() => {
    tempDir = '';
  });

  afterEach(() => {
    delete process.env.DOLSSH_USER_DATA_DIR;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps the auth key out of the record and readable only through readAuthKey', async () => {
    const tailnets = await loadTailnets();

    const saved = tailnets.save(draft(), 'tskey-abc');

    expect(saved.hasAuthKey).toBe(true);
    expect(JSON.stringify(tailnets.list())).not.toContain('tskey-abc');
    expect(tailnets.readAuthKey('net-1')).toBe('tskey-abc');
  });

  // ephemeral 은 요청하지 않는다.
  //
  // 예전에는 auth key 가 있으면 켰다. 그러면 앱을 끌 때마다 컨트롤 플레인이 노드를 지우고,
  // 1회용 키(Tailscale 기본)는 다음 실행의 재등록이 "invalid key" 로 실패한다 — 그 tailnet 은
  // 새 키를 넣기 전까지 못 쓰게 된다. 실기기에서 그렇게 깨졌다.
  it('never asks for an ephemeral registration', async () => {
    const tailnets = await loadTailnets();

    expect(tailnets.save(draft(), 'tskey-abc').ephemeral).toBe(false);
    expect(tailnets.save(draft({ id: 'net-2' }), '').ephemeral).toBe(false);
    // 렌더러가 켜서 보내와도 무시한다.
    expect(tailnets.save(draft({ id: 'net-3', ephemeral: true }), 'tskey-abc').ephemeral).toBe(
      false,
    );
  });

  it('flips to persistent when the auth key is cleared', async () => {
    const tailnets = await loadTailnets();

    tailnets.save(draft(), 'tskey-abc');
    expect(tailnets.save(draft(), '').ephemeral).toBe(false);
  });

  it('reports no auth key for a browser-login tailnet', async () => {
    const tailnets = await loadTailnets();

    const saved = tailnets.save(draft(), '');

    expect(saved.hasAuthKey).toBe(false);
    expect(tailnets.readAuthKey('net-1')).toBeNull();
  });

  it('leaves the stored key alone when an edit omits it', async () => {
    const tailnets = await loadTailnets();

    tailnets.save(draft(), 'tskey-abc');
    const renamed = tailnets.save(draft({ label: 'Home' }));

    expect(renamed.label).toBe('Home');
    expect(renamed.hasAuthKey).toBe(true);
    expect(tailnets.readAuthKey('net-1')).toBe('tskey-abc');
  });

  it('clears the stored key when an edit passes an empty one', async () => {
    const tailnets = await loadTailnets();

    tailnets.save(draft(), 'tskey-abc');
    const cleared = tailnets.save(draft(), '');

    expect(cleared.hasAuthKey).toBe(false);
    expect(tailnets.readAuthKey('net-1')).toBeNull();
  });

  it('preserves createdAt across edits and moves updatedAt', async () => {
    const tailnets = await loadTailnets();

    const created = tailnets.save(draft());
    const edited = tailnets.save(
      draft({ label: 'Home', createdAt: '2030-01-01T00:00:00.000Z' }),
    );

    expect(edited.createdAt).toBe(created.createdAt);
    expect(edited.createdAt).not.toBe('2030-01-01T00:00:00.000Z');
    expect(tailnets.list()).toHaveLength(1);
  });

  it('drops the stored key along with the record', async () => {
    const tailnets = await loadTailnets();

    tailnets.save(draft(), 'tskey-abc');
    tailnets.save(draft({ id: 'net-2', label: 'Other' }), 'tskey-other');
    tailnets.remove('net-1');

    expect(tailnets.list().map((item) => item.id)).toEqual(['net-2']);
    expect(tailnets.readAuthKey('net-1')).toBeNull();
    expect(tailnets.readAuthKey('net-2')).toBe('tskey-other');
  });

  it('reads a state file written before data.tailnets existed', async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'dolgate-tailnet-db-'));
    process.env.DOLSSH_USER_DATA_DIR = tempDir;
    // 업그레이드하는 기존 사용자가 지나는 경로다: data.tailnets 가 아예 없다.
    // secure 쪽 키를 심어 두고 그것이 읽히는지 봐야 파일이 실제로 읽혔음이 증명된다
    // (빈 목록만 확인하면 파일을 못 찾았을 때도 통과해 버린다).
    mkdirSync(path.join(tempDir, 'storage'), { recursive: true });
    writeFileSync(
      path.join(tempDir, 'storage', 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        data: {},
        secure: {
          tailnetAuthKeysById: {
            'net-old': {
              encrypted: true,
              value: Buffer.from('tskey-old', 'utf8').toString('base64'),
            },
          },
        },
      }),
      'utf8',
    );
    vi.resetModules();
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const { TailnetRepository } = await import('./database');
    const tailnets = new TailnetRepository();

    expect(tailnets.readAuthKey('net-old')).toBe('tskey-old');
    expect(tailnets.list()).toEqual([]);
    expect(tailnets.save(draft(), 'tskey-abc').hasAuthKey).toBe(true);
  });

  it('survives a reload so a restart keeps the key', async () => {
    const tailnets = await loadTailnets();
    tailnets.save(draft(), 'tskey-abc');

    // 같은 userData 를 가리킨 채 스토리지만 다시 읽는다.
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const { TailnetRepository } = await import('./database');
    const reloaded = new TailnetRepository();

    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.readAuthKey('net-1')).toBe('tskey-abc');
  });
});

describe('TailnetRepository sync payloads', () => {
  beforeEach(() => {
    tempDir = '';
  });

  afterEach(() => {
    delete process.env.DOLSSH_USER_DATA_DIR;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 동기화에 올릴 때는 키가 들어가야 한다. 서버는 암호문만 보관하므로(E2EE) 안전하고,
  // 키가 빠지면 다른 기기에서 브라우저 로그인 없이 붙을 수가 없다.
  it('includes the auth key in the sync payload', async () => {
    const tailnets = await loadTailnets();
    tailnets.save(draft(), 'tskey-abc');
    tailnets.save(draft({ id: 'net-2', label: 'Browser' }), '');

    const payloads = tailnets.listPayloads();

    expect(payloads).toHaveLength(2);
    expect(payloads.find((item) => item.id === 'net-1')?.authKey).toBe('tskey-abc');
    // 브라우저 로그인 tailnet 은 키가 없다. 빈 문자열이 아니라 없어야 한다.
    expect(payloads.find((item) => item.id === 'net-2')).not.toHaveProperty('authKey');
  });

  // 렌더러로 가는 list() 에는 절대 실리지 않는다.
  it('keeps the auth key out of the renderer-facing list', async () => {
    const tailnets = await loadTailnets();
    tailnets.save(draft(), 'tskey-abc');

    expect(JSON.stringify(tailnets.list())).not.toContain('tskey-abc');
    expect(JSON.stringify(tailnets.listPayloads())).toContain('tskey-abc');
  });

  // 다른 기기에서 내려온 것을 적용하는 경로.
  it('restores records and keys together when applying a remote snapshot', async () => {
    const tailnets = await loadTailnets();

    tailnets.replaceAll([
      { ...draft({ label: 'Work' }), authKey: 'tskey-remote' },
      { ...draft({ id: 'net-2', label: 'Browser' }) },
    ]);

    expect(tailnets.list().map((item) => item.id)).toEqual(['net-1', 'net-2']);
    expect(tailnets.readAuthKey('net-1')).toBe('tskey-remote');
    expect(tailnets.readAuthKey('net-2')).toBeNull();
  });

  // 원격 레코드가 ephemeral 을 켜서 내려와도 켜지 않는다 — 다른 기기의 옛 값이 이 기기의
  // 등록 방식을 바꾸면 안 된다. hasAuthKey 는 반대로 실제 적용된 키에서 다시 계산한다.
  it('never turns on ephemeral from a remote record', async () => {
    const tailnets = await loadTailnets();

    tailnets.replaceAll([
      { ...draft({ ephemeral: true }), authKey: 'tskey-remote' },
      { ...draft({ id: 'net-2', ephemeral: true }) },
    ]);

    const [withKey, withoutKey] = tailnets.list();
    expect(withKey.ephemeral).toBe(false);
    expect(withKey.hasAuthKey).toBe(true);
    expect(withoutKey.ephemeral).toBe(false);
    expect(withoutKey.hasAuthKey).toBe(false);
  });

  // 로그아웃하면 로컬에 남지 않아야 한다 — 키까지.
  it('clears records and keys when applying an empty snapshot', async () => {
    const tailnets = await loadTailnets();
    tailnets.save(draft(), 'tskey-abc');

    tailnets.replaceAll([]);

    expect(tailnets.list()).toEqual([]);
    expect(tailnets.readAuthKey('net-1')).toBeNull();
  });
});

// 호스트의 tailnetId 는 두 화이트리스트를 지난다: 저장할 때 toSshHostRecord, 디스크에서
// 읽을 때 normalizeHostRecord. 둘 다 필드를 나열해 새 객체를 만들기 때문에, 빠뜨리면
// 조용히 사라진다 — 폼에서 골랐는데 저장이 안 되거나, 저장은 됐는데 재시작하면 없다.
describe('SSH host tailnetId survives the whitelists', () => {
  async function loadHosts() {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'dolgate-host-tailnet-'));
    process.env.DOLSSH_USER_DATA_DIR = tempDir;
    vi.resetModules();
    const stateStorageModule = await import('./state-storage');
    stateStorageModule.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    return {
      hosts: new databaseModule.HostRepository(),
      reload: async () => {
        const storage = await import('./state-storage');
        storage.resetDesktopStateStorageForTests();
        const db = await import('./database');
        return new db.HostRepository();
      },
    };
  }

  function rdpDraft(tailnetId?: string | null) {
    return {
      kind: 'rdp' as const,
      label: 'Win Box',
      hostname: '10.0.0.9',
      port: 3389,
      username: 'Administrator',
      tailnetId,
    };
  }

  function sshDraft(tailnetId?: string | null) {
    return {
      kind: 'ssh' as const,
      label: 'Prod',
      hostname: 'server',
      port: 22,
      username: 'root',
      authType: 'password' as const,
      tailnetId,
    };
  }

  it('keeps the chosen tailnet when saving', async () => {
    const { hosts } = await loadHosts();

    const created = hosts.create('host-1', sshDraft('net-a'));

    expect(created.kind).toBe('ssh');
    expect((created as { tailnetId?: string | null }).tailnetId).toBe('net-a');
  });

  it('keeps it across a reload', async () => {
    const { hosts, reload } = await loadHosts();
    hosts.create('host-1', sshDraft('net-a'));

    const reloaded = await reload();
    const record = reloaded.getById('host-1');

    expect((record as { tailnetId?: string | null } | null)?.tailnetId).toBe('net-a');
  });

  it('stores no tailnet when the form left it unset', async () => {
    const { hosts, reload } = await loadHosts();
    hosts.create('host-1', sshDraft(null));
    hosts.create('host-2', sshDraft('  '));

    const reloaded = await reload();
    for (const id of ['host-1', 'host-2']) {
      const record = reloaded.getById(id) as { tailnetId?: string | null } | null;
      expect(record?.tailnetId ?? null).toBeNull();
    }
  });

  // 편집으로 해제하는 경로.
  it('clears the tailnet when the host stops using one', async () => {
    const { hosts, reload } = await loadHosts();
    hosts.create('host-1', sshDraft('net-a'));

    hosts.update('host-1', sshDraft(null));

    const reloaded = await reload();
    const record = reloaded.getById('host-1') as { tailnetId?: string | null } | null;
    expect(record?.tailnetId ?? null).toBeNull();
  });

  it('clears the tailnet from every host when the network setting is deleted', async () => {
    const { hosts, reload } = await loadHosts();
    const { TailnetRepository } = await import('./database');
    const tailnets = new TailnetRepository();
    tailnets.save(draft({ id: 'net-a' }));
    tailnets.save(draft({ id: 'net-b' }));
    hosts.create('host-1', sshDraft('net-a'));
    hosts.create('host-2', { ...sshDraft('net-a'), label: 'Staging' });
    hosts.create('host-3', { ...sshDraft('net-b'), label: 'Other network' });

    tailnets.remove('net-a');

    const reloaded = await reload();
    expect((reloaded.getById('host-1') as { tailnetId?: string | null })?.tailnetId).toBeNull();
    expect((reloaded.getById('host-2') as { tailnetId?: string | null })?.tailnetId).toBeNull();
    expect((reloaded.getById('host-3') as { tailnetId?: string | null })?.tailnetId).toBe(
      'net-b',
    );
  });

  it('keeps the per-device RDP monitor choice out of the host record', async () => {
    // 모니터 선택은 기기 로컬 설정에 있다. 호스트 레코드는 동기화 대상이라, 거기 들어가면
    // 다른 기기에서 고른 배치가 넘어와 없는 화면을 가리킨다.
    const { hosts } = await loadHosts();
    const databaseModule = await import('./database');
    const settings = new databaseModule.SettingsRepository();
    hosts.create('rdp-1', rdpDraft());

    const monitors = [{ id: 7, label: 'LG', width: 2560, height: 1440 }];
    settings.update({ rdpMonitorsByHostId: { 'rdp-1': monitors } });

    const storage = await import('./state-storage');
    storage.resetDesktopStateStorageForTests();
    const reloadedDb = await import('./database');
    const reloadedSettings = new reloadedDb.SettingsRepository();

    expect(reloadedSettings.get().rdpMonitorsByHostId).toEqual({ 'rdp-1': monitors });
    const reloadedHosts = new reloadedDb.HostRepository();
    expect(
      (reloadedHosts.getById('rdp-1') as { monitors?: unknown })?.monitors ?? null,
    ).toBeNull();
  });

  it('forgets the per-device monitor choice when the host is deleted', async () => {
    // 남겨 두면 없는 호스트의 설정이 쌓이고, 같은 id 가 재사용되면 엉뚱한 배치가 되살아난다.
    const { hosts } = await loadHosts();
    const databaseModule = await import('./database');
    const settings = new databaseModule.SettingsRepository();
    hosts.create('rdp-1', rdpDraft());
    settings.update({
      rdpMonitorsByHostId: { 'rdp-1': [{ id: 7, label: 'LG', width: 2560, height: 1440 }] },
    });

    hosts.remove('rdp-1');

    expect(settings.get().rdpMonitorsByHostId).toEqual({});
  });

  it('moves a legacy single shared folder into the drives list', async () => {
    // 이관하지 않으면 기존 사용자의 공유가 조용히 사라진다 — 원격에 드라이브가 안 뜨는데
    // 설정 화면에도 아무것도 없어서 왜 없어졌는지 알 수 없다.
    const { hosts } = await loadHosts();
    hosts.create('rdp-1', rdpDraft());

    // 옛 빌드가 남긴 모양을 직접 만든다(폼은 더 이상 이 필드를 쓰지 않는다).
    const storage = await import('./state-storage');
    storage.getDesktopStateStorage().updateState((state) => {
      state.data.hosts = state.data.hosts.map((host) =>
        host.id === 'rdp-1'
          ? { ...host, drives: null, drivePath: '/Users/me/docs', driveReadOnly: true }
          : host,
      );
    });

    storage.resetDesktopStateStorageForTests();
    const databaseModule = await import('./database');
    const reloaded = new databaseModule.HostRepository();

    expect((reloaded.getById('rdp-1') as { drives?: unknown })?.drives).toEqual([
      { path: '/Users/me/docs', readOnly: true },
    ]);
  });

  it('clears the tailnet from RDP hosts too', async () => {
    // SSH 와 RDP 가 같은 필드를 쓴다. 한쪽만 정리하면 그 종류만 없는 tailnet 을 가리킨 채 남아
    // 연결할 수 없게 된다 — 화면에는 tailnet 이름이 비어 보이는데 저장된 값은 살아 있다.
    const { hosts, reload } = await loadHosts();
    const { TailnetRepository } = await import('./database');
    const tailnets = new TailnetRepository();
    tailnets.save(draft({ id: 'net-a' }));
    hosts.create('rdp-1', rdpDraft('net-a'));

    tailnets.remove('net-a');

    const reloaded = await reload();
    expect((reloaded.getById('rdp-1') as { tailnetId?: string | null })?.tailnetId).toBeNull();
  });
});

// get() 은 필드를 하나하나 나열하는 화이트리스트라, 새 설정을 빠뜨리면 저장은 되는데 읽을
// 때 사라진다. 노드 이름은 이 값이 코어로 나가는 유일한 통로라, 빠지면 화면에는 저장된 것처럼
// 보이면서 컨트롤 플레인의 이름은 영영 안 바뀐다 — 아무도 버그로 신고하지 않는 종류의 실패다.
describe('SettingsRepository tailnet node name', () => {
  beforeEach(() => {
    tempDir = '';
  });

  afterEach(() => {
    delete process.env.DOLSSH_USER_DATA_DIR;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reads back a saved node name', async () => {
    const settings = await loadSettings();

    expect(settings.get().tailnetHostname).toBeNull();

    settings.update({ tailnetHostname: 'work-laptop' });
    expect(settings.get().tailnetHostname).toBe('work-laptop');
  });

  it('treats a blank name as unset so the core falls back to its default', async () => {
    const settings = await loadSettings();
    settings.update({ tailnetHostname: 'work-laptop' });

    settings.update({ tailnetHostname: '   ' });
    expect(settings.get().tailnetHostname).toBeNull();

    settings.update({ tailnetHostname: 'work-laptop' });
    settings.update({ tailnetHostname: null });
    expect(settings.get().tailnetHostname).toBeNull();
  });

  // 다른 설정을 바꿀 때 이름이 날아가면, 사용자는 자기가 지운 적 없는 값이 사라진 것을 본다.
  it('survives an unrelated settings update', async () => {
    const settings = await loadSettings();
    settings.update({ tailnetHostname: 'work-laptop' });

    settings.update({ theme: 'dark' });
    expect(settings.get().tailnetHostname).toBe('work-laptop');
  });
});
