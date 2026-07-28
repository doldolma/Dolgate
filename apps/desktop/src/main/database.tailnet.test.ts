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

  // 인증 방식이 ephemeral 여부를 정한다. auth key 면 재등록이 자동이라 노드를 지워도
  // 사용자가 못 느끼지만, 브라우저 로그인이면 지워질 때마다 다시 로그인해야 한다.
  it('registers an auth-key tailnet as ephemeral', async () => {
    const tailnets = await loadTailnets();

    expect(tailnets.save(draft(), 'tskey-abc').ephemeral).toBe(true);
  });

  it('keeps a browser-login tailnet persistent so the login lasts', async () => {
    const tailnets = await loadTailnets();

    expect(tailnets.save(draft(), '').ephemeral).toBe(false);
  });

  it('ignores whatever the renderer claimed about ephemeral', async () => {
    const tailnets = await loadTailnets();

    // 렌더러가 반대로 보내와도 저장된 키가 진실이다.
    expect(tailnets.save(draft({ ephemeral: false }), 'tskey-abc').ephemeral).toBe(true);
    expect(tailnets.save(draft({ id: 'net-2', ephemeral: true }), '').ephemeral).toBe(false);
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

  // ephemeral 은 인증 방식이 정한다. 원격 레코드가 반대로 적혀 있어도 키 유무가 진실이다.
  it('recomputes ephemeral from the applied key, not the remote record', async () => {
    const tailnets = await loadTailnets();

    tailnets.replaceAll([
      { ...draft({ ephemeral: false }), authKey: 'tskey-remote' },
      { ...draft({ id: 'net-2', ephemeral: true }) },
    ]);

    const [withKey, withoutKey] = tailnets.list();
    expect(withKey.ephemeral).toBe(true);
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
});
