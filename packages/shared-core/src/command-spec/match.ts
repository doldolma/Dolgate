import type { CommandSpec } from './types';

export interface SpecCompletion {
  insertText: string;
  description?: string;
}

const COMPOUND = /[;&|]/;

/**
 * Produce subcommand/flag completions for the current partial token, by walking
 * the command spec tree. Returns full insertText values (the current token
 * completed in place). Returns [] while still typing the bare command name
 * (no space yet) or for compound commands.
 */
export function matchCommandSpec(
  spec: CommandSpec | null | undefined,
  value: string,
): SpecCompletion[] {
  if (!spec || COMPOUND.test(value)) {
    return [];
  }
  const lastSpace = value.lastIndexOf(' ');
  if (lastSpace < 0) {
    // Still typing the command itself — executables handle that.
    return [];
  }
  const before = value.slice(0, lastSpace + 1);
  const partial = value.slice(lastSpace + 1);

  // Descend through already-typed subcommand tokens.
  const completeTokens = before.trim().split(/\s+/);
  let node: CommandSpec = spec;
  for (let index = 1; index < completeTokens.length; index += 1) {
    const token = completeTokens[index];
    if (token.startsWith('-')) {
      continue; // flag — does not change the subcommand context (v1)
    }
    const next = node.subcommands?.find(sub => sub.name === token);
    if (!next) {
      break; // positional arg or unknown token — stop descending
    }
    node = next;
  }

  const completingOption = partial.startsWith('-');
  const out: SpecCompletion[] = [];
  const seen = new Set<string>();
  const push = (token: string, description?: string) => {
    if (!token.startsWith(partial) || token === partial) {
      return;
    }
    const insertText = before + token;
    if (seen.has(insertText)) {
      return;
    }
    seen.add(insertText);
    out.push(description ? { insertText, description } : { insertText });
  };

  if (!completingOption) {
    for (const sub of node.subcommands ?? []) {
      push(sub.name, sub.description);
    }
  }
  for (const option of node.options ?? []) {
    if (partial === '') {
      // Offer one spelling per flag (prefer the long form) to avoid noise.
      const primary =
        option.names.find(name => name.startsWith('--')) ?? option.names[0];
      if (primary) {
        push(primary, option.description);
      }
      continue;
    }
    for (const name of option.names) {
      push(name, option.description);
    }
  }
  return out;
}
