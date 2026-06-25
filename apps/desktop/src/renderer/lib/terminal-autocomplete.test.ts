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

  it('caps results at the requested limit (default 5)', () => {
    const history = Array.from({ length: 25 }, (_, index) => `deploy-app-${index}`);
    const s = snap(history);
    // Default keeps the overlay tight…
    expect(getTerminalAutocompleteSuggestions(s, cmd('deploy')).length).toBe(5);
    // …but the controller asks for a deeper, scrollable list.
    expect(
      getTerminalAutocompleteSuggestions(s, cmd('deploy'), { limit: 20 }).length,
    ).toBe(20);
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

  it('ranks an exact-keyword snippet above even the strongest this-session command', () => {
    // 가장 강한 세션 명령: 자주(50회)·성공(exit 0)·같은 cwd로 실행 (≈ 10.5k점).
    // (입력 'git status'의 확장형 'git status -s' — insertText===입력이면 제외되므로.)
    const sessionStats = new Map<string, SessionCommandStat>([
      ['git status -s', { count: 50, lastSeq: 10, lastExit: 0, cwd: '/home/me' }],
    ]);
    // 입력이 키워드와 정확히 일치 → snippetExact(20000) → 최강 세션 명령보다도 위.
    const results = getTerminalAutocompleteSuggestions(snap(['git status -s']), cmd('git status'), {
      sessionStats,
      currentCwd: '/home/me',
      snippets: [
        { label: 'Git status short', command: 'git status --short', keyword: 'git status' },
      ],
    });
    const snippetIndex = results.findIndex((r) => r.insertText === 'git status --short');
    const sessionIndex = results.findIndex((r) => r.insertText === 'git status -s');
    expect(snippetIndex).toBeGreaterThanOrEqual(0);
    expect(sessionIndex).toBeGreaterThanOrEqual(0);
    expect(snippetIndex).toBeLessThan(sessionIndex);
  });

  it('ranks an exact keyword match above a mere prefix match', () => {
    // 'gs' 입력: 'gs'는 정확히 일치(20000), 'gst'는 prefix 일치(4000).
    const results = getTerminalAutocompleteSuggestions(snap([]), cmd('gs'), {
      snippets: [
        { label: 'Git status', command: 'git status', keyword: 'gs' },
        { label: 'Git stash list', command: 'git stash list', keyword: 'gst' },
      ],
    });
    const exactIndex = results.findIndex((r) => r.insertText === 'git status');
    const prefixIndex = results.findIndex((r) => r.insertText === 'git stash list');
    expect(exactIndex).toBeGreaterThanOrEqual(0);
    expect(prefixIndex).toBeGreaterThanOrEqual(0);
    expect(exactIndex).toBeLessThan(prefixIndex);
  });

  it('ranks a prefix-matched snippet below a command run this session', () => {
    // 4000(prefix) < sessionBase(4500)+보너스 — 부분입력 스니펫은 실제 실행 명령에 양보.
    const sessionStats = new Map<string, SessionCommandStat>([
      ['git stash', { count: 1, lastSeq: 1, lastExit: 0 }],
    ]);
    const results = getTerminalAutocompleteSuggestions(snap(['git stash']), cmd('git s'), {
      sessionStats,
      snippets: [
        { label: 'Git status short', command: 'git status --short', keyword: 'git status' },
      ],
    });
    const sessionIndex = results.findIndex((r) => r.insertText === 'git stash');
    const snippetIndex = results.findIndex((r) => r.insertText === 'git status --short');
    expect(sessionIndex).toBeGreaterThanOrEqual(0);
    expect(snippetIndex).toBeGreaterThanOrEqual(0);
    expect(sessionIndex).toBeLessThan(snippetIndex);
  });

  it('matches a snippet by a substring of its keyword', () => {
    // 'web'은 키워드 'rweb'의 접두사가 아니라 부분 문자열 → substring 티어로 매칭.
    const results = getTerminalAutocompleteSuggestions(snap([]), cmd('web'), { snippets });
    expect(
      results.some(
        (r) => r.source === 'snippet' && r.insertText === 'kubectl rollout restart deploy/web',
      ),
    ).toBe(true);
  });

  it('matches a snippet by a substring of its label', () => {
    // 'pods'는 라벨 'List pods'의 접두사가 아니라 부분 문자열.
    const results = getTerminalAutocompleteSuggestions(snap([]), cmd('pods'), { snippets });
    expect(
      results.some((r) => r.source === 'snippet' && r.insertText === 'kubectl get pods'),
    ).toBe(true);
  });

  it('ranks a prefix match above a substring match', () => {
    // 'rest': 라벨 'Restart web'엔 접두사(4000), 키워드 'prestart'엔 부분 문자열(1500).
    const results = getTerminalAutocompleteSuggestions(snap([]), cmd('rest'), {
      snippets: [
        { label: 'Restart web', command: 'kubectl rollout restart deploy/web', keyword: 'rweb' },
        { label: 'Prestart hook', command: 'echo prestart', keyword: 'prestart' },
      ],
    });
    const prefixIndex = results.findIndex(
      (r) => r.insertText === 'kubectl rollout restart deploy/web',
    );
    const substringIndex = results.findIndex((r) => r.insertText === 'echo prestart');
    expect(prefixIndex).toBeGreaterThanOrEqual(0);
    expect(substringIndex).toBeGreaterThanOrEqual(0);
    expect(prefixIndex).toBeLessThan(substringIndex);
  });
});
