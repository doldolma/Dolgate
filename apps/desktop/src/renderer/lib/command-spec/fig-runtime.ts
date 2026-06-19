// Minimal runtime for executing Fig autocomplete generators (script / custom).
//
// Ported from Amazon Q Developer CLI (the open-source Fig successor), tag v1.6.0,
// packages/autocomplete/src/generators/{scriptSuggestionsGenerator,customSuggestionsGenerator}.ts
// — Apache-2.0 / MIT. The only substantive change: the `executeCommand` seam,
// which in Fig ran on the local machine, is supplied by the caller and backed by
// our remote auxiliary channel, so generators run on the connected host.
//
// We deliberately port only the script/custom execution + output shaping. Fig's
// trigger/getQueryTerm/cache features are not implemented here (the controller
// handles caching and re-runs); see the plan's "out of scope" notes.

/** Subset of `Fig.ExecuteCommandInput`. */
export interface FigExecuteCommandInput {
  command: string;
  args: string[];
  cwd?: string;
  timeout?: number;
}

/** Backed by the aux channel. Mirrors Fig's `executeCommand` callback. */
export type FigExecuteCommand = (
  input: FigExecuteCommandInput,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** Subset of `Fig.Suggestion` we read. */
export interface FigSuggestion {
  name?: string | string[];
  insertValue?: string;
  displayName?: string;
  description?: string;
  icon?: string;
  priority?: number;
  type?: string;
}

type FigScript =
  | string
  | string[]
  | ((tokens: string[]) => string | string[] | undefined);

/** Subset of `Fig.Generator` we execute. */
export interface FigGenerator {
  script?: FigScript;
  postProcess?: (
    out: string,
    tokens: string[],
  ) => Array<FigSuggestion | string>;
  splitOn?: string;
  custom?: (
    tokens: string[],
    executeCommand: FigExecuteCommand,
    context: FigGeneratorContext,
  ) => Promise<Array<FigSuggestion | string>>;
  scriptTimeout?: number;
}

export interface FigGeneratorContext {
  currentWorkingDirectory: string;
  currentProcess: string;
  sshPrefix: string;
  searchTerm: string;
  environmentVariables: Record<string, string>;
  isDangerous: boolean;
}

const DEFAULT_TIMEOUT_MS = 2_000;

/** Normalize a generator's output (strings or suggestion objects) and drop empties. */
function normalize(results: Array<FigSuggestion | string>): FigSuggestion[] {
  if (!Array.isArray(results)) {
    return [];
  }
  return results
    .filter((item) => item && (typeof item === 'string' || !!item.name))
    .map((item) =>
      typeof item === 'string'
        ? { name: item, insertValue: item, type: 'arg' }
        : { ...item, type: item.type || 'arg' },
    );
}

/** Resolve a `script` (string | array | function) into an executable input. */
function scriptToInput(
  script: FigScript,
  tokens: string[],
  cwd: string,
): FigExecuteCommandInput | null {
  const resolved = typeof script === 'function' ? script(tokens) : script;
  if (!resolved) {
    return null;
  }
  if (Array.isArray(resolved)) {
    if (resolved.length === 0) {
      return null;
    }
    return { command: resolved[0], args: resolved.slice(1), cwd };
  }
  // A plain string script is a shell line — run it via `sh -c` so quoting and
  // pipes inside it are honored (executeCommand shell-escapes each arg).
  return { command: 'sh', args: ['-c', resolved], cwd };
}

async function runOne(
  generator: FigGenerator,
  context: FigGeneratorContext,
  tokens: string[],
  executeCommand: FigExecuteCommand,
  timeoutMs: number,
): Promise<FigSuggestion[]> {
  try {
    if (typeof generator.custom === 'function') {
      return normalize(
        await generator.custom(tokens, executeCommand, context),
      );
    }
    if (generator.script) {
      const input = scriptToInput(
        generator.script,
        tokens,
        context.currentWorkingDirectory,
      );
      if (!input) {
        return [];
      }
      const timeout = Math.max(timeoutMs, generator.scriptTimeout ?? 0);
      const { stdout } = await executeCommand({ ...input, timeout });
      // Empty output → nothing to shape. Skipping postProcess here also avoids
      // spec postProcessors that JSON.parse each line throwing (and logging) on
      // a blank/trailing line. Pass the trimmed output so a trailing newline
      // doesn't produce a stray empty line either.
      const trimmed = stdout.trim();
      if (trimmed === '') {
        return [];
      }
      if (generator.splitOn) {
        return normalize(trimmed.split(generator.splitOn));
      }
      if (typeof generator.postProcess === 'function') {
        return normalize(generator.postProcess(trimmed, tokens));
      }
      // Matching the reference engine: a script with neither splitOn nor
      // postProcess produces nothing (raw output would be unshaped garbage).
      return [];
    }
  } catch {
    // Best-effort: a broken generator yields nothing rather than throwing.
    return [];
  }
  return [];
}

/**
 * Run one or more Fig generators for the current arg and return their combined
 * suggestions. `executeCommand` runs commands on the connected host.
 */
export async function runGenerators(
  generators: FigGenerator | FigGenerator[] | undefined,
  options: {
    tokens: string[];
    searchTerm: string;
    cwd: string;
    executeCommand: FigExecuteCommand;
    timeoutMs?: number;
  },
): Promise<FigSuggestion[]> {
  if (!generators) {
    return [];
  }
  const list = Array.isArray(generators) ? generators : [generators];
  const context: FigGeneratorContext = {
    currentWorkingDirectory: options.cwd,
    currentProcess: '',
    sshPrefix: '',
    searchTerm: options.searchTerm,
    environmentVariables: {},
    isDangerous: false,
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results = await Promise.all(
    list.map((generator) =>
      runOne(generator, context, options.tokens, options.executeCommand, timeoutMs),
    ),
  );
  return results.flat();
}

/** First display string for a suggestion whose `name` may be an array. */
export function figSuggestionName(suggestion: FigSuggestion): string | null {
  const { name } = suggestion;
  if (Array.isArray(name)) {
    return name[0] ?? null;
  }
  return name ?? null;
}

// --- Fig spec navigation (on the bundled JS spec module) --------------------

type FigName = string | string[] | undefined;

interface FigArgNode {
  name?: string;
  isVariadic?: boolean;
  generators?: FigGenerator | FigGenerator[];
}

interface FigOptionNode {
  name?: FigName;
  args?: FigArgNode | FigArgNode[];
}

export interface FigSpecNode {
  name?: FigName;
  subcommands?: FigSpecNode[];
  options?: FigOptionNode[];
  args?: FigArgNode | FigArgNode[];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function nameMatches(name: FigName, token: string): boolean {
  return Array.isArray(name) ? name.includes(token) : name === token;
}

/**
 * Walk the (full) Fig spec to the arg the current partial token occupies and
 * return its generator(s). Mirrors the slim matcher's resolveCurrentArg, but on
 * the richer Fig shape (name arrays, single-or-array args). `tokens` includes
 * the partial last token; the walk uses everything before it.
 */
export function findArgGenerators(
  spec: FigSpecNode,
  tokens: string[],
): FigGenerator | FigGenerator[] | undefined {
  const completed = tokens.slice(0, -1);
  let node: FigSpecNode = spec;
  let positional = 0;
  let pendingOptionArg: FigArgNode | undefined;
  for (let index = 1; index < completed.length; index += 1) {
    const token = completed[index];
    pendingOptionArg = undefined;
    if (token.startsWith('-')) {
      if (token.includes('=')) {
        continue;
      }
      const option = (node.options ?? []).find((candidate) =>
        nameMatches(candidate.name, token),
      );
      const optionArgs = asArray(option?.args);
      if (optionArgs.length > 0) {
        if (index === completed.length - 1) {
          pendingOptionArg = optionArgs[0];
        } else {
          index += 1; // its value is the next token — skip it
        }
      }
      continue;
    }
    const sub =
      positional === 0
        ? (node.subcommands ?? []).find((candidate) =>
            nameMatches(candidate.name, token),
          )
        : undefined;
    if (sub) {
      node = sub;
      continue;
    }
    positional += 1;
  }
  if (pendingOptionArg) {
    return pendingOptionArg.generators;
  }
  const args = asArray(node.args);
  if (args.length > 0) {
    if (positional < args.length) {
      return args[positional]?.generators;
    }
    // Past the declared slots: only a variadic last arg keeps generating (e.g.
    // `cat a b c`); a fixed-arity arg (e.g. `docker logs <container>`) is done.
    const last = args[args.length - 1];
    return last?.isVariadic ? last.generators : undefined;
  }
  return undefined;
}

/**
 * Map generator output to insertable completions: filter by the current partial
 * token, build full insertText, and dedupe. `insertValue` (what Fig types) wins
 * over the display `name`.
 */
export function figSuggestionsToCompletions(
  suggestions: FigSuggestion[],
  before: string,
  base: string,
): Array<{ insertText: string; description?: string }> {
  const out: Array<{ insertText: string; description?: string }> = [];
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    const name = figSuggestionName(suggestion);
    if (!name) {
      continue;
    }
    const value = suggestion.insertValue ?? name;
    // Filter by what the user has typed so far (prefix on the value or display).
    if (base && !value.startsWith(base) && !name.startsWith(base)) {
      continue;
    }
    const insertText = before + value;
    if (insertText === before + base || seen.has(insertText)) {
      continue;
    }
    seen.add(insertText);
    out.push(
      suggestion.description
        ? { insertText, description: suggestion.description }
        : { insertText },
    );
  }
  return out;
}
