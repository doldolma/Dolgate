import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CoreEvent,
  HostDetectedOs,
  TerminalAutocompleteCapability,
  TerminalAutocompleteSnapshot,
} from '@shared';
import { normalizeHostOsId } from '@shared';
import {
  prepareTerminalAutocomplete,
  queryTerminalCompletion,
  stopTerminalAutocomplete,
  subscribeToTerminalEvents,
} from '../services/desktop/terminal';
import {
  applyTerminalInput,
  createEmptyCommandBuffer,
  getTerminalAutocompleteSuggestions,
  type CommandBufferState,
  type SessionCommandStat,
  type TerminalAutocompleteSuggestion,
} from '../lib/terminal-autocomplete';
import {
  parseSnippetVariables,
  resolveSnippetCommand,
  type SnippetVariable,
} from '../lib/snippet';
import type { CommandFinishedInfo } from '../lib/command-notification';
import {
  getCachedCommandSpec,
  hasCommandModule,
  hasCommandSpec,
  loadCommandModule,
  loadCommandSpec,
} from '../lib/command-spec/store';
import {
  buildGeneratorShellLine,
  buildListCommand,
  parsePathListing,
  resolveDynamicCompletion,
} from '../lib/command-spec/dynamic';
import {
  figSuggestionsToCompletions,
  findArgGenerators,
  runGenerators,
  type FigExecuteCommand,
} from '../lib/command-spec/fig-runtime';
import type { CommandSpec } from '../lib/command-spec/types';
import { setShellHistory } from '../lib/shell-history-registry';

// The overlay shows ~5 rows at once but keeps a deeper list so arrow keys can
// scroll through more candidates (TerminalAutocompleteOverlay windows the view).
const MAX_SUGGESTIONS = 20;

function leadingCommand(value: string): string {
  return value.trimStart().split(/\s+/, 1)[0] ?? '';
}

function parseExitCode(marker: string): number | null {
  // OSC 133;D;<exit> — the exit code follows the first ';'.
  const parts = marker.split(';');
  if (parts.length < 2) {
    return null;
  }
  const code = Number.parseInt(parts[1], 10);
  return Number.isFinite(code) ? code : null;
}

export function parseCwdFromOsc7(data: string): string | null {
  // OSC 7 payload: file://<host><abs-path>
  const windowsFileMatch = data.match(/^file:\/\/\/([A-Za-z]:\/.*)$/);
  if (windowsFileMatch) {
    try {
      return decodeURIComponent(windowsFileMatch[1]).replace(/\//g, '\\');
    } catch {
      return windowsFileMatch[1].replace(/\//g, '\\');
    }
  }
  const match = data.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!match) {
    return data || null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

// Dynamic completion runs read-only commands on the host, so misses are
// debounced and results cached; cache lifetime is one prompt (cleared on the
// OSC 133 C/D boundaries so host-state changes refresh next prompt).
const DYNAMIC_DEBOUNCE_MS = 120;
const DYNAMIC_CACHE_MAX = 32;

interface DynamicSuggestionState {
  value: string;
  items: TerminalAutocompleteSuggestion[];
}

const EMPTY_DYNAMIC: DynamicSuggestionState = { value: '', items: [] };

interface UseTerminalAutocompleteOptions {
  sessionId: string;
  enabled: boolean;
  connected: boolean;
  lazyPrepare: boolean;
  sendInput: (data: string) => void;
  /** Saved snippets to surface as candidates (synced; supplied by the caller). */
  snippets?: readonly { label: string; command: string; keyword?: string | null }[];
  /** 명령이 끝났을 때(OSC 133;D) 호출 — 명령 완료 알림 등 후처리에 사용. */
  onCommandFinished?: (info: CommandFinishedInfo) => void;
  /**
   * 연결할 때 감지한 OS 를 받는다(호스트 아이콘용).
   *
   * 이 훅이 직접 호스트를 쓰지 않는 이유: 어느 호스트에 쓸지는 호출부가 안다(로컬 터미널·
   * 컨테이너 세션처럼 기록할 호스트가 없는 경우도 있다).
   */
  onHostOsDetected?: (detectedOs: HostDetectedOs) => void;
}

const EMPTY_SNIPPETS: readonly { label: string; command: string; keyword?: string | null }[] = [];

function isPreparationTrigger(data: string): boolean {
  return [...data].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
}

function normalizeCapability(
  sessionId: string,
  payload: Record<string, unknown>,
): TerminalAutocompleteCapability {
  const shell = payload.shell === 'bash' || payload.shell === 'zsh'
    ? payload.shell
    : undefined;
  const status =
    payload.status === 'ready' ||
    payload.status === 'degraded' ||
    payload.status === 'unsupported' ||
    payload.status === 'probing'
      ? payload.status
      : 'unsupported';
  return {
    sessionId,
    status,
    shell,
    sources: Array.isArray(payload.sources)
      ? payload.sources.filter(
          (source): source is 'history' | 'executable' | 'session-history' =>
            source === 'history' ||
            source === 'executable' ||
            source === 'session-history',
        )
      : [],
    reasonCode:
      payload.reasonCode === 'unsupported-shell' ||
      payload.reasonCode === 'probe-timeout' ||
      payload.reasonCode === 'metadata-unavailable'
        ? payload.reasonCode
        : undefined,
  };
}

// Our own OSC 133 / snapshot injection can leak into the shell history (the
// leading-space + `history -d` mitigations aren't bulletproof, and injection can
// concatenate onto a half-typed line and execute). Never suggest those lines.
function isShellIntegrationArtifact(entry: string): boolean {
  return (
    entry.includes('__ds_') ||
    entry.includes(']133;') ||
    entry.includes(']6973;') ||
    entry.includes(']7;file://')
  );
}

/**
 * 코어가 보낸 OS 값을 레코드에 넣을 모양으로 다듬는다. id 가 없으면 없는 것으로 본다 —
 * 아이콘을 고르는 유일한 기준이라 빈 값을 저장할 이유가 없다.
 */
function normalizeDetectedOs(value: unknown): HostDetectedOs | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeHostOsId(typeof record.id === 'string' ? record.id : null);
  if (!id) {
    return null;
  }
  const like = typeof record.like === 'string' ? record.like.trim() : '';
  const prettyName =
    typeof record.prettyName === 'string' ? record.prettyName.trim() : '';
  return {
    id,
    like: like.length > 0 ? like : null,
    prettyName: prettyName.length > 0 ? prettyName : null,
  };
}

function normalizeSnapshot(
  sessionId: string,
  payload: Record<string, unknown>,
): TerminalAutocompleteSnapshot | null {
  if (payload.shell !== 'bash' && payload.shell !== 'zsh') {
    return null;
  }
  return {
    sessionId,
    shell: payload.shell,
    revision: typeof payload.revision === 'number' ? payload.revision : 0,
    history: Array.isArray(payload.history)
      ? payload.history.filter(
          (value): value is string =>
            typeof value === 'string' && !isShellIntegrationArtifact(value),
        )
      : [],
    executables: Array.isArray(payload.executables)
      ? payload.executables.flatMap((value) => {
          if (!value || typeof value !== 'object') {
            return [];
          }
          const record = value as Record<string, unknown>;
          if (typeof record.name !== 'string') {
            return [];
          }
          return [{
            name: record.name,
            path: typeof record.path === 'string' ? record.path : undefined,
          }];
        })
      : [],
    truncated: payload.truncated === true,
  };
}

export function useTerminalAutocomplete({
  sessionId,
  enabled,
  connected,
  lazyPrepare,
  sendInput,
  snippets = EMPTY_SNIPPETS,
  onCommandFinished,
  onHostOsDetected,
}: UseTerminalAutocompleteOptions) {
  const [capability, setCapability] =
    useState<TerminalAutocompleteCapability | null>(null);
  const [snapshot, setSnapshot] =
    useState<TerminalAutocompleteSnapshot | null>(null);
  const [command, setCommand] = useState<CommandBufferState>(
    createEmptyCommandBuffer,
  );
  const [dismissedValue, setDismissedValue] = useState<string | null>(null);
  // Which suggestion the keyboard has highlighted (0 = top, the default that
  // Tab/→ accepts). Arrow keys move it; typing resets it to the top.
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Gated on the OSC 133 shell-integration handshake: suggestions only appear
  // once a prompt marker confirms integration, or tmux restores that confirmation.
  const [integrationReady, setIntegrationReady] = useState(false);
  // Lazily-loaded Fig-derived spec for the leading command (for option/subcommand
  // discovery beyond what the user has typed).
  const [commandSpec, setCommandSpec] = useState<CommandSpec | null>(null);
  // Saved snippets (synced) — surfaced as autocomplete candidates, matched by
  // keyword/label and inserted as the full command. Variables prompt first.
  const [pendingSnippet, setPendingSnippet] = useState<{
    command: string;
    variables: SnippetVariable[];
  } | null>(null);
  const preparedRef = useRef(false);
  const preparingRef = useRef<Promise<void> | null>(null);
  const queuedInputRef = useRef<string[]>([]);
  const activeRef = useRef(false);
  const generationRef = useRef(0);
  const commandRef = useRef(command);
  const snapshotRef = useRef(snapshot);
  const sendInputRef = useRef(sendInput);
  // Commands run during this session, keyed by command text, with exit code
  // (OSC 133;D) and cwd (OSC 7) — the signals raw file history can't provide.
  const sessionStatsRef = useRef<Map<string, SessionCommandStat>>(new Map());
  const sessionSeqRef = useRef(0);
  const pendingCommandRef = useRef<string | null>(null);
  // OSC 133;C(명령 실행 시작) 시각 — D에서 소요 시간 계산에 사용.
  const commandStartedAtRef = useRef<number | null>(null);
  const currentCwdRef = useRef<string | null>(null);
  const commandSpecRef = useRef<CommandSpec | null>(null);
  const commandSpecNameRef = useRef<string | null>(null);
  // Dynamic (host-resolved) completions: cached stdout keyed by host command,
  // in-flight dedup, and a generation counter to drop stale async results.
  const [dynamicSuggestions, setDynamicSuggestions] =
    useState<DynamicSuggestionState>(EMPTY_DYNAMIC);
  const dynamicSuggestionsRef = useRef<DynamicSuggestionState>(EMPTY_DYNAMIC);
  const selectedIndexRef = useRef(0);
  const suggestionsRef = useRef<TerminalAutocompleteSuggestion[]>([]);
  const completionCacheRef = useRef<Map<string, string>>(new Map());
  const completionInflightRef = useRef<Map<string, Promise<string>>>(new Map());
  const dynamicGenerationRef = useRef(0);
  const snippetsRef = useRef(snippets);
  const onCommandFinishedRef = useRef(onCommandFinished);
  const onHostOsDetectedRef = useRef(onHostOsDetected);
  const pendingSnippetRef = useRef(pendingSnippet);
  const autocompleteUnsupported = capability?.status === 'unsupported';

  useEffect(() => {
    commandRef.current = command;
  }, [command]);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    snippetsRef.current = snippets;
  }, [snippets]);
  useEffect(() => {
    onCommandFinishedRef.current = onCommandFinished;
    onHostOsDetectedRef.current = onHostOsDetected;
  }, [onCommandFinished, onHostOsDetected]);
  useEffect(() => {
    pendingSnippetRef.current = pendingSnippet;
  }, [pendingSnippet]);
  useEffect(() => {
    sendInputRef.current = sendInput;
  }, [sendInput]);
  useEffect(() => {
    commandSpecRef.current = commandSpec;
  }, [commandSpec]);
  useEffect(() => {
    dynamicSuggestionsRef.current = dynamicSuggestions;
  }, [dynamicSuggestions]);

  // Lazily load the Fig-derived spec for the leading command once the user is
  // typing arguments, so we can suggest options/subcommands they haven't used.
  useEffect(() => {
    if (!enabled || !integrationReady || autocompleteUnsupported) {
      if (commandSpecNameRef.current !== null) {
        commandSpecNameRef.current = null;
        setCommandSpec(null);
      }
      return;
    }
    const leading = command.value.includes(' ')
      ? leadingCommand(command.value)
      : '';
    if (!leading || !hasCommandSpec(leading)) {
      if (commandSpecNameRef.current !== null) {
        commandSpecNameRef.current = null;
        setCommandSpec(null);
      }
      return;
    }
    if (commandSpecNameRef.current === leading) {
      return;
    }
    commandSpecNameRef.current = leading;
    const cached = getCachedCommandSpec(leading);
    if (cached) {
      setCommandSpec(cached);
      return;
    }
    let cancelled = false;
    void loadCommandSpec(leading).then((spec) => {
      if (!cancelled && commandSpecNameRef.current === leading) {
        setCommandSpec(spec);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [autocompleteUnsupported, command.value, enabled, integrationReady]);

  const runCompletionQuery = useCallback(
    (hostCommand: string): Promise<string> => {
      // Cache hit → no host round-trip. This is what lets typing a prefix
      // (docker logs se…) filter the already-fetched list client-side instead of
      // re-running `docker ps` on every keystroke. Cache lifetime is one prompt
      // (cleared on the OSC 133 C/D boundary).
      const cached = completionCacheRef.current.get(hostCommand);
      if (cached !== undefined) {
        completionCacheRef.current.delete(hostCommand);
        completionCacheRef.current.set(hostCommand, cached); // refresh LRU recency
        return Promise.resolve(cached);
      }
      // Dedup concurrent identical queries so rapid keystrokes share one call.
      const inflight = completionInflightRef.current.get(hostCommand);
      if (inflight) {
        return inflight;
      }
      // 자동완성은 종료 코드를 쓰지 않는다 — 실패한 generator 는 "제안 없음" 으로 끝나는 것이
      // 맞다(사람이 치는 중에 오류를 띄울 자리가 없다).
      const promise = queryTerminalCompletion(sessionId, hostCommand)
        .then(({ stdout }) => {
          const cache = completionCacheRef.current;
          cache.delete(hostCommand);
          cache.set(hostCommand, stdout);
          while (cache.size > DYNAMIC_CACHE_MAX) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) {
              break;
            }
            cache.delete(oldest);
          }
          return stdout;
        })
        // 자동완성은 끝까지 best-effort 다. 보조 채널이 답을 못 주면(타임아웃·채널 재시작)
        // 제안이 없는 것으로 둔다 — 타이핑 중에 오류를 띄우거나, 잡히지 않은 rejection 을
        // 흘리지 않는다. 실패를 실패로 다뤄야 하는 쪽은 세션 패널이고, 그쪽은 직접 받는다.
        .catch(() => '')
        .finally(() => {
          completionInflightRef.current.delete(hostCommand);
        });
      completionInflightRef.current.set(hostCommand, promise);
      return promise;
    },
    [sessionId],
  );

  // Fig generators call this to run a command on the host. argv is shell-escaped
  // and routed through the same cached/deduped aux-channel path as everything else.
  const executeCommand = useCallback<FigExecuteCommand>(
    ({ command: cmd, args, cwd }) =>
      runCompletionQuery(
        buildGeneratorShellLine(cmd, args ?? [], cwd ?? currentCwdRef.current),
      ).then((stdout) => ({ stdout, stderr: '', exitCode: 0 })),
    [runCompletionQuery],
  );

  // Resolve dynamic (file path / generator) completions over the aux channel.
  // Cache hits are synchronous (no host call); misses are debounced and deduped.
  useEffect(() => {
    const value = command.value;
    const clear = () =>
      setDynamicSuggestions((prev) => (prev === EMPTY_DYNAMIC ? prev : EMPTY_DYNAMIC));
    if (!enabled || !integrationReady || autocompleteUnsupported) {
      clear();
      return;
    }
    const fresh = (generation: number) =>
      generation === dynamicGenerationRef.current && commandRef.current.value === value;
    const request = resolveDynamicCompletion(commandSpec, value);
    if (!request) {
      clear();
      return;
    }
    const cwd = currentCwdRef.current;

    if (request.kind === 'path') {
      const hostCommand = buildListCommand(request, cwd);
      const toItems = (stdout: string): TerminalAutocompleteSuggestion[] =>
        parsePathListing(stdout, request).map((completion) => ({
          insertText: completion.insertText,
          source: 'path',
        }));
      const cached = completionCacheRef.current.get(hostCommand);
      if (cached !== undefined) {
        setDynamicSuggestions({ value, items: toItems(cached) });
        return;
      }
      const generation = (dynamicGenerationRef.current += 1);
      const timer = setTimeout(() => {
        void runCompletionQuery(hostCommand)
          .then((stdout) => {
            if (fresh(generation)) {
              setDynamicSuggestions({ value, items: toItems(stdout) });
            }
          })
          .catch(() => undefined);
      }, DYNAMIC_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }

    // Generator: load the bundled spec module, walk to the current arg's
    // generator(s), and run them on the host (executeCommand caches/dedups).
    if (!hasCommandModule(request.command)) {
      clear();
      return;
    }
    const generation = (dynamicGenerationRef.current += 1);
    const timer = setTimeout(() => {
      void (async () => {
        const spec = await loadCommandModule(request.command);
        const generators = spec
          ? findArgGenerators(spec, request.tokens)
          : undefined;
        if (!generators) {
          if (fresh(generation)) {
            setDynamicSuggestions({ value, items: [] });
          }
          return;
        }
        const suggestions = await runGenerators(generators, {
          tokens: request.tokens,
          searchTerm: request.base,
          cwd: cwd ?? '',
          executeCommand,
        });
        if (!fresh(generation)) {
          return;
        }
        const items: TerminalAutocompleteSuggestion[] = figSuggestionsToCompletions(
          suggestions,
          request.before,
          request.base,
        ).map((completion) => ({
          insertText: completion.insertText,
          source: 'generator' as const,
          ...(completion.displayText ? { displayText: completion.displayText } : {}),
          ...(completion.description ? { description: completion.description } : {}),
        }));
        setDynamicSuggestions({ value, items });
      })().catch(() => undefined);
    }, DYNAMIC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    autocompleteUnsupported,
    command.value,
    commandSpec,
    enabled,
    executeCommand,
    integrationReady,
    runCompletionQuery,
  ]);

  const recordExecutedCommand = useCallback((commandText: string) => {
    const stats = sessionStatsRef.current;
    const existing = stats.get(commandText);
    sessionSeqRef.current += 1;
    stats.set(commandText, {
      count: (existing?.count ?? 0) + 1,
      lastSeq: sessionSeqRef.current,
      lastExit: null,
      cwd: currentCwdRef.current,
    });
    // Tie the upcoming OSC 133;D exit code back to this command.
    pendingCommandRef.current = commandText;
  }, []);

  const setSelected = useCallback((index: number) => {
    selectedIndexRef.current = index;
    setSelectedIndex(index);
  }, []);

  const applyAndSend = useCallback(
    (data: string) => {
      const result = applyTerminalInput(commandRef.current, data);
      commandRef.current = result.state;
      setCommand(result.state);
      setDismissedValue(null);
      setSelected(0); // typing changes the list → reset highlight to the top
      if (result.executed) {
        recordExecutedCommand(result.executed);
      }
      sendInputRef.current(data);
    },
    [recordExecutedCommand, setSelected],
  );

  // Insert a snippet by clearing the current line (\x15 empties the buffer, in
  // both the shell and our local buffer) and sending the full command.
  const insertSnippetCommand = useCallback(
    (command: string) => {
      applyAndSend('\x15' + command);
    },
    [applyAndSend],
  );

  const acceptSnippet = useCallback(
    (command: string) => {
      const variables = parseSnippetVariables(command);
      if (variables.length > 0) {
        // Has {{variables}} → prompt for values before inserting.
        setPendingSnippet({ command, variables });
        return;
      }
      insertSnippetCommand(command);
    },
    [insertSnippetCommand],
  );

  const confirmSnippet = useCallback(
    (values: Record<string, string>) => {
      const pending = pendingSnippetRef.current;
      setPendingSnippet(null);
      if (!pending) {
        return;
      }
      insertSnippetCommand(resolveSnippetCommand(pending.command, values));
    },
    [insertSnippetCommand],
  );

  const cancelSnippet = useCallback(() => setPendingSnippet(null), []);

  const prepare = useCallback(() => {
    if (!enabled || !connected || preparedRef.current) {
      return Promise.resolve();
    }
    if (preparingRef.current) {
      return preparingRef.current;
    }
    const generation = generationRef.current;
    const pending = prepareTerminalAutocomplete(sessionId)
      .catch(() => {
        if (generation !== generationRef.current) {
          return;
        }
        setCapability({
          sessionId,
          status: 'degraded',
          sources: ['session-history'],
          reasonCode: 'metadata-unavailable',
        });
      })
      .finally(() => {
        const queued = queuedInputRef.current.splice(0);
        if (generation !== generationRef.current) {
          preparingRef.current = null;
          queued.forEach((data) => sendInputRef.current(data));
          return;
        }
        preparedRef.current = true;
        activeRef.current = true;
        preparingRef.current = null;
        queued.forEach(applyAndSend);
      });
    preparingRef.current = pending;
    return pending;
  }, [applyAndSend, connected, enabled, sessionId]);

  useEffect(() => {
    generationRef.current += 1;
    preparedRef.current = false;
    activeRef.current = false;
    preparingRef.current = null;
    queuedInputRef.current = [];
    commandRef.current = createEmptyCommandBuffer();
    snapshotRef.current = null;
    sessionStatsRef.current = new Map();
    sessionSeqRef.current = 0;
    pendingCommandRef.current = null;
    currentCwdRef.current = null;
    commandSpecRef.current = null;
    commandSpecNameRef.current = null;
    completionCacheRef.current.clear();
    completionInflightRef.current.clear();
    dynamicGenerationRef.current += 1;
    dynamicSuggestionsRef.current = EMPTY_DYNAMIC;
    setCommand(createEmptyCommandBuffer());
    setCapability(null);
    setSnapshot(null);
    setShellHistory(sessionId, null);
    setDismissedValue(null);
    setIntegrationReady(false);
    setCommandSpec(null);
    setDynamicSuggestions(EMPTY_DYNAMIC);
  }, [sessionId]);

  useEffect(() => {
    if (!enabled || !connected || lazyPrepare) {
      return;
    }
    void prepare();
  }, [connected, enabled, lazyPrepare, prepare]);

  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1;
	  const shouldStop = activeRef.current || preparingRef.current != null;
      preparedRef.current = false;
      preparingRef.current = null;
      queuedInputRef.current = [];
      commandRef.current = createEmptyCommandBuffer();
      snapshotRef.current = null;
      sessionStatsRef.current = new Map();
      sessionSeqRef.current = 0;
      pendingCommandRef.current = null;
      currentCwdRef.current = null;
      commandSpecRef.current = null;
      commandSpecNameRef.current = null;
      completionCacheRef.current.clear();
      completionInflightRef.current.clear();
      dynamicGenerationRef.current += 1;
      dynamicSuggestionsRef.current = EMPTY_DYNAMIC;
      setCommand(createEmptyCommandBuffer());
      setCapability(null);
      setSnapshot(null);
    setShellHistory(sessionId, null);
      setIntegrationReady(false);
      setCommandSpec(null);
      setDynamicSuggestions(EMPTY_DYNAMIC);
      activeRef.current = false;
      if (shouldStop) {
        void stopTerminalAutocomplete(sessionId).catch(() => undefined);
      }
    }
  }, [enabled, sessionId]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    return subscribeToTerminalEvents((event: CoreEvent) => {
        if (event.sessionId !== sessionId) {
          return;
        }
        if (event.type === 'terminalAutocompleteCapability') {
          setCapability(normalizeCapability(sessionId, event.payload));
        } else if (event.type === 'terminalAutocompleteShellState') {
          // tmux keeps the shell hooks across detach, but capture-pane cannot replay
          // their OSC markers. Restore readiness without clearing input as A does.
          // shellReady only identifies the metadata shell; it does not confirm hooks.
          if (event.payload.kind === 'integrationRestored') {
            if (currentCwdRef.current === null && typeof event.payload.cwd === 'string') {
              currentCwdRef.current = event.payload.cwd || null;
            }
            setIntegrationReady(true);
          }
        } else if (event.type === 'terminalAutocompleteSnapshot') {
          // OS 는 스냅샷 정규화 **밖에서** 읽는다. 아래 normalizeSnapshot 은 bash·zsh 가 아니면
          // 전체를 버리는데, 아이콘은 셸과 상관이 없다 — ash 를 쓰는 NAS 도 잡혀야 한다.
          const detectedOs = normalizeDetectedOs(
            (event.payload as Record<string, unknown>).os,
          );
          if (detectedOs) {
            onHostOsDetectedRef.current?.(detectedOs);
          }
          const next = normalizeSnapshot(sessionId, event.payload);
          snapshotRef.current = next;
          setSnapshot(next);
          // 세션 패널의 히스토리 섹션도 같은 값을 본다 — 원격에 다시 묻지 않기 위해서다.
          setShellHistory(sessionId, next?.history ?? null);
        }
      });
  }, [enabled, sessionId]);

  useEffect(
    () => () => {
      if (activeRef.current || preparingRef.current) {
        void stopTerminalAutocomplete(sessionId).catch(() => undefined);
      }
    },
    [sessionId],
  );

  const suggestions = useMemo(() => {
    if (
      !enabled ||
      !integrationReady ||
      autocompleteUnsupported ||
      dismissedValue === command.value
    ) {
      return [];
    }
    return getTerminalAutocompleteSuggestions(snapshot, command, {
      sessionStats: sessionStatsRef.current,
      currentCwd: currentCwdRef.current,
      commandSpec,
      dynamicCompletions:
        dynamicSuggestions.value === command.value
          ? dynamicSuggestions.items
          : undefined,
      // Path args (cd/ls/…): the live listing is authoritative, so drop stale
      // history paths.
      suppressHistory:
        resolveDynamicCompletion(commandSpec, command.value)?.kind === 'path',
      snippets,
      limit: MAX_SUGGESTIONS,
    });
  }, [
    command,
    commandSpec,
    autocompleteUnsupported,
    dismissedValue,
    dynamicSuggestions,
    enabled,
    integrationReady,
    snapshot,
    snippets,
  ]);

  // Mirror the rendered list for the keyboard handlers, and clamp the highlight
  // if the list shrank under it.
  useEffect(() => {
    suggestionsRef.current = suggestions;
    if (selectedIndexRef.current > suggestions.length - 1) {
      setSelected(suggestions.length > 0 ? suggestions.length - 1 : 0);
    }
  }, [suggestions, setSelected]);

  // Accept the highlighted suggestion (the top one unless arrow keys moved it).
  const acceptSelectedSuggestion = useCallback(() => {
    if (!integrationReady || autocompleteUnsupported) {
      return false;
    }
    const dynamic = dynamicSuggestionsRef.current;
    const list = getTerminalAutocompleteSuggestions(
      snapshotRef.current,
      commandRef.current,
      {
        sessionStats: sessionStatsRef.current,
        currentCwd: currentCwdRef.current,
        commandSpec: commandSpecRef.current,
        dynamicCompletions:
          dynamic.value === commandRef.current.value ? dynamic.items : undefined,
        suppressHistory:
          resolveDynamicCompletion(commandSpecRef.current, commandRef.current.value)
            ?.kind === 'path',
        snippets: snippetsRef.current,
        limit: MAX_SUGGESTIONS,
      },
    );
    if (list.length === 0) {
      return false;
    }
    const suggestion = list[Math.min(selectedIndexRef.current, list.length - 1)];
    if (!suggestion) {
      return false;
    }
    if (suggestion.source === 'snippet') {
      acceptSnippet(suggestion.insertText);
      return true;
    }
    if (!suggestion.insertText.startsWith(commandRef.current.value)) {
      return false;
    }
    const suffix = suggestion.insertText.slice(commandRef.current.value.length);
    if (!suffix) {
      return false;
    }
    applyAndSend(suffix);
    return true;
  }, [acceptSnippet, applyAndSend, autocompleteUnsupported, integrationReady]);

  const handleInput = useCallback(
    (data: string) => {
      if (!enabled || !connected) {
        sendInputRef.current(data);
        return;
      }
      const popupOpen = suggestionsRef.current.length > 0;
      // Arrow keys arrive as either CSI (\x1b[A) or SS3 (\x1bOA) depending on the
      // shell's cursor-key mode (DECCKM / `smkx`), so accept both forms.
      const isAccept = data === '\t' || data === '\x1b[C' || data === '\x1bOC';
      const isDown = data === '\x1b[B' || data === '\x1bOB';
      const isUp = data === '\x1b[A' || data === '\x1bOA';
      // Tab / → accept the highlighted suggestion.
      if (isAccept && acceptSelectedSuggestion()) {
        return;
      }
      // Enter accepts the highlighted suggestion ONLY when the user has navigated
      // below the top item. At the top (the default) Enter runs the command as
      // usual, so the normal "type → Enter" flow isn't hijacked.
      if (
        (data === '\r' || data === '\n') &&
        popupOpen &&
        selectedIndexRef.current > 0 &&
        acceptSelectedSuggestion()
      ) {
        return;
      }
      if (popupOpen) {
        // ↓ moves the highlight down the list.
        if (isDown) {
          setSelected(
            Math.min(suggestionsRef.current.length - 1, selectedIndexRef.current + 1),
          );
          return;
        }
        // ↑ moves it up; at the top, fall through so the shell still gets ↑
        // (history recall) instead of trapping the user in the popup.
        if (isUp && selectedIndexRef.current > 0) {
          setSelected(selectedIndexRef.current - 1);
          return;
        }
        // Esc dismisses the popup.
        if (data === '\x1b') {
          setDismissedValue(commandRef.current.value);
          return;
        }
      }
      if (!preparedRef.current) {
        if (!preparingRef.current && !isPreparationTrigger(data)) {
          applyAndSend(data);
          return;
        }
        queuedInputRef.current.push(data);
        void prepare();
        return;
      }
      applyAndSend(data);
    },
    [acceptSelectedSuggestion, applyAndSend, connected, enabled, prepare, setSelected],
  );

  const acceptSuggestion = useCallback(
    (suggestion: TerminalAutocompleteSuggestion) => {
      if (suggestion.source === 'snippet') {
        acceptSnippet(suggestion.insertText);
        return;
      }
      if (!suggestion.insertText.startsWith(commandRef.current.value)) {
        return;
      }
      applyAndSend(suggestion.insertText.slice(commandRef.current.value.length));
    },
    [acceptSnippet, applyAndSend],
  );

  const handleShellMarker = useCallback((marker: string) => {
    const kind = marker.charAt(0);
    if (kind === 'A') {
      // OSC 133;A = a fresh prompt was drawn. Seeing it confirms the shell
      // integration handshake and means the command line is empty again, so we
      // can trust prompt boundaries instead of guessing from terminal output.
      setIntegrationReady(true);
      const next = createEmptyCommandBuffer();
      commandRef.current = next;
      setCommand(next);
      setDismissedValue(null);
      setSelected(0);
      return;
    }
    if (kind === 'C') {
      // 명령 실행 시작 시각을 기록 — D에서 소요 시간 계산에 사용.
      commandStartedAtRef.current = Date.now();
    }
    if (kind === 'C' || kind === 'D') {
      // OSC 133;C/D = a command is starting/finishing. Host state (files,
      // branches, …) may change, so drop the dynamic cache and supersede any
      // in-flight/awaited query — the next prompt re-fetches fresh.
      completionCacheRef.current.clear();
      completionInflightRef.current.clear();
      dynamicGenerationRef.current += 1;
    }
    if (kind === 'D') {
      // OSC 133;D;<exit> = the command finished. Attach its exit code so failed
      // commands can be dropped from suggestions, and notify the caller (명령
      // 완료 알림 등) with the exit code and elapsed time.
      const exitCode = parseExitCode(marker);
      const startedAt = commandStartedAtRef.current;
      commandStartedAtRef.current = null;
      const pending = pendingCommandRef.current;
      pendingCommandRef.current = null;
      if (pending) {
        const stat = sessionStatsRef.current.get(pending);
        if (stat) {
          stat.lastExit = exitCode;
        }
      }
      onCommandFinishedRef.current?.({
        command: pending,
        exitCode,
        durationMs: startedAt !== null ? Date.now() - startedAt : null,
      });
    }
  }, [setSelected]);

  const handleCwd = useCallback((data: string) => {
    currentCwdRef.current = parseCwdFromOsc7(data);
  }, []);

  return {
    capability,
    command,
    suggestions,
    selectedIndex,
    handleInput,
    acceptSuggestion,
    handleShellMarker,
    handleCwd,
    pendingSnippet,
    confirmSnippet,
    cancelSnippet,
  };
}
