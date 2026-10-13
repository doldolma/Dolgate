import { render, screen } from '@testing-library/react';
import type { AiSettings, CodexModel } from '@shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { storeState } = vi.hoisted(() => ({
  storeState: {
    testAiConnection: vi.fn(),
    setAiApiKey: vi.fn(),
    clearAiApiKey: vi.fn(),
    getAiApiKeyStatus: vi.fn(),
    openExternalUrl: vi.fn(),
    getAiSearchKeyStatus: vi.fn(),
    setAiSearchKey: vi.fn(),
    clearAiSearchKey: vi.fn(),
    codexLoginStart: vi.fn(),
    getCodexAuthStatus: vi.fn(),
    codexLogout: vi.fn(),
    getCodexUsage: vi.fn(),
    listCodexModels: vi.fn(),
  },
}));

vi.mock('../store/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(storeState),
}));

import { AiSettingsPanel, buildCodexModelOptions } from './AiSettingsPanel';

const CODEX_SETTINGS: AiSettings = {
  enabled: true,
  providerId: 'codex',
  baseUrl: undefined,
  model: '',
  temperature: undefined,
  contextTokens: 128000,
};

function codexModel(overrides: Partial<CodexModel> & Pick<CodexModel, 'id'>): CodexModel {
  return {
    displayName: overrides.id,
    description: null,
    isDefault: false,
    ...overrides,
  };
}

// codex 0.162.1 의 model/list 와 같은 모양. GPT-5.6-Sol 은 서버가 설명을 고친 경우를 흉내 낸다.
const LIVE_MODELS: CodexModel[] = [
  codexModel({
    id: 'gpt-6.1-sol',
    displayName: 'GPT-6.1-Sol',
    description: 'Latest workhorse model for coding and everyday work.',
    isDefault: true,
  }),
  codexModel({
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: 'Retired workhorse model.',
  }),
  codexModel({
    id: 'gpt-6.2-nova',
    displayName: 'GPT-6.2-Nova',
    description: 'Brand new model.',
  }),
];

describe('buildCodexModelOptions', () => {
  it('uses the fallback list (0.162.1 catalog order) before model/list arrives', () => {
    const fallbackIds = [
      'auto',
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
    ];
    expect(buildCodexModelOptions(null).map((option) => option.id)).toEqual(fallbackIds);
    expect(buildCodexModelOptions([]).map((option) => option.id)).toEqual(fallbackIds);
  });

  it('keeps a translation only while the server description still matches its source', () => {
    const [auto, latest, changed, unknown] = buildCodexModelOptions(LIVE_MODELS);
    expect(auto).toMatchObject({
      id: 'auto',
      descriptionKey: 'ai.model.autoDescriptionWithDefault',
      descriptionParams: { model: 'GPT-6.1 Sol' },
    });
    expect(latest).toMatchObject({
      id: 'gpt-6.1-sol',
      label: 'GPT-6.1 Sol',
      descriptionKey: 'ai.model.gpt61sol',
    });
    expect(changed).toEqual({
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      description: 'Retired workhorse model.',
    });
    expect(unknown).toEqual({
      id: 'gpt-6.2-nova',
      label: 'GPT-6.2-Nova',
      description: 'Brand new model.',
    });
  });

  it('names an unknown default model by its server display name', () => {
    const [auto] = buildCodexModelOptions([
      codexModel({ id: 'gpt-7-sol', displayName: 'GPT-7-Sol', isDefault: true }),
    ]);
    expect(auto.descriptionParams).toEqual({ model: 'GPT-7-Sol' });
  });
});

describe('AiSettingsPanel codex model select', () => {
  beforeEach(() => {
    for (const fn of Object.values(storeState)) {
      fn.mockReset();
    }
    storeState.getAiApiKeyStatus.mockResolvedValue({ hasKey: false });
    storeState.getAiSearchKeyStatus.mockResolvedValue({ hasKey: false });
    storeState.getCodexUsage.mockResolvedValue({ planType: null, primary: null, secondary: null });
  });

  it('shows translated copy for current models and the server original once it changes', async () => {
    storeState.getCodexAuthStatus.mockResolvedValue({
      authenticated: true,
      authMode: 'chatgpt',
      email: 'dev@example.com',
      planType: 'pro',
    });
    storeState.listCodexModels.mockResolvedValue(LIVE_MODELS);

    render(<AiSettingsPanel settings={CODEX_SETTINGS} onUpdateSettings={vi.fn()} />);

    expect(
      await screen.findByRole('option', { name: 'Auto (권장) - Codex 권장 모델 자동 선택 (현재: GPT-6.1 Sol)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'GPT-6.1 Sol - 코딩과 일상 작업을 위한 최신 주력 모델' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'GPT-5.6 Sol - Retired workhorse model.' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'GPT-6.2-Nova - Brand new model.' })).toBeInTheDocument();
  });

  it('shows the translated fallback list before sign-in', async () => {
    storeState.getCodexAuthStatus.mockResolvedValue({
      authenticated: false,
      authMode: null,
      email: null,
      planType: null,
    });

    render(<AiSettingsPanel settings={CODEX_SETTINGS} onUpdateSettings={vi.fn()} />);

    expect(
      await screen.findByRole('option', { name: 'GPT-5.6 Sol - 구세대 주력 모델' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'GPT-6 Astra - 가장 까다로운 작업을 위한 프론티어 모델' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /GPT-5\.4/ })).not.toBeInTheDocument();
    expect(storeState.listCodexModels).not.toHaveBeenCalled();
  });
});
