// Dynamic completion: turn the current command line into a short read-only host
// command (file listing or a static generator script), then turn its stdout
// back into suggestions. Pure + shell-agnostic so it can be unit-tested; the
// controller runs the command over the auxiliary channel and caches results.

import type { SpecCompletion } from './match';
import type { ArgSpec, CommandSpec } from './types';

export interface PathCompletionRequest {
  kind: 'path';
  /** Whole-line prefix before the current token (insertText = before+dir+name). */
  before: string;
  /** Directory portion of the token, as typed (incl. trailing '/'); '' = cwd. */
  dir: string;
  /** Basename prefix to filter listing entries by (client-side). */
  base: string;
  /** Only suggest directories (e.g. `cd`, or a `folders` template). */
  foldersOnly: boolean;
}

export interface GeneratorCompletionRequest {
  kind: 'generator';
  /** Leading command — the bundled JS spec module to load and run from. */
  command: string;
  /** Full token array including the partial last token (Fig generator input). */
  tokens: string[];
  /** Whole-line prefix before the current token (insertText = before + value). */
  before: string;
  /** Current partial token to filter candidates by (client-side). */
  base: string;
}

export type DynamicCompletionRequest =
  | PathCompletionRequest
  | GeneratorCompletionRequest;

const COMPOUND = /[;&|]/;

/**
 * Decide whether the current partial token wants dynamic completion, and how.
 * Returns null when it doesn't (bare command, compound line, no path/generator
 * intent). The spec is optional — the path heuristic works without it.
 */
export function resolveDynamicCompletion(
  spec: CommandSpec | null | undefined,
  value: string,
): DynamicCompletionRequest | null {
  if (COMPOUND.test(value)) {
    return null;
  }
  const lastSpace = value.lastIndexOf(' ');
  if (lastSpace < 0) {
    return null; // still typing the command name
  }
  const before = value.slice(0, lastSpace + 1);
  const token = value.slice(lastSpace + 1);

  const slash = token.lastIndexOf('/');
  const dir = slash >= 0 ? token.slice(0, slash + 1) : '';
  const base = slash >= 0 ? token.slice(slash + 1) : token;

  const pathLike =
    token.includes('/') || token.startsWith('~');

  const completedTokens = before.trim().split(/\s+/).filter(Boolean);
  const arg = resolveCurrentArg(spec, completedTokens);
  const template = arg?.template;

  // A file/folder template is our own path completion's job.
  if (template === 'filepaths' || template === 'folders') {
    return { kind: 'path', before, dir, base, foldersOnly: template === 'folders' };
  }
  // A generator-bearing arg wins over the path heuristic — branch/ref values
  // often contain "/" but are not file paths. The generator filters by the whole
  // token (not the path basename).
  if (arg?.hasGenerator) {
    return {
      kind: 'generator',
      command: completedTokens[0] ?? '',
      tokens: [...completedTokens, token],
      before,
      base: token,
    };
  }
  // No spec generator: fall back to the path heuristic for path-shaped tokens.
  if (pathLike) {
    return { kind: 'path', before, dir, base, foldersOnly: false };
  }
  return null;
}

/**
 * Walk the spec to the arg slot the current partial token occupies: the value of
 * the immediately-preceding option (if it takes one), else the next positional
 * slot. Returns null when there's no spec or no matching arg.
 */
function resolveCurrentArg(
  spec: CommandSpec | null | undefined,
  completedTokens: string[],
): ArgSpec | null {
  if (!spec) {
    return null;
  }
  let node: CommandSpec = spec;
  let positional = 0;
  let pendingOptionArg: ArgSpec | null = null;
  for (let index = 1; index < completedTokens.length; index += 1) {
    const token = completedTokens[index];
    pendingOptionArg = null;
    if (token.startsWith('-')) {
      // `--opt=value` carries its own value — not a pending arg.
      if (token.includes('=')) {
        continue;
      }
      const option = node.options?.find((candidate) =>
        candidate.names.includes(token),
      );
      if (option?.takesArg) {
        const argSpec = option.args?.[0] ?? null;
        if (index === completedTokens.length - 1) {
          pendingOptionArg = argSpec; // current partial is this option's value
        } else {
          index += 1; // its value is the next token — skip it
        }
      }
      continue;
    }
    const sub =
      positional === 0
        ? node.subcommands?.find((candidate) => candidate.name === token)
        : undefined;
    if (sub) {
      node = sub;
      continue;
    }
    positional += 1;
  }
  if (pendingOptionArg !== null) {
    return pendingOptionArg;
  }
  const args = node.args;
  if (args && args.length > 0) {
    if (positional < args.length) {
      return args[positional] ?? null;
    }
    // Past the declared slots: only a variadic last arg keeps matching (e.g.
    // `cat a b c`). A fixed-arity arg (e.g. `docker logs <container>`) is done,
    // so stop offering it for further tokens.
    const last = args[args.length - 1];
    return last?.variadic ? last : null;
  }
  return null;
}

/** POSIX single-quote escaping (safe for arbitrary bytes except NUL). */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function joinPath(cwd: string, dir: string): string {
  return `${cwd.replace(/\/+$/, '')}/${dir}`;
}

/**
 * Resolve the typed directory to a host argument for `ls`. Relative dirs are
 * anchored to the session cwd (OSC 7) so we don't depend on the aux channel's
 * own working directory; `~` is kept unquoted so the shell still expands it.
 */
function resolveDir(dir: string, cwd?: string | null): string {
  if (dir === '') {
    return cwd ? shellEscape(cwd) : '.';
  }
  if (dir.startsWith('~')) {
    const slash = dir.indexOf('/');
    if (slash < 0) {
      return dir; // bare ~ or ~user, no trailing slash yet
    }
    return dir.slice(0, slash) + shellEscape(dir.slice(slash));
  }
  if (dir.startsWith('/')) {
    return shellEscape(dir);
  }
  return cwd ? shellEscape(joinPath(cwd, dir)) : shellEscape(dir);
}

/** Build the host command for a path request: `ls -1Ap -- <dir>`. */
export function buildListCommand(
  request: PathCompletionRequest,
  cwd?: string | null,
): string {
  return `ls -1Ap -- ${resolveDir(request.dir, cwd)}`;
}

/** Parse `ls -1Ap` output into completions for a path request. */
export function parsePathListing(
  stdout: string,
  request: PathCompletionRequest,
): SpecCompletion[] {
  const out: SpecCompletion[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split('\n')) {
    const name = rawLine.replace(/\r$/, '');
    if (!name || name === './' || name === '../') {
      continue;
    }
    if (request.foldersOnly && !name.endsWith('/')) {
      continue;
    }
    if (!name.startsWith(request.base) || name === request.base) {
      continue;
    }
    const insertText = request.before + request.dir + name;
    if (seen.has(insertText)) {
      continue;
    }
    seen.add(insertText);
    out.push({ insertText });
  }
  return out;
}
