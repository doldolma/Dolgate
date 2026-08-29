import { describe, expect, it } from 'vitest';
import {
  buildListCommand,
  parsePathListing,
  resolveDynamicCompletion,
  shellEscape,
  type GeneratorCompletionRequest,
  type PathCompletionRequest,
} from './dynamic';
import type { CommandSpec } from './types';

const cd: CommandSpec = {
  name: 'cd',
  args: [{ name: 'directory', template: 'folders' }],
};

const vim: CommandSpec = {
  name: 'vim',
  args: [{ name: 'file', template: 'filepaths' }],
};

const git: CommandSpec = {
  name: 'git',
  subcommands: [
    {
      name: 'checkout',
      args: [{ name: 'branch', hasGenerator: true }],
    },
  ],
};

describe('resolveDynamicCompletion', () => {
  it('returns null while typing the bare command', () => {
    expect(resolveDynamicCompletion(null, 'vim')).toBeNull();
  });

  it('returns null for compound lines', () => {
    expect(resolveDynamicCompletion(null, 'cat a/b && ls /')).toBeNull();
  });

  it('triggers on a path-like token without any spec (heuristic)', () => {
    const request = resolveDynamicCompletion(null, 'vim ./src/comp');
    expect(request).toEqual<PathCompletionRequest>({
      kind: 'path',
      before: 'vim ',
      dir: './src/',
      base: 'comp',
      foldersOnly: false,
    });
  });

  it('treats a tilde token as path-like', () => {
    const request = resolveDynamicCompletion(null, 'cat ~/no');
    expect(request?.kind).toBe('path');
    expect((request as PathCompletionRequest).dir).toBe('~/');
    expect((request as PathCompletionRequest).base).toBe('no');
  });

  it('does not trigger on a non-path argument without a spec', () => {
    expect(resolveDynamicCompletion(null, 'git commit -m mess')).toBeNull();
  });

  it('completes common filesystem commands without the bundled catalogue', () => {
    expect(resolveDynamicCompletion(null, 'cd sr')).toEqual<PathCompletionRequest>({
      kind: 'path',
      before: 'cd ',
      dir: '',
      base: 'sr',
      foldersOnly: true,
    });
    expect(resolveDynamicCompletion(null, 'ls pac')).toEqual<PathCompletionRequest>({
      kind: 'path',
      before: 'ls ',
      dir: '',
      base: 'pac',
      foldersOnly: false,
    });
  });

  it('triggers via the filepaths template even without a slash', () => {
    const request = resolveDynamicCompletion(vim, 'vim REAaa');
    expect(request).toEqual<PathCompletionRequest>({
      kind: 'path',
      before: 'vim ',
      dir: '',
      base: 'REAaa',
      foldersOnly: false,
    });
  });

  it('marks folders-only for the folders template', () => {
    const request = resolveDynamicCompletion(cd, 'cd sr');
    expect(request).toEqual<PathCompletionRequest>({
      kind: 'path',
      before: 'cd ',
      dir: '',
      base: 'sr',
      foldersOnly: true,
    });
  });

  it('emits a generator request for a generator-bearing subcommand arg', () => {
    const request = resolveDynamicCompletion(git, 'git checkout ma');
    expect(request).toEqual<GeneratorCompletionRequest>({
      kind: 'generator',
      command: 'git',
      tokens: ['git', 'checkout', 'ma'],
      before: 'git checkout ',
      base: 'ma',
    });
  });

  it('stops offering a non-variadic generator arg once it is filled', () => {
    // `git checkout <branch>` takes one positional — the 2nd token must not
    // re-trigger the branch generator.
    expect(resolveDynamicCompletion(git, 'git checkout main ')).toBeNull();
  });

  it('keeps offering a variadic generator arg for later tokens', () => {
    const variadic: CommandSpec = {
      name: 'scp',
      args: [{ name: 'src', variadic: true, hasGenerator: true }],
    };
    const request = resolveDynamicCompletion(variadic, 'scp a b');
    expect(request?.kind).toBe('generator');
    expect((request as GeneratorCompletionRequest).base).toBe('b');
  });

  it('prefers a generator arg over the path heuristic (branch contains "/")', () => {
    const request = resolveDynamicCompletion(git, 'git checkout feat/');
    expect(request?.kind).toBe('generator');
    expect((request as GeneratorCompletionRequest).tokens).toEqual([
      'git',
      'checkout',
      'feat/',
    ]);
    expect((request as GeneratorCompletionRequest).base).toBe('feat/');
  });
});

describe('buildListCommand', () => {
  const make = (dir: string): PathCompletionRequest => ({
    kind: 'path',
    before: '',
    dir,
    base: '',
    foldersOnly: false,
  });

  it('lists the cwd when the token has no directory part', () => {
    expect(buildListCommand(make(''), '/home/u')).toBe("ls -1Ap -- '/home/u'");
  });

  it('anchors a relative dir to the cwd', () => {
    expect(buildListCommand(make('src/'), '/home/u/proj')).toBe(
      "ls -1Ap -- '/home/u/proj/src/'",
    );
  });

  it('keeps an absolute dir as-is', () => {
    expect(buildListCommand(make('/etc/'), '/home/u')).toBe("ls -1Ap -- '/etc/'");
  });

  it('keeps the tilde unquoted so the shell expands it', () => {
    expect(buildListCommand(make('~/conf ig/'), '/home/u')).toBe(
      "ls -1Ap -- ~'/conf ig/'",
    );
  });

  it('escapes single quotes in the path', () => {
    expect(shellEscape("a'b")).toBe("'a'\\''b'");
  });
});

describe('parsePathListing', () => {
  const request: PathCompletionRequest = {
    kind: 'path',
    before: 'vim ',
    dir: './src/',
    base: 'co',
    foldersOnly: false,
  };

  it('filters by basename prefix and builds full insertText', () => {
    const out = parsePathListing(
      'components/\ncore.ts\nmain.ts\ncontext.tsx\n',
      request,
    );
    expect(out.map((entry) => entry.insertText)).toEqual([
      'vim ./src/components/',
      'vim ./src/core.ts',
      'vim ./src/context.tsx',
    ]);
  });

  it('keeps only directories when foldersOnly', () => {
    const out = parsePathListing('components/\ncore.ts\nconfig/\n', {
      ...request,
      foldersOnly: true,
    });
    expect(out.map((entry) => entry.insertText)).toEqual([
      'vim ./src/components/',
      'vim ./src/config/',
    ]);
  });

  it('drops an entry identical to what was typed', () => {
    const out = parsePathListing('co\ncore.ts\n', request);
    expect(out.map((entry) => entry.insertText)).toEqual(['vim ./src/core.ts']);
  });
});
