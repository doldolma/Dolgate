import { useCallback, useEffect, useState } from 'react';
import type { AiProviderId, AiSettings, AiTestResult, AppSettings } from '@shared';
import { useAppStore } from '../store/appStore';
import { Button, FieldGroup, Input, SectionLabel, SelectField, ToggleSwitch } from '../ui';

// @shared의 DEFAULT_AI_SETTINGS를 값으로 import하지 않고 인라인한다(vite dev export* 값-누락 회피).
// settings.ai가 아직 없을 때의 폴백.
const AI_DEFAULTS: AiSettings = {
  enabled: false,
  providerId: 'openai-compat',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  temperature: undefined,
};

const TAVILY_KEYS_URL = 'https://app.tavily.com/';

const PROVIDER_OPTIONS: Array<{ value: AiProviderId; label: string }> = [
  { value: 'openai-compat', label: 'OpenAI 호환 (OpenAI · Ollama · LM Studio · vLLM 등)' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
];

const API_KEY_HELP_URL: Record<AiProviderId, string> = {
  'openai-compat': 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
};

interface AiSettingsPanelProps {
  settings: AiSettings | undefined;
  onUpdateSettings: (input: Partial<AppSettings>) => Promise<void>;
}

export function AiSettingsPanel({ settings, onUpdateSettings }: AiSettingsPanelProps) {
  const ai = settings ?? AI_DEFAULTS;
  const providerId = ai.providerId;

  // IPC 는 스토어 액션을 통해서만 호출한다(컴포넌트에서 desktopApi 직접 사용 금지 — 경계 규칙).
  const testAiConnection = useAppStore((state) => state.testAiConnection);
  const setAiApiKey = useAppStore((state) => state.setAiApiKey);
  const clearAiApiKey = useAppStore((state) => state.clearAiApiKey);
  const getAiApiKeyStatus = useAppStore((state) => state.getAiApiKeyStatus);
  const openExternalUrl = useAppStore((state) => state.openExternalUrl);
  const getAiSearchKeyStatus = useAppStore((state) => state.getAiSearchKeyStatus);
  const setAiSearchKey = useAppStore((state) => state.setAiSearchKey);
  const clearAiSearchKey = useAppStore((state) => state.clearAiSearchKey);

  const [keyInput, setKeyInput] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AiTestResult | null>(null);
  const [searchKeyInput, setSearchKeyInput] = useState('');
  const [hasSearchKey, setHasSearchKey] = useState(false);

  const update = useCallback(
    (patch: Partial<AiSettings>) => onUpdateSettings({ ai: { ...ai, ...patch } }),
    [ai, onUpdateSettings],
  );

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

  // provider가 바뀌면 키 상태를 다시 읽고 입력/결과를 초기화한다(키는 provider별로 분리 저장).
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

  async function handleTest() {
    setTesting(true);
    setResult(null);
    try {
      const res = await testAiConnection({
        providerId,
        baseUrl: ai.baseUrl,
        model: ai.model,
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
      <div className="mb-4">
        <SectionLabel>AI</SectionLabel>
        <h3>Assistant</h3>
      </div>

      <div className="grid grid-cols-1 gap-[0.9rem]">
        <ToggleSwitch
          checked={ai.enabled}
          label="AI 어시스턴트 사용"
          description="세션에서 AI 도우미를 사용할 수 있게 합니다. API 키는 이 기기의 키체인에만 저장되며 동기화되지 않습니다."
          onClick={() => {
            void update({ enabled: !ai.enabled });
          }}
        />

        {ai.enabled ? (
          <>
            <FieldGroup label="Provider">
              <SelectField
                value={providerId}
                onChange={(event) => {
                  void update({ providerId: event.target.value as AiProviderId });
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
                  defaultValue={ai.baseUrl ?? ''}
                  onBlur={(event) => {
                    void update({ baseUrl: event.target.value });
                  }}
                />
                <span className="text-[0.8rem] font-normal text-[var(--text-soft)]">
                  로컬/호환 서버 주소. 비우면 https://api.openai.com/v1 을 사용합니다.
                </span>
              </FieldGroup>
            ) : null}

            <FieldGroup label="Model">
              <Input
                type="text"
                aria-label="AI Model"
                placeholder={providerId === 'anthropic' ? 'claude-… (모델 id)' : 'gpt-4o-mini · llama3.1 …'}
                defaultValue={ai.model}
                onBlur={(event) => {
                  void update({ model: event.target.value.trim() });
                }}
              />
            </FieldGroup>

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
                  ? '키가 이 기기 키체인에 저장되어 있습니다.'
                  : 'openai-호환 로컬 서버는 키가 필요 없을 수 있습니다.'}
              </span>
            </FieldGroup>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void handleTest()} disabled={testing}>
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
      </div>
    </section>
  );
}
