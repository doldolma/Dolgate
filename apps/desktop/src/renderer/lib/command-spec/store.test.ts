import { describe, expect, it } from 'vitest';
import { findArgGenerators, runGenerators } from './fig-runtime';
import { parseDockerContainerRows } from './module-overrides';
import {
  hasCommandSpec,
  loadCommandModule,
  loadCommandSpec,
} from './store';

describe('command spec store', () => {
  it('reports availability from the bundled index', () => {
    expect(hasCommandSpec('git')).toBe(true);
    expect(hasCommandSpec('definitely-not-a-real-command')).toBe(false);
  });

  it('lazily loads a bundled spec and caches it', async () => {
    const spec = await loadCommandSpec('git');
    expect(spec?.name).toBe('git');
    expect(spec?.subcommands?.some((sub) => sub.name === 'commit')).toBe(true);
    // Second load returns the cached instance.
    expect(await loadCommandSpec('git')).toBe(spec);
  });

  it('returns null for unavailable commands', async () => {
    expect(await loadCommandSpec('definitely-not-a-real-command')).toBeNull();
  });

  it('overrides docker container generators with the faster tabular ps format', async () => {
    const spec = await loadCommandModule('docker');
    expect(spec?.subcommands?.some((sub) => sub.name === 'logs')).toBe(true);

    const generator = findArgGenerators(spec!, ['docker', 'logs', '']);
    expect(generator).toMatchObject({
      script: ['docker', 'ps', '--format', '{{.Names}}\t{{.Image}}'],
    });

    const executeCommand = async () => ({
      stdout: 'web\tnginx\napi\trepo/app:1\n',
      stderr: '',
      exitCode: 0,
    });
    const suggestions = await runGenerators(generator, {
      tokens: ['docker', 'logs', ''],
      searchTerm: '',
      cwd: '/home/u',
      executeCommand,
    });

    expect(suggestions).toEqual([
      {
        name: 'web',
        displayName: 'web (nginx)',
        icon: 'fig://icon?type=docker',
        type: 'arg',
      },
      {
        name: 'api',
        displayName: 'api (repo/app:1)',
        icon: 'fig://icon?type=docker',
        type: 'arg',
      },
    ]);
  });

  it('parses docker tabular container rows without relying on generated modules', () => {
    expect(parseDockerContainerRows('web\tnginx\napi\trepo/app:1\n')).toEqual([
      {
        name: 'web',
        displayName: 'web (nginx)',
        icon: 'fig://icon?type=docker',
      },
      {
        name: 'api',
        displayName: 'api (repo/app:1)',
        icon: 'fig://icon?type=docker',
      },
    ]);
  });
});
