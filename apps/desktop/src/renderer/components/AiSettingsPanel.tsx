import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AiProviderId,
  AiSettings,
  AiTestResult,
  AppSettings,
  CodexAuthStatus,
  CodexRateWindow,
  CodexUsage,
} from '@shared';
import { useAppStore } from '../store/appStore';
import { Button, FieldGroup, Input, SectionLabel, SelectField, ToggleSwitch } from '../ui';

// @shared의 DEFAULT_AI_SETTINGS를 값으로 import하지 않고 인라인한다(vite dev export* 값-누락 회피).
// settings.ai가 아직 없을 때의 폴백.
const AI_DEFAULTS: AiSettings = {
  enabled: false,
  providerId: 'openai-compat',
  // 비워두면 기본 호스트(https://api.openai.com/v1) — 필드는 placeholder 로만 안내.
  baseUrl: undefined,
  model: '',
  temperature: undefined,
  contextTokens: 128000,
};

const TAVILY_KEYS_URL = 'https://app.tavily.com/';

const PROVIDER_OPTIONS: Array<{ value: AiProviderId; label: string }> = [
  { value: 'codex', label: 'Codex (ChatGPT 계정)' },
  { value: 'openai-compat', label: 'OpenAI 호환 (OpenAI · Ollama · LM Studio · vLLM 등)' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
];

const DEFAULT_CODEX_MODEL = 'gpt-5.5';

const CODEX_MODEL_OPTIONS = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: '최신 추천 모델 · 복잡한 코딩/도구 사용',
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: '강한 범용 코딩/추론 모델',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description: '가볍고 빠른 작업 · 사용량 절약',
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3 Codex Spark',
    description: 'Pro research preview · 빠른 반복 작업',
  },
];

function withCodexDefaultModel(settings: AiSettings): AiSettings {
  if (settings.providerId !== 'codex') {
    return settings;
  }
  const model = settings.model.trim();
  if (CODEX_MODEL_OPTIONS.some((option) => option.id === model)) {
    return model === settings.model ? settings : { ...settings, model };
  }
  return { ...settings, model: DEFAULT_CODEX_MODEL };
}

// codex 는 API 키 대신 브라우저 로그인(ChatGPT 계정)을 쓴다 — 키 발급 URL 없음.
const API_KEY_HELP_URL: Record<Exclude<AiProviderId, 'codex'>, string> = {
  'openai-compat': 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
};

// 로그인 완료 폴링(브라우저에서 로그인하는 동안 상태를 주기적으로 확인).
const CODEX_LOGIN_POLL_INTERVAL_MS = 2000;
const CODEX_LOGIN_POLL_MAX_ATTEMPTS = 60;

// rate limit 창 길이(분) → 사람이 읽는 라벨. 300=5시간, 10080=주간.
function codexWindowLabel(windowMinutes: number): string {
  if (windowMinutes >= 10080) {
    return '주간';
  }
  if (windowMinutes >= 1440) {
    return `${Math.round(windowMinutes / 1440)}일`;
  }
  if (windowMinutes >= 60) {
    return `${Math.round(windowMinutes / 60)}시간`;
  }
  return `${windowMinutes}분`;
}

// resetsAt(Unix seconds) → "약 3시간 후 리셋" 같은 상대 문구. 과거/누락이면 빈 문자열.
function codexResetLabel(resetsAt: number | null): string {
  if (!resetsAt) {
    return '';
  }
  const diffMs = resetsAt * 1000 - Date.now();
  if (diffMs <= 0) {
    return '';
  }
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 60) {
    return `약 ${minutes}분 후 리셋`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `약 ${hours}시간 후 리셋`;
  }
  return `약 ${Math.round(hours / 24)}일 후 리셋`;
}

function CodexUsageRow({ window }: { window: CodexRateWindow }) {
  const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
  const reset = codexResetLabel(window.resetsAt);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between text-[0.8rem] text-[var(--text)]">
        <span>{codexWindowLabel(window.windowMinutes)} 한도</span>
        <span className="text-[var(--text-soft)]">
          {remaining}% 남음{reset ? ` · ${reset}` : ''}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-muted)]">
        <div
          className="h-full rounded-full bg-[var(--accent-strong)]"
          style={{ width: `${remaining}%` }}
        />
      </div>
    </div>
  );
}

interface AiSettingsPanelProps {
  settings: AiSettings | undefined;
  onUpdateSettings: (input: Partial<AppSettings>) => Promise<void>;
}

export function AiSettingsPanel({ settings, onUpdateSettings }: AiSettingsPanelProps) {
  const ai = settings ?? AI_DEFAULTS;
  const aiKey = JSON.stringify(ai);

  // IPC 는 스토어 액션을 통해서만 호출한다(컴포넌트에서 desktopApi 직접 사용 금지 — 경계 규칙).
  const testAiConnection = useAppStore((state) => state.testAiConnection);
  const setAiApiKey = useAppStore((state) => state.setAiApiKey);
  const clearAiApiKey = useAppStore((state) => state.clearAiApiKey);
  const getAiApiKeyStatus = useAppStore((state) => state.getAiApiKeyStatus);
  const openExternalUrl = useAppStore((state) => state.openExternalUrl);
  const getAiSearchKeyStatus = useAppStore((state) => state.getAiSearchKeyStatus);
  const setAiSearchKey = useAppStore((state) => state.setAiSearchKey);
  const clearAiSearchKey = useAppStore((state) => state.clearAiSearchKey);
  const codexLoginStart = useAppStore((state) => state.codexLoginStart);
  const getCodexAuthStatus = useAppStore((state) => state.getCodexAuthStatus);
  const codexLogout = useAppStore((state) => state.codexLogout);
  const getCodexUsage = useAppStore((state) => state.getCodexUsage);

  // 설정은 초안(draft)으로 편집하고 "설정 저장"을 눌러야만 반영된다(자동 저장 안 함 — 저장 안 하고 나가면 폐기).
  // API 키/Tavily 키는 키체인에 개별 저장(초안과 무관).
  const [draft, setDraft] = useState<AiSettings>(ai);
  const [saved, setSaved] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AiTestResult | null>(null);
  const [searchKeyInput, setSearchKeyInput] = useState('');
  const [hasSearchKey, setHasSearchKey] = useState(false);
  // Codex 계정 상태. null = 아직 조회 전(확인 중 표시).
  const [codexStatus, setCodexStatus] = useState<CodexAuthStatus | null>(null);
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [codexLoggingIn, setCodexLoggingIn] = useState(false);
  const [codexLoginUrl, setCodexLoginUrl] = useState<string | null>(null);
  // 언마운트/프로바이더 전환 시 로그인 폴링을 멈추기 위한 세대 토큰.
  const codexPollGeneration = useRef(0);

  // 저장된 설정이 실제로 바뀌면(저장 완료·최초 로드) 초안을 다시 맞춘다. 편집 중(props 불변)엔 안 건드린다.
  useEffect(() => {
    setDraft(withCodexDefaultModel(JSON.parse(aiKey) as AiSettings));
  }, [aiKey]);

  const providerId = draft.providerId;
  const codexModelValue = draft.model.trim() || DEFAULT_CODEX_MODEL;
  const hasKnownCodexModel = CODEX_MODEL_OPTIONS.some((model) => model.id === codexModelValue);
  const dirty = JSON.stringify({ ...draft, model: draft.model.trim() }) !== aiKey;
  // openai-compat 은 Base URL 이 필수 — 어디에 붙을지 추측(기본 호스트 폴백)하지 않고 입력을 요구한다.
  const baseUrlMissing =
    draft.enabled && providerId === 'openai-compat' && (draft.baseUrl ?? '').trim() === '';

  const setField = useCallback((patch: Partial<AiSettings>) => {
    setSaved(false);
    setDraft((current) => {
      const providerChanged = patch.providerId !== undefined && patch.providerId !== current.providerId;
      const next = { ...current, ...patch };
      if (providerChanged && patch.model === undefined) {
        next.model = '';
      }
      return next;
    });
  }, []);

  const refreshKeyStatus = useCallback(
    async (provider: AiProviderId) => {
      try {
        const status = await getAiApiKeyStatus(provider);
        setHasKey(status.hasKey);
      } catch {
        setHasKey(false);
      }
    },
    [getAiApiKeyStatus],
  );

  // 초안 provider가 바뀌면 키 상태를 다시 읽고 입력/결과를 초기화한다(키는 provider별로 분리 저장).
  useEffect(() => {
    void refreshKeyStatus(providerId);
    setKeyInput('');
    setResult(null);
  }, [providerId, refreshKeyStatus]);

  const refreshSearchKeyStatus = useCallback(async () => {
    try {
      const status = await getAiSearchKeyStatus('tavily');
      setHasSearchKey(status.hasKey);
    } catch {
      setHasSearchKey(false);
    }
  }, [getAiSearchKeyStatus]);

  useEffect(() => {
    void refreshSearchKeyStatus();
  }, [refreshSearchKeyStatus]);

  const refreshCodexStatus = useCallback(async () => {
    try {
      setCodexError(null);
      const status = await getCodexAuthStatus();
      setCodexStatus(status);
      // 로그인 상태면 플랜 사용량도 함께 조회(실패해도 상태 표시는 유지).
      if (status.authenticated) {
        try {
          setCodexUsage(await getCodexUsage());
        } catch {
          setCodexUsage(null);
        }
      } else {
        setCodexUsage(null);
      }
    } catch (error) {
      setCodexStatus(null);
      setCodexUsage(null);
      setCodexError(
        error instanceof Error ? error.message : 'Codex 상태를 확인하지 못했습니다.',
      );
    }
  }, [getCodexAuthStatus, getCodexUsage]);

  // codex 선택 시 상태 조회, 다른 프로바이더로 전환 시 진행 중이던 로그인 폴링 중단.
  useEffect(() => {
    codexPollGeneration.current += 1;
    setCodexLoggingIn(false);
    setCodexLoginUrl(null);
    if (providerId === 'codex') {
      setCodexStatus(null);
      void refreshCodexStatus();
    }
  }, [providerId, refreshCodexStatus]);

  useEffect(
    () => () => {
      codexPollGeneration.current += 1;
    },
    [],
  );

  // 브라우저 로그인: URL 열고 완료될 때까지 상태를 폴링한다(gitlab-bot 과 동일 패턴).
  async function handleCodexLogin() {
    setCodexLoggingIn(true);
    setCodexError(null);
    setCodexLoginUrl(null);
    const generation = ++codexPollGeneration.current;
    try {
      const { authUrl } = await codexLoginStart();
      if (codexPollGeneration.current !== generation) {
        return;
      }
      setCodexLoginUrl(authUrl);
      await openExternalUrl(authUrl);
      for (let attempt = 0; attempt < CODEX_LOGIN_POLL_MAX_ATTEMPTS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, CODEX_LOGIN_POLL_INTERVAL_MS));
        if (codexPollGeneration.current !== generation) {
          return;
        }
        try {
          const status = await getCodexAuthStatus();
          if (codexPollGeneration.current !== generation) {
            return;
          }
          setCodexStatus(status);
          if (status.authenticated) {
            // 로그인 완료 → 플랜 사용량도 채워 넣는다(실패해도 로그인 성공은 유지).
            try {
              setCodexUsage(await getCodexUsage());
            } catch {
              setCodexUsage(null);
            }
            setCodexLoginUrl(null);
            return;
          }
        } catch {
          // 일시적 조회 실패(app-server 재기동 등)는 무시하고 폴링을 계속한다.
        }
      }
      setCodexError('로그인 확인 시간이 초과되었습니다. 로그인을 완료했다면 상태 새로고침을 눌러 주세요.');
    } catch (error) {
      setCodexError(
        error instanceof Error ? error.message : 'Codex 로그인을 시작하지 못했습니다.',
      );
    } finally {
      if (codexPollGeneration.current === generation) {
        setCodexLoggingIn(false);
      }
    }
  }

  async function handleReopenCodexLogin() {
    if (!codexLoginUrl) {
      return;
    }
    try {
      setCodexError(null);
      await openExternalUrl(codexLoginUrl);
    } catch (error) {
      setCodexError(error instanceof Error ? error.message : '브라우저를 다시 열지 못했습니다.');
    }
  }

  function handleCancelCodexLogin() {
    codexPollGeneration.current += 1;
    setCodexLoggingIn(false);
    setCodexLoginUrl(null);
    setCodexError(null);
  }

  async function handleCodexLogout() {
    try {
      await codexLogout();
    } catch (error) {
      setCodexError(error instanceof Error ? error.message : 'Codex 로그아웃에 실패했습니다.');
    }
    await refreshCodexStatus();
  }

  async function handleSaveSettings() {
    await onUpdateSettings({
      ai: { ...draft, model: providerId === 'codex' ? codexModelValue : draft.model.trim() },
    });
    setSaved(true);
  }

  async function handleTest() {
    setTesting(true);
    setResult(null);
    try {
      const res = await testAiConnection({
        providerId,
        baseUrl: draft.baseUrl,
        model: providerId === 'codex' ? codexModelValue : draft.model.trim(),
        apiKey: keyInput.trim() || undefined,
      });
      setResult(res);
      // 성공하고 방금 입력한 키가 있으면 키체인에 저장(원샷 UX). 나쁜 키는 저장하지 않는다.
      if (res.ok && keyInput.trim()) {
        await setAiApiKey(providerId, keyInput.trim());
        setKeyInput('');
        await refreshKeyStatus(providerId);
      }
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : '연결 테스트에 실패했습니다.',
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleSaveKey() {
    const trimmed = keyInput.trim();
    if (!trimmed) {
      return;
    }
    await setAiApiKey(providerId, trimmed);
    setKeyInput('');
    await refreshKeyStatus(providerId);
  }

  async function handleClearKey() {
    await clearAiApiKey(providerId);
    await refreshKeyStatus(providerId);
    setResult(null);
  }

  async function handleSaveSearchKey() {
    const trimmed = searchKeyInput.trim();
    if (!trimmed) {
      return;
    }
    await setAiSearchKey('tavily', trimmed);
    setSearchKeyInput('');
    await refreshSearchKeyStatus();
  }

  async function handleClearSearchKey() {
    await clearAiSearchKey('tavily');
    await refreshSearchKeyStatus();
  }

  return (
    <section className="rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.6rem] shadow-[var(--shadow-soft)]">
      <div className="grid grid-cols-1 gap-[0.9rem]">
        <ToggleSwitch
          checked={draft.enabled}
          label="AI 어시스턴트 사용"
          description="세션에서 AI 도우미를 사용할 수 있게 합니다. API 키는 이 기기의 키체인에만 저장되며 동기화되지 않습니다."
          onClick={() => {
            setField({ enabled: !draft.enabled });
          }}
        />

        {draft.enabled ? (
          <>
            <FieldGroup label="Provider">
              <SelectField
                value={providerId}
                onChange={(event) => {
                  setField({ providerId: event.target.value as AiProviderId });
                }}
              >
                {PROVIDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </SelectField>
            </FieldGroup>

            {providerId === 'openai-compat' ? (
              <FieldGroup label="Base URL">
                <Input
                  type="text"
                  aria-label="AI Base URL"
                  placeholder="https://api.openai.com/v1"
                  value={draft.baseUrl ?? ''}
                  onChange={(event) => setField({ baseUrl: event.target.value })}
                />
                <span
                  className={
                    baseUrlMissing
                      ? 'text-[0.8rem] font-normal text-[var(--danger-text)]'
                      : 'text-[0.8rem] font-normal text-[var(--text-soft)]'
                  }
                >
                  {baseUrlMissing
                    ? '서버 주소를 입력하세요 — 예: https://api.openai.com/v1 (OpenAI) · http://localhost:11434/v1 (Ollama)'
                    : '서버 주소 (필수). 예: https://api.openai.com/v1 (OpenAI) · http://localhost:11434/v1 (Ollama)'}
                </span>
              </FieldGroup>
            ) : null}

            <FieldGroup label="Model">
              {providerId === 'codex' ? (
                <SelectField
                  aria-label="AI Model"
                  value={codexModelValue}
                  onChange={(event) => setField({ model: event.target.value })}
                >
                  {hasKnownCodexModel ? null : (
                    <option value={codexModelValue}>현재 설정값 - {codexModelValue}</option>
                  )}
                  {CODEX_MODEL_OPTIONS.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label} - {model.description}
                    </option>
                  ))}
                </SelectField>
              ) : (
                <Input
                  type="text"
                  aria-label="AI Model"
                  placeholder={providerId === 'anthropic' ? 'claude-… (모델 id)' : 'gpt-4o-mini · llama3.1 …'}
                  value={draft.model}
                  onChange={(event) => setField({ model: event.target.value })}
                />
              )}
              {providerId === 'codex' ? (
                <span className="text-[0.8rem] font-normal text-[var(--text-soft)]">
                  Codex CLI/SDK에 공개 모델 조회 API가 없어 공식 추천 모델 목록을 표시합니다. 기본값은 GPT-5.5입니다.
                </span>
              ) : null}
            </FieldGroup>

            {providerId === 'anthropic' ? (
              <div className="rounded-[10px] border border-[color-mix(in_srgb,#f59e0b_48%,var(--border))] bg-[color-mix(in_srgb,#f59e0b_13%,var(--surface-elevated))] px-4 py-3 text-[0.86rem] leading-[1.55] text-[color-mix(in_srgb,#92400e_72%,var(--text))]">
                <div className="mb-1 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[color-mix(in_srgb,#b45309_78%,var(--text-soft))]">
                  Claude 계정 로그인 예정
                </div>
                현재는 API 키 기반 Claude API로 연결합니다. 추후 Anthropic이 서드파티 앱용 Claude 계정
                로그인을 공식 지원하면 Claude Agent SDK 기반 연결로 변경될 예정입니다.
              </div>
            ) : null}

            {providerId === 'codex' ? (
              <FieldGroup label="Codex 계정">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.85rem] text-[var(--text)]">
                    {codexStatus === null
                      ? '상태 확인 중…'
                      : codexStatus.authenticated
                        ? `로그인됨${codexStatus.email ? ` — ${codexStatus.email}` : ''}${codexStatus.planType ? ` (${codexStatus.planType})` : ''}`
                        : '로그인이 필요합니다.'}
                  </span>
                </div>
                {codexStatus?.authenticated && codexUsage && (codexUsage.primary || codexUsage.secondary) ? (
                  <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2.5">
                    <span className="text-[0.78rem] font-medium text-[var(--text-soft)]">
                      플랜 남은 용량{codexUsage.planType ? ` (${codexUsage.planType})` : ''}
                    </span>
                    {codexUsage.primary ? <CodexUsageRow window={codexUsage.primary} /> : null}
                    {codexUsage.secondary ? <CodexUsageRow window={codexUsage.secondary} /> : null}
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant={codexStatus?.authenticated ? 'secondary' : 'primary'}
                    onClick={() => void handleCodexLogin()}
                    disabled={codexLoggingIn}
                  >
                    {codexLoggingIn
                      ? '브라우저에서 로그인 대기 중…'
                      : codexStatus?.authenticated
                        ? '다시 로그인'
                        : 'Codex 로그인'}
                  </Button>
                  {codexLoggingIn ? (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => void handleReopenCodexLogin()}
                        disabled={!codexLoginUrl}
                      >
                        브라우저 다시 열기
                      </Button>
                      <Button variant="secondary" onClick={handleCancelCodexLogin}>
                        취소
                      </Button>
                    </>
                  ) : null}
                  {codexStatus?.authenticated ? (
                    <Button variant="danger" onClick={() => void handleCodexLogout()}>
                      로그아웃
                    </Button>
                  ) : null}
                  <Button variant="secondary" onClick={() => void refreshCodexStatus()}>
                    상태 새로고침
                  </Button>
                </div>
                <span className="text-[0.8rem] font-normal text-[var(--text-soft)]">
                  버튼을 누르면 브라우저에서 ChatGPT 계정으로 로그인합니다. 로그인 정보는 이 앱 전용
                  공간(codex)에 저장되며 API 키가 필요 없습니다.
                </span>
                {codexError ? (
                  <span className="text-[0.8rem] font-normal text-[var(--danger-text)]">{codexError}</span>
                ) : null}
              </FieldGroup>
            ) : null}

            {/* Anthropic 은 모델의 컨텍스트 창을 Models API 로 자동 감지하므로 설정을 받지 않는다.
                openai-compat 은 서버에 로드된 창(예: Ollama num_ctx)을 클라이언트가 알 수 없어 입력 유지. */}
            {providerId === 'openai-compat' ? (
              <FieldGroup label="컨텍스트 창 (토큰)">
                <Input
                  type="number"
                  aria-label="AI Context Window Tokens"
                  min={2000}
                  step={1000}
                  value={draft.contextTokens ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    const parsed = Number(value);
                    setField({
                      contextTokens: value !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
                    });
                  }}
                />
                <span className="text-[0.8rem] font-normal text-[var(--text-soft)]">
                  서버에 로드된 컨텍스트 길이(예: Ollama num_ctx). 대화·도구 출력이 이 예산을 넘으면 오래된
                  대화부터 잘라 보냅니다.
                </span>
              </FieldGroup>
            ) : null}

            {/* codex 는 API 키 대신 위의 계정 로그인 사용 — 키 입력/발급 UI 전체를 숨긴다. */}
            {providerId !== 'codex' ? (
              <>
                <FieldGroup label="API Key">
                  <Input
                    type="password"
                    aria-label="AI API Key"
                    autoComplete="off"
                    placeholder={hasKey ? '•••••••• (저장됨 — 새 키 입력 시 교체)' : 'sk-…'}
                    value={keyInput}
                    onChange={(event) => setKeyInput(event.target.value)}
                  />
                  <span className="text-[0.8rem] font-normal text-[var(--text-soft)]">
                    {hasKey
                      ? '키가 이 기기 키체인에 저장되어 있습니다(설정 저장과 별도로 즉시 저장).'
                      : 'openai-호환 로컬 서버는 키가 필요 없을 수 있습니다.'}
                  </span>
                </FieldGroup>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => void handleTest()}
                    disabled={testing || baseUrlMissing}
                  >
                    {testing ? '테스트 중…' : '연결 테스트'}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => void handleSaveKey()}
                    disabled={testing || !keyInput.trim()}
                  >
                    키 저장
                  </Button>
                  {hasKey ? (
                    <Button variant="danger" onClick={() => void handleClearKey()} disabled={testing}>
                      키 삭제
                    </Button>
                  ) : null}
                  <button
                    type="button"
                    className="ml-auto text-[0.85rem] font-medium text-[var(--accent-strong)] hover:underline"
                    onClick={() => {
                      void openExternalUrl(API_KEY_HELP_URL[providerId]);
                    }}
                  >
                    API 키 발급 ↗
                  </button>
                </div>
              </>
            ) : null}

            {result ? (
              <div
                role="status"
                className={
                  result.ok
                    ? 'rounded-[10px] border border-[color-mix(in_srgb,var(--success,#16a34a)_45%,transparent)] bg-[color-mix(in_srgb,var(--success,#16a34a)_12%,transparent)] px-3.5 py-2.5 text-[0.85rem] text-[var(--text)]'
                    : 'rounded-[10px] border border-[color-mix(in_srgb,var(--danger,#dc2626)_45%,transparent)] bg-[color-mix(in_srgb,var(--danger,#dc2626)_12%,transparent)] px-3.5 py-2.5 text-[0.85rem] text-[var(--text)]'
                }
              >
                <div className="font-semibold">{result.ok ? '연결 성공' : '연결 실패'}</div>
                <div className="text-[var(--text-soft)]">{result.message}</div>
                {result.ok && result.detectedModels && result.detectedModels.length > 0 ? (
                  <div className="mt-1 text-[0.8rem] text-[var(--text-soft)]">
                    감지된 모델: {result.detectedModels.slice(0, 8).join(', ')}
                    {result.detectedModels.length > 8
                      ? ` 외 ${result.detectedModels.length - 8}개`
                      : ''}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="mt-1 border-t border-[var(--border)] pt-3">
              <SectionLabel>웹 검색</SectionLabel>
            </div>

            <FieldGroup label="Tavily 검색 API 키 (선택)">
              <Input
                type="password"
                aria-label="Tavily Search API Key"
                autoComplete="off"
                placeholder={hasSearchKey ? '•••••••• (저장됨)' : 'tvly-… (선택)'}
                value={searchKeyInput}
                onChange={(event) => setSearchKeyInput(event.target.value)}
              />
              <span className="text-[0.8rem] font-normal text-[var(--text-soft)]">
                웹 검색·URL 읽기는 기본으로 켜져 있고 키 없이 DuckDuckGo 로 검색합니다. Tavily 키를 넣으면 더 안정적·고품질 검색으로 업그레이드됩니다.
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void handleSaveSearchKey()}
                  disabled={!searchKeyInput.trim()}
                >
                  키 저장
                </Button>
                {hasSearchKey ? (
                  <Button variant="danger" onClick={() => void handleClearSearchKey()}>
                    키 삭제
                  </Button>
                ) : null}
                <button
                  type="button"
                  className="ml-auto text-[0.85rem] font-medium text-[var(--accent-strong)] hover:underline"
                  onClick={() => {
                    void openExternalUrl(TAVILY_KEYS_URL);
                  }}
                >
                  Tavily 키 발급 ↗
                </button>
              </div>
            </FieldGroup>
          </>
        ) : null}

        {/* 설정 저장(자동 저장 안 함). enabled 토글·provider·모델·컨텍스트 등 구성값을 함께 저장. */}
        <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
          <Button
            variant="primary"
            onClick={() => void handleSaveSettings()}
            disabled={!dirty || baseUrlMissing}
          >
            설정 저장
          </Button>
          <span className="text-[0.8rem] font-normal text-[var(--text-soft)]">
            {baseUrlMissing
              ? 'Base URL을 입력해야 저장할 수 있습니다.'
              : dirty
                ? '저장하지 않은 변경사항이 있습니다. (키는 위에서 개별 저장)'
                : saved
                  ? '저장되었습니다.'
                  : '변경사항 없음'}
          </span>
        </div>
      </div>
    </section>
  );
}
