import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyTerminalInput,
  buildListCommand,
  createEmptyCommandBuffer,
  getTerminalAutocompleteSuggestions,
  parsePathListing,
  resolveDynamicCompletion,
  type CommandBufferState,
  type SessionCommandStat,
  type SnippetRecord,
  type TerminalAutocompleteCapability,
  type TerminalAutocompleteSnapshot,
  type TerminalAutocompleteSuggestion,
} from '@dolssh/shared-core';
import {
  prepareSessionAutocomplete,
  runSessionCompletion,
} from '../store/useMobileAppStore';
import {
  parseSnippetVariables,
  resolveSnippetCommand,
  type SnippetVariable,
} from '../lib/snippet-variables';

const EMPTY_SNIPPETS: readonly SnippetRecord[] = [];
const DYNAMIC_DEBOUNCE_MS = 140;
const DYNAMIC_CACHE_MAX = 24;

export interface PendingAutocompleteSnippet {
  command: string;
  variables: SnippetVariable[];
}

interface UseTerminalAutocompleteOptions {
  sessionId: string | null;
  enabled: boolean;
  connected: boolean;
  snippets?: readonly SnippetRecord[];
  sendInput: (data: string) => void;
}

function parseCwdFromOsc7(value: string): string | null {
  const windows = value.match(/^file:\/\/\/([A-Za-z]:\/.*)$/);
  if (windows) {
    try {
      return decodeURIComponent(windows[1]).replace(/\//g, '\\');
    } catch {
      return windows[1].replace(/\//g, '\\');
    }
  }
  const posix = value.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!posix) return value || null;
  try {
    return decodeURIComponent(posix[1]);
  } catch {
    return posix[1];
  }
}

function isShellIntegrationArtifact(entry: string): boolean {
  return (
    entry.includes('__ds_') ||
    entry.includes(']133;') ||
    entry.includes(']6973;') ||
    entry.includes(']7;file://')
  );
}

function withSessionId(
  sessionId: string,
  result: Awaited<ReturnType<typeof prepareSessionAutocomplete>>,
): {
  capability: TerminalAutocompleteCapability;
  snapshot: TerminalAutocompleteSnapshot | null;
} {
  const capability: TerminalAutocompleteCapability = {
    ...result.capability,
    sessionId,
  };
  const source = result.snapshot;
  const snapshot = source
    ? {
        ...source,
        sessionId,
        history: source.history.filter(
          entry => !isShellIntegrationArtifact(entry),
        ),
      }
    : capability.shell
      ? {
          sessionId,
          shell: capability.shell,
          revision: 0,
          history: [],
          executables: [],
          truncated: false,
        }
      : null;
  return { capability, snapshot };
}

function parseExitCode(marker: string): number | null {
  const code = Number.parseInt(marker.split(';')[1] ?? '', 10);
  return Number.isFinite(code) ? code : null;
}

export function useTerminalAutocomplete({
  sessionId,
  enabled,
  connected,
  snippets = EMPTY_SNIPPETS,
  sendInput,
}: UseTerminalAutocompleteOptions) {
  const [capability, setCapability] =
    useState<TerminalAutocompleteCapability | null>(null);
  const [snapshot, setSnapshot] = useState<TerminalAutocompleteSnapshot | null>(
    null,
  );
  const [command, setCommand] = useState<CommandBufferState>(
    createEmptyCommandBuffer,
  );
  const [integrationReady, setIntegrationReady] = useState(false);
  const [dynamicSuggestions, setDynamicSuggestions] = useState<
    TerminalAutocompleteSuggestion[]
  >([]);
  const [pendingSnippet, setPendingSnippet] =
    useState<PendingAutocompleteSnippet | null>(null);

  const generationRef = useRef(0);
  const preparedRef = useRef(false);
  const preparingRef = useRef<Promise<void> | null>(null);
  const commandRef = useRef(command);
  const cwdRef = useRef<string | null>(null);
  const statsRef = useRef<Map<string, SessionCommandStat>>(new Map());
  const sessionSeqRef = useRef(0);
  const pendingCommandRef = useRef<string | null>(null);
  const cacheRef = useRef<Map<string, string>>(new Map());
  const inflightRef = useRef<Map<string, Promise<string>>>(new Map());
  const dynamicGenerationRef = useRef(0);
  const sendInputRef = useRef(sendInput);

  useEffect(() => {
    commandRef.current = command;
  }, [command]);
  useEffect(() => {
    sendInputRef.current = sendInput;
  }, [sendInput]);

  const prepare = useCallback(() => {
    if (!sessionId || !enabled || !connected || preparedRef.current) {
      return Promise.resolve();
    }
    if (preparingRef.current) return preparingRef.current;
    const generation = generationRef.current;
    const pending = prepareSessionAutocomplete(sessionId)
      .then(result => {
        if (generation !== generationRef.current) return;
        const normalized = withSessionId(sessionId, result);
        setCapability(normalized.capability);
        setSnapshot(normalized.snapshot);
      })
      .catch(() => {
        if (generation !== generationRef.current) return;
        setCapability({
          sessionId,
          status: 'degraded',
          sources: ['session-history'],
          reasonCode: 'metadata-unavailable',
        });
      })
      .finally(() => {
        if (generation === generationRef.current) {
          preparedRef.current = true;
          preparingRef.current = null;
        }
      });
    preparingRef.current = pending;
    return pending;
  }, [connected, enabled, sessionId]);

  useEffect(() => {
    generationRef.current += 1;
    preparedRef.current = false;
    preparingRef.current = null;
    commandRef.current = createEmptyCommandBuffer();
    cwdRef.current = null;
    statsRef.current = new Map();
    sessionSeqRef.current = 0;
    pendingCommandRef.current = null;
    cacheRef.current.clear();
    inflightRef.current.clear();
    dynamicGenerationRef.current += 1;
    setCapability(null);
    setSnapshot(null);
    setCommand(createEmptyCommandBuffer());
    setIntegrationReady(false);
    setDynamicSuggestions([]);
    setPendingSnippet(null);
  }, [connected, sessionId]);

  useEffect(() => {
    if (integrationReady) void prepare();
  }, [integrationReady, prepare]);

  const runCompletion = useCallback(
    (hostCommand: string): Promise<string> => {
      if (!sessionId) return Promise.resolve('');
      const cached = cacheRef.current.get(hostCommand);
      if (cached !== undefined) return Promise.resolve(cached);
      const inflight = inflightRef.current.get(hostCommand);
      if (inflight) return inflight;
      let query: Promise<string>;
      query = runSessionCompletion(sessionId, hostCommand)
        .then(result => {
          const cache = cacheRef.current;
          cache.set(hostCommand, result.stdout);
          while (cache.size > DYNAMIC_CACHE_MAX) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
          return result.stdout;
        })
        .catch(() => '')
        .finally(() => {
          if (inflightRef.current.get(hostCommand) === query) {
            inflightRef.current.delete(hostCommand);
          }
        });
      inflightRef.current.set(hostCommand, query);
      return query;
    },
    [sessionId],
  );

  useEffect(() => {
    const value = command.value;
    const request = resolveDynamicCompletion(null, value);
    if (
      !enabled ||
      !integrationReady ||
      capability?.status === 'unsupported' ||
      !request ||
      request.kind !== 'path'
    ) {
      setDynamicSuggestions([]);
      return;
    }
    const hostCommand = buildListCommand(request, cwdRef.current);
    const generation = (dynamicGenerationRef.current += 1);
    const apply = (stdout: string) => {
      if (
        generation !== dynamicGenerationRef.current ||
        commandRef.current.value !== value
      ) {
        return;
      }
      setDynamicSuggestions(
        parsePathListing(stdout, request).map(item => ({
          ...item,
          source: 'path' as const,
        })),
      );
    };
    const cached = cacheRef.current.get(hostCommand);
    if (cached !== undefined) {
      apply(cached);
      return;
    }
    const timer = setTimeout(
      () => void runCompletion(hostCommand).then(apply),
      DYNAMIC_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [
    capability?.status,
    command.value,
    enabled,
    integrationReady,
    runCompletion,
  ]);

  const suggestions = useMemo(() => {
    if (!enabled || !integrationReady || capability?.status === 'unsupported') {
      return [];
    }
    return getTerminalAutocompleteSuggestions(snapshot, command, {
      sessionStats: statsRef.current,
      currentCwd: cwdRef.current,
      dynamicCompletions: dynamicSuggestions,
      suppressHistory: dynamicSuggestions.length > 0,
      snippets,
      limit: 12,
    });
  }, [
    capability?.status,
    command,
    dynamicSuggestions,
    enabled,
    integrationReady,
    snapshot,
    snippets,
  ]);

  const applyAndSend = useCallback((data: string) => {
    const result = applyTerminalInput(commandRef.current, data);
    commandRef.current = result.state;
    setCommand(result.state);
    sendInputRef.current(data);
  }, []);

  const insertCommand = useCallback(
    (value: string) => {
      applyAndSend(`\x15${value}`);
      return value;
    },
    [applyAndSend],
  );

  const accept = useCallback(
    (suggestion: TerminalAutocompleteSuggestion): string | null => {
      if (suggestion.source === 'snippet') {
        const variables = parseSnippetVariables(suggestion.insertText);
        if (variables.length > 0) {
          setPendingSnippet({ command: suggestion.insertText, variables });
          return null;
        }
        return insertCommand(suggestion.insertText);
      }
      const current = commandRef.current.value;
      if (suggestion.insertText.startsWith(current)) {
        applyAndSend(suggestion.insertText.slice(current.length));
        return suggestion.insertText;
      } else {
        return insertCommand(suggestion.insertText);
      }
    },
    [applyAndSend, insertCommand],
  );

  const send = useCallback(
    (data: string): string | null => {
      if (data === '\t' && suggestions[0]) {
        return accept(suggestions[0]);
      }
      applyAndSend(data);
      return null;
    },
    [accept, applyAndSend, suggestions],
  );

  const handleShellIntegration = useCallback(
    (marker: string, reportedCommand?: string): string | null => {
      const kind = marker.split(';', 1)[0];
      if (marker === 'B;2') {
        setIntegrationReady(true);
        const ambiguous = { ...commandRef.current, ambiguous: true };
        commandRef.current = ambiguous;
        setCommand(ambiguous);
        return null;
      }
      if (kind === 'A' || marker === 'B') {
        setIntegrationReady(true);
        const empty = createEmptyCommandBuffer();
        commandRef.current = empty;
        setCommand(empty);
        return null;
      }
      if (kind === 'C') {
        const executed = (reportedCommand ?? commandRef.current.value).trim();
        if (executed) {
          const existing = statsRef.current.get(executed);
          sessionSeqRef.current += 1;
          statsRef.current.set(executed, {
            count: (existing?.count ?? 0) + 1,
            lastSeq: sessionSeqRef.current,
            lastExit: null,
            cwd: cwdRef.current,
          });
          pendingCommandRef.current = executed;
        }
        cacheRef.current.clear();
        dynamicGenerationRef.current += 1;
        setDynamicSuggestions([]);
        return executed || null;
      }
      if (kind === 'D') {
        const executed = pendingCommandRef.current;
        const current = executed ? statsRef.current.get(executed) : undefined;
        if (executed && current) {
          statsRef.current.set(executed, {
            ...current,
            lastExit: parseExitCode(marker),
          });
        }
        pendingCommandRef.current = null;
        cacheRef.current.clear();
        dynamicGenerationRef.current += 1;
      }
      return null;
    },
    [],
  );

  const handleCwd = useCallback((value: string) => {
    cwdRef.current = parseCwdFromOsc7(value);
  }, []);

  const confirmSnippet = useCallback(
    (values: Record<string, string>): string | null => {
      const pending = pendingSnippet;
      setPendingSnippet(null);
      if (pending)
        return insertCommand(resolveSnippetCommand(pending.command, values));
      return null;
    },
    [insertCommand, pendingSnippet],
  );

  return {
    command: command.value,
    suggestions,
    pendingSnippet,
    send,
    accept,
    handleShellIntegration,
    handleCwd,
    confirmSnippet,
    cancelSnippet: () => setPendingSnippet(null),
  };
}
