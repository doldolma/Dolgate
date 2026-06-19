import { describe, expect, it } from 'vitest';
import { matchCommandSpec } from './match';
import type { CommandSpec } from './types';

const git: CommandSpec = {
  name: 'git',
  options: [
    { names: ['--version'], description: 'Print version' },
    { names: ['-C'], takesArg: true },
  ],
  subcommands: [
    {
      name: 'commit',
      description: 'Record changes',
      options: [
        { names: ['-m', '--message'], description: 'Commit message', takesArg: true },
        { names: ['--amend'], description: 'Amend the previous commit' },
      ],
    },
    { name: 'status', description: 'Show working tree status' },
    { name: 'stash' },
  ],
};

function texts(value: string) {
  return matchCommandSpec(git, value).map((entry) => entry.insertText);
}

describe('matchCommandSpec', () => {
  it('does not complete the bare command name (no space yet)', () => {
    expect(matchCommandSpec(git, 'git')).toEqual([]);
  });

  it('completes subcommands by prefix', () => {
    expect(texts('git c')).toEqual(['git commit']);
  });

  it('lists subcommands and flags after a trailing space', () => {
    const results = texts('git ');
    expect(results).toContain('git commit');
    expect(results).toContain('git status');
    expect(results).toContain('git --version');
  });

  it('descends into a subcommand and completes its long flag', () => {
    expect(texts('git commit --me')).toEqual(['git commit --message']);
  });

  it('offers short and long flag spellings for a dash prefix', () => {
    const results = texts('git commit -');
    expect(results).toContain('git commit -m');
    expect(results).toContain('git commit --message');
    expect(results).toContain('git commit --amend');
  });

  it('carries flag descriptions through', () => {
    const message = matchCommandSpec(git, 'git commit --m').find(
      (entry) => entry.insertText === 'git commit --message',
    );
    expect(message?.description).toBe('Commit message');
  });

  it('skips compound command lines', () => {
    expect(matchCommandSpec(git, 'git status; rm')).toEqual([]);
  });
});
