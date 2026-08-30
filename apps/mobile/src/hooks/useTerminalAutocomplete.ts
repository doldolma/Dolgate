import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyTerminalInput,
  buildGeneratorShellLine,
  buildListCommand,
  figSuggestionsToCompletions,
  findArgGenerators,
  runGenerators,
  createEmptyCommandBuffer,
  getTerminalAutocompleteSuggestions,
  parsePathListing,
  resolveDynamicCompletion,
  type CommandBufferState,
  type CommandSpec,
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
  getCachedCommandSpec,
  hasCommandGeneratorModule,
  hasCommandSpec,
  loadCommandGeneratorModule,
  loadCommandSpec,
  primeCommandSpecs,
} from '../lib/command-spec';
import {
  parseSnippetVariables,
  resolveSnippetCommand,
  type SnippetVariable,
} from '../lib/snippet-variables';

const EMPTY_SNIPPETS: readonly SnippetRecord[] = [];

function leadingCommand(value: string): string {
  return value.trimStart().split(/\s+/, 1)[0] ?? '';
}
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
  // **어느 입력의 결과인지 함께 담는다.** 목록만 들고 있으면 사용자가 계속 타이핑하는 동안
  // 이전 입력의 경로 목록이 잠깐 그대로 보인다(데스크톱과 같은 규칙).
  const [dynamicSuggestions, setDynamicSuggestions] = useState<{
    value: string;
    items: TerminalAutocompleteSuggestion[];
  }>({ value: '', items: [] });
  // 이 명령의 스펙(서브커맨드·옵션). 엔진에서 받아 오므로 비동기라, 오기 전에는 null 이다.
  const [commandSpec, setCommandSpec] = useState<CommandSpec | null>(null);
  const [pendingSnippet, setPendingSnippet] =
    useState<PendingAutocompleteSnippet | null>(null);

  const generationRef = useRef(0);
  const commandSpecNameRef = useRef<string | null>(null);
  // 마지막 프롬프트 경계 이후에 명령 완료(D) 마커가 있었는지. 진짜 새 프롬프트는 항상
  // D(완료·Ctrl-C)로 끝나지만, SIGWINCH 재드로잉(모바일 키보드 개폐로 터미널이 리사이즈될 때)은
  // D 없이 A·B 를 재발행한다 — 타이핑 중인 버퍼를 그 재드로잉이 지우지 않게 하기 위해
  // D 로만 "진짜 경계" 를 판정한다.
  const sawCompletionRef = useRef(false);
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
    setDynamicSuggestions({ value: '', items: [] });
    setPendingSnippet(null);
    sawCompletionRef.current = false;
  }, [connected, sessionId]);

  useEffect(() => {
    if (integrationReady) void prepare();
  }, [integrationReady, prepare]);

  // 스펙 목록을 미리 받아 둔다. 없는 이름을 칠 때마다 다리를 건너지 않기 위한 것이라, 첫
  // 타이핑이 이 왕복을 기다리지 않게 세션이 준비될 때 한 번만 부른다.
  useEffect(() => {
    if (integrationReady) void primeCommandSpecs();
  }, [integrationReady]);

  const runCompletion = useCallback(
    (hostCommand: string): Promise<string> => {
      if (!sessionId) return Promise.resolve('');
      const cached = cacheRef.current.get(hostCommand);
      if (cached !== undefined) return Promise.resolve(cached);
      const inflight = inflightRef.current.get(hostCommand);
      if (inflight) return inflight;
      const generation = generationRef.current;
      let query: Promise<string>;
      query = runSessionCompletion(sessionId, hostCommand)
        .then(result => {
          if (generation !== generationRef.current) return result.stdout;
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
    // **스펙을 넘긴다.** null 을 넘기던 동안 제너레이터 인자(docker logs 의 컨테이너 이름 등)가
    // 아예 해석되지 않아, 모바일에는 경로 완성만 있었다.
    const request = resolveDynamicCompletion(commandSpec, value);
    if (
      !enabled ||
      !integrationReady ||
      capability?.status === 'unsupported' ||
      !request
    ) {
      setDynamicSuggestions({ value, items: [] });
      return;
    }
    const fresh = (generation: number) =>
      generation === dynamicGenerationRef.current &&
      commandRef.current.value === value;

    if (request.kind === 'generator') {
      // 데스크톱과 **같은 런타임·같은 모듈**을 쓴다(shared-core 의 fig-runtime). 모듈 본문은
      // 여기서 처음 require 될 때 실행된다 — Metro 가 미리 묶어 두기만 한다.
      if (!hasCommandGeneratorModule(request.command)) {
        setDynamicSuggestions({ value, items: [] });
        return;
      }
      const generation = (dynamicGenerationRef.current += 1);
      const cwd = cwdRef.current;
      const timer = setTimeout(() => {
        void (async () => {
          const spec = loadCommandGeneratorModule(request.command);
          const generators = spec
            ? findArgGenerators(spec, request.tokens)
            : undefined;
          if (!generators) {
            if (fresh(generation)) {
              setDynamicSuggestions({ value, items: [] });
            }
            return;
          }
          const found = await runGenerators(generators, {
            tokens: request.tokens,
            searchTerm: request.base,
            cwd: cwd ?? '',
            executeCommand: ({ command: cmd, args, cwd: generatorCwd }) =>
              runCompletion(
                buildGeneratorShellLine(cmd, args ?? [], generatorCwd ?? cwd),
              ).then(stdout => ({ stdout, stderr: '', exitCode: 0 })),
          });
          if (!fresh(generation)) {
            return;
          }
          setDynamicSuggestions({
            value,
            items: figSuggestionsToCompletions(
              found,
              request.before,
              request.base,
            ).map(completion => ({
              insertText: completion.insertText,
              source: 'generator' as const,
              ...(completion.displayText
                ? { displayText: completion.displayText }
                : {}),
              ...(completion.description
                ? { description: completion.description }
                : {}),
            })),
          });
        })().catch(() => undefined);
      }, DYNAMIC_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }

    const hostCommand = buildListCommand(request, cwdRef.current);
    const generation = (dynamicGenerationRef.current += 1);
    const apply = (stdout: string) => {
      if (!fresh(generation)) {
        return;
      }
      setDynamicSuggestions({
        value,
        items: parsePathListing(stdout, request).map(item => ({
          ...item,
          source: 'path' as const,
        })),
      });
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
    commandSpec,
    enabled,
    integrationReady,
    runCompletion,
  ]);

  // 인자를 치기 시작하면 그 명령의 스펙을 받아 온다. 아직 안 써 본 옵션·서브커맨드를 추천할
  // 수 있는 것은 이것뿐이다(히스토리에는 쳐 본 것만 있다).
  //
  // 데스크톱과 다른 점은 **비동기**라는 것뿐이다 — 엔진에서 받아 오므로 도착하면 다시 그린다.
  useEffect(() => {
    if (!enabled || !integrationReady || capability?.status === 'unsupported') {
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
    void loadCommandSpec(leading).then(spec => {
      if (!cancelled && commandSpecNameRef.current === leading) {
        setCommandSpec(spec);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [capability?.status, command.value, enabled, integrationReady]);

  const suggestions = useMemo(() => {
    if (!enabled || !integrationReady || capability?.status === 'unsupported') {
      return [];
    }
    return getTerminalAutocompleteSuggestions(snapshot, command, {
      sessionStats: statsRef.current,
      currentCwd: cwdRef.current,
      commandSpec,
      // 지금 입력의 결과일 때만 쓴다 — 아니면 이전 줄의 경로 목록이 섞인다.
      dynamicCompletions:
        dynamicSuggestions.value === command.value
          ? dynamicSuggestions.items
          : undefined,
      // 경로 인자(cd·ls…)에서는 살아 있는 목록이 진실이라 오래된 히스토리 경로를 덮는다.
      // 동적 결과가 있다고 무조건 덮으면 경로가 아닌 자리에서도 히스토리가 사라진다.
      suppressHistory:
        resolveDynamicCompletion(commandSpec, command.value)?.kind === 'path',
      snippets,
      // 목록 길이는 데스크톱(20)과 다르게 둔다 — 화면이 좁아 그만큼 보여 줄 자리가 없다.
      limit: 12,
    });
  }, [
    capability?.status,
    command,
    commandSpec,
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
        // 프롬프트 마커. 다만 이 마커는 새 프롬프트뿐 아니라 프롬프트 **재드로잉**에도 온다 —
        // 모바일은 키보드가 열려도 PTY 가 리사이즈되어 원격 셸이 SIGWINCH 로 프롬프트를 다시
        // 그리며(재드로우 시 bash 는 PROMPT_COMMAND 의 A 를, zsh 는 PS1 끝에 붙인 B 를)
        // 재발행한다. 그 순간을 무조건 초기화하면 키보드를 열기 시작할 때마다 타이핑 중인
        // 버퍼가 지워져 추천이 0.5 초 만에 사라진다. 진짜 프롬프트 경계는 직전에 D 가 반드시
        // 오므로(명령 완료·Ctrl-C) D 가 없으면 재드로잉으로 간주해 버퍼를 보존한다.
        setIntegrationReady(true);
        if (sawCompletionRef.current) {
          sawCompletionRef.current = false;
          const empty = createEmptyCommandBuffer();
          commandRef.current = empty;
          setCommand(empty);
        }
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
        setDynamicSuggestions({ value: '', items: [] });
        return executed || null;
      }
      if (kind === 'D') {
        sawCompletionRef.current = true;
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
