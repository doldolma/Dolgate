import { describe, expect, it } from 'vitest';
import { hasCommandSpec, loadCommandSpec } from './store';

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
});
