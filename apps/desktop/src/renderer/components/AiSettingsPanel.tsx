import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AiProviderId,
  AiSettings,
  AiTestResult,
  AppSettings,
  CodexAuthStatus,
  CodexModel,
  CodexRateWindow,
  CodexUsage,
} from '@shared';
import { useAppStore } from '../store/appStore';
import { Button, FieldGroup, Input, SectionLabel, SelectField, ToggleSwitch } from '../ui';
import { useTranslation } from 'react-i18next';
import { t } from "../i18n";

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

// 모듈 최상위 상수는 i18n 초기화보다 먼저 평가되므로 문구가 아니라 키를 담는다.
const PROVIDER_OPTIONS: Array<{ value: AiProviderId; labelKey?: string; label?: string }> = [
  { value: 'codex', labelKey: 'ai.provider.codex' },
  { value: 'openai-compat', labelKey: 'ai.provider.openaiCompat' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
];

const DEFAULT_CODEX_MODEL = 'auto';

// 모델 미지정 센티널 — codex 가 권장 모델을 자동 선택한다(항상 목록 맨 위 고정).
// 정적 목록은 키를, 서버에서 받은 목록은 원문을 담는다 — 렌더 시점에 골라 쓴다.
interface CodexModelOption {
  id: string;
  label?: string;
  labelKey?: string;
  description?: string;
  descriptionKey?: string;
}

const CODEX_AUTO_OPTION: CodexModelOption = {
  id: 'auto',
  labelKey: 'ai.model.autoLabel',
  descriptionKey: 'ai.model.autoDescription',
};

// model/list 조회 실패(미로그인 등) 시의 폴백 목록. 평소에는 codex 의 model/list 를
// 실시간으로 가져와 대체한다(설명은 당시 응답의 description 원문을 한국어로 옮긴 것).
const CODEX_FALLBACK_MODEL_OPTIONS: CodexModelOption[] = [
  CODEX_AUTO_OPTION,
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    descriptionKey: 'ai.model.gpt56sol',
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    descriptionKey: 'ai.model.gpt56terra',
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    descriptionKey: 'ai.model.gpt56luna',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    descriptionKey: 'ai.model.gpt55',
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    descriptionKey: 'ai.model.gpt54',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    descriptionKey: 'ai.model.gpt54mini',
  },
];

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
    return t('ai.usage.weekly');
  }
  if (windowMinutes >= 1440) {
    return t('ai.usage.days', { count: Math.round(windowMinutes / 1440) });
  }
  if (windowMinutes >= 60) {
    return t('ai.usage.hours', { count: Math.round(windowMinutes / 60) });
  }
  return t('ai.usage.minutes', { count: windowMinutes });
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
    return t('ai.usage.resetInMinutes', { count: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return t('ai.usage.resetInHours', { count: hours });
  }
  return t('ai.usage.resetInDays', { count: Math.round(hours / 24) });
}

function CodexUsageRow({ window }: { window: CodexRateWindow }) {
  const { t: translate } = useTranslation();
  const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
  const reset = codexResetLabel(window.resetsAt);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between text-[0.8rem] text-[var(--text)]">
        <span>
          {translate('ai.usage.windowLimit', {
            window: codexWindowLabel(window.windowMinutes),
          })}
        </span>
        <span className="text-[var(--text-soft)]">
          {translate('ai.usage.remaining', { percent: remaining })}
          {reset ? ` · ${reset}` : ''}
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
  const { t: translate } = useTranslation();
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
  const listCodexModels = useAppStore((state) => state.listCodexModels);

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
  // model/list 실시간 목록(로그인 상태에서 조회). null 이면 폴백 정적 목록 사용.
  const [codexModels, setCodexModels] = useState<CodexModel[] | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [codexLoggingIn, setCodexLoggingIn] = useState(false);
  const [codexLoginUrl, setCodexLoginUrl] = useState<string | null>(null);
  // 언마운트/프로바이더 전환 시 로그인 폴링을 멈추기 위한 세대 토큰.
  const codexPollGeneration = useRef(0);

  // 저장된 설정이 실제로 바뀌면(저장 완료·최초 로드) 초안을 다시 맞춘다. 편집 중(props 불변)엔 안 건드린다.
  // 저장된 codex 모델이 목록 밖 값(구모델 등)이어도 강제 변환하지 않는다 — select 의
  // "현재 설정값" 옵션으로 그대로 보여주고, 실행 시 main(normalizeCodexModel)이 auto 로 처리한다.
  useEffect(() => {
    setDraft(JSON.parse(aiKey) as AiSettings);
  }, [aiKey]);

  const providerId = draft.providerId;
  const codexModelValue = draft.model.trim() || DEFAULT_CODEX_MODEL;
  // 모델 select 옵션: Auto 고정 + model/list 실시간 목록(알려진 id 는 한국어 설명 유지,
  // 새 id 는 서버 displayName/description 원문). 조회 전/실패 시엔 폴백 정적 목록.
  const codexModelOptions = useMemo<CodexModelOption[]>(() => {
    if (!codexModels || codexModels.length === 0) {
      return CODEX_FALLBACK_MODEL_OPTIONS;
    }
    const knownCopy = new Map(
      CODEX_FALLBACK_MODEL_OPTIONS.map((option) => [option.id, option]),
    );
    const defaultModel = codexModels.find((model) => model.isDefault);
    const autoOption = defaultModel
      ? {
          ...CODEX_AUTO_OPTION,
          descriptionKey: undefined,
          description: translate('ai.model.autoDescriptionWithDefault', {
            model: defaultModel.displayName,
          }),
        }
      : CODEX_AUTO_OPTION;
    return [
      autoOption,
      ...codexModels.map(
        (model) =>
          knownCopy.get(model.id) ?? {
            id: model.id,
            label: model.displayName,
            description: model.description ?? '',
          },
      ),
    ];
  }, [codexModels]);
  const hasKnownCodexModel = codexModelOptions.some(
    (option) => option.id === codexModelValue,
  );
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
      // 로그인 상태면 플랜 사용량·모델 목록도 함께 조회(실패해도 상태 표시는 유지 —
      // 모델 목록은 폴백 정적 목록으로 대체된다).
      if (status.authenticated) {
        try {
          setCodexUsage(await getCodexUsage());
        } catch {
          setCodexUsage(null);
        }
        try {
          setCodexModels(await listCodexModels());
        } catch {
          setCodexModels(null);
        }
      } else {
        setCodexUsage(null);
        setCodexModels(null);
      }
    } catch (error) {
      setCodexStatus(null);
      setCodexUsage(null);
      setCodexModels(null);
      setCodexError(
        error instanceof Error ? error.message : translate('ai.error.statusFailed'),
      );
    }
  }, [getCodexAuthStatus, getCodexUsage, listCodexModels]);

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
      setCodexError(translate('ai.error.loginTimeout'));
    } catch (error) {
      setCodexError(
        error instanceof Error ? error.message : translate('ai.error.loginFailed'),
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
      setCodexError(error instanceof Error ? error.message : translate('ai.error.reopenBrowserFailed'));
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
      setCodexError(error instanceof Error ? error.message : translate('ai.error.logoutFailed'));
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
        message: error instanceof Error ? error.message : translate('ai.error.testFailed'),
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
          label={translate('ai.enable.label')}
          description={translate('ai.enable.description')}
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
                    {option.labelKey ? translate(option.labelKey) : option.label}
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
                    ? translate('ai.baseUrl.placeholder')
                    : translate('ai.baseUrl.hint')}
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
                    <option value={codexModelValue}>
                      {translate('ai.model.currentValue', { model: codexModelValue })}
                    </option>
                  )}
                  {codexModelOptions.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.labelKey ? translate(model.labelKey) : model.label} -{' '}
                      {model.descriptionKey
                        ? translate(model.descriptionKey)
                        : model.description}
                    </option>
                  ))}
                </SelectField>
              ) : (
                <Input
                  type="text"
                  aria-label="AI Model"
                  placeholder={
                    providerId === 'anthropic'
                      ? translate('ai.model.placeholderAnthropic')
                      : translate('ai.model.placeholderCompat')
                  }
                  value={draft.model}
                  onChange={(event) => setField({ model: event.target.value })}
                />
              )}
              {providerId === 'codex' ? (
                <span className="text-[0.8rem] font-normal text-[var(--text-soft)]">
                  {codexModels
                    ? translate('ai.model.listFromAccount')
                    : translate('ai.model.listAfterLogin')}{' '}
                  {translate('ai.model.autoFollowsRecommended')}
                </span>
              ) : null}
            </FieldGroup>

            {providerId === 'anthropic' ? (
              <div className="rounded-[10px] border border-[color-mix(in_srgb,#f59e0b_48%,var(--border))] bg-[color-mix(in_srgb,#f59e0b_13%,var(--surface-elevated))] px-4 py-3 text-[0.86rem] leading-[1.55] text-[color-mix(in_srgb,#92400e_72%,var(--text))]">
                <div className="mb-1 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[color-mix(in_srgb,#b45309_78%,var(--text-soft))]">
                  {translate('ai.anthropic.accountLoginPlanned')}
                </div>
                {translate('ai.anthropic.accountLoginNote')}
              </div>
            ) : null}

            {providerId === 'codex' ? (
              <FieldGroup label={translate('ai.codex.accountLabel')}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.85rem] text-[var(--text)]">
                    {codexStatus === null
                      ? translate('ai.codex.checkingStatus')
                      : codexStatus.authenticated
                        ? `${translate('ai.codex.signedIn')}${codexStatus.email ? ` — ${codexStatus.email}` : ''}${codexStatus.planType ? ` (${codexStatus.planType})` : ''}`
                        : translate('ai.codex.signInRequired')}
                  </span>
                </div>
                {codexStatus?.authenticated && codexUsage && (codexUsage.primary || codexUsage.secondary) ? (
                  <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2.5">
                    <span className="text-[0.78rem] font-medium text-[var(--text-soft)]">
                      {translate('ai.usage.planRemaining')}
                      {codexUsage.planType ? ` (${codexUsage.planType})` : ''}
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
                      ? translate('ai.codex.waitingBrowser')
                      : codexStatus?.authenticated
                        ? translate('ai.codex.signInAgain')
                        : translate('ai.codex.signIn')}
                  </Button>
                  {codexLoggingIn ? (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => void handleReopenCodexLogin()}
                        disabled={!codexLoginUrl}
                      >
                        {translate('ai.codex.reopenBrowser')}
                      </Button>
                      <Button variant="secondary" onClick={handleCancelCodexLogin}>
                        {translate('common.cancel')}
                      </Button>
                    </>
                  ) : null}
                  {codexStatus?.authenticated ? (
                    <Button variant="danger" onClick={() => void handleCodexLogout()}>
                      {translate('ai.codex.logout')}
                    </Button>
                  ) : null}
                  <Button variant="secondary" onClick={() => void refreshCodexStatus()}>
                    {translate('ai.codex.refreshStatus')}
                  </Button>
                </div>
                <span className="text-[0.8rem] font-normal text-[var(--text-soft)]">
                  {translate('ai.codex.loginNote')}
                </span>
                {codexError ? (
                  <span className="text-[0.8rem] font-normal text-[var(--danger-text)]">{codexError}</span>
                ) : null}
              </FieldGroup>
            ) : null}

            {/* Anthropic 은 모델의 컨텍스트 창을 Models API 로 자동 감지하므로 설정을 받지 않는다.
                openai-compat 은 서버에 로드된 창(예: Ollama num_ctx)을 클라이언트가 알 수 없어 입력 유지. */}
            {providerId === 'openai-compat' ? (
              <FieldGroup label={translate('ai.context.label')}>
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
                  {translate('ai.context.hint')}
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
                    placeholder={hasKey ? translate('ai.apiKey.placeholderSaved') : 'sk-…'}
                    value={keyInput}
                    onChange={(event) => setKeyInput(event.target.value)}
                  />
                  <span className="text-[0.8rem] font-normal text-[var(--text-soft)]">
                    {hasKey
                      ? translate('ai.apiKey.hintSaved')
                      : translate('ai.apiKey.hintOptional')}
                  </span>
                </FieldGroup>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => void handleTest()}
                    disabled={testing || baseUrlMissing}
                  >
                    {translate(testing ? 'ai.apiKey.testing' : 'ai.apiKey.test')}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => void handleSaveKey()}
                    disabled={testing || !keyInput.trim()}
                  >
                    {translate('ai.apiKey.saveKey')}
                  </Button>
                  {hasKey ? (
                    <Button variant="danger" onClick={() => void handleClearKey()} disabled={testing}>
                      {translate('ai.apiKey.deleteKey')}
                    </Button>
                  ) : null}
                  <button
                    type="button"
                    className="ml-auto text-[0.85rem] font-medium text-[var(--accent-strong)] hover:underline"
                    onClick={() => {
                      void openExternalUrl(API_KEY_HELP_URL[providerId]);
                    }}
                  >
                    {translate('ai.apiKey.issueKey')}
                  </button>
                </div>
              </>
            ) : null}

            {result ? (
              <div
                role="status"
                className={
                  result.ok
                    ? 'select-text rounded-[10px] border border-[color-mix(in_srgb,var(--success,#16a34a)_45%,transparent)] bg-[color-mix(in_srgb,var(--success,#16a34a)_12%,transparent)] px-3.5 py-2.5 text-[0.85rem] text-[var(--text)]'
                    : 'select-text rounded-[10px] border border-[color-mix(in_srgb,var(--danger,#dc2626)_45%,transparent)] bg-[color-mix(in_srgb,var(--danger,#dc2626)_12%,transparent)] px-3.5 py-2.5 text-[0.85rem] text-[var(--text)]'
                }
              >
                <div className="font-semibold">{translate(result.ok ? 'ai.test.success' : 'ai.test.failure')}</div>
                <div className="text-[var(--text-soft)]">{result.message}</div>
                {result.ok && result.detectedModels && result.detectedModels.length > 0 ? (
                  <div className="mt-1 text-[0.8rem] text-[var(--text-soft)]">
                    {translate('ai.test.detectedModels', {
                      models: result.detectedModels.slice(0, 8).join(', '),
                    })}
                    {result.detectedModels.length > 8
                      ? translate('ai.test.detectedMore', {
                          count: result.detectedModels.length - 8,
                        })
                      : ''}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="mt-1 border-t border-[var(--border)] pt-3">
              <SectionLabel>{translate('ai.search.section')}</SectionLabel>
            </div>

            <FieldGroup label={translate('ai.search.tavilyLabel')}>
              <Input
                type="password"
                aria-label="Tavily Search API Key"
                autoComplete="off"
                placeholder={
                  hasSearchKey
                    ? translate('ai.search.tavilyPlaceholderSaved')
                    : translate('ai.search.tavilyPlaceholder')
                }
                value={searchKeyInput}
                onChange={(event) => setSearchKeyInput(event.target.value)}
              />
              <span className="text-[0.8rem] font-normal text-[var(--text-soft)]">
                {translate('ai.search.hint')}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void handleSaveSearchKey()}
                  disabled={!searchKeyInput.trim()}
                >
                  {translate('ai.apiKey.saveKey')}
                </Button>
                {hasSearchKey ? (
                  <Button variant="danger" onClick={() => void handleClearSearchKey()}>
                    {translate('ai.apiKey.deleteKey')}
                  </Button>
                ) : null}
                <button
                  type="button"
                  className="ml-auto text-[0.85rem] font-medium text-[var(--accent-strong)] hover:underline"
                  onClick={() => {
                    void openExternalUrl(TAVILY_KEYS_URL);
                  }}
                >
                  {translate('ai.search.issueKey')}
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
            {translate('ai.save.button')}
          </Button>
          <span className="text-[0.8rem] font-normal text-[var(--text-soft)]">
            {baseUrlMissing
              ? translate('ai.save.baseUrlRequired')
              : dirty
                ? translate('ai.save.unsaved')
                : saved
                  ? translate('ai.save.saved')
                  : translate('ai.save.noChanges')}
          </span>
        </div>
      </div>
    </section>
  );
}
