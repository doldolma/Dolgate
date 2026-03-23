import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mockedHomeDirectory = '/Users/tester';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'home' ? mockedHomeDirectory : os.tmpdir()))
  }
}));

import { LocalFileService } from './file-service';

describe('LocalFileService', () => {
  let tempDir: string;
  const service = new LocalFileService();

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dolssh-file-service-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('lists entries with folders first and file metadata attached', async () => {
    await fs.mkdir(path.join(tempDir, 'folder'));
    await fs.writeFile(path.join(tempDir, 'zeta.txt'), 'zeta');
    await fs.writeFile(path.join(tempDir, 'alpha.txt'), 'alpha');

    const listing = await service.list(tempDir);

    expect(listing.path).toBe(tempDir);
    expect(listing.entries.map((entry) => entry.name)).toEqual(['folder', 'alpha.txt', 'zeta.txt']);
    expect(listing.entries[0]).toMatchObject({
      name: 'folder',
      isDirectory: true,
      kind: 'folder',
      size: 0
    });
    expect(listing.entries[1]).toMatchObject({
      name: 'alpha.txt',
      isDirectory: false,
      kind: 'file',
      size: 5
    });
    expect(listing.entries[1]?.permissions).toHaveLength(9);
    expect(listing.warnings).toBeUndefined();
  });

  it('supports home lookup, mkdir, rename, parent lookup, and delete', async () => {
    mockedHomeDirectory = '/Users/smoke';

    expect(await service.getHomeDirectory()).toBe('/Users/smoke');
    expect(await service.getParentPath(path.join(tempDir, 'nested', 'child'))).toBe(path.join(tempDir, 'nested'));

    await service.mkdir(tempDir, 'created');
    await fs.writeFile(path.join(tempDir, 'created', 'before.txt'), 'payload');

    await service.rename(path.join(tempDir, 'created', 'before.txt'), 'after.txt');
    await expect(fs.readFile(path.join(tempDir, 'created', 'after.txt'), 'utf8')).resolves.toBe('payload');

    await service.delete([path.join(tempDir, 'created', 'after.txt'), path.join(tempDir, 'created')]);

    await expect(fs.access(path.join(tempDir, 'created'))).rejects.toThrow();
  });
});
