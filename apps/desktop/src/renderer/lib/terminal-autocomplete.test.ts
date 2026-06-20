import { describe, expect, it } from 'vitest';
import {
  applyTerminalInput,
  createEmptyCommandBuffer,
  getTerminalAutocompleteSuggestions,
  type SessionCommandStat,
} from './terminal-autocomplete';

function snap(
  history: string[],
  executables: { name: string; path?: string }[] = [],
) {
  return {
    sessionId: 'session-1',
    shell: 'bash' as const,
    revision: 1,
    history,
    executables,
    truncated: false,
  };
}

function cmd(value: string) {
  return { value, cursor: value.length, ambiguous: false };
}

describe('terminal autocomplete', () => {
  it('tracks insertion, cursor movement, and command execution', () => {
    let state = applyTerminalInput(createEmptyCommandBuffer(), 'gti').state;
    state = applyTerminalInput(state, '\x1b[D\x7f').state;
    state = applyTerminalInput(state, 't').state;
    const result = applyTerminalInput(state, '\r');
    expect(result.executed).toBe('gti');
    expect(result.state.value).toBe('');
  });

  it('requires at least 2 characters before suggesting', () => {
    const s = snap(['git status'], [{ name: 'git' }]);
    expect(getTerminalAutocompleteSuggestions(s, cmd('g'))).toEqual([]);
    expect(
      getTerminalAutocompleteSuggestions(s, cmd('gi')).length,
    ).toBeGreaterThan(0);
  });

  it('ranks executable/command matches above raw file history', () => {
    const s = snap(['gitfoo --bar'], [{ name: 'gitk', path: '/usr/bin/gitk' }]);
    const results = getTerminalAutocompleteSuggestions(s, cmd('git'));
    const execIndex = results.findIndex((entry) => entry.insertText === 'gitk');
    const historyIndex = results.findIndex(
      (entry) => entry.insertText === 'gitfoo --bar',
    );
    expect(execIndex).toBeGreaterThanOrEqual(0);
    expect(historyIndex).toBeGreaterThanOrEqual(0);
    expect(execIndex).toBeLessThan(historyIndex);
  });

  it('merges dynamic completions, sources them, and orders shorter-first', () => {
    const s = snap([]);
    const results = getTerminalAutocompleteSuggestions(s, cmd('cat /etc/ho'), {
      dynamicCompletions: [
        { insertText: 'cat /etc/hostname', source: 'path' },
        { insertText: 'cat /etc/hosts', source: 'path' },
      ],
    });
    expect(results.map((entry) => entry.insertText)).toEqual([
      'cat /etc/hosts',
      'cat /etc/hostname',
    ]);
    expect(results.every((entry) => entry.source === 'path')).toBe(true);
  });

  it('ranks a live path completion above ordinary history lines', () => {
    // Tuned weights: raw history is weak enough that actual filesystem results
    // surface instead of being buried (the `cd ` → all-History problem).
    const s = snap(['cd archive/', 'cd other/']);
    const results = getTerminalAutocompleteSuggestions(s, cmd('cd '), {
      dynamicCompletions: [{ insertText: 'cd build/', source: 'path' }],
    }).map((entry) => entry.insertText);
    expect(results[0]).toBe('cd build/');
    expect(results).toContain('cd archive/'); // history still present, just lower
  });

  it('suppresses stale history paths when completing a path arg', () => {
    // `cd mo` in /etc/metricbeat: history has a no-longer-existing `cd mod/`.
    const s = snap(['cd mod/', 'cd modules.d/']);
    const results = getTerminalAutocompleteSuggestions(s, cmd('cd mo'), {
      suppressHistory: true,
      dynamicCompletions: [{ insertText: 'cd modules.d/', source: 'path' }],
    });
    const texts = results.map((entry) => entry.insertText);
    // The real folder shows (from the live listing)…
    expect(results[0]).toEqual({ insertText: 'cd modules.d/', source: 'path' });
    // …and the stale history path does not.
    expect(texts).not.toContain('cd mod/');
  });

  it('ignores dynamic completions that no longer match the input', () => {
    const s = snap([]);
    const results = getTerminalAutocompleteSuggestions(s, cmd('cat /etc/ho'), {
      dynamicCompletions: [
        { insertText: 'cat /var/log', source: 'path' },
      ],
    });
    expect(results).toEqual([]);
  });

  it('drops commands that failed (exit != 0) this session', () => {
    const s = snap(['npm run build', 'npm run broken']);
    const sessionStats = new Map<string, SessionCommandStat>([
      ['npm run broken', { count: 1, lastSeq: 2, lastExit: 1 }],
      ['npm run build', { count: 1, lastSeq: 1, lastExit: 0 }],
    ]);
    const results = getTerminalAutocompleteSuggestions(s, cmd('npm run'), {
      sessionStats,
    }).map((entry) => entry.insertText);
    expect(results).toContain('npm run build');
    expect(results).not.toContain('npm run broken');
  });

  it('completes full command lines from history (no history-derived "Option" source)', () => {
    const s = snap(['git status -s', 'git commit -m wip', 'git status']);
    const results = getTerminalAutocompleteSuggestions(s, cmd('git s'));
    const history = results.filter((entry) => entry.source === 'history');
    expect(history.some((entry) => entry.insertText === 'git status')).toBe(true);
    // The history-derived argument/option source was removed (Fig spec covers options).
    expect(results.some((entry) => (entry.source as string) === 'argument')).toBe(
      false,
    );
  });

  it('boosts commands that last ran in the current directory', () => {
    const s = snap(['make test', 'make deploy']);
    const sessionStats = new Map<string, SessionCommandStat>([
      ['make test', { count: 1, lastSeq: 2, lastExit: 0, cwd: '/other' }],
      ['make deploy', { count: 1, lastSeq: 1, lastExit: 0, cwd: '/home/u/proj' }],
    ]);
    const results = getTerminalAutocompleteSuggestions(s, cmd('make '), {
      sessionStats,
      currentCwd: '/home/u/proj',
    }).map((entry) => entry.insertText);
    expect(results.indexOf('make deploy')).toBeLessThan(
      results.indexOf('make test'),
    );
  });

  it('supplements with command-spec options, ranked below used history', () => {
    const s = snap(['git status']);
    const commandSpec = {
      name: 'git',
      subcommands: [{ name: 'commit' }, { name: 'status' }, { name: 'stash' }],
    };
    const results = getTerminalAutocompleteSuggestions(s, cmd('git '), {
      commandSpec,
    });
    const order = results.map((entry) => entry.insertText);
    // A never-typed subcommand surfaces from the spec...
    expect(order).toContain('git commit');
    expect(
      results.find((entry) => entry.insertText === 'git commit')?.source,
    ).toBe('spec');
    // ...but the one in history ranks above the spec-only option.
    expect(order.indexOf('git status')).toBeLessThan(order.indexOf('git commit'));
  });

  it('hides suggestions for ambiguous or mid-line editing', () => {
    const s = snap(['git status'], [{ name: 'git' }]);
    expect(
      getTerminalAutocompleteSuggestions(s, {
        value: 'git',
        cursor: 1,
        ambiguous: false,
      }),
    ).toEqual([]);
    expect(
      getTerminalAutocompleteSuggestions(s, {
        value: 'git',
        cursor: 3,
        ambiguous: true,
      }),
    ).toEqual([]);
  });
});

describe('terminal autocomplete snippets', () => {
  const snippets = [
    { label: 'Restart web', command: 'kubectl rollout restart deploy/web', keyword: 'rweb' },
    { label: 'List pods', command: 'kubectl get pods', keyword: null },
  ];

  it('matches a snippet by keyword and inserts the full command', () => {
    const results = getTerminalAutocompleteSuggestions(snap([]), cmd('rwe'), { snippets });
    const snippet = results.find((result) => result.source === 'snippet');
    expect(snippet?.insertText).toBe('kubectl rollout restart deploy/web');
    expect(snippet?.description).toBe('Restart web');
  });

  it('falls back to a label match when there is no keyword', () => {
    const results = getTerminalAutocompleteSuggestions(snap([]), cmd('List p'), { snippets });
    expect(
      results.some(
        (result) => result.source === 'snippet' && result.insertText === 'kubectl get pods',
      ),
    ).toBe(true);
  });

  it('does not surface multi-line snippets in autocomplete', () => {
    const results = getTerminalAutocompleteSuggestions(snap([]), cmd('multi'), {
      snippets: [{ label: 'two liner', command: 'echo a\necho b', keyword: 'multi' }],
    });
    expect(results.some((result) => result.source === 'snippet')).toBe(false);
  });
});
