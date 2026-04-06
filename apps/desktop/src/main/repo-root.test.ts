import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDesktopRepoRoot } from './repo-root';

function createRepoRootPath(...segments: string[]): string {
  if (path.sep === '\\') {
    return path.join('C:\\', ...segments);
  }
  return path.join('/', ...segments);
}

describe('resolveDesktopRepoRoot', () => {
  it('resolves the repository root from a packaged app.asar path used by smoke tests', () => {
    const repoRoot = createRepoRootPath('work', 'dolssh');
    const appPath = path.join(
      repoRoot,
      'apps',
      'desktop',
      'out',
      'dolgate-win32-x64',
      'resources',
      'app.asar',
    );
    const currentDir = path.join(appPath, '.vite', 'build');
    const exists = (candidatePath: string) =>
      candidatePath === path.join(repoRoot, 'services', 'ssh-core') ||
      candidatePath === path.join(repoRoot, 'apps', 'desktop');

    expect(resolveDesktopRepoRoot({ appPath, currentDir, exists })).toBe(repoRoot);
  });

  it('resolves the repository root from the development build directory', () => {
    const repoRoot = createRepoRootPath('work', 'dolssh');
    const appPath = path.join(repoRoot, 'apps', 'desktop');
    const currentDir = path.join(repoRoot, 'apps', 'desktop', '.vite', 'build');
    const exists = (candidatePath: string) =>
      candidatePath === path.join(repoRoot, 'services', 'ssh-core') ||
      candidatePath === path.join(repoRoot, 'apps', 'desktop');

    expect(resolveDesktopRepoRoot({ appPath, currentDir, exists })).toBe(repoRoot);
  });
});
