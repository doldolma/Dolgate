import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function collectFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(fullPath);
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
      return [];
    }
    return [fullPath];
  });
}

describe('renderer desktopApi boundaries', () => {
  it('keeps desktopApi usage out of components, shells, controllers, view-models, and terminal runtime', () => {
    const rendererRoot = __dirname;
    const files = [
      ...collectFiles(path.join(rendererRoot, 'components')),
      ...collectFiles(path.join(rendererRoot, 'shells')),
      ...collectFiles(path.join(rendererRoot, 'controllers')),
      ...collectFiles(path.join(rendererRoot, 'view-models')),
      path.join(rendererRoot, 'App.tsx'),
      path.join(rendererRoot, 'lib', 'terminal-runtime.ts'),
    ];

    const violations = files.filter((filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');
      return (
        source.includes('desktopApi.') ||
        source.includes("from '../services/desktopApi'") ||
        source.includes('from "../services/desktopApi"') ||
        source.includes('window.dolssh')
      );
    });

    expect(violations).toEqual([]);
  });
});
