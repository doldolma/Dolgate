import { existsSync } from 'node:fs';
import path from 'node:path';

export function buildRepoRootCandidates(basePath: string, maxDepth = 10): string[] {
  const candidates: string[] = [];
  let currentPath = path.resolve(basePath);
  candidates.push(currentPath);

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const parentPath = path.resolve(currentPath, '..');
    if (parentPath === currentPath) {
      break;
    }
    candidates.push(parentPath);
    currentPath = parentPath;
  }

  return candidates;
}

export function resolveDesktopRepoRoot(input: {
  appPath: string;
  currentDir: string;
  exists?: (candidatePath: string) => boolean;
  maxDepth?: number;
}): string {
  const exists = input.exists ?? existsSync;
  const maxDepth = input.maxDepth ?? 10;
  const candidates = [
    ...buildRepoRootCandidates(input.appPath, maxDepth),
    ...buildRepoRootCandidates(input.currentDir, maxDepth),
  ];

  for (const candidate of new Set(candidates)) {
    if (
      exists(path.join(candidate, 'services', 'ssh-core')) &&
      exists(path.join(candidate, 'apps', 'desktop'))
    ) {
      return candidate;
    }
  }

  throw new Error(
    `Repository root could not be resolved from appPath=${input.appPath} and __dirname=${input.currentDir}`,
  );
}
