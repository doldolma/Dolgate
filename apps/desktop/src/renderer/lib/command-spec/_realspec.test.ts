import { describe, expect, it } from 'vitest';
import { matchCommandSpec } from './match';
import { getTerminalAutocompleteSuggestions } from '../terminal-autocomplete';
import gitSpec from '../../generated/command-specs/git.json';
import kubectlSpec from '../../generated/command-specs/kubectl.json';
import dockerSpec from '../../generated/command-specs/docker.json';

const snapshot = {
  sessionId: 's',
  shell: 'bash' as const,
  revision: 1,
  history: ['git status'],
  executables: [],
  truncated: false,
};

describe('real generated specs do not break the pipeline', () => {
  for (const [name, spec] of [
    ['git', gitSpec],
    ['kubectl', kubectlSpec],
    ['docker', dockerSpec],
  ] as const) {
    it(`matchCommandSpec works on real ${name} spec`, () => {
      const results = matchCommandSpec(spec as never, `${name} `);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    it(`getTerminalAutocompleteSuggestions works with real ${name} spec`, () => {
      const out = getTerminalAutocompleteSuggestions(
        snapshot,
        { value: `${name} s`, cursor: `${name} s`.length, ambiguous: false },
        { commandSpec: spec as never },
      );
      expect(Array.isArray(out)).toBe(true);
    });
  }
});
