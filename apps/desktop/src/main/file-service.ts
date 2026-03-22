import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DirectoryListing, FileEntry, FileEntryKind } from '@shared';

function toIsoTime(valueMs: number): string {
  return new Date(valueMs).toISOString();
}

function resolveKind(stats: Awaited<ReturnType<typeof fs.lstat>>): FileEntryKind {
  if (stats.isDirectory()) {
    return 'folder';
  }
  if (stats.isFile()) {
    return 'file';
  }
  if (stats.isSymbolicLink()) {
    return 'symlink';
  }
  return 'unknown';
}

function toPermissions(mode: number): string {
  const table = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
  const owner = table[(mode >> 6) & 7];
  const group = table[(mode >> 3) & 7];
  const other = table[mode & 7];
  return `${owner}${group}${other}`;
}

function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

export class LocalFileService {
  async getHomeDirectory(): Promise<string> {
    return app.getPath('home');
  }

  async list(targetPath: string): Promise<DirectoryListing> {
    const currentPath = path.resolve(targetPath);
    const names = await fs.readdir(currentPath);
    const entries = await Promise.all(
      names.map(async (name) => {
        const entryPath = path.join(currentPath, name);
        const stats = await fs.lstat(entryPath);
        return {
          name,
          path: entryPath,
          isDirectory: stats.isDirectory(),
          size: stats.isDirectory() ? 0 : stats.size,
          mtime: toIsoTime(stats.mtimeMs),
          kind: resolveKind(stats),
          permissions: toPermissions(stats.mode)
        } satisfies FileEntry;
      })
    );

    return {
      path: currentPath,
      entries: entries.sort(compareEntries)
    };
  }

  async mkdir(parentPath: string, name: string): Promise<void> {
    const targetPath = path.join(path.resolve(parentPath), name);
    await fs.mkdir(targetPath, { recursive: false });
  }

  async rename(targetPath: string, nextName: string): Promise<void> {
    const absolutePath = path.resolve(targetPath);
    const nextPath = path.join(path.dirname(absolutePath), nextName);
    await fs.rename(absolutePath, nextPath);
  }

  async delete(paths: string[]): Promise<void> {
    await Promise.all(
      paths.map(async (targetPath) => {
        const absolutePath = path.resolve(targetPath);
        const stats = await fs.lstat(absolutePath);
        if (stats.isDirectory()) {
          await fs.rm(absolutePath, { recursive: true, force: false });
          return;
        }
        await fs.unlink(absolutePath);
      })
    );
  }
}
