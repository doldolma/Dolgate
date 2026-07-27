import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  DirectoryListing,
  FileEntry,
  FileEntryKind,
  FileSystemRoot,
} from '@shared';
import { t } from './i18n';

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

function isSkippableEntryError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = 'code' in error ? String((error as NodeJS.ErrnoException).code ?? '') : '';
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

export class LocalFileService {
  async getHomeDirectory(): Promise<string> {
    return app.getPath('home');
  }

  async getDownloadsDirectory(): Promise<string> {
    return app.getPath('downloads');
  }

  // ZMODEM 다운로드 등 렌더러가 받은 바이트를 Downloads에 저장한다.
  // 같은 이름이 있으면 " (n)" 접미사로 충돌을 피하고, 최종 경로를 반환한다.
  async saveToDownloads(name: string, bytes: Uint8Array): Promise<string> {
    const dir = await this.getDownloadsDirectory();
    const safeName = path.basename(name) || 'download';
    const ext = path.extname(safeName);
    const base = safeName.slice(0, safeName.length - ext.length);
    let target = path.join(dir, safeName);
    let counter = 1;
    while (await this.pathExists(target)) {
      target = path.join(dir, `${base} (${counter})${ext}`);
      counter += 1;
    }
    await fs.writeFile(target, Buffer.from(bytes));
    return target;
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  async listRoots(): Promise<FileSystemRoot[]> {
    if (process.platform !== 'win32') {
      return [{ label: '/', path: '/' }];
    }

    const roots: FileSystemRoot[] = [];
    for (let code = 65; code <= 90; code += 1) {
      const driveLetter = String.fromCharCode(code);
      const drivePath = `${driveLetter}:\\`;
      try {
        await fs.access(drivePath);
        roots.push({
          label: `${driveLetter}:`,
          path: drivePath,
        });
      } catch {
        continue;
      }
    }
    return roots;
  }

  async getParentPath(targetPath: string): Promise<string> {
    const currentPath = path.resolve(targetPath);
    const parent = path.dirname(currentPath);
    if (parent === currentPath) {
      return currentPath;
    }
    return parent;
  }

  async list(targetPath: string): Promise<DirectoryListing> {
    const currentPath = path.resolve(targetPath);
    const names = await fs.readdir(currentPath);
    const entries: FileEntry[] = [];
    let skippedEntryCount = 0;

    for (const name of names) {
      const entryPath = path.join(currentPath, name);
      try {
        const stats = await fs.lstat(entryPath);
        entries.push({
          name,
          path: entryPath,
          isDirectory: stats.isDirectory(),
          size: stats.isDirectory() ? 0 : stats.size,
          mtime: toIsoTime(stats.mtimeMs),
          kind: resolveKind(stats),
          permissions: toPermissions(stats.mode)
        } satisfies FileEntry);
      } catch (error) {
        if (isSkippableEntryError(error)) {
          skippedEntryCount += 1;
          continue;
        }
        throw error;
      }
    }

    return {
      path: currentPath,
      entries: entries.sort(compareEntries),
      warnings:
        skippedEntryCount > 0
          ? [t('misc.skippedEntries', { count: skippedEntryCount })]
          : undefined
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

  async chmod(targetPath: string, mode: number): Promise<void> {
    await fs.chmod(path.resolve(targetPath), mode);
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
