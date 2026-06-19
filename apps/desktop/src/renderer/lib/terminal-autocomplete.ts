import type { TerminalAutocompleteSnapshot } from '@shared';
import { matchCommandSpec } from './command-spec/match';
import type { CommandSpec } from './command-spec/types';

export interface TerminalAutocompleteSuggestion {
  insertText: string;
  source: 'history' | 'executable' | 'spec' | 'path' | 'generator';
  description?: string;
}

/** Per-command stats observed during the current session via OSC 133 markers. */
export interface SessionCommandStat {
  count: number;
  /** Monotonic sequence for session recency (higher = more recent). */
  lastSeq: number;
  /** Exit code from the last run this session, or null if not yet finished. */
  lastExit: number | null;
  /** Working directory the command last ran in (OSC 7), if known. */
  cwd?: string | null;
}

export interface AutocompleteScoringContext {
  sessionStats?: ReadonlyMap<string, SessionCommandStat>;
  currentCwd?: string | null;
  /** Loaded command spec for the leading command (Fig-derived), if any. */
  commandSpec?: CommandSpec | null;
  /**
   * Dynamic completions resolved over the auxiliary channel (file paths,
   * generator output). Already keyed to the current value by the controller.
   */
  dynamicCompletions?: readonly TerminalAutocompleteSuggestion[];
  /**
   * Drop raw history/session full-line suggestions. Set when the current token
   * is a filesystem path (cd/ls/…): the live `ls` listing is authoritative, so
   * stale history paths (e.g. a dir that no longer exists here) shouldn't show.
   */
  suppressHistory?: boolean;
  limit?: number;
}

export interface CommandBufferState {
  value: string;
  cursor: number;
  ambiguous: boolean;
}

export function createEmptyCommandBuffer(): CommandBufferState {
  return { value: '', cursor: 0, ambiguous: false };
}

export function applyTerminalInput(
  state: CommandBufferState,
  data: string,
): { state: CommandBufferState; executed?: string } {
  let next = { ...state };
  let executed: string | undefined;

  for (let index = 0; index < data.length; ) {
    const rest = data.slice(index);
    if (rest.startsWith('\x1b[D')) {
      next.cursor = Math.max(0, next.cursor - 1);
      index += 3;
      continue;
    }
    if (rest.startsWith('\x1b[C')) {
      next.cursor = Math.min(next.value.length, next.cursor + 1);
      index += 3;
      continue;
    }
    if (rest.startsWith('\x1b[A') || rest.startsWith('\x1b[B')) {
      next = { value: '', cursor: 0, ambiguous: true };
      index += 3;
      continue;
    }

    const codePoint = data.codePointAt(index);
    if (codePoint == null) {
      break;
    }
    const char = String.fromCodePoint(codePoint);
    index += char.length;
    switch (char) {
      case '\r':
      case '\n':
        executed = next.value.trim() || undefined;
        next = { value: '', cursor: 0, ambiguous: true };
        break;
      case '\x7f':
      case '\b':
        if (next.cursor > 0) {
          next.value =
            next.value.slice(0, next.cursor - 1) + next.value.slice(next.cursor);
          next.cursor -= 1;
        }
        break;
      case '\x01':
        next.cursor = 0;
        break;
      case '\x05':
        next.cursor = next.value.length;
        break;
      case '\x15':
        next = createEmptyCommandBuffer();
        break;
      case '\x03':
        next = { value: '', cursor: 0, ambiguous: true };
        break;
      default:
        if (codePoint >= 0x20 && codePoint !== 0x7f) {
          next.value =
            next.value.slice(0, next.cursor) + char + next.value.slice(next.cursor);
          next.cursor += char.length;
        }
    }
  }
  return { state: next, executed };
}

const MIN_PREFIX_LENGTH = 2;
const DEFAULT_LIMIT = 5;

// Additive scoring weights (tune by feel — kept together for easy adjustment).
// Executable names intentionally outrank raw file-history lines; commands
// actually run (and that succeeded) this session rank highest, while commands
// that failed this session are dropped entirely.
const SCORE_WEIGHTS = {
  executableBase: 6_000,
  sessionBase: 4_500,
  // Dynamic, host-resolved values (real file paths / generator output) are a
  // discovery supplement: ranked above raw file history and spec options, but
  // below commands the user has actually run.
  pathBase: 2_000,
  generatorBase: 1_800,
  // Raw ~/.bash_history is deliberately weak: even a frequently-run line lands
  // below live path/value completions, so actual filesystem/host results aren't
  // buried. Only a very-frequently-run line (count ~20+) climbs back above them.
  historyBase: 150,
  // Spec options the user hasn't run rank below used history (supplement, not
  // replace) but still surface for discovery.
  specBase: 1_000,
  recency: 550,
  frequency: 350,
  exitSuccess: 1_500,
  cwdMatch: 2_000,
} as const;

export function getTerminalAutocompleteSuggestions(
  snapshot: TerminalAutocompleteSnapshot | null,
  command: CommandBufferState,
  context: AutocompleteScoringContext = {},
): TerminalAutocompleteSuggestion[] {
  if (
    !snapshot ||
    command.ambiguous ||
    command.cursor !== command.value.length ||
    command.value.trim().length < MIN_PREFIX_LENGTH ||
    command.value.includes('\n')
  ) {
    return [];
  }

  const value = command.value;
  const { sessionStats } = context;
  const currentCwd = context.currentCwd ?? null;
  const limit = context.limit ?? DEFAULT_LIMIT;

  let maxSessionSeq = 0;
  if (sessionStats) {
    for (const stat of sessionStats.values()) {
      maxSessionSeq = Math.max(maxSessionSeq, stat.lastSeq);
    }
  }

  const scored = new Map<
    string,
    { suggestion: TerminalAutocompleteSuggestion; score: number }
  >();
  const consider = (
    suggestion: TerminalAutocompleteSuggestion,
    score: number,
  ) => {
    if (suggestion.insertText === value) {
      return;
    }
    const existing = scored.get(suggestion.insertText);
    if (!existing || score > existing.score) {
      scored.set(suggestion.insertText, { suggestion, score });
    }
  };

  const fileStats = new Map<string, { count: number; lastIndex: number }>();
  snapshot.history.forEach((entry, index) => {
    const current = fileStats.get(entry) ?? { count: 0, lastIndex: -1 };
    fileStats.set(entry, { count: current.count + 1, lastIndex: index });
  });
  const historyLength = Math.max(1, snapshot.history.length);
  const lineKeys = new Set<string>(fileStats.keys());
  if (sessionStats) {
    for (const key of sessionStats.keys()) {
      lineKeys.add(key);
    }
  }

  // 1) Full-line completions from file history + this session's commands.
  //    Skipped when completing a filesystem path — the live listing is truth.
  if (!context.suppressHistory) {
    for (const entry of lineKeys) {
      if (!entry.startsWith(value)) {
        continue;
      }
      const sessionStat = sessionStats?.get(entry);
      if (isFailedSessionStat(sessionStat)) {
        continue;
      }
      const fileStat = fileStats.get(entry);
      let score = sessionStat ? SCORE_WEIGHTS.sessionBase : SCORE_WEIGHTS.historyBase;
      if (sessionStat) {
        score +=
          SCORE_WEIGHTS.recency *
          (maxSessionSeq > 0 ? sessionStat.lastSeq / maxSessionSeq : 1);
      } else if (fileStat) {
        score += SCORE_WEIGHTS.recency * ((fileStat.lastIndex + 1) / historyLength);
      }
      const count = (sessionStat?.count ?? 0) + (fileStat?.count ?? 0);
      score += SCORE_WEIGHTS.frequency * Math.log2(1 + count);
      if (sessionStat?.lastExit === 0) {
        score += SCORE_WEIGHTS.exitSuccess;
      }
      if (matchesCwd(sessionStat, currentCwd)) {
        score += SCORE_WEIGHTS.cwdMatch;
      }
      consider({ insertText: entry, source: 'history' }, score);
    }
  }

  // 2) Executable name completion while typing the command (first token).
  const executableContext = resolveExecutableContext(value);
  if (executableContext) {
    for (const executable of snapshot.executables) {
      if (
        !executable.name.startsWith(executableContext.prefix) ||
        executable.name === executableContext.prefix
      ) {
        continue;
      }
      consider(
        {
          insertText: executableContext.before + executable.name,
          source: 'executable',
          description: executable.path,
        },
        SCORE_WEIGHTS.executableBase - executable.name.length,
      );
    }
  }

  // 3) Subcommands / flags from the bundled command spec (Fig-derived). These
  //    surface options accurately (vs guessing argument tokens from history);
  //    deduped against (and ranked below) the history/session candidates above.
  if (context.commandSpec) {
    for (const completion of matchCommandSpec(context.commandSpec, value)) {
      consider(
        completion.description
          ? {
              insertText: completion.insertText,
              source: 'spec',
              description: completion.description,
            }
          : { insertText: completion.insertText, source: 'spec' },
        SCORE_WEIGHTS.specBase,
      );
    }
  }

  // 4) Dynamic values resolved over the auxiliary channel (real file paths /
  //    generator output). Shorter matches first; deduped against everything else.
  if (context.dynamicCompletions) {
    for (const suggestion of context.dynamicCompletions) {
      if (!suggestion.insertText.startsWith(value)) {
        continue;
      }
      const base =
        suggestion.source === 'generator'
          ? SCORE_WEIGHTS.generatorBase
          : SCORE_WEIGHTS.pathBase;
      consider(suggestion, base - suggestion.insertText.length);
    }
  }

  return [...scored.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.suggestion);
}

function isFailedSessionStat(stat: SessionCommandStat | undefined): boolean {
  return Boolean(stat && stat.lastExit != null && stat.lastExit !== 0);
}

function matchesCwd(
  stat: SessionCommandStat | undefined,
  currentCwd: string | null,
): boolean {
  return Boolean(stat?.cwd && currentCwd && stat.cwd === currentCwd);
}

function resolveExecutableContext(
  value: string,
): { before: string; prefix: string } | null {
  if (/^[^\s;&|]*$/.test(value)) {
    return { before: '', prefix: value };
  }
  const match = value.match(/^(.*?\b(?:sudo|env|command)\s+)([^\s;&|]*)$/);
  if (!match) {
    return null;
  }
  return { before: match[1] ?? '', prefix: match[2] ?? '' };
}

