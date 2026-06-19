import type { CommandSpec } from './types';
import type { FigSpecNode } from './fig-runtime';
import index from '../../generated/command-specs/index.json';

// Command specs are converted from Fig's autocomplete specs
// (github.com/withfig/autocomplete, MIT). Only static subcommands/options are
// kept; see scripts/generate-command-specs.cjs and generated/command-specs/.

const available = new Set<string>(index as string[]);

// Vite-idiomatic lazy loading: a statically-analyzable map of path -> loader,
// each a separate chunk. More robust than a template-literal dynamic import
// (which can go stale in a running dev server when spec files are added).
const loaders = import.meta.glob<{ default: CommandSpec }>(
  '../../generated/command-specs/*.json',
);

const cache = new Map<string, CommandSpec | null>();

/** Whether a bundled spec exists for the command — cheap, no load. */
export function hasCommandSpec(name: string): boolean {
  return available.has(name);
}

/** The spec for a command if it has already been loaded into the cache. */
export function getCachedCommandSpec(name: string): CommandSpec | null {
  return cache.get(name) ?? null;
}

/** Lazily load (and cache) a command's spec. Returns null when unavailable. */
export async function loadCommandSpec(name: string): Promise<CommandSpec | null> {
  if (!available.has(name)) {
    return null;
  }
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const loader = loaders[`../../generated/command-specs/${name}.json`];
  if (!loader) {
    cache.set(name, null);
    return null;
  }
  try {
    const module = await loader();
    const spec = (module.default ?? (module as unknown)) as CommandSpec;
    cache.set(name, spec);
    return spec;
  } catch {
    cache.set(name, null);
    return null;
  }
}

// Runnable spec modules (Fig generators preserved as functions), bundled by the
// converter. Loaded only when a command's arg has a generator to run.
const moduleLoaders = import.meta.glob<{ default: FigSpecNode }>(
  '../../generated/command-spec-modules/*.js',
);
const moduleCache = new Map<string, FigSpecNode | null>();

/** Whether a runnable spec module exists for the command — cheap, no load. */
export function hasCommandModule(name: string): boolean {
  return `../../generated/command-spec-modules/${name}.js` in moduleLoaders;
}

/** Lazily load (and cache) a command's runnable spec module. */
export async function loadCommandModule(
  name: string,
): Promise<FigSpecNode | null> {
  const cached = moduleCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const loader = moduleLoaders[`../../generated/command-spec-modules/${name}.js`];
  if (!loader) {
    moduleCache.set(name, null);
    return null;
  }
  try {
    const module = await loader();
    const spec = (module.default ?? (module as unknown)) as FigSpecNode;
    moduleCache.set(name, spec);
    return spec;
  } catch {
    moduleCache.set(name, null);
    return null;
  }
}
