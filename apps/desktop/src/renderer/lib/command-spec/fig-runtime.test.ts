import { describe, expect, it, vi } from 'vitest';
import {
  figSuggestionName,
  findArgGenerators,
  runGenerators,
  type FigExecuteCommand,
  type FigGenerator,
  type FigSpecNode,
} from './fig-runtime';

const exec = (stdout: string): FigExecuteCommand =>
  vi.fn(async () => ({ stdout, stderr: '', exitCode: 0 }));

const opts = (executeCommand: FigExecuteCommand, tokens: string[] = ['git', 'checkout', '']) => ({
  tokens,
  searchTerm: tokens[tokens.length - 1] ?? '',
  cwd: '/home/u/proj',
  executeCommand,
});

describe('runGenerators', () => {
  it('runs an array script and applies postProcess (object suggestions)', async () => {
    const executeCommand = exec('  main\n* feature\n  HEAD detached\n');
    const generator: FigGenerator = {
      script: ['git', 'branch', '--no-color'],
      postProcess: (out) =>
        out
          .split('\n')
          .filter((l) => l.trim() && !l.includes('HEAD'))
          .map((l) => ({ name: l.replace('*', '').trim(), description: 'Branch' })),
    };
    const result = await runGenerators(generator, opts(executeCommand));
    expect(result.map((s) => s.name)).toEqual(['main', 'feature']);
    expect(executeCommand).toHaveBeenCalledWith({
      command: 'git',
      args: ['branch', '--no-color'],
      cwd: '/home/u/proj',
      timeout: 2000,
    });
  });

  it('wraps a string script in sh -c', async () => {
    const executeCommand = exec('a\nb\n');
    await runGenerators({ script: 'git tag | sort', splitOn: '\n' }, opts(executeCommand));
    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'sh', args: ['-c', 'git tag | sort'] }),
    );
  });

  it('resolves a function script with the token array', async () => {
    const executeCommand = exec('x\n');
    const script = vi.fn((tokens: string[]) =>
      tokens.includes('-r') ? ['git', 'branch', '-r'] : ['git', 'branch'],
    );
    await runGenerators({ script, splitOn: '\n' }, opts(executeCommand, ['git', 'branch', '-r', '']));
    expect(script).toHaveBeenCalledWith(['git', 'branch', '-r', '']);
    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'git', args: ['branch', '-r'] }),
    );
  });

  it('splits on splitOn into plain-name suggestions', async () => {
    const result = await runGenerators(
      { script: ['echo'], splitOn: '\n' },
      opts(exec('one\ntwo\n\nthree')),
    );
    expect(result.map((s) => s.name)).toEqual(['one', 'two', 'three']);
  });

  it('yields nothing when a script has neither splitOn nor postProcess', async () => {
    // Matches the reference engine: unshaped output is not surfaced.
    const result = await runGenerators({ script: ['ls'] }, opts(exec('a\nb\n')));
    expect(result).toEqual([]);
  });

  it('runs a custom generator with the executeCommand bridge', async () => {
    const executeCommand = exec('feat-1\nfeat-2\n');
    const generator: FigGenerator = {
      custom: async (tokens, run) => {
        const { stdout } = await run({ command: 'git', args: ['branch'] });
        return stdout.trim().split('\n').map((name) => ({ name }));
      },
    };
    const result = await runGenerators(generator, opts(executeCommand));
    expect(result.map((s) => s.name)).toEqual(['feat-1', 'feat-2']);
    expect(executeCommand).toHaveBeenCalledWith({ command: 'git', args: ['branch'] });
  });

  it('returns [] when a generator throws (best-effort, never propagates)', async () => {
    const generator: FigGenerator = {
      script: ['git', 'branch'],
      postProcess: () => {
        throw new Error('boom');
      },
    };
    const result = await runGenerators(generator, opts(exec('main\n')));
    expect(result).toEqual([]);
  });

  it('combines multiple generators', async () => {
    const result = await runGenerators(
      [
        { script: ['a'], splitOn: '\n' },
        { script: ['b'], splitOn: '\n' },
      ],
      opts(exec('x\n')),
    );
    expect(result.map((s) => s.name)).toEqual(['x', 'x']);
  });

  it('drops suggestions without a name', async () => {
    const result = await runGenerators(
      { script: ['x'], postProcess: () => [{ description: 'no name' }, { name: 'ok' }] },
      opts(exec('data')),
    );
    expect(result.map((s) => s.name)).toEqual(['ok']);
  });

  it('yields nothing (and does not call postProcess) on empty output', async () => {
    const postProcess = vi.fn(() => [{ name: 'should-not-appear' }]);
    const result = await runGenerators({ script: ['x'], postProcess }, opts(exec('   \n')));
    expect(result).toEqual([]);
    expect(postProcess).not.toHaveBeenCalled();
  });
});

describe('findArgGenerators', () => {
  const gen = { script: ['docker', 'ps'], splitOn: '\n' };
  const dockerLogs: FigSpecNode = {
    name: 'docker',
    subcommands: [{ name: 'logs', args: [{ name: 'container', generators: gen }] }],
  };

  it('returns the generator for the first positional arg', () => {
    expect(findArgGenerators(dockerLogs, ['docker', 'logs', ''])).toBe(gen);
  });

  it('returns nothing for a 2nd token when the arg is not variadic', () => {
    // `docker logs <container>` takes one — no repeat.
    expect(findArgGenerators(dockerLogs, ['docker', 'logs', 'c1', ''])).toBeUndefined();
  });

  it('keeps returning a variadic arg generator for later tokens', () => {
    const cat: FigSpecNode = {
      name: 'cat',
      args: [{ name: 'file', isVariadic: true, generators: gen }],
    };
    expect(findArgGenerators(cat, ['cat', 'a', ''])).toBe(gen);
    expect(findArgGenerators(cat, ['cat', 'a', 'b', ''])).toBe(gen);
  });
});

describe('figSuggestionName', () => {
  it('takes the first name when name is an array', () => {
    expect(figSuggestionName({ name: ['co', 'checkout'] })).toBe('co');
    expect(figSuggestionName({ name: 'status' })).toBe('status');
    expect(figSuggestionName({})).toBeNull();
  });
});
